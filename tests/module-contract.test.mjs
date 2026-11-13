import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as goalRun from "../src/goal-run.mjs";

test("GoalRun v7 module exports the complete runtime contract", () => {
  assert.equal(goalRun.GOAL_RUN_API_VERSION, 7);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(goalRun.GOAL_RUN_RELEASE, manifest.version);
  const required = [
    "applyGoalChange", "dismissGoalChangeCandidate", "availableCapabilities", "acceptanceStatus", "goalOutcomeStatus", "planningActivationSignal", "buildGoalAnchor",
    "buildGoalDetails", "buildIssueReview", "buildRecentEvents", "buildStateSnapshot", "stripConventionSections", "triageIssue", "defineAcceptanceCriteria",
    "recordAcceptanceResult", "shouldSurfaceIssueReview", "captureHumanPrompt",
    "captureHumanDecision", "recordHumanQuestionnaireFailure", "emptyGoalRunState",
    "explicitGoalChangeUpdates", "hasUsefulTrace", "mergeTrace", "normalizeGoalRunState",
    "recordCheckpoint", "recordDecision", "recordFailure", "recordWriteTarget", "recordExecutionDrift",
    "revisePlanState", "summarizePlanStatus", "transitionTasks",
    "createRouteSet", "bindRouteSetQuestionnaire", "recordRouteSelection", "proposeRouteExploration", "registerCompetitorRun", "recordCompetitorResult", "selectRoute", "updateCompetitorCancellation", "routeSetStatus",
  ];
  for (const name of required) assert.equal(typeof goalRun[name], "function", `${name} must be exported`);
});
