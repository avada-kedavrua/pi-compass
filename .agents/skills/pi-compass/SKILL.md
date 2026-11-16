---
name: pi-compass
description: Use Compass for retained Goal/evidence state, same-session attention frames, source recovery, optional Human-approved DAGs, and route comparison. Load when these reduce the work needed for a real task, not to exercise every capability.
---

# Compass: Agent operating guide

Work normally. Compass changes retained state and future context, not Pi's raw history or filesystem. Use the smallest useful operation; no obligatory Goal, frame, DAG, review or ceremony.

If Compass is absent from the available tools (check `compass_context_search` in Code Mode `ALL_TOOLS`), the Skill alone has not loaded the extension. `compass_context` is model-only and is intentionally absent from Code Mode discovery. `compass_open` cannot fix that. Human can load the local package with `pi -e /absolute/path/to/pi-compass`, or enable/trust the configured project package and `/reload`; `/compass-preflight` then reports the registry. Do not alter global settings or assume children inherit Compass.

## Goal and evidence

- When Goal tracking helps, `compass_goal({expectedVersion:0,current,constraints,sources,acceptanceCriteria?})` creates your semantic interpretation. Select the original Human refs that actually define the Goal; state returns the latest input ref, search/details recover earlier refs. Reviewing a follow-up does not replace the original semantic sources. Submit the complete constraint list; your interpretation is not Human approval.
- Reaffirm/update the Goal after material Human input before resuming an approved DAG. Same objective/constraints can preserve exact approval; replacement reports which Goal-specific work was reset. Do not treat old criterion IDs as new-Goal evidence.
- Reuse mutation receipts. Read `compass_state({cursor})` only when state is missing; use returned cursors unchanged. Native tool diagnostics belong to `/compass-preflight`, not routine Goal reads.
- `compass_open` loads missing groups once: `acceptance`, `history`, `goal_details`, `planning`, `routes`, `issue_review`, `context`. Context is also available without a Goal. Open only what the next step needs. No need to open planning to retain evidence.
- Acceptance is optional and may be recorded whenever evidence is available. Define concrete criteria, use returned IDs, then record `reported_pass|failed|blocked|inconclusive` with real evidence. No independent verification is inferred from your report. Status returns current full criterion text/evidence; no mandatory reread after every record.

## Optional runtime checks

- `runtime_guard` works before any Goal. Compile only worthwhile mechanical requirements into pure JS; Agent owns semantics/coverage and runtime owns safe execution. Canonical instructions remain in AGENTS/NOTES, not another prose registry.
- `get` lists scope revisions and IDs; `get+id` recovers one definition. `put`/`remove` require the **scope** revision; default session, local binds canonical Pi cwd, global affects the profile. Reuse receipts; do not register/read every turn.
- Declare native tools and only needed `input.field` observations. Return `{verdict:"pass"|"violation"|"unknown",reason?}`; no tools/I/O/output/store. Use cases, including optional parentToolCallId for nested checks. Refine the same ID instead of accumulating copies.
- `warn` keeps business results untouched and sends boundary feedback; `block` prevents the observed call but returns a native error. The control tool remains available for repair. Local cannot override global.
- Coverage is native tool_call, including Code Mode nested calls—not later plugin rewrites, independent children or arbitrary OS actions. No live clock/mutable state, device cooldown guarantee, or automatic semantic compilation. Do not blindly retry blocked/unknown actions.

## Retain or recover context

All mutation names below are actions of `compass_context({operation:{action,...}})`, not separate tools.

- Search only for missing information: compass_context_search({query}). Literal keywords match any term by default; match=all is conjunction. Default snippets are short. Choose view=handles to omit text, details for qualifications. Recover exact refs without a query; omitted sourceScope then covers all available scopes.
- Copy returned refs unchanged. Never construct IDs, binding paths or versions, decode refs, or extract a context revision from a cursor. Stale mutations reject instead of silently selecting newer content.
- Prefer remember({text,sources,caveats?}) for compact conclusions/decisions with their sources and caveats. It is Agent-authored memory, not a new observation or Human instruction. pin({sources}) retains complete originals and can cost more; use it only when full content must stay visible. Use skill=true only for the exact complete native Skill-file read.
- Lifetime defaults to the current Goal, or session before a Goal exists. Explicit lifetime=goal requires a Goal. unpin releases retention without deleting raw history.
- Context mutations are model-only **direct standalone calls**, never nested/parallel. queued is not committed; the native boundary supplies applied/rejected. Do not poll or retry unknown outcomes blindly. Other plugins may invalidate a queued operation.

## Optional attention and edits

Open compass_open({capabilities:["context"]}) once when these help; no Goal is required.

- call takes a task and optional capture. ref shares its outer value; copy is private. The applied receipt returns sources in capture order: use those returned refs to edit copies, not the original refs.
- return exports only exportSources and result; other local work is released. Shared-ref writes survive interruption/return. Frames use the same native session and do not roll back filesystem/environment changes.
- load creates a version-checked data copy; replace edits eligible working values; drop preserves complete exchanges; mark records handling. Human originals and executed calls are not editable originals. Source ranges are content-relative, not file coordinates. After replace/spill or a remainder-changing move, use the applied receipt’s updated ref for that value; the old ref no longer names its current content.
- spill needs a source ref, new project-relative path and purpose. It writes/readbacks a verified artifact; later rejection can leave a reported artifact. No filesystem rollback or silent fallback from a bad artifact is promised.
- move can relocate eligible working values or verify a complete repeated read against verifiedAgainst. The runtime checks identity/ranges, conflicts and qualifications; no separate comparison/ranking call is needed.
- A frame cannot return with live owned watches. Use native unwatch, or transfer with target=parent/root. Repeating wakes stay live; native pi-await owns identities and scheduling.

## Optional plans and alternatives

- DAG tasks explicitly choose parent/code/subagent. Keep coupled reasoning with parent, deterministic batching in Code Mode, and bounded semantic investigation in read-only Subagents. `dispatchReason` explains why another context is worth it.
- A draft does not execute. The plan tool-result supplies **exact questionnaire arguments**: pass them unchanged to the native question tool, including previews. Text, partial/custom conditions and UI errors are not approval. Material definitions require new approval; status/evidence updates do not.
- Compass dispatches approved ready read-only Subagent tasks through pi-subagents. Do not manually dispatch/start them again. Native results are evidence; explicitly assess completed prerequisites against their criterion and unresolved caveats before dependents unlock. Unknown runs require native status reconciliation, not retry.
- Route alternatives are not DAG siblings. `create` requires baselineRef, shared criteria and 2–3 routes. Use the returned exact selection questionnaire; `select` cannot self-approve. `result` records a **registered native competitor**, requiring runId/routeId/correlationId and complete shared-criterion evidence, not just a route-level opinion. Existing RouteSet mutations require its current stateVersion. Exploration needs exact Human scope/budget authorization; competitor cancellation is acceptance/identity-gated.

On failure, preserve native IDs and qualifications. Use current receipts to correct the failed precondition; source inspection should not be necessary for ordinary usage. Report unknowns and boundaries honestly. A local test or Agent report is not live provider acceptance or proof of lower total cost.
