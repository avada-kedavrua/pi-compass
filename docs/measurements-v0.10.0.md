# v0.10 local measurements

All numbers below are bounded local measurements, not provider, token-cache or semantic-quality evidence.

## Seven-tool schema cost

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

First put, including module/WASM/Worker startup and private store creation: 51.052 ms. Mutation JSON: 123 bytes; compact listing: 294 bytes; exact unchanged listing: 62 bytes. Serialized JSON excludes the native tool envelope and is not a provider-token measurement.

Whole-process RSS was 50,135,040 bytes before the sample and 109,985,792 at its end. This includes Node, SQLite, worker, VM allocations and GC timing; it is not sole-attributed guard memory. Worker VM memory and V8 heap have separate caps, and idle workers are reaped; no zero-overhead or zero-RSS claim is made.

Reusing a Node Worker removes per-check thread creation, while each predicate still gets a fresh public sandbox VM. Matching several rules adds VM work; selectors and scope-revision caching avoid that on unrelated calls. This demonstrates bounded local mechanics and output size, not native AgentSession/provider latency, cache hits, semantic detector quality or net savings. Native warn/block/branch composition checks and independent review are recorded separately in the [canonical evidence](architecture-v0.10.0.md#final-local-evidence). This benchmark supplies a temporary profile explicitly; it did not test the default host-profile lookup and did not detect the subsequently reported native SDK-resolution failure. That failure is now covered by the separate unpatched native-factory probe; the latency sample above is not a rerun of a live session.
