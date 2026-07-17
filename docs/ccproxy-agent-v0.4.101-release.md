# CCProxy Agent v0.4.101

This release fixes real image recognition for Claude Desktop when the downstream coding model is text-only.

## Highlights

- Resolves Claude Desktop `container_upload` and `file_id` references through the matching upstream Files API.
- Detects images nested inside Desktop tool-result payloads, including base64 image blocks.
- Sends downloaded image bytes to the configured vision model, then forwards only the verified visual summary to GLM or another text-only model.
- Removes the misleading text-only fallback that could return a successful "image not visible" answer.
- Preserves Agent tool-result structure while removing original image data after successful visual preprocessing.

## Requirements

- CC Switch must remain available at the configured upstream address, normally `http://127.0.0.1:15721`.
- Multimodal routing must be enabled in CCProxy Agent.
- A working OpenAI-compatible vision endpoint, vision model, and API key must be configured. The API key is never included in release files.

## Windows installation

1. Download `CCProxy-Agent-v0.4.101-Windows-x64.zip` and extract it, or download the portable EXE directly.
2. Start `CCProxy-Agent-v0.4.101.exe`; the proxy listens on `127.0.0.1:15722` and temporarily patches Claude CLI/Desktop routing.
3. Configure the vision endpoint and credential in the desktop control center if they are not already stored on this machine.
4. Upload an image in Claude Desktop. A successful request produces the Chinese log event `检测到图片并完成预处理`.

## Verification

- TypeScript check passed.
- Full automated test suite passed: 84/84.
- Packaged-secret scan passed before local runtime configuration was created.
- Windows portable EXE SHA256 is published in `SHA256SUMS.txt`.
