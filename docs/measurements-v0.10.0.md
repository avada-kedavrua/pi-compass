# v0.10 local measurements

These are bounded local measurements, not provider, token-cache, or semantic-quality evidence. They were produced on the development host with Node 22.22.1, Pi 1.5.2, and 1,000 synthetic user messages:

```text
node scripts/measure-context.mjs
```

Observed output on 2026-11-13:

| Measure | Result |
|---|---:|
| Branch entries | 1,000 |
| Bounded lexical retrieval median | 0.480 ms |
| Returned hits | 8 |
| Retrieval truncation | true (bounded result) |
| Watch-state transition median | 0.053 ms |
| Projected context JSON | 100,911 bytes |
| Control-state JSON | 79 bytes before the watch transition |
| Process RSS at sample end | 70,860,800 bytes |
| Process heap used at sample end | 9,200,056 bytes |

The script measures the local control/index path only. It does not claim provider latency, token counts, cache hits, instruction compliance, semantic ranking quality, or lower cost than a parent-only route. Repeat with a representative real session before using these values for a route decision.
