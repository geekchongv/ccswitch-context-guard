# CCProxy Agent v0.4.3

## Highlights

- Quieter, more actionable logs. Routine startup probes (port resolution, upstream discovery, config-patch no-ops) and per-request diagnostics (budget estimate, chunk plan, pass-through) moved to `debug`. `info` now marks outcomes a user cares about: request completed, vision preprocessing done, compact triggered, upstream failures.
- Upstream failure bodies are no longer lost. When the upstream returns a non-success status, the orchestrator captures the response body, logs the first 2 KB for diagnosis, and replays a re-readable response to the caller so the original status and body survive.
- Log rotation that actually keeps rotating. The agent log archives to `ccproxy-agent.log.1` past 5 MB, and the rotation now repeats across a whole session instead of firing only once.
- A new warning surfaces when a request appears to contain images but vision preprocessing did not match a supported image format, so silent image pass-through is visible.

## Notes

- The orchestration request path is unchanged; this release is about observability and log hygiene.
- Added regression tests for upstream-failure body replay and repeated log rotation.
- The Electron main/preload sources are excluded from `npm run build` (`tsc`) since they are bundled separately by esbuild.
