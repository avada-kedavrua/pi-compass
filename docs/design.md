# Pi Compass V2 — v0.10.0 Design Contract

The v0.10.0 execution contract is the current contract for GoalRun, DAG execution, Code Mode, native children/waits, context frames and acceptance. The requirement-linked implementation checklist is [`architecture-v0.10.0.md`](./architecture-v0.10.0.md).

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
- Human instructions remain authoritative. The Agent drafts the Goal and constraints, and the Human approves that exact interpretation separately from the DAG. The first semantic Goal remains Original Goal; raw instructions stay in Pi.
- New native Human input pauses further approved DAG progression until an explicit Agent interpretation reviews it. Reaffirming unchanged semantics preserves approval; changing material definitions requires new approval. Terminal native evidence is still consumed.
- Goal replacement rejects unresolved native executions and resets Goal-specific work without a separate Goal-change archive. No candidate registry, prose classifier or schema migration is retained.

## Messages contract

Raw Pi session history remains append-only. Compass stores a compact, bounded GoalRun projection and event history; it does not copy every raw tool result into a second ledger. The context-attention layer alters only the future model-context projection through validated native boundary drafts and request-side retention overlays, never the original session record. Every omission/replacement must be traceable and must preserve the evidence needed for the active Goal.

Keep Pi-owned global/project instructions and the native request prefix intact. Working content appends by default; the Agent can drop, move, spill to a verified project file, or load on demand. The Agent explicitly pins temporary instructions; verified complete Skill reads auto-pin in scope. Pins inherit downward and a child can mask them without changing the parent. Frame refs are read-only, edits stay local, and explicit exports carry selected values. Approved parent nodes can declare exact artifact inputs. Make frame state and edits observable without Human intervention.

At append, verified exact repeated native reads keep the newest payload at the tail, replace the earlier future-view payload with a pointer, and tell the Agent. Require compatible source and exact coverage; do not normalize similar or uncertain sources. Protect reserved and pinned content, raw history and tool-call/result pairing. Similarity stays advisory. Stable prefixes and reduced compaction are goals, not guarantees of provider cache hits or lower cost.

## Planning scope

A DAG executes steps of one chosen strategy. A draft does not gate the Goal, and the Agent can discard an inactive plan without changing Goal evidence. An approved plan with unfinished work is distinct from Goal acceptance. Independent nodes contribute distinct pieces of work; one node’s native launch refusal stops that node and its dependents, not independent eligible work. The Agent chooses the strategy and replans when evidence invalidates it. No RouteSet or multi-strategy execution registry.

### Approval-to-execution contract

Main prepares two definitions: the semantic Goal (outcome, constraints, final criteria) and the DAG (normalized tasks, node acceptance, execution route, scope, and dependencies). Goal input does not require context source refs. Native Human messages and answers stay in Pi; Compass retains correlation, not a second source archive. Neither a Goal proposal nor a DAG proposal is proof of acceptance.

Use one native questionnaire for the definitions that still need approval. If both are pending, present `Goal` and `DAG` as separate tabs with separate exact previews. Bind each answer to its own definition, question index, canonical preview and native exchange. Preserve a clean approval on an answered tab even if the other was left blank or needs changes; no approval on cancel, mismatched echoes or a qualifying note for that tab. A global note holds both. Do not ask again for an unchanged valid approval. A DAG cannot advance until both definitions are authorized and the latest native Human input is reviewed. A late valid answer and terminal evidence may still be recorded while advancement is paused.

- Editing a final criterion invalidates its own acceptance evidence and the Goal approval, not the DAG approval or unrelated task evidence. Main must edit the affected DAG definition too when the approved work or its execution constraints need to change. Compass never guesses that distinction from text. Replacing the objective starts a new Goal and cannot carry across an approved DAG.
- Main owns definition, revision, and approval. Nodes can report outcomes, exact exports, caveats and known side effects; they cannot revise their approved program. A same-session DAG has one serial frame lane. If multiple parent nodes are eligible, the first eligible node in the approved list runs next. Parallel native work must have an explicit executor. A native child still uses the separately documented read-only boundary until that policy is changed explicitly.
- A valid approval is the execution signal. At Pi's completed native turn boundary, Compass plans the eligible serial frame entry. A successful frame return carries the node's own semantic acceptance evidence when the successor needs it. A return and eligible successor entry must compose before the next model request without a main-frame model turn. Explicit input refs must carry only selected exports and their caveats. A blocked or inconclusive outcome cannot unlock dependents; a `throw` restores main, prevents new downstream work, and reports any effects without rolling them back. Running native work is still reconciled from correlated facts. Main resumes execution control at a stop or after the program is exhausted; completed DAG work alone does not satisfy the Goal.
- Do not activate an uncommitted frame or hold the Goal mutation queue across native preflight. A boundary preview is not the branch: Pi 1.5.2 allocates new entry IDs on actual append. A composed transition may use stable logical export identities, but must never persist a preview-generated native ID or emit an edit targeting it. Route recovery uses exact persisted branch state, not a timer or a new Agent loop.

Release evidence must include an unpatched native boundary run with one combined questionnaire and `A → B → C` frame execution (no manual opens or interim main turns), the `B throw → main` variant, partial/tab-specific approvals, input-review pause/recovery, restart or duplicate boundary, and safe independent native delegation. If these are not demonstrated, the target is incomplete; a hand-driven frame test is not a substitute.

## Compatibility

- Pi baseline: 1.5.2 for the current `context_with_system`, native boundary and installed projection behavior. Pi 0.87.0 introduced Context Edit, but Compass uses only the validated boundaries supported by the installed host.
- pi-subagents: the installed structured delegation contract owns child execution, status and cancellation; Compass does not assume extension inheritance.
- Node.js: `>=22.19.0` for the pinned public Code Mode runtime used by guards.
- GoalRun schema/API: v11; context schema v6. Start a new session or select a supported native branch when old GoalRun snapshots are present; unsupported schemas fail visibly without migration or reset.

Historical v0.9.0 architecture and implementation boundaries are in [`architecture-v0.9.0.md`](./architecture-v0.9.0.md). Historical v0.8.0 implementation details remain in [`design-v0.8.0.md`](./design-v0.8.0.md).
