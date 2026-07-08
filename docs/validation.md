# v0.2 Validation Standard

## Goal

The proxy is considered acceptable for v0.2 use when all items below pass.

## Functional Checks

1. `GET /health` on `ccproxy-agent` returns `200`.
2. Non-AI routes are transparently forwarded to the upstream service.
3. `POST /v1/messages` can pass through the proxy and return a provider response.
4. `POST /v1/chat/completions` can pass through the proxy when the upstream provider configuration supports it.
5. Requests over the compact threshold trigger a `/compact` warning when `compactMode = "warn"`.
6. Requests whose requested output would exceed the safe context budget automatically lower `max_tokens`.
7. Upstream context-limit `400` errors are parsed and retried once when a safe output budget is available.
8. Claude Desktop 3P configs are patched from `15721` to `15722` and restored on shutdown.
9. Prefixed Desktop routes such as `/claude-desktop/v1/messages` enter the AI orchestration layer.
10. Requests over the hard limit trigger staged chunk execution.
11. Image-bearing requests trigger vision preprocessing when `vision.enabled = true`.
12. Orchestration records are written into `runtime/sessions/`.
13. Logs are written into `logs/ccproxy-agent.log`.

## Command Checks

```bash
npm run check
npm run build
npm run test
npm run probe
```

## Manual Checks

1. Start the proxy with `npm run dev`
2. Point the client to `http://127.0.0.1:15722`
3. Send a short text request and confirm normal pass-through
4. Send a long context request and confirm compact warning log output
5. Send a request with high `max_tokens` and confirm automatic output reduction
6. Confirm Claude Desktop config points to `15722` while the proxy is running and restores to `15721` after exit
7. Send a route known to exist upstream, such as `/v1/messages`, and confirm compatibility

## Known MVP Gaps

- provider-native tokenization is not implemented
- streaming is proxied at the HTTP layer but not specially transformed
- `/compact` is a warning in default mode, not a hidden CLI command
- Claude Desktop must be restarted after config changes because it reads 3P settings at launch
- multimodal preprocessing currently summarizes images before text execution rather than fusing native image parts into every provider schema
