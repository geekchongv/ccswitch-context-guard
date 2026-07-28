# CCProxy Agent v0.4.104

## Multi-session context center

v0.4.104 adds a dedicated Sessions page:

- A stable session list that does not change the selected detail when another request completes.
- Independent token usage, percentage, remaining capacity, and protection state for every Claude session.
- Per-session request, compaction, cleanup, and recent-event history.
- Active/in-flight sessions are prioritized while ended sessions remain available for review.
- The overview shows the highest-risk non-ended session instead of the globally latest request.

## Reliable session correlation

`SessionRegistry` associates Claude Hook events and API requests using this order:

1. Explicit session or conversation fields when available.
2. An existing stable conversation fingerprint.
3. A pending Hook session matched by an irreversible prompt hash.
4. A local deterministic fallback fingerprint.

Raw session identifiers and prompt content are not persisted or exposed to the renderer.

## Bounded storage and updates

- Per-request diagnostics: 500 records by default.
- Persisted session index: 100 sessions by default.
- Retention: 7 days by default.
- Session state uses a dedicated IPC update channel.
- Log-derived protection insights are debounced.

## Verification

- TypeScript check passed.
- GUI reference validation passed.
- Full automated test suite passed.
- Packaged Windows context-rescue smoke test passed.
