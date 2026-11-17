# Compass v0.10.0 local candidate handoff

## Delivery and evidence

Local M0–M7 development is complete for the declared supported boundaries. This is a **local candidate**, not live Pi/provider acceptance.

- [Field-use audit](docs/agent-usage-audit-v0.10.0.md): observed session IDs/hash, cost/benefit evidence, resolved T1–T5 and explicitly unmodified work. This round adds no forced prompt injection or workflow restrictions.
- [Release manifest](RELEASE-MANIFEST.json): implementation snapshot and native dependency identity.
- [Milestone checklist and local evidence](docs/architecture-v0.10.0.md#final-local-evidence): implemented behavior, verification results and unsupported cases.
- [Measurements](docs/measurements-v0.10.0.md): bounded local CPU/memory/context data, not provider/cache/token or semantic-quality evidence.
- [Tool contract](docs/tool-contract.md): eight fixed tools, explicit semantic Goal entry, one read surface with compact cursors/frame feedback, and safety boundaries. GoalRun v9/context v5 are current-only; old snapshots are rejected, not migrated. Stock-Pi retention uses request overlays; recursive child Compass is unsupported; race-safe artifacts require Linux. Filesystem effects are never rolled back.

- [Runtime guards](docs/runtime-guards-design.md): implemented stable-ID registration/refinement/removal, explicit scope revisions, shared global/local and native session lifecycle, result-preserving warn and native pre-execution block. Coverage is the Human-approved tool_call observation point, not post-plugin final arguments. No Human profile rules were installed by development; Node >=22.19.0 and the new owned dependency require `npm ci --ignore-scripts --omit=peer` before loading.

The Agent-facing contract has been replaced by eight fixed tools with no loader: Goal owns definitions, state owns reads, context writes memory/frames/values. Use refs unchanged and remember for compact working evidence; advanced context operations are optional. Restart Pi to load the changed modules, then use a fresh disposable session or a native branch before any v4 context snapshot. Do not migrate/reset stored context or install a second SDK. The [consumer audit](docs/agent-usage-audit-v0.10.0.md) separates proven flows/costs from unproven provider and arbitrary-task benefit.

## Human acceptance

1. [Install](README.md#install) into a safe target project; use a fresh disposable Pi session and run `/compass-preflight`.
2. Ask the Agent to create/reaffirm/update a semantic Goal through `compass_goal`; prose alone must not mutate it. Exercise a small same-session frame, ref/copy return, qualified pin, native compaction and branch navigation; check committed frame/root feedback in the native footer. Check nested Code Mode watch ownership and cancellation/transfer before returning a frame.
3. Exercise genuine structured DAG/route questionnaires: clear, conditional, partial, declined and UI-error outcomes. Only the exact unqualified answer should authorize the displayed work.
4. For actual read-only children, follow [the normal Agent/DAG acceptance path](README.md#human-acceptance) only when provider cost is acceptable: exact native Human approval, independent child evidence, explicit prerequisite assessments, then dependent execution. The obsolete synthetic live-test command/launcher/report checker was removed; it could not satisfy this approval/assessment contract. Installed API checks are not live provider results.

5. Separately exercise a session-only `runtime_guard` without a Goal: register the documented fixture, verify direct/nested warn and block, update the same ID from warn to block in one Code Mode root, test cases, then remove it using the returned scope revision. Use an isolated disposable profile for global/local checks; local must not weaken global. Unknown/bad checks must remain visible and repairable, not execute a blocked action.

Config scripts create private proposals, preserve unrelated settings and do not apply changes to global Pi settings. Do not upload credentials or full private transcripts.

For feedback, provide the failing action, expected/actual behavior, versions, error text and relevant frame/source/watch/request/run identities. Generate a local report with `node scripts/session-report.mjs <session.jsonl> --json`; review/redact it before sharing. Missing, stale, partial or contradictory evidence remains qualified rather than becoming pass.
