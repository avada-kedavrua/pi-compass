# Pi Compass V2 — 0.9.1

> **Unreleased development:** this branch contains context-foundation and native same-session frame changes requiring Pi >=1.5.2. `compass_context` uses Pi `turn_end` boundary drafts; it does not create another Session or Agent Loop. See [the implementation TODO and current evidence](./docs/architecture-v0.10.0.md). The v0.9.1 release manifest and validation records describe the historical release, not acceptance of these changes. No v0.10.0 release is claimed.

Pi Compass is an agent-only Pi extension. Its objective is to reduce the total practical cost of completing arbitrary Goals without lowering correctness or delivery quality. It is not a human-facing workflow UI.

## 0.9.1 changes

- **GoalRun schema/API v7.** Existing v2-v6 states migrate to v7. The active Goal, versioned Human constraints, decisions, plan, acceptance and bounded event history remain the single Compass continuity source.
- **Structured Human decisions.** When `ask_user_question` returns structured `details`, Compass preserves question/answer semantics, selected multi-values, notes, unanswered indexes and global notes. Large option previews are not duplicated; only `hasPreview` is retained.
- **Correct decline/error distinction.** A Human decline is a decision. UI load failures and validation errors are `human_questionnaire_error` events, not Human decisions. Older text-only result envelopes still use the prior capture path.
- **Architecture boundary for the next step.** `docs/architecture-v0.9.0.md` defines RouteSet separately from DAG, Agent-owned attention, Pi-native append-only Context Edit, the Context Ledger and Caveat semantics. The v0.10 development branch now has the first native frame core; nested/reload/provider acceptance and retention semantics remain unaccepted TODOs.
- **No new runtime dependency.** TypeBox is host-provided by Pi and is declared only as `peerDependencies: { "typebox": "*" }`; it is not installed into the Compass package.

## Retained v0.8 execution model

- Explicit executor ownership: `parent` for coupled reasoning/mutations/final integration, `code` for deterministic Code Mode batching, and `subagent` for isolated read-only semantic investigation.
- Automatic dispatch only for explicitly declared, justified, dependency-ready read-only Subagent DAG tasks through the public `pi-subagents@0.84.0` Structured Delegation API.
- Human veto and exact-identity cancellation; unknown child outcomes fail closed and are never automatically retried.
- Narrow provider fallback only for recognized quota/rate-limit or availability errors.
- Compact Goal state, composite revision/event cursors, bounded history with explicit gap reporting, and risk-proportionate acceptance.
- Task completion, Agent-reported acceptance and independent verification remain distinct.

A DAG is optional. Simple Goals remain on the light default loadout. The Agent chooses the route and decomposition; code validates deterministic boundaries.

## Released v0.9.1 compatibility target

- Pi: `>=1.4.0` for the historical v0.9.1 release. The current unreleased development branch requires Pi `>=1.5.2` for native `context_with_system` and actionable boundary behavior; do not treat the historical target as current runtime acceptance.
- `pi-subagents`: pinned target `0.84.0`; its delegation declaration and runtime export are byte-identical to the supplied 0.83.1 baseline.
- `@juicesharp/rpiv-ask-user-question`: tested against the supplied source `2.15.0`; text-only fallback remains supported.
- GoalRun: schema/API v7.
- Node.js: `>=22.16.0`.

## Local checks

```bash
npm ci --ignore-scripts --omit=peer
npm run test:core
npm run test:non-extension
npm test
node scripts/preflight.mjs /path/to/separate-target-project --static-only
node scripts/check-subagents-contract.mjs --report evidence/pi-subagents-0.84.0-contract.txt --expected 0.84.0
bash -n scripts/run-live-acceptance.sh
```

`npm ci --omit=peer` is intentional: Pi supplies `typebox`; installing a package-local copy can bypass Pi's module mapping. Full `npm test` resolves TypeBox from the installed Pi package through `scripts/register-pi-host-typebox.mjs` and therefore requires Pi >=1.5.2 on PATH for the current development tests (or `PI_CODING_AGENT_PACKAGE_ROOT`).

The 2026-10-31 user-side v0.9.0 evidence records 89/89 core and 187/187 full tests, with static preflight passing. Live Pi was not started because the installed pi-subagents 0.84.0 did not match the package's old 0.83.1 pin. v0.9.1 updates that compatibility baseline and the TypeBox host dependency contract; exact v0.9.1 live acceptance remains pending. See `docs/validation-v0.9.1.md`.

## Configuration proposal

The existing v0.8.0 configuration merger/checker remains. It proposes Pi `settings.json` and the pi-subagents runtime config separately, never edits either original, and removes obsolete `fallbackModels`. Review both generated files before adopting them. The settings proposal may contain credentials; keep it local and never upload it.

## Live acceptance

The inherited RC6 evidence demonstrates a real Pi 1.4.0 / pi-subagents 0.83.1 structured-delegation cycle for the v0.8.0 predecessor. The supplied 0.84.0 contract report shows the public delegation declaration and runtime export are byte-identical to that baseline. Neither historical run is a live run of the v0.9.1 bytes. The original RC6 report remains preserved with its historical FAIL status and independent reconciliation in `evidence/live-rc6/`.

For a new isolated runtime run, execute:

```bash
bash scripts/run-live-acceptance.sh
```

When the isolated Pi TUI opens, run `/compass-live-acceptance`, wait for the report, then exit Pi. The command uses the current project if it has `package.json` and `README.md`; otherwise it falls back to the Compass package. You can pass an explicit fixture root: `/compass-live-acceptance /path/to/project`. The test makes at least three read-only child calls and may incur provider cost. Original settings are not modified. A v0.9.1 live PASS is still required before claiming runtime compatibility for these exact bytes.

## Architecture and handoff

- [`docs/design.md`](./docs/design.md): current design contract.
- [`docs/architecture-v0.9.0.md`](./docs/architecture-v0.9.0.md): RouteSet, Messages, Context Edit, Attention and Caveat design boundaries.
- [`docs/validation-v0.9.1.md`](./docs/validation-v0.9.1.md): current validation results and remaining blockers. The prior `docs/validation-v0.9.0.md` is retained as historical evidence.
- [`handoff.md`](./handoff.md): delivery state, exact next steps and user-side verification.

Historical v0.5.0-v0.7.0 session analyses and field baselines are included. The raw JSONL exports are not bundled; see `handoff.md` for the evidence boundary.
