# Pi Compass V2 v0.5.1 — Field Trace Root-Cause Review

## Scope and counting rules

This review covers the four user-supplied traces `ikimasho.jsonl`, `dispatch.jsonl`, `vtts.jsonl`, and `retoucher.jsonl`. Their state entries show GoalRun schema v5 and composite `R<revision>-E<event>` cursors, consistent with the v0.5.0 field run. The logs do not contain a package hash, so the exact installed archive cannot be cryptographically established from the traces alone.

A *top-level tool call* is a Pi `toolCall` record in an assistant message. A *tool error* is a matched top-level `toolResult` with `isError: true`; this includes target-project/environment failures and is not equivalent to a Compass defect. Code Mode contains additional nested tool expressions. Those are counted separately because a visible expression does not prove it executed if the script failed before reaching it.

| Session | JSONL records | Top-level tool calls | Top-level `isError` results | Compass calls | Compass errors |
|---|---:|---:|---:|---:|---:|
| ikimasho | 1,567 | 664 | 25 | 61 | 8 |
| dispatch | 1,037 | 412 | 22 | 0 | 0 |
| vtts | 694 | 278 | 10 | 21 | 2 |
| Retoucher | 970 | 405 | 17 | 52 | 0 |
| **Total** | **4,268** | **1,759** | **74** | **134** | **10** |

There are 12 top-level Code Mode calls and 29 statically visible nested `tools.*` references (18 Compass references, 11 other references). Their exact executed count is not independently logged. The previously stated aggregate of 1,803 tool calls is not reproducible from the current trace parser; do not use it as a verified metric.

## Per-session outcome signals

- **ikimasho:** the DAG reached 7/7 tasks done at one checkpoint, but later acceptance tracking had 4/10 criteria reported pass and 6 unverified. Task closure did not establish Goal completion.
- **dispatch:** the GoalRun state was present and the planning surface was auto-activated after three distinct write targets, but the session made zero Compass tool calls and did not create a DAG. This is an adoption/route-selection gap, not proof that the extension failed to load. The Goal involved multiple stages and safety constraints, so a clearer conditional planning instruction is warranted; forcing a DAG for every Goal is not.
- **vtts:** the observed plan had 2/3 tasks done and one blocked while acceptance was `reported_satisfied` with 3/3 Agent-reported passes. This is a valid process/evidence outcome only if the unresolved task is disclosed; it must not be presented as proof that the full Goal outcome was achieved.
- **Retoucher:** the DAG reached 4/4 tasks done, while acceptance later showed 4/5 reported pass and one unverified. Repeated reads also occurred: 12 `compass_state` calls, six returning `unchanged: true`; five `compass_open` calls, three explicitly no-op because the requested groups were already loaded; and six full Goal reads for an unchanged Goal. Some reads may have followed compaction or route changes, so these are optimization candidates rather than six proven wasteful calls.

## Root causes observed in the traces

### 1. Hard Human constraints could be evicted by later instruction churn

The v0.5.0 implementation placed all session directives in a single 24-entry retention budget. New directives could displace older constraints. The compact anchor then displayed only a ranked subset, and `compass_goal_read` returned only the last six directives. In `dispatch`, several clauses from the initial explicit Restrictions section were no longer present in the current directive list, even though the original Goal text remained stored. That created a gap between *information persisted somewhere* and *constraints visible at the decision point*.

**v0.5.1 correction:** explicit clauses from `Restrictions`/`Constraints` sections are marked `pinned`; hard constraints and soft preferences have separate bounded retention budgets. Pinned constraints rank ahead of later generic instructions. The compact anchor shows the highest-priority pinned constraints first and points to Goal details if more exist; Goal details returns all retained hard constraints before secondary history. Legacy v5 states infer pinned clauses from retained Goal/source text.

### 2. Task lifecycle required an unnecessary bookkeeping transition

Observed failures:

- `ikimasho`, 2026-10-25 05:23:26Z: `compass_task_done` rejected `e2e` because it was pending.
- `ikimasho`, 2026-10-25 06:55:59Z: `compass_task_done` rejected `veto` because it was pending.
- `vtts`, 2026-10-25 06:47:31Z: `compass_task_done` rejected `data_plan` because it was pending.

In these cases, work had already been performed before the tracking transition was recorded. Requiring `task_start` merely to register past work created an avoidable tool error without adding evidence. However, allowing arbitrary pending tasks to close would weaken dependency integrity.

**v0.5.1 correction:** a ready pending task may be marked done directly with concrete evidence; an in-progress task may also be closed. Unfinished dependencies still reject direct completion. `task_start` remains appropriate for work that is actually beginning or continuing.

### 3. Evidence schema limits caused retries and a downstream dependency failure

- `ikimasho`, 05:10:56Z: renderer completion evidence had 1,003 characters against a 1,000-character schema cap. The same assistant batch also attempted to start dependent task `e2e`, which then failed because `renderer` had not been completed.
- `ikimasho`, 07:23:49Z and 07:23:59Z: acceptance evidence of 1,465 and 1,682 characters exceeded the 1,200-character schema cap.

The renderer error was not just one rejected field: it left the dependency state unchanged, so the dependent start also failed. This is a schema ergonomics problem; evidence should remain bounded but realistic evidence must not fail over a few hundred characters.

**v0.5.1 correction:** task evidence accepts up to 1,600 characters; acceptance evidence accepts up to 2,000. Task/criterion state retains that bounded evidence. Event text remains separately capped at 1,200 and marks truncation, so increasing evidence input does not make the event stream unbounded.

### 4. Code Mode could not parse the plan version from prose

`ikimasho`, 04:28:04Z, ran:

```js
const st = await tools.compass_plan_status({});
const m = String(st).match(/stateVersion[^0-9]*(\d+)/i);
const version = m ? Number(m[1]) : null;
```

The status text used `state vN`, not the `stateVersion` label the script searched for. The script therefore supplied a null/zero-like version and `compass_plan_revise` rejected it as stale. This was avoidable because the state existed; the model was forced to scrape a human-oriented summary.

**v0.5.1 correction:** plan status text explicitly emits `stateVersion: N` and the tool returns structured revision, version, task-state, ready/blocked, and acceptance fields. The tool description instructs Code Mode to use the structured field instead of parsing prose.

### 5. Replanning did not explain invalidated work in its immediate result

The v0.5.0 mutation result listed invalidated completed task IDs but not why each task had been reset. The agent then had to inspect status/history to understand whether the reset came from a changed task definition or a changed prerequisite.

**v0.5.1 correction:** `compass_plan_revise` reports each invalidated task's prior status, new pending state, and reset reason in the same mutation result, and also exposes `invalidatedDetails` structurally. Unknown affected task IDs include the exact current task IDs; IDs are still rejected rather than silently remapped.

### 6. Agent-reported acceptance could obscure a blocked Goal outcome

In `vtts`, 3/3 acceptance criteria were reported pass while one of three DAG tasks remained blocked. These can coexist when criteria measure evidence/process discipline, but the combined status must not imply end-to-end success. The underlying values were available separately; the anchor/status summary lacked an explicit caveat connecting them.

**v0.5.1 correction:** when any DAG task remains blocked and acceptance is `reported_satisfied`, the compact anchor, plan-status summary, and structured state snapshot explicitly say that the overall Goal outcome remains unresolved unless the blocker is disclosed. This does not relabel reported evidence as failed; it prevents an unsupported completion claim.

### 7. Tool capability use was sometimes redundant, and sometimes absent

Retoucher's no-op `compass_open` calls and unchanged `compass_state` reads show that the Agent does not always internalize idempotent/no-polling guidance. Conversely, `dispatch` never opened Compass planning despite the runtime surfacing it after cross-file writes. The correct response is clearer conditional routing guidance, not forcing every Goal through a DAG or hiding native Subagents.

**v0.5.1 correction:** capability-open instructions now explicitly say to open missing groups once and not reopen groups to refresh schemas. Goal-detail reads are recommended only when the compact anchor is insufficient, then reused until the Goal/source changes or compaction removes needed details. The anchor states a direct conditional rule: open planning for multiple dependency stages or independent workstreams; leave the DAG off for simple/linear work.

## Errors not attributed to Compass

The 74 top-level `isError: true` results break down as follows:

- ikimasho: 11 `edit`, 4 `bash`, 4 `compass_task_done`, 2 `compass_acceptance_record`, 1 `codemode`, 1 `compass_task_start`, 1 `subagent`, 1 `compass_decision`.
- dispatch: 12 `dispatch`, 5 `edit`, 3 `bash`, 1 `read`, 1 `upload`.
- vtts: 6 `bash`, 2 `edit`, 1 `compass_task_done`, 1 `compass_task_block`.
- Retoucher: 6 `edit`, 5 `web_search`, 4 `bash`, 1 `amend`, 1 `read`.

Most failures are target-project edits, shell/environment problems, or dispatch outcomes. They should not be counted as Compass defects. The vtts `compass_task_block` error came from an extra `reason_extra` property rejected by the intentionally strict schema; v0.5.1 clarifies that each item accepts exactly `id` and `reason` rather than permitting arbitrary fields.

## Verification and remaining limits

- Full automated suite: **112/112 passed** after v0.5.1 changes.
- Core suite: run separately before packaging; results recorded in the delivery summary.
- Static module-contract and extension-entry import checks passed in this environment.
- Full preflight cannot pass here because the `pi` executable is not installed in this container. This is an environment limitation, not a live Pi acceptance result.
- No live Pi 1.3.0 run was performed here. The decisive next evidence is a fresh-session run of the same classes of Goals, then a new JSONL comparison. The model's decision to use or ignore planning remains a runtime behavior to measure, not something local unit tests can prove.
