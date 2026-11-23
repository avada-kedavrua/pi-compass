# Changelog

## 0.10.0 — seven-tool candidate

- Clarify Agent-first semantic verification: Compass checks deterministic mechanics only; domain coverage belongs in the Goal, project instructions and tests. Independent reviewer tasks remain optional and evidence-only. Do not add training-style penalty scores, long-lived error memories or universal review/watchdog loops; use bounded corrective receipts and existing deterministic gates.

- Resolve Release Assistant context detours: distinguish pending from applied, require explicit frame nesting, expose removable working groups without their bodies, and report actionable artifact path errors. Reuse an already blank frame checkpoint; session reports distinguish projection checkpoints from native compaction.

- Fix AiClusterHub field-use detours: scope frame input and approval echoes, report native questionnaire availability before offering a prompt, reject mixed context mutations early, and let nodes return inconclusive evidence without unlocking dependents. Plan reads are compact; inspect one task by ID for qualified evidence.

- Fix macOS field-use detours: surface the blocked approval before another tab, give the exact recovery action, and probe the guard Worker in `/compass-preflight`. Keep native ordinary tool telemetry out of GoalRun; preserve actual advisory DAG drift.

- Keep guard control receipts as compact JSON. Scope listing cursors to readable views, acknowledge writes with the committed revision, and emit deduplicated guard notices as short text without modifying business results.

- Wake main through Pi after the first correlated child `throw` is persisted. Sibling results still settle, and a fallback under preflight cannot delay the stop or launch afterward. No pi-subagents changes.

- Separate Goal and DAG signatures in one tabbed native questionnaire. Draft Goals without provenance refs. Make main the only planning frame, commit eligible serial frames and their exact handoffs without intermediate model turns, and return to main on semantic throw. GoalRun v11/context v6 reject earlier snapshots without migration.

- Make unapproved DAGs non-blocking for the Goal and let the Agent discard inactive plans. Carry the next approval or execution step in receipts. Validate artifact producers at definition and check exact inputs before reporting parent readiness. Admit read-only native nodes independently without holding the state queue during preflight.

- Use Pi’s native `tui` mode for exact DAG approval and canonicalize preview line endings before the native questionnaire echoes them. Pass the session’s scoped models to child preflight. Report optional DAG transport and bridge readiness in `/compass-preflight`.

- Remove `compass_route`, its state view, and the underlying strategy competition state and approval bindings. An approved DAG covers one strategy. GoalRun API/schema is now 10; v9 snapshots fail visibly without migration. DAG approval and task acceptance still apply.

- Add incremental Goal/DAG edits, approved parent-node frames with committed outcomes and exact artifact handoff, and scoped memory with native Skill auto-pin and exact repeated-read deduplication.
- Record each correlated child result as it arrives; the final late terminal result closes an unknown batch exactly once without redispatch. `throw` stops new DAG work and fallback without discarding sibling results. `cancel` targets a single exact attempt, and does not settle it.

- Refuse primary and fallback child launches without a verified native read-only leaf profile. Invalidate stale downstream assessments and preserve already-started outcomes. Keep correlation across invalid terminal events and recheck readiness after late recovery.

## 0.10.0 — R2 eight-tool convergence (live Pi/provider acceptance pending)

- **Breaking Agent contract:** replace the loader/capability surface with eight fixed tools — `compass_goal`, `compass_state`, `compass_context_search`, `compass_context`, `compass_plan`, `compass_acceptance`, `compass_route`, `runtime_guard`. Remove `compass_open`, `compass_goal_read`, the split plan/task/execution/history/triage tools and all loadout/capability state; no aliases, migration or compatibility adapter. GoalRun API/schema is 9 and current-only.
- Goal alone owns semantic definitions: `compass_goal set` takes the complete constraint list and optional complete criteria text, and code assigns the current `AC*` IDs. Plan, acceptance and route consume those IDs; duplicate plan/route criterion lists are gone, and `plan.definitionKey` binds plan, task assessment and DAG approval to the Goal digest.
- Code transports approvals: a material plan/route mutation returns a tiny native prompt whose preview is an opaque proposal ref. The Agent forwards it unchanged; at the `tool_call` boundary Compass expands the canonical complete questionnaire, but only for interactive Pi with a full-preview custom TUI. RPC, print, unknown or no-UI sessions are blocked with no approval and no state change; authorization requires the exact canonical preview echo plus native identity and the current binding. Truncated echoes, declined/partial/note/custom/UI-error answers never approve, and new Human input or a material definition change reports the approval as stale.
- One read surface: `compass_state` views `summary|goal|plan|acceptance|history|route|execution`. Summary stays compact with opaque `R…-E…-C…` cursors and an exact-repeat `unchanged` envelope; bounded history declares its gap. Mutation receipts return only newly usable IDs/refs and the next cursor.
- Preserve execution safety while removing bookkeeping: explicit `parent|code|subagent` intent, read-only enforcement plus `dispatchReason` for Subagent tasks, current-binding semantic assessments, correlated structured results, unknown-batch reconciliation with native confirmation evidence, and exact route/competitor identity with acceptance gates. Auto-dispatch still happens only after an exactly approved DAG, never for code/parent tasks, and never retries an unknown child.
- Replacing the tool surface also removed a duplicate context schema module, a duplicate reserved-message set, and a request-projection regression that leaked retired internal messages to the model.
- Fail-closed dispatch no longer discards evidence that did arrive. An ACK or terminal timeout still settles the caller as `unknown` and still forbids a second dispatch, but it retains the request correlation so a late correlated terminal response is absorbed into the same execution result. Only an execution result that is still `unknown` for that exact request may take it, so a manually reconciled or superseded batch is never overwritten. Retention is bounded and unref'd.
- Execution history keeps both provider diagnostic streams per task (`providerDiagnostics`, `primaryProviderDiagnostics`) plus `primaryDurationMs`, replacing the lossy flat `providerErrorCount`/`providerLastErrorKind`/`providerRetryPhase` projection that could only describe one attempt. A Primary fault that triggered DeepSeek fallback is now reconstructable from history. State normalization shares one diagnostics sanitizer with the delegation contract instead of keeping a second copy.
- Evidence: domain `goal-run`+`dag-core` 69/69; full suite 231/231 in 3.53 s; core 77/77; static preflight PASS; pi-subagents contract 36/36. The late-result regression fails on the previous implementation and passes now. These remain local adapter checks, not live provider acceptance.

## 0.10.0 — local candidate (live Pi/provider acceptance pending)

- **Breaking Agent contract:** replace exposed source ID/binding/version/revision plumbing with reusable opaque exact-source refs and code-owned context preconditions. The basic context tool now offers pin/unpin/remember; optional frames/edits/artifacts load through the existing context capability. Default search/state/retained envelopes omit empty, duplicate and internal audit fields; handles/details are on demand. Goal creation requires explicit original Human refs independently of latest-input review. Short Agent-authored memories retain exact provenance/caveats instead of automatically keeping entire large results. Updated values and private captures return usable next refs. Remove old public arguments and dead ranking/comparison/transfer aliases, not a compatibility layer. Retained-message format is context schema v5; old v4 snapshots fail visibly without migration/reset. See the [consumer audit](docs/agent-usage-audit-v0.10.0.md) for the original failure, measured costs and bounded reviews.
- Repair the reported live runtime-guard SDK-resolution failure: inject the host profile provider from the native extension entry instead of dynamically resolving the global Pi package inside a native ESM module. Add an unpatched real-loader/factory/Worker/SQLite regression, and run it in full preflight; the in-session command now reads actual guard state rather than checking registration alone. Bind queued/awaited operations and notices to their original branch epoch, and distinguish detail/list cursor projections. See [local evidence](docs/architecture-v0.10.0.md#final-local-evidence); no extra SDK installation, data reset, guard bypass or provider request is required.
- Implement optional `runtime_guard` with fixed put/get/test/remove operations, Agent-written pure JS, stable scoped IDs and scope-revision CAS. Session rules use native branch state; global/local share private SQLite/WAL without local override. Native tool_call warns preserve all business result fields and append compact parent-visible boundary notices; blocks prevent execution and retain error pairing, including swallowed nested errors. The Human explicitly accepted observed-input coverage, not post-plugin final parameters or independent children. Checks use fresh public Code Mode VMs in one lazy, hard-cancellable, idle-reaped Worker; no Node eval, model inference, automatic rule creation, cooldown scheduler or rules enabled by development. Pin the owned Code Mode 1.5.2 dependency, keep TypeBox host-only, and require Node >=22.19.0. Document the [execution contract and limits](docs/runtime-guards-design.md); native integration/provider acceptance remains separate.
- Qualify full Goal details with the same native-input `input.id/reviewed` signal as compact state: newer observed Human input is visibly unreviewed until explicit Agent reaffirmation. This detects pending review, not semantic constraint conflicts.
- Separate source recovery (`compass_context_search`, Code Mode-callable) from context procedures (`compass_context`, native model-only). Mutations use a root-object/nested discriminated operation schema with required and disallowed fields; model-only exposure keeps them reachable in Code Mode-only mode without a second hook policy. Remove duplicated domain metadata, mutation-name/provenance echoes and full RouteSet mutation dumps while retaining native identities, unresolved gates, caveats and on-demand evidence. Keep automatic dispatch feedback in the same JSON receipt so programmatic decoding remains valid. Document Skill-versus-extension loading and report exact schema-size tradeoffs; no forced adoption or global settings changes.
- Repair first-task field failures without forced adoption: remove the 256-source parent-frame snapshot ceiling (reference metadata has a 2 MiB budget), validate before queued and revalidate at commit, correlate JSON terminal receipts, and preserve artifact text/image recovery. Search defaults to ranked keyword-any with explicit all-term matching; suppress search-envelope recursion and duplicate excerpts. Emit compact Agent JSON receipts with exact native approval questionnaires in content, full on-demand acceptance evidence and strict no-truncation validation. Record measured overhead, local replay and unresolved net-benefit questions in the [field audit](docs/agent-usage-audit-v0.10.0.md).
- Make Goal interpretation explicitly Agent-owned through `compass_goal`, with native Human source IDs and optimistic version checks. Delete prose-driven Goal/constraint/acceptance extraction, candidate/change registries and heuristic planning activation. New Human input pauses approved progression until reviewed; exact reaffirmation preserves approval and native terminal facts remain consumable. Compact state omits repeated raw text, empty diagnostics and native tool inventory; cursors include context revision and declare bounded-history omissions.
- Add same-session attention frames with explicit ref/copy capture and return, scoped versioned values, copy-on-write, read-only Human originals/executed calls, and complete tool exchanges. Bind native context drafts and resulting state with intent/commit receipts; incomplete persistence aborts visibly rather than resetting frames.
- Retain qualified pins, explicit Skills and structured Human answers across compaction using missing-only request overlays and later native boundaries. Keep native system/tool/AGENTS state unchanged. Immediate post-compaction canonical restoration remains unsupported by stock Pi 1.5.2.
- Add on-demand active/parent/history retrieval, verified Agent ranking, exact range load/move, and explicit repeated-read coalescing. Preserve source identity, projection lineage, completeness, caveats and provenance; subset relocation requires shared native file-revision evidence, and a partial comparison cannot erase an uncovered remainder.
- Add project-relative artifact spill/readback/reload with envelope digests, receipt-bounded reads and Linux descriptor-relative traversal. Verify root device/inode identity across replacement races. Other platforms fail closed; filesystem effects are not rolled back and failures may report orphan artifacts.
- Require exact correlated structured Human approval for DAG execution. Bind entry/call identities, Goal/route/baseline/tasks/executors/constraints; material changes invalidate approval. Isolate asynchronous work by native lifecycle generation, preserve unknown child outcomes, validate requested/reported model identities and reconcile terminal facts without advancing dependencies.
- Keep RouteSet alternatives separate from DAG tasks. Scope/budget proposals require exact Human authorization; shared-criteria acceptance gates route selection and exact-identity competitor cancellation. Reject out-of-order cancellation, late-result races and undocumented native terminal statuses. Native pi-await arm identities own watch liveness, repeat/lost/terminal behavior and explicit frame transfer.
- Unify binding syntax and verify logical value identity against immutable native content/snapshot/write records, independently of provenance. Remove unused Goal/DAG continuity projections, duplicate DAG notes/state, the global write guard and dead retry/scheduler wrappers. GoalRun remains the authoritative decision/checkpoint store; GoalRun schema v8/context v4 are current-only; unsupported snapshots fail without migration or reset.
- Remove the obsolete automatic live-acceptance command, isolated launcher and fixture/report-only tests: they created a draft then failed the native approval/assessment gates. Human acceptance now uses the ordinary Agent, exact questionnaire, task assessment and native scheduler with session-report evidence, not a synthetic tool-result trigger or another configuration/execution path.
- Package one progressively loaded Compass Skill and verify installed discovery outside the checkout. Publish the current [requirement checklist and local verification](docs/architecture-v0.10.0.md#final-local-evidence), [measurements](docs/measurements-v0.10.0.md) and [Human acceptance](README.md#human-acceptance). Local installed-host checks are not live Pi/provider acceptance or provider-cache/cost evidence.
- Expose committed frame/root identity through the native footer and compact `compass_state.contextFrame`, without polling or duplicating frame contents. Frames and retained values work before a Goal exists; their default retention is session-scoped, not a fictitious Goal version.

## 0.9.1 (2026-10-31)

- Declare Pi-hosted `typebox` as `peerDependencies: { "typebox": "*" }`; remove it from runtime dependencies to prevent a duplicate module copy.
- Resolve TypeBox for tests and full preflight through the installed Pi host. The live launcher rejects a package-local TypeBox copy and documents `npm ci --omit=peer --ignore-scripts`.
- Update the exact `pi-subagents` compatibility pin to the user's installed `0.84.0`. The supplied 0.84.0 `src/api/delegation.d.ts` and `bundle/delegation.js` are byte-identical to the retained 0.83.1 baseline; all 36 structural contract checks pass after the version update.
- Fix `/compass-live-acceptance` project-root selection. It now prefers the current project, falls back to the Compass package when the current directory lacks `package.json` or `README.md`, and accepts an explicit project-root argument.
- Add focused tests for live acceptance root resolution. The exact v0.9.1 live Pi/provider run remains pending.
- Validation on the v0.9.1 source: core 89/89 PASS, non-Extension 127/127 PASS, collected pi-subagents 0.84.0 contract 37/37 PASS, static preflight and syntax checks PASS. Full `npm test` has 127 passing tests; the Extension test file is blocked in this build container because no Pi host TypeBox package is installed. Exact live Pi acceptance remains pending.

## 0.9.0 (2026-10-31)

- Promote GoalRun to schema/API v7; accept and migrate existing schema v2-v6 states.
- Remove the unreferenced v0.7 GoalRun implementation module; v0.9.0 has one active GoalRun implementation.
- Preserve structured `ask_user_question` outcomes: answer kind, selected labels, per-question notes, unanswered indexes, global note, and whether a selected option had a preview. Rich preview markdown is intentionally not duplicated into GoalRun.
- Distinguish a genuine Human decline from questionnaire validation/UI errors. Errors become `human_questionnaire_error` events and are not inserted into `humanDecisions`.
- Prefix structured questionnaire UI/validation failures at Pi's `tool_result` middleware boundary with an explicit no-Human-answer/not-a-decline classification, preserve the original diagnostic text, and mark the result as a tool error.
- Keep the legacy text-only answer capture path for older `ask_user_question` result envelopes.
- Add bounded normalization and regression tests for answered, partial, declined, error, duplicate, and schema-migration paths.
- Add the v0.9.0 architecture contract for RouteSet/DAG separation, Context Ledger, Pi-native Context Edit, Agent-owned Attention, and Caveat propagation. These mechanisms are design-only in this release; no automatic branch fan-out or Context Edit pruning is enabled.
- No new runtime dependencies.
- Validation: core 89/89 PASS, non-Extension suite 124/124 PASS. Full extension suite and Pi preflight are blocked in this build container because TypeBox is unavailable, `npm ci` timed out, and no Pi CLI is installed. See `docs/validation-v0.9.0.md`.
- The v0.8.0 RC6 live evidence is inherited only. No v0.9.0 bytes have been run in live Pi.

## 0.8.0 (2026-10-29)

- Accepted the real Pi 1.4.0 + pi-subagents 0.83.1 structured-delegation RC6 evidence: three genuine child runs, two DAG waves, read-only evidence, and observed cost/time. The original RC6 report remains FAIL because its validator rejected the documented `provider/model:high` format. The underlying data independently satisfies that check after normalization; this is a historical evidence reconciliation, not a new execution of the final package.
- Match exact whitelisted model IDs with an optional documented thinking suffix (`off|minimal|low|medium|high|xhigh|max`); reject unknown models and arbitrary suffixes. Preserve observed model identities and usage without rewriting or concealing them.
- Live report checker now cross-checks child model/observed tool activity, run IDs, task evidence, and dependency waves rather than trusting flags alone. Add regression coverage using the actual `:high` result shape.
- The final executable runtime retains RC6's bounded read-only Subagent scheduling, Human veto, Code Mode separation, error/unknown recovery, and split configuration policy. No undocumented cross-extension API is introduced.
- Full local test suite is run against TypeBox 1.4.3 recovered from the previously uploaded RC1 package, not a fake TypeBox replacement. Registry access remains unavailable in this build sandbox.

## 0.8.0-rc.6

- Fix the stale extension preflight test that still expected the RC4 release string; derive release identity from the GoalRun module/package manifest so future release bumps do not break unrelated tests.
- Make the in-session preflight release label use the module release constant and compare the module release against the package manifest instead of hard-coded RC5 text.
- Make the live acceptance launcher identify its candidate version dynamically.
- Preserve the user's RC5 evidence finding: full tests were 176/177, and Pi was not started because the stale version assertion blocked the launcher. RC6 remains a candidate until fresh full tests and real Pi/provider acceptance pass.

## 0.8.0-rc.5

- Correct the configuration-surface bug: keep Pi settings-level keys in `settings.json` and move documented pi-subagents runtime options to `~/.pi/agent/extensions/subagent/config.json`.
- Update the config proposal script to merge both files separately, preserve unrelated values, remove obsolete `fallbackModels`, remove misplaced runtime keys from settings proposals, and avoid overwriting existing output files.
- Stop emitting undocumented global `toolActivation` and `disabledFeatures` keys; update the strict checker to reject these keys on the wrong/unsupported configuration surface.
- Update the isolated live acceptance launcher to validate both proposed config files and use the merged runtime config rather than overwriting it with the original config.
- Capture observed tool names/counts from the public structured-delegation progress events, retain only tool names (never arguments), and preserve those fields through GoalRun normalization for live acceptance evidence.
- Make live acceptance honest about optional provider usage: reported cost/token/duration fields may be unknown, but must remain explicitly null/known rather than fabricated as zero. Validate actual observed tool activity separately from usage counters.
- Local validation: core tests 82/82 pass; non-extension tests 115/115 pass; user-supplied 0.83.1 contract report 37/37 pass. Full `npm test` and live Pi acceptance remain blocked/pending because this build environment cannot fetch `typebox` (`EAI_AGAIN registry.npmjs.org`).

## 0.8.0-rc.4

- Pin compatibility to the user's actual `pi-subagents@0.83.1` report and add an offline report checker alongside the installed-package contract checker.
- Require `dispatchReason` for new read-only Subagent tasks so the planner explicitly justifies the added semantic call; adapt wave sizing from measured wait savings and repeated provider fallback.
- Preserve absent provider usage fields as unknown rather than zero; report incomplete cost/usage metrics honestly.
- Emit exact-identity cancellation requests when a new Human instruction prohibits Subagents; missing cancellation/terminal acknowledgement remains unknown and is never assumed stopped.
- Correct the configured per-session spawn budget to 100 while keeping the per-run DAG limit at 24, so one DAG does not exhaust the whole session budget.
- Strengthen the isolated live launcher: preserve optional pi-subagents extension config privately, avoid duplicate loading of Compass/provider/subagents packages, and require a PASS report rather than treating any report file as success. Add a dedicated report checker with regression tests.
- Add live acceptance coverage through the same shared post-tool-result scheduling handler; refresh validation records to 176/176 full tests and 82/82 core tests.

## 0.8.0-rc.2

- Replace the unverified RPC/workflow prototype with the public pi-subagents Structured Delegation API (`prompt-template:subagent:request|started|update|response`).
- Automatically dispatch explicitly declared, ready, read-only Subagent tasks at the `tool_result` boundary; consume correlated structured results and automatically advance dependency-ready Subagent waves. Add a `before_agent_start` recovery sweep for a persisted plan whose dispatch boundary was missed, with latest-Human-instruction veto.
- Persist wave/request identities before launch, refuse manual starts of Subagent-routed tasks, and fail closed to `unknown` after missing acknowledgements or session restart. Add a conditional execution status/reconciliation tool.
- Implement one narrow DeepSeek v4.1 Flash fallback after recognized primary provider quota/rate-limit or availability errors; do not retry semantic task failures, child deadlines, malformed output, or unknown runs.
- Track reported child usage, duration, fallback and rough parallel wait-savings estimates over the last eight completed waves.
- Add explicit read-only tool allowlists to configured Subagent roles, cap concurrency at four, align per-run/session spawn budgets with the 24-node DAG limit, disable nested Subagents, strengthen the installed-config checker, and add a safe non-destructive settings proposal merger.
- Update the contract exporter to capture the exact installed delegation type and bundle files; document that a live Pi request/response cycle remains required.
- Local tests cover auto-dispatch, parallel/dependent waves, evidence-gated completion, provider fallback, disabled-tool preference, and unknown-run reconciliation. Live Pi/provider acceptance remains pending.

## 0.8.0-rc.1

- Promote GoalRun to schema/API v6 with v2–v5 migration support; old tasks default to `executor=parent` so migration never silently delegates.
- Add explicit `parent`, `code`, and `subagent` task executor intent and validate that Subagent tasks are read-only.
- Consolidate task lifecycle tools into `compass_task(action=...)`; remove the redundant ready-only tool because `compass_plan_status` returns ready IDs.
- Add automatic path-scope drift warnings for observable top-level write tools; inject the warning into the next Goal anchor without requiring an Agent-initiated reflection call.
- Pin the proposed pi-subagents config to 0.83.0, remove `fallbackModels` from the fragment, and add a config checker plus static-only preflight mode.
- Remove the incoming draft's mocked RPC adapter after discovering it targeted an RPC channel/method contract that does not match the current public pi-subagents RPC docs. Keep the workflow-script generator isolated and explicitly experimental; automatic dispatch is not included in this RC.
- Validate local tests and static preflight; live Pi and actual pi-subagents RPC v2 integration remain pending.

## 0.7.0

- Review hardening: `compass_open` now lists only applicable *unloaded* groups and is hidden once all groups are loaded, preventing repeated no-op opens and preserving a compact model-facing schema.
- Human-provided Subagent prohibitions override DAG eligibility; latest explicit instructions supersede older instructions. In-progress read-only tasks do not count as newly available delegation candidates.
- Handle fenced convention examples and blank-line transitions without discarding unrelated Goal instructions. Add corresponding regression tests.
- Replace unconditional native Subagent visibility with a reversible code-derived gate: show Subagent tools when at least two current DAG tasks are ready, declared read-only, and have satisfied dependencies, or when Human explicitly requests Subagent use or parallel scouting across multiple independent paths. Respect the Pi/user-enabled native-tool preference; do not create a DAG or auto-dispatch.
- Make capability disclosure state-derived. `compass_open` is hidden when no group applies, and its enum contains only current relevant groups. Simple Goals keep `compass_state` without an unused capability menu.
- Make planning activation more conservative: explicit planning/multi-stage intent or at least two actionable numbered work items may surface planning; a numbered diagnostic/evidence list alone does not. The existing cross-file write fallback remains.
- Remove the Compass-owned conventions registry, CRUD tools, and duplicate context injection. Leave any legacy conventions file untouched and unused; preserve current-Goal Human constraints for Messages continuity.
- Fix session-report timestamp handling for numeric Unix milliseconds and add assistant/model request error counts, provider/model breakdown, logged error durations, transport phase, and request size when available.
- Add regression tests for dynamic capability availability, quoted/diagnostic planning examples, reversible Subagent visibility, user-disabled native tools, and model-request error accounting.
- Keep GoalRun schema/API v5; version the module as `goal-run-v0-7-0.mjs`.

## 0.6.0

- Surface planning tools at Goal capture for explicit multi-part/multi-workstream Goals without creating a DAG or mandating use; retain cross-file-write activation as a fallback.
- Add a structured Goal outcome projection that distinguishes not assessed, incomplete, blocked, failed, and Agent-reported satisfied, and never claims independent verification.
- Reprioritize the compact Goal anchor around current objective, pinned Human constraints, outcome, actual plan/blocker state, decisions/checkpoints, and repeated failure patterns; keep one-off failures on-demand.
- Preserve explicit pinned constraints in source order ahead of later hard-sounding instructions; recognize Chinese `硬性限制`/`硬性约束` headings and numbered Goal clauses with explicit hard language as pinned, without pinning ordinary numbered workflow steps. Reduce framework-generated workflow pressure and explicitly reject universal tool bans/step sequences.
- Add a reproducible JSONL session-report script for top-level/nested tool calls, errors, usage, compactions, repeated state reads, no-op opens, and Goal reads.
- Keep GoalRun schema/API v5; version the module path for safe reloads.
- Add regression coverage for planning activation, outcome classification, failure-context escalation, and session-report counts.

## 0.5.1

- Preserve explicit `Restrictions`/`Constraints` clauses as pinned Human constraints. Hard constraints have a separate bounded retention budget from soft preferences, survive later instruction churn, and are prioritized in the compact Goal anchor and full Goal details.
- Return structured `revision`, `stateVersion`, task-state, ready/blocked, and acceptance fields from `compass_plan_status`; expose `stateVersion:` in the text summary for deterministic Code Mode extraction.
- Permit evidence-backed completion of a ready pending task when work predates DAG tracking, while continuing to reject completion when dependencies are unfinished. Starting remains available to track ongoing work.
- Increase task evidence input/storage bound to 1,600 characters and acceptance evidence to 2,000 to avoid unnecessary schema retries; event previews remain independently bounded.
- Explain each invalidated task in plan-revision results, including prior status and reset reason. Unknown affected task IDs report current valid IDs.
- Surface an explicit caveat when acceptance is only Agent-reported satisfied while DAG tasks remain blocked.
- Clarify conditional planning activation for multi-stage/multi-track Goals, and discourage repeated no-op capability opens or repeated full Goal reads without a Goal/source change.
- Add regression tests for constraint retention, task lifecycle, evidence bounds, outcome caveats, structured status, and plan-revision invalidation details.

## 0.5.0

- Fix false Goal replacement from embedded prose: only direct top-level Goal labels/replacement commands can automatically change Current Goal; quoted/fenced Goal text is excluded.
- Parse explicitly labelled acceptance lists from the first Human prompt and direct Goal-change messages. The original prompt remains intact; extracted criteria and hard constraints survive compaction as structured state.
- Extract hard constraints from explicit `Restrictions`/`Constraints` sections even when individual bullets do not contain a command keyword. Acceptance-list parsing stops at trailing prose after a blank line.
- Recognize a versioned `Goal vN:` label embedded in a longer task message as a pending candidate. Surface `compass_goal_change` only for that pending review, with explicit `apply`/`dismiss`; applying defaults to the extracted scope instead of requiring the Agent to rewrite it into a potentially narrower Goal.
- Retain the Human update that established Current Goal by update ID. Goal details can retrieve its full retained message; the compact anchor shows its source summary. Acceptance ID-range references are checked against current criteria IDs and warn on missing/mismatched IDs rather than treating any nonempty criteria list as complete.
- When native Subagents are registered but not active in Pi's current toolset, the Agent anchor states that parallel scouting is unavailable. Compass does not silently enable a tool the user has disabled.
- Extract Human session directives into atomic clauses, deduplicate repeated constraints, and retain reaffirmation counts instead of clipping a whole prompt into one directive.
- Replace event-only `E<n>` state cursor with composite revision/event cursor `R<revision>-E<event>`. Exact cursor reads return a tiny unchanged envelope; revision-only changes are detected even when no current-Goal event was added.
- Avoid false state revisions from repeated identical write observations, no-op plan revisions, and repeated identical acceptance evidence. Canonicalize relative/absolute write paths before the deterministic planning-activation threshold.
- Avoid re-reading the injected Goal/plan/acceptance summary by default; state-tool descriptions now direct the Agent to call only for event deltas, cursor recovery, or live capability inventory.
- Keep task lifecycle tool names and schemas stable while a DAG is active. Task IDs, readiness, and status are validated in handlers; plan state versions are checked at execution rather than baked into a changing enum.
- Keep acceptance status/record tools stable as criteria are defined; validate criterion IDs at execution.
- Keep native Subagent visibility under Pi/user control regardless of DAG existence, enabling independent scouting before task decomposition.
- Hide `affectedTaskIds` from decision schema when no DAG exists and accept longer decision evidence references with bounded storage.
- Upgrade GoalRun module/API/state schema to v5, retaining migration support for v2-v4 state.
- Add regression tests for embedded Goal mentions/candidate changes, atomic directives, revision-aware cursors, stable task transitions, capability retention across Goal changes, idempotent acceptance evidence, canonical write targets, and Subagent visibility.

## 0.4.0

- Promote GoalRun to API/schema v4 with v2/v3 migration support and a release-versioned module path.
- Add `compass_state`, automatically available after Goal capture. It provides a compact Goal/plan/acceptance/capability snapshot plus an event cursor and incremental current-Goal event delta.
- Explicitly report registered vs active `codemode`, native Subagent, and `ask-user-questions` capabilities; do not infer native tool visibility from Code Mode's tool list.
- Add explicit cursor-ahead and history-gap handling. A bounded event log no longer silently implies complete history.
- Change triage to accept short issue text and/or current-Goal event references; reject stale/unknown/cross-Goal references and deduplicate identical reviews when relevant state has not changed.
- Bound issue review output to 2,800 characters and prioritize relevant state over repeated full histories.
- Rework the per-request Goal anchor to use priority-based inclusion and a 2,200-character target, preserving Goal identity, directives, plan state, and acceptance caveats before secondary history.
- Stop duplicating full GoalRun state inside every mutation tool result when Pi custom-entry persistence succeeds; preserve the details fallback only when custom-entry persistence is unavailable.
- Update preflight to check the v4 module contract and, when TypeBox is installed, import the actual extension entry module before live Pi testing.
- Add regression coverage for cursor deltas, history gaps, Goal isolation, triage deduplication, stale references, and runtime capability inventory.

## 0.3.1

- Version the GoalRun module path to avoid reusing a cached older dependency module on in-place reload.
- Add a GoalRun export-contract check and runtime guard for issue-review escalation.
- Add atomic multi-capability loading and compact Goal details.
- Keep stable tool names and defer schema refresh to model-request boundaries.
- Deduplicate restored initial prompts and avoid echoing the same Goal in updates/directives/history.

## 0.3.0

- Introduces GoalRun schema v3 with Goal-versioned events, Human updates, decisions, checkpoints, traces, and acceptance criteria.
- Adds explicit acceptance states and separates task closure from Goal acceptance.
- Makes capability loading additive, keeps DAG optional, and reuses Pi-native Code Mode/Subagents.

## 0.2.x

- Introduced GoalRun state independent of a DAG, progressive capability loading, dynamic task schemas, serialized mutations, and bounded context projection.
- Added Human-authorized conventions and on-demand issue review.
