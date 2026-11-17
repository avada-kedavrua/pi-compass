# Pi Compass V2 — v0.10.0 Design Contract

The v0.10.0 execution contract is the current contract for GoalRun, DAG execution, Code Mode, native children/waits, context frames, RouteSets and acceptance. The requirement-linked implementation checklist is [`architecture-v0.10.0.md`](./architecture-v0.10.0.md).

## North star

Lower the total practical cost of completing arbitrary Goals without reducing correctness or delivery quality. Optimize correctness first, then fail-fast behavior, then cost, then simplicity. Do not optimize raw Compass call count, DAG adoption, Subagent fanout, or parallel wall time in isolation.

## Ownership

- **Agent:** interpret Human intent; explicitly create/reaffirm/replace the semantic Goal and declare constraints/acceptance; choose decomposition, capabilities, route, attention, caveats and final integration. Runtime never guesses these from natural language.
- **Pi:** session tree, message persistence, branching, compaction, and append-only context projection edits.
- **Compass:** Goal/version state, explicit Human constraints and decisions, evidence references, deterministic eligibility/validation, acceptance status, and bounded continuity projection. The optional [runtime guard kernel](runtime-guards-design.md) stores executable Agent compilations, not a second canonical conventions registry; it requires neither Goal nor DAG and uses native observation gates only.
- **Code Mode:** deterministic tool batching, parsing, validation, and aggregation in the parent context.
- **pi-subagents:** isolated semantic child work when explicitly justified, dependency-ready, and read-only.

Do not introduce a second scheduler, second session store, or duplicate convention registry. The [Agent consumer contract](tool-contract.md) exposes semantic intent and opaque exact-source refs; native bindings, context revisions and detailed lineage are code-owned mechanics, not mandatory Agent bookkeeping. Basic working memory is distinct from retaining full originals.

## Correctness contract

- Task completion, Agent-reported acceptance, and independent verification remain distinct.
- Verification intensity is proportional to risk and acceptance requirements; it is not a mandatory ritual after every operation.
- A child result is evidence, not final Goal acceptance.
- Missing, stale, partial, or contradictory evidence stays unknown/inconclusive; never upgrade it to pass.
- Human instructions remain authoritative. Goal text and constraints are Agent interpretations backed by native Human source IDs, not new Human messages or Human approval. The first semantic Goal remains Original Goal; raw original instructions stay in Pi.
- New native Human input pauses further approved DAG progression until an explicit Agent interpretation reviews it. Reaffirming unchanged semantics preserves approval; changing material definitions requires new approval. Terminal native evidence is still consumed.
- Goal replacement rejects unresolved native execution/competitor identities and resets Goal-specific work without a separate Goal-change archive. No candidate registry, prose classifier or schema migration is retained.

## Messages contract

Raw Pi session history remains append-only. Compass stores a compact, bounded GoalRun projection and event history; it does not copy every raw tool result into a second ledger. The context-attention layer alters only the future model-context projection through validated native boundary drafts and request-side retention overlays, never the original session record. Every omission/replacement must be traceable and must preserve the evidence needed for the active Goal.

## Route contract

A RouteSet is a set of alternative strategies for the same Goal version and baseline checkpoint. It is not a DAG. Only the selected route gets an execution DAG unless independent route experiments are demonstrably worth their cost. Route comparison is acceptance-gated, not first-result-wins.

## Compatibility

- Pi baseline: 1.5.2 for the current `context_with_system`, native boundary and installed projection behavior. Pi 0.87.0 introduced Context Edit, but Compass uses only the validated boundaries supported by the installed host.
- pi-subagents: the installed structured delegation contract owns child execution, status and cancellation; Compass does not assume extension inheritance.
- Node.js: `>=22.19.0` for the pinned public Code Mode runtime used by guards.
- GoalRun schema/API: v9; context schema v5. Start a new session or select a supported native branch when old GoalRun snapshots are present; unsupported schemas fail visibly without migration or reset.

Historical v0.9.0 architecture and implementation boundaries are in [`architecture-v0.9.0.md`](./architecture-v0.9.0.md). Historical v0.8.0 implementation details remain in [`design-v0.8.0.md`](./design-v0.8.0.md).
