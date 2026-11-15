# v0.10 field-use audit: make called capabilities useful

Scope: repair called Compass capabilities and their Agent-facing contracts. No automatic prompt injection, mandatory adoption, new approval rituals, or changes to the application's implementation. Human will run the next live task after publication.

## Reproducible evidence

Session `01a1ddbd-24ae-7503-a29b-0a6c0c41cfcd`, source JSONL:

`/home/avada/.pi/agent/sessions/--home-avada-workspace-gitcode-ergon-studio-mindstudio-quality-monitor--/2026-11-15T05-45-22-863Z_01a1ddbd-24ae-7503-a29b-0a6c0c41cfcd.jsonl`

Frozen audit input SHA-256: `926504134a0dcae317b550a4e58181be83dd10c9b1e307a5ded16a749869f090`. Private transcript and scratch analysis are not published. Reproduce aggregate counts with `node scripts/session-report.mjs <session.jsonl> --json`; record IDs below are authoritative rather than assumed model message indices.

| Observed measure | Value |
|---|---:|
| JSONL records / assistant messages | 905 / 320 |
| Top-level / executed, logged nested tool calls | 322 / 38 |
| Compass calls / Compass tool errors | 47 / 5 |
| Context calls | search 9; pin 2; call 1 |
| Context queued receipts / later boundary rejection | 2 / 1 |
| Committed context messages | observation 10; pin 1; retention 1 |
| Native compactions | 1 |
| GoalRun snapshots / serialized snapshot bodies | 107 / 3,744,006 bytes |
| Final Goal / DAG / acceptance | v3 / none / 2 reported pass, 5 unresolved |

Elapsed session time is 8,729 seconds, including Human waits. It is **not** Compass execution time. Snapshot bytes are persistence volume, not provider input. Reported usage includes repeated cache reads; zero configured prices do not prove free requests or monetary savings. No matched parent-only baseline exists.

### Corrections to the first analysis

- A lack of demonstrated net savings is not proof of negative net savings. No causal speed, dollar, token, memory, or delivery-quality improvement can be calculated from this single uncontrolled run.
- `snapshot()` traversed the current native projection, **not the entire append-only transcript**. Its independent 256-source ceiling was nevertheless hit in this run.
- The search comparison changed both query and scope. Successful decision hits were still `origin=active`; the evidence does not establish that `scope=active` hid them. The actual matcher required every whitespace-separated term in one text block.
- The frame rejection occurred **after** a successful queued tool result, at the native boundary. It was not successful early tool-call validation.
- Raw ToolResult `details` are native integration metadata, not a reliable provider-visible payload. The old route-create response said to present a generated questionnaire without actually including it in content.
- No failed acceptance tool call was recorded. Whether acceptance should happen before or after implementation is Agent/Human workflow, not a new runtime requirement.

## Findings → fixes → checks

### T1 — Agent result projection

Status: implemented; final review/publication tracked in [delivery evidence](architecture-v0.10.0.md#final-local-evidence).

**Evidence:** old route create result `50e4590c` told the Agent to present a questionnaire but exposed only summary/cursor in content. Following attempts guessed fields or authorization. Search results also emitted duplicate `snippet`/`excerpt`; ordinary mutations repeated cursor in prose and metadata.

**Fix:** explicit JSON payloads for machine state, mutations, search, history and acceptance. The shared serializer never merges private `details` into provider content or parses prose back into fields. Mutation receipts have `resultStatus=applied|unchanged` and one cursor. Context receipts distinguish queued from applied/rejected and correlate the call. No extra `ok/resultKind` boilerplate or full GoalRun echo. Explanatory triage/Goal detail text remains on demand, rather than repeated in every mutation.

**Checks:** `tests/module-contract.test.mjs` verifies private metadata cannot overwrite domain arrays; extension regressions consume content JSON, assert no-op status and exact actionable questionnaire data.

### T2 — long-session frames and preflight

Status: implemented.

**Evidence:** call record `627da62b` / result `cc16152d` queued revision 8; native rejection `225b306a` reported the 256-source ceiling. The Agent then used shell calls to read the Skill and implementation instead of doing application work. `MAX_SOURCES` incorrectly governed both explicit selections and the parent restoration snapshot.

**Fix:** parent restoration uses native references, bounded by a 2 MiB control-metadata budget rather than the 256-item selection ceiling. No count-raising shim, native compaction prerequisite, copied transcript store or extra capacity/state call. The same planner validates before returning queued and revalidates at the actual boundary; queued never means committed. Native receipts report action, call ID and actual revision. Artifact recovery preserves its complete text/image payload separately from the compact receipt.

**Checks:** 1,000-source parent entry/return regression and a 350-source installed-runner path cover selected retention, early rejection and terminal receipts. Local replay of the exact observed call: 270 projected messages before entry, 266 restoration references, 29,780 bytes of control state; frame entered and returned, complete exchanges remained paired. This is installed SessionManager replay, **not a new live AgentSession/provider test**.

### T3 — keyword recovery and mutation boundaries

Status: implemented.

**Evidence:** search results `2ffb906f` and `e4a591d8` show keyword bags such as `红字 绿字 挑战GAP 微软雅黑 颜色` and `未转测试 口径 dts view`. The old all-terms matcher returned zero. A later history search matched a previous search result. Nested pin failed as GoalRun `E28–E29` before direct pin successfully applied at revision 8 (`120ab3f3`).

**Fix:** default literal keyword-any retrieval ranks by distinct matched terms; `match=all` preserves an explicit exact-conjunction option. Scan is bounded at 1,024 candidates, output/top-K storage at 16. Complete native search-only Code Mode results are not recursively indexed unless explicitly selected by ID. Remove duplicate excerpts. Read-only search no longer needs a preceding revision lookup; mutations still require the current revision and standalone native call. Schema states required action fields and keyword semantics. No new tools or prompt injection.

**Checks:** keyword bag/strict-all, explicit recovery of excluded search records, source qualifications and the installed retained-source path. CPU ranking now scans more candidates than the old early-hit path; the updated measurement reports this cost rather than claiming an unconditional speedup.

### T4 — route and acceptance contracts

Status: implemented.

**Evidence:** six nested route calls, four errors: create without baseline (`26cb198b`), result without state version (`901ea21c`), self-select and competitor-result without an actual competitor (`5c8126da`). The Human questionnaire was re-authored (`820ebd22`), so it could not correlate. Status contained the generated question, but the Agent truncated its own read to 700 characters. Acceptance records all succeeded; replacing Goal v2 cleared its criteria, while old criteria IDs were not reassigned.

**Fix:** route mutations return the exact generated questionnaire once in Agent-visible JSON, with an explicit next call. DAG tool-result receipts also include exact native questionnaire arguments rather than referring only to hidden details. Schema descriptions state baseline/version/run requirements; errors distinguish unknown competitors from stale correlation and explain recovery after rejected alternatives. Goal replacement reports reset criteria/task/route counts without adding an archive. Acceptance status returns full current criterion text/evidence once, not truncated prose plus duplicated hidden detail. Central validation rejects duplicate/oversized criteria and oversized evidence without silent truncation. Agent-reported pass remains distinct from independent verification; no new approval for ordinary acceptance.

**Checks:** content-only questionnaire roundtrip, unknown/stale native identities, no-op evidence, replacement identity, strict input validation, existing approval/assessment/competitor safety regressions.

### T5 — measurement and delivery

Status: implemented; publication outcome recorded in [delivery evidence](architecture-v0.10.0.md#final-local-evidence).

The session report now counts context actions, queued results, native context message actions and boundary rejections separately, and records snapshot-body bytes. It counts only executed nested calls present in JSONL, not tools merely named in scripts. The frame measurement now exercises 1,000 un-compacted active sources instead of measuring a pre-compacted 128-source tail.

## Information the Agent needs

| Needed for the next action | Omitted from the ordinary result |
|---|---|
| Actual status, cursor/revision and changed IDs | Repeated prose receipt, duplicated cursor and raw GoalRun |
| Source ID/binding/version/range, qualification and caveats | Duplicate excerpt/body and previous search envelopes |
| Current criterion IDs/status, requested evidence | Timestamps, storage fields and repeated pass disclaimers |
| Exact generated questionnaire and native authorization status | Internal approval digest and self-authored approval inputs |
| Explicit failure cause and viable correction | Generic “stale” for a missing run or misleading spill advice |

JSON is for structured state and composable receipts. Longer semantic reviews are opt-in; retaining caveats, provenance, native images and complete exchanges takes precedence over shorter output. `details` remains the native protocol channel, not an accidental source of duplicated Agent state.

## Known limitations and explicitly unmodified work

- **Net benefit:** this round demonstrates corrected operations, smaller/more complete receipts and recoverable local workflows. Dollar/token/cache savings, task-quality benefit and a matched baseline remain unproven. Meaningless calls cannot be made profitable by a tool contract.
- **Agent adoption:** deferred by Human instruction. No mandatory prompt injection, automatic semantic decisions, forced framing/planning or changed acceptance timing.
- **Context protocol:** mutations still require standalone native calls. Competing boundary edits can reject a previously validated queued operation; this is reported, never called applied. No durable immediate post-compaction canonical restoration exists on stock Pi 1.5.2.
- **Bounds:** explicit selections/value bindings, pins, depth and metadata remain bounded. A long frame produces linear native edits and reference metadata; it is not free or a provider-cache guarantee. Payload spill does not shrink parent restoration references.
- **Capability grouping:** the existing 19 tools and optional loader remain; a separate retain/frame API split is not introduced just for discoverability. Root `scope` ownership versus source-recovery naming is unchanged; use `sourceScope` explicitly for retrieval.
- **Human authorization:** native exact questionnaire correlation stays fail-closed. Re-authoring the question or slicing away its options cannot authorize a route/DAG.
- **RTK:** no majority-negative proof or global configuration changes in this round. Its gross output-token counter does not measure retry/recovery cost; assess selective filters separately before removing it.
- **Other native boundaries:** recursive child Compass and non-Linux race-safe artifact traversal remain unsupported. No installed Pi, pi-await, global instructions or user runtime configuration was modified.
