# Pi Compass V2 — v0.9.0 Architecture Review

## 1. Decision summary

v0.9.0 should not turn Compass into a general-purpose orchestration framework. The system already has the correct ownership split for deterministic execution, semantic investigation, and final integration. The next architecture step is to connect the existing GoalRun continuity model to Pi's native session tree without duplicating Pi's storage or introducing another scheduler.

This release implements one low-risk continuity correction: structured Human questionnaire outcomes are now retained as structured GoalRun decisions, and questionnaire UI/validation failures are recorded as failures rather than misclassified as Human declines.

The RouteSet runtime, general Caveat ledger, and Context Edit automation are deliberately specified but not wired into production hooks yet. Their safety and live Pi behavior need a real 1.4.0 runtime acceptance before they can be called implemented.

## 2. Core system model

| Layer | Owner | Responsibility | Must not become |
|---|---|---|---|
| Semantic control | Main Agent | Interpret Goal, choose route, decide what matters, synthesize evidence | A hard-coded keyword planner |
| Deterministic orchestration | Code Mode | Batch independent tool operations, parse structured outputs, validate deterministic rules | A second agent loop or scheduler |
| Semantic delegation | pi-subagents | Read-only isolated investigation with explicit incremental value | A default fan-out mechanism |
| Goal continuity | Compass | Goal version, Human directives/decisions, acceptance, evidence references, bounded event state | A duplicate raw transcript store |
| Session and context | Pi | Append-only session tree, branch navigation, compaction, context projection | A Compass-owned message database |

The original optimization target remains total practical cost to completion, not the number of calls made by Compass. Cost comparisons must include model/provider usage, latency, retries, tool errors, quality, and final acceptance evidence. A parallel wave's `sum(child duration) - wall duration` is only a wait-saving estimate, not proof of lower total cost.

### Historical evidence that constrains design

- The v0.4.0 investigation found one PPTX session with 193 top-level Code Mode calls containing about 876 Compass tool-call expressions; Triage ran 77 times, with 13 overlong-input failures. A v0.3.1 state mutation also returned a full `details.state` payload around 10–11 KB despite persistent state already existing. These were the concrete reasons for compact `compass_state`, event cursors, event-ID-based Triage and mutation-result compaction. The nested expression count was an analysis estimate from that trace, not a general rate.
- The v0.7.0 four-trace baseline recorded 2,411 total executed/logged calls (2,063 top-level + 348 logged nested), 209 Compass calls, 17 Compass errors, 100 tool errors overall, and 50 failed assistant/model requests with 12,345 seconds of reported request duration. Forty-two model request errors were `cliproxyapi/gpt-6.1-sol` in one architecture-refactor session. This evidence argues against attributing transport timeouts to Compass state logic.
- Only one of those four sessions reported a nonzero provider cost (98.195626); zero or missing cost fields are not evidence of zero economic cost. The traces also differ in Goal class and starting state, so they are a retrospective diagnostic baseline, not a controlled A/B comparison.
- The historical V1 comparison recorded native Pi at 14 calls / 135K tokens / 41.3 seconds versus the then-current full Compass route at 21 calls / 300K tokens / 77.1 seconds. This is a prior NO-GO signal for that design, not a universal result for all Goals. It is why the project must not add forced DAGs, blanket Subagent fanout, mandatory verification or a second scheduler.
- v0.8.0 RC6 live evidence recorded three real child calls and two dependency waves; the first parallel wave's 25.079-second wait-saving estimate is not a total-cost or quality-adjusted savings proof. Natural quota fallback and a matched parent-only baseline remain unproven.

Source records: `evidence/source-contracts/JavaScript编排核心优点.txt`, `evidence/source-contracts/总结项目进展.txt`, `evidence/source-contracts/ask-user-question-2.15.0-contract.md`, `docs/field-baseline-v0.7.0.md`, `docs/session-analysis-v0.7.0.md`, `docs/experiment.md`, and `docs/acceptance-matrix-v0.8.0.md`.

## 3. DeepSeekHarness — execution efficiency

Keep the current executor semantics:

- `parent`: coupled semantic reasoning, writes, decisions, and final integration.
- `code`: deterministic repeated operations and structured aggregation in the parent Agent's Code Mode.
- `subagent`: an isolated semantic read-only task only when `dispatchReason` explains why the extra model context is worth its cost.

The model chooses the decomposition and executor. Compass validates IDs, dependencies, write scope, Human veto, and dispatch preconditions. Pi Code Mode remains the deterministic orchestration runtime; pi-subagents remains the semantic child runtime. No new queue, child loop, or hidden scheduler is justified.

## 4. Prove2Me — evidence and acceptance

Keep three different facts separate:

1. **Task completion:** a unit of planned work has been reported complete with evidence.
2. **Agent-reported acceptance:** the Agent says a Goal criterion is satisfied and supplies evidence.
3. **Independent verification:** a separate verifier or external system actually confirms the criterion.

Only the third is independently verified. A completed DAG and all reported-pass criteria do not prove the Goal if a required task, human quality gate, or external dependency remains blocked or unknown.

Verification is risk-proportionate. Do not force a verification tool call after every edit. Use the least expensive evidence that can falsify the important failure modes. A failed verification should influence the next route decision, but should not force repeated retries after the evidence shows the route is wrong or blocked.

## 5. Messages — continuity and the Context Ledger

### 5.1 Three different objects

- **Raw session history:** Pi's append-only JSONL/tree. It is the audit source and is not rewritten by Compass.
- **GoalRun ledger:** bounded structured state for the active Goal: original/current Goal, versioned Human instructions, decisions, checkpoints, task/acceptance evidence, and event references.
- **Model context projection:** the subset of history and state Pi sends on a particular provider request.

Do not copy the raw transcript into GoalRun. Store structured facts and references, not duplicate logs. When a summary or projection is incomplete, report the gap instead of implying that the full history was retained.

### 5.2 Context Edit: supported mechanism, not yet activated

Pi 0.87.0 introduced append-only context edits and actionable `turn_end` / `agent_before_settle` boundaries; these capabilities are present in the Pi 1.4.0 target. A context edit can omit or replace an earlier context-producing entry for future model requests while leaving the original session entry and its UI/history representation intact. The `context` hook is a per-request projection and is not a durable history edit. `ctx.sessionManager` is documented as read-only session access; Compass must not mutate it through undocumented methods. Separately, Pi 1.4.0 restructured `tool_result` so extensions receive the full `content`, `details`, and error fields and may return partial result patches; v0.9.0 uses this latter contract for questionnaire failures.

References:
- [Pi extension lifecycle and actionable boundaries](https://pi.dev/docs/latest/extensions)
- [Pi 0.87.0 release notes for Context Edit](https://pi.dev/changelog/releases/0.87.0)
- [Pi 1.4.0 package changelog for the `tool_result` contract](https://app.unpkg.com/@earendil-works/pi-coding-agent@1.4.0/files/CHANGELOG.md)
- [Pi session format](https://pi.dev/docs/latest/session-format)

A future Context Edit implementation should use the documented boundary result (`entries` containing `context_edit` drafts), not direct session-file writes or an undocumented cross-extension API.

### 5.3 Attention policy requirements

Attention is a semantic decision owned by the Agent; code enforces only deterministic safety rules. The Agent should be able to say which prior evidence remains relevant, which content is now represented by a durable checkpoint, and which content can be omitted from future context.

Before a Context Edit can ship, all of the following must be true:

- Target IDs resolve on the active branch and are not already edited in a conflicting way.
- The edit never targets a Human message, system prompt, active Goal anchor, unresolved acceptance evidence, or a live/unknown tool exchange.
- Assistant tool-call messages and their corresponding tool results are treated as one exchange. No dangling tool call may remain in projected context.
- A source entry may be omitted only after the information needed for the active Goal has been preserved in a bounded, branch-local checkpoint with source references and caveats.
- The active Goal, hard Human directives, material decisions, failed routes, unresolved blockers, and acceptance status survive projection changes.
- Compaction after edits is tested; raw history remains inspectable and the projected branch remains coherent.
- Aborted turns, queued messages, retries, multiple extensions proposing boundary edits, and stale branch IDs fail closed.

Use `turn_end` for a completed turn's message/tool exchange when a safe edit is justified. Use `agent_before_settle` only for a final run-level checkpoint or continuation decision. Never use `agent_settled` for an edit that must affect the current run; it is notification-only.

No automatic pruning is enabled in v0.9.0. The current `context` hook already filters stale Compass anchor messages from each request. Automatically editing unrelated native tool history before the checkpoint and pairing rules are proven would risk removing evidence and create more complexity than the known benefit.

## 6. RouteSet — alternatives are not tasks

A RouteSet represents materially different strategies for one Goal version and one baseline checkpoint. Each route should contain:

- stable `routeId` and `goalVersion`;
- strategy summary and why it may work;
- assumptions and dependencies;
- expected cost/latency band and main risks (unknown when not measured);
- required acceptance criteria and evidence plan;
- current status: candidate, selected, rejected, blocked, or evaluated;
- decision/evidence references explaining selection or rejection.

The DAG is the execution graph for one selected route. It is not the list of alternative routes. Do not place mutually exclusive approaches as sibling tasks in one DAG and then let whichever finishes first win.

### Route selection and comparison

- Keep one route as the default when alternatives are not materially different or the cost of comparison exceeds expected value.
- Fork only when independent route exploration is justified. Pi's native session tree is the source of branch history; Compass should store route identity and comparison evidence, not create a second session store.
- Compare routes against the same Goal version, baseline checkpoint, and acceptance criteria.
- A route is eligible to win only when its required criteria are satisfied or its remaining caveats are explicitly accepted. Speed alone cannot win.
- If no route meets the acceptance gate, return no winner and explain the unresolved evidence.

No automatic RouteSet creation, branch fan-out, or race is enabled in v0.9.0. The current source does not yet have a branch-correlated route ledger or a verified branch lifecycle integration.

## 7. Caveat semantics

A Caveat is a material condition that limits when a decision, fact, measurement, or acceptance claim is valid. It is not a generic note and should not duplicate every unknown.

A future Caveat record should include:

- the claim/evidence/route it qualifies;
- condition or uncertainty;
- source and timestamp;
- Goal version and branch/route scope;
- severity/decision impact;
- invalidation or expiry trigger, when known;
- status: active, resolved, superseded, or accepted-by-Human.

Caveats must travel with the qualified claim through route comparison, summaries, compaction, and context edits. A superseded decision remains in history with its caveat; it must not be presented as the active route. Unresolved high-impact caveats are prioritized in the compact anchor. Do not introduce a second global memory or conventions registry.

## 8. Human questionnaire integration implemented in v0.9.0

The supplied `@juicesharp/rpiv-ask-user-question@2.15.0` result contract provides structured `details`, including `answers`, `cancelled`, `globalNote`, `unanswered`, and `error`.

Compass now:

- retains question index/text, answer kind, selected values, per-question notes, unanswered indexes, and global note;
- stores only a `hasPreview` flag, not the rich preview body, avoiding duplication of large Agent-authored markdown;
- distinguishes answered, partial, and declined outcomes;
- records questionnaire validation/UI load failures as `human_questionnaire_error` events, not Human decisions;
- prefixes structured questionnaire errors at Pi's `tool_result` middleware boundary with an explicit no-Human-answer/not-a-decline classification, preserves the extension's original diagnostic content, and marks the result as a tool error before it reaches the Agent; it then records the structured failure at `tool_execution_end` without double-counting it as a generic failure;
- preserves the old text-only capture path when older tool results do not include structured details;
- migrates existing GoalRun schema v2-v6 states to schema v7.

The bounded structured decision is available in Goal details; the compact anchor keeps only its short summary. This preserves Human intent without bloating every model request.

## 9. Release boundary and next work

Implemented:
- GoalRun schema/API v7 and v2-v6 migration.
- Structured questionnaire decision capture and failure distinction.
- Bounded normalization and tests for answered/partial/declined/error cases.
- Existing v0.8.0 execution and acceptance boundaries retained.

Not implemented and not claimed:
- RouteSet persistence/branch correlation/acceptance-gated comparison.
- General Context Ledger beyond the current GoalRun structured state and event references.
- Agent-directed durable Context Edit application.
- General Caveat object and invalidation engine.
- New live Pi 1.4.0 + pi-subagents 0.84.0 acceptance for the v0.9.1 bytes.

Next implementation order:
1. Run the exact v0.9.0 source in an isolated Pi 1.4.0 profile and verify the structured questionnaire result capture.
2. Add a read-only Context Edit probe in a disposable session: append one edit through `turn_end`, restart/reload, verify raw history unchanged and projected context changed, then test compaction and branch navigation.
3. Only after the probe passes, implement a narrowly scoped Agent-authorized context checkpoint/edit workflow.
4. Design RouteSet state against real fork/branch lifecycle evidence; keep it separate from DAG.
5. Add Caveat records only when the RouteSet and context projection contracts can preserve them without duplicate state.
