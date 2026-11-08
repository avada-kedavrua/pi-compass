# Four-session evidence review informing v0.5.0

This review uses the four JSONL sessions uploaded for the 2026-10-24 field run. They ran the GoalRun v4 implementation, not v0.5.0. Counts below are recomputed from top-level assistant tool-call records; Code Mode's nested tool expressions are noted separately where useful. A tool error is not automatically waste: some errors were meaningful environment or test evidence.

## Objective trace summary

| Session | Top-level calls | Compass calls | Code Mode calls | Goal/plan outcome |
|---|---:|---:|---:|---|
| pi-dispatch security/deployment | 586 | 75 | 0 | Goal changed during the session; no DAG. Code was pushed and a binary uploaded, but yellow-zone installation remained unconfirmed because dispatch was concurrency-limited. |
| GPT-SoVITS Ascend TTS | 211 | 24 | 8 | Six-task DAG; three tasks done and three pending. Three candidates had real NPU attempts, but the production voice A/B and human listening gate were not satisfied. |
| AiClusterHub / OptiX | 342 | 13 | 44 | Goal narrowed to auto_aisbench integration; no DAG and no current acceptance criteria. Hub-side adapter removal reached 150 passing targeted tests, but front-end cleanup remained outstanding. |
| pptx-forge OLE stage | 76 | 8 | 0 | No DAG; 711 tests passed. Three criteria were Agent-reported passes, while the natural-language intake criterion remained inconclusive. |

These sessions are not a controlled model comparison: tasks, external dependencies, models, and GoalRun state schema differed. They are evidence for failure modes, not a leaderboard.

## Findings and design response

### 1. State reads were too expensive and too easy to repeat

The pi-dispatch session called `compass_state` 66 times. The returned text totalled about 83,293 characters; 41 adjacent calls reused the same `afterEventId` argument. The v4 response still repeated the broad Goal/plan/acceptance/runtime snapshot and its event-only cursor could not represent a state-only revision.

v0.5.0 uses a composite `R<stateRevision>-E<eventSeq>` cursor, returns a tiny `unchanged` envelope for an exact cursor, and explicitly instructs the Agent to use the injected Goal anchor and mutation results instead of polling. The cursor is client-supplied by design; this reduces cost only when the Agent reuses it.

### 2. Task tools became unavailable during a valid plan lifecycle

The TTS session made 17 `compass_task_start` / `compass_task_done` calls; nine returned `Tool ... not found` (three starts and six completions). The plan therefore did not reflect all the work the Agent had actually done. This is runtime/tool-lifecycle friction, not evidence that the semantic DAG was wrong.

v0.5.0 keeps task lifecycle names and schemas stable while a DAG is active, validates current task IDs/status/dependencies in the handler, and returns a no-mutation error for stale or invalid transitions. This should be verified in live Pi because the uploaded sessions ran v4.

### 3. Goal changes and acceptance must be explicit and versioned

AiClusterHub began with a multi-bug Goal and later narrowed to `接入 auto_aisbench 插件`. The v4 final state had zero current acceptance criteria even though the earlier prompt referenced AC1-AC10. The code work also changed scope after the user clarified the relationship between the hub-specific plugin and the external tool.

v0.5.0 preserves Original Goal, treats a versioned Goal label embedded in a longer prompt as a pending candidate rather than silently replacing Current Goal, carries the source update into Goal details, and warns when referenced acceptance IDs are missing. It does not invent the missing AC definitions; the Agent must retrieve the authoritative criteria or ask Human.

### 4. Evidence and completion are not interchangeable

In TTS, real NPU synthesis succeeded for Ming and Qwen, while IndexTTS produced reproducible blockers. The user later judged Qwen the worst candidate because of accent/listening quality. The final state correctly left listening/A-B criteria inconclusive or unverified. Objective metrics did not justify the model's earlier recommendation.

In pptx-forge, 711 tests passed, but the tool itself still did not parse arbitrary natural language; the host Agent created the intent representation. That boundary was explicitly reported rather than hidden.

v0.5.0 keeps task completion, Agent-reported acceptance, and independent verification separate. It cannot itself verify subjective listening quality or infer that an unlabelled requirement has been accepted.

### 5. Code Mode helped with batch work, but malformed orchestration still costs a call

AiClusterHub used 44 Code Mode calls with about 140 static `tools.*(...)` call expressions, including parallel reads and edits. Two attempted batch scripts failed syntax parsing before making any tool calls. This supports using Code Mode for clearly independent operations, but not building a second scheduler or forcing parallelism where dependencies are unknown.

The extension should make capability inventory precise and tool results compact; the model still owns semantic decomposition and route choice. Code Mode's own tool list must not be treated as a complete inventory of model-native tools.

### 6. Not every failure was caused by Compass

- pi-dispatch had real remote delivery blockers: forced-update queue history, old daemon askpass behavior, upload acknowledgements that remained unconfirmed, and a `concurrency_limited` dispatch result. The final handoff correctly did not claim yellow-zone installation.
- TTS had environment/asset blockers including a missing package in one local probe, a disk-full event during candidate experiments, and SSH timeout. These are not Compass defects, though the plan should preserve them as blockers.
- AiClusterHub had two malformed Code Mode scripts, an overlong decision-evidence argument, and a missing target file during refactoring. Stable schemas and better references can reduce avoidable failures, but cannot eliminate ordinary engineering mistakes.
- pptx-forge initially lacked `dotnet` on PATH and had a couple of stale file/line references before the local SDK path was found.

## v0.5.0 contract changes derived from these traces

1. Composite state cursor and bounded event deltas.
2. Stable task lifecycle schemas with handler-side state validation.
3. Goal-versioned atomic directives and bounded prioritized context projection.
4. Explicit pending Goal-change candidates for long prompts; preserve the source Human message.
5. Acceptance-ID-range mismatch warnings rather than treating any nonempty criteria list as sufficient.
6. Compact mutation results, explicit stale/unknown reference errors, and no-op mutation handling.
7. Native Subagents remain under Pi/user control and are not gated on DAG existence.

## What remains unproven

- The uploaded logs predate v0.5.0; none is a live v0.5.0 trial.
- The current build environment could not fetch the real `typebox` dependency and has no Pi CLI, so live Pi 1.3.0 tool registry/Schema replacement has not been tested here.
- Fake-registry tests establish local state/handler behavior only; they are not proof of Pi runtime compatibility.
- No controlled A/B establishes that Compass reduces total cost while preserving output quality. Future JSONL analysis must include nested Code Mode operations and independently checked deliverables.
