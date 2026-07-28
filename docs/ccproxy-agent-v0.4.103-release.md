# CCProxy Agent v0.4.103

## 200k context capacity center

The overview now makes context capacity a first-class operating signal instead of hiding it in logs:

- Current context input in tokens and as a percentage of the configured window.
- Remaining capacity and the source of the latest reading.
- A single protection rail with markers for:
  - tool-result cleanup at 140k,
  - proxy compaction at 160k,
  - Claude native compaction at 170k,
  - effective hard protection at 192k.
- A clear next-action message showing how many tokens remain until the next threshold.

## Policy migration

The default context window is now 200k. Existing installations using the exact legacy CCProxy defaults (`130k` hard limit, `90k` compact threshold, `80k/65k` tool cleanup) are migrated automatically. The legacy managed Claude pair (`130000` window and `76%`) is upgraded to `200000` and `85%`. Other custom values are preserved.

## Verification

- TypeScript check passed.
- GUI reference validation passed.
- Full automated test suite passed.
