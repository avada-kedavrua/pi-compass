# Pi Compass Session Report

Counts distinguish top-level Pi tool calls from nested Code Mode calls explicitly recorded in tool results. A visible nested expression is not counted as executed unless the JSONL records it.

| Session | Records | Assistant requests | Model request errors | Error wait | Top-level calls | Logged nested calls | Total logged calls | Tool errors | Compass calls | Compass errors | Compactions | Recorded tokens | Final Goal outcome | DAG progress | Acceptance report |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| 2026-10-24T10-28-27-532Z_01a16d74-670c-73f7-8952-c7e39ebfd3d6.jsonl | 3557 | 1092 | 7 | 19s | 1509 | 84 | 1593 | 60 | 176 | 17 | 17 | 148,046,194 | agent_reported_satisfied | 14/14 (0 blocked) | 10/10 reported pass |
| 2026-10-26T10-29-25-214Z_01a177c2-005d-716e-9f9a-e646c57e65b3.jsonl | 862 | 285 | 1 | 19s | 308 | 57 | 365 | 17 | 0 | 0 | 3 | 39,467,033 | not_assessed | no DAG | not defined |
| 2026-10-26T14-34-10-233Z_01a178a2-13b9-751a-ae83-5a22a136c904.jsonl | 637 | 197 | 42 | 12308s | 166 | 207 | 373 | 22 | 33 | 0 | 1 | 34,708,365 | agent_reported_satisfied | 8/8 (0 blocked) | 5/5 reported pass |
| 2026-10-27T02-15-23-767Z_01a17b24-1177-751f-ac0d-5b671cd4afff.jsonl | 182 | 50 | 0 | 0s | 80 | 0 | 80 | 1 | 0 | 0 | 0 | 4,232,281 | not_assessed | no DAG | not defined |
| **TOTAL** | **5238** | **1624** | **50** | **12345s** | **2063** | **348** | **2411** | **100** | **209** | **17** | **21** | **226,453,873** | — | — | — |

## Recorded model usage

- Input: 39,259,895
- Output: 2,357,114
- Cache read: 184,836,864
- Cache write: 0
- Reasoning (reported separately; may be included in output): 1,536,166
- Provider-reported total tokens: 226,453,873
- Provider-reported cost sum: 98.195626 (zero/unreported cost is not evidence of zero economic cost)
- Compass unchanged state reads: 0; no-op capability opens: 3; full Goal reads: 1
- Model request errors: 50; cumulative request duration reported for those errors: 12345s; longest single error request: 600s. These are provider/runtime observations, not automatically Compass defects.
- Request errors by provider/model: cliproxyapi/gpt-6.1-sol=42; avada/deepseek-v4.1-flash=8
- Longest request-error samples: 2026-10-26T14-34-10-233Z_01a178a2-13b9-751a-ae83-5a22a136c904.jsonl: cliproxyapi/gpt-6.1-sol, 600s, phase=before_message_stream_start, bytes=17633900, Codex SSE response headers timed out after 300000ms | 2026-10-26T14-34-10-233Z_01a178a2-13b9-751a-ae83-5a22a136c904.jsonl: cliproxyapi/gpt-6.1-sol, 300s, phase=unknown, bytes=unknown, Codex SSE response headers timed out after 300000ms | 2026-10-26T14-34-10-233Z_01a178a2-13b9-751a-ae83-5a22a136c904.jsonl: cliproxyapi/gpt-6.1-sol, 300s, phase=unknown, bytes=unknown, Codex SSE response headers timed out after 300000ms | 2026-10-26T14-34-10-233Z_01a178a2-13b9-751a-ae83-5a22a136c904.jsonl: cliproxyapi/gpt-6.1-sol, 300s, phase=unknown, bytes=unknown, Codex SSE response headers timed out after 300000ms | 2026-10-26T14-34-10-233Z_01a178a2-13b9-751a-ae83-5a22a136c904.jsonl: cliproxyapi/gpt-6.1-sol, 300s, phase=unknown, bytes=unknown, Codex SSE response headers timed out after 300000ms
- GoalRun state records parsed: 783. Per-session final Goal/DAG/acceptance projection is shown above; reported acceptance is not independent verification.

### Top-level tool calls

- `bash`: 960
- `read`: 358
- `edit`: 271
- `write`: 126
- `codemode`: 94
- `subagent`: 67
- `compass_task_done`: 34
- `compass_acceptance_record`: 31
- `ask_user_question`: 26
- `compass_decision`: 21
- `compass_task_start`: 20
- `amend`: 9
- `compass_plan_status`: 7
- `compass_acceptance_status`: 6
- `compass_checkpoint`: 6
- `subagent_supervisor`: 5
- `compass_open`: 4
- `compass_plan_revise`: 4
- `compass_state`: 3
- `read_symbol`: 3
- `compass_plan_create`: 2
- `watch`: 2
- `compass_acceptance_define`: 1
- `compass_goal_change`: 1
- `compass_goal_read`: 1
- `web_search`: 1

### Logged nested Code Mode calls

- `read`: 168
- `bash`: 49
- `edit`: 33
- `compass_task_done`: 20
- `compass_task_start`: 19
- `compass_acceptance_record`: 11
- `web_fetch`: 9
- `amend`: 8
- `compass_plan_revise`: 6
- `compass_decision`: 5
- `web_search`: 4
- `project_report`: 3
- `compass_plan_status`: 2
- `module_report`: 2
- `read_symbol`: 2
- `compass_acceptance_status`: 1
- `compass_checkpoint`: 1
- `compass_open`: 1
- `compass_plan_create`: 1
- `compass_state`: 1
- `lens_diagnostics`: 1
- `write`: 1

### Top-level tool errors by tool

- `bash`: 30
- `edit`: 17
- `codemode`: 11
- `compass_task_done`: 6
- `subagent`: 6
- `read`: 3
- `ask_user_question`: 2
- `compass_acceptance_record`: 2
- `compass_acceptance_define`: 1
- `compass_checkpoint`: 1
- `compass_decision`: 1
- `compass_task_start`: 1

### Nested tool errors by tool

- `bash`: 6
- `read`: 6
- `compass_plan_revise`: 2
- `compass_task_done`: 2
- `compass_task_start`: 1
- `edit`: 1
- `project_report`: 1

## Interpretation limits

- Model-request errors are counted separately from toolResult errors. A failed assistant request may consume substantial wall time without producing any tool call; durationMs is the logged request duration, not necessarily pure provider processing time.
- A tool error is not automatically a Compass defect; classify target-project, environment, model/schema, transport, and Compass state errors separately.
- Token totals are summed exactly as logged by the provider. Cache reads count toward reported total tokens but have different billing treatment by provider/model.
- Only nested calls present in `nestedCalls.calls` or the result's recorded `details.calls` are counted. Static Code Mode expressions are not treated as executed calls.
- Compare the same Goal class, starting repository state, Pi/model/provider, and acceptance standard before attributing savings to Compass.
