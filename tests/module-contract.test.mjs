import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as goalRun from "../src/goal-run.mjs";

test("GoalRun v8 module exports the complete runtime contract", () => {
  assert.equal(goalRun.GOAL_RUN_API_VERSION, 8);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(goalRun.GOAL_RUN_RELEASE, manifest.version);
  const required = [
    "setGoal", "observeHumanInput", "stateCursor", "availableCapabilities", "acceptanceStatus", "goalOutcomeStatus",
    "buildGoalDetails", "buildIssueReview", "buildRecentEvents", "buildStateSnapshot", "triageIssue", "defineAcceptanceCriteria",
    "recordAcceptanceResult", "shouldSurfaceIssueReview",
    "captureHumanDecision", "recordHumanQuestionnaireFailure", "emptyGoalRunState",
    "hasUsefulTrace", "mergeTrace", "normalizeGoalRunState",
    "recordCheckpoint", "recordDecision", "recordFailure", "recordWriteTarget", "recordExecutionDrift",
    "revisePlanState", "summarizePlanStatus", "transitionTasks",
    "createRouteSet", "bindRouteSetQuestionnaire", "recordRouteSelection", "proposeRouteExploration", "registerCompetitorRun", "recordCompetitorResult", "selectRoute", "updateCompetitorCancellation", "routeSetStatus",
  ];
  for (const name of required) assert.equal(typeof goalRun[name], "function", `${name} must be exported`);
});
