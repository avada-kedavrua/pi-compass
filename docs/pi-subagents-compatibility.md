# pi-subagents compatibility — 0.9.1

## Installed target

The user-generated 2026-10-31 report identifies the installed package as `pi-subagents@0.84.0`. The package version differs from the v0.9.0 pin (`0.83.1`), but a byte-for-byte comparison of the supplied `src/api/delegation.d.ts` and `bundle/delegation.js` against the retained 0.83.1 baseline found both files identical. The installed-package checker passes 36/36 structural checks after updating the exact package pin; report mode adds a metadata check and passes 37/37. The delegation declaration hash is `66bc1230efb2805da6b3e6e72b3635dc989d135bdeddc9e5a54075e1884fdbfe`; the runtime export hash is `7845d67d61f7cd1290b38f2c2ccddeb92e0f3a53926131e546fcabb772579c5c` for both versions. This establishes the public structured-delegation API shape used by Compass; it does not prove the real Pi/provider request-response cycle.

## Integration choice

Compass uses the public **Structured Delegation API**, not the model-visible `subagent` tool and not a guessed RPC adapter.

Documented event names:

- `prompt-template:subagent:request`
- `prompt-template:subagent:started`
- `prompt-template:subagent:update`
- `prompt-template:subagent:response`
- `prompt-template:subagent:cancel`

The structured request contains `requestId`, `ownerRunId`, `nodeId`, `agent`, `task`, `context`, `cwd`, optional model/thinking/timeout/budgets, and an explicit result schema. A terminal response carries the same identity tuple, terminal status, optional `runId`, effective model, structured result and usage.

Before dispatch, Compass sends one malformed empty-task probe and expects a correlated `invalid_request` response. This verifies that a structured-delegation handler is present without launching a child. If the response does not arrive within 1.5 seconds, the batch remains unlaunched and tasks stay pending. A failed probe is cached for 30 seconds in that extension instance to avoid repeated latency; reloading the extension permits a fresh check.

The `ownerRunId + nodeId` tuple identifies an active logical child; `requestId` identifies one attempt. A second active attempt for the same logical node is rejected as `duplicate_node`. Compass therefore persists the batch identity and each request ID before emitting requests and never retries an unknown run automatically.

## Execution contract

- Requests are emitted from a queued application step/event boundary, not by recursively calling the `subagent` tool from a `tool_call` hook.
- Structured delegation is foreground-only. It is not a replacement for detached workflow RPC.
- Only explicit `executor=subagent`, `writeScope=read-only` tasks with a substantive `dispatchReason` are dispatched. The model-visible native `subagent` tool may remain hidden; structured runtime dispatch uses the event API independently and does not force-enable the native tool. An explicit Human prohibition still wins.
- Each new Subagent task requires a substantive `dispatchReason`; it must explain why the added semantic call is worth its cost. Up to four ready tasks are dispatched in a wave unless measured short-task savings or repeated fallback suggests serializing. Results are consumed by exact request/owner/node correlation.
- `done` requires schema-valid structured output and concrete evidence. Other task results block the DAG dependency.
- One DeepSeek fallback is allowed only after a primary provider quota/rate-limit or availability error. Timeouts, semantic failures and malformed structured output do not trigger fallback.
- Missing response/start acknowledgement or session restart becomes `unknown`; no automatic duplicate launch is allowed. `compass_execution` can reconcile only after native status has been checked.

## Configuration

`config/pi-subagents-settings.v0.84.0.patch.json` pins `npm:pi-subagents@0.84.0`, defaults to `cliproxyapi/gpt-6-luna` with high thinking, uses `cliproxyapi/gpt-6.1-sol` for review roles, and allows `jrt/deepseek-v4.1-flash` for fallback. It contains no `fallbackModels` field and only contains Pi settings-level keys.

Read-only roles have explicit tool allowlists:
- `scout`, `delegate`, `reviewer`, `oracle`: `read`, `grep`, `find`, `ls`
- `researcher`, `evidence-auditor`: `web_search`, `web_fetch`

The fallback is implemented by Compass after a correlated terminal provider failure. It is not delegated to an unsupported pi-subagents config field. The separate `config/pi-subagents-runtime.v0.84.0.json` is merged into `~/.pi/agent/extensions/subagent/config.json`. It caps concurrency at four, per-run child launches at 24, per-session launches at 100, and nesting depth at one. It uses documented runtime keys only; `toolActivation` and `disabledFeatures` are not emitted as global runtime settings.

## Remaining proof

The supplied report confirms the 0.84.0 package identity, export map, event API and exact delegation declaration/runtime body match with 0.83.1. Unit tests use a contract-faithful fake event bus and do not prove a real provider launch. See `docs/first-live-test.md` for the remaining live acceptance step.
