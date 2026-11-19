import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as goalRun from "../src/goal-run.mjs";
import * as toolSchema from "../src/tool-schema.mjs";
import { agentResult } from "../src/compass-result.mjs";

test("Agent JSON contains only the selected payload, never merged internal receipts", () => {
  const payload = { revision: 4, hits: [{ id: "source" }] };
  const result = agentResult(payload, { hits: 1, contextOperation: { private: true } });
  assert.deepEqual(JSON.parse(result.content[0].text), payload);
  assert.equal(result.details.hits, 1);
  assert.equal(result.details.contextOperation.private, true);
});

test("GoalRun reports the current API and release identity", () => {
  assert.equal(goalRun.GOAL_RUN_API_VERSION, 10);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(goalRun.GOAL_RUN_RELEASE, manifest.version);
});

test("Compass exposes exactly the seven fixed tools with closed object schemas", () => {
  const { toolSchemas, COMPASS_TOOL_NAMES } = toolSchema;
  assert.deepEqual(COMPASS_TOOL_NAMES, [
    "compass_goal", "compass_state", "compass_context_search", "compass_context",
    "compass_plan", "compass_acceptance", "runtime_guard",
  ]);
  for (const [name, schema] of Object.entries(toolSchemas)) {
    assert.equal(schema.type, "object", `${name} must be a root object for provider compatibility`);
    assert.equal(schema.additionalProperties, false, `${name} rejects unlisted fields`);
  }
  assert.deepEqual(toolSchemas.compass_goal.properties.action.enum, ["set", "update", "decide", "checkpoint"]);
  assert.deepEqual(toolSchemas.compass_state.properties.view.enum, ["summary", "goal", "plan", "acceptance", "history", "execution", "retained"]);
});
