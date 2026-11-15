import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeSession, formatReport } from "../scripts/session-report.mjs";
import { createGoalState } from "./helpers/goal-state.mjs";

test("session report distinguishes top-level calls, logged nested calls, errors, and usage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compass-session-report-"));
  const file = path.join(dir, "sample.jsonl");
  const goalState = createGoalState("Sample report");
  const records = [
    { type: "session", id: "sample-session", timestamp: "2026-10-26T00:00:00.000Z" },
    { type: "custom", customType: "pi-compass-v2.goalrun", data: goalState, timestamp: "2026-10-26T00:00:00.500Z" },
    { type: "message", timestamp: "2026-10-26T00:00:01.000Z", message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, reasoning: 5, totalTokens: 150, cost: { total: 0.01 } }, content: [{ type: "toolCall", name: "codemode" }, { type: "toolCall", name: "compass_state" }] } },
    { type: "message", timestamp: "2026-10-26T00:00:02.000Z", message: { role: "toolResult", toolName: "codemode", content: [{ type: "text", text: "ok" }] }, nestedCalls: { calls: [{ id: "call/1", name: "compass_plan_status", status: "ok" }] } },
    { type: "message", timestamp: "2026-10-26T00:00:03.000Z", message: { role: "toolResult", toolName: "compass_state", details: { unchanged: true }, content: [{ type: "text", text: "unchanged" }] } },
    { type: "message", timestamp: "2026-10-26T00:00:04.000Z", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "exit 1" }] } },
    { type: "message", timestamp: 1793028435898, message: { role: "assistant", provider: "cliproxyapi", model: "gpt-test", stopReason: "error", errorMessage: "response headers timed out", durationMs: 300000, diagnostics: [{ type: "provider_transport_failure", details: { phase: "before_message_stream_start", requestBytes: 1000000 } }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, content: [] } },
  ];
  fs.writeFileSync(file, records.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const summary = await analyzeSession(file);
  assert.equal(summary.records, 7);
  assert.equal(summary.goalStateRecords, 1);
  assert.equal(summary.goalStateBytes, Buffer.byteLength(JSON.stringify(goalState)));
  assert.deepEqual(summary.context, { callsByAction: {}, queued: 0, messagesByAction: {}, rejectedBoundaries: 0 });
  assert.equal(summary.finalState.outcome.status, "not_assessed");
  assert.equal(summary.assistantRequests, 2);
  assert.equal(summary.assistantRequestErrors, 1);
  assert.equal(summary.requestErrorDurationMs, 300000);
  assert.equal(summary.requestErrorDurationSeconds, 300);
  assert.equal(summary.assistantRequestErrorsByProviderModel["cliproxyapi/gpt-test"], 1);
  assert.equal(summary.requestErrorExamples[0].phase, "before_message_stream_start");
  assert.equal(summary.startedAt, "2026-10-26T00:00:00.000Z");
  assert.equal(summary.elapsedSeconds, Math.round((1793028435898 - Date.parse("2026-10-26T00:00:00.000Z")) / 1000));
  assert.equal(summary.topLevelToolCalls, 2);
  assert.equal(summary.nestedToolCalls, 1);
  assert.equal(summary.totalToolCallsIncludingLoggedNested, 3);
  assert.equal(summary.compassTopLevelCalls, 1);
  assert.equal(summary.compassNestedCalls, 1);
  assert.equal(summary.topLevelErrors, 1);
  assert.equal(summary.unchangedStateReads, 1);
  assert.equal(summary.usage.totalTokens, 150);
  assert.equal(summary.usage.cost, 0.01);
  assert.match(formatReport([summary]), /Total logged calls/);
  assert.match(formatReport([summary]), /Final Goal outcome/);
  assert.match(formatReport([summary]), /Model request errors/);
  assert.match(formatReport([summary]), /response headers timed out/);
  fs.rmSync(dir, { recursive: true, force: true });
});
