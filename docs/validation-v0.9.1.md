# Pi Compass V2 0.9.1 — Validation Record

> Historical v0.9.x record, not current instructions. The old automatic live-test helpers were removed in v0.10; use the [current native acceptance path](../README.md#human-acceptance).

Date: 2026-10-31

## 1. User-provided v0.9.0 acceptance evidence

Reviewed `pi-compass-live-evidence-20261031T012954Z.tar.gz`:

| Check | Result |
|---|---|
| Pi / Node / npm | 1.4.0 / 22.22.1 / 10.9.4 |
| Core tests | 89/89 PASS |
| Full v0.9.0 tests | 187/187 PASS |
| Static preflight | PASS |
| Installed pi-subagents | 0.84.0 |
| v0.9.0 installed contract check | 35/36; sole failure was expected 0.83.1 vs actual 0.84.0 |
| Proposed config | All checks except the same package-version check passed |
| Live Pi process | NOT STARTED |

The installed 0.84.0 `src/api/delegation.d.ts` and `bundle/delegation.js` are byte-identical to the retained 0.83.1 baseline. Their SHA-256 values are preserved in `docs/pi-subagents-compatibility.md` and the source reports. The 0.84.0 collected-report contract checker passes 37/37, including the report metadata check.

The original settings/runtime config were not modified. The proposed configuration corrected tool allowlists, model scope, concurrency, and unsupported runtime keys. The uploaded `summary.txt` says Pi was not started, so this was a local preflight block, not a live runtime failure.

## 2. v0.9.1 checks executed in this build environment

| Check | Result | Notes |
|---|---|---|
| `npm ci --ignore-scripts --omit=peer --offline --no-audit --no-fund` | PASS | No local `node_modules/typebox` was installed |
| `npm run test:core` | **89/89 PASS** | GoalRun, DAG, questionnaire integration core |
| `npm run test:non-extension` | **127/127 PASS** | Includes the three new live-root tests |
| `npm test` | **127 PASS / 1 test file blocked** | `tests/extension.test.mjs` requires Pi's real host TypeBox; this build container has no Pi installation |
| Static preflight | PASS | Package/API/cursor, TypeBox peer declaration, no local TypeBox copy, target separation |
| pi-subagents 0.84.0 report check | **37/37 PASS** | Checks the supplied report; no runtime dispatch |
| Changed TS/JS/shell syntax | PASS | `src/index.ts`, new helper/loader, GoalRun, preflight/checker/merge scripts, live launcher |
| TypeBox host resolver plumbing smoke | PASS | A temporary resolver fixture only; not a TypeBox implementation or runtime test |
| Real Pi / provider live acceptance | NOT RUN | No Pi host package or provider runtime is installed in this build container |

Full `npm test` was deliberately not made to use a local or fake TypeBox copy. The new test loader resolves `typebox` from Pi's own package when Pi is installed. In this environment it fails only when `tests/extension.test.mjs` imports the host package; the other 127 tests pass.

Static preflight output includes warnings that pi-subagents, ask-user-questions and Code Mode were not found by this container's filesystem scan. Those warnings are explicitly non-definitive and do not establish runtime absence.

## 3. v0.9.1 changes covered by these checks

- `typebox` is declared as `peerDependencies: { "typebox": "*" }`, not as a runtime dependency.
- `npm ci --omit=peer` leaves no package-local TypeBox copy. Full tests resolve TypeBox through Pi's host module tree using `scripts/register-pi-host-typebox.mjs`.
- Static preflight verifies the peer declaration and rejects a package-local `node_modules/typebox`.
- The exact `pi-subagents` pin is updated to 0.84.0; the supplied 0.84.0 delegation declaration and runtime export match the 0.83.1 baseline.
- `/compass-live-acceptance` no longer assumes the process working directory is the Compass package. It uses the current project if it has the required fixture files, otherwise falls back to the Compass package; an explicit project-root argument is supported.
- Three pure tests cover current-root selection, fallback and explicit-root behavior.

## 4. Required user-side checks

From a fresh extraction of the v0.9.1 package:

```bash
npm ci --ignore-scripts --omit=peer
npm run test:core
npm run test:non-extension
npm test
node scripts/preflight.mjs /path/to/separate-target-project --require-compass
bash scripts/run-live-acceptance.sh
```

The full test suite should now resolve TypeBox from the installed Pi 1.4.0 host. The launcher must pass the 0.84.0 contract and proposed configuration checks before starting isolated Pi. Run `/compass-live-acceptance` in the TUI and require the generated JSON report to say `PASS`.

Also verify that an exact approval authorizes the displayed plan and that partial, declined, or UI-error results do not. Do not claim v0.9.1 live acceptance until the exact package bytes pass those user-side checks.
