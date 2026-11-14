# Compass v0.10.0 local candidate handoff

## Delivery

Local M0–M7 development and requirement reconciliation are complete for the declared supported boundaries. Implementation `b2d2a24` is pushed to `origin/chatgpt-only`. This is a **local candidate**, not a claim of live Pi/provider acceptance.

The canonical [milestone checklist](docs/architecture-v0.10.0.md) records implemented behavior, native reuse/unsupported decisions and verification. [README](README.md) provides installation and a short real-session guide; [tool contract](docs/tool-contract.md) explains the current surface.

## Local evidence

For implementation `b2d2a24`: full tests **278/278**, core **100/100**, non-extension **136/136**; static/installed-host preflight and the installed pi-subagents structural contract **36/36** passed. Context/retention/artifact regressions passed **66/66**. Scoped independent reviews cleared the identified high-risk findings after repairs. These are source/installed-adapter checks, not a live AgentSession/provider cycle or a clean whole-project typecheck.

The inspected baseline is Pi **1.5.2**, Node **22.22.1**, pi-subagents **0.88.1**. The release manifest owns the declared native identity. Local CPU, draft/control sizes, request-overlay bytes and process memory are measured separately in [measurements](docs/measurements-v0.10.0.md); no provider/cache/token or semantic-quality win is inferred.

## Deliberate boundaries

- Stock Pi has no general awaited immediate post-compaction canonical-restoration hook. Qualified request overlays bridge the gap until an existing native boundary; raw history and native system/tool/AGENTS state remain unchanged.
- Semantic selection stays with the parent Agent over bounded recovered candidates. Runtime verifies selected IDs/versions/ranges; there is no embedding store or always-on extra model loop.
- Repeat/subset processing is explicit. Subset relocation without shared native file-revision evidence stays unknown; similarity never triggers edits. Older unrefreshed superset content remains qualified.
- Recursive child Compass is unsupported/fail-closed under the inspected native delegation launch contract. Native pi-subagents still owns child work and pi-await owns watches; no second scheduler/observer is introduced.
- Race-safe artifact spill/reload currently requires Linux `/proc/self/fd`. Other platforms fail closed. A failed readback or native commit may leave a possible filesystem orphan; Compass does not roll back environment effects.
- Unsupported GoalRun/context snapshots fail visibly without migration or silent reset. Use a fresh session or a supported native branch.

## Human acceptance

1. Install from the README into a safe target project; use a fresh disposable Pi session and run `/compass-preflight`.
2. Exercise a small same-session frame, ref/copy return, qualified pin, native compaction and branch navigation. Check nested Code Mode watch ownership and cancellation/transfer before returning a frame.
3. Exercise genuine structured DAG/route questionnaires: clear, conditional, partial, declined and UI-error outcomes. Only the exact unqualified answer should authorize the displayed work.
4. For actual read-only children, use **another fresh session before any Goal is captured** and run `/compass-live-acceptance` only when provider cost is acceptable. Alternatively, `bash scripts/run-live-acceptance.sh` prepares an isolated launcher. Neither a passing report fixture nor an installed API check is a live provider result.

Config scripts create private proposals, preserve unrelated settings and do not apply changes to global Pi settings. Do not upload credentials or full private transcripts.

For feedback, provide the failing action, expected/actual behavior, versions, error text and relevant frame/source/watch/request/run identities. A local report can be generated with `node scripts/session-report.mjs <session.jsonl> --json`; review/redact it before sharing. Missing, stale, partial or contradictory evidence must remain qualified rather than becoming pass.
