# Agent field review

Use at a meaningful milestone or Goal completion. Human-triggered only; do not call tools or modify code just to complete the review. For objective counts, run `node scripts/session-report.mjs <session.jsonl> ...` and cite the resulting totals rather than estimating from memory.

> Review actual Session events, tool calls, and deliverables. Mark unavailable facts `unknown`. Do not estimate call counts from memory and do not claim Compass benefit merely because the task succeeded.
>
> 1. What were Original Goal, Current Goal, and acceptance state? Did the plan change? Was the new issue already planned, introduced by a prior edit/decision, or a genuine reason to replan? If new evidence invalidated an earlier decision, was it explicitly superseded and were affected tasks reassessed?
> 2. Which capabilities were used or not triggered: compact state/delta, DAG, acceptance, triage, decisions/checkpoints, conventions, Code Mode/Subagents?
> 3. Did `compass_state` replace multiple redundant reads? Was the event cursor reused correctly? Did a history gap or stale reference occur?
> 4. Did Triage use event references? Did duplicate detection avoid repeating an unchanged review? Were any references invalid or from an old Goal?
> 5. Did tool visibility and capability inventory accurately distinguish registered from active native tools?
> 6. What were the clearest avoidable calls, retries, repeated reads, oversized results, or context costs? Separate normal engineering iteration from Compass-induced friction.
> 7. Did Human updates/directives and Goal versions survive Compaction/reload? Did explicit Restrictions/Constraints remain pinned after later instruction churn? Were any old-Goal directives leaked?
> 8. Did tasks and Goal acceptance remain distinct? If acceptance was reported satisfied while a task remained blocked, was the overall-Goal caveat explicit? What was independently verified, Agent-reported, blocked, or unknown?
> 9. Recommend at most one change, with direct trace evidence, expected benefit, and likely side effect.

## Analysis rules

- Recompute tool-call counts from JSONL, including calls nested inside `codemode` where the log exposes them.
- Do not treat every tool error as waste; classify the expected diagnostic value.
- Separate extension defects, Pi behavior, model mistakes, Human constraints, and target-project complexity.
- Model self-assessment is a hypothesis, not a source of ground truth.
