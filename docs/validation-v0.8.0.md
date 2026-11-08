# Pi Compass V2 0.8.0 — Validation and release boundary

## Local verification

The final suite was rerun in the build environment against the 1.4.3 TypeBox package recovered from the user-provided RC1 ZIP, not a stub. Final source `npm test` **179/179 PASS**, `npm run test:core` **82/82 PASS**, and static preflight **PASS** (with dependency-discovery warnings due to no installed Pi CLI in the build environment). The TypeBox dependency is real 1.4.3; user RC6 had its own independent full test and Pi runtime.

## User's RC6 live Pi evidence (2026-10-29)

- Pi 1.4.0; pi-subagents 0.83.1; installed contract check passed 36/36.
- RC6 complete tests 177/177; core tests 82/82; static preflight passed; isolated config proposal checker passed.
- Isolated Pi runtime exited 0.
- Three actual read-only child agents completed with evidence and observed native tool activity. Two ran concurrently, then one dependent child. Code Mode and parent tasks remained owner-directed.
- First-wave estimated wait saving 25.079 seconds. Reported cost sum for all children 0.00117348.
- Original live report remains FAIL: its only failed check compared `cliproxyapi/gpt-6-luna:high` to an unsuffixed model ID. Independently revalidated three tool-active metrics with exact known model + allowed thinking suffix and all other eleven checks.
- The corrected model predicate and hardened offline report checker have regression tests. This does not create a new live run of final 0.8.0.

## Limitations

A live natural quota-exhaustion fallback was not observed; controlled unit tests validate fallback classification only. Config originals were not changed; user must inspect proposed updates before adoption. Parent-only economic baseline not observed, so no proven across-Goal cost decrease. Nested Code Mode or semantic drift may not be observable by the path guard.
