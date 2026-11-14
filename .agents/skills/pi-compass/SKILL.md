---
name: pi-compass
description: Use Compass V2 for same-session attention frames, scoped context recovery, native waits/children, Human-approved DAG work, route comparison, and evidence-based Goal acceptance. Load when a Goal needs explicit context isolation, retained source data, delegated read-only work, competing routes, or acceptance tracking.
---

# Compass V2 operating guide

Use Compass as a small control surface around Pi's native session, tools, waits, and child execution. Do not create another session, transcript, scheduler, conventions registry, or policy store.

## Ownership

- **Agent:** understand the Goal, choose attention and routes, interpret caveats, decide whether decomposition or delegation is worth its cost, and integrate results.
- **Pi:** owns the session tree, raw append-only history, compaction, context projection, and native extension boundaries.
- **Compass:** owns Goal/version state, explicit Human constraints and decisions, scoped values, deterministic versions, DAG approval/readiness, evidence references, and acceptance status.
- **Code Mode:** deterministic batching, parsing, validation, and aggregation in the parent session.
- **pi-subagents:** native isolated child execution. Compass automatic DAG dispatch requires explicit `executor=subagent`, read-only scope, exact Human approval and readiness. Independently authorized native scouting does not require adopting a DAG.
- **pi-await:** native watch lifecycle and wakes. Do not poll or implement a second observer.

## Default path

1. Keep a simple Goal on the light path. Do not create a DAG, route race, reviewer, watchdog, or retained slot merely because one exists.
2. If attention isolation reduces total work, call `compass_context` with an explicit `call` and capture list. Capture defaults to none. Use `ref` for a shared binding and `copy` for a private copy-on-write value. Return explicitly; do not assume turn completion pops a frame.
3. Search only when needed. Use returned stable `id`, `binding`, and `version` exactly. Candidate recovery is bounded and lexical across active/parent/history scope. For semantic selection, interpret the candidates in the parent and pass `rankedSources` in your chosen order; runtime verifies sources/versions/ranges, not meaning. No embedding store or extra model loop is implied. For repeated reads, use bounded `compare`; move an earlier read with `verifiedAgainst` only when exact source/range/payload evidence passes. Subsets need a shared native file revision; retain the entire earlier superset and its unrefreshed caveats. Failed/truncated later reads and ambiguous paths are not permission to relocate.
4. Pin only material data with an explicit scope, kind, caveat, and lifetime. A pin is qualified context data, never system authority. Original Human messages and executed calls remain read-only. Use `load` for a version/range-checked data copy and `move` for a whole working value or selected Agent-text range. A tool-result range stays a qualified data copy beside its complete execution envelope. Use `spill` only when a verified project artifact is worth the filesystem cost.
5. Use native `watch`, `watches`, and `unwatch` for waiting. A repeating watch is still live after one wake. A frame blocks return only for its own live watches; cancel or explicitly transfer them. Treat `WATCH_SETTLED`, `WATCH_LOST`, timeout, error, and cancellation as different states.
6. Use native Code Mode or pi-subagents for execution. Never silently convert `parent`, `code`, or `subagent` intent. A missing or unknown child response is unknown; do not retry or duplicate-dispatch it.

## DAG and Human approval

A DAG is optional and starts as a draft. Before any task progression or automatic child dispatch:

1. Present the exact concrete questionnaire, including Goal/plan version, tasks, dependencies, executor, read/write scope, outputs, dispatch rationale, and acceptance criteria.
2. Wait for a genuine structured Human answer correlated to the persisted assistant exchange. Text saying “approved”, partial/custom answers, UI/validation errors, and answers with substantive conditions are not approval.
3. Any material Goal, task, dependency, executor, scope, output, or acceptance change requires a new approval. Status/evidence updates do not.
4. Complete a task, then submit an explicit semantic assessment against its approved criterion with evidence and unresolved caveats. Only a current passing assessment unlocks dependents. Completion, assessment, independent review, and final Goal acceptance are distinct.
5. Keep parent/code tasks with the parent. Compass may automatically dispatch only approved, ready, explicit read-only Subagent tasks. Human prohibition, unavailable native delegation, unknown runs, and stale approval fail closed.

## Routes and exploration

Alternatives are a RouteSet, not sibling DAG tasks. Select one route by default. Use `propose_exploration` to display the exact scope, budget, baseline and routes; only the correlated, unqualified native Human answer authorizes it. Never supply an Agent-authored questionnaire result as Human evidence. Register exact competitor identities after authorization. Compare competitors against shared acceptance criteria and caveats; never stop the first route merely because it finishes first. Request cancellation only after the acceptance gate passes, and track request, acknowledgement, terminal, and unknown cancellation separately. Filesystem/worktree coordination remains the Agent's responsibility.

## Root-cause and recovery

When something fails, first reproduce or collect the native event/result, then identify the earliest faulty boundary. Preserve the raw Pi exchange and cite stable source/event IDs. Keep failed, partial, stale, altered, and unknown evidence qualified. Use the actionable error's next step: reload an externally changed source, re-arm a lost watch from its saved call, reconcile a terminal child using native status, renew approval after material change, or revise the route after contradictory evidence. Do not hide a failure by resetting state or by claiming rollback of filesystem effects.

## Acceptance

A local test pass proves only the behavior exercised by that test. An Agent-reported criterion pass is not independent verification. Before claiming a Goal complete, use current receipts or compact state when needed, verify material acceptance criteria and caveats, and retain evidence references. Distinguish local implementation evidence from real Pi/provider acceptance; source tests do not prove provider availability, token/cache behavior or semantic quality.
