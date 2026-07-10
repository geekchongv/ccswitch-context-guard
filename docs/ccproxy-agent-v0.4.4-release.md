# CCProxy Agent v0.4.4

## Highlights

- The recurring `196001 input tokens` failure is fixed. When a request is so large it must be chunked, an oversized single message is no longer dropped into one uncapped block that blows past the 200k hard limit. The chunker now splits oversized messages on paragraph → sentence → token boundaries, and every chunk is guaranteed to stay under the hard cap (`hardLimit − safetyMargin − responseReserve`).
- Token counting is now accurate and consistent. The estimator and chunker both use `tokenx` — a Chinese-aware, ~96% accurate heuristic counter — instead of the old `length/3.0` and `length/3.5` rules that disagreed with each other and halved Chinese token estimates. Budget decisions (safe / compact / chunk) and chunk sizing now rest on the same number.
- Base64 images no longer inflate token estimates. An image part is counted as a bounded `[image]` placeholder (~1 token) rather than serializing its base64 payload, which previously turned a 100 KB image into ~33k phantom tokens.
- Every chunk is now logged with its estimated size against the hard cap, with a regression sentinel that warns if any chunk ever crosses it.

## Notes

- New `src/token-counter.ts` is the single counting layer wrapping `tokenx`; `src/token-estimator.ts` and `src/chunking.ts` both call it, so estimate and chunk sizing can never drift apart again.
- `buildChunkPlan` gains a `hardCap` parameter (computed by the orchestrator) so the chunker stays a pure function with no `AppConfig` coupling.
- Added `src/token-counter.test.ts` (image-not-inflated, CJK accuracy, bounded unknown parts) and `src/chunking.test.ts` (oversized split, giant no-punctuation line, array multi-part split, image never split, and a `196001` regression asserting no chunk exceeds the hard cap).
- No behavior change for normal-sized requests; this release hardens the chunking path against the exact failure that produced HTTP 400 on oversized inputs.
