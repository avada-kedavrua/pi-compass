# Compass v0.10.0 — requirements, milestones and delivery gates

Status: v0.10 local candidate. M0–M7 local delivery gates are complete, with explicit native reuse/unsupported decisions below. Implementation snapshot and final local checks are recorded in [Final local evidence](#final-local-evidence). Human live Pi/provider acceptance remains open; local tests and scoped source reviews are not that acceptance.

## Active delivery — R0–R4 consumer convergence

Human's current instruction supersedes the old public tool layout, not native safety/ownership requirements. Current implementation remains the preceding snapshot until each milestone below lands. No legacy tool aliases, capability registry, migrations or second workflow loop will be retained. Raw Pi records and Git history remain immutable.

Current surface: seven initially registered, stable tools. goal alone owns semantic Goal/constraint/criterion definitions and Goal-level decisions/checkpoints; state owns all reads; context_search retrieves evidence; context writes memory/attention/work values; plan owns DAG definition/task/approval/reconciliation; acceptance records criterion evidence only; runtime_guard owns executable mechanical checks. Internal revisions/bindings never become required Agent bookkeeping. Compact JSON serves composition; requested evidence/caveats remain complete. No schema/status churn or Compass loader.

- **R0 — Contract and failure ledger**
  - [x] Verify the original eight responsibilities and schema/result journeys against the implementation and documented host boundaries; record F1–F12 and proving checks in the existing consumer audit.
  - [x] Resolve approval composition without another UI/control plane or model copying long payloads. Independent design re-review cleared the interactive-only/full-preview qualification; no code execution claimed. R0 is the design/ledger delivery commit; implementation gates remain open below.
- **R1 — Context root fixes**
  - [x] Distinguish no summary from changed summary; no false return checkpoint. Preserve real inner-compaction restoration and complete exchanges.
  - [x] Explicitly exporting a retained value preserves its declared retention lifetime in the parent. Unexported local work stays local; derived authorship and bounded provenance remain recoverable.
  - [x] Allow one ordinary memory mutation alongside sibling tools; keep projection-changing operations standalone. Reject ambiguous multiple mutations without partial changes.
  - [x] Eliminate demonstrably redundant restoration edits, not required raw-owned omissions. Native replay: no false checkpoint, 342 edits / 516,412 bytes. Four before-fix behavioral failures; 283/283 full in 4.259 s, core/non-extension/static/native gates PASS. Independent bounded source re-review OK; R1 commit records this delivery.
- **R2 — Atomic domain and eight-tool implementation**
  - [x] Goal alone defines criteria (GoalRun API/schema 9): plan/route/acceptance keep no editable criterion list; `goal.criteria` is the single definition and `plan.definitionKey` binds plan, assessment and approval to the Goal digest. Duplicate plan writers, triage, capability/loadout state and their tests were removed in one current-only change; old snapshots fail visibly.
  - [x] Code transports the complete exact proposal to the native questionnaire; the Agent transports only an opaque `P.<id>` ref. Expansion requires interactive Pi with a full-preview custom TUI; RPC/print/unknown/no-UI are blocked with no approval and no state change. Authorization additionally requires the exact canonical preview echo, native message identity and the current binding; declined/partial/note/custom/UI-error/truncated-echo answers stay distinct.
  - [x] Explicit `parent|code|subagent` intent, read-only Subagent enforcement plus `dispatchReason`, current-binding semantic assessments, unknown-batch reconciliation (`confirmedNoActiveRuns` + `confirmationEvidence`), route/competitor identity and acceptance gates are retained with regression coverage.
  - [x] Old registrations were replaced, not wrapped: fixed non-overlapping action schemas in `src/tool-schema.mjs`, one read surface (`compass_state` views), minimal receipts, native tool preferences untouched. R2 evidence: domain `goal-run`+`dag-core` 69/69; full suite 230/230 in 3.58 s; core 77/77; non-extension 106/106; static/native preflight and subagents contract 36/36 PASS; eight-tool schema total 37,189 bytes with the largest Code Mode signature at 3,972 chars. The R2 delivery commit records this state.
- **R3 — Native consumption and further convergence**
  - [x] Exercise installed native loading and dispatch: fixed registry, two-tab canonical preview expansion/qualification and actual Code Mode tool routing. See [Final local evidence](#final-local-evidence).
  - [x] Replay the MindStudio stale-start and partial Code Mode batch through the installed `AgentSession` with a scripted stream, without touching MindStudio. Goal drafts no longer take source refs; node entry is automatic and the context tool stays model-only. This is a replay of the failure sequence, not the full workload.
- **R4 — Occam and final delivery**
  - [x] Reconcile the four current milestones below; review the touched stop, fallback, native tool and frame boundaries. Keep scoped behavioral coverage.
  - [x] Run focused, full, core, non-extension, and isolated preflight checks. Measure schema/result bytes, the scripted failure replay call count, and local context draft size and CPU against `262d566`; see [measurements](measurements-v0.10.0.md#local-stop-and-field-recovery-checks).
  - [x] Align the tool contract and release identity; review the scoped diff alongside native consumer evidence. Record local and live boundaries separately. No separate model reviewer or real provider was used for this follow-up.

### Next acceptance work

#### 1. DAG execution and recovery

- [x] Close a native batch when its last correlated terminal result arrives late. The installed-host adapter regression failed before the fix and now verifies that a partial result leaves the batch unresolved, the last result settles it once, and no unknown attempt is retried.
- [x] Consume correlated terminal results per node. An adapter regression keeps a sibling running while the first terminal result becomes visible.
- [x] Dispatch an assessed successor without waiting for unrelated siblings. The regression held a sibling open and timed out before the fix. Separate active batch records preserve exact request correlation and a shared admission cap.
- [x] Accept semantic `throw` with reason, evidence and known side effects. Freeze progression and fallback; continue consuming running siblings. Adapter tests verify exact cancellation and that a cancel request is not terminal evidence. No filesystem rollback.
- [x] After committing the first correlated child `throw`, request one native Pi wake. An offline `AgentSession` test verifies idle wake and duplicate suppression; an adapter verifies sibling fallback preflight cannot block the stop.
- [x] Verify malformed graphs and edgeless advice, exact recovery of a launch-refused node and individual rerun of a confirmed terminal node, and stale-input recovery without asking for a second unchanged stamp. Shared-CWD conflict detection is not implemented: automatic children remain read-only and Compass does not coordinate writers.

#### 2. Node frames and artifact handoff

- [x] Bind approved parent nodes to native same-session frame commits. A single return submits the outcome and explicit exports; a queued return cannot settle the node. Code Mode remains a separate deterministic route.
- Deferred: writable children are out of scope under the repository's read-only Subagent constraint. No write locks, automatic merge, or rollback were added.
- [x] Same-session node handoff uses exact exports and caveats. The native Runner exercises automatic A → B → C with no main turn and B → throw → main with C pending. A fixture also verifies that a replan can reuse A’s exact export. Native child artifact inputs are not exposed.

#### 3. Context and incremental editing

- [x] Inherit pins downward, protect reserved instructions, and isolate frame writes. Child unpin masks inherited retention; complete verified canonical Skill reads auto-pin locally.
- [x] List retained memory directly and update/delete local Agent-authored memory without unpinning first. Raw provenance and exact original source recovery stay intact.
- [x] Apply exact native read dedup at append with a qualified pointer and intact raw call/result pairing. Keep queued receipts distinct from the single applied return receipt. Skip already-null context edits on return; the MindStudio workload was not replayed with the new implementation.
- [x] Incremental Goal edits and DAG patches preserve unaffected progress. New criterion IDs retire stale evidence and invalidate only the Goal stamp; task definition or ordering changes invalidate the DAG stamp.

#### 4. Agent review and delivery

- [x] Exercise the signed execution paths through the native Runner and scoped adapters: dual approval, serial handoff, readonly dispatch, stop, exact recovery and replanning. No manual opens or intermediary assessment calls for serial frames. Model/provider behavior and live cost are separate and unmeasured for this revision.
- [x] Run focused and full gates and separate installed-native evidence from adapter coverage. Agent smoke and recovery evidence are listed below; this is not a request for Human live acceptance.
- Review and publish the scoped Git revision to `chatgpt-only`; verify the remote ref against the final local commit.

### Candidate review evidence

- Planner/worker/integrator journeys: `tests/extension.test.mjs` covers correlated approval, per-node dispatch, partial failure, late evidence, cancellation and incremental edits. `tests/context-integration.test.mjs` covers real installed Pi Runner/SessionManager projection, frame-node commit, artifact handoff/replanning, Skill activation, memory and dedup. Native approval replies and native child events in these tests use adapters, not a provider.
- Disposable Pi 1.5.2 Agent run (`jrt/deepseek-v4.1-flash`) exercised source-bound Goal, real `read` dedup, frame memory, scoped export and `reported_pass`. The first pass stopped inside a frame. Recovery reached root and reported 1/1 criterion with explicit static-file limitations; it initially confused ordinary return with node outcomes and invented IDs for additions. Review added a frame-return cue, one applied return receipt, explicit return mode and actionable ID diagnostics. Raw transcripts remain local. This does not qualify interactive approval, live child execution, Human acceptance, or end-to-end cost/cache benefits.
- Final local gates: full 224/224, core 63/63, non-extension 92/92; isolated static preflight and real Pi loader/runner/Worker checks passed. Package dry run excluded `.pi/` and session JSONL.
- White-box follow-up: full 228/228, core 64/64, non-extension 93/93, and isolated static preflight passed. Through the actual Pi loader in a disposable profile, public launch-contract resolution for pi-subagents 0.88.1 and 0.89.1 rejected stock `scout` tools and accepted the repository’s read-only override. This check did not execute a child or call a provider. The structured request cannot bind a preflight digest atomically; profiles must remain stable through launch.
- Open for Human live acceptance: native interactive approval, real child execution and provider behavior. Shared-CWD writable scheduling remains out of scope. A targeted MindStudio failure replay ran offline, not the full workload.

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
7. Original Goal, Current Goal, interpreted Human constraints/decisions, plan and acceptance remain one GoalRun authority. The Agent explicitly submits semantic Goals through `compass_goal`; runtime records native Human IDs and validates versions, never classifies prose or builds Goal-change candidates. Raw messages are referenced, not copied into another transcript store.
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
- [x] Keep each requirement assigned to a milestone through final reconciliation; native capability decisions and Human-only evidence are recorded explicitly below.

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

Local M1 evidence (scoped independent review confirmed): six targeted regressions failed on the prior implementation, including dropped parent summaries, resurrected child process, incomplete exchanges, failed drop, tool-call rewrite and silently ignored mixed batches. Independent review found two further P1 defects: stale steering/watch state could erase a newly committed frame, and the commit digest excluded resulting control state. Both were reproduced as failing installed-runner tests and fixed; native wakes now reconcile committed state, Human text cannot spoof a native wake, and the digest binds the resulting state. Frame identity uses persisted entry IDs, not assumed session-global provider call IDs. At the M1 checkpoint, context core/installed-runner checks 23/23, full tests 216/216, core 89/89, preflight and syntax/diff checks passed. LSP probing is not a clean/typecheck claim: one check was inconclusive and a pre-existing `Record<string, any>` rule finding remains in an untouched index section. Runner tests use the installed Pi implementation with registry/lifecycle adapters, not a live AgentSession or provider. At M1, context control schema was v2; the first M2 value slice used v3. Current-only v4 adds handling and Goal-scoped retention metadata. Earlier development states are rejected rather than migrated or silently reset.

## M2 — slots, retention and complete message operations

- [x] Provide an explicit source/value ownership model: Reserved, scoped Pinned and Working, without a second transcript or conventions registry.
- [x] Stable source IDs and versioned references; same-session shared bindings; explicit ref/copy capture and return with empty defaults.
- [x] Copy-on-write rather than eager history duplication where the native protocol permits it; whole-value moves preserve tool envelopes and evidence identity.
- [x] Implement replace/drop and selected-range movement at protocol-safe boundaries. Move Agent-authored text ranges to the append end, retaining the remainder; read-result ranges become qualified data copies so the complete original execution and larger superset remain intact. Human originals, executed calls and active Skill sources cannot be cut.
- [x] Preserve active Skill content after it is read, with explicit scope and retirement; preserve material temporary Human requirements and handling state.
- [x] Make pins survive native compaction and frame changes. Do not ban compaction to conceal an inconsistent projection.
- [x] Carry sources, versions and caveats through summaries, exports and derived replacements. Agent-authored edits must not masquerade as original tool observations.
- [x] Preserve Human steering, structured answers and material external results across pop without copying the whole subproblem transcript.
- [x] Keep schemas stable and mutation receipts actionable: actual resulting revision, applied/rejected/unknown status, no full-state echo or mandatory follow-up poll.

Exit: protocol integrity, scoped retention and source identity are checked on representative text/image/tool messages, not just isolated user strings. Semantic adequacy remains the Agent's judgment and Human acceptance.

### Recorded Pi compaction gap and request-side retention proposal

**Observed host:** the installed `@earendil-works/pi-coding-agent` is **1.5.2** (`package.json`, rechecked locally). This is a version-specific source/API finding, independently source-reviewed, not a live-provider test. No Pi source or installed-runtime modification is authorized by this discussion.

Two guarantees must be distinguished:

- **Canonical restoration:** pins are restored into Pi's durable projection immediately after compaction, before any next request. Stock 1.5.2 exposes no general actionable boundary at that point. `turn_end` can precede threshold compaction; `agent_before_settle` can follow an overflow continuation. `session_compact` is a notification, and non-triggering `sendMessage` calls can queue until a later turn boundary. A string summary cannot retain native image blocks; retaining an old suffix is not selective retention.
- **Request-side restoration:** existing `context` / `context_with_system` hooks can supplement the outgoing request without changing the durable projection. Request transforms run after request preparation, including request-time virtual-model compaction. This route does **not** require the missing canonical boundary, but it must not be advertised as canonical restoration.

**Desired native capability, if pursued later:** an awaited post-compaction boundary using Pi's existing validated draft machinery. It must support text/image `custom_message` drafts after successful manual, threshold (including virtual-model request preparation) and overflow compaction; commit and rebuild the canonical projection before any request; preserve Pi-owned system/tool/AGENTS state; add no otherwise-unneeded continuation; and surface failed restoration before sending a request without the required pins. No released minimum version containing this capability has been established; do not invent a version requirement.

**Human's proposed near-term direction:** after compaction, inject pinned content through system context on stock Pi. Record and evaluate this rather than treating a Pi fork as the only possible route.

**Implemented retention path (local, not full M2):** pins have qualified native views with immutable source/body references. `context_with_system` supplements only missing complete outgoing envelopes; native-projection membership and key/version tags alone are not presence proof. Altered tagged snapshots fail visibly, and payload blocks are cloned at the extension boundary so later handlers cannot mutate original image data. At the next existing `turn_end`, Pi's chained preview supplies the preceding proposed frame/watch state; omitted snapshots are materialized through validated drafts plus integrity receipts, without requesting another turn. Scope deduplication, compacted-pin retirement, root pins through compacted frame entry/return, and original tool pairing are checked locally. Immediate post-compaction canonical restoration remains unavailable on stock Pi; the request overlay covers that gap until an existing boundary. The current local slice adds explicit Skill activation (`pin kind=skill` after a successful source read), `mark active|handled|retired` with rationale, and Goal-default/session-explicit retention lifetimes once a Goal exists; pre-Goal retention is session-scoped. Genuine structured questionnaire answers retain full notes and partial/declined distinctions as source-qualified data across frame return; rich previews remain only in raw history. Whole-value moves and exact-range data copies preserve tool envelopes. Selected-range movement and material native child/watch/Human result preservation now have regression coverage. Search and ranking expose edit lineage/authorship, immutable read completeness and caveats; loaded/copied/derived reads cannot bypass original complete Skill-read activation. Independent review found and drove these qualification repairs.

Local retention evidence: the earlier outgoing-filter and marker-only bugs were reproduced as failing installed-runner tests before repair. Full tests 230/230, core 89/89 and static preflight passed; a subsequently added compacted-frame/scope case also passed independently. These checks use installed Pi projection/runner code with registry/lifecycle adapters, not a live provider. LSP reported an inconclusive path and the existing untouched `Record<string, any>` rule finding; this is not a clean typecheck claim.

**Accepted direction; remaining integration and measurement work:**

1. Treat pins as scoped retained context, not automatically as system-authority instructions. Preserve original authorship, stable source/version, caveats, handling state and retirement. Raw tool/file content must not acquire system authority merely because it is pinned.
2. Keep Pi's original system/tool/AGENTS messages untouched. If an explanatory system rule is needed, keep it small and stable; carry actual retained text/images as clearly identified context data using provider-supported message content.
3. At request assembly, restore only required missing pin versions from committed state and immutable native source references. Do not rely solely on an in-memory "compaction happened" flag; cover reload, branch/frame changes and retries. Do not match cloned source messages by guessed position/text. Exact outgoing presence/deduplication and extension composition still need proof; a native-projection match alone does not prove another hook kept the content in the outgoing request.
4. A later existing actionable boundary may materialize missing snapshots into native context, without forcing a provider turn. Until then this is explicitly a request overlay, derived from the same source/value authority, not another transcript or pin store.
5. Account for overlay size: canonical token displays/compaction estimates may omit request-only content. Check actual serialized request size, text/image preservation, scope/retirement, protocol closure, prefix stability and provider limits. No cache-hit or instruction-compliance guarantee follows merely from injecting content.

Evidence in the installed Pi 1.5.2 package: `docs/extensions.md` sections `context` / `context_with_system`; `dist/core/agent-session.js` methods `_installAgentRequestProjection`, `_installAgentNextTurnRefresh`, `compact`, `_runAutoCompaction`, `sendCustomMessage`; `dist/core/extensions/types.d.ts` (`SessionCompactEvent` and its handler); `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` functions `runLoop` and `streamAssistantResponse`. These distinguish pre-request transforms from durable boundary commits. This note completes no M2 checkbox.

## M3 — retrieval, spill and repeated-result optimization

- [x] Search both the active view and recoverable parent/branch-local history on demand; return bounded snippets, stable IDs, versions, provenance and useful ranges.
- [x] Provide explicit load/recovery of uncaptured or spilled material; snippets may suffice without a forced second call.
- [x] Evaluate semantic retrieval: reuse the parent Agent's semantic selection over bounded recovered candidates; opaque exact-source refs validate identity/version while the parent chooses the semantic order; the unused public ranking handshake is removed. Native symbol navigation targets code, not omitted session evidence. No embedding store or mandatory extra model loop; semantic quality remains unmeasured, not mislabeled lexical scoring.
- [x] Spill selected content to an allowed project artifact before replacing it with a recoverable pointer; preserve purpose, source/version, caveats and integrity checks.
- [x] Verify artifact write before context removal; missing/stale/wrong-scope artifacts fail visibly. No hidden environment rollback.
- [x] Detect exact repeated successful native reads by persisted call path/range and complete payload versions; verified subsets additionally require a shared native file revision and matching covered lines. Missing revision is unknown, never inferred from text. Later changed, failed or truncated read evidence blocks verified relocation.
- [x] Explicit `move` with `verifiedAgainst` relocates the complete earlier read or verified superset to the append end; both covered execution pairs keep qualified pointers and one complete retained payload remains. Coalescing requires the entire companion read, never just a selected comparison range. Preserve unrefreshed outside-subset data and report what changed. Similarity never triggers relocation.
- [x] Never automatically transform a non-exact/similarity-only match or Reserved material. Offer bounded, non-repetitive advisory hints when justified.
- [x] Measure scan/index, storage and cache-edit overhead; allow Agent policy to avoid optimizations whose total cost exceeds its benefit.

Implemented local slice: `search` distinguishes active, saved-parent and branch history; `load` makes version/range-checked private data copies, and `move` relocates whole working payloads while preserving executed calls/results. `spill` writes and reads back an explicit project-relative artifact before a native pointer replacement; `load` re-verifies its immutable full-envelope digest/root/identity and returns a new data reference. Existing raw history is never silently substituted for a failed artifact read. Artifact creation is a filesystem effect: rejected native commits may leave an explicitly reported orphan. The initial context slice passed 50/50 checks using installed projection/runner adapters, not a real provider; final follow-up evidence is recorded below. The completed follow-up adds cross-call repeat/subset analysis, explicit verified relocation, source-qualified Agent ranking, range movement and qualification repair. Similarity stays advisory; there is no always-on optimizer or forced source search. Missing file revision cannot authorize subset relocation.

Exit: repeated/subset/changed-file cases preserve information; spill round trips work; retrieval does not require searching on every frame call.

## M4 — native extension composition and unified work calls

- [x] Reuse task identity and explicit parent/code/subagent intent; attach optional frame scope rather than create a parallel task registry. DAG tasks and native execution receipts now retain an optional `frameScope`; native child identity remains `(ownerRunId, nodeId, requestId)`.
- [x] Integrate serial same-session calls and independently justified native child work; no silent executor conversion.
- [x] Evaluate recursive child Compass against the installed launch contract: unsupported and fail-closed. The documented foreground delegation boundary does not inherit ambient Compass extensions and read-only requests do not grant Compass mutation tools. No fabricated launch configuration or implicit inheritance is shipped.
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

- [x] A DAG remains optional. Creating/adopting one produces a draft, not automatic execution.
- [x] Present the concrete tasks, dependencies, executors and acceptance criteria through structured ask_user_question before execution.
- [x] Bind approval to the exact Goal/plan/acceptance definition and questionnaire identity. Declined, partial, custom-modified and UI-error results remain distinct.
- [x] Material changes invalidate approval; ordinary status updates do not. Reject stale approval without mutation.
- [x] Block both automatic delegation and parent/code DAG task progression before approval. No recovery sweep bypasses the gate.
- [x] Support Human additions/revisions and re-approval; arbitrary text or Agent-reported "Human approved" is not a stamp.
- [x] Require an explicit semantic step check against approved criteria, evidence and unresolved caveats before dependency progression; preserve failed/inconclusive results.
- [x] Evaluate optional independent reviewer/watchdog: reuse explicitly authorized native reviewers when valuable; explicit semantic task assessments are implemented. No always-on model/watchdog loop or mandatory review ritual is introduced.
- [x] Keep task completion, Agent assessment, independent review and final Goal acceptance distinct. Unknown evidence never becomes pass.
- [x] Represent material Human optimization declarations in the same approved constraints/decisions, without another policy registry.

Exit: unapproved and stale plans cannot execute; clear approval can proceed; semantic checks are explicit and traceable, not claimed to be mathematically proven by runtime.

## M6 — strategy choice (RouteSet retired)

The earlier candidate tracked alternative strategies but never launched them automatically. The current candidate removes that surface, including its persisted state and approval bindings. Agents choose one strategy and create an approved DAG; semantic early exit, replanning, and artifact handoff are not implemented by this removal.

## M7 — simplify, measure, document and deliver

- [x] Deliver one progressively loaded Compass Skill covering attention, work calls, native children/waits, root-cause investigation, approval and acceptance. Do not require multiple overlapping orchestration guides per task.
- [x] Remove obsolete GoalRun schema migration, active-capability projection, session-wide state fallback, and tool-result state fallback; retain relevant current-format behavioral coverage rather than historical-format tests.
- [x] Replace automatic Goal/constraint/acceptance extraction and heuristic planning activation with explicit Agent semantic entry, native Human source/version checks, review-gated progression and consumed terminal evidence. Remove obsolete inference tests; retain lifecycle, stale-reference, compact delta and no-Goal frame/retention regressions.
- [x] Align current design, tool contract, README, package identity, preflight and installed native extension versions. Historical evidence is not current compatibility proof.
- [x] Replace false completion/documentation claims with actual local evidence and known limitations.
- [x] Apply Occam to the touched scope: remove obsolete schemas/fallbacks, the unused global write-guard implementation/test, dead scheduler rerun state and eager copies of arbitrary tool arguments. Retire the synthetic live-acceptance command/launcher and dedicated fixture/report tests: they could not satisfy normal native approval/assessment gates. Reuse the ordinary Agent workflow and session-report evidence instead of maintaining a second acceptance execution path. Keep source/range proof and meaningful regressions.
- [x] Measure representative local transition/search memory and CPU costs plus request/context sizes. Collect native usage evidence where available; do not invent provider/cache/cost measurements.
- [x] Run targeted/full/core/non-extension checks, static preflight, installed host import/API checks and independent high-risk source review; resolve reproduced findings. Verify actual package/Skill discovery from an unrelated target directory, not just source-project auto-discovery. Active interactive Pi registry/provider acceptance remains Human-only.
- [x] Reconcile requirements: implemented context/retention/retrieval/movement/spill, native composition, DAG gates; reuse native execution/waits/review and parent semantic judgment; unsupported recursive child Compass is explicitly fail-closed, not advertised as implemented. Human-only live evidence stays separate.
- [x] Version-control and publish coherent implementation milestones. README/handoff provide a short real-session test guide; local configuration is not included in delivery commits.
- [ ] Human performs actual Compass/provider acceptance and provides a feedback path. This is the only remaining verification ownership transferred to Human, not development TODOs.

## Final local evidence

Current implementation `495ac33`: full 239/239, core 68/68, non-extension 98/98, guard 18/18, isolated preflight passed. The guard-consumer check chains a listing revision into put and the committed receipt into remove. Native boundary tests verify concise grouped notices without changing the original result, and listing cursors survive unchanged restores without conflating different policies. See [payload measurements](measurements-v0.10.0.md#runtime-guard-cost).

The delegated-stop implementation `60180b0` remains covered. [`native-stop-host.test.mjs`](../tests/native-stop-host.test.mjs) uses the real `AgentSession` with an injected model stream and structured delegation fixture. It observes one actual idle-session wake after a committed child stop and replays the MindStudio stale-start and non-transactional Code Mode sequence. The fallback regression holds preflight open while the stop is committed and delivered, then verifies no further attempt launches. No pi-subagents source was changed; the tests used neither a provider nor the MindStudio checkout.

The serial-frame implementation `afc5197` remains covered. The unpatched Pi 1.5.2 loader/Runner uses an injected two-tab questionnaire answer, verifies RPC refusal, and commits A → B → C without a manual open, main turn or separate frame assessment. It checks exact artifact/caveat visibility, reload and duplicate boundary recovery, B throw → main with C pending, new-input pause with stamp reuse, and Code Mode and Goal acceptance. A native Runner plus delegation-bus fixture verifies that a returned frame releases an independent read-only child while the next frame is active; separate adapter checks cover unknown results and launch refusal. No live terminal rendering, child launch or provider request was run for this revision.

Earlier implementation `a426acc`, including semantic Goal foundation `63a14ff` and field-use corrections. The [consumer audit](agent-usage-audit-v0.10.0.md) records the latest frozen input/hash, five failed pin attempts, the redesigned consumption path, bounded reviews and measured interface/retention cost. Counts retain behavioral safety coverage and remove one redundant NLP-era mock-only assertion. Current-only GoalRun v8/context v5 reject unsupported snapshots without migration/reset; native raw history is unchanged.

| Check | Observed result |
|---|---:|
| `npm test` | 282/282, 0 skipped; 4.191 s |
| `npm run test:core` | 82/82; 0.081 s |
| `npm run test:non-extension` | 111/111; 0.235 s |
| `npm run test:guards` | 18/18; 0.911 s |
| `npm run preflight` / `node scripts/preflight.mjs --static-only` | PASS; expected source/target overlap warning |
| `node scripts/check-subagents-contract.mjs` | 36/36 against installed pi-subagents 0.88.1 |
| Context/retention/artifact regressions | Included in full suite; installed projection/runner adapters |
| Native package Skill discovery outside checkout | 1/1; one progressive Skill, no provider |
| Action-specific schemas and Code Mode-only loadout | Installed validator + prepareLoadout + declaration generator; no provider |
| Frozen field-call native replay | 266 parent references, entered/returned, paired exchanges; no provider |
| `git diff --check` | PASS |

Independent scoped reviews cleared persistence/approval, branch and scheduler generation recovery, nested watch ownership, route questionnaire/proposal correlation, artifact root/ancestor replacement protection, retrieval edit lineage/read completeness, Skill activation, spill range provenance, conflicting read evidence and whole-companion coalescing. The final binding review cleared shared syntax validation and immutable-record identity checks, keeping logical binding identity separate from payload entry IDs and provenance. Dead Goal/DAG continuity projections, duplicate DAG notes/state and the unused retry wrapper were removed; active GoalRun decisions/checkpoints remain authoritative. The repeated-read regression checks one covered payload and a net serialized-context reduction for a representative large read; a partial comparison cannot remove an uncovered remainder. The repaired scheduler regression emitted four requests instead of two before repair; the artifact race created an outside file before repair. Source identities, not text equality alone, control edits and eligibility. Auxiliary diagnostics remain inconclusive for some files and include a pre-existing dictionary-`any` rule finding; this is not a clean whole-project typecheck claim.

The semantic Goal audit also reproduced a real pause/fallback race: a primary terminal quota failure was replaced with an unlaunched fallback identity and became fictitious unknown work. The regression now covers pauses before the primary response and during fallback preparation; source identities are persisted/emitted without an await gap, suppressed fallback consumes the primary terminal fact, and Goal replacement is not blocked by a nonexistent run. Pre-Goal answers retain version 0; criterion IDs do not cross-rebind after replacement; bounded deltas declare omitted events. Independent bounded re-reviews found no remaining actionable findings in these fixes and obsolete-helper removal.

Field-use repair independently re-reviewed the result/context/search/acceptance seams. Review found a near-limit metadata/commit-size mismatch; the failure was reproduced, canonical metadata budgeting corrected, and a near-budget roundtrip regression added. The bounded re-review found no further actionable issues. Early validation and actual native commit remain distinct; generated questionnaires are now available directly in model-visible content, without unsolicited startup prompts. Final parent checks also cover complete structured Goal reads and cursor-validation errors before persistence.

The follow-up Agent-contract review separated query callability from native model-only mutations, checking the installed dispatcher/loadout contracts rather than retaining a duplicate nested-call hook. Root-object schemas enforce action-specific fields; native diagnostics identify the chosen action. Full-suite content-only checks preserve passing-route caveats/evidence refs, complete dispatch JSON, artifacts/images and canonical provenance. Base mutation metadata no longer repeats the Agent payload; native operation ownership stays intact. Independent bounded re-reviews found no further actionable issues in these changes. Schema size is an explicit tradeoff, not a provider-token saving claim.

A subsequent legacy-feedback check reproduced a missing qualifier in full Goal details: compact state exposed pending native-input review, while full details required inferring it from IDs. The detail response now exposes the same input.id/reviewed signal; the existing Human-reaffirmation regression covers false → true without treating semantic correctness as proven. The subsequent [runtime-guard kernel](runtime-guards-design.md) is implemented under the explicitly Human-approved native tool_call observation boundary; definitions are not automatically enabled.

Runtime guard verification uses actual SQLite/public sandbox/installed ExtensionRunner with temporary profiles. Independent review found and cleared cancellation/precommit, nested error notice, projection cursor, singleflight initialization, prototype-safe projection, idle-worker admission and revision/effect aggregation bugs; regressions cover each meaningful path without enabling Human profile rules. The scope revision hot path does not run a model; matching checks use fresh VMs inside one lazy worker. The documented JSON example was schema-validated, registered and triggered in a disposable fixture. Node 22.19.0 is the declared dependency minimum; actual local execution used Node 22.22.1. GoalRun remains v8; retained context is now v5 current-only and runtime guard snapshots remain v1.

Human live feedback then exposed a missed production seam: the guard kernel dynamically imported the globally installed Pi SDK through ordinary Node ESM resolution. Injected test profiles and the Node host-resolution shim bypassed it. An unpatched native discoverAndLoadExtensions/factory/Runner regression reproduced the exact compass_state block before repair; the entry now statically obtains and injects the host profile provider, with no extra local SDK dependency. The same probe executes a real Worker check and temporary-profile SQLite mutation; full preflight runs it and the in-session command reads actual guard state. A broader bounded audit reproduced and repaired queued operations crossing branches, detail cursors satisfying list reads, late notices leaking across branches, and empty-policy admission after an epoch changed during initialization. Control/read/check work now retains its enqueue/await epoch, and stale errors cannot enter a new branch accumulator. All added regressions passed; independent code re-review found no remaining actionable issue in this audited seam.

The subsequent consumer-contract revision removes Agent binding/version/revision plumbing rather than merely adding hints. Basic pin/unpin/remember uses stateless exact-source refs; optional context operations reuse the existing loader. Semantic Human sources are explicit and independent of latest-input review. Default results and retained envelopes omit internal audit data, while source details, inherited caveats and derived authorship stay recoverable. The rendered format is context v5 current-only with an explicit v4 rejection regression, not a compatibility path. The native consumer subprocess now executes both Goal/search/remember/compaction recovery and private-copy/edit/updated-ref/export; no source/ref decoding is required by that client. Three focused tests cover stale selection/binding safety, omitted/historical exact recovery and memory provenance/lifetime. Consumer-only schema review and bounded code rereviews cleared actionable findings; no reviewer execution is claimed. The [consumer audit](agent-usage-audit-v0.10.0.md) records the frozen evidence, measured interface costs and limits. Performance scripts reject empty/incorrect scan fixtures instead of reporting them as fast paths.

Native API/installed projection/runner checks, including this provider-free native factory probe, do not establish a real AgentSession/provider cycle. See [measurements](./measurements-v0.10.0.md) for bounded local CPU/memory/draft/request-size data and [README](../README.md#human-acceptance) for Human acceptance and feedback. No provider/cache/token or semantic-quality improvement is claimed from these checks.

## Native reference baseline

Last inspected local baseline: Pi 1.5.2; pi-subagents 0.88.1; sibling pi-await 1.3.0 candidate revision 4 (`8a51e51`). Recheck versions/contracts when integrating, without modifying pi-await or global Pi settings.

- Pi public extension boundary/session-format/compaction contracts and installed SessionManager projection implementation.
- Installed pi-subagents `docs/extension-api.md` and delegation declarations; native child lifecycle/status/cancellation contracts.
- Sibling pi-await README/handoff and watch result/custom-message contracts.
- DeepSeekHarness article and source were research inputs, not a replacement architecture or proof of local behavior. The historical inspected commit remains unknown.
