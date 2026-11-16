---
name: pi-compass
description: Use Compass for retained Goal/evidence state, same-session attention frames, source recovery, optional Human-approved DAGs, and route comparison. Load when these reduce the work needed for a real task, not to exercise every capability.
---

# Compass: Agent operating guide

Work normally. Compass changes retained state and future context, not Pi's raw history or filesystem. Use the smallest useful operation; no obligatory Goal, frame, DAG, review or ceremony.

If Compass is absent from the available tools (check `compass_context_search` in Code Mode `ALL_TOOLS`), the Skill alone has not loaded the extension. `compass_context` is model-only and is intentionally absent from Code Mode discovery. `compass_open` cannot fix that. Human can load the local package with `pi -e /absolute/path/to/pi-compass`, or enable/trust the configured project package and `/reload`; `/compass-preflight` then reports the registry. Do not alter global settings or assume children inherit Compass.

## Goal and evidence

- When Goal tracking helps, `compass_goal({expectedVersion:0,current,constraints,acceptanceCriteria?})` creates your semantic interpretation. Human sources default to the latest native input. Submit the complete constraint list; your interpretation is not Human approval.
- Reaffirm/update the Goal after material Human input before resuming an approved DAG. Same objective/constraints can preserve exact approval; replacement reports which Goal-specific work was reset. Do not treat old criterion IDs as new-Goal evidence.
- Reuse mutation receipts. Read `compass_state({cursor})` only when state is missing; use returned cursors unchanged. Native tool diagnostics belong to `/compass-preflight`, not routine Goal reads.
- `compass_open` loads missing groups once: `acceptance`, `history`, `goal_details`, `planning`, `routes`, `issue_review`. Open only what the next step needs. No need to open planning to retain evidence.
- Acceptance is optional and may be recorded whenever evidence is available. Define concrete criteria, use returned IDs, then record `reported_pass|failed|blocked|inconclusive` with real evidence. No independent verification is inferred from your report. Status returns current full criterion text/evidence; no mandatory reread after every record.

## Retain or recover context

Read with `compass_context_search({...})`; mutate with direct `compass_context({operation:{action,...}})`. Required/allowed fields are in each schema. Model-only mutation stays available even in Code Mode-only mode; no flat mutation adapter is retained.

1. `compass_context_search({query,sourceScope?})` returns the context revision and bounded sources with exact `id`, `binding`, `version` and ranges. No prior state call is needed. Default scope is active; use parent/history/all for omitted sources. Keywords match **any** term by default and rank by matched count; use `match:"all"` for conjunction. This is literal recovery, not semantic inference. Do not slice away IDs/versions needed for the next operation.
2. Pin material instructions/evidence with `action:"pin",expectedRevision,ids`. Pins are qualified context, not extra system authority. Lifetime defaults to the current Goal, or session when no Goal exists; set session explicitly when required. Use `mark` with version, handling and reason to record active/handled/retired state. Retirement unpins; it is not deletion of raw history.
3. `load` makes a version/range-checked data copy; `move` relocates an eligible value/range. Original Human instructions and executed calls remain immutable. `replace` edits eligible working data; `drop` needs every selected source's version and preserves complete tool exchanges.
4. Spill only when a verified artifact is worth its filesystem and recovery cost: `spill` needs IDs/version, a new project-relative path and purpose; Compass writes/readbacks the artifact. `load` verifies its receipt. Do not prewrite the destination. Failed later commits can leave an artifact; no filesystem rollback is implied.

Search may run in Code Mode. **All context mutations must be direct standalone calls**, not nested or parallel with another tool. Supply mutation `expectedRevision` from search/receipt or the cursor's C segment. Validation errors happen before queued when possible. `queued` means no context commit yet; the native boundary then emits a correlated `applied` or `rejected` receipt with the actual revision. Use that receipt; do not poll. A boundary can still reject a queued operation if another extension changed its preconditions.

## Same-session attention frame

- `call` needs a local task and optional capture list; capture/export defaults are empty. `ref` shares an enclosing value and writes survive failure; `copy` is private and forks on write. Pins remain qualified inputs. A frame does not launch another Agent/session or roll back files.
- Work locally, then explicitly `return` with result/export IDs. Turn completion does not pop. Only selected outputs and material external/Human facts survive return; local process is released.
- Native watches belong to their arm identity. Cancel or transfer live frame-owned watches to root/parent before return. A repeating wake is not terminal. Use native `watch/watches/unwatch`; never poll or create a second timer loop.

## Optional plans and alternatives

- DAG tasks explicitly choose parent/code/subagent. Keep coupled reasoning with parent, deterministic batching in Code Mode, and bounded semantic investigation in read-only Subagents. `dispatchReason` explains why another context is worth it.
- A draft does not execute. The plan tool-result supplies **exact questionnaire arguments**: pass them unchanged to the native question tool, including previews. Text, partial/custom conditions and UI errors are not approval. Material definitions require new approval; status/evidence updates do not.
- Compass dispatches approved ready read-only Subagent tasks through pi-subagents. Do not manually dispatch/start them again. Native results are evidence; explicitly assess completed prerequisites against their criterion and unresolved caveats before dependents unlock. Unknown runs require native status reconciliation, not retry.
- Route alternatives are not DAG siblings. `create` requires baselineRef, shared criteria and 2–3 routes. Use the returned exact selection questionnaire; `select` cannot self-approve. `result` records a **registered native competitor**, requiring runId/routeId/correlationId and complete shared-criterion evidence, not just a route-level opinion. Existing RouteSet mutations require its current stateVersion. Exploration needs exact Human scope/budget authorization; competitor cancellation is acceptance/identity-gated.

On failure, preserve native IDs and qualifications. Use current receipts to correct the failed precondition; source inspection should not be necessary for ordinary usage. Report unknowns and boundaries honestly. A local test or Agent report is not live provider acceptance or proof of lower total cost.
