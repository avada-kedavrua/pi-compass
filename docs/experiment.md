# Field Experiment Protocol — v0.6.0

## Objective

Determine whether Compass lowers the total cost of completing a Goal without lowering quality. Do not optimize for Compass-call count, DAG adoption, Subagent use, or number of verification steps.

## Historical V1 rejection signal

The project history recorded a three-task comparison in which native Pi used 14 tool calls, 135K tokens, and 41.3 seconds, while the then-current full Compass route used 21 calls, 300K tokens, and 77.1 seconds. This is a historical NO-GO signal for that design, not a fresh benchmark or a universal claim about every Goal. It is why v0.6.0 must not add mandatory verification, tool blacklists, forced DAGs, or a second scheduler. Repeat comparisons only with matched Goals, starting state, provider/model, and acceptance requirements.

## Unit of observation

One fresh Pi Session, one Goal, one target project state. Record starting Git commit/dirty tree, Compass version, Pi version, provider/model/thinking level, dependency state, and final deliverable evidence. Do not force a DAG, Subagent, triage, or extra verification for coverage.

## Baseline

The four supplied field traces are summarized in `field-baseline-v0.5.0.md`. Reproduce future counts with:

```bash
node scripts/session-report.mjs /path/to/session.jsonl [other-session.jsonl ...]
```

Metrics include model requests and provider-reported usage, top-level tool calls, nested Code Mode calls logged in tool results, errors/retries, compactions, Compass calls, unchanged state reads, no-op opens, full Goal reads, and a compact final Goal/DAG/acceptance projection. Static nested expressions are not counted as executions.

## v0.6.0 probes

- **Planning availability:** a genuinely multi-part Goal should surface planning operations before edits begin, without creating a DAG or requiring its use. A simple single-file Goal should remain on the light loadout.
- **Outcome classification:** test `not_assessed`, `incomplete`, `blocked`, `failed`, and `agent_reported_satisfied`. No Agent report may be labelled independently verified. A blocked DAG task must keep the overall outcome blocked even if process-oriented criteria are reported pass.
- **Human constraints:** after later preferences/instructions, explicit `Restrictions`/`Constraints` clauses remain pinned and visible in source order.
- **Failure continuity:** one-off errors remain on-demand; repeated matching failures surface a concise signature. The Agent should not be forced into triage or prevented from using native tools.
- **Cost and quality:** compare top-level and nested calls, provider token usage, latency when available, errors/retries, final acceptance evidence, and Human review. Separate Compass errors from target-project/environment errors.
- **Continuity:** check Goal/version, Human directives, decisions, checkpoints, and caveats after compaction and route changes. A bounded history gap must not be presented as complete history.

## Classification rules

A tool error is not automatically wasted work. Classify each as Compass state/schema, model route choice, target-project implementation, external dependency, or environment. If a new issue was caused by a prior edit or decision, determine whether to continue, locally repair, replan, or restore a real checkpoint. No automatic rollback is implied.

## Decision rule

Retain a change only if it improves outcome quality, continuity, or total cost on comparable Goals. If earlier planning visibility increases schema/context cost without improving route choice, narrow or remove the activation heuristic. If a control causes agent/framework conflict, remove the control unless it protects a deterministic invariant or explicit Human constraint.
