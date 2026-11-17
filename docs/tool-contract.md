# Compass tool contract — current development source

Eight fixed tools are registered for the session; nothing is loaded, opened or hidden by Compass. `compass_state` is the only read surface. Agent payloads are selected JSON, never merged internal receipts: `content[0]` is the Agent-facing object, native `details` carries protocol state. A mutation receipt returns only the next cursor plus what the next step needs. Validation failures state that nothing changed. Raw Pi history, native tool identity and the Human's tool preferences remain native-owned.

## compass_goal — semantic definitions only

`set` records the Agent's interpretation: `current`, the complete `constraints` list, optional complete `criteria` text list, and `sources` naming the original Human refs that define the objective. Omission of `criteria` preserves the current definitions; `[]` clears them. Criterion IDs (`AC1…`) are assigned by code and returned once. `decide` records a material decision (`summary`, optional `rationale`/`evidence`/`supersedes`/`taskIds`). `checkpoint` records a real recoverable `ref`.

A different `current` replaces the Goal: version increments, plan and RouteSet reset, criteria restart, unresolved native runs block replacement. Semantic changes invalidate DAG approval, task assessments and the RouteSet while preserved task evidence stays visible. Raw prose never creates, changes or approves a Goal; latest-input review is a separate native identity, so a follow-up never rewrites semantic provenance.

Only `compass_goal` defines criteria. Plan, acceptance and route consume those criterion IDs; none of them keeps a second editable criterion list.

## compass_state — all reads

Views: `summary` (default, compact), `goal`, `plan`, `acceptance`, `history`, `route`, `execution`. Summary returns `cursor`, `frame`, Goal, outcome, latest-input ref, plan progress, acceptance counts and a bounded event delta; an exact repeat of the same cursor returns `{unchanged:true,cursor}`. `delta.historyGap`/`cursorAhead`/`omitted` mark bounded history instead of claiming completeness. Cursors are opaque and apply only to `summary`; do not construct or decode them.

`goal` returns criterion IDs/text, Human answers (when the native record exists), decisions, checkpoints and the latest-input review state. `plan` returns tasks, approval status, the native proposal prompt while unapproved, and ready IDs once approved. `execution` returns the current batch, request identity, per-task status/runId/error and summary. `route` returns the alternatives, selection state, authorized exploration, competitor runs and comparison. `acceptance` returns criterion status/evidence and `independentlyVerified:false`.

## compass_plan — optional DAG

`define` replaces the full graph (2–24 tasks). Each task names `executor: parent|code|subagent`; a `subagent` task must use `writeScope:"read-only"` and a `dispatchReason` of at least 12 characters explaining why a separate semantic context is worth the call. Goal criteria must exist first. Definition is a draft: it never authorizes execution.

`request_approval` renews the exact proposal. `start`, `done`, `block` and `reopen` update task state with code-owned preconditions; `subagent` tasks cannot be started manually. `assess` records a semantic check (`pass|fail|inconclusive` + evidence, caveats and unresolved caveats) and requires current Human approval. `resolve` reconciles only the exact current `unknown` batch and requires `confirmedNoActiveRuns:true`, concrete `confirmationEvidence` from native status, and one terminal result per batch task.

**Approval transport.** `plan`/`route` return a small `prompt` whose option preview is an opaque proposal ref. Forward that prompt unchanged to the native question tool. At the native `tool_call` boundary Compass replaces it with the canonical complete questionnaire, but only in interactive Pi with a full-preview custom TUI; RPC, print, unknown or no-UI sessions are blocked with no approval and no state change. Authorization then requires the answered option to echo the exact canonical preview plus native message identity and the current binding. Declined, partial, note-modified, global-note, UI-error and truncated-echo answers stay distinct and do not approve. New Human input or any material definition change makes a prior approval stale.

**Execution.** After an exact approval, code dispatches ready read-only Subagent tasks through the documented pi-subagents structured-delegation events and consumes correlated structured results. It never force-enables or rewrites native tool activation. Code and parent tasks are never delegated. A missing start acknowledgement or terminal response, a session shutdown or a branch change leaves the batch `unknown`; nothing is retried automatically and no task is presumed started. Dependent tasks unlock only after the prerequisite is `done` with a current passing assessment. Child success is evidence, not Goal acceptance.

## compass_acceptance — evidence only

`{results:[{criterion,status,evidence}]}` records `reported_pass|failed|blocked|inconclusive` for existing current criterion IDs. Unknown or duplicate criteria fail before mutation; an identical repeat is a no-op. This is an Agent report, never independent verification; the deterministic outcome projection classifies recorded evidence, it does not prove correctness.

## compass_route — alternatives, not tasks

`define` requires a `baselineRef` and 2–3 alternatives (`routeId`, `summary`, optional rationale/assumptions/dependencies/risks/cost/latency). Shared `criteria` default to the current Goal criterion IDs; `parallel_exploration` is reserved. `request_selection` renews the native selection proposal, and the Human's answer selects the route — there is no separate self-approving select action. `explore` requires an exactly authorized scope/budget/route-set proposal. `register`/`result` require the exact native `runId`, `routeId` and `correlationId` plus complete shared-criterion evidence; `accept` requires a competitor result that passes every shared criterion without unresolved caveats. `cancel_request|ack|terminal|unknown` track exact cancellation identity. Alternatives never become DAG tasks and are never fanned out automatically. A selected route binds the DAG approval to its baseline/route.

## compass_context — memory, frames, values

Flat actions (`pin`, `unpin`, `remember`, `call`, `return`, `load`, `replace`, `drop`, `mark`, `move`, `spill`, `transfer`). All refs are opaque; copy them unchanged. One `pin`/`unpin`/`remember` may accompany sibling tools; every other operation must be a standalone call. A `queued` result is provisional: only the correlated native applied/rejected receipt becomes active, so never poll or blindly retry.

`pin` retains complete original content (optionally the exact native Skill read with `skill:true`); `remember` stores Agent-authored compact memory with optional sources and caveats; `unpin` releases retention without deleting raw history. Lifetime defaults to the current Goal, or session before a Goal exists; explicit `lifetime:"goal"` requires a Goal.

A frame is same-session attention, not a second Agent, transcript store or filesystem rollback. `call` creates a local scope with explicit `capture` (`ref` shares, `copy` is private; its receipt returns the refs in capture order). `return` exports only `exportSources`/`result`: explicitly exported retained values keep their declared lifetime in the parent, ordinary working exports do not become retained, and unexported local work releases. Shared-ref writes survive.

`load` makes an exact copy; `replace`/`drop` edit or drop eligible working values; `mark` records handling; `move` verifies a complete repeated read against `verifiedAgainst`; `spill` writes and readbacks a new project-relative artifact before emitting its pointer. After `replace`/`spill` or a remainder-changing `move`, use the updated ref from the applied receipt. A frame cannot return with live owned watches: unwatch or `transfer` them first.

Context schema v5 is current-only. Old v4 snapshots fail visibly; there is no migration, argument adapter or silent reset. Filesystem and environment effects are never rolled back.

## runtime_guard — executable mechanical checks

`runtime_guard({operation:{action,...}})`: `get|put|test|remove` manage Agent-written pure-JS checks under session/local/global scope revisions with CAS. `put` validates code and optional cases before activation and does not echo code. Default scope is session; local binds the canonical project cwd; global affects the profile store. Local cannot weaken global.

Coverage is the native `tool_call` observation, including Code Mode nested calls — not later plugin rewrites, independent child processes or arbitrary OS actions. `warn` leaves business results untouched and delivers boundary feedback to the parent; `block` prevents the observed call and returns a native error. `unknown` stays unknown, the control tool stays repairable, and no rule is generated from Human prose. See [runtime-guards-design.md](runtime-guards-design.md).

## Boundaries

`parent` and `code` execution stay with the main Agent; only exactly approved, ready, read-only `subagent` tasks are dispatched. Task completion, assessment, independent review and Goal acceptance remain distinct. Local tests prove local behavior only: they do not establish live Pi/provider quality, cache effects or lower total cost.
