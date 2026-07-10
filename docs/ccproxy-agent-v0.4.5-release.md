# CCProxy Agent v0.4.5

## Highlights

- Final synthesis is now hard-cap aware. After chunk execution, CCProxy Agent no longer places the full original `messages` JSON back into the synthesis request.
- Synthesis now carries a bounded original-task preview plus chunk outputs, then truncates to the same hard-cap budget used by chunk execution.
- Synthesis output tokens are capped at 4,000, preventing the previous `large input + huge max_tokens` failure pattern from reappearing at the final step.
- The Windows GUI release is now packaged as a clean zip containing the portable exe, `config.example.json`, README, docs, license, changelog, and checksum.

## Notes

- v0.4.4 fixed the oversized single-chunk bug. v0.4.5 closes the follow-up synthesis path so the whole chunking pipeline is protected.
- Added regression tests for oversized original messages and excessive chunk outputs during synthesis.
- Release zip intentionally excludes local `config.json`, logs, runtime data, unpacked build directories, and secrets.
