# Pi Compass V2 — 0.10.0

Pi Compass is an agent-only Pi extension for reducing the total cost of completing arbitrary Goals without lowering correctness. It stays inside one Pi session: Pi owns the raw transcript and native projection; Compass owns compact Goal/context control; Code Mode, pi-subagents and pi-await remain the execution authorities.

## What 0.10.0 provides

- Same-session attention frames with explicit `ref`/`copy` capture, scoped values, copy-on-write, versioned source IDs and protocol-safe return/drop/edit operations.
- Qualified retention through native compaction boundaries. Pinned data is user-context data, not system authority; original Human messages and executed calls remain read-only.
- On-demand active/parent/history lexical recovery, source-verified Agent ranking, exact range loads and moves, and verified project-relative artifact spill/reload.
- Explicit Skill retention and `active|handled|retired` handling with Goal/session lifetimes. Failed or truncated reads cannot be activated as complete Skills.
- Human-approved DAGs: exact structured questionnaire correlation, material-change invalidation, evidence-bearing assessments, dependency gating, unknown-run fail-closed behavior, and native structured delegation.
- RouteSets separate from DAGs: explicit route selection, Human-authorized bounded exploration, shared acceptance/caveat comparison, and acceptance-gated competitor cancellation.
- Native watch ownership by arm identity, repeating/lost/terminal lifecycle handling, branch reconciliation, and explicit frame-to-parent transfer.

## Important boundaries

- No second Pi session, transcript store, conventions registry, scheduler, polling observer, or automatic route fan-out.
- Lexical recovery is not semantic scoring. The Agent may rank verified candidates. Repeat analysis and relocation are explicit/on demand, not an always-on optimizer; a subset without a shared native file revision remains unknown.
- Filesystem effects are not rolled back by Compass. Artifact writes report possible orphans if readback or a later native commit fails. Race-safe spill/reload currently requires Linux `/proc/self/fd`; other platforms fail closed rather than use a symlink check/open race.
- Stock Pi 1.5.2 has no general awaited post-compaction canonical-restoration boundary. Compass uses request-side qualified overlays and later existing native boundaries instead of modifying Pi.
- Recursive Compass use inside pi-subagents children is fail-closed because the installed delegation contract does not inherit Compass extensions.
- Local tests use installed Pi projection/runner adapters. Real AgentSession/provider behavior, provider cost/cache behavior, and semantic quality require the separate Human acceptance below.

## Requirements

- Pi: `>=1.5.2` for the current `context_with_system` integration.
- Node.js: `>=22.16.0`.
- TypeBox is supplied by Pi as a peer dependency; Compass must not install a package-local copy.
- pi-subagents, pi-await and ask-user-questions must be installed and enabled by the Human's Pi configuration when those capabilities are used.

## Install

From the target project, run `pi install -l /absolute/path/to/pi-compass` (replace the path with this checkout), then start a fresh Pi session and run `/compass-preflight`. This installs a local Pi package; do not copy Compass source into the target project or overwrite global settings with config proposals.

## Local validation

```bash
npm ci --ignore-scripts --omit=peer
npm run test:core
npm run test:non-extension
npm test
npm run preflight
node scripts/measure-context.mjs
```

See the canonical [local verification results](docs/architecture-v0.10.0.md#final-local-evidence) and [bounded local measurements](docs/measurements-v0.10.0.md). These are not live provider or token evidence.

## Human acceptance

In a disposable Pi session rooted at this package (or an explicit safe fixture project):

1. Run `/compass-preflight` and confirm the active registry and native dependencies.
2. Capture a simple Goal and verify the light loadout remains light.
3. Use `compass_context` for a small `call`/`return`, then search and pin one qualified value. Compact or navigate only through native Pi operations and verify the value remains qualified.
4. In **another fresh disposable session, before capturing any Goal**, run `/compass-live-acceptance` only if provider cost is acceptable. It performs real read-only child work and writes a bounded report under `/tmp`.
5. Inspect the report and session behavior. A local test pass is not a live provider acceptance result.

Do not use a production session for the live acceptance command. It refuses non-empty Goal state, but provider calls and filesystem fixtures still have real effects.

## References

- [`docs/design.md`](./docs/design.md) — ownership and correctness contract.
- [`docs/architecture-v0.10.0.md`](./docs/architecture-v0.10.0.md) — requirement-linked M0–M7 checklist and evidence boundaries.
- [`docs/measurements-v0.10.0.md`](./docs/measurements-v0.10.0.md) — bounded local measurement.
- [`handoff.md`](./handoff.md) — current delivery state and Human feedback path.
- Historical v0.9.x validation and session evidence remain under `docs/validation-v0.9.1.md` and `evidence/`; they are not evidence for the current bytes.
