# Agent-facing tool contract — v0.8.0

The tool surface is intentionally small and progressive. Do not call every tool at the start of every Goal. `compass_state` is the compact default read; the current Goal anchor already carries the essential state.

## Planning and execution

### `compass_plan_create`

Use only when a Goal has real dependencies or independent workstreams. Do not create a DAG for a simple one-step task. Each task explicitly selects:
- `executor=parent`: main Agent owns the work;
- `executor=code`: main Agent uses Code Mode for deterministic batching and tool orchestration;
- `executor=subagent`: Compass automatically dispatches a configured read-only child when the task is ready.

A Subagent task must set `writeScope="read-only"`, select a configured role, and provide `dispatchReason` explaining why the extra semantic call is justified. If the work is deterministic or too small to warrant another context, choose `code` or `parent`. Plan creation does not turn parent/code tasks into children. After the planning mutation boundary, eligible Subagent tasks are automatically dispatched without a separate dispatcher call. Their structured results are consumed when the child wave finishes; independent parent/Code Mode work can proceed while the wave runs. A `before_agent_start` sweep recovers a persisted ready DAG if the earlier boundary was missed, while checking the latest Human instruction and Current Goal.

### `compass_plan_status`

Read when a decision depends on current DAG progress. It returns stable task IDs, statuses, dependencies, executor intent, ready/blocked sets, state version, acceptance and execution metadata. Use `stateVersion` directly for `compass_plan_revise`.

### `compass_plan_revise`

Use only when new evidence materially changes the route. It rejects stale state versions and material changes while an execution batch is unresolved. Existing completed work is preserved only when its task definition/dependencies remain unchanged.

### `compass_task(action=...)`

One lifecycle tool:
- `start`: parent/code task IDs only; Subagent tasks are started automatically by Compass and must not be manually started.
- `done`: each task needs concrete evidence.
- `block`: each task needs a reason.
- `reopen`: each task needs a reason.

Do not mix the `taskIds` and `tasks` input shapes. Runtime validates current IDs, statuses, dependencies and unresolved-batch conflicts.

### `compass_execution(action=status|resolve)`

This tool is only surfaced when an execution batch is failed or unresolved.

- `status`: inspect batch ID, task IDs, per-task request/run IDs, model, fallback and error state.
- `resolve`: use only when the batch is `unknown`. First check every recorded child run with native pi-subagents status. Confirm that no child remains active, provide concrete confirmation evidence, and supply one `done`/`blocked` result for every task. Never use resolve as a shortcut to retry a possibly active child.

## Parallelism policy

Compass dispatches up to four explicitly justified ready Subagent tasks concurrently. Tasks in one wave have satisfied dependencies; a later Subagent task is dispatched only after the earlier wave has terminal results and successful prerequisites. If one task blocks, its dependents remain unready. Only read-only Subagent tasks are auto-run.

The cost policy is two-stage. At planning time, `dispatchReason` must explain why the extra semantic call adds value over parent reasoning or deterministic Code Mode. At scheduling time, Compass uses observed data: with no comparable history it parallelizes the already-justified independent tasks; after three measured multi-task waves it serializes briefly if median observed wait savings is at or below five seconds, then re-probes after two successful single-child waves; it also serializes after fallback was needed in at least two of the last three measured waves. This optimizes wall time and provider pressure; it does not claim a counterfactual dollar-cost comparison with a parent-only solution. Reported per-task costs and usage remain visible for review.

Use Code Mode for deterministic repeated tool calls, parsing and state extraction. Use Subagents for semantically distinct, isolated investigations. Keep tightly coupled reasoning and mutations in the parent. Parallelism is a choice made at planning time, not a universal requirement.

## Provider fallback

Compass chooses the configured model for the task role. A single DeepSeek v4.1 Flash fallback is allowed only for recognized provider quota/rate-limit or provider-availability errors. Do not expect fallback after a semantic task failure, child timeout, malformed structured result or unknown dispatch outcome.

## Other tools

- `compass_acceptance_status`, `compass_acceptance_define`, and `compass_acceptance_record` manage Goal-level acceptance; task completion alone does not satisfy the Goal. They remain separate because each has a narrow, distinct schema; progressive disclosure limits their visibility to Goals where acceptance tracking applies. Raw tool count is not optimized at the expense of action/argument ambiguity.
- `compass_triage` is a read-only issue route review using existing event references.
- `compass_decision` records a material decision and why it supersedes an earlier route.
- `compass_checkpoint` points to a genuinely recoverable state.
- Convention CRUD is not provided. Project instructions and explicit Human constraints own working conventions.

## Live acceptance (isolated integration harness)

In an isolated, empty Pi session rooted at the Compass package directory, run `/compass-live-acceptance`. It makes at least three real read-only child calls (two in parallel and one dependency-gated; fallback can add calls), verifies returned evidence against local metadata, checks that parent/code nodes remain pending, and writes a bounded report under `/tmp`. It may incur model cost. This command is an acceptance harness, not a permanent user-facing tool, and is a development-only command and should be removed or explicitly retained as an opt-in diagnostic in the final release.

## Drift warning

Compass automatically records certain top-level path-based writes that occur outside active writable task scopes and injects a compact warning into the next Goal anchor. This reduces reliance on a reflection tool, but it is advisory and cannot detect every semantic deviation or nested Code Mode write.
