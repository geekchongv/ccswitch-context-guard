# CCProxy Agent v0.4.102

This release fixes a hang that occurred after the compact threshold was triggered during Agent tool sessions.

## Highlights

- Fixes the post-compact hang where Agent tool sessions would loop indefinitely on small tool calls. Previously, when `totalTokens` exceeded the compact threshold and the request carried the Agent tool protocol, the proxy deferred compaction to "Claude native compact" as a no-op — the proxy cleared old tool results each turn, but total tokens rebounded on the next turn, so Claude kept churning on tiny tool calls and the session appeared frozen.
- Agent tool sessions now run the same proxy-side `compactRequest` path as ordinary requests when `compactMode === "proxy"`, so compaction actually reduces context size instead of deferring into a dead branch.
- The compaction log event now includes `agentToolProtocol` so Agent-tool compactions are distinguishable from ordinary compactions in the logs.

## Requirements

- CC Switch must remain available at the configured upstream address, normally `http://127.0.0.1:15721`.
- `compactMode` must be set to `proxy` (default) for proxy-side compaction to take effect.

## Windows installation

1. Download `CCProxy-Agent-v0.4.102-Windows-x64.zip` and extract it, or download the portable EXE directly.
2. Start `CCProxy-Agent-v0.4.102.exe`; the proxy listens on `127.0.0.1:15722`.
3. Trigger any long Agent tool session that exceeds the compact threshold; the proxy now compacts context in place and the session continues instead of hanging.

## Verification

- TypeScript check passed.
- Windows portable EXE SHA256 is published in `SHA256SUMS.txt`.
