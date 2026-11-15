# Pi Compass V2 0.9.0 — Validation Record

> Historical v0.9.x record, not current instructions. The old automatic live-test helpers were removed in v0.10; use the [current native acceptance path](../README.md#human-acceptance).

Date: 2026-10-31

## Executed checks

| Check | Result | Evidence |
|---|---|---|
| Core suite | **89/89 PASS** | `npm run test:core` |
| Non-Extension suite | **124/124 PASS** | Explicit Node test command below |
| TypeScript entry syntax | PASS | `node --experimental-strip-types --check src/index.ts` |
| GoalRun module syntax | PASS | `node --check src/goal-run-v0-9-0.mjs` |
| Live launcher shell syntax | PASS | `bash -n scripts/run-live-acceptance.sh` |
| Static preflight package/cursor/module checks | PASS | `node scripts/preflight.mjs /tmp/pi-compass-target-empty --static-only` |
| Static preflight dependency check | **BLOCKED** | TypeBox is declared but not installed |
| Full `npm test` | **124 pass / 1 test file failed to load** | `tests/extension.test.mjs` cannot resolve `node_modules/typebox/index.js` |
| Pi runtime | Not run | No `pi` executable in this build container |
| Live pi-subagents integration | Not run | No Pi runtime/provider environment in this build container |

Non-Extension suite command:

```bash
node --experimental-strip-types --test \
  tests/dag-core.test.mjs \
  tests/goal-run.test.mjs \
  tests/module-contract.test.mjs \
  tests/execution-orchestrator.test.mjs \
  tests/session-report.test.mjs \
  tests/subagents-config.test.mjs \
  tests/write-scope.test.mjs \
  tests/live-acceptance-report.test.mjs \
  tests/questionnaire-integration.test.mjs
```

## Dependency blocker

`package-lock.json` pins the real `typebox@1.4.3` tarball. `node_modules/typebox` is empty. `npm ci --ignore-scripts --no-audit --no-fund` did not complete within the 120-second attempt; no fake TypeBox implementation was introduced. The full suite's only failure is the Extension test file failing during module resolution, before its tests execute. The other 124 tests passed.

Static preflight was run against a separate empty target directory. It passed the package declaration, composite state cursor, GoalRun API v7/module release contract, target separation, Node and npm checks. It exited nonzero because TypeBox is absent; it skipped Pi CLI under `--static-only`. Missing filesystem scans for pi-subagents, ask-user-questions and Code Mode are warnings only and are not definitive runtime capability checks.

## Runtime evidence boundary

The v0.8.0 RC6 live evidence is inherited, not rerun. It demonstrates the predecessor's Pi 1.4.0 + pi-subagents 0.83.1 structured-delegation path. It does not establish that the exact v0.9.0 source hash loads, that the new questionnaire middleware works in live Pi, or that provider fallback works under real quota/transport failures.

The v0.9.0 `tool_result` middleware uses Pi 1.4.0's documented result-patching contract to prefix questionnaire UI/validation errors with an explicit no-Human-answer/not-a-decline classification, preserve the extension's original diagnostic content, and mark the result as a tool error before `tool_execution_end`. The pure transformation and GoalRun capture behavior are unit-tested. The end-to-end Extension hook test is present but could not run without TypeBox and Pi.

## Required user-side acceptance

From the extracted v0.9.0 package in a directory separate from the target project:

```bash
npm ci --ignore-scripts
npm test
node scripts/preflight.mjs /path/to/separate-target-project --require-compass
bash scripts/run-live-acceptance.sh
```

After the isolated Pi session opens, run `/compass-live-acceptance`. The generated report must say `PASS`. Then run a focused questionnaire check:

1. Submit a fully answered questionnaire and confirm the Goal anchor/details preserve structured choices and notes.
2. Submit a partial questionnaire and confirm unanswered indexes remain distinct from accepted answers.
3. Cancel a questionnaire and confirm it is recorded as a Human decline.
4. Trigger a non-interactive/validation failure and confirm the model sees `Questionnaire unavailable (...)`, not `User declined to answer questions`; GoalRun records `human_questionnaire_error`, not a Human decision or generic duplicate failure.

Do not claim v0.9.0 live acceptance until these checks pass on the exact package bytes.
