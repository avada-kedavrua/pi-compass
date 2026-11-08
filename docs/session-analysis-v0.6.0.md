# v0.6.0 — Root-Cause Review and Change Rationale

## Objective

The target is lower total cost for arbitrary Goals without lower delivery quality. The version is not considered successful merely because it has more Compass calls or more tests. DeepSeekHarness, Prove2Me, and Messages remain a unified design: efficiency, evidence-constrained correctness, and continuity with caveats.

## Historical V1 failure evidence

Project history records a three-task comparison: native Pi used 14 tool calls, 135K tokens, and 41.3 seconds; the then-current full Compass route used 21 calls, 300K tokens, and 77.1 seconds. That is a historical NO-GO signal for the V1 control design, not a fresh benchmark from this build. The design lesson is concrete: mandatory verification after every step can deadlock; framework-generated tool bans cause workaround loops; and a second control plane can add more calls/context than it saves. v0.6.0 therefore limits hard enforcement to deterministic state/schema/dependency invariants and preserves Agent route/tool choice.

## Reproducible baseline

The four supplied JSONLs were reprocessed using `scripts/session-report.mjs`. The earlier apparent disagreement about 1,803 calls came from counting only top-level calls in one pass:

- Top-level Pi tool calls: 1,759.
- Nested Code Mode calls explicitly recorded in tool results: 44.
- Total logged calls: 1,803.
- Top-level error results: 74; logged nested errors: 2; combined: 76.
- Compass calls: 134 top-level + 18 nested = 152.
- Compass errors: 10 top-level + 1 nested `compass_plan_revise` = 11.
- Provider-reported tokens: 167,426,643 total, including 129,094,528 cache reads. Reported costs are not comparable across the four sessions because most costs are zero/unreported.

This is descriptive baseline data, not causal proof that Compass is responsible for all observed context/token usage. The exact installed package cannot be cryptographically proven from these logs because no archive hash is recorded.

See `field-baseline-v0.5.0.md` for per-session counts and tool/error breakdowns.

## Root cause 1: availability was late or ignored on complex Goals

`dispatch` contains a multi-part safety Goal with explicit numbered requirements but made zero Compass calls. v0.5.1's planning activation primarily depended on three distinct write targets, so planning was surfaced only after work had already begun. Conditional language alone did not ensure the tools were visible at the first useful decision point.

**v0.6.0 change:** explicit numbered multi-part Goals and clear multi-stage/multi-workstream signals surface planning operations during Goal capture. This only changes availability. It never creates a DAG, forces a planning call, or gates native tools. The three-write fallback remains. Simple Goals keep the default light loadout.

**Hypothesis to test:** earlier visibility improves route selection for genuinely complex Goals. **Risk:** planning schemas enter context earlier even if unused. The field test must measure both adoption and cost; if context/schema cost rises without better outcomes, narrow or remove the heuristic.

## Root cause 2: acceptance status did not provide one authoritative outcome classification

v0.5.1 surfaced acceptance and DAG status and warned about the known `reported_satisfied + blocked task` case. But clients still had to combine several fields themselves, and the same status language was spread across anchor, state snapshot, plan status, and acceptance status.

**v0.6.0 change:** `goalOutcomeStatus` computes a single structured classification:

- `not_assessed`: no acceptance criteria and no unresolved DAG work.
- `incomplete`: acceptance criteria or tasks remain unresolved.
- `blocked`: an acceptance criterion or DAG task is blocked.
- `failed`: a current Goal criterion is recorded failed.
- `agent_reported_satisfied`: all criteria are Agent-reported pass and no DAG task remains unfinished.
- `no_goal`: no active Goal.

Every result includes `independentlyVerified: false`. This is a classification of recorded evidence, not a verifier. The status is exposed through the anchor, `compass_state`, `compass_plan_status`, and acceptance-status results. Task closure is still not Goal acceptance.

## Root cause 3: compact context prioritized ranked directives over explicit source constraints

Pinned clauses from `Restrictions`/`Constraints` were retained, but the anchor used a global priority score and showed only a subset. The dispatch prompt used the Chinese heading `硬性限制`, which was not recognized as an explicit pinned-section heading by the previous parser; those clauses could therefore be ranked behind later hard-sounding instructions. This allowed some pinned constraints to be hidden behind later high-scoring hard instructions in the compact view.

**v0.6.0 change:** explicit English `Restrictions`/`Constraints` and Chinese `硬性限制`/`硬性约束` clauses are pinned, as are numbered Goal requirements that contain explicit hard language. They preserve source order and appear before later hard-sounding instructions; ordinary numbered workflow steps are not pinned merely because they are numbered. The compact anchor prioritizes Goal/outcome, pinned constraints, actual DAG state/blockers, then decision/checkpoint/failure and secondary preferences. Full source text remains available in Goal details.

## Root cause 4: failure continuity must not become context pollution

The earlier design correctly kept one-off failures on-demand, because most errors in the field traces were target-project edits, shell/tooling problems, or environment outcomes rather than Compass defects. But the anchor's repeated-failure warning did not show the actual signature needed to avoid a blind retry.

**v0.6.0 change:** a single failure stays out of the anchor. When the existing repeated-signature detector triggers, the anchor includes a short timestamp/tool/error observation. It remains labelled an observation, not a diagnosis; the Agent chooses whether to retry, change route, or consult history.

## Root cause 5: framework-generated control can fight the Agent

The user's rejected V1 patterns remain binding constraints: mandatory verification after every step caused deadlock; hard tool bans caused workaround loops; forced workflows increased calls and context pollution. v0.6.0 explicitly states that Compass adds no native-tool blacklist or universal step sequence. It does not force DAG, Subagents, triage, or a verification ritual. Deterministic runtime checks remain strict where correctness requires them: dependency readiness, state versions, Schema validity, mutation atomicity, cursor consistency, and honest outcome labels.

## Measurement improvement

The bundled `scripts/session-report.mjs` makes the baseline reproducible and separates top-level tool calls from nested calls actually logged in tool results. It also reports provider usage, compactions, unchanged state reads, no-op capability opens, and full Goal reads. Static `tools.*` expressions are not counted as executions. This avoids repeating the earlier confusion between 1,759 top-level calls and 1,803 total logged calls.

## Verification boundary

- Full tests: 118/118 passed in the local container.
- The package includes the baseline and the exact analyzer used to produce it.
- The build container has no Pi CLI. Real Pi 1.3.0 runtime acceptance remains pending.
- The next live test must compare a multi-part Goal and a simple Goal, and measure the cost of earlier planning visibility as well as its effect on useful planning adoption.
