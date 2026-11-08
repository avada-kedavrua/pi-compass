#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { normalizeGoalRunState, goalOutcomeStatus, acceptanceStatus } from "../src/goal-run-v0-9-0.mjs";

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const addCount = (map, key, amount = 1) => { map[key] = (map[key] ?? 0) + amount; };

function createSummary(file) {
  return {
    file: path.basename(file),
    records: 0,
    recordTypes: {},
    sessionId: null,
    startedAt: null,
    endedAt: null,
    elapsedSeconds: null,
    compactions: 0,
    assistantRequests: 0,
    assistantRequestErrors: 0,
    assistantRequestErrorsByProviderModel: {},
    requestErrorDurationMs: 0,
    maxRequestErrorDurationMs: 0,
    requestErrorExamples: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 },
    topLevelToolCalls: 0,
    topLevelTools: {},
    topLevelErrors: 0,
    topLevelErrorsByTool: {},
    nestedToolCalls: 0,
    nestedTools: {},
    nestedErrors: 0,
    nestedErrorsByTool: {},
    compassTopLevelCalls: 0,
    compassNestedCalls: 0,
    compassTopLevelErrors: 0,
    compassNestedErrors: 0,
    codemodeCalls: 0,
    unchangedStateReads: 0,
    noOpCapabilityOpens: 0,
    fullGoalReads: 0,
    goalStateRecords: 0,
    finalState: null,
    malformedLines: 0,
  };
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value;       // Unix milliseconds (Pi JSONL)
    if (value > 1e9) return value * 1000; // Unix seconds
    return Number.NaN;
  }
  if (typeof value !== "string" || !value.trim()) return Number.NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return timestampMs(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
function isoTimestamp(value) {
  const ms = timestampMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function updateTime(summary, value) {
  const date = timestampMs(value);
  if (!Number.isFinite(date)) return;
  if (summary._firstMs === undefined || date < summary._firstMs) summary._firstMs = date;
  if (summary._lastMs === undefined || date > summary._lastMs) summary._lastMs = date;
}

function nestedCallsFor(record, message) {
  const direct = record?.nestedCalls?.calls ?? message?.nestedCalls?.calls;
  if (Array.isArray(direct) && direct.length) return direct;
  const fallback = message?.details?.calls;
  return Array.isArray(fallback) ? fallback : [];
}

function compactGoalState(raw) {
  const state = normalizeGoalRunState(raw);
  if (!state.goal.current) return { hasGoal: false, stateRevision: state.stateRevision ?? 0, goalVersion: state.goal.version ?? 1, outcome: goalOutcomeStatus(state) };
  const acceptance = acceptanceStatus(state);
  const tasks = Array.isArray(state.plan?.tasks) ? state.plan.tasks : [];
  const currentCriteria = (state.goal.criteria ?? []).filter((item) => item.goalVersion === (state.goal.version ?? 1));
  return {
    hasGoal: true,
    goalVersion: state.goal.version ?? 1,
    stateRevision: state.stateRevision ?? 0,
    goalChars: String(state.goal.current).length,
    goalDiffersFromOriginal: state.goal.current !== state.goal.original,
    activeCapabilities: Array.isArray(state.activeCapabilities) ? [...state.activeCapabilities] : [],
    plan: tasks.length ? {
      total: tasks.length,
      done: tasks.filter((task) => task.status === "done").length,
      inProgress: tasks.filter((task) => task.status === "in_progress").length,
      blocked: tasks.filter((task) => task.status === "blocked").length,
      remaining: tasks.filter((task) => task.status !== "done").length,
    } : null,
    acceptance: {
      status: acceptance.status,
      total: acceptance.total,
      reportedPass: acceptance.passed,
      failed: acceptance.failed,
      blocked: acceptance.blocked,
      unverified: acceptance.unverified,
      currentCriteria: currentCriteria.length,
    },
    outcome: goalOutcomeStatus(state),
    trace: { failures: state.trace?.failures?.length ?? 0, writes: state.trace?.writes?.length ?? 0 },
    latestEventSeq: Math.max(0, (state.eventSeq ?? 1) - 1),
  };
}

function resultText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean).join("\n");
}

export async function analyzeSession(file) {
  const summary = createSummary(file);
  const seenNested = new Set();
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { summary.malformedLines += 1; continue; }
    summary.records += 1;
    addCount(summary.recordTypes, String(record.type ?? "unknown"));
    updateTime(summary, record.timestamp);
    if (record.type === "session") {
      summary.sessionId = record.id ?? null;
      summary.startedAt = isoTimestamp(record.timestamp);
    }
    if (record.type === "compaction") summary.compactions += 1;

    let rawGoalState = null;
    if (record.type === "custom" && record.customType === "pi-compass-v2.goalrun" && isRecord(record.data)) rawGoalState = record.data;
    if (record.type === "custom_message" && record.customType === "pi-compass-v2.goalrun-state" && typeof record.content === "string") {
      try { rawGoalState = JSON.parse(record.content); } catch { /* not a valid state snapshot */ }
    }
    if (isRecord(rawGoalState) && [2, 3, 4, 5, 6, 7].includes(rawGoalState.schemaVersion)) {
      summary.goalStateRecords += 1;
      summary.finalState = compactGoalState(rawGoalState);
    }

    const message = isRecord(record.message) ? record.message : null;
    if (!message) continue;
    if (message.role === "assistant") {
      summary.assistantRequests += 1;
      const usage = isRecord(message.usage) ? message.usage : null;
      if (usage) {
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]) {
          summary.usage[key] += Number(usage[key]) || 0;
        }
        summary.usage.cost += Number(usage.cost?.total ?? usage.cost ?? 0) || 0;
      }
      if (String(message.stopReason ?? "").toLowerCase() === "error" || message.errorMessage || message.error) {
        summary.assistantRequestErrors += 1;
        const providerModel = `${message.provider ?? "unknown-provider"}/${message.model ?? "unknown-model"}`;
        addCount(summary.assistantRequestErrorsByProviderModel, providerModel);
        const duration = Math.max(0, Number(message.durationMs) || 0);
        summary.requestErrorDurationMs += duration;
        summary.maxRequestErrorDurationMs = Math.max(summary.maxRequestErrorDurationMs, duration);
        const diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics : [];
        const firstDiagnostic = diagnostics.find((item) => item && (item.error || item.details || item.type));
        const diagnosticError = firstDiagnostic?.error?.message || firstDiagnostic?.error?.name || "";
        const phase = firstDiagnostic?.details?.phase || firstDiagnostic?.type || null;
        const requestBytes = Number(firstDiagnostic?.details?.requestBytes) || null;
        summary.requestErrorExamples.push({
          providerModel,
          durationMs: duration,
          error: String(message.errorMessage || message.error || diagnosticError || message.stopReason || "unknown request error").slice(0, 260),
          phase,
          requestBytes,
        });
        summary.requestErrorExamples.sort((a, b) => b.durationMs - a.durationMs);
        summary.requestErrorExamples = summary.requestErrorExamples.slice(0, 8);
      }
      for (const item of Array.isArray(message.content) ? message.content : []) {
        if (item?.type !== "toolCall") continue;
        const name = String(item.name ?? "unknown");
        summary.topLevelToolCalls += 1;
        addCount(summary.topLevelTools, name);
        if (name === "codemode") summary.codemodeCalls += 1;
        if (name.startsWith("compass_")) summary.compassTopLevelCalls += 1;
      }
    }
    if (message.role !== "toolResult") continue;
    const name = String(message.toolName ?? "unknown");
    if (message.isError === true) {
      summary.topLevelErrors += 1;
      addCount(summary.topLevelErrorsByTool, name);
      if (name.startsWith("compass_")) summary.compassTopLevelErrors += 1;
    }
    const text = resultText(message);
    if (name === "compass_state") {
      let unchanged = message.details?.unchanged === true;
      if (!unchanged) {
        try { unchanged = JSON.parse(text).unchanged === true; } catch { /* text is not JSON */ }
      }
      if (unchanged) summary.unchangedStateReads += 1;
    }
    if (name === "compass_open" && /already loaded|already active|no-op|no new capability/i.test(text)) summary.noOpCapabilityOpens += 1;
    if (name === "compass_goal_read") summary.fullGoalReads += 1;

    for (const call of nestedCallsFor(record, message)) {
      const callId = String(call?.id ?? "");
      if (callId && seenNested.has(callId)) continue;
      if (callId) seenNested.add(callId);
      const nestedName = String(call?.name ?? "unknown");
      summary.nestedToolCalls += 1;
      addCount(summary.nestedTools, nestedName);
      if (nestedName.startsWith("compass_")) summary.compassNestedCalls += 1;
      if (String(call?.status ?? "").toLowerCase() === "error" || call?.isError === true) {
        summary.nestedErrors += 1;
        addCount(summary.nestedErrorsByTool, nestedName);
        if (nestedName.startsWith("compass_")) summary.compassNestedErrors += 1;
      }
    }
  }
  summary.endedAt = summary._lastMs !== undefined ? new Date(summary._lastMs).toISOString() : null;
  if (!summary.startedAt && summary._firstMs !== undefined) summary.startedAt = new Date(summary._firstMs).toISOString();
  summary.elapsedSeconds = summary._firstMs !== undefined && summary._lastMs !== undefined ? Math.round((summary._lastMs - summary._firstMs) / 1000) : null;
  summary.requestErrorDurationSeconds = Math.round(summary.requestErrorDurationMs / 1000);
  delete summary._firstMs;
  delete summary._lastMs;
  summary.totalToolCallsIncludingLoggedNested = summary.topLevelToolCalls + summary.nestedToolCalls;
  summary.totalToolErrorsIncludingLoggedNested = summary.topLevelErrors + summary.nestedErrors;
  summary.compassCallsIncludingLoggedNested = summary.compassTopLevelCalls + summary.compassNestedCalls;
  summary.compassErrorsIncludingLoggedNested = summary.compassTopLevelErrors + summary.compassNestedErrors;
  return summary;
}

function sortedCounts(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function formatReport(summaries) {
  const totals = summaries.reduce((out, item) => {
    for (const key of ["records", "compactions", "assistantRequests", "assistantRequestErrors", "requestErrorDurationMs", "topLevelToolCalls", "topLevelErrors", "nestedToolCalls", "nestedErrors", "totalToolCallsIncludingLoggedNested", "totalToolErrorsIncludingLoggedNested", "compassTopLevelCalls", "compassNestedCalls", "compassCallsIncludingLoggedNested", "compassTopLevelErrors", "compassNestedErrors", "compassErrorsIncludingLoggedNested", "codemodeCalls", "unchangedStateReads", "noOpCapabilityOpens", "fullGoalReads", "goalStateRecords", "malformedLines"]) out[key] = (out[key] ?? 0) + (item[key] ?? 0);
    for (const key of Object.keys(out.usage)) out.usage[key] += item.usage[key] ?? 0;
    out.maxRequestErrorDurationMs = Math.max(out.maxRequestErrorDurationMs ?? 0, item.maxRequestErrorDurationMs ?? 0);
    for (const [key, count] of Object.entries(item.assistantRequestErrorsByProviderModel ?? {})) addCount(out.assistantRequestErrorsByProviderModel, key, count);
    return out;
  }, { assistantRequestErrorsByProviderModel: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 } });
  const rows = summaries.map((item) => {
    const final = item.finalState;
    const outcome = final?.outcome?.status ?? "unknown";
    const plan = final?.plan ? `${final.plan.done}/${final.plan.total} (${final.plan.blocked} blocked)` : "no DAG";
    const acceptance = final?.acceptance?.total ? `${final.acceptance.reportedPass}/${final.acceptance.total} reported pass` : "not defined";
    return `| ${item.file} | ${item.records} | ${item.assistantRequests} | ${item.assistantRequestErrors} | ${item.requestErrorDurationSeconds}s | ${item.topLevelToolCalls} | ${item.nestedToolCalls} | ${item.totalToolCallsIncludingLoggedNested} | ${item.totalToolErrorsIncludingLoggedNested} | ${item.compassCallsIncludingLoggedNested} | ${item.compassErrorsIncludingLoggedNested} | ${item.compactions} | ${item.usage.totalTokens.toLocaleString("en-US")} | ${outcome} | ${plan} | ${acceptance} |`;
  }).join("\n");
  const topTools = {};
  const nestedTools = {};
  const topErrors = {};
  const nestedErrors = {};
  for (const item of summaries) {
    for (const [name, count] of Object.entries(item.topLevelTools)) addCount(topTools, name, count);
    for (const [name, count] of Object.entries(item.nestedTools)) addCount(nestedTools, name, count);
    for (const [name, count] of Object.entries(item.topLevelErrorsByTool)) addCount(topErrors, name, count);
    for (const [name, count] of Object.entries(item.nestedErrorsByTool)) addCount(nestedErrors, name, count);
  }
  const countsBlock = (title, values) => `### ${title}\n\n${sortedCounts(values).map(([name, count]) => `- \`${name}\`: ${count}`).join("\n") || "- none"}`;
  return [
    "# Pi Compass Session Report",
    "",
    "Counts distinguish top-level Pi tool calls from nested Code Mode calls explicitly recorded in tool results. A visible nested expression is not counted as executed unless the JSONL records it.",
    "",
    "| Session | Records | Assistant requests | Model request errors | Error wait | Top-level calls | Logged nested calls | Total logged calls | Tool errors | Compass calls | Compass errors | Compactions | Recorded tokens | Final Goal outcome | DAG progress | Acceptance report |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|",
    rows,
    `| **TOTAL** | **${totals.records}** | **${totals.assistantRequests}** | **${totals.assistantRequestErrors}** | **${Math.round(totals.requestErrorDurationMs / 1000)}s** | **${totals.topLevelToolCalls}** | **${totals.nestedToolCalls}** | **${totals.totalToolCallsIncludingLoggedNested}** | **${totals.totalToolErrorsIncludingLoggedNested}** | **${totals.compassCallsIncludingLoggedNested}** | **${totals.compassErrorsIncludingLoggedNested}** | **${totals.compactions}** | **${totals.usage.totalTokens.toLocaleString("en-US")}** | — | — | — |`,
    "",
    "## Recorded model usage",
    "",
    `- Input: ${totals.usage.input.toLocaleString("en-US")}`,
    `- Output: ${totals.usage.output.toLocaleString("en-US")}`,
    `- Cache read: ${totals.usage.cacheRead.toLocaleString("en-US")}`,
    `- Cache write: ${totals.usage.cacheWrite.toLocaleString("en-US")}`,
    `- Reasoning (reported separately; may be included in output): ${totals.usage.reasoning.toLocaleString("en-US")}`,
    `- Provider-reported total tokens: ${totals.usage.totalTokens.toLocaleString("en-US")}`,
    `- Provider-reported cost sum: ${totals.usage.cost.toFixed(6)} (zero/unreported cost is not evidence of zero economic cost)`,
    `- Compass unchanged state reads: ${totals.unchangedStateReads}; no-op capability opens: ${totals.noOpCapabilityOpens}; full Goal reads: ${totals.fullGoalReads}`,
    `- Model request errors: ${totals.assistantRequestErrors}; cumulative request duration reported for those errors: ${Math.round(totals.requestErrorDurationMs / 1000)}s; longest single error request: ${Math.round(totals.maxRequestErrorDurationMs / 1000)}s. These are provider/runtime observations, not automatically Compass defects.`,
    `- Request errors by provider/model: ${sortedCounts(totals.assistantRequestErrorsByProviderModel).map(([name, count]) => `${name}=${count}`).join("; ") || "none"}`,
    `- Longest request-error samples: ${summaries.flatMap((item) => item.requestErrorExamples.map((sample) => ({ ...sample, session: item.file }))).sort((a, b) => b.durationMs - a.durationMs).slice(0, 5).map((sample) => `${sample.session}: ${sample.providerModel}, ${Math.round(sample.durationMs / 1000)}s, phase=${sample.phase ?? "unknown"}, bytes=${sample.requestBytes ?? "unknown"}, ${sample.error}`).join(" | ") || "none"}`,
    `- GoalRun state records parsed: ${totals.goalStateRecords}. Per-session final Goal/DAG/acceptance projection is shown above; reported acceptance is not independent verification.`,
    "",
    countsBlock("Top-level tool calls", topTools),
    "",
    countsBlock("Logged nested Code Mode calls", nestedTools),
    "",
    countsBlock("Top-level tool errors by tool", topErrors),
    "",
    countsBlock("Nested tool errors by tool", nestedErrors),
    "",
    "## Interpretation limits",
    "",
    "- Model-request errors are counted separately from toolResult errors. A failed assistant request may consume substantial wall time without producing any tool call; durationMs is the logged request duration, not necessarily pure provider processing time.",
    "- A tool error is not automatically a Compass defect; classify target-project, environment, model/schema, transport, and Compass state errors separately.",
    "- Token totals are summed exactly as logged by the provider. Cache reads count toward reported total tokens but have different billing treatment by provider/model.",
    "- Only nested calls present in `nestedCalls.calls` or the result's recorded `details.calls` are counted. Static Code Mode expressions are not treated as executed calls.",
    "- Compare the same Goal class, starting repository state, Pi/model/provider, and acceptance standard before attributing savings to Compass.",
    "",
  ].join("\n");
}

async function main(argv) {
  const jsonOutput = argv.includes("--json");
  const files = argv.filter((arg) => arg !== "--json" && !arg.startsWith("--"));
  if (!files.length) {
    process.stderr.write("Usage: node scripts/session-report.mjs <session.jsonl> [more.jsonl ...] [--json]\n");
    process.exitCode = 2;
    return;
  }
  const summaries = [];
  for (const file of files) summaries.push(await analyzeSession(path.resolve(file)));
  process.stdout.write(jsonOutput ? `${JSON.stringify(summaries, null, 2)}\n` : formatReport(summaries));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
