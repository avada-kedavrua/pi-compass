# Pi Compass V2 — 0.10.0

Pi Compass is an agent-only Pi extension for reducing the total cost of completing arbitrary Goals without lowering correctness. It stays inside one Pi session: Pi owns the raw transcript and native projection; Compass owns compact Goal/context control; Code Mode, pi-subagents and pi-await remain the execution authorities.

## What 0.10.0 provides

- Agent-owned semantic Goals through explicit `compass_goal`: native Human source references, versioned updates, declared constraints and optional acceptance. No prose classifier, Goal-change candidate registry or duplicate transcript.
- Same-session attention frames with explicit `ref`/`copy` capture, scoped values, copy-on-write, versioned source IDs and protocol-safe return/drop/edit operations.
- Qualified retention through native compaction boundaries. Pinned data is user-context data, not system authority; original Human messages and executed calls remain read-only.
- On-demand active/parent/history lexical recovery, source-verified Agent ranking, exact range loads and moves, and verified project-relative artifact spill/reload.
- Explicit Skill retention and `active|handled|retired` handling with Goal/session lifetimes. Failed or truncated reads cannot be activated as complete Skills.
- Human-approved DAGs: exact structured questionnaire correlation, material-change invalidation, evidence-bearing assessments, dependency gating, unknown-run fail-closed behavior, and native structured delegation.
- Native watch ownership by arm identity, repeating/lost/terminal lifecycle handling, branch reconciliation, and explicit frame-to-parent transfer.
- Optional `runtime_guard`: Agent-written pure JS checks with scoped IDs/CAS revisions, session branch recovery, shared global/local definitions, result-preserving warnings and pre-execution blocks at the native tool_call observation point.

The [field-use audit and resolved TODOs](docs/agent-usage-audit-v0.10.0.md) records the first real task’s overhead, failures, fixes and remaining unknowns. It does not claim measured net savings from a single uncontrolled session.

## Important boundaries

- No second Pi session, transcript store, conventions registry, scheduler, or polling observer.
- Lexical recovery is not semantic scoring. The Agent may rank verified candidates. Repeat analysis and relocation are explicit/on demand, not an always-on optimizer; a subset without a shared native file revision remains unknown.
- Filesystem effects are not rolled back by Compass. Artifact writes report possible orphans if readback or a later native commit fails. Race-safe spill/reload currently requires Linux `/proc/self/fd`; other platforms fail closed rather than use a symlink check/open race.
- Stock Pi 1.5.2 has no general awaited post-compaction canonical-restoration boundary. Compass uses request-side qualified overlays and later existing native boundaries instead of modifying Pi.
- Recursive Compass use inside pi-subagents children is fail-closed because the installed delegation contract does not inherit Compass extensions.
- Local tests use installed Pi projection/runner adapters. Real AgentSession/provider behavior, provider cost/cache behavior, and semantic quality require the separate Human acceptance below.

## Requirements

- Pi: `>=1.5.2` for the current `context_with_system` integration.
- Node.js: `>=22.19.0`. Install the pinned public Code Mode runtime dependency; TypeBox still comes only from Pi.
- TypeBox is supplied by Pi as a peer dependency; Compass must not install a package-local copy.
- pi-subagents, pi-await and ask-user-questions must be installed and enabled by the Human's Pi configuration when those capabilities are used.

## Install

From the target project, run `pi install -l /absolute/path/to/pi-compass` (replace the path with this checkout), then start a fresh Pi session and run `/compass-preflight`. GoalRun schema v10/context v5 are current-only; old snapshots fail visibly rather than migrating or resetting. This installs a local Pi package; do not copy Compass source into the target project or overwrite global settings with config proposals.

### Tool missing?

Seeing the Compass Skill or starting Pi in this repository does not load `src/index.ts`. For a single invocation without changing settings, use `pi -e /absolute/path/to/pi-compass`, then `/compass-preflight`. If the package is already declared, grant project trust and `/reload`, checking any load error. All seven fixed tools (`compass_goal`, `compass_state`, `compass_context_search`, `compass_context`, `compass_plan`, `compass_acceptance`, `runtime_guard`) are registered at factory startup; nothing is opened or loaded. `compass_context_search` is discoverable/callable in Code Mode; `compass_context` is model-only and stays directly declared even in Code Mode-only mode. Compass is not inherited by child sessions.

Context mutations now use flat actions (`compass_context({action,...})`); reload the current schemas before testing. For example, read-only recovery in Code Mode:

```js
const result = JSON.parse(await tools.compass_context_search({query:"material constraint"}));
text(result);
```

Mutations remain direct standalone calls; copy source refs unchanged, without binding/version/revision plumbing. Prefer `remember` for short qualified conclusions; `pin` retains full originals. Do not batch mutations in Code Mode. The old argument forms are not accepted. See the [consumer contract](docs/tool-contract.md#context-find-remember-then-optionally-edit).

Full preflight additionally exercises the real native loader/factory and guard Worker/SQLite in a disposable profile without test SDK aliases. `/compass-preflight` checks readable guard state in the running session, not just controller registration. Neither requests a provider turn.

## Runtime guards

Use `runtime_guard({operation:{action:"get"}})` once to recover scope revisions. Put a worthwhile mechanical check under a stable ID, then reuse its mutation receipt to refine/remove it. No Goal or DAG is required. `warn` keeps normal results intact; `block` prevents the observed call and returns a short native error. Source/cases are fetched only with get+id.

The Human-approved coverage is native `tool_call` inputs, including Code Mode nested tools—not post-plugin final parameters, independent children or arbitrary OS actions. Rules do not auto-compile from Human text. See the [execution contract and runnable rule example](docs/runtime-guards-design.md); stateful device cooldowns are not supported by this version.

## Local validation

```bash
npm ci --ignore-scripts --omit=peer
npm run test:core
npm run test:non-extension
npm test
npm run preflight
node scripts/measure-context.mjs
node scripts/measure-runtime-guards.mjs
```

See the canonical [local verification results](docs/architecture-v0.10.0.md#final-local-evidence) and [bounded local measurements](docs/measurements-v0.10.0.md). These are not live provider or token evidence.

## Human acceptance

After the Agent clears the [delivery gate](AGENTS.md#delivery-gate--agent-first), use a disposable Pi session rooted at this package (or an explicit safe fixture project):

1. Run `/compass-preflight` and confirm the active registry and native dependencies.
2. Ask the Agent to record a simple semantic Goal via `compass_goal`; verify a DAG is not required. Send a clarification: raw text must not replace the Goal. The Agent explicitly reviews/reaffirms or updates it.
3. Use `compass_context` for a small `call`/`return`. Check the footer changes between `frame: root` and the committed frame identity, then recover a source with `compass_context_search` and pin it with `compass_context`. Compact or navigate only through native Pi operations and verify the value remains qualified.
4. Only when provider cost is acceptable, ask the Agent to create a small read-only DAG: two independent inspections and a third depending on both. Verify that partial, modified, declined and UI-error answers do not authorize work. Review and approve the exact proposal. The Agent must assess prerequisite evidence before the dependent task starts; parent/Code Mode work stays with the parent.
5. In the disposable session, register the [session-scoped guard example](docs/runtime-guards-design.md#注册并使用一条规则). Trigger warn and block, including a nested Code Mode call that discards its result; verify the parent still gets feedback. Change/remove the same ID with the returned scope revision. Global/local tests affect the profile and should use an isolated disposable profile.
6. Inspect actual native child identities, task evidence, assessments and unknown/stale handling. Export a redacted report with `node scripts/session-report.mjs <session.jsonl> --json`. A local test pass is not live provider acceptance.

Use a disposable session/project: provider calls and filesystem effects remain real. For feedback, include the action, expected and actual behavior, versions, and relevant frame/source/watch/run IDs. Redact secrets and private transcript content. Acceptance uses the ordinary Agent and native paths, not a synthetic dispatch bypass.

## References

- [`docs/design.md`](./docs/design.md) — ownership and correctness contract.
- [`docs/architecture-v0.10.0.md`](./docs/architecture-v0.10.0.md) — requirement-linked M0–M7 checklist and evidence boundaries.
- [`docs/measurements-v0.10.0.md`](./docs/measurements-v0.10.0.md) — bounded local measurement.
- Historical v0.9.x validation and session evidence remain under `docs/validation-v0.9.1.md` and `evidence/`; they are not evidence for the current bytes.
