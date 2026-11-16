# v0.10 Agent consumer-contract audit

## Outcome and scope

The previous readiness criterion was insufficient: passing state/protocol tests did not prove that an Agent could cheaply consume the interface. This revision replaces the public Goal/context contract rather than adding another compatibility layer or asking the Agent to learn internal binding/revision rules. [Current operations](tool-contract.md) are authoritative; the previous public arguments are rejected.

No mandatory adoption, startup prompt injection, second state store, scheduler, semantic classifier, installed-Pi change or global configuration change is introduced. Raw native history stays immutable. GoalRun v8 remains current; the changed retained-message format requires **context v5**, current-only. Existing v4 context snapshots fail visibly; use a fresh session or a pre-context native branch, never a silent reset/migration.

## Frozen field evidence

Session `01a1e330-1289-74f2-a3b3-ce1906a8b6ef`, file `2026-11-16T07-09-00-937Z_01a1e330-1289-74f2-a3b3-ce1906a8b6ef.jsonl` in the native mindstudio-quality-monitor session directory. Frozen input SHA-256: `80d823d4d7fa8d92ba6e579b1c81ca8980622a3e35198bf0ad4673e6982f80fa`. Private transcript/body data are not published.

- Native report: 9 Compass calls, 6 tool errors, no nested Compass executions. This includes an initial SDK-resolution state failure already repaired separately, and five unsuccessful pin attempts. All context mutations remained at revision 0.
- Original task `359b8f66`; later input `55389610` contains the no-cd constraint/question. Goal creation omitted sources, so the old default recorded only the later input. Review identity and semantic provenance were incorrectly coupled.
- Search scanned 69 candidates and returned 8 hits: **8,147 response characters**, including 3,445 snippet characters, at most 600 per hit. `chars` described original source length; it was not the emitted snippet size.
- Root retention already worked. A read-only memory replay of the same seven sources committed 7 root/Goal pins at revision 1 when invented scope/binding arguments were omitted. Their original text totals 56,309 characters. The defect was the consumer model/error recovery, not a missing root capability.

Reproduce counts with `node scripts/session-report.mjs <session.jsonl> --json`. Reproduce the frozen search/retention comparison with `node scripts/measure-agent-context.mjs <session.jsonl>`; it streams through the first pin attempt, uses isolated native in-memory branches, and never writes the source session/profile.

## Replaced consumer model

| Agent decision | Code-owned mechanics |
|---|---|
| Interpret Goal/constraints; select original Human refs | Validate native Human identity and exact ref; record latest-input review separately |
| Find missing evidence; choose short preview, handles or requested details | Lexical lookup, scope resolution, exact version/binding, limits and qualifications |
| Write a compact qualified memory or deliberately retain a full original | Native snapshot ownership, version checks, revision CAS and retention lifecycle |
| Capture shared/private values; explicitly export results | Copy-on-write, returned copy refs, protocol companions and commit correlation |

A source `ref` is an opaque, stateless exact selection, not a working-set name. It replaces the ID/binding/version tuple without adding a registry. The Agent copies it; code decodes and validates it. Ordinary mutations no longer accept public revision/binding/version fields. Legacy argument adapters are not retained.

The common context schema has only pin/unpin/remember. Optional frames, edits and artifacts use the existing `compass_open` context capability, including before a Goal. This is explicit capability loading, not schemas changing with task statuses. State/search agree on `frame:"root"`; empty frame triples, no-Goal outcome duplication and empty deltas are gone. Goal and source details return refs that round-trip into their corresponding inputs.

`remember` creates labelled **Agent-derived** memory with exact source provenance and inherited caveats. It does not pretend to be a new observation or lossless summary. `pin` still preserves complete originals when required; it is not automatically cheaper. Native retained envelopes no longer display internal binding/version audits to the model. Nonempty caveats, material local task, shared/private semantics and required feedback remain visible.

## Measured local costs

| Measure | Previous | Current |
|---|---:|---:|
| Always-declared context parameter JSON | 10,460 bytes | 2,901 bytes |
| Callable search declaration | 1,225 characters | 602 characters |
| Frozen-case normal search response | 8,147 characters | 2,322 characters |
| Frozen-case handles response | not available | 792 characters |
| Qualified retention of seven full originals | 66,566 content bytes | still available explicitly |
| One supplied short memory citing those seven sources | not available | 406 content bytes |

Schema reduction is 72.3%; default search reduction in this case is 71.5%. These are serialized bytes/characters, **not provider tokens, cache hits or total-task savings**. The short memory preserves the supplied claim and caveat, not every fact in the original bodies. Semantic adequacy remains Agent-owned. No extra dependency was added. Optional advanced schema is loaded only when requested; its cost is not claimed to disappear.

## Review, regression and Occam checks

- Schema/result consumer review, restricted to public descriptions, constructed the Goal → search → remember → known-ref path without implementation knowledge. It found missing private-copy/export explanations; those were added to the relevant optional fields and re-reviewed.
- Independent implementation review found stale-ref retargeting, filtering after pagination, lost per-source bindings, non-round-trippable detail IDs, lost memory authorship and inconsistent explicit Goal lifetime. Fixes centralize current-head validation, resolve exact refs before limiting, preserve recorded provenance and reject invalid lifetime. Bounded re-review found no remaining actionable finding in that seam; reviewer execution was not claimed.
- Actual installed public Pi loader/factory/Runner executes the common contract in an isolated Node process with no test SDK resolution hook: explicit Human Goal source, short search, remember, native boundary commit and compaction recovery, plus real guard Worker/SQLite. No provider request is made. It is not a live AgentSession/provider acceptance claim.
- Three focused regressions cover exact-ref mutation/binding safety, omitted/historical exact recovery, and memory provenance/authorship/lifetime through load/export. Existing Goal-review and native consumer tests were strengthened rather than duplicating them.
- Removed unused public ranking/comparison routes and their dead ranking implementation, redundant schema-field assertions and one duplicate receipt assertion. Native duplicate-read verification remains in the mutation engine. The native consumer subprocess body is one maintained helper, not an error-dumping inline script. Protocol/branch/source safety coverage is retained.

The [canonical verification](architecture-v0.10.0.md#final-local-evidence) records actual checks and durations. Neither test count nor “all green” is the usability acceptance criterion. Current evidence supports these concrete paths and lower interface cost; arbitrary-task benefit, provider behavior and real delivery quality still require controlled Human field evidence.

## Design reference

Anthropic, [Writing effective tools for agents](https://www.anthropic.com/research/writing-tools-for-agents): design around Agent tasks, return meaningful context, offer concise/detailed responses, and evaluate task success/error/token cost rather than mirroring internal APIs. This is design guidance, not independent proof of local improvement. The frozen replay and native consumer checks above are the local evidence.
