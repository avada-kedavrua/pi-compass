# v0.10 local measurements

These are bounded local measurements, not provider, token-cache, or semantic-quality evidence. They were produced on the development host with Node 22.22.1, Pi 1.5.2, and 1,000 synthetic user messages:

```text
node scripts/measure-context.mjs
```

Observed output for implementation `4dc29d7` (Node 22.22.1 / Pi 1.5.2):

| Measure | Result |
|---|---:|
| Compact semantic Goal read median / JSON | 0.025 ms / 216 bytes |
| Exact unchanged Goal read JSON | 90 bytes |
| Branch entries | 1,000 |
| Bounded lexical retrieval median / returned hits | 4.061 ms / 8 (1,000 candidates scanned for ranking) |
| Full lexical miss median / scanned sources | 1.697 ms / 1,000 |
| Retrieval truncation | true (bounded result) |
| Watch-state transition median | 0.090 ms |
| Frame-call planning median / active window | 2.453 ms / 1,000 sources |
| Frame-call projection edits / draft JSON | 1,002 / 168,945 bytes |
| Frame-call control-state JSON | 103,185 bytes |
| Missing-pin request overlay median | 0.155 ms |
| Compacted native / outgoing JSON | 137 / 629 bytes |
| Retained overlay increment | 492 bytes |
| Projected context JSON | 100,911 bytes |
| Control-state JSON | 79 bytes before the watch transition |
| Process RSS at sample end | 75,657,216 bytes |
| Process heap used at sample end | 13,136,056 bytes |

The Goal sample is an explicitly submitted short objective, with native source identity, no criteria/DAG and no retained raw Human prompt. Bytes measure serialized snapshot JSON, not the surrounding tool envelope or provider tokens. The unchanged sample includes the committed root-frame indicator. Snapshot generation normalizes once and reuses derived acceptance/outcome summaries.

The frame sample now uses all 1,000 active sources without pre-compaction. The former 256-source restoration ceiling was removed: snapshots contain immutable native references under a 2 MiB canonical-control budget, not copied parent payloads. Explicit captures, pins, value bindings and exchange closures remain separately bounded. The sample measures production draft planning and linear edit/control overhead, not persistence latency or provider cache hits. Earlier-view edits may invalidate a provider’s cached suffix; native system/tool prefixes are not rewritten.

Keyword-any ranking scans the bounded candidate set before selecting top matches, so its 4.061 ms sample is not the same operation as the earlier early-hit lookup that stopped after eight candidates. The extra local CPU buys deterministic ranking and recovery for keyword alternatives; no unconditional performance or provider-cost win is claimed.

The overlay sample uses one explicit retained source head referencing native raw content after a synthetic native compaction; it measures serialized request-context bytes, not provider tokens. The miss sample exercises the bounded scan rather than only early matching results. Whole-process memory is not memory attributed solely to Compass.

Retrieval decision: reuse parent semantic judgment over bounded recovered candidates, with `rankedSources` verifying the selected IDs/versions/ranges in caller order. Native code navigation tools target repository symbols rather than omitted session evidence; an embedding database or another always-on model loop would duplicate authority and add unmeasured lifecycle cost. Lexical recovery can miss paraphrases: query expansion or an explicit bounded source listing remains an Agent decision. Local tests prove source/range verification, not semantic ranking quality; no semantic benchmark or provider-cost win is claimed.

A separate installed-boundary regression uses a representative 32 KB repeated read: verified coalescing leaves one complete covered payload, preserves both raw read exchanges, and reduces serialized context bytes. This is a local fixture assertion, not a provider token/cache or universal optimization claim; small payloads may cost more in pointers and edits than they save.

The script measures the local control/index/request-overlay path only. It does not claim provider latency, token counts, cache hits, instruction compliance, semantic ranking quality, or lower cost than a parent-only route. Repeat with a representative real session before using these values for a route decision.
