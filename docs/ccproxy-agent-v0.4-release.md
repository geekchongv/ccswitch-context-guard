# CCProxy Agent v0.4 Release Notes

## Summary

v0.4 adds multimodal image support for text-only downstream models.

Claude Desktop can send image blocks, but your downstream model may be GLM-5.2 or another text-only model. In that case, CCProxy Agent now intercepts the image, calls a dedicated vision model, injects a text summary, and strips the original image before forwarding downstream.

## Default Vision Models

```json
{
  "vision": {
    "enabled": true,
    "models": [
      "qwen3-vl-30b-a3b-instruct",
      "Qwen3.6-35B-A3B"
    ],
    "compareModels": true
  }
}
```

Both models are called by default. Their summaries are combined into one `[VISION SUMMARY]` block.

## Secret Handling

The API key is not committed to config. Set it as a user environment variable:

```powershell
[Environment]::SetEnvironmentVariable("CCPROXY_VISION_API_KEY", "your-token", "User")
```

Restart the proxy after setting the variable.

## Flow

```text
Claude Desktop image input
-> CCProxy Agent extracts image blocks
-> calls qwen3-vl-30b-a3b-instruct
-> calls Qwen3.6-35B-A3B
-> injects [VISION SUMMARY]
-> strips image blocks
-> forwards text-only request to ccswitch / GLM-5.2
```

## Limits

Default limits:

```json
{
  "maxImagesPerRequest": 5,
  "maxImageBytes": 5000000,
  "summaryMaxTokens": 1500
}
```

These guardrails prevent image payloads from exploding context size.

## Validation

- TypeScript check passes.
- Unit tests pass.
- Added regression coverage for dual vision model calls.
- Live test confirmed `qwen3-vl-30b-a3b-instruct` can OCR the provided screenshot.
- Live test confirmed `Qwen3.6-35B-A3B` can return normal content when `enable_thinking=false`.
