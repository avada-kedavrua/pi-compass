#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FALLBACK_MODEL, PRIMARY_MODEL, isSupportedDelegatedModel } from "../src/execution-orchestrator.mjs";

const args = process.argv.slice(2);
const option = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const reportPath = option("--report");
if (!reportPath) {
  console.error("Usage: node scripts/check-live-acceptance-report.mjs --report /tmp/pi-compass-live-evidence-*/live-acceptance.json");
  process.exit(2);
}
let report;
try { report = JSON.parse(fs.readFileSync(path.resolve(reportPath), "utf8")); }
catch (error) {
  console.error(`Cannot read valid live acceptance report: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let manifest;
try { manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); }
catch { manifest = null; }
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
const checks = Array.isArray(report.checks) ? report.checks : [];
const names = new Set(checks.map((check) => check?.name));
const missing = requiredChecks.filter((name) => !names.has(name));
const failed = checks.filter((check) => check?.pass !== true).map((check) => check?.name || "unnamed check");
// Independently check the bounded observable fields, not only the reporter's
// boolean check flags. The accepted model label may have a documented effort
// suffix (e.g., cliproxyapi/gpt-6-luna:high) in real pi-subagents 0.84.0.
const metrics = Array.isArray(report.taskMetrics) ? report.taskMetrics : [];
const results = Array.isArray(report.taskResults) ? report.taskResults : [];
const waves = Array.isArray(report.waves) ? report.waves : [];
const childIds = ["probe_a", "probe_b", "probe_c"];
const metricsById = new Map(metrics.map((item) => [item?.id, item]));
const resultsById = new Map(results.map((item) => [item?.id, item]));
const requiredDataOk = metrics.length === 3 && new Set(metrics.map((item) => item?.id)).size === 3
  && childIds.every((id) => {
    const metric = metricsById.get(id);
    const result = resultsById.get(id);
    const observed = Array.isArray(metric?.observedTools) && metric.observedTools.length > 0
      || Number.isFinite(metric?.observedToolCount) && metric.observedToolCount > 0
      || Number.isFinite(metric?.toolCalls) && metric.toolCalls > 0;
    return Boolean(metric && result && result.status === "done"
      && typeof result.evidence === "string" && result.evidence.trim()
      && observed && typeof metric.runId === "string" && metric.runId.trim()
      && isSupportedDelegatedModel(metric.model, [PRIMARY_MODEL, FALLBACK_MODEL]));
  })
  && waves.length === 2
  && Array.isArray(waves[0]?.taskIds) && waves[0].taskIds.length === 2
  && ["probe_a", "probe_b"].every((id) => waves[0].taskIds.includes(id))
  && Array.isArray(waves[1]?.taskIds) && waves[1].taskIds.length === 1 && waves[1].taskIds[0] === "probe_c"
  && waves[0].requestId !== waves[1].requestId
  && ["probe_code", "probe_parent"].every((id) => resultsById.get(id)?.status === "pending");
const identityOk = report.schemaVersion === 1
  && report.result === "PASS"
  && typeof report.compassRelease === "string"
  && report.compassRelease === manifest?.version
  && report.package?.name === manifest?.name
  && report.package?.version === manifest?.version
  && report.schedulerTrigger === "shared-post-tool-result-handler"
  && report.explicitCompassExecutionCalls === 0
  && checks.length >= requiredChecks.length;
if (!identityOk || !requiredDataOk || missing.length || failed.length) {
  console.error(JSON.stringify({
    result: report.result ?? "invalid",
    reportRelease: report.compassRelease ?? null,
    packageRelease: manifest?.version ?? null,
    reportPackage: report.package ?? null,
    schedulerTrigger: report.schedulerTrigger ?? null,
    explicitCompassExecutionCalls: report.explicitCompassExecutionCalls ?? null,
    missingChecks: missing,
    failedChecks: failed,
    reportDataConsistent: requiredDataOk,
  }, null, 2));
  process.exit(1);
}
console.log(`PASS live acceptance report: ${report.compassRelease}; ${checks.length} checks passed; scheduler trigger verified; no compass_execution dispatch call.`);
