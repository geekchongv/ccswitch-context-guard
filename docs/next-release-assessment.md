# Next release assessment

## Recommended priority: trusted distribution and adaptive scheduling

1. **macOS signing and notarization** — add Apple Developer signing credentials, hardened runtime, notarization, and an update channel so users do not need the Control-click workaround.
2. **Token-aware local-gateway scheduler** — extend the v0.4.97 reactive 429 cooldown with persisted per-gateway profiles, rolling Token estimates, fair per-session queues, and queue/cooldown metrics in the UI.
3. **Provider presets and connection tests** — add presets for common multimodal endpoints plus a safe “Test connection” action that verifies URL, authentication, model availability, and latency without exposing the key.
4. **Release size architecture decision** — measure Electron cold start and artifact size against a Tauri prototype before committing to a framework migration. Keep Electron unless the prototype materially improves package size and startup without regressing secure storage or cross-platform behavior.

## Success criteria

- Signed/notarized macOS installation with no Gatekeeper workaround.
- No repeated 429 burst from parallel local agents in a 30-minute stress run.
- A new user can configure and verify Vision from the GUI without editing files or environment variables.
- Release assets, checksums, smoke tests, and update metadata are generated from one reproducible workflow.
