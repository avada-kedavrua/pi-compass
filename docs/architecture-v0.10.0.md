# Compass v0.10.0 — architecture and implementation TODO

Status: development contract, not an implemented or runtime-accepted release.

## Objective and engineering contract

Minimize total cost to finish a Goal without reducing quality. Prefer a coherent design over a small patch. Refactor or replace existing mechanisms when that reduces coupling, runtime cost, memory, maintenance or future development. Do not ship legacy adapters, duplicate control planes or old/new implementations in parallel. A large diff is acceptable; shotgun edits and speculative abstractions are not.

The Human is the Router; separately managed Pi sessions are Workers. Compass does not add a router, cross-session scheduler or agent loop. Runtime validates deterministic mechanics; the Agent owns semantic decisions. Conventions remain in global/project AGENTS.md and explicit Human instructions, not a Compass registry.

Research baseline: Pi 1.5.2; installed pi-subagents 0.88.0; sibling pi-await 1.3.0 candidate revision 4, commit `8a51e51`. Do not modify pi-await or global Pi configuration here. A source/API inspection is not live compatibility proof.

## Confirmed semantics

### Tasks and execution

Reuse the task as the unit of work. A route is an alternative strategy, not a DAG sibling. A DAG is optional; when used, its concrete definition and acceptance criteria require structured Human approval before execution. Material changes invalidate that approval; ordinary status changes do not.

A task may run in the parent, through deterministic Code Mode, through an in-place context frame, or through pi-subagents when independent execution is justified. Do not create a second task registry or infer a new scheduler from this vocabulary. Current automatic delegation remains explicitly declared and read-only until its authority is deliberately changed.

Human approval is authorization and semantic alignment, not evidence that execution succeeded. Task completion, Agent assessment, independent review and Goal acceptance remain distinct. Do not use self-reported "100% confidence" as a proof gate. Unknown evidence stays unknown. Verification intensity must justify its cost.

Explicitly authorized alternative routes may stop competitors only after a clear acceptance gate passes. Cancellation acknowledgements and actual termination are different facts. Filesystem effects are the Agent's responsibility; frame pop does not roll them back.

### In-place calls and lambda capture

The required function-like task does not start another Pi Session, AgentSession or Agent Loop. The same session switches its active messages between LLM requests.

- A frame is the context scope of a call.
- Capture and export are explicit; both default to none, apart from reserved instructions and the call's own definition.
- `ref` changes the enclosing logical slot. Writes persist even if the call fails, is interrupted or never returns normally.
- `copy` has a private value. Local changes do not change the enclosing slot. Prefer reference/version metadata and copy-on-write over eager transcript copies.
- Returning releases local working context and restores the parent with selected exports. It does not restore model hidden state or environment state.
- Shared slots are scoped to frames of this one session, not writable cross-session shared memory.
- The Agent explicitly enters and returns; finishing a turn or waiting for Human input does not imply pop.

The native subagent backend is complementary, not a substitute for this same-session requirement. pi-subagents 0.88.0 local foreground children already share the parent process; detached runners can reuse processes. Do not assume a process startup per child or claim coroutine savings without measurement.

## Context, retention and recovery

Pi remains the only raw transcript store. GoalRun is the single Compass state owner. Store bounded control metadata, source IDs and versions rather than another copy of message history.

- Reserved: Pi-owned system/prompt/tool state, including global/project instructions. Do not rewrite or reorder it.
- Pinned: active material requirements, Skills, facts and their caveats, with explicit scope. Reading a Skill for current work must not be followed by silently discarding it; it is not active forever.
- Working: process material the Agent may retain, offload, recover or release.

Normal requests append. Earlier deletions, replacements or moves can invalidate the cached suffix; reserved-prefix stability alone does not guarantee a cache hit. Do not inject full GoalRun state or a volatile instruction block before every request.

Search is available on demand, not a mandatory step before each call. Select useful capture arguments up front; return bounded snippets and stable source IDs, often enough to avoid a second load. Additional parent context may be explicitly searched/loaded when needed. Context isolation manages attention, not filesystem security. Start with inexpensive text/metadata lookup and Agent semantic selection; do not add an embedding store without evidence.

Offload saves recoverable content before removing its active contribution. Pointers carry purpose, source/version and caveats. Missing, stale, wrong-branch or reserved targets fail visibly. Do not require separate lesson/ledger/memory records for every operation. Compaction remains a safety mechanism for finite windows.

### Native projection mechanism

Use Pi's documented actionable `turn_end` boundary to append native context edits, compaction checkpoints, hidden frame procedure messages and compact frame metadata. `compass_context` is a same-session tool: it queues an operation, but does not create an AgentSession, child process or scheduler. The boundary is the only commit point, including an aborted assistant turn; no private SessionManager mutation is needed.

`src/context-core.mjs` is a pure planner. It keeps source IDs, prior edit IDs, content versions, frame ownership, pins, reference writes and watch ownership only. Raw content remains in Pi's append-only transcript. `call` creates a new projection with explicit `ref`/`copy` capture; `return` restores the saved source versions, preserves user steering, and exports only requested sources. `replace` uses optimistic versions; Human messages cannot be replaced/dropped, complete tool exchanges are required for drops, and referenced outer slots cannot be dropped. Search is bounded and returns stable IDs/snippets/versions.

A frame-owned `watch` is recorded from pi-await's existing tool-result metadata and released from its native cancellation or wake messages; Compass does not create a second watch mechanism. Parent-owned watches do not block a child. A return fails closed while an owned watch remains active. This is ownership bookkeeping, not a replacement for pi-await's authoritative watch state.

Native compaction, ordinary requests and reload all consume the same canonical projection. The raw session remains unchanged; a context custom entry is only bounded metadata. Boundary drafts are applied only by Pi after validation. If a boundary operation is rejected, Compass appends a compact rejection message and does not advance context state. The implementation still needs nested/reload/provider acceptance coverage and must not be described as a zero-cost or zero-compaction guarantee.

### Repeated results

Exact text equality is not sufficient authorization to delete an arbitrary message. Preserve source identity, read ranges, observation context, pins and complete exchanges. A new subset does not replace an old superset. Never deduplicate reserved material or turn similar text into an automatic replacement.

Evaluate replacing an older read-only result body with a source pointer while preserving its protocol envelope, rather than moving isolated tool messages. Detection and application are separate; the Agent controls optimization policy. Count edit/cache costs and avoid repetitive similarity notices.

## External input and native extensions

- pi-subagents owns isolated execution, native activation/loading, status, completion and exact-identity cancellation. Retain explicit executor intent and fail closed on unknown runs; do not launch duplicates.
- pi-await owns observation, watch lifecycle, cancellation and wake delivery. Do not wrap its timers or use watches to duplicate native child-completion notifications.
- A frame cannot return while it owns active watches. Parent-owned watches do not block a child. Repeating watches require explicit cancellation or transfer to the parent. Keep only ownership references; native watch state remains authoritative.
- New Human input and structured answers can arrive while a frame runs. Pi supports steering; ask_user_question can also execute inside a frame. Such requirements and their handling must not disappear on pop. Preserve external event references without returning the entire child process.
- Child tools/extensions are not automatically inherited in every pi-subagents execution mode. Recursive Compass use requires an explicit native launch contract, not an assumed ambient extension.
- Prefer Pi's existing parallel tools, Code Mode batching, native background children and pi-await Started/wake behavior. Optional asynchronous execution does not justify a new coroutine scheduler.

## Implementation TODO

- [x] Establish native extension contracts and record Human decisions.
- [x] Remove per-request full anchors and redundant native activation policy; cover prefix preservation and loader/executor diagnostics.
- [x] Independently review the foundation and fix its material findings.
- [x] Probe native parent restoration across child compaction without another AgentSession.
- [ ] Define the remaining unified task/context contracts and replace obsolete mechanisms rather than retain compatibility layers.
- [x] Implement the native in-place frame core: explicit capture/return, versioned ref/copy, branch-local native edits, complete-exchange protection and aborted-turn ref persistence.
- [ ] Add nested-frame, branch navigation, reload and native compaction recovery coverage; validate active Skills, material Human requirements and caveats under frame projection.
- [x] Integrate bounded pi-await watch ownership and external input preservation without duplicate observers/wakes; verify lost-watch/reload behavior against the native package contract.
- [ ] Bind DAG/acceptance approval to exact revisions; integrate explicit native delegation and acceptance-gated route stopping.
- [ ] Evaluate optional repeated-result clearing and asynchronous execution against total completion cost.
- [ ] Consolidate the Agent-facing Skill and current documentation; remove dead code, redundant state/tests and obsolete active contracts.
- [ ] Run targeted/full/core checks and preflight; independent review; commit and push coherent milestones.
- [ ] Human performs actual Pi/provider acceptance and supplies feedback separately.

## Foundation evidence

Current source requires Pi >=1.5.2. The foundation is not a v0.10.0 release; package/release-manifest promotion follows completed implementation.

- `npm test`: 199/199 pass after the frame-core implementation; `npm run test:core`: 89/89 pass before the frame-only additions.
- Static and non-static preflight pass; checking this repository itself produces the expected target/package-overlap warning.
- `git diff --check` passes.
- Independent foundation review found two P2 issues (loader/executor diagnostics and stale gate text), both fixed.
- Prefix tests use the real installed Pi runner/Responses serializer with constructed messages and fake extension activation/persistence. They do not prove provider cache hits or live extension acceptance.
- Native SessionManager projection, frame-core tests and an extension boundary integration test pass; no live provider run, same-session frame cost comparison, nested/reload proof or zero-compaction guarantee is claimed.

## Sources

- [DeepSeekHarness Super-agent article](https://x.com/DeepSeekHarness/article/2116857257245987236): isolated workers, Inline/Spill, optional asynchronous Started/result delivery. The historical inspected commit is unknown.
- [Anthropic context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents): notes, compaction and subagents are complementary.
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): exact rendered prefixes and eligibility matter.
- [Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing): selective result clearing, not unrestricted message relocation.
- Installed Pi `docs/extensions.md`, `docs/session-format.md`, `docs/compaction.md`, public session-manager declarations and `buildSessionProjection()` implementation.
- Installed pi-subagents `docs/extension-api.md` and delegation declarations; sibling pi-await README, handoff and watch tool implementation.
