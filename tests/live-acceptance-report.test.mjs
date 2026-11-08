import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMeta = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const checker = path.join(root, "scripts", "check-live-acceptance-report.mjs");
const requiredChecks = [
  "probe bridge accepted the structured request contract",
  "shared post-tool-result scheduler dispatches without compass_execution",
  "two independent tasks share first parallel wave",
  "dependent task starts in a later wave",
  "child A evidence matches a real safe directory entry",
  "child B evidence confirms actual package metadata",
  "child C evidence confirms README heading after dependencies",
  "Code Mode task remains undispatched",
  "parent task remains undispatched",
  "all three real Subagent tasks completed with evidence",
  "each child reports observed tool activity and a supported model",
  "usage and cost fields preserve known/unknown values",
];
function runReport(report) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compass-live-report-"));
  const reportPath = path.join(dir, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report));
  const result = spawnSync(process.execPath, [checker, "--report", reportPath], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}
function validReport() {
  return {
    schemaVersion: 1,
    compassRelease: packageMeta.version,
    package: { name: packageMeta.name, version: packageMeta.version },
    schedulerTrigger: "shared-post-tool-result-handler",
    explicitCompassExecutionCalls: 0,
    result: "PASS",
    checks: requiredChecks.map((name) => ({ name, pass: true })),
    waves: [
      { requestId: "wave-a", taskIds: ["probe_a", "probe_b"], status: "completed" },
      { requestId: "wave-b", taskIds: ["probe_c"], status: "completed" },
    ],
    taskMetrics: ["probe_a", "probe_b", "probe_c"].map((id) => ({
      id, model: "cliproxyapi/gpt-6-luna:high", toolCalls: 2,
      observedToolCount: 2, observedTools: ["read", "structured_output"], runId: `run-${id}`,
    })),
    taskResults: [
      ...["probe_a", "probe_b", "probe_c"].map((id) => ({ id, status: "done", evidence: `README.md:1 evidence for ${id}` })),
      { id: "probe_code", status: "pending" },
      { id: "probe_parent", status: "pending" },
    ],
  };
}

test("live acceptance report checker requires every real integration assertion and exact release identity", () => {
  const result = runReport(validReport());
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /scheduler trigger verified/);
});

test("live acceptance report checker rejects a report file whose result is FAIL", () => {
  const report = validReport();
  report.result = "FAIL";
  const result = runReport(report);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"result": "FAIL"/);
});

test("live acceptance report checker rejects missing scheduler and dependency checks", () => {
  const report = validReport();
  report.checks = report.checks.filter((check) => check.name !== "shared post-tool-result scheduler dispatches without compass_execution");
  const result = runReport(report);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missingChecks/);
});

test("live report checker accepts provider/model:high and independently validates observed activity", () => {
  const report = validReport();
  assert.equal(runReport(report).status, 0);
  report.taskMetrics[0].model = "cliproxyapi/gpt-6-luna:invented";
  let result = runReport(report);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reportDataConsistent.*false/);
  report.taskMetrics[0].model = "cliproxyapi/gpt-6-luna:high";
  report.taskMetrics[0].observedTools = [];
  report.taskMetrics[0].toolCalls = 0;
  report.taskMetrics[0].observedToolCount = 0;
  result = runReport(report);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reportDataConsistent.*false/);
});
