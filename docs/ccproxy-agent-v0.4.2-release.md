# CCProxy Agent v0.4.2

## Highlights

- Adds a product-focused health panel to the desktop console.
- Shows proxy, upstream, Claude routing, and vision readiness at a glance.
- Adds a protection event feed that turns technical logs into user-facing guardrail events.
- Surfaces token budget checks, `max_tokens` reductions, context-limit retries, compact reminders, chunking, and vision preprocessing as readable timeline cards.
- Adds README dashboard screenshots so new users can understand the running product faster.

## Notes

- The raw runtime log view is still available.
- Protection events are derived from existing structured logs, so the request orchestration path is unchanged.
- Vision readiness checks whether the configured vision API key environment variable is present when vision is enabled.
