# Four-Session Field Baseline (v0.5.0-era traces)

These are the four user-supplied field traces used to guide v0.6.0. The logs contain GoalRun schema v5 and composite cursors, but no package hash; the exact installed archive cannot be cryptographically established. The report is a reproducible count of logged events, not a causal attribution of cost to Compass.

Counts distinguish top-level Pi tool calls from nested Code Mode calls explicitly recorded in tool results. A visible nested expression is not counted as executed unless the JSONL records it. The earlier 1,803 aggregate is reproducible: 1,759 top-level calls + 44 logged nested calls = 1,803 total logged calls.

| Session | Records | Assistant requests | Top-level calls | Logged nested calls | Total logged calls | Tool errors | Compass calls | Compass errors | Compactions | Recorded tokens | Final Goal outcome | DAG progress | Acceptance report |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| ikimasho.jsonl | 1567 | 478 | 664 | 12 | 676 | 26 | 71 | 9 | 6 | 64,024,684 | agent_reported_satisfied | 5/5 (0 blocked) | 10/10 reported pass |
| dispatch.jsonl | 1037 | 298 | 412 | 0 | 412 | 22 | 0 | 0 | 4 | 39,052,307 | not_assessed | no DAG | not defined |
| vtts.jsonl | 694 | 213 | 278 | 0 | 278 | 10 | 21 | 2 | 2 | 28,311,592 | blocked | 3/4 (1 blocked) | 4/4 reported pass |
| retoucher.jsonl | 970 | 274 | 405 | 32 | 437 | 18 | 60 | 0 | 3 | 36,038,060 | agent_reported_satisfied | 4/4 (0 blocked) | 5/5 reported pass |
| **TOTAL** | **4268** | **1263** | **1759** | **44** | **1803** | **76** | **152** | **11** | **15** | **167,426,643** | — | — | — |

## Recorded model usage

- Input: 36,315,111
- Output: 2,017,004
- Cache read: 129,094,528
- Cache write: 0
- Reasoning (reported separately; may be included in output): 1,474,756
- Provider-reported total tokens: 167,426,643
- Provider-reported cost sum: 3.355604 (zero/unreported cost is not evidence of zero economic cost)
- Compass unchanged state reads: 6; no-op capability opens: 3; full Goal reads: 7
- GoalRun state records parsed: 678. Per-session final Goal/DAG/acceptance projection is shown above; reported acceptance is not independent verification.

### Top-level tool calls

- `bash`: 690
- `read`: 377
- `edit`: 359
- `write`: 62
- `dispatch`: 45
- `compass_acceptance_record`: 25
- `compass_task_done`: 25
- `compass_task_start`: 23
- `ask_user_question`: 13
- `compass_decision`: 13
- `compass_state`: 13
- `codemode`: 12
- `amend`: 11
- `web_search`: 10
- `module_report`: 9
- `upload`: 9
- `read_symbol`: 8
- `compass_goal_read`: 7
- `subagent`: 7
- `compass_open`: 6
- `compass_plan_status`: 6
- `lens_diagnostics`: 5
- `compass_acceptance_status`: 4
- `web_fetch`: 4
- `compass_checkpoint`: 3
- `compass_plan_revise`: 3
- `compass_task_block`: 3
- `compass_plan_create`: 2
- `compass_acceptance_define`: 1
- `project_report`: 1
- `read_enclosing`: 1
- `retoucher_portrait`: 1
- `symbol_search`: 1

### Logged nested Code Mode calls

- `read_symbol`: 13
- `bash`: 9
- `compass_acceptance_record`: 8
- `compass_task_done`: 3
- `compass_plan_revise`: 2
- `compass_task_start`: 2
- `read`: 2
- `compass_decision`: 1
- `compass_plan_create`: 1
- `compass_plan_status`: 1
- `retoucher_image`: 1
- `retoucher_portrait`: 1

### Top-level tool errors by tool

- `edit`: 24
- `bash`: 17
- `dispatch`: 12
- `compass_task_done`: 5
- `web_search`: 5
- `compass_acceptance_record`: 2
- `read`: 2
- `amend`: 1
- `codemode`: 1
- `compass_decision`: 1
- `compass_task_block`: 1
- `compass_task_start`: 1
- `subagent`: 1
- `upload`: 1

### Nested tool errors by tool

- `bash`: 1
- `compass_plan_revise`: 1

## Interpretation limits

- A tool error is not automatically a Compass defect; classify target-project, environment, model/schema, and Compass state errors separately.
- Token totals are summed exactly as logged by the provider. Cache reads count toward reported total tokens but have different billing treatment by provider/model.
- Only nested calls present in `nestedCalls.calls` or the result's recorded `details.calls` are counted. Static Code Mode expressions are not treated as executed calls.
- Compare the same Goal class, starting repository state, Pi/model/provider, and acceptance standard before attributing savings to Compass.
