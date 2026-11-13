# Compass tool contract — current development source

The tool surface is progressive. `compass_state` is the compact default read; use other tools only when current work needs them. The Agent chooses decomposition, attention and route; code validates deterministic state and safety boundaries. A frame or DAG is optional. Task completion and Agent-reported acceptance are not independent Goal verification.

## Goal state and work plans

- `compass_state` returns the compact Goal/plan/acceptance/capability state and composite cursor deltas. `compass_goal_details`, `compass_history` and `compass_triage` are bounded on-demand reads; triage may refer to existing event IDs rather than requiring copied logs.
- `compass_plan_create` is optional. Tasks explicitly select `parent`, `code` or `subagent`; only read-only Subagent tasks can be auto-dispatched. `dispatchReason` must justify the extra semantic call. Code and parent tasks are not silently delegated.
- `compass_plan_status` reads readiness and stable task IDs. `compass_plan_revise` checks the current state version and unresolved execution state. `compass_task(action=...)` validates task identities, dependencies and lifecycle preconditions. Subagent tasks are started by Compass after eligible plan/task mutation boundaries; do not start them manually.
- `compass_execution(action=status|resolve)` is for failed or unresolved native batches. An unknown child must first be checked through native pi-subagents status; never infer it stopped or retry it automatically.

**Approval and progression contract:** A DAG is a draft until a correlated structured Human answer approves the exact Goal/criteria/tasks/dependencies/executors/constraints binding. Declined, partial, modified, stale and UI-error answers do not approve. Plan revision/constraint changes invalidate approval; task progression and auto-dispatch remain blocked until current approval. A completed task requires a separate explicit `assess` result with evidence; dependencies unlock only after a passing assessment with no unresolved caveats. Task completion, assessment, independent review and final Goal acceptance remain distinct. These code paths have local regression coverage; tests do not establish real Human UI or provider behavior.

## Same-session context frames

`compass_context` operates on the current Pi session's context projection; it does not start a Pi session or Agent loop and does not roll back filesystem/environment effects. Supported actions include `call`, `return`, `search`, `pin`, `unpin`, `transfer`, `replace`, `drop`, `load`, `move`, `spill` and `mark`. Mutations are proposed at a native turn boundary and must bind the current context revision and source/value versions.

- Frame capture/return is explicit and defaults to no captured or exported values. `ref` values are shared and survive interruption; `copy` values are private and fork on write. Complete tool-call/result exchanges are preserved.
- Search can find active, saved-parent and branch-history sources. Loads/ranges are version checked; whole working-value moves preserve message envelopes. Search is lexical, not semantic.
- Pins are scoped retained context, not system-authority instructions. A successful Skill source read must be explicitly pinned as `kind=skill` before it can be activated. `mark` tracks `active`, `handled` or `retired` status and retention lifetime.
- Spill writes and reads back a project-relative artifact before replacing context with a pointer. It does not roll back filesystem effects; a rejected later native commit can leave a reported orphan artifact.
- Native pi-await watch identity/liveness is authoritative. A frame cannot return while it owns a live watch; use native unwatch or transfer the exact arm identity to an active parent/root scope. Repeating wakes are not terminal completion.
- The installed Pi 1.5.2 path can supplement an outgoing request with missing pinned context and materialize some changes at existing boundaries. This is not a guarantee of immediate canonical restoration after every compaction. Do not claim provider cache hits or live behavior from local projection/runner tests.

M2/M3 are not fully complete: selected-range cut/reordering, semantic retrieval, repeated/subset result automation, material-external lifecycle integration, and associated measurement/reconciliation remain open. See the milestone checklist rather than treating this interface summary as release acceptance.

## RouteSet

The optional routes capability exposes a persisted RouteSet separate from the DAG. Alternatives are not DAG siblings and are not automatically fanned out. Route selection uses a structured Human questionnaire; parallel exploration requires explicit scope/budget authorization and correlated competitor identities. Competitor cancellation is exact-identity and acceptance-gated, with request/acknowledgement/terminal/unknown tracked separately. The RouteSet does not create branches or worktrees; filesystem/worktree coordination remains the Agent's responsibility.

## Native Subagents and waits

Compass delegates eligible read-only child tasks through the documented pi-subagents Structured Delegation API. It does not force-enable native tools or alter the user's tool preferences. pi-subagents owns child execution/status/cancellation; pi-await owns watch lifecycle/wakes. Compass correlates receipts and consumes child feedback but does not claim child success as Goal acceptance. Recursive Compass use inside children is not supported by the installed launch contract.

## Acceptance

`compass_acceptance_status`, `compass_acceptance_define` and `compass_acceptance_record` manage Goal criteria separately from DAG task status. A task marked done or an Agent-reported pass is not independent verification. Missing, stale, partial or contradictory evidence remains unknown/inconclusive.
