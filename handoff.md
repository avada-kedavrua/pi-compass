# Pi Compass V2 v0.9.1 — Handoff

## 1. Delivery status

v0.9.1 is a corrective release built on the delivered v0.9.0 source. It addresses the three blockers found in the user's 2026-10-31 live-acceptance attempt:

1. Pi warned because `typebox` was listed under `dependencies` instead of as a host-provided peer.
2. The package required `pi-subagents@0.83.1`, while the user's installed package is `0.84.0`.
3. `/compass-live-acceptance` assumed the Pi process working directory itself contained both `package.json` and `README.md`, then emitted a misleading instruction to start Pi from the Compass package directory.

The exact v0.9.1 bytes have not yet completed real Pi/provider live acceptance. This package is a candidate for that run, not a claimed production-accepted release.

## 2. What the uploaded evidence actually proves

Reviewed: `pi-compass-live-evidence-20261031T012954Z.tar.gz` and the terminal output supplied with it.

| Check | Evidence |
|---|---|
| Pi | 1.4.0 |
| Node / npm | 22.22.1 / 10.9.4 |
| Core suite | 89/89 PASS |
| Full v0.9.0 suite | 187/187 PASS |
| Static preflight | PASS |
| Installed pi-subagents | 0.84.0 |
| Old contract check | 35/36 PASS; the sole failure was the exact version pin |
| Proposed settings/runtime config | All checks passed except the same installed-version pin |
| Live Pi process | Not started |

The installed 0.84.0 `src/api/delegation.d.ts` and `bundle/delegation.js` bodies are byte-for-byte identical to the retained 0.83.1 baseline. The new contract report is preserved at `evidence/pi-subagents-0.84.0-contract.txt`; the checker now expects 0.84.0 and still checks the full public event/type surface and documented foreground-only integration constraint.

The current user configuration had drift (tool allowlists, model allowlist, worker model scope, concurrency and unsupported runtime keys). The generated proposal repaired those fields, while preserving unrelated fields. The original `settings.json` and pi-subagents runtime config were not modified. The live launcher continues to use isolated proposed copies.

The uploaded evidence summary explicitly says `Pi was not started`. Therefore the live acceptance did not fail in the runtime; it was blocked by preflight contract/config checks. The separate `ENOENT` shown in the terminal output came from invoking the command with a working directory that had no root `package.json`.

## 3. Implemented in v0.9.1

### 3.1 TypeBox host dependency

- Removed `typebox` from `dependencies`.
- Declared `peerDependencies.typebox = "*"`, matching Pi's host-provided package contract.
- Added `scripts/register-pi-host-typebox.mjs`. Full tests and non-static preflight resolve `typebox` from the installed Pi package, not from a Compass-local copy.
- `npm ci --omit=peer --ignore-scripts` omits the host peer from the Compass package tree. This matters because a package-local TypeBox copy can bypass Pi's host module mapping.
- Static preflight verifies the peer declaration and fails if `node_modules/typebox` exists locally.
- The live launcher refuses to proceed when a package-local TypeBox copy is present.

### 3.2 pi-subagents 0.84.0

- Updated the exact version pin, configuration patch filenames, default checkers and tests to `pi-subagents@0.84.0`.
- Retained strict contract checks; this is not a version-only bypass.
- Added the supplied 0.84.0 source-contract report. The declaration and runtime export match the 0.83.1 baseline byte-for-byte.
- No downgrade is required for the user's installed 0.84.0 package.

### 3.3 Live acceptance project root

`/compass-live-acceptance` now:
- uses the current project if it has a readable `package.json`, `README.md`, and safe visible entries;
- otherwise falls back to the Compass package directory;
- accepts an explicit project root: `/compass-live-acceptance /path/to/project`;
- records the selected fixture root as the execution `projectRoot`;
- no longer instructs the user to start Pi from a particular directory.

Pure tests cover current-root selection, fallback, and explicit-root behavior.

## 4. Validation boundary for this build

The uploaded v0.9.0 evidence proves 187/187 full tests and 89/89 core tests for the previous bytes. It does not prove that v0.9.1's changed files pass those tests.

This build environment has no installed Pi package, so it cannot resolve the host TypeBox module or run the complete extension suite without substituting a fake dependency. No fake TypeBox module is used. The following are run on the v0.9.1 bytes and recorded in `docs/validation-v0.9.1.md`:
- core tests;
- non-Extension tests;
- package/GoalRun static preflight;
- the supplied pi-subagents 0.84.0 contract report check;
- syntax checks for changed JS/TS and shell files.

The user's Pi environment must rerun `npm test`, full preflight, and the live acceptance harness on the exact v0.9.1 package. Do not infer runtime success from the fake-Pi unit tests or contract source checks.

## 5. User-side verification

Extract v0.9.1 into a new directory. Do not overwrite the working Compass installation. From the extracted package root:

```bash
npm ci --ignore-scripts --omit=peer
npm run test:core
npm run test:non-extension
npm test

bash scripts/run-live-acceptance.sh
```

`npm ci --omit=peer` intentionally removes/omits the package-local TypeBox copy. It operates only on the extracted Compass package's `node_modules`; using a new extraction directory avoids disturbing other local work.

When the isolated Pi TUI opens, run:

```text
/compass-live-acceptance
```

The launcher starts Pi from the extracted Compass package directory. If invoking the command manually from another project, the command now falls back to the Compass package when the current directory lacks the required fixture files. To test a specific app package, pass its root:

```text
/compass-live-acceptance /path/to/project
```

The smoke makes at least three read-only child model calls and may incur provider cost. It checks real request/response correlation, two parallel independent children, a dependency-gated later child, and that `code`/`parent` tasks remain undispatched. The report must say `PASS`.

Then perform the questionnaire checks:
1. Fully answer a questionnaire; confirm selected values and notes persist in GoalRun.
2. Partially answer; confirm unanswered indexes remain distinct.
3. Cancel; confirm this is a Human decline.
4. Trigger a no-UI or validation error; confirm the model sees a questionnaire-unavailable error, not a Human decline, and GoalRun records `human_questionnaire_error` without a duplicate generic failure.

Upload only the generated `pi-compass-live-evidence-*.tar.gz` if the run is blocked or fails. Do not upload settings, auth, model files, API keys, or session transcripts.

## 6. Remaining proof

- Exact v0.9.1 live Pi + pi-subagents 0.84.0 request/response and DAG scheduling.
- Live questionnaire middleware behavior in Pi 1.4.0.
- Natural provider quota fallback remains unforced; unit tests cover classification and one-time fallback.
- A matched parent-only cost baseline remains unavailable.

These are explicit acceptance gaps, not silently marked complete.
