# User-side RC5 evidence review

Evidence bundle: `pi-compass-live-evidence-20261029T033158Z.tar.gz` (uploaded by the user).

Observed results:

- Pi `1.4.0`; Node `v22.22.1`; pi-subagents `0.83.1`.
- Core suite: 82/82 pass.
- Full suite: 176/177 pass. The sole failure is `preflight reports dynamic tool activation and native dependencies`, whose assertion expected `v0.8.0-rc.4 preflight` while runtime output correctly said `Compass v0.8.0-rc.5 preflight`.
- Static preflight passes. Installed pi-subagents contract report check passes 36/36 in that run (the separately rerun bundled report checker passes 37/37).
- Proposed settings and proposed runtime config pass strict checks. Existing settings check fails because the current config is not yet migrated to the candidate policy. The script does not mutate either original config.
- Summary says `Local acceptance blocked; Pi was not started`; therefore there is no real Pi/provider acceptance result in this bundle.

RC6 fixes the stale test by comparing the GoalRun release with the package manifest and by deriving the in-session preflight label from `GOAL_RUN_RELEASE`. The module contract test now also compares to the package manifest. This avoids repeating the same version-bump failure on the next release.
