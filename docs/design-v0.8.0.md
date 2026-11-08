# Pi Compass V2 — v0.8.0 Design Contract

## North star

Lower total cost to complete arbitrary Goals without reducing correctness or delivery quality. Use deterministic code for mechanics, the main Agent for semantic decisions, Code Mode for deterministic tool batching, and pi-subagents for isolated semantic child work. Do not force a DAG or delegation on a simple Goal.

## Ownership model

| Executor | Owns | Does not own |
|---|---|---|
| `parent` | Main Agent's semantic decisions, coupled reasoning, mutations and final integration | Deterministic repeated operations that Code Mode can batch more cheaply |
| `code` | Main Agent's Code Mode scripts for deterministic tool orchestration, parsing, validation and state extraction | Semantic child sessions or final Goal acceptance |
| `subagent` | A configured pi-subagents foreground leaf with a read-only tool profile | Writes, final Goal acceptance, or control over DAG state |

The planner selects executor intent. Compass validates the declared intent and schedules only ready tasks explicitly marked `executor=subagent` and `writeScope=read-only`. Old GoalRun v2-v5 tasks migrate to `parent`, never silently to Subagent.

## Automatic Subagent DAG execution

At the finalized planning/task mutation boundary, Compass selects up to four ready read-only Subagent tasks and emits structured-delegation requests through pi-subagents' documented `prompt-template:subagent:*` event family. It does not invoke the model-visible `subagent` tool recursively, create a second agent loop, or require the main Agent to remember a separate dispatcher call.

Each request has:
- a unique `requestId` for the attempt;
- a stable batch `ownerRunId`;
- a `nodeId` equal to the DAG task ID;
- configured agent, task prompt, fresh context, working directory, model/thinking, timeout and bounded tool budget;
- a JSON schema for `status`, `summary`, `evidence`, and `reason`.

The caller correlates `requestId`, `ownerRunId`, and `nodeId` for start/update/terminal messages. A new Human veto emits exact-tuple cancellation requests for active attempts; missing cancellation acknowledgement remains unknown. `ownerRunId + nodeId` is the active logical child identity; the same logical child is not retried while the prior attempt may still be active.

A task is marked done only when the terminal response is correlated, structured output validates, and at least one concrete evidence item is present. Blocked or failed child results block the task and therefore prevent its dependents from being dispatched. After a wave settles, Compass automatically selects the next ready Subagent wave. A `before_agent_start` recovery sweep resumes ready tasks when a previous process persisted a plan but stopped before the dispatch boundary; it checks the latest Human instruction and exact Current Goal first. Parent and Code Mode tasks remain owned by the main Agent.

## Provider selection and fallback

- `scout`, `delegate`, and ordinary investigation tasks default to `cliproxyapi/gpt-6-luna` with high thinking.
- `reviewer`, `evidence-auditor`, and `oracle` use `cliproxyapi/gpt-6.1-sol` according to the proposed configuration.
- `jrt/deepseek-v4.1-flash` is the only fallback model.
- A single fallback attempt is allowed only when the primary terminal response clearly indicates provider quota/rate-limit or provider availability failure.
- Semantic task failure, structured-output failure, child timeout/deadline, generic timeout, or unknown outcome does not trigger fallback.
- The fallback is implemented in Compass after a correlated terminal response; no `fallbackModels` config field is used.
- Wave sizing uses observed multi-task history: a measured wait-saving median at or below five seconds after three samples or fallback in at least two of the last three waves reduces the next wave to one child. This is an adaptive latency/provider-pressure policy; task-level `dispatchReason` addresses the incremental model-call cost of delegation itself.

## Failure and recovery

Before emitting a wave, Compass persists its batch and per-task request IDs and moves those tasks to `in_progress`. Missing start/terminal correlation or a Pi session restart marks the batch `unknown`; Compass never automatically redispatches unknown work. The conditional `compass_execution` tool reports the current batch and allows manual reconciliation only after the native Subagent status is checked and no recorded child remains active. Reconciliation requires the exact batch ID, confirmation evidence, and a result for every task.

This is fail-closed, not proof that a caller's confirmation is truthful. The Agent must actually inspect status before using reconciliation. Material plan revisions and conflicting task transitions remain blocked while the batch is unresolved.

## Cost and benefit

The runtime stores up to eight completed wave summaries: reported child cost, summed child duration, wall duration, estimated net wait saved, fallback count and usage completeness. The estimate `sum(child duration) - batch wall time` is a rough scheduling measure. It does not establish lower total model cost versus a parent-only counterfactual. Use real session traces and task quality to decide whether the chosen decomposition paid off.

## Tool surface

- `compass_state` is the compact default read.
- `compass_open` exposes only applicable unloaded capability groups.
- `compass_plan_status` returns revision, state version, tasks, ready IDs, acceptance and latest execution summary.
- `compass_task(action=...)` consolidates task lifecycle transitions.
- `compass_execution(action=status|resolve)` is exposed only for failed/unresolved execution state.
- `compass_triage` remains read-only and refers to existing event IDs.
- No Compass-owned Convention registry exists; repository `AGENTS.md` and explicit Human instructions own working conventions.
- Path-scope drift detection is an automatic warning for observable top-level writes, not a universal semantic-drift detector or global write lock.

## Evidence boundary

A completed task is not independent Goal acceptance. A structured child result is evidence from that child, not proof that the overall Goal is correct. `goalOutcomeStatus` classifies recorded state and never upgrades an Agent-reported pass into independent verification.

## Compatibility boundary

Target `pi-subagents@0.83.1`. The integration uses the public Structured Delegation API and its documented event family. Structured delegation is foreground-only; it is not the detached workflow RPC. The user-supplied contract report includes the exact installed declarations and bundle exports; the offline contract check passes. Local contract-faithful tests are not live package compatibility proof. A real Pi 1.4.0 + pi-subagents 0.83.1 request/response cycle has now been observed in the RC6 predecessor; final 0.8.0 bytes were not re-run live. Historical acceptance false-negative is reviewed in `evidence/live-rc6/independent-review.json`.
