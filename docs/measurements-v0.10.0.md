# v0.10 local measurements

These are bounded local measurements, not provider, token-cache, or semantic-quality evidence. They were produced on the development host with Node 22.22.1, Pi 1.5.2, and 1,000 synthetic user messages:

```text
node scripts/measure-context.mjs
```

Observed output for implementation `7aa6105` (Node 22.22.1 / Pi 1.5.2):

| Measure | Result |
|---|---:|
| Compact semantic Goal read median / JSON | 0.026 ms / 216 bytes |
| Exact unchanged Goal read JSON | 90 bytes |
| Branch entries | 1,000 |
| Bounded lexical retrieval median / returned hits | 4.253 ms / 8 (1,000 candidates scanned for ranking) |
| Full lexical miss median / scanned sources | 1.430 ms / 1,000 |
| Retrieval truncation | true (bounded result) |
| Watch-state transition median | 0.060 ms |
| Frame-call planning median / active window | 2.237 ms / 1,000 sources |
| Frame-call projection edits / draft JSON | 1,002 / 168,945 bytes |
| Frame-call control-state JSON | 103,185 bytes |
| Missing-pin request overlay median | 0.188 ms |
| Compacted native / outgoing JSON | 137 / 629 bytes |
| Retained overlay increment | 492 bytes |
| Projected context JSON | 100,911 bytes |
| Control-state JSON | 79 bytes before the watch transition |
| Process RSS at sample end | 75,546,624 bytes |
| Process heap used at sample end | 13,683,264 bytes |

The Goal sample is an explicitly submitted short objective, with native source identity, no criteria/DAG and no retained raw Human prompt. Bytes measure serialized snapshot JSON, not the surrounding tool envelope or provider tokens. The unchanged sample includes the committed root-frame indicator. Snapshot generation normalizes once and reuses derived acceptance/outcome summaries.

The frame sample now uses all 1,000 active sources without pre-compaction. The former 256-source restoration ceiling was removed: snapshots contain immutable native references under a 2 MiB canonical-control budget, not copied parent payloads. Explicit captures, pins, value bindings and exchange closures remain separately bounded. The sample measures production draft planning and linear edit/control overhead, not persistence latency or provider cache hits. Earlier-view edits may invalidate a provider’s cached suffix; native system/tool prefixes are not rewritten.

Keyword-any ranking scans the bounded candidate set before selecting top matches, so its 4.253 ms sample is not the same operation as the earlier early-hit lookup that stopped after eight candidates. The extra local CPU buys deterministic ranking and recovery for keyword alternatives; no unconditional performance or provider-cost win is claimed.

The overlay sample uses one explicit retained source head referencing native raw content after a synthetic native compaction; it measures serialized request-context bytes, not provider tokens. The miss sample exercises the bounded scan rather than only early matching results. Whole-process memory is not memory attributed solely to Compass.

Retrieval decision: reuse parent semantic judgment over bounded recovered candidates, with `rankedSources` verifying the selected IDs/versions/ranges in caller order. Native code navigation tools target repository symbols rather than omitted session evidence; an embedding database or another always-on model loop would duplicate authority and add unmeasured lifecycle cost. Lexical recovery can miss paraphrases: query expansion or an explicit bounded source listing remains an Agent decision. Local tests prove source/range verification, not semantic ranking quality; no semantic benchmark or provider-cost win is claimed.

A separate installed-boundary regression uses a representative 32 KB repeated read: verified coalescing leaves one complete covered payload, preserves both raw read exchanges, and reduces serialized context bytes. This is a local fixture assertion, not a provider token/cache or universal optimization claim; small payloads may cost more in pointers and edits than they save.

The script measures the local control/index/request-overlay path only. It does not claim provider latency, token counts, cache hits, instruction compliance, semantic ranking quality, or lower cost than a parent-only route. Repeat with a representative real session before using these values for a route decision.

## Agent interface size

Run `node scripts/measure-tool-contract.mjs` on the installed Pi host. Baseline is the actual registered mixed context schema from `c6aedff`; the current output uses `7aa6105` schemas and Pi's declaration generator.

| Measure | Baseline → current |
|---|---:|
| Context parameter JSON, both current entrypoints combined | 8,848 → 10,460 bytes (+18.2%) |
| Callable Code Mode context signature | 7,044 → 1,225 characters (−82.6%) |
| Public Compass tools including optional loader | 19 → 20 |
| Context mutation actions / schema cases | 11 / 13, plus one read-only query tool |
| Code Mode input type | Preserved, not `unknown` |

The mutation schema remains visible to the model. Its nested variants cost more JSON than a flat optional-field bag but encode required/disallowed fields and source-selection forms. Query/mutation separation reuses native model-only exposure so Code Mode-only does not hide the only legal mutation path. This is a structural correctness/callability tradeoff, not an assertion that the entire prompt, tokenizer output or provider bill is smaller. No strict-provider sampling mode is requested; actual provider acceptance remains a Human live-test item.

## Runtime guard cost

Run `node scripts/measure-runtime-guards.mjs` after installing the owned dependency. Node 22.22.1, public Code Mode sandbox 1.5.2; actual kernel and temporary SQLite profile with an in-memory branch adapter, 25 calls per path (first reported separately, remaining calls form warm statistics). One applicable trivial rule; this is not a many-rule throughput claim.

| Path | Warm median / p95 |
|---|---:|
| Empty profile | 0.017 / 0.059 ms |
| Registered global rule, different tool | 0.028 / 0.060 ms |
| One matching rule passes | 5.881 / 7.698 ms |
| One matching rule blocks | 5.569 / 6.722 ms |

First put, including module/WASM/Worker startup and private store creation: 51.052 ms. Mutation JSON: 123 bytes; compact listing: 294 bytes; exact unchanged listing: 62 bytes. Serialized JSON excludes the native tool envelope and is not a provider-token measurement.

Whole-process RSS was 50,135,040 bytes before the sample and 109,985,792 at its end. This includes Node, SQLite, worker, VM allocations and GC timing; it is not sole-attributed guard memory. Worker VM memory and V8 heap have separate caps, and idle workers are reaped; no zero-overhead or zero-RSS claim is made.

Reusing a Node Worker removes per-check thread creation, while each predicate still gets a fresh public sandbox VM. Matching several rules adds VM work; selectors and scope-revision caching avoid that on unrelated calls. This demonstrates bounded local mechanics and output size, not native AgentSession/provider latency, cache hits, semantic detector quality or net savings. Native warn/block/branch composition checks and independent review are recorded separately in the [canonical evidence](architecture-v0.10.0.md#final-local-evidence). This benchmark supplies a temporary profile explicitly; it did not test the default host-profile lookup and did not detect the subsequently reported native SDK-resolution failure. That failure is now covered by the separate unpatched native-factory probe; the latency sample above is not a rerun of a live session.
