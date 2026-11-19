# Compass V2 v0.10.0 development protocol

This is an Agent-only local Pi extension. Keep changes scoped, evidence-driven, and consistent with `docs/design.md`.

## Non-negotiable principles

- Goal: lower total cost to complete arbitrary Goals without lowering delivery quality.
- Use code for deterministic mechanics: state transitions, dependency readiness, schema validation, visibility gates, duplicate detection, path-scope checks, and measurement.
- Keep `parent`, `code`, and `subagent` executor intent explicit on DAG tasks. A Subagent task must be read-only. GoalRun schema v10 and context schema v5 are current-only; unsupported snapshots fail visibly without migration or silent reset.
- The model chooses decomposition and executor; code validates state and safety boundaries.
- Compass automatically dispatches only exactly Human-approved, ready `executor=subagent` + `writeScope=read-only` tasks through the documented pi-subagents structured delegation API at the `tool_result` boundary. A `before_agent_start` sweep recovers a persisted ready DAG if that boundary was missed, after checking the latest Human instruction and exact Current Goal. It consumes structured results; it never ignores child feedback.
- Do not call the model-visible `subagent` tool recursively from a `tool_call` hook. Use the documented structured-delegation event contract from a supported event callback/application step.
- The Human is the router; each Human-managed session is a worker. Do not add a cross-session scheduler, a second Agent loop, or another watch system. Reuse Pi Code Mode, pi-subagents, and pi-await.
- Parent tasks stay with the main Agent; Code Mode tasks stay with the main Agent and are used for deterministic batching. Neither executor is silently converted to Subagent.
- No automatic retry of unknown child runs. Persist request identity before dispatch; a missing terminal response or session restart becomes `unknown` until status is checked.
- Fallback is one narrow retry for recognized provider quota/rate-limit or availability errors. Never retry semantic task failure, structured-output failure, child deadline or unknown dispatch outcome.
- GoalRun is the single source of truth for current Goal state. Original Goal, Current Goal, Human constraints, decisions, plan, and acceptance must not drift into separate stores.
- Do not build a second conventions registry. Project/repository `AGENTS.md` and explicit Human instructions own working conventions.
- Only the Agent explicitly creates/reaffirms/replaces semantic Goals through compass_goal. Runtime records native Human input identity, never infers Goals, constraints, acceptance, scope candidates or capability intent from prose. New Human input pauses approved progression until the Agent reviews it; unchanged semantics preserve exact Human approval. Raw Human messages remain native Pi records.
- Fixed operation schemas stay stable across task status/criterion changes. Runtime validates IDs and preconditions; stale references fail without mutation.
- `compass_state` is the compact default read. Prefer cursor deltas over repeated full reads. Do not require Agents to copy whole logs or manage internal state.
- A task marked done or an Agent-reported pass is not independent Goal verification.
- Do not force a DAG, Subagent, validation ritual, or rollback. Verification is risk-proportionate.
- Path-scope drift detection is advisory for observable top-level writes, not a universal semantic-drift detector or global write lock.
- Never treat tests under a fake dependency or mocked event bus as proof of live Pi compatibility.

## Delivery gate — Agent first

- Design for the Agent, not for a Human operating the tools. Do not force workflow, prompt injection, or blanket async execution.
- Before asking the Human for live acceptance, use the candidate as an Agent on a representative task in a separate disposable session. Check tool discovery, schema, receipts and recovery: the path must be fast, accurate, economical and unambiguous. If it is not, or the evidence is insufficient, do not hand it off. Keep the evidence path local.
- Do not load Compass in the current development session. Work in the order milestone → to-dos → review → commit → push. The [delivery checklist](docs/architecture-v0.10.0.md) tracks open work; [Human acceptance](README.md#human-acceptance) is separate.

## Before changing code

1. Read `docs/design.md`, the latest changelog, and relevant implementation/tests.
2. Identify whether the issue is already covered by the contract or was introduced by a prior change.
3. Prefer fixing the root cause over adding a feature.
4. Add regression tests for the observed failure and relevant edge cases.
5. Run `npm test`, `npm run test:core`, static preflight, and real Pi preflight when available.
6. For field traces, use `scripts/session-report.mjs`; count nested Code Mode calls only when the JSONL records execution. Count assistant/model request errors separately from tool errors.
7. Separate observed facts from hypotheses; never claim a live runtime check that was not run.

## Tool/result design

- Every failure result must say whether state changed; default to no mutation on validation errors.
- Unknown, stale, and cross-Goal references must be distinguishable.
- Bounded history must signal a gap instead of claiming complete history.
- Mutation results include the next cursor and immediate actionable state without echoing the full GoalRun.
- Exact unchanged state reads return only a small cursor/revision envelope.
- Dynamic visibility preserves user native-tool preferences. Compass may temporarily hide a native semantic tool under a deterministic eligibility gate, but never erases the user's enabled/disabled preference.
- Structured `ask_user_question` details are authoritative when present. Preserve answered/partial/declined distinctions and notes; questionnaire UI/validation errors are not Human decisions. Keep the text-only path for older result envelopes.
- Do not implement durable Context Edit by writing session files or mutating `ctx.sessionManager`. Pi 1.5.2 context edits must be proposed through documented actionable boundaries and must preserve complete tool-call/result exchanges.
- Parallel DAG nodes are parts of one plan, not competing plans. Strategy selection belongs to the Agent; do not add a route registry or automatic multi-strategy execution.
- Caveats qualify claims and evidence; do not flatten them into generic notes or silently drop them during summaries/projections.
