# Compass v0.10.0 development handoff

## Delivery status

**Implementation is in progress; this is not a release-complete handoff.** The current source aligns its native identity records to the locally inspected Pi `1.5.2` and pi-subagents `0.88.1` baseline. Local package/API inspection is not live acceptance. No provider was called for this work.

The exact human-acceptance boundary is a real interactive Pi/provider run on final committed bytes. Source inspection and local tests show correlated Human approval gating for DAG progression/dispatch and explicit semantic task assessments; this is not proof of the real Human UI or provider lifecycle. The architecture checklist still has unchecked M5 items despite those code paths, so reconcile checklist/evidence before marking them complete. M2 and M3 retain explicitly open requirements. Do not call the work release-ready until remaining implementation, measurement, review and evidence reconciliation in `docs/architecture-v0.10.0.md` are resolved.

## Baseline and evidence

- Local `pi --version`: `1.5.2`.
- Installed package manifest: `pi-subagents@0.88.1`.
- The current contract checker inspects the installed declaration/export/API shape. This proves only the checked source contract, not dispatch, provider behavior, cache behavior, cost, or completion correctness.
- `RELEASE-MANIFEST.json` is the source for current release identity and the expected native versions. No current-milestone test counts are asserted there; historical validation records apply only to their named earlier source bytes.
- No live provider acceptance was run.

## Configuration safety

The proposal merger reads the user's Pi settings and pi-subagents runtime config, preserves unrelated values, and writes separate private proposals. It does not modify global Pi settings. Review both resulting files before any eventual isolated acceptance run; do not copy proposals into global config as part of development validation. The native tool preference remains owned by Pi/user settings.

## Remaining development work

Use `docs/architecture-v0.10.0.md` as the implementation checklist, while reconciling its stale M5 unchecked markers against the implemented approval/assessment paths and their regression tests. Remaining substantive gaps include scoped-retention/retrieval/repeated-result requirements (M2/M3), representative local measurements, and final independent review/reconciliation. Do not mark anything complete because the documentation now names it.

## Eventual Human-only live acceptance

After the missing local implementation and reviews are complete, run the isolated acceptance harness against the exact candidate package in a separate Compass session. It starts an isolated Pi process and can incur provider cost. The expected command is `bash scripts/run-live-acceptance.sh`; in the opened TUI, run `/compass-live-acceptance` and require a passing bounded report. Also perform live structured-questionnaire checks for fully answered, partial, declined and UI/error outcomes. The harness must not overwrite global Pi settings or include credentials/session transcripts in uploaded evidence.

If implementation remains blocked, report the precise gap and do not interpret a blocked preflight or a passing mock/adapter test as runtime acceptance.
