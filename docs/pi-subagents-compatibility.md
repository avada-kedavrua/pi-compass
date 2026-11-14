# pi-subagents compatibility — current development baseline

## Tested local identity

The inspected local host reports Pi `1.5.2` (`pi --version`) and `pi-subagents@0.88.1` (`/home/avada/.pi/agent/npm/node_modules/pi-subagents/package.json`). The release manifest and proposed package pin target those identities. Earlier `0.84.0`/Pi `1.4.0` references and reports are historical only; they are not evidence for the current source.

The installed `0.88.1` package still exports `./delegation` as `src/api/delegation.d.ts` plus `bundle/delegation.js`, and the contract checker passes all 36 structural checks using the manifest's expected package version. The declarations include the five `prompt-template:subagent:*` events, correlated `requestId` / `ownerRunId` / `nodeId`, structured result requests and terminal statuses used by Compass. This is source/API inspection, not proof of live dispatch or provider behavior.

## Integration boundary

Compass uses the documented Structured Delegation API, not recursive calls to the model-visible `subagent` tool and not a guessed RPC interface. Requests are emitted from a queued application/event boundary. Only explicit, ready `executor=subagent` tasks with `writeScope=read-only` are eligible, and Human prohibition vetoes dispatch. Requests/results retain native identity; unknown outcomes are not automatically retried. Read-only roles receive their configured tool allowlists. Native activation preferences are not changed by Compass.

The API surface remains compatible by structural inspection in 0.88.1, but changed API semantics beyond the checked declaration/runtime surface have not been independently verified. The real Pi/provider request-response cycle remains Human-only acceptance.

## Configuration

`config/pi-subagents-settings.patch.json` contains Pi settings-surface values and the exact `npm:pi-subagents@0.88.1` package pin. `config/pi-subagents-runtime.json` contains extension runtime settings for `~/.pi/agent/extensions/subagent/config.json`. The merger creates private proposals, keeps the two settings surfaces separate, preserves unrelated user configuration and does not modify global settings. The strict checker validates both proposals and checks the installed package identity against `RELEASE-MANIFEST.json`.

The runtime config bounds concurrency and spawn counts, keeps scheduled runs/missions disabled, and retains foreground operation. Compass owns its explicit read-only DAG dispatch; pi-subagents owns child execution and its lifecycle.

## Current implementation boundaries

A locally passing API contract check is not a live run. Pi is 1.5.2 locally, but no provider acceptance has been run for this development source. Local M0–M7 development and scoped review gates are complete for the declared supported boundaries. M5 approval/semantic progression is implemented and locally tested; real Pi/provider acceptance remains open, so this is a local candidate, not a runtime-verified release. See `docs/architecture-v0.10.0.md` and `RELEASE-MANIFEST.json`.
