# v0.10 local measurements

These are bounded local measurements, not provider, token-cache, or semantic-quality evidence. They were produced on the development host with Node 22.22.1, Pi 1.5.2, and 1,000 synthetic user messages:

```text
node scripts/measure-context.mjs
```

Observed output for implementation `24198a3` (Node 22.22.1 / Pi 1.5.2):

| Measure | Result |
|---|---:|
| Compact semantic Goal read median / JSON | 0.025 ms / 222 bytes |
| Exact unchanged Goal read JSON | 96 bytes |
| Branch entries | 1,000 |
| Bounded lexical retrieval median / returned hits | 0.406 ms / 8 |
| Full lexical miss median / scanned sources | 3.369 ms / 1,000 |
| Retrieval truncation | true (bounded result) |
| Watch-state transition median | 0.060 ms |
| Frame-call planning median / active window | 0.529 ms / 128 sources |
| Frame-call projection edits / draft JSON | 130 / 22,557 bytes |
| Frame-call control-state JSON | 13,375 bytes |
| Missing-pin request overlay median | 0.174 ms |
| Compacted native / outgoing JSON | 137 / 629 bytes |
| Retained overlay increment | 492 bytes |
| Projected context JSON | 100,911 bytes |
| Control-state JSON | 79 bytes before the watch transition |
| Process RSS at sample end | 77,459,456 bytes |
| Process heap used at sample end | 11,424,648 bytes |

The Goal sample is an explicitly submitted short objective, with native source identity, no criteria/DAG and no retained raw Human prompt. Bytes measure serialized snapshot JSON, not the surrounding tool envelope or provider tokens. The unchanged sample includes the committed root-frame indicator. Snapshot generation normalizes once and reuses derived acceptance/outcome summaries.

The frame sample uses a synthetic native parent summary and a bounded 128-source active tail: frame capture is limited to 256 active sources, so an unbounded 1,000-source call is deliberately rejected. It measures production draft planning and serialized edit/control overhead, not persistence latency or provider cache hits. Earlier-view edits may invalidate a provider's cached suffix; native system/tool prefixes are not rewritten.

The overlay sample uses one explicit retained source head referencing native raw content after a synthetic native compaction; it measures serialized request-context bytes, not provider tokens. The miss sample exercises the bounded scan rather than only early matching results. Whole-process memory is not memory attributed solely to Compass.

Retrieval decision: reuse parent semantic judgment over bounded recovered candidates, with `rankedSources` verifying the selected IDs/versions/ranges in caller order. Native code navigation tools target repository symbols rather than omitted session evidence; an embedding database or another always-on model loop would duplicate authority and add unmeasured lifecycle cost. Lexical recovery can miss paraphrases: query expansion or an explicit bounded source listing remains an Agent decision. Local tests prove source/range verification, not semantic ranking quality; no semantic benchmark or provider-cost win is claimed.

A separate installed-boundary regression uses a representative 32 KB repeated read: verified coalescing leaves one complete covered payload, preserves both raw read exchanges, and reduces serialized context bytes. This is a local fixture assertion, not a provider token/cache or universal optimization claim; small payloads may cost more in pointers and edits than they save.

The script measures the local control/index/request-overlay path only. It does not claim provider latency, token counts, cache hits, instruction compliance, semantic ranking quality, or lower cost than a parent-only route. Repeat with a representative real session before using these values for a route decision.
