# First Live Test — Pi Compass V2 v0.9.1

The user has supplied a read-only contract report from `pi-subagents@0.84.0`. Its public delegation declaration and runtime export are byte-identical to the retained 0.83.1 baseline, and the updated offline contract checker passes. The remaining blocker is the real Pi/provider request-response cycle.

## One-command acceptance

Extract the 0.9.1 package into a directory separate from the active application repository. Do not install it over the working Compass extension. From the extracted package root, run:

```bash
bash scripts/run-live-acceptance.sh
```

The launcher:

1. Checks Node/npm/Pi versions and the installed `pi-subagents` package.
2. Re-runs full/core tests, static preflight, contract checks, and strict configuration checks.
3. Merges both Pi settings and the pi-subagents runtime config into separate mode-0600 temporary proposals; it never edits either original file.
4. Copies only `auth.json` and `models.json` into a private temporary Pi agent directory. The runtime config in that directory is the merged proposal, not a late copy of the original config. The directory is deleted on exit and never added to the evidence archive.
5. Starts Pi with the provider extension, installed `pi-subagents`, and this Compass candidate explicitly loaded.

When the isolated Pi TUI opens, run exactly:

```text
/compass-live-acceptance
```

Wait for PASS/FAIL and the report path, then exit Pi. The acceptance fixture has two independent read-only child tasks, one dependent child, and two non-dispatched `code`/`parent` tasks. It verifies correlated structured results, dependency-gated wave progression, evidence, model IDs, tool calls, usage/cost/duration fields where reported, and that parent/Code Mode tasks remain untouched. It calls the same post-tool-result scheduler handler as normal plan mutations; the fake-Pi suite separately verifies Pi hook registration and non-blocking behavior.

The test makes at least three read-only child model calls; a DeepSeek fallback may add calls. It may incur provider cost. The launcher requires the JSON report itself to say `PASS`; merely writing a report file does not pass acceptance. The command defaults to the current project if it contains `package.json` and `README.md`; otherwise it falls back to the Compass package. An explicit fixture directory can be supplied as `/compass-live-acceptance /path/to/project`.

## Upload

After the launcher exits, it prints a path like:

```text
/tmp/pi-compass-live-evidence-<timestamp>.tar.gz
```

Upload only this evidence bundle. It contains version checks, local test logs, the exact installed contract excerpts, config-check outcomes, a bounded live acceptance report, and a summary. It must not contain `settings.json`, `auth.json`, `models.json`, the temporary agent directory, or Pi session transcripts. The launcher intentionally excludes these.

If the provider extension cannot be resolved automatically, set `PI_PROVIDER_EXTENSION` to its actual extension entry path. If pi-subagents is installed elsewhere, set `PI_SUBAGENTS_ROOT`. If the installed settings use a nonstandard path, set `PI_COMPASS_SETTINGS`. If the extension runtime config is in a nonstandard path, set `PI_COMPASS_SUBAGENTS_CONFIG`.

## What this test does not prove

- A real quota exhaustion is not forced: do not drain a working account just to test fallback. Unit tests exercise explicit quota/rate-limit classification and one-time DeepSeek fallback. If a natural provider quota failure occurs, the live report should show the fallback model and both attempts' usage where available.
- Restart/reconciliation is covered by state-machine tests. A controlled live interruption is a separate follow-up only if basic structured dispatch passes and evidence suggests the host lifecycle differs.
- Runtime drift detection covers observable path-based top-level writes and explicit Human vetoes; it cannot guarantee detection of every semantic deviation or nested Code Mode write.

The RC6 predecessor already ran the real three-child smoke; its false-negative model-label check was independently reconciled using the original task metrics. Re-running this final build is optional additional evidence, and does not alter the original historical report.
