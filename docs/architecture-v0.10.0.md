# Compass v0.10.0 — requirements, milestones and delivery gates

Status: development in progress. The frame prototype at `c355469` is not ready for Human acceptance. Its passing tests did not cover the defects found in the requirement audit. This document is the single implementation checklist; unchecked items are not implemented or proven.

## Source of requirements

Original Pi session `01a1b90f-8faa-752a-bb77-8132146df4d9`:

- `d3f836a4`, `3e29e232`: ownership boundaries; RouteSet/DAG separation; Agent-owned attention; append-only context edits; compact continuity and caveats.
- `32aac06e`: combine pi-subagents/pi-await; enumerate TODOs; implement, review, commit and push.
- `3e76102b`, `5890f58d`: route choice/acceptance; nested problem solving; active Skills; reserved/pinned/working slots; explicit capture/export; spill/recovery and shared values.
- Questionnaire `fffd355d`: frames affect context only; explicit input/output default none; shared slots are same-session; competing routes may stop only after explicit acceptance.
- Questionnaire `f0645421`: function-like tasks; ref/copy; optional coroutine/async evaluation; exact/subset repeated-result relocation; similarity advisory; semantic source/range search; Human-approved DAG and acceptance; semantic step checks or optional independent reviewer; one Compass Skill; filesystem effects remain the Agent's responsibility.
- Questionnaire `cb8490fc`: no additional Pi session for a frame; only work adopting a DAG requires approval.
- Questionnaire `f9ad3946`: ref writes survive failure/interruption; uncaptured parent context may be searched; Agent returns explicitly; active owned watches prevent return.
- `2ca81fba`, `569c8b29`: optimal coherent design, not minimal patches; no legacy/compatibility unless requested; root-cause fixes; evidence; research concrete uncertainties.
- `8aa06cf7`, subsequent instructions: finish the development work locally, then Human tests in a separate Compass session; explain delivery in plain language.

Earlier speculative assistant suggestions are not additional Human requirements. In particular, an embedding database, character-offset editing, a second scheduler, forced optimization modes, and an always-running watchdog are not assumed requirements.

## Non-negotiable boundaries

1. Human is Router; different Human-managed sessions are Workers. No extra Router, cross-session scheduler or Agent Loop.
2. Pi owns raw append-only history, system/tool prompt state, branches and compaction. Never write session files or mutate the read-only session manager.
3. Frames use the same running session and loop. Context rollback is not filesystem/environment rollback.
4. Runtime handles deterministic state, references, versions, pairing, approval identity, dependency readiness and measurement. Agent handles semantic attention, route selection, caveats and judgment.
5. pi-subagents owns child execution/status/cancellation; pi-await owns observation/watch lifecycle/wakes. Do not duplicate their execution loops or timers.
6. Reserved instructions include Pi prompt/tool state and global/project AGENTS.md. Ordinary work appends. Context optimization may invalidate a cached suffix; never promise provider cache hits from prefix tests.
7. Original Goal, Current Goal, Human constraints/decisions, plan and acceptance remain one GoalRun authority. Raw messages are referenced, not copied into another transcript store.
8. No old/new implementation tracks or schema migration adapters in the delivered development contract. Preserving Pi's original transcript and Git history is explicitly required, not a reason to retain obsolete executable code.
9. Simple work does not require a DAG, frame, subagent or verification ceremony. No unconditional setup call or search per task.
10. A Human approval authorizes a plan; it does not prove execution success. Self-reported certainty is not independent proof. Implement the requested explicit semantic checks rather than silently dropping them or pretending code can prove semantics.

## Completion rules

A TODO is complete only when its behavior exists, affected consumers agree, relevant failure paths are checked, and local evidence is recorded here. An API name, design paragraph, mock event-bus test, or unrelated passing suite is insufficient.

Each milestone gets a scoped diff review and commit. Independent review is used where it adds value, and findings are resolved before handoff. Human performs real interactive/provider acceptance after development; missing implementation and locally reproducible bugs are not delegated to Human as "acceptance".

Evaluations end with evidence and a decision: implement, reuse a native capability, or explicitly defer with a reason. An evaluation must not be silently removed from scope, and a proposed option must not silently become a mandatory runtime subsystem.

## M0 — requirement coverage and honest baseline

- [x] Recover original Human inputs and structured questionnaire answers; distinguish requirements, proposals and superseded instructions.
- [x] Enumerate all known gaps and reproduce the frame defects locally, without provider requests.
- [x] Replace premature completion checkboxes with this single milestone/TODO contract.
- [ ] Keep each requirement assigned to a milestone through final reconciliation; no unassigned "later" list.

Audit baseline: native in-memory probes at `c355469` reproduced parent-summary loss, child-process resurrection after compaction, invisible-parent search failure, pin loss after native compaction, failing drop, orphan tool results after ref capture, and premature repeating-watch ownership release. Existing `npm test` still passed 200/200. This proves inadequate coverage, not correctness.

## M1 — correct canonical context and frame transitions

Goal: make the native projection reliable before adding more operations.

- [x] Centralize branch/source/edit indexing; use one index per operation, not rebuild it for every source.
- [x] Preserve the parent checkpoint/summary and omitted-source state by stable references.
- [x] On return, release all frame-owned process entries, including entries hidden by an intervening native compaction; do not resurrect them.
- [x] Restore explicit ref value versions after compaction; keep copy changes local; retain ref writes on failure/interruption.
- [x] Preserve complete tool exchanges for existing capture, pin, edits, drop and return operations. Reject tool-call rewrites that would fabricate an execution. M3 loading must reuse this boundary.
- [x] Fix drop and stale/wrong-branch/reserved failures without mutation or misleading errors.
- [x] Reconcile state from committed branch-local records; a returned boundary proposal is not a committed transition. Detect partial persistence rather than guessing or silently resetting an active frame.
- [x] Cover nested entry/return, native compaction, pre-existing parent summaries, branch navigation/reload, abort and boundary composition with the installed Pi projection/boundary contracts.
- [x] Resolve independent M1 review findings; scoped confirmation found no further issues.

Exit: regressions reproduce the audit defects before fixing them; targeted checks pass after the fix. No new AgentSession/loop and no raw transcript mutation. Remaining live-provider limitations stay explicit.

Local M1 evidence (scoped independent review confirmed): six targeted regressions failed on the prior implementation, including dropped parent summaries, resurrected child process, incomplete exchanges, failed drop, tool-call rewrite and silently ignored mixed batches. Independent review found two further P1 defects: stale steering/watch state could erase a newly committed frame, and the commit digest excluded resulting control state. Both were reproduced as failing installed-runner tests and fixed; native wakes now reconcile committed state, Human text cannot spoof a native wake, and the digest binds the resulting state. Frame identity uses persisted entry IDs, not assumed session-global provider call IDs. Current context core/installed-runner checks 23/23, full tests 216/216, core 89/89, preflight and syntax/diff checks pass. LSP probing is not a clean/typecheck claim: one check was inconclusive and a pre-existing `Record<string, any>` rule finding remains in an untouched index section. Runner tests use the installed Pi implementation with registry/lifecycle adapters, not a live AgentSession or provider. At M1, context control schema was v2; the first M2 value slice used v3. Current-only v4 adds handling and Goal-scoped retention metadata. Earlier development states are rejected rather than migrated or silently reset.

## M2 — slots, retention and complete message operations

- [ ] Provide an explicit source/value ownership model: Reserved, scoped Pinned and Working, without a second transcript or conventions registry.
- [ ] Stable source IDs and versioned references; same-session shared bindings; explicit ref/copy capture and return with empty defaults.
- [ ] Copy-on-write rather than eager history duplication where the native protocol permits it; evaluate move semantics without breaking tool envelopes or evidence identity.
- [ ] Implement replace/drop and selected-range movement/reordering at protocol-safe boundaries; exact source/range selection, not guessed message indices.
- [ ] Preserve active Skill content after it is read, with explicit scope and retirement; preserve material temporary Human requirements and handling state.
- [ ] Make pins survive native compaction and frame changes. Do not ban compaction to conceal an inconsistent projection.
- [ ] Carry sources, versions and caveats through summaries, exports and derived replacements. Agent-authored edits must not masquerade as original tool observations.
- [ ] Preserve Human steering, structured answers and material external results across pop without copying the whole subproblem transcript.
- [ ] Keep schemas stable and mutation receipts actionable: actual resulting revision, applied/rejected/unknown status, no full-state echo or mandatory follow-up poll.

Exit: protocol integrity, scoped retention and source identity are checked on representative text/image/tool messages, not just isolated user strings. Semantic adequacy remains the Agent's judgment and Human acceptance.

### Recorded Pi compaction gap and request-side retention proposal

**Observed host:** the installed `@earendil-works/pi-coding-agent` is **1.5.2** (`package.json`, rechecked locally). This is a version-specific source/API finding, independently source-reviewed, not a live-provider test. No Pi source or installed-runtime modification is authorized by this discussion.

Two guarantees must be distinguished:

- **Canonical restoration:** pins are restored into Pi's durable projection immediately after compaction, before any next request. Stock 1.5.2 exposes no general actionable boundary at that point. `turn_end` can precede threshold compaction; `agent_before_settle` can follow an overflow continuation. `session_compact` is a notification, and non-triggering `sendMessage` calls can queue until a later turn boundary. A string summary cannot retain native image blocks; retaining an old suffix is not selective retention.
- **Request-side restoration:** existing `context` / `context_with_system` hooks can supplement the outgoing request without changing the durable projection. Request transforms run after request preparation, including request-time virtual-model compaction. This route does **not** require the missing canonical boundary, but it must not be advertised as canonical restoration.

**Desired native capability, if pursued later:** an awaited post-compaction boundary using Pi's existing validated draft machinery. It must support text/image `custom_message` drafts after successful manual, threshold (including virtual-model request preparation) and overflow compaction; commit and rebuild the canonical projection before any request; preserve Pi-owned system/tool/AGENTS state; add no otherwise-unneeded continuation; and surface failed restoration before sending a request without the required pins. No released minimum version containing this capability has been established; do not invent a version requirement.

**Human's proposed near-term direction:** after compaction, inject pinned content through system context on stock Pi. Record and evaluate this rather than treating a Pi fork as the only possible route.

**Implemented retention path (local, not full M2):** pins have qualified native views with immutable source/body references. `context_with_system` supplements only missing complete outgoing envelopes; native-projection membership and key/version tags alone are not presence proof. Altered tagged snapshots fail visibly, and payload blocks are cloned at the extension boundary so later handlers cannot mutate original image data. At the next existing `turn_end`, Pi's chained preview supplies the preceding proposed frame/watch state; omitted snapshots are materialized through validated drafts plus integrity receipts, without requesting another turn. Scope deduplication, compacted-pin retirement, root pins through compacted frame entry/return, and original tool pairing are checked locally. Immediate post-compaction canonical restoration remains unavailable on stock Pi; the request overlay covers that gap until an existing boundary. The current local slice adds explicit Skill activation (`pin kind=skill` after a successful source read), `mark active|handled|retired` with rationale, and Goal-default/session-explicit retention lifetimes. Genuine structured questionnaire answers retain full notes and partial/declined distinctions as source-qualified data across frame return; rich previews remain only in raw history. Whole-value moves and exact-range data copies preserve tool envelopes. These paths are implemented, not independent approval of all M2 requirements; selected-range cut/reordering, material-external lifecycle integration and final receipt/review reconciliation remain pending.

Local retention evidence: the earlier outgoing-filter and marker-only bugs were reproduced as failing installed-runner tests before repair. Full tests 230/230, core 89/89 and static preflight passed; a subsequently added compacted-frame/scope case also passed independently. These checks use installed Pi projection/runner code with registry/lifecycle adapters, not a live provider. LSP reported an inconclusive path and the existing untouched `Record<string, any>` rule finding; this is not a clean typecheck claim.

**Accepted direction; remaining integration and measurement work:**

1. Treat pins as scoped retained context, not automatically as system-authority instructions. Preserve original authorship, stable source/version, caveats, handling state and retirement. Raw tool/file content must not acquire system authority merely because it is pinned.
2. Keep Pi's original system/tool/AGENTS messages untouched. If an explanatory system rule is needed, keep it small and stable; carry actual retained text/images as clearly identified context data using provider-supported message content.
3. At request assembly, restore only required missing pin versions from committed state and immutable native source references. Do not rely solely on an in-memory "compaction happened" flag; cover reload, branch/frame changes and retries. Do not match cloned source messages by guessed position/text. Exact outgoing presence/deduplication and extension composition still need proof; a native-projection match alone does not prove another hook kept the content in the outgoing request.
4. A later existing actionable boundary may materialize missing snapshots into native context, without forcing a provider turn. Until then this is explicitly a request overlay, derived from the same source/value authority, not another transcript or pin store.
5. Account for overlay size: canonical token displays/compaction estimates may omit request-only content. Check actual serialized request size, text/image preservation, scope/retirement, protocol closure, prefix stability and provider limits. No cache-hit or instruction-compliance guarantee follows merely from injecting content.

Evidence in the installed Pi 1.5.2 package: `docs/extensions.md` sections `context` / `context_with_system`; `dist/core/agent-session.js` methods `_installAgentRequestProjection`, `_installAgentNextTurnRefresh`, `compact`, `_runAutoCompaction`, `sendCustomMessage`; `dist/core/extensions/types.d.ts` (`SessionCompactEvent` and its handler); `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` functions `runLoop` and `streamAssistantResponse`. These distinguish pre-request transforms from durable boundary commits. This note completes no M2 checkbox.

## M3 — retrieval, spill and repeated-result optimization

- [ ] Search both the active view and recoverable parent/branch-local history on demand; return bounded snippets, stable IDs, versions, provenance and useful ranges.
- [ ] Provide explicit load/recovery of uncaptured or spilled material; snippets may suffice without a forced second call.
- [ ] Provide semantic retrieval/ranking when chosen; compare native capabilities and bounded semantic calls before introducing dependencies or an embedding store. Lexical matching must not be labeled semantic search.
- [ ] Spill selected content to an allowed project artifact before replacing it with a recoverable pointer; preserve purpose, source/version, caveats and integrity checks.
- [ ] Verify artifact write before context removal; missing/stale/wrong-scope artifacts fail visibly. No hidden environment rollback.
- [ ] Detect exact repeated read-only results and verified subset relations using source identity/read ranges, not bare text equality alone.
- [ ] Relocate the prior covered information to the append end without losing a larger old superset; preserve protocol envelopes and tell the Agent what changed.
- [ ] Never automatically transform a non-exact/similarity-only match or Reserved material. Offer bounded, non-repetitive advisory hints when justified.
- [ ] Measure scan/index, storage and cache-edit overhead; allow Agent policy to avoid optimizations whose total cost exceeds their benefit.

Implemented local slice: `search` distinguishes active, saved-parent and branch history; `load` makes version/range-checked private data copies, and `move` relocates whole working payloads while preserving executed calls/results. `spill` writes and reads back an explicit project-relative artifact before a native pointer replacement; `load` re-verifies its immutable full-envelope digest/root/identity and returns a new data reference. Existing raw history is never silently substituted for a failed artifact read. Artifact creation is a filesystem effect: rejected native commits may leave an explicitly reported orphan. Current context checks are 50/50, using installed projection/runner adapters, not a real provider. Historical mutable-version coverage, semantic retrieval evaluation, repeated/subset automation, measurement and independent review remain open.

Exit: repeated/subset/changed-file cases preserve information; spill round trips work; retrieval does not require searching on every frame call.

## M4 — native extension composition and unified work calls

- [x] Reuse task identity and explicit parent/code/subagent intent; attach optional frame scope rather than create a parallel task registry. DAG tasks and native execution receipts now retain an optional `frameScope`; native child identity remains `(ownerRunId, nodeId, requestId)`.
- [x] Integrate serial same-session calls and independently justified native child work; no silent executor conversion.
- [ ] Establish explicit supported launch/configuration for a child to use Compass recursively; do not assume extension inheritance.
- [x] Correlate and consume native child results; unknown runs remain unknown, never duplicate-dispatched. Preserve native activation/user preferences.
- [x] Track watches by native arm identity and frame owner; native live status is authoritative, including nested Code Mode calls.
- [x] Handle native custom wake/lost messages and repeating rounds correctly. A repeating wake is not terminal completion.
- [x] Block return only for live watches owned by that frame; native `unwatch` identity and explicit `compass_context(action=transfer)` ownership transfer are supported; parent watches do not block a child.
- [x] Reconcile reload/branch changes and finished watches without another observer, timer loop or mandatory polling.
- [x] Reuse native structured delegation and pi-await asynchronous execution with started/result and wake semantics under Agent control; Compass does not force every tool asynchronous.
- [x] Evaluate coroutine-like interleaving versus native parallel Code Mode/subagents/await: native composition remains the optimal local boundary, so no second scheduler or coroutine loop was added.

**M4 local result (current installed contracts):** Compass does not claim recursive child extension inheritance. The installed pi-subagents contract starts children with the resolved agent tool/extension projection; its default child boundary omits `subagent`, and the Compass structured request only grants the read-only role allowlist. A child cannot use Compass recursively through this path; recursive use remains fail-closed/deferred until a documented launch configuration is supplied. The installed pi-await contract owns arm identity/lifecycle, exact cancellation, repeating rounds, native wakes/lost notices, and active-branch reconciliation; Compass consumes those records and never polls or runs a second observer. Local regressions use the installed Pi projection/runner adapters, not a live AgentSession/provider; Human must perform actual child/provider acceptance.

Exit: native APIs are the execution authorities. No assumed notification delivery or compatibility inferred from a fake bus. Human performs actual child/provider interaction acceptance.

## M5 — Human-approved DAG and evidence-bearing progression

- [ ] A DAG remains optional. Creating/adopting one produces a draft, not automatic execution.
- [ ] Present the concrete tasks, dependencies, executors and acceptance criteria through structured ask_user_question before execution.
- [ ] Bind approval to the exact Goal/plan/acceptance definition and questionnaire identity. Declined, partial, custom-modified and UI-error results remain distinct.
- [ ] Material changes invalidate approval; ordinary status updates do not. Reject stale approval without mutation.
- [ ] Block both automatic delegation and parent/code DAG task progression before approval. No recovery sweep bypasses the gate.
- [ ] Support Human additions/revisions and re-approval; arbitrary text or Agent-reported "Human approved" is not a stamp.
- [ ] Require an explicit semantic step check against approved criteria, evidence and unresolved caveats before dependency progression; preserve failed/inconclusive results.
- [ ] Evaluate optional independent reviewer/watchdog through pi-subagents where justified; no always-on extra model loop and no numeric-confidence fiction.
- [ ] Keep task completion, Agent assessment, independent review and final Goal acceptance distinct. Unknown evidence never becomes pass.
- [ ] Represent material Human optimization declarations in the same approved constraints/decisions, without another policy registry.

Exit: unapproved and stale plans cannot execute; clear approval can proceed; semantic checks are explicit and traceable, not claimed to be mathematically proven by runtime.

## M6 — route choice, exploration and acceptance-gated stopping

- [ ] Distinguish alternative routes from a chosen route's DAG; no automatic route fan-out from merely mentioning alternatives.
- [ ] Use structured questions to align default/recommended versus Human-selected routes when the decision matters.
- [ ] Represent explicit authorization for parallel exploration, its scope/budget and result correlation; do not infer authorization from task size.
- [ ] Compare results against shared acceptance criteria and caveats, not first-finished-wins.
- [ ] Allow exact-identity cancellation of competitors only after the explicit acceptance gate passes.
- [ ] Track cancellation request/acknowledgement/terminal status separately; unknown termination remains unknown.
- [ ] Leave filesystem/worktree/environment coordination to the Agent and native execution capabilities; remove redundant Compass global write-lock policy.
- [ ] Instruct the Agent to stop and revisit root cause when new evidence invalidates the route; provide nested context operations without pretending code can recognize every semantic failure.

Exit: unauthorized exploration and premature cancellation are rejected; accepted-route evidence is retained; no new Router or scheduler.

## M7 — simplify, measure, document and deliver

- [ ] Deliver one progressively loaded Compass Skill covering attention, work calls, native children/waits, root-cause investigation, approval and acceptance. Do not require multiple overlapping orchestration guides per task.
- [ ] Remove obsolete compatibility/migration/fallback implementations, duplicate state and dead API/schema/control paths; retain relevant behavioral coverage, not historical-format tests for their own sake.
- [ ] Align current design, tool contract, README, package identity, preflight and installed native extension versions. Historical evidence is not current compatibility proof.
- [ ] Replace false completion/documentation claims with actual local evidence and known limitations.
- [ ] Review touched scope for cohesion, coupling, repeated indexing/copying, schema overhead, extra calls and lifecycle cleanup. Refactor rather than apply shotgun patches.
- [ ] Measure representative local transition/search memory and CPU costs plus request/context sizes. Collect native usage evidence where available; do not invent provider/cache/cost measurements.
- [ ] Run targeted checks, full/core tests, static and installed-Pi preflight; independent review of high-risk boundaries; resolve findings.
- [ ] Reconcile every requirement against this list; report implemented, evaluated/reused, explicitly deferred and Human-only acceptance separately.
- [ ] Commit and push coherent milestones; verify actual Git state. Explain in plain language what changed and give a short real-session test guide.
- [ ] Human performs actual Compass/provider acceptance and provides a feedback path. This is the only remaining verification ownership transferred to Human, not development TODOs.

## Native reference baseline

Last inspected local baseline: Pi 1.5.2; pi-subagents 0.88.0; sibling pi-await 1.3.0 candidate revision 4 (`8a51e51`). Recheck versions/contracts when integrating, without modifying pi-await or global Pi settings.

- Pi public extension boundary/session-format/compaction contracts and installed SessionManager projection implementation.
- Installed pi-subagents `docs/extension-api.md` and delegation declarations; native child lifecycle/status/cancellation contracts.
- Sibling pi-await README/handoff and watch result/custom-message contracts.
- DeepSeekHarness article and source were research inputs, not a replacement architecture or proof of local behavior. The historical inspected commit remains unknown.
