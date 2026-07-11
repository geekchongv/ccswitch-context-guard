import { sliceByTokens } from "tokenx";
import { ChatCompletionRequest, ChatMessage, ChatMessagePart, ChatMessagePartImage } from "./types.js";
import { countTextTokens, countMessageTokens } from "./token-counter.js";
import { estimateRequestTokens } from "./token-estimator.js";

/** 图片占位符,与 token-counter 保持一致 —— 切分时图片块永不拆分。 */
const IMAGE_PLACEHOLDER = "[image]";

/** buildChunkPlan 给每块加的 system preamble 文本,打包时需为其预留 token 余量。 */
const CHUNK_PREAMBLE_FIRST = "Process this chunk and preserve all actionable constraints for later synthesis.";
const CHUNK_PREAMBLE_LATER = "Continue processing this chunk. Preserve constraints and new findings for final synthesis.";
const SYNTHESIS_PREAMBLE = "Synthesize the chunk results into one final answer. Preserve all constraints and avoid contradictions.";
/** 取两者中较大的 token 数作为打包预留(保守)。 */
const PREAMBLE_RESERVE = Math.max(countTextTokens(CHUNK_PREAMBLE_FIRST), countTextTokens(CHUNK_PREAMBLE_LATER));
/**
 * estimateRequestTokens 在内容 token 之外还加 wrapper 开销(250 + messages.length*12)。
 * 打包时按每块最多约 4 条消息保守预留,避免 wrapper 把块顶过 hardCap。
 */
const WRAPPER_RESERVE = 250 + 4 * 12;
const SYNTHESIS_MAX_OUTPUT_TOKENS = 4000;
const ORIGINAL_PREVIEW_TOKENS = 2000;

/** 判断一个 part 是否是图片块(判定与 token-counter / modality-router 保持一致)。 */
function isImagePart(part: ChatMessagePart): boolean {
  const typed = part as ChatMessagePartImage;
  if (typed.type === "image" && typed.source?.type === "base64" && typed.source.data) {
    return true;
  }
  if (typed.type === "image_url" || "image_url" in typed) {
    return true;
  }
  if ((typed.type === "input_image" || "url" in typed) && typeof typed.url === "string") {
    return true;
  }
  return false;
}

function truncateByTokens(text: string, maxTokens: number): string {
  if (countTextTokens(text) <= maxTokens) {
    return text;
  }
  const suffix = "\n[truncated]";
  const suffixTokens = countTextTokens(suffix);
  const sliceBudget = Math.max(1, maxTokens - suffixTokens);
  return `${sliceByTokens(text, 0, sliceBudget)}${suffix}`;
}

function partToPreviewText(part: ChatMessagePart): string {
  if ("text" in part && typeof part.text === "string") {
    return part.text;
  }
  if (isImagePart(part)) {
    return IMAGE_PLACEHOLDER;
  }
  return JSON.stringify(part).slice(0, 200);
}

function messageToPreviewText(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content.map(partToPreviewText).join("\n");
}

function buildOriginalTaskPreview(messages: ChatMessage[]): string {
  const systemMessages = messages
    .filter((message) => message.role === "system")
    .map(messageToPreviewText)
    .filter(Boolean);
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const preview = [
    systemMessages.length > 0 ? `System constraints:\n${systemMessages.join("\n\n")}` : "",
    lastUserMessage ? `Latest user request:\n${messageToPreviewText(lastUserMessage)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return truncateByTokens(preview || "No original task preview available.", ORIGINAL_PREVIEW_TOKENS);
}

/**
 * 把单段文本按 maxTokens 切成多片,保证每片 token 数 <= maxTokens。
 * 三级回退:段落 → 句子 → token 硬切。前一级无法满足时才降级。
 * 性能:每级用"预计算各单元 token 数 + 贪心累加"避免对越来越大的 buffer 反复全长计数(O(n²))。
 */
function splitText(text: string, maxTokens: number): string[] {
  if (countTextTokens(text) <= maxTokens) {
    return [text];
  }

  // 第一级:按空行分段,贪心合并。
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.length > 0);
  if (paragraphs.length > 1) {
    return greedyPack(paragraphs, maxTokens, "\n\n", splitText);
  }

  // 第二级:按句子(CJK + ASCII 句末标点)切,贪心合并。
  const sentences = text.split(/(?<=[。！？!?\.])\s+/).filter((s) => s.length > 0);
  if (sentences.length > 1) {
    return greedyPack(sentences, maxTokens, " ", splitByHardTokenCut);
  }

  // 第三级:无任何语义边界(一整行),用 token 硬切保证硬上限。
  return splitByHardTokenCut(text, maxTokens);
}

/**
 * 贪心打包:把若干文本单元合并成片,每片 token 数 <= maxTokens。
 * 关键:预先一次性算好每个单元的 token 数,合并时用累加而非重新计全长 → O(n)。
 * 单个单元本身就超 maxTokens 时,用 oversizeHandler 拆它(段落级→splitText,句子级→硬切)。
 */
function greedyPack(
  units: string[],
  maxTokens: number,
  separator: string,
  oversizeHandler: (unit: string, maxTokens: number) => string[],
): string[] {
  const unitTokens = units.map((u) => countTextTokens(u));
  const pieces: string[] = [];
  let buffer = "";
  let bufferSize = 0;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const unitSize = unitTokens[i];
    const sep = buffer ? separator : "";
    // separator 本身的 token 开销近似为 0(单个空白/换行),不单独计入。

    if (bufferSize + unitSize <= maxTokens) {
      buffer = buffer ? `${buffer}${sep}${unit}` : unit;
      bufferSize += unitSize;
    } else {
      if (buffer) {
        pieces.push(buffer);
        buffer = "";
        bufferSize = 0;
      }
      // 当前单元无处可放:若它本身超限,交给 handler 拆;否则起一个新片。
      if (unitSize > maxTokens) {
        pieces.push(...oversizeHandler(unit, maxTokens));
      } else {
        buffer = unit;
        bufferSize = unitSize;
      }
    }
  }

  if (buffer) {
    pieces.push(buffer);
  }
  return pieces.filter((p) => p.length > 0);
}

/**
 * token 级硬切:用 sliceByTokens 按 maxTokens 步进切,保证每片 <= maxTokens。
 * 这是硬上限的最终保证 —— 即便文本没有任何标点/换行也不会越界。
 * 性能:每片只调一次 sliceByTokens + 一次 countTextTokens(校验),整体 O(n)。
 */
function splitByHardTokenCut(text: string, maxTokens: number): string[] {
  const totalTokens = countTextTokens(text);
  if (totalTokens <= maxTokens) {
    return [text];
  }

  const pieces: string[] = [];
  let start = 0;

  while (start < totalTokens) {
    const end = Math.min(start + maxTokens, totalTokens);
    const piece = sliceByTokens(text, start, end);

    if (countTextTokens(piece) <= maxTokens) {
      // 正常:切片在预算内。
      if (piece.length > 0) {
        pieces.push(piece);
      }
      start = end;
    } else {
      // 切片超出预算(sliceByTokens 的 token 边界与 estimateTokenCount 的启发式口径略有差异)。
      // 二分收缩到 <= maxTokens,只在异常分支触发,不影响正常路径性能。
      let lo = start + 1;
      let hi = end;
      let bestEnd = start + 1;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (countTextTokens(sliceByTokens(text, start, mid)) <= maxTokens) {
          bestEnd = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const fixedPiece = sliceByTokens(text, start, bestEnd);
      if (fixedPiece.length > 0) {
        pieces.push(fixedPiece);
      }
      start = bestEnd <= start ? start + 1 : bestEnd;
    }
  }

  return pieces.filter((p) => p.length > 0);
}

/**
 * 把单条超大 message 拆成多条,每条 token 数 <= maxTokens,role 保持不变。
 * 字符串内容委托 splitText;数组内容按 part 拆(text part 仍超则 splitText,图片 part 原样不拆)。
 */
function splitOversizedMessage(message: ChatMessage, maxTokens: number): ChatMessage[] {
  if (typeof message.content === "string") {
    return splitText(message.content, maxTokens).map((piece) => ({
      role: message.role,
      content: piece,
    }));
  }

  // 数组内容:逐 part 处理。
  const result: ChatMessage[] = [];
  for (const part of message.content) {
    if (isImagePart(part)) {
      // 图片永不拆分(切 base64 无意义);占位符仅 ~1 token,正常永不会超 maxTokens。
      if (countTextTokens(IMAGE_PLACEHOLDER) > maxTokens) {
        console.warn("[chunking] 单个图片块已超过硬上限,无法拆分,原样放行");
      }
      result.push({ role: message.role, content: [part] });
      continue;
    }

    const text = "text" in part && typeof part.text === "string" ? part.text : JSON.stringify(part).slice(0, 200);
    if (countTextTokens(text) <= maxTokens) {
      result.push({ role: message.role, content: [part] });
    } else {
      // 单个 text part 仍超 → 拆文本,每片包成同类型 part。
      const partType = ("type" in part && (part.type === "input_text" ? "input_text" : "text")) as "text" | "input_text";
      for (const piece of splitText(text, maxTokens)) {
        result.push({ role: message.role, content: [{ type: partType, text: piece }] });
      }
    }
  }

  return result.length > 0 ? result : [message];
}

/**
 * 把消息列表打包成块。先预展开(超过 chunkTarget 的单条拆成多条,保证每条 <= hardCap),
 * 再贪心打包到 chunkTarget。移除了旧实现 `current.length > 0` 的短路 bug ——
 * 预展开后每条都 <= hardCap,空块必能容纳下一条。
 */
function chunkMessages(messages: ChatMessage[], chunkTarget: number, hardCap: number): ChatMessage[][] {
  // 打包上限需扣除 buildChunkPlan 后加的 preamble + estimator 的 wrapper 开销,
  // 否则这两部分会把块顶过 hardCap。
  const overhead = PREAMBLE_RESERVE + WRAPPER_RESERVE;
  const effectiveTarget = Math.max(1, chunkTarget - overhead);
  const effectiveHardCap = Math.max(1, hardCap - overhead);

  // 预展开:超 chunkTarget 的单条拆分,保证每条 <= effectiveHardCap。
  const expanded: ChatMessage[] = [];
  for (const message of messages) {
    if (countMessageTokens(message) > effectiveTarget) {
      expanded.push(...splitOversizedMessage(message, effectiveHardCap));
    } else {
      expanded.push(message);
    }
  }

  const chunks: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  let currentSize = 0;

  for (const message of expanded) {
    const size = countMessageTokens(message);

    // 软上限:超 effectiveTarget 就开新块(正常路径)。
    if (current.length > 0 && currentSize + size > effectiveTarget) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }

    // 硬上限保险:即便软上限没触发,若会超 effectiveHardCap 也开新块(纵深防御)。
    if (current.length > 0 && currentSize + size > effectiveHardCap) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }

    current.push(message);
    currentSize += size;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export function buildChunkPlan(
  request: ChatCompletionRequest,
  chunkTarget: number,
  hardCap: number,
): ChatCompletionRequest[] {
  const messages = request.messages ?? [];
  const topLevelOverhead = Math.max(
    0,
    estimateRequestTokens({ ...request, messages: [], max_tokens: 0, max_completion_tokens: 0 }, 0).inputTokens - 250,
  );
  const chunks = chunkMessages(
    messages,
    Math.max(1, chunkTarget - topLevelOverhead),
    Math.max(1, hardCap - topLevelOverhead),
  );

  return chunks.map((chunk, index) => ({
    ...request,
    messages: [
      {
        role: "system",
        content: index === 0 ? CHUNK_PREAMBLE_FIRST : CHUNK_PREAMBLE_LATER,
      },
      ...chunk,
    ],
    max_tokens: Math.min(request.max_tokens ?? 4000, 4000),
    stream: false,
  }));
}

export function buildSynthesisRequest(
  originalRequest: ChatCompletionRequest,
  chunkOutputs: string[],
  hardCap = 120_000,
): ChatCompletionRequest {
  const topLevelOverhead = Math.max(
    0,
    estimateRequestTokens({ ...originalRequest, messages: [], max_tokens: 0, max_completion_tokens: 0 }, 0).inputTokens - 250,
  );
  const synthesisInputBudget = Math.max(
    1,
    hardCap - topLevelOverhead - countTextTokens(SYNTHESIS_PREAMBLE) - WRAPPER_RESERVE,
  );
  const synthesisBody = [
    "Original task preview:",
    buildOriginalTaskPreview(originalRequest.messages ?? []),
    "",
    "Chunk outputs:",
    ...chunkOutputs.map((output, index) => `Chunk ${index + 1}:\n${output}`),
  ].join("\n");

  return {
    ...originalRequest,
    stream: false,
    max_tokens: Math.min(originalRequest.max_tokens ?? SYNTHESIS_MAX_OUTPUT_TOKENS, SYNTHESIS_MAX_OUTPUT_TOKENS),
    max_completion_tokens:
      typeof originalRequest.max_completion_tokens === "number"
        ? Math.min(originalRequest.max_completion_tokens, SYNTHESIS_MAX_OUTPUT_TOKENS)
        : undefined,
    messages: [
      {
        role: "system",
        content: SYNTHESIS_PREAMBLE,
      },
      {
        role: "user",
        content: truncateByTokens(synthesisBody, synthesisInputBudget),
      },
    ],
  };
}
