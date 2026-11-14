# Compass v0.10.0 local candidate handoff

## Delivery and evidence

Local M0–M7 development is complete for the declared supported boundaries. This is a **local candidate**, not live Pi/provider acceptance.

- [Release manifest](RELEASE-MANIFEST.json): implementation snapshot and native dependency identity.
- [Milestone checklist and local evidence](docs/architecture-v0.10.0.md#final-local-evidence): implemented behavior, verification results and unsupported cases.
- [Measurements](docs/measurements-v0.10.0.md): bounded local CPU/memory/context data, not provider/cache/token or semantic-quality evidence.
- [Tool contract](docs/tool-contract.md): progressive tool use and safety boundaries. Stock-Pi retention uses request overlays; recursive child Compass is unsupported; race-safe artifacts require Linux. Filesystem effects are never rolled back.

## Human acceptance

1. [Install](README.md#install) into a safe target project; use a fresh disposable Pi session and run `/compass-preflight`.
2. Exercise a small same-session frame, ref/copy return, qualified pin, native compaction and branch navigation. Check nested Code Mode watch ownership and cancellation/transfer before returning a frame.
3. Exercise genuine structured DAG/route questionnaires: clear, conditional, partial, declined and UI-error outcomes. Only the exact unqualified answer should authorize the displayed work.
4. For actual read-only children, use **another fresh session before any Goal is captured** and run `/compass-live-acceptance` only when provider cost is acceptable. Alternatively, `bash scripts/run-live-acceptance.sh` prepares an isolated launcher. Neither a passing report fixture nor an installed API check is a live provider result.

Config scripts create private proposals, preserve unrelated settings and do not apply changes to global Pi settings. Do not upload credentials or full private transcripts.

For feedback, provide the failing action, expected/actual behavior, versions, error text and relevant frame/source/watch/request/run identities. Generate a local report with `node scripts/session-report.mjs <session.jsonl> --json`; review/redact it before sharing. Missing, stale, partial or contradictory evidence remains qualified rather than becoming pass.
