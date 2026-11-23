# v0.10 local measurements

Local replay numbers are not provider, token-cache or semantic-quality measurements. Field counts below are observations, not a matched performance comparison.

## AiClusterHub live snapshot

Private Pi session `2026-11-20T09-03-54-635Z_01a1f832-b309-70bd-83cf-9038127520ed.jsonl`; first 9,038 records only (SHA-256 `a10a19822c2a1a08073415a69880b9e9b65221b41f7321e71875d8fa9ff17da4`). GoalRun v11; the exact installed build hash is not recorded. `scripts/session-report.mjs`: 1,541 assistant requests, 1,680 top-level plus 10 logged nested calls, 52 tool errors, 65 Compass calls with 5 errors, and 8 model-request errors/interruptions (68 s of recorded request duration). The 193M reported tokens include 190.2M cache reads; they are not uncached input or billing. At cutoff the task projection had 11/13 done, with `diag` inconclusive, `ui` stopped, `e2e` pending and zero final criteria reported passed. No native child ran in this slice.

| Evidence (JSONL lines) | Root cause and ownership |
|---|---|
| L554, L6290/6294, L6659/9022 | Parent entry carried a local task but not approved cross-node scope. Seven identical Goal detail reads were 5,317 bytes each; the UI node read only the DAG and mounted in the wrong panel. Entry now carries the bound objective and constraints, not the rest of Goal state. This removes the need for routine Goal reads; it cannot guarantee semantic compliance. The `diag` criterion also duplicated UI work assigned to another node (L5534/6290); the framework correctly kept `diag` inconclusive. |
| L4363/4368, L4561–4568, L4577/4874 | From the guards return to the next node, unreviewed Human input correctly held new work. The receipt looked like a normal return to main; recovery took a state read, then more probes and a Human interruption. The same approval resumed after `update`. The receipt now states why handoff paused; unchanged input does not need a questionnaire. |
| L268/282/288, L5653/6688/9022 | An objective replacement reset the old DAG; `patch` was not applicable. In a node, patch/plan-throw are main-only; `context return(outcome)` is the exit. The original recovery did not distinguish the two `throw` routes. Schema and receipts now identify the applicable action without weakening the gates. |
| L932/2314 | Return evidence was 1,809 and 1,778 UTF-16 code units against a 1,600 limit, causing two retries and full argument echo by Pi. The shared DAG evidence limit is now 2,000; longer bodies should be cited or exported. Native schema rejection still belongs to Pi. |
| L1568, L1752–6459 | One stale guard revision and ten blocks by the session's cwd rule. CAS protected existing rules; the Agent had the revision from `put`, and the rule already gave a corrective hint. No score, predicate inference or automatic retry added. |
| L767/908/2168/3380/4919, L2188/2220/4421/4423, L4001/6617 | Missing tools/dependencies, request timeout and environment/import errors; nonunique, overlapping or unmatched edits; a completed PID and a UI inspection mode mismatch. These are project or native-tool issues. Prefer preflight of the actual target interpreter and narrow result batches. L3530–4449 also includes broad baseline tests and their interruption, not Compass execution delay. |

Bash accounts for 1,307 top-level calls. Several repeated probes were avoidable, but the trace does not show how many calls were necessary or what a matched no-Compass run would cost. In the raw prefix, 5,660 context edits (5,015 omissions and 645 replacements) occupy 2.18 MB, context snapshots 2.16 MB, GoalRun snapshots 1.76 MB. The four Compass checkpoints carry no model usage; most of their bytes are Pi `systemMessage` metadata, not injected evidence. The two native compactions are L1570 and L6628. Removing the unused `plan.activity` field would remove 38,741 serialized bytes across these GoalRun snapshots; task/event evidence remains in its original owner. This is a field-footprint calculation, not a rewrite of the log.

**Local replay.** Reconstruct the 9,036-entry branch by following `parentId` from the last entry in the fixed prefix. On Node 22.22.1, 30 full scans of the branch averaged 39.3 ms; one incremental replay through all committed context snapshots took 38.3 ms total and produced identical final control state. Ten thousand reads of the same verified branch averaged under 0.001 ms. This measures only context control restoration, excluding Pi's `getBranch`, request projection, and provider calls. The installed-boundary regressions cover compaction, unchanged-approval recovery and explicit throw routing; an existing persistence regression now exercises a warmed reader with tampered/incomplete commits and a fork. No live rerun or workload speedup is claimed.

## Local stop and field recovery checks

Compared with `262d566` on the same Pi 1.5.2 host: 38,168 schema bytes and 15,511 Code Mode signature characters before and after (seven tools). Compact state JSON stayed 193 bytes, or 52 for an unchanged cursor. In the 1,000-message fixture, frame entry took 2.34 ms median vs. 2.26 ms; both generated 1,002 edits and 168,973 bytes of drafts. These small timing samples do not establish a speed change.

The scripted MindStudio failure replay used four model-stream invocations: stale start, unchanged Goal review, authorized batch with a later failure, and final reply. No provider was called. The separate child-stop fixture measured one Pi wake for a duplicate terminal delivery and no change to the pending dependent. Neither is a replay of the full live workload.

## Earlier seven-tool schema cost

Removing RouteSet reduces the serialized tool schemas from 37,189 to 28,597 bytes (23.1%). The Code Mode declaration renderer measures 11,963 total signature characters, down from 15,442. These are schema measurements, not provider savings.

## R2 eight-tool baseline

R2 replaced the loader/capability layout with eight fixed tools. Measured on this host with `npm test`, `npm run test:core`, `npm run test:non-extension`, and `node --import ./scripts/register-pi-host-typebox.mjs scripts/measure-tool-contract.mjs`:

| Measure | Result |
|---|---:|
| Full suite | 230/230 in 3.58 s |
| Core suite | 77/77 in 0.10 s |
| Non-extension suite | 106/106 in 0.25 s |
| Registered Compass tools | 8 (native tools remain host-owned) |
| Serialized tool schemas | 37,189 bytes |
| Largest Code Mode signature | 3,972 chars (`compass_context`) |
| Code Mode signature total | 15,442 chars |

Schema bytes are parameter JSON only: they exclude the native tool envelope, rendered descriptions and provider tokenization. Signature sizes come from the installed Code Mode declaration renderer, so they bound its 16,000-character input limit; they are not provider cache or cost measurements. The suite count excludes obsolete capability/triage/loader tests instead of keeping them as skipped coverage.

The context numbers below were produced on the development host with Node 22.22.1, Pi 1.5.2 and 1,000 synthetic user messages:

```text
node scripts/measure-context.mjs
```

Observed output for the current context-v5 consumer revision (Node 22.22.1 / Pi 1.5.2):

| Measure | Result |
|---|---:|
| Compact semantic Goal read median / JSON | 0.030 ms / 179 bytes |
| Exact unchanged Goal read JSON | 38 bytes |
| Branch entries | 1,000 |
| Bounded lexical retrieval median / returned hits | 3.996 ms / 8 (1,000 candidates scanned for ranking) |
| Full lexical miss median / scanned sources | 1.600 ms / 1,000 |
| Retrieval truncation | true (bounded result) |
| Watch-state transition median | 0.067 ms |
| Frame-call planning median / active window | 2.551 ms / 1,000 sources |
| Frame-call projection edits / draft JSON | 1,002 / 168,893 bytes |
| Frame-call control-state JSON | 103,185 bytes |
| Missing-pin request overlay median | 0.219 ms |
| Compacted native / outgoing JSON | 137 / 562 bytes |
| Retained overlay increment | 425 bytes |
| Projected context JSON | 100,911 bytes |
| Control-state JSON | 79 bytes before the watch transition |
| Process RSS at sample end | 78,864,384 bytes |
| Process heap used at sample end | 12,761,896 bytes |

The Goal sample is an explicitly submitted short objective, with native source identity, no criteria/DAG and no retained raw Human prompt. Bytes measure serialized snapshot JSON, not the surrounding tool envelope or provider tokens. The unchanged sample is only cursor/unchanged; changed reads carry a single frame identity. Snapshot generation normalizes once and reuses derived acceptance/outcome summaries.

The frame sample now uses all 1,000 active sources without pre-compaction. The former 256-source restoration ceiling was removed: snapshots contain immutable native references under a 2 MiB canonical-control budget, not copied parent payloads. Explicit captures, pins, value bindings and exchange closures remain separately bounded. The sample measures production draft planning and linear edit/control overhead, not persistence latency or provider cache hits. Earlier-view edits may invalidate a provider’s cached suffix; native system/tool prefixes are not rewritten.

Keyword-any ranking scans the bounded candidate set before selecting top matches, so its 3.996 ms sample is not the same operation as the earlier early-hit lookup that stopped after eight candidates. The extra local CPU buys deterministic ranking and recovery for keyword alternatives; no unconditional performance or provider-cost win is claimed.

The overlay sample uses one explicit retained source head referencing native raw content after a synthetic native compaction; it measures serialized request-context bytes, not provider tokens. The miss sample exercises the bounded scan rather than only early matching results. Whole-process memory is not memory attributed solely to Compass.

Retrieval decision: reuse parent semantic judgment over bounded recovered candidates, with opaque exact-source refs verified by code. The obsolete public ranking/comparison handshake and dead ranking implementation were removed; mutation-time read-identity verification remains. Native code navigation tools target repository symbols rather than omitted session evidence; an embedding database or another always-on model loop would duplicate authority and add unmeasured lifecycle cost. Lexical recovery can miss paraphrases: query expansion or an explicit bounded source listing remains an Agent decision. Local tests prove source/range verification, not semantic ranking quality; no semantic benchmark or provider-cost win is claimed.

A separate installed-boundary regression uses a representative 32 KB repeated read: verified coalescing leaves one complete covered payload, preserves both raw read exchanges, and reduces serialized context bytes. This is a local fixture assertion, not a provider token/cache or universal optimization claim; small payloads may cost more in pointers and edits than they save.

The script measures the local control/index/request-overlay path only. It does not claim provider latency, token counts, cache hits, instruction compliance, semantic ranking quality, or lower cost than a parent-only route. Repeat with a representative real session before using these values for a route decision.

## Agent interface size

Run node scripts/measure-tool-contract.mjs on the installed Pi host. Common query/mutation parameter JSON is **2,901 bytes**, versus the prior public contract's 10,460 bytes (−72.3%). The callable search signature is **602 characters**, versus 1,225 (−50.9%), with a preserved input type. The common mutation schema has only pin/unpin/remember; advanced context operations use the existing explicit capability loader. The advanced schema still has a cost when requested; no entire-prompt or provider-token reduction is inferred.

For the recorded seven-source case, node scripts/measure-agent-context.mjs <session.jsonl> reproduces:

| Output | Serialized size |
|---|---:|
| Actual original search | 8,147 characters |
| New normal search, 8 hits | 2,322 characters / 3,036 bytes |
| Handles only, 8 hits | 792 characters / bytes |
| Explicit source details | 5,374 characters / 6,620 bytes |
| Qualified retained contents: seven full pins | 66,566 bytes |
| Qualified retained contents: one supplied short memory citing all seven | 406 bytes |

The last row is an explicit Agent-written conclusion/caveat, not lossless compression or evidence that every relevant fact was retained. Both branches are independently cloned before replay; the script does not mutate the transcript/profile. CPU scripts assert nonempty retrieval and the declared scanned count, avoiding a misleading fast empty-path measurement. The [field audit](agent-usage-audit-v0.10.0.md) records source identity, SHA, consumer/code reviews and limits. No strict-provider sampling or provider request was performed.

## Runtime guard cost

Run `node scripts/measure-runtime-guards.mjs` after installing the owned dependency. Node 22.22.1, public Code Mode sandbox 1.5.2; actual kernel and temporary SQLite profile with an in-memory branch adapter, 25 calls per path (first reported separately, remaining calls form warm statistics). One applicable trivial rule; this is not a many-rule throughput claim.

| Path | Warm median / p95 |
|---|---:|
| Empty profile | 0.017 / 0.059 ms |
| Registered global rule, different tool | 0.028 / 0.060 ms |
| One matching rule passes | 5.881 / 7.698 ms |
| One matching rule blocks | 5.569 / 6.722 ms |

The timing sample above measured 51.052 ms for the first put, including module/WASM/Worker startup and private store creation. A later same-fixture before/after receipt check measured 123 → 79 bytes for put, 294 → 175 for the all-scope listing, and 62 unchanged for an exact repeated listing. These are serialized payload bytes, excluding the native tool envelope; not a provider-token measurement.

Whole-process RSS was 50,135,040 bytes before the sample and 109,985,792 at its end. This includes Node, SQLite, worker, VM allocations and GC timing; it is not sole-attributed guard memory. Worker VM memory and V8 heap have separate caps, and idle workers are reaped; no zero-overhead or zero-RSS claim is made.

Reusing a Node Worker removes per-check thread creation, while each predicate still gets a fresh public sandbox VM. Matching several rules adds VM work; selectors and scope-revision caching avoid that on unrelated calls. This demonstrates bounded local mechanics and output size, not native AgentSession/provider latency, cache hits, semantic detector quality or net savings. Native warn/block/branch composition checks and independent review are recorded separately in the [canonical evidence](architecture-v0.10.0.md#final-local-evidence). This benchmark supplies a temporary profile explicitly; it did not test the default host-profile lookup and did not detect the subsequently reported native SDK-resolution failure. That failure is now covered by the separate unpatched native-factory probe; the latency sample above is not a rerun of a live session.
