import { Type } from "typebox";
import fs from "node:fs";
import os from "node:os";
import { executionDriftReason, writeGuardDecision } from "./write-scope.mjs";
import { questionnaireFailureResultPatch } from "./questionnaire-integration.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLiveAcceptanceFixture } from "./live-acceptance-root.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  DELEGATION_EVENTS,
  FALLBACK_MODEL,
  PRIMARY_MODEL,
  REVIEW_MODEL,
  isSupportedDelegatedModel,
  DEFAULT_THINKING,
  DEFAULT_TIMEOUT_MS,
  MAX_WAVE_TASKS,
  START_ACK_TIMEOUT_MS,
  assessWavePolicy,
  hasCompleteUsageMetrics,
  buildSubagentDelegationRequest,
  selectReadySubagentTasks,
  parseSubagentDelegationResponse,
  normalizeProviderDiagnostics,
  providerFallbackReason,
} from "./execution-orchestrator.mjs";
import {
  readyTasks,
  updateTasks,
} from "./dag-core.mjs";
import {
  applyGoalChange,
  availableCapabilities,
  acceptanceStatus,
  goalOutcomeStatus,
  planningActivationSignal,
  stripConventionSections,
  buildGoalDetails,
  buildRecentEvents,
  buildStateSnapshot,
  GOAL_RUN_API_VERSION,
  GOAL_RUN_RELEASE,
  defineAcceptanceCriteria,
  dismissGoalChangeCandidate,
  recordAcceptanceResult,
  shouldSurfaceIssueReview,
  captureHumanPrompt,
  captureHumanDecision,
  emptyGoalRunState,
  explicitGoalChangeUpdates,
  mergeTrace,
  normalizeGoalRunState,
  recordCheckpoint,
  recordDecision,
  recordFailure,
  recordHumanQuestionnaireFailure,
  recordExecutionDrift,
  recordExecutionEvent,
  recordWriteTarget,
  revisePlanState,
  summarizePlanStatus,
  transitionTasks,
  triageIssue,
} from "./goal-run-v0-9-0.mjs";
import {
  CONTEXT_MESSAGE_TYPE,
  CONTEXT_STATE_TYPE,
  emptyContextState,
  planContextBoundary,
  planWatchBoundary,
  releaseWatchMessages,
  restoreContextState,
  searchContext,
} from "./context-core.mjs";

const STATE_ENTRY_TYPE = "pi-compass-v2.goalrun";
const STATE_MESSAGE_TYPE = "pi-compass-v2.goalrun-state";
const ANCHOR_MESSAGE_TYPE = "pi-compass-v2.goalrun-anchor";
const TOOL_PREFIX = "compass_";
const PACKAGE_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? null; }
  catch { return null; }
})();
const MAX_TRACE_ENTRIES = 24;

let state: any = emptyGoalRunState();
let contextState: any = emptyContextState();
let needsRestore = true;
let loaderSignature = "";
let loaderName = "";
let lastLoadoutSignature = "";
let mutationQueue: Promise<any> = Promise.resolve();
let loadoutRefreshPending = true;
let statePersistedViaEntry = false;
const stableToolsByPi = new WeakMap<object, Set<string>>();
const dynamicToolSignaturesByPi = new WeakMap<object, Map<string, string>>();
const delegationRuntimes = new WeakMap<object, any>();
const autoSchedulers = new WeakMap<object, { promise: Promise<any> | null; rerunRequested: boolean }>();

function clone<T>(value: T): T {
  return structuredClone(value);
}
function clip(value: unknown, max = 300): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function now() { return new Date().toISOString(); }
function isCompassName(name: string) { return name.startsWith(TOOL_PREFIX); }

function namesFrom(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((tool: any) => typeof tool === "string" ? tool : String(tool?.name ?? "")).filter(Boolean);
}
function activeNames(pi: any): string[] {
  try {
    if (typeof pi.getActiveTools === "function") return namesFrom(pi.getActiveTools());
    if (typeof pi.getAllTools === "function") return namesFrom(pi.getAllTools());
  } catch { /* best effort */ }
  return [];
}
function nativeToolSetSignature(pi: any): string {
  let registered: string[] | null = null;
  try { if (typeof pi.getAllTools === "function") registered = namesFrom(pi.getAllTools()).filter((name) => !isCompassName(name)).sort(); }
  catch { registered = null; }
  return createHash("sha256")
    .update(JSON.stringify({ registered, active: activeNames(pi).filter((name) => !isCompassName(name)).sort() }))
    .digest("hex");
}

// Explicit Human instructions are evaluated newest first. Earlier commands may be
// superseded by a later instruction, including a later prohibition. Conventions
// and quoted examples are not treated as runtime delegation requests.
function explicitSubagentVisibilityRequest(latestInstruction = ""): string | null {
  const version = state.goal.version ?? 1;
  const updates = state.goal.updates.filter((item: any) => item.goalVersion === version)
    .map((item: any) => item.sourceText || item.text)
    .filter((value: any) => typeof value === "string" && value.trim());
  const sources = [latestInstruction, ...updates.slice(-10).reverse(), state.goal.current].filter((value) => typeof value === "string" && value.trim());
  for (const value of sources) {
    if (typeof value !== "string") continue;
    const text = stripConventionSections(value)
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`\n]*`/g, " ")
      .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, " ");
    const veto = /\b(?:do not|don't|never|avoid)\s+(?:use|call|spawn|delegate to)\s+(?:native )?subagents?\b|(?:不要用|不要调用|不使用|别用|别调用|禁止使用).{0,10}子代理|(?:不要|别).{0,10}(?:并行侦察|并行调查)/i.test(text);
    if (veto) return "human_prohibited_subagents";
    if (/\buse (?:native )?subagents?\b|\b(?:please )?(?:call|spawn) (?:native )?subagents?\b|(?:使用|调用|启用)(?:多个)?子代理/i.test(text)) {
      return "explicit_human_subagent_request";
    }
    const request = /\b(?:scout|scouting|investigate|investigation|inspect|inspection|review|explore|exploration)\b.{0,90}\bparallel(?:ly)?\b|\bparallel(?:ly)?\b.{0,90}\b(?:scout|scouting|investigate|investigation|inspect|inspection|review|explore|exploration)\b/i.test(text)
      || /(?:并行.{0,16}(?:侦察|调查|检查|审查|探索|排查)|(?:侦察|调查|检查|审查|探索|排查).{0,16}并行|用(?:多个)?子代理并行|并行使用子代理)/i.test(text);
    if (!request) continue;
    const targets = sources.filter((item): item is string => typeof item === "string").join("\n");
    const multiple = /\b(?:multiple|several|two|three|four|many|independent|separate|different)\b.{0,60}\b(?:paths?|workstreams?|tracks?|files?|modules?|areas?|components?)\b|\b(?:paths?|workstreams?|tracks?|files?|modules?|areas?|components?)\b.{0,60}\b(?:independent|separate|different)\b/i.test(targets)
      || /(?:多个|多条|不同|独立|两个|三条|四条|多处).{0,24}(?:路径|工作流|方向|文件|模块|区域|组件|代码路径)|(?:路径|工作流|方向|文件|模块|区域|组件|代码路径).{0,24}(?:多个|多条|不同|独立)/i.test(targets);
    if (multiple) return "explicit_human_parallel_scouting";
  }
  return null;
}
function setCompassLoadout(pi: any, compassNames: string[]) {
  if (typeof pi.setActiveTools !== "function" || typeof pi.getActiveTools !== "function") {
    throw new Error("This Pi runtime must expose getActiveTools() and setActiveTools().");
  }
  // Native extensions own their activation policy. Compass changes only its own tools.
  const native = activeNames(pi).filter((name) => !isCompassName(name));
  const desired = [...new Set([...native, ...compassNames.filter(Boolean)])];
  const current = activeNames(pi);
  if (current.length !== desired.length || current.some((name, index) => name !== desired[index])) pi.setActiveTools(desired);
}

function getContext(rest: any[]): any {
  return rest.find((item) => item && typeof item === "object" && (item.sessionManager || typeof item.cwd === "string" || item.hasUI !== undefined)) ?? {};
}
function parseState(value: any): any | null {
  if (!value) return null;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (value && typeof value === "object" && [2, 3, 4, 5, 6, 7].includes(value.schemaVersion) && value.goal && value.plan) {
    return normalizeGoalRunState(value);
  }
  return null;
}
function stateFromEntry(entry: any): any | null {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type === "message") {
    const message = entry.message;
    if (message?.role === "toolResult") {
      const fromResult = parseState(message?.details?.state);
      if (fromResult) return fromResult;
    }
    if (message?.role === "custom" && message?.customType === STATE_MESSAGE_TYPE) {
      return parseState(message.content);
    }
  }
  if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) return parseState(entry.data);
  return null;
}
function traceFromEntries(entries: any[]): any[] {
  const found: any[] = [];
  for (const entry of entries ?? []) {
    if (entry?.type === "custom" && entry.customType === `${STATE_ENTRY_TYPE}.trace` && entry.data) found.push(entry.data);
  }
  return found.slice(-MAX_TRACE_ENTRIES);
}
function restoreState(ctx: any): any {
  let restored: any = null;
  let branch: any[] = [];
  let allEntries: any[] = [];
  try { branch = ctx?.sessionManager?.getBranch?.() ?? []; } catch { branch = []; }
  try { allEntries = ctx?.sessionManager?.getEntries?.() ?? branch; } catch { allEntries = branch; }
  for (const entry of branch) {
    const candidate = stateFromEntry(entry);
    if (candidate && (!restored || (candidate.stateRevision ?? 0) >= (restored.stateRevision ?? 0))) restored = candidate;
  }
  // Prefer the active branch. Session-wide fallback is only for runtimes whose
  // branch API does not expose custom extension entries.
  if (!restored) {
    for (const entry of allEntries) {
      const candidate = stateFromEntry(entry);
      if (candidate && (!restored || (candidate.stateRevision ?? 0) >= (restored.stateRevision ?? 0))) restored = candidate;
    }
  }
  if (!restored) restored = emptyGoalRunState();
  const branchTrace = traceFromEntries(branch);
  restored = mergeTrace(restored, branchTrace.length ? branchTrace : traceFromEntries(allEntries));
  return normalizeGoalRunState(restored);
}
function persistState(pi: any, value = state) {
  value.stateRevision = (Number.isInteger(value.stateRevision) ? value.stateRevision : 0) + 1;
  if (value === state) state.stateRevision = value.stateRevision;
  statePersistedViaEntry = false;
  try {
    if (typeof pi.appendEntry === "function") {
      pi.appendEntry(STATE_ENTRY_TYPE, clone(value));
      statePersistedViaEntry = true;
    }
  } catch { /* tool-result details remain the fallback */ }
}
function persistTrace(pi: any, item: any) {
  try { pi.appendEntry?.(`${STATE_ENTRY_TYPE}.trace`, clone(item)); } catch { /* trace is best-effort */ }
}
function stateResult(text: string, details: Record<string, unknown> = {}) {
  // Do not duplicate the full GoalRun snapshot into every tool-result JSONL entry
  // when Pi's custom-entry persistence succeeded. Keep it only as a compatibility
  // fallback for runtimes that cannot persist extension entries.
  const fallback = statePersistedViaEntry ? {} : { state: clone(state) };
  const cursor = `R${Number.isInteger(state.stateRevision) ? state.stateRevision : 0}-E${Math.max(0, (state.eventSeq ?? 1) - 1)}`;
  return {
    content: [{ type: "text", text: `${text}\nstateCursor: ${cursor}` }],
    details: { ...fallback, ...details, cursor, stateRevision: state.stateRevision ?? 0 },
  };
}
function readResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text", text }], details };
}
function sameIds(left: any[], right: any[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function executionUnresolved(value: any): boolean {
  return Boolean(value && ["dispatching", "running", "unknown"].includes(value.status));
}
function executionResultIndex(execution: any, taskId: string): number {
  return Array.isArray(execution?.results) ? execution.results.findIndex((item: any) => item?.id === taskId) : -1;
}
function matchingPending(runtime: any, payload: any) {
  if (!runtime || !payload || typeof payload !== "object") return null;
  const pending = runtime.pending.get(payload.requestId);
  if (!pending) return null;
  if (payload.ownerRunId !== pending.request.ownerRunId || payload.nodeId !== pending.request.nodeId) return null;
  return pending;
}
function ensureDelegationRuntime(pi: any) {
  const existing = delegationRuntimes.get(pi);
  if (existing) return existing;
  const bus = pi?.events;
  if (typeof bus?.on !== "function" || typeof bus?.emit !== "function") return null;
  const runtime: any = { pending: new Map(), probeWaiters: new Map(), disposers: [], installed: true };
  const subscribe = (eventName: string, handler: (payload: any) => void) => {
    try {
      const disposer = bus.on(eventName, handler);
      if (typeof disposer === "function") runtime.disposers.push(disposer);
      else if (typeof bus.off === "function") runtime.disposers.push(() => bus.off(eventName, handler));
    } catch {
      runtime.installed = false;
    }
  };
  const recordProgress = (payload: any) => {
    const pending = matchingPending(runtime, payload);
    if (!pending) return;
    pending.started = true;
    const recentTools = Array.isArray(payload?.recentTools)
      ? payload.recentTools.map((item: any) => typeof item?.tool === "string" ? clip(item.tool, 80) : "").filter(Boolean).slice(-8)
      : [];
    const currentTool = typeof payload?.currentTool === "string" ? clip(payload.currentTool, 80) : "";
    const previousProgress = pending.progress ?? { toolCount: null, tools: [] };
    const observedCount = Number.isFinite(payload?.toolCount) && payload.toolCount >= 0
      ? payload.toolCount
      : (currentTool || recentTools.length ? Math.max(1, Number.isFinite(previousProgress.toolCount) ? previousProgress.toolCount : 0) : previousProgress.toolCount);
    pending.progress = {
      toolCount: observedCount,
      tools: [...new Set([...(previousProgress.tools ?? []), ...recentTools, ...(currentTool ? [currentTool] : [])])].slice(-12),
    };
    if (pending.ackTimer) {
      clearTimeout(pending.ackTimer);
      pending.ackTimer = null;
    }
    void serialized(async () => {
      const execution = state.plan?.execution;
      if (!execution || execution.requestId !== pending.request.ownerRunId || !executionUnresolved(execution)) return;
      const index = executionResultIndex(execution, pending.request.nodeId);
      if (index < 0 || execution.results[index].requestId !== pending.request.requestId) return;
      const prior = execution.results[index];
      const runId = typeof payload.runId === "string" && payload.runId.trim() ? payload.runId.trim() : prior.runId;
      const nextStatus = prior.status === "unknown" ? "unknown" : "running";
      const progressCount = pending.progress?.toolCount ?? prior.observedToolCount ?? null;
      const progressTools = pending.progress?.tools ?? prior.observedTools ?? [];
      if (prior.status === nextStatus && prior.runId === runId
        && prior.observedToolCount === progressCount
        && JSON.stringify(prior.observedTools ?? []) === JSON.stringify(progressTools)) return;
      execution.results[index] = { ...prior, status: nextStatus, runId, observedToolCount: progressCount, observedTools: progressTools };
      execution.status = "running";
      persistState(pi);
    }).catch(() => {});
  };
  subscribe(DELEGATION_EVENTS.started, recordProgress);
  subscribe(DELEGATION_EVENTS.update, recordProgress);
  subscribe(DELEGATION_EVENTS.response, (payload) => {
    const pending = matchingPending(runtime, payload);
    if (!pending) return;
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    if (pending.responseTimer) clearTimeout(pending.responseTimer);
    runtime.pending.delete(pending.request.requestId);
    pending.resolve(payload && typeof payload === "object" ? { ...payload, __compassProgress: pending.progress ?? null } : payload);
  });
  subscribe(DELEGATION_EVENTS.response, (payload) => {
    const probe = runtime.probeWaiters.get(payload?.requestId);
    if (!probe) return;
    if (payload?.ownerRunId && payload.ownerRunId !== probe.ownerRunId) return;
    if (payload?.nodeId && payload.nodeId !== probe.nodeId) return;
    runtime.probeWaiters.delete(payload.requestId);
    if (payload.status === "invalid_request") runtime.bridgeConfirmed = true;
    probe.resolve(payload);
  });
  delegationRuntimes.set(pi, runtime);
  return runtime;
}
function dispatchOneDelegation(pi: any, runtime: any, request: any): Promise<any> {
  return new Promise((resolve) => {
    const pending: any = {
      request,
      resolve,
      started: false,
      ackTimer: null,
      responseTimer: null,
    };
    const finishUnknown = (reason: string) => {
      if (!runtime.pending.has(request.requestId)) return;
      if (pending.ackTimer) clearTimeout(pending.ackTimer);
      if (pending.responseTimer) clearTimeout(pending.responseTimer);
      runtime.pending.delete(request.requestId);
      resolve({ __compassUnknown: true, requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, model: request.model, reason });
    };
    runtime.pending.set(request.requestId, pending);
    pending.ackTimer = setTimeout(() => {
      finishUnknown(`No correlated Subagent start acknowledgement arrived within ${START_ACK_TIMEOUT_MS / 1000}s. Dispatch outcome is unknown; do not retry automatically.`);
    }, START_ACK_TIMEOUT_MS);
    pending.responseTimer = setTimeout(() => {
      finishUnknown(`No correlated terminal Subagent response arrived within ${Math.round((request.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s plus grace. Dispatch outcome is unknown; do not retry automatically.`);
    }, (request.timeoutMs || DEFAULT_TIMEOUT_MS) + 15_000);
    try {
      pi.events.emit(DELEGATION_EVENTS.request, request);
    } catch (error) {
      // Emitting can enter the package handler before throwing; fail closed rather
      // than assuming no child was started.
      finishUnknown(`Delegation request emit failed: ${clip(error instanceof Error ? error.message : String(error), 240)}. Dispatch outcome is unknown.`);
    }
  });
}
function cancelActiveDelegations(pi: any, reason = "Human instruction prohibited Subagent execution.") {
  const runtime = delegationRuntimes.get(pi);
  if (!runtime?.pending || typeof pi?.events?.emit !== "function") return 0;
  let requested = 0;
  for (const pending of [...runtime.pending.values()]) {
    if (!pending?.request || pending.cancelRequested) continue;
    pending.cancelRequested = true;
    pending.cancelReason = clip(reason, 240);
    try {
      // The structured API requires the exact attempt identity. A lost cancel
      // acknowledgement remains unknown; never infer that the child stopped.
      pi.events.emit(DELEGATION_EVENTS.cancel, {
        requestId: pending.request.requestId,
        ownerRunId: pending.request.ownerRunId,
        nodeId: pending.request.nodeId,
      });
      requested += 1;
    } catch {
      // The existing terminal-response deadline will fail closed to unknown.
    }
  }
  return requested;
}

async function probeDelegationBridge(pi: any, runtime: any, cwd: string) {
  if (runtime.bridgeConfirmed) return { ok: true, reason: "" };
  if (runtime.bridgeFailureUntil > Date.now()) return { ok: false, reason: runtime.bridgeFailureReason || "Structured-delegation bridge probe is cooling down after a failed check." };
  const requestId = randomUUID();
  const ownerRunId = `compass-probe-${randomUUID()}`;
  const nodeId = "compass_probe";
  const bus = pi.events;
  const response = await new Promise((resolve) => {
    let settled = false;
    let timer: any = null;
    const finish = (payload: any) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      runtime.probeWaiters.delete(requestId);
      resolve(payload);
    };
    runtime.probeWaiters.set(requestId, { ownerRunId, nodeId, resolve: finish });
    timer = setTimeout(() => finish(null), 1_500);
    try {
      bus.emit(DELEGATION_EVENTS.request, {
        requestId,
        ownerRunId,
        nodeId,
        agent: "scout",
        task: "",
        context: "fresh",
        cwd,
        result: { kind: "structured", schema: { type: "object", properties: { probe: { type: "boolean" } }, required: ["probe"], additionalProperties: false } },
      });
    } catch {
      finish(null);
    }
  });
  if (response?.status === "invalid_request") {
    runtime.bridgeFailureUntil = 0;
    runtime.bridgeFailureReason = "";
    return { ok: true, reason: "" };
  }
  const reason = response
    ? `Structured-delegation probe returned unexpected status ${clip(response.status || "unknown", 40)}; no real task was dispatched.`
    : "No correlated invalid_request response arrived from pi-subagents' structured-delegation handler; no task was dispatched.";
  runtime.bridgeFailureReason = reason;
  runtime.bridgeFailureUntil = Date.now() + 30_000;
  return { ok: false, reason };
}
async function executionAvailability(pi: any, cwd: string, latestInstruction = "") {
  const runtime = ensureDelegationRuntime(pi);
  const allNames = (() => {
    try { return typeof pi.getAllTools === "function" ? namesFrom(pi.getAllTools()) : []; }
    catch { return []; }
  })();
  const registered = allNames.some((name: string) => /^(?:subagent|subagents)$/i.test(name));
  const humanRequest = explicitSubagentVisibilityRequest(latestInstruction);
  if (humanRequest === "human_prohibited_subagents") return { ok: false, runtime, reason: "Human instructions prohibit Subagent execution for the current Goal; no task was dispatched." };
  if (!registered) return { ok: false, runtime, reason: "pi-subagents is not registered in this Pi session; no task was dispatched." };
  // pi-subagents owns model-visible tool activation. Structured dispatch is a separate
  // runtime API; explicit executor intent authorizes it unless Human vetoes.
  if (!runtime?.installed) return { ok: false, runtime, reason: "The Pi event bus does not expose the structured-delegation contract; no task was dispatched." };
  const bridge = await probeDelegationBridge(pi, runtime, cwd);
  if (!bridge.ok) return { ok: false, runtime, reason: bridge.reason };
  return { ok: true, runtime, reason: "" };
}
function primaryModelForTask(task: any): string {
  return ["reviewer", "evidence-auditor", "oracle"].includes(String(task?.agent ?? ""))
    ? REVIEW_MODEL
    : PRIMARY_MODEL;
}
function executionConstraints() {
  const version = state.goal.version ?? 1;
  return (state.sessionDirectives ?? [])
    .filter((item: any) => item.goalVersion === version && (item.pinned === true || item.hard === true))
    .map((item: any) => item.text)
    .filter((value: any) => typeof value === "string" && value.trim())
    .slice(0, 12);
}
function executionRecordForWave(waveId: string, tasks: any[], planRevision: number, stateVersion: number, requestIds: string[], policy: any) {
  return {
    requestId: waveId,
    runId: null,
    taskIds: tasks.map((task: any) => task.id),
    planRevision,
    stateVersion,
    status: "dispatching",
    startedAt: now(),
    completedAt: null,
    error: null,
    policy: policy ? { mode: policy.mode, reason: clip(policy.reason, 400), observedSamples: policy.observedSamples ?? 0, medianSavingsMs: Number.isFinite(policy.medianSavingsMs) ? policy.medianSavingsMs : null } : null,
    results: tasks.map((task: any, index: number) => ({
      id: task.id,
      status: "dispatching",
      agent: task.agent || "scout",
      model: primaryModelForTask(task),
      fallbackAttempted: false,
      requestId: requestIds[index],
      ownerRunId: waveId,
      runId: null,
      error: "",
      primaryError: "",
      summary: "",
      usage: null,
      primaryUsage: null,
      providerDiagnostics: null,
      primaryProviderDiagnostics: null,
      fallbackReason: null,
      observedToolCount: null,
      observedTools: [],
    })),
  };
}
function setExecutionResult(pi: any, waveId: string, taskId: string, patch: any) {
  return serialized(async () => {
    const execution = state.plan?.execution;
    if (!execution || execution.requestId !== waveId) return false;
    const index = executionResultIndex(execution, taskId);
    if (index < 0) return false;
    execution.results[index] = { ...execution.results[index], ...patch };
    persistState(pi);
    return true;
  });
}
function parsedTaskEvidence(parsed: any): string {
  return clip([parsed.summary, ...(parsed.evidence ?? []).map((item: string) => `Evidence: ${item}`)].filter(Boolean).join("\n"), 1600);
}
async function applyDelegationOutcome(pi: any, waveId: string, task: any, parsed: any, fallbackAttempted: boolean, primaryError = "") {
  await serialized(async () => {
    let execution = state.plan?.execution;
    if (!execution || execution.requestId !== waveId) return;
    let index = executionResultIndex(execution, task.id);
    if (index < 0) return;
    const currentResult = execution.results[index];
    if (parsed?.status === "done" && state.plan.tasks.find((item: any) => item.id === task.id)?.status === "in_progress") {
      const evidence = parsedTaskEvidence(parsed);
      state = transitionTasks(state, "done", [{ id: task.id, evidence }], updateTasks).state;
    } else if (state.plan.tasks.find((item: any) => item.id === task.id)?.status === "in_progress") {
      const reason = clip(`${parsed?.terminalStatus ? `Subagent ${parsed.terminalStatus}: ` : ""}${parsed?.reason || parsed?.summary || "Subagent returned no valid task evidence."}`, 600);
      state = transitionTasks(state, "block", [{ id: task.id, reason }], updateTasks).state;
    }
    execution = state.plan?.execution;
    if (!execution || execution.requestId !== waveId) return;
    index = executionResultIndex(execution, task.id);
    if (index < 0) return;
    execution.results[index] = {
      ...execution.results[index],
      status: parsed?.status === "done" ? "done" : parsed?.status === "failed" ? "failed" : "blocked",
      model: parsed?.model || currentResult.model,
      fallbackAttempted,
      runId: parsed?.runId || currentResult.runId || null,
      error: parsed?.status === "done" ? "" : clip(parsed?.reason || parsed?.error || "Subagent did not complete the task.", 600),
      primaryError: clip(primaryError || currentResult.primaryError || "", 400),
      summary: clip(parsed?.summary || "", 800),
      usage: parsed?.usage || currentResult.usage || null,
      providerDiagnostics: parsed?.providerDiagnostics || currentResult.providerDiagnostics || null,
      observedToolCount: Number.isFinite(parsed?.observedToolCount) ? parsed.observedToolCount : currentResult.observedToolCount ?? null,
      observedTools: Array.isArray(parsed?.observedTools) ? parsed.observedTools.slice(0, 12) : currentResult.observedTools ?? [],
    };
    state = recordExecutionEvent(state, {
      status: execution.results[index].status,
      summary: `Subagent task ${task.id}: ${execution.results[index].status}${fallbackAttempted ? " via DeepSeek fallback" : ""}.`,
      text: clip(`${execution.results[index].summary}${execution.results[index].error ? `\nReason: ${execution.results[index].error}` : ""}`, 1200),
      ref: execution.results[index].runId || "",
    });
    persistState(pi);
    loadoutRefreshPending = true;
  });
}
async function runReadySubagentWaves(pi: any, ctx: any, latestInstruction = "") {
  if (!state.goal.current || !state.plan?.tasks?.length) return;
  if (state.plan.goal && state.plan.goal !== state.goal.current) return;
  // A restored or timed-out wave is never automatically re-dispatched: absence
  // of a response is not proof that a child did not start.
  if (executionUnresolved(state.plan.execution)) return;
  for (let wave = 0; wave < 24; wave += 1) {
    const readyCandidates = selectReadySubagentTasks(state.plan, MAX_WAVE_TASKS);
    const wavePolicy = assessWavePolicy(readyCandidates, state.plan.executionHistory, MAX_WAVE_TASKS);
    const ready = readyCandidates.slice(0, wavePolicy.maxTasks);
    if (!ready.length) {
      const missingRationale = (state.plan.tasks ?? []).filter((task: any) => task.status === "pending"
        && task.executor === "subagent"
        && String(task.writeScope ?? "").trim().toLowerCase() === "read-only"
        && (typeof task.dispatchReason !== "string" || task.dispatchReason.trim().length < 12));
      if (missingRationale.length) {
        const ids = missingRationale.map((task: any) => task.id);
        const reason = `Subagent tasks ${ids.join(", ")} have no adequate dispatchReason. Explain why a separate semantic context is worth the extra model call, or route the task to parent/code. No child was dispatched.`;
        const existing = state.plan.execution;
        if (!(existing?.status === "failed" && existing.planRevision === state.plan.revision && sameIds(existing.taskIds ?? [], ids) && existing.error === reason)) {
          await serialized(async () => {
            const requestId = randomUUID();
            state.plan.execution = { requestId, runId: null, taskIds: ids, planRevision: state.plan.revision, stateVersion: state.plan.stateVersion ?? 0, status: "failed", startedAt: now(), completedAt: now(), error: reason, results: [] };
            state = recordExecutionEvent(state, { status: "failed", summary: "Subagent dispatch rationale missing.", text: reason, ref: requestId });
            persistState(pi);
            loadoutRefreshPending = true;
          });
        }
      }
      return;
    }
    const availability = await executionAvailability(pi, contextCwd(ctx) || state.projectRoot || process.cwd(), latestInstruction);
    if (!availability.ok) {
      const existing = state.plan.execution;
      const ids = ready.map((task: any) => task.id);
      if (existing?.status === "failed" && existing.planRevision === state.plan.revision
        && sameIds(existing.taskIds ?? [], ids) && existing.error === availability.reason) return;
      await serialized(async () => {
        const currentReady = selectReadySubagentTasks(state.plan, MAX_WAVE_TASKS).slice(0, wavePolicy.maxTasks);
        if (!sameIds(currentReady.map((task: any) => task.id), ids) || executionUnresolved(state.plan.execution)) return;
        const requestId = randomUUID();
        state.plan.execution = {
          requestId,
          runId: null,
          taskIds: ids,
          planRevision: state.plan.revision,
          stateVersion: state.plan.stateVersion ?? 0,
          status: "failed",
          startedAt: now(),
          completedAt: now(),
          error: availability.reason,
          results: [],
        };
        state = recordExecutionEvent(state, { status: "failed", summary: "Subagent auto-dispatch skipped.", text: availability.reason, ref: requestId });
        persistState(pi);
        loadoutRefreshPending = true;
      });
      return;
    }

    const waveId = randomUUID();
    const selectedPlanRevision = state.plan.revision;
    const selectedGoalVersion = state.goal.version;
    const requestIds = ready.map(() => randomUUID());
    const requests = ready.map((task: any, index: number) => buildSubagentDelegationRequest({
      task,
      goal: state.goal.current,
      constraints: executionConstraints(),
      cwd: contextCwd(ctx) || state.projectRoot || process.cwd(),
      ownerRunId: waveId,
      requestId: requestIds[index],
      model: primaryModelForTask(task),
      thinking: DEFAULT_THINKING,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }));
    const prepared = await serialized(async () => {
      const currentReady = selectReadySubagentTasks(state.plan, MAX_WAVE_TASKS).slice(0, wavePolicy.maxTasks);
      if (state.plan.revision !== selectedPlanRevision || state.goal.version !== selectedGoalVersion
        || !currentReady.length || !sameIds(currentReady.map((task: any) => task.id), ready.map((task: any) => task.id))
        || executionUnresolved(state.plan.execution)) return false;
      const started = transitionTasks(state, "start", currentReady.map((task: any) => ({ id: task.id })), updateTasks);
      state = started.state;
      state.plan.execution = executionRecordForWave(waveId, currentReady, state.plan.revision, state.plan.stateVersion ?? 0, requestIds, wavePolicy);
      state = recordExecutionEvent(state, {
        status: "dispatching",
        summary: `Auto-dispatched ${currentReady.length} read-only Subagent task(s) (${wavePolicy.mode}).`,
        text: `${wavePolicy.reason}
${currentReady.map((task: any) => `${task.id}/${task.agent || "scout"}`).join(", ")}`,
        ref: waveId,
      });
      persistState(pi);
      loadoutRefreshPending = true;
      return true;
    });
    if (!prepared) return;

    const primaryResponses = await Promise.all(requests.map((request: any) => dispatchOneDelegation(pi, availability.runtime, request)));
    const fallbackJobs: any[] = [];
    let unknown = false;
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      const task = ready.find((item: any) => item.id === request.nodeId);
      const response = primaryResponses[index];
      if (response?.__compassUnknown) {
        unknown = true;
        await setExecutionResult(pi, waveId, task.id, { status: "unknown", error: response.reason });
        continue;
      }
      const fallbackReason = providerFallbackReason(response);
      if (fallbackReason) {
        const fallbackRequestId = randomUUID();
        await setExecutionResult(pi, waveId, task.id, {
          status: "dispatching",
          requestId: fallbackRequestId,
          model: FALLBACK_MODEL,
          fallbackAttempted: true,
          fallbackReason,
          primaryError: clip(response.error || response.message || "Primary provider failed.", 400),
          primaryUsage: response.usage && typeof response.usage === "object" ? response.usage : null,
          primaryProviderDiagnostics: normalizeProviderDiagnostics(response.providerDiagnostics),
          runId: null,
          error: "",
        });
        fallbackJobs.push({
          task,
          primaryError: clip(response.error || response.message || "Primary provider failed.", 400),
          request: buildSubagentDelegationRequest({
            task,
            goal: state.goal.current,
            constraints: executionConstraints(),
            cwd: contextCwd(ctx) || state.projectRoot || process.cwd(),
            ownerRunId: waveId,
            requestId: fallbackRequestId,
            model: FALLBACK_MODEL,
            thinking: DEFAULT_THINKING,
            timeoutMs: DEFAULT_TIMEOUT_MS,
          }),
        });
        continue;
      }
      const parsed = parseSubagentDelegationResponse(response, {
        requestId: request.requestId,
        ownerRunId: waveId,
        nodeId: task.id,
        model: request.model,
      });
      if (!parsed) {
        unknown = true;
        await setExecutionResult(pi, waveId, task.id, { status: "unknown", error: "Terminal response failed correlation/shape validation; no automatic retry was attempted." });
        continue;
      }
      await applyDelegationOutcome(pi, waveId, task, parsed, false);
    }

    if (fallbackJobs.length) {
      const fallbackResponses = await Promise.all(fallbackJobs.map((job: any) => dispatchOneDelegation(pi, availability.runtime, job.request)));
      for (let index = 0; index < fallbackJobs.length; index += 1) {
        const job = fallbackJobs[index];
        const response = fallbackResponses[index];
        if (response?.__compassUnknown) {
          unknown = true;
          await setExecutionResult(pi, waveId, job.task.id, { status: "unknown", error: response.reason, fallbackAttempted: true, primaryError: job.primaryError });
          continue;
        }
        const parsed = parseSubagentDelegationResponse(response, {
          requestId: job.request.requestId,
          ownerRunId: waveId,
          nodeId: job.task.id,
          model: FALLBACK_MODEL,
        });
        if (!parsed) {
          unknown = true;
          await setExecutionResult(pi, waveId, job.task.id, { status: "unknown", error: "Fallback response failed correlation/shape validation; no further retry was attempted." });
          continue;
        }
        await applyDelegationOutcome(pi, waveId, job.task, parsed, true, job.primaryError);
      }
    }

    await serialized(async () => {
      const execution = state.plan?.execution;
      if (!execution || execution.requestId !== waveId) return;
      const hasUnknown = unknown || execution.results.some((item: any) => item.status === "unknown" || item.status === "dispatching" || item.status === "running");
      execution.status = hasUnknown ? "unknown" : "completed";
      execution.completedAt = hasUnknown ? null : now();
      execution.error = hasUnknown
        ? "At least one delegated task has no correlated terminal result. Inspect recorded run IDs and reconcile before retrying; Compass will not duplicate the batch."
        : null;
      if (!hasUnknown) {
        const rows = execution.results || [];
        const totalCost = rows.every((item: any) => Number.isFinite(item.usage?.cost) && (!item.fallbackAttempted || Number.isFinite(item.primaryUsage?.cost)))
          ? rows.reduce((sum: number, item: any) => sum + item.usage.cost + (item.fallbackAttempted ? item.primaryUsage.cost : 0), 0)
          : null;
        const sumDurationMs = rows.every((item: any) => Number.isFinite(item.usage?.durationMs) && (!item.fallbackAttempted || Number.isFinite(item.primaryUsage?.durationMs)))
          ? rows.reduce((sum: number, item: any) => sum + item.usage.durationMs + (item.fallbackAttempted ? item.primaryUsage.durationMs : 0), 0)
          : null;
        const wallDurationMs = Math.max(0, Date.parse(execution.completedAt) - Date.parse(execution.startedAt));
        state.plan.executionHistory = [...(state.plan.executionHistory || []), {
          requestId: waveId,
          planRevision: execution.planRevision,
          taskIds: [...execution.taskIds],
          status: "completed",
          startedAt: execution.startedAt,
          completedAt: execution.completedAt,
          totalCost,
          sumDurationMs,
          wallDurationMs,
          estimatedParallelSavingsMs: Number.isFinite(sumDurationMs) ? sumDurationMs - wallDurationMs : null,
          fallbackCount: rows.filter((item: any) => item.fallbackAttempted).length,
          metricsComplete: rows.every((item: any) => hasCompleteUsageMetrics(item.usage) && (!item.fallbackAttempted || hasCompleteUsageMetrics(item.primaryUsage))),
          policyMode: execution.policy?.mode ?? "unknown",
          policyReason: clip(execution.policy?.reason ?? "No recorded wave policy.", 400),
          taskMetrics: rows.map((item: any) => ({
            id: item.id,
            model: clip(item.model || "unknown", 120),
            fallbackAttempted: item.fallbackAttempted === true,
            fallbackReason: clip(item.fallbackReason || "", 80) || null,
            providerErrorCount: Number.isFinite(item.providerDiagnostics?.errorCount) ? item.providerDiagnostics.errorCount : null,
            providerLastErrorKind: item.providerDiagnostics?.lastError?.kind ?? null,
            providerRetryPhase: item.providerDiagnostics?.retry?.phase ?? null,
            cost: Number.isFinite(item.usage?.cost) ? item.usage.cost : null,
            primaryCost: Number.isFinite(item.primaryUsage?.cost) ? item.primaryUsage.cost : null,
            durationMs: Number.isFinite(item.usage?.durationMs) ? item.usage.durationMs : null,
            input: Number.isFinite(item.usage?.input) ? item.usage.input : null,
            output: Number.isFinite(item.usage?.output) ? item.usage.output : null,
            toolCalls: Number.isFinite(item.usage?.toolCalls) ? item.usage.toolCalls : null,
            observedToolCount: Number.isFinite(item.observedToolCount) ? item.observedToolCount : null,
            observedTools: Array.isArray(item.observedTools) ? item.observedTools.slice(0, 12) : [],
            metricsComplete: hasCompleteUsageMetrics(item.usage) && (!item.fallbackAttempted || hasCompleteUsageMetrics(item.primaryUsage)),
            runId: clip(item.runId || "", 128) || null,
          })),
          source: "runtime",
        }].slice(-8);
      }
      state = recordExecutionEvent(state, {
        status: execution.status,
        summary: `Subagent batch ${execution.status}.`,
        text: (execution.results || []).map((item: any) => `${item.id}=${item.status}${item.fallbackAttempted ? " (DeepSeek fallback)" : ""}${item.error ? `: ${clip(item.error, 160)}` : ""}`).join("\n"),
        ref: waveId,
      });
      persistState(pi);
      loadoutRefreshPending = true;
    });
    if (executionUnresolved(state.plan.execution)) return;
    // Keep running deterministic waves while ready Subagent tasks exist. Parent
    // and Code Mode tasks are deliberately left to the main Agent.
  }
}

async function recordAutoDispatchFailure(pi: any, error: any) {
  await serialized(async () => {
    const message = clip(error instanceof Error ? error.message : String(error), 300);
    const execution = state.plan?.execution;
    if (execution && ["dispatching", "running", "unknown"].includes(execution.status)) {
      execution.status = "unknown";
      execution.completedAt = null;
      execution.error = `Auto-dispatch orchestration raised an error; outcome is treated as unknown to prevent duplicate work: ${message}`;
      execution.results = (execution.results ?? []).map((item: any) => ["dispatching", "running"].includes(item.status)
        ? { ...item, status: "unknown", error: execution.error }
        : item);
      state = recordExecutionEvent(state, { status: "unknown", summary: "Subagent orchestration failed closed.", text: execution.error, ref: execution.requestId });
      persistState(pi);
      loadoutRefreshPending = true;
      return;
    }
    const ids = selectReadySubagentTasks(state.plan, MAX_WAVE_TASKS).map((task: any) => task.id);
    if (!ids.length) return;
    const requestId = randomUUID();
    state.plan.execution = {
      requestId, runId: null, taskIds: ids, planRevision: state.plan.revision,
      stateVersion: state.plan.stateVersion ?? 0, status: "failed", startedAt: now(),
      completedAt: now(), error: `Auto-dispatch failed before a child run was confirmed: ${message}`,
      results: [],
    };
    state = recordExecutionEvent(state, { status: "failed", summary: "Subagent orchestration failed before confirmed dispatch.", text: state.plan.execution.error, ref: requestId });
    persistState(pi);
    loadoutRefreshPending = true;
  });
}
async function runReadySubagentWavesSafely(pi: any, ctx: any, latestInstruction = "") {
  try {
    await runReadySubagentWaves(pi, ctx, latestInstruction);
  } catch (error) {
    await recordAutoDispatchFailure(pi, error);
  }
}
function hasAutoDispatchWork() {
  if (!state.goal.current || !state.plan?.tasks?.length) return false;
  if (state.plan.goal && state.plan.goal !== state.goal.current) return false;
  if (executionUnresolved(state.plan.execution)) return false;
  if (selectReadySubagentTasks(state.plan, MAX_WAVE_TASKS).length) return true;
  return state.plan.tasks.some((task: any) => task.status === "pending"
    && task.executor === "subagent"
    && String(task.writeScope ?? "").trim().toLowerCase() === "read-only"
    && (typeof task.dispatchReason !== "string" || task.dispatchReason.trim().length < 12));
}
// The parent turn must not wait for all child model calls. Reserve one scheduler
// promise synchronously, then run the deterministic orchestration in the background
// so independent parent/Code Mode work can overlap with read-only Subagents.
function scheduleReadySubagentWaves(pi: any, ctx: any, latestInstruction = "") {
  let scheduler = autoSchedulers.get(pi);
  if (!scheduler) {
    scheduler = { promise: null, rerunRequested: false };
    autoSchedulers.set(pi, scheduler);
  }
  if (scheduler.promise) {
    scheduler.rerunRequested = true;
    return { started: false, coalesced: true };
  }
  if (!hasAutoDispatchWork()) return { started: false, coalesced: false };
  scheduler.rerunRequested = false;
  const running = Promise.resolve().then(() => runReadySubagentWavesSafely(pi, ctx, latestInstruction));
  scheduler.promise = running.finally(() => {
    const rerun = scheduler!.rerunRequested && !executionUnresolved(state.plan?.execution);
    scheduler!.promise = null;
    scheduler!.rerunRequested = false;
    if (rerun) scheduleReadySubagentWaves(pi, ctx, latestInstruction);
  });
  return { started: true, coalesced: false };
}
function executionSnapshotForToolResult() {
  return JSON.stringify({
    stateRevision: state.stateRevision,
    eventSeq: state.eventSeq,
    planRevision: state.plan?.revision ?? 0,
    statuses: (state.plan?.tasks ?? []).map((task: any) => [task.id, task.status]),
    requestId: state.plan?.execution?.requestId ?? null,
    status: state.plan?.execution?.status ?? null,
    error: state.plan?.execution?.error ?? null,
    historyLength: (state.plan?.executionHistory ?? []).length,
  });
}
function automaticExecutionSummary(previousHistoryIds: Set<string>): string | null {
  const history = Array.isArray(state.plan?.executionHistory) ? state.plan.executionHistory : [];
  const newBatches = history.filter((batch: any) => !previousHistoryIds.has(batch.requestId));
  const execution = state.plan?.execution;
  if (newBatches.length) {
    const ids = [...new Set(newBatches.flatMap((batch: any) => batch.taskIds ?? []))];
    const taskStates = ids.map((id) => {
      const task = state.plan.tasks.find((item: any) => item.id === id);
      return `${id}=${task?.status ?? "unknown"}`;
    });
    const costComplete = newBatches.every((batch: any) => Number.isFinite(batch.totalCost));
    const cost = newBatches.reduce((sum: number, batch: any) => sum + (Number.isFinite(batch.totalCost) ? batch.totalCost : 0), 0);
    const wallMs = newBatches.reduce((sum: number, batch: any) => sum + (batch.wallDurationMs || 0), 0);
    const fallbackCount = newBatches.reduce((sum: number, batch: any) => sum + (batch.fallbackCount || 0), 0);
    const ready = readyTasks(state.plan).map((task: any) => task.id);
    return `Compass auto-executed ${ids.length} read-only Subagent task(s): ${taskStates.join(", ")}. Waves=${newBatches.length}; ${costComplete ? `reported child cost=$${cost.toFixed(4)}` : `reported child cost is incomplete (known subtotal=$${cost.toFixed(4)})`}; combined batch wall=${Math.round(wallMs / 1000)}s; DeepSeek fallback(s)=${fallbackCount}. Next ready tasks: ${ready.join(", ") || "none"}.`;
  }
  if (execution && ["dispatching", "running"].includes(execution.status)) {
    const active = (execution.results ?? []).filter((item: any) => ["dispatching", "running", "unknown"].includes(item.status)).map((item: any) => item.id);
    return `Compass dispatched read-only Subagent task(s) ${(execution.taskIds ?? []).join(", ")} (status=${execution.status}; awaiting ${active.join(", ") || "terminal results"}). The runtime will consume correlated structured results and advance dependency-ready Subagent waves automatically. Continue independent parent/Code Mode work in parallel; do not manually start or redispatch these Subagent tasks.`;
  }
  if (execution?.status === "unknown") {
    return `Compass Subagent execution is UNKNOWN for tasks ${(execution.taskIds ?? []).join(", ")}; do not redispatch. Inspect run IDs with native Subagent status, then use compass_execution(action=status|resolve) only after all children are terminal.`;
  }
  if (execution?.status === "failed" && execution.error) {
    return `Compass could not auto-dispatch Subagent tasks ${(execution.taskIds ?? []).join(", ")}. No child was confirmed; tasks remain pending. ${clip(execution.error, 240)} Revise executor to parent/code or enable the user's native Subagent tool before retrying.`;
  }
  return null;
}

async function handleCompassToolResult(pi: any, event: any, ctx: any) {
  return serialized(async () => {
    const toolName = String(event?.toolName ?? "");
    if (event?.isError || !/^compass_(?:plan_create|plan_revise|task|execution)$/.test(toolName)) return;
    if (toolName === "compass_execution" && event?.input?.action !== "resolve") return;

    const beforeSnapshot = executionSnapshotForToolResult();
    const previousHistoryIds = new Set((state.plan?.executionHistory ?? []).map((batch: any) => batch.requestId));
    const readyBefore = selectReadySubagentTasks(state.plan, MAX_WAVE_TASKS).map((task: any) => task.id);
    const missingRationale = (state.plan?.tasks ?? []).filter((task: any) => task.status === "pending"
      && task.executor === "subagent"
      && String(task.writeScope ?? "").trim().toLowerCase() === "read-only"
      && (typeof task.dispatchReason !== "string" || task.dispatchReason.trim().length < 12)).map((task: any) => task.id);
    const scheduled = scheduleReadySubagentWaves(pi, ctx ?? {});
    const changed = executionSnapshotForToolResult() !== beforeSnapshot;
    if (!changed && !scheduled.started && !scheduled.coalesced) return;

    const humanDelegationRequest = explicitSubagentVisibilityRequest();
    const summary = automaticExecutionSummary(previousHistoryIds)
      ?? (humanDelegationRequest === "human_prohibited_subagents"
        ? "The latest Human instruction prohibits Subagent execution for this Goal. No child will be dispatched; keep the tasks with parent/Code Mode or revise the plan only after the Human changes that constraint."
        : readyBefore.length && scheduled.started
          ? `Compass queued automatic dispatch for ready read-only Subagent task(s) ${readyBefore.join(", ")}. The runtime will consume their results; independent parent/Code Mode work may proceed without waiting for these children.`
          : missingRationale.length && scheduled.started
            ? `No Subagent was dispatched for ${missingRationale.join(", ")}: each task must explain in dispatchReason why a separate semantic context is worth the extra model call. Route deterministic work to code or coupled reasoning to parent.`
            : scheduled.coalesced
              ? "Compass is already processing the current Subagent batch. Its results will be consumed automatically; continue only independent parent/Code Mode work and do not redispatch the active tasks."
              : null);
    const details = {
      ...(event?.details && typeof event.details === "object" ? clone(event.details) : {}),
      autoDispatch: scheduled.started ? "scheduled" : scheduled.coalesced ? "already_running" : null,
      execution: state.plan?.execution ? clone(state.plan.execution) : null,
      executionHistory: clone(state.plan?.executionHistory ?? []),
      taskStatuses: (state.plan?.tasks ?? []).map((task: any) => ({ id: task.id, status: task.status })),
    };
    if (!summary) return { details };
    const content = Array.isArray(event?.content)
      ? [...event.content]
      : typeof event?.content === "string" && event.content
        ? [{ type: "text", text: event.content }]
        : [];
    content.push({ type: "text", text: summary });
    return { content, details };
  });
}

function activeCapabilities(): string[] {
  const values = Array.isArray(state.activeCapabilities) ? state.activeCapabilities : [];
  if (!values.length && state.activeCapability && state.activeCapability !== "root") return [state.activeCapability];
  return [...new Set(values)];
}
function setActiveCapabilities(values: string[]) {
  state.activeCapabilities = [...new Set(values.filter((value) => value && value !== "root"))];
  state.activeCapability = state.activeCapabilities.at(-1) ?? "root";
}
function assertCapability(expected: string) {
  const active = activeCapabilities();
  if (!active.includes(expected)) {
    throw new Error(`Compass capability not loaded: "${expected}". Loaded: ${active.join(", ") || "none"}. No change was made.`);
  }
}
function serialized<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = mutationQueue.then(fn, fn);
  mutationQueue = next.then(() => undefined, () => undefined);
  return next;
}
function noMutation<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no state changed/i.test(message)) throw error;
    throw new Error(`${message} No state changed.`);
  }
}
function registerOnce(pi: any, name: string, definition: any): string {
  let stableTools = stableToolsByPi.get(pi);
  if (!stableTools) {
    stableTools = new Set<string>();
    stableToolsByPi.set(pi, stableTools);
  }
  if (!stableTools.has(name)) {
    pi.registerTool({ ...definition, name });
    stableTools.add(name);
  }
  return name;
}
// Pi replaces an extension tool when registerTool is called with the same name.
// Keep names stable; update only the schema/implementation that actually changed.
function registerDynamic(pi: any, name: string, definition: any): string {
  let signatures = dynamicToolSignaturesByPi.get(pi);
  if (!signatures) {
    signatures = new Map<string, string>();
    dynamicToolSignaturesByPi.set(pi, signatures);
  }
  const signature = JSON.stringify({
    label: definition.label,
    description: definition.description,
    promptSnippet: definition.promptSnippet,
    promptGuidelines: definition.promptGuidelines,
    parameters: definition.parameters,
  });
  if (signatures.get(name) !== signature) {
    pi.registerTool({ ...definition, name });
    signatures.set(name, signature);
  }
  return name;
}
function toolInventory(pi: any) {
  let all: string[] | null = null;
  try { if (typeof pi.getAllTools === "function") all = namesFrom(pi.getAllTools()); } catch { all = null; }
  const active = activeNames(pi);
  const stateFor = (pattern: RegExp, hiddenReason = "") => {
    const registered = all === null ? null : all.some((name) => pattern.test(name));
    const visible = active.some((name) => pattern.test(name));
    return {
      registered,
      active: visible,
      ...(registered === false ? { reason: "not registered in this Pi session" } : !visible && hiddenReason ? { reason: hiddenReason } : {}),
    };
  };
  return {
    codemode: stateFor(/codemode|code.?mode/i, "registered but not currently active"),
    subagents: stateFor(/^(?:subagent|subagents)$/i, "activation is owned by Pi/pi-subagents and the user"),
    subagentLoader: stateFor(/^subagents_enable$/i),
    await: {
      watch: stateFor(/^watch$/),
      status: stateFor(/^watches$/),
      cancel: stateFor(/^unwatch$/),
    },
    askUserQuestions: stateFor(/ask.*user.*question|ask_user_question|ask.*question/i, "registered but not currently active"),
  };
}

function registerStateSnapshotTool(pi: any) {
  return registerOnce(pi, "compass_state", {
    label: "Compact Goal State",
    description: "Read compact Goal/plan/acceptance state and native capability availability when prior results are insufficient. Pass a previous cursor for deltas; omit it for a fresh snapshot. Exact cursors return a small unchanged envelope. This is not independent Goal verification.",
    promptSnippet: "Read Goal continuity or event deltas on demand; do not poll.",
    promptGuidelines: [
      "Use compass_state only when existing messages/results do not answer the current state question; pass its returned cursor for later deltas.",
    ],
    parameters: Type.Object({
      cursor: Type.Optional(Type.String({ pattern: "^R[0-9]+-E[0-9]+$", maxLength: 32, description: "Opaque cursor returned by compass_state, e.g. R213-E166." })),
      maxEvents: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: "Maximum event summaries in the delta; defaults to 8." })),
    }, { additionalProperties: false }),
    async execute(_id: string, params: any, ...rest: any[]) {
      const ctx = getContext(rest);
      if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
      if (params?.maxEvents !== undefined && (!Number.isInteger(params.maxEvents) || params.maxEvents < 1 || params.maxEvents > 8)) throw new Error("maxEvents must be an integer from 1 to 8. No state changed.");
      const snapshot = buildStateSnapshot(state, params?.cursor ?? null, {
        ...toolInventory(pi),
        compassActive: activeCapabilities(),
      });
      if (Number.isInteger(params?.maxEvents) && snapshot.delta?.events?.length > params.maxEvents) {
        snapshot.delta.omitted += snapshot.delta.events.length - params.maxEvents;
        snapshot.delta.events = snapshot.delta.events.slice(-params.maxEvents);
      }
      if (snapshot.unchanged) {
        return readResult(JSON.stringify(snapshot), { cursor: snapshot.cursor, unchanged: true, stateRevision: snapshot.stateRevision });
      }
      return readResult(JSON.stringify(snapshot), { cursor: snapshot.cursor, hasNewEvents: snapshot.delta?.hasNewEvents ?? false, stateRevision: snapshot.stateRevision });
    },
  });
}

function contextBoundaryPreview(ctx: any) {
  const projection = ctx?.sessionManager?.buildSessionProjection?.();
  if (!projection) return { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true };
  return {
    contextEntries: projection.entries,
    contextMessages: projection.messages,
    llmMessages: projection.messages,
    pendingMessages: [],
    canContinue: true,
  };
}
function restoreContext(ctx: any) {
  try {
    const branch = ctx?.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) throw new Error("Native active-branch context is unavailable; no context state was reset.");
    contextState = restoreContextState(branch);
    return contextState;
  } catch (error) {
    // Hook exceptions alone do not stop Pi's provider request. Abort through the
    // public lifecycle API if a context commit is corrupt or incomplete.
    ctx?.abort?.();
    throw error;
  }
}
function contextOperationSchema() {
  const sourceId = Type.String({ minLength: 1, maxLength: 64, description: "Stable source entry ID returned by compass_context search; never use a message index." });
  const version = Type.String({ pattern: "^[a-f0-9]{24}$", maxLength: 24, description: "Source version returned by search; edits fail closed if it changed." });
  return Type.Object({
    action: Type.String({ enum: ["call", "return", "search", "pin", "unpin", "replace", "drop"] }),
    expectedRevision: Type.Integer({ minimum: 0, description: "Context revision from the latest compass_context result." }),
    task: Type.Optional(Type.String({ minLength: 1, maxLength: 4000, description: "Required for call: the local procedure and objective." })),
    capture: Type.Optional(Type.Array(Type.Object({ id: sourceId, mode: Type.String({ enum: ["ref", "copy"] }), version }, { additionalProperties: false }), { maxItems: 64, uniqueItems: true })),
    exportIds: Type.Optional(Type.Array(sourceId, { maxItems: 64, uniqueItems: true, description: "Sources explicitly returned to the parent frame; default none." })),
    ids: Type.Optional(Type.Array(sourceId, { maxItems: 64, uniqueItems: true, description: "Sources for pin/unpin/replace/drop." })),
    version: Type.Optional(version),
    versions: Type.Optional(Type.Array(Type.Object({ id: sourceId, version }, { additionalProperties: false }), { maxItems: 64, uniqueItems: true, description: "Required for action=drop: the observed version of every selected source." })),
    content: Type.Optional(Type.String({ minLength: 1, maxLength: 8000, description: "Replacement content for action=replace." })),
    result: Type.Optional(Type.String({ maxLength: 8000, description: "Optional bounded return value for action=return." })),
    query: Type.Optional(Type.String({ maxLength: 400, description: "Search terms for action=search; lookup is on demand, not mandatory." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
  }, { additionalProperties: false });
}
function registerContextTool(pi: any) {
  return registerOnce(pi, "compass_context", {
    label: "Context Frames",
    description: "Manage same-session attention frames without starting another Pi session. call enters a local task with explicit ref/copy capture; return restores the parent view with explicit exports. search returns stable source IDs and versions. replace/drop use optimistic version checks and preserve Human messages/tool exchanges.",
    promptSnippet: "Use same-session context frames only when isolating attention reduces total work; capture and export are explicit and default to none.",
    promptGuidelines: [
      "This changes the next native context projection, not Pi's append-only transcript or the filesystem.",
      "Use search only when needed. Pass stable source IDs and versions; never infer them from message positions.",
      "A ref is a shared logical slot and survives frame failure/interruption; a copy is local. Do not edit or drop Human messages.",
      "A frame cannot return while it owns active pi-await watches; cancel or explicitly transfer them first.",
    ],
    parameters: contextOperationSchema(),
    async execute(toolCallId: string, params: any, ...rest: any[]) {
      return serialized(async () => {
        const ctx = getContext(rest);
        if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
        restoreContext(ctx);
        const action = String(params?.action ?? "");
        if (!Number.isInteger(params?.expectedRevision) || params.expectedRevision !== contextState.revision) {
          throw new Error(`Stale context revision ${params?.expectedRevision}; current revision is ${contextState.revision}. No context changed.`);
        }
        if (action === "search") {
          const branch = ctx?.sessionManager?.getBranch?.() ?? [];
          const result = searchContext(branch, { context: contextBoundaryPreview(ctx) }, contextState, params);
          return readResult(JSON.stringify(result), { contextRevision: contextState.revision, hits: result.hits.length });
        }
        if (!["call", "return", "pin", "unpin", "replace", "drop"].includes(action)) {
          throw new Error(`Unknown context action ${action}. No context changed.`);
        }
        const operation = { ...params, callId: toolCallId };
        return {
          content: [{ type: "text", text: `Context action ${action} queued for the native turn boundary; no new session or Agent Loop will be created.` }],
          details: { contextOperation: operation, contextRevision: contextState.revision },
        };
      });
    },
  });
}
function contextCwd(ctx: any) {
  return typeof ctx?.cwd === "string" && ctx.cwd.trim() ? ctx.cwd : process.cwd();
}
function capabilitiesFor() {
  return availableCapabilities(state);
}

function ensureLoader(pi: any): string {
  const loaded = new Set(activeCapabilities());
  const caps = capabilitiesFor().filter((name) => !loaded.has(name));
  const signature = caps.join("|");
  if (!caps.length) {
    loaderSignature = "";
    loaderName = "";
    return "";
  }
  if (loaderName && signature === loaderSignature) return loaderName;
  loaderSignature = signature;
  const name = "compass_open";
  pi.registerTool({
    name,
    label: "Compass Open",
    description: `Load one or more missing Compass capability groups in one call. Currently openable: ${caps.join(", ")}. Loaded groups are omitted from this schema; do not reopen them.`,
    promptSnippet: "Open missing capability groups once, in one batch. Do not reopen groups already loaded just to refresh tool visibility.",
    promptGuidelines: [
      "This schema contains only currently applicable, not-yet-loaded groups. It changes with Goal structure and recorded evidence; do not search for hidden groups or retry stale names.",
      "Load missing capability groups in one batch when their operations or details will help the next step; loaded groups are additive.",
      "Loaded groups no longer appear in this schema. If any requested group is unavailable, the atomic request loads none.",
      "Compass mutation results carry current state; use compass_state only for missing information. Runtime validates dependencies; the Agent chooses the route. Planning visibility does not create a DAG.",
    ],
    parameters: Type.Object({
      capabilities: Type.Array(Type.String({ enum: caps, description: "Capability group currently applicable to this Goal state." }), {
        minItems: 1, maxItems: caps.length, uniqueItems: true,
        description: "Missing capability groups needed for the next step; loaded groups are not options.",
      }),
    }, { additionalProperties: false }),
    async execute(_toolCallId: string, params: any, ...rest: any[]) {
      return serialized(async () => {
        const requested = Array.isArray(params?.capabilities) ? params.capabilities : [];
        if (!requested.length || new Set(requested).size !== requested.length) {
          throw new Error("capabilities must contain one or more unique capability names. No state changed.");
        }
        const invalidAtLoad = requested.filter((capability: string) => !caps.includes(capability));
        if (invalidAtLoad.length) throw new Error(`Unavailable capability: ${invalidAtLoad.join(", ")}. Available: ${caps.join(", ")}. No state changed.`);
        const ctx = getContext(rest);
        if (needsRestore) {
          state = restoreState(ctx);
          needsRestore = false;
          state.projectRoot = contextCwd(ctx);
          ensureLoader(pi);
        }
        const currentCaps = capabilitiesFor();
        const invalidNow = requested.filter((capability: string) => !currentCaps.includes(capability) || activeCapabilities().includes(capability));
        if (invalidNow.length) throw new Error(`Capability no longer applicable: ${invalidNow.join(", ")}. Current openable set: ${currentCaps.filter((capability: string) => !activeCapabilities().includes(capability)).join(", ")}. No state changed.`);
        const before = activeCapabilities();
        const added = requested.filter((capability: string) => !before.includes(capability));
        const alreadyLoaded = requested.filter((capability: string) => before.includes(capability));
        if (!added.length) {
          return readResult(`No change; already loaded: ${alreadyLoaded.join(", ")}.`, { added, alreadyLoaded, activeCapabilities: before });
        }
        setActiveCapabilities([...before, ...added]);
        state.projectRoot = contextCwd(ctx);
        // Do not change tool registry inside this model response. The next context
        // boundary exposes the union of loaded capabilities and current schemas.
        loadoutRefreshPending = true;
        persistState(pi);
        return stateResult(`Loaded: ${added.join(", ")}.`, { activeCapabilities: activeCapabilities(), added, alreadyLoaded });
      });
    },
  });
  loaderName = name;
  return name;
}
function capabilitySchemaSignature(capability: string): string {
  // Operation schemas stay stable across ordinary state changes. Runtime
  // validates IDs/statuses at execution, avoiding stale-schema "tool not found".
  if (capability === "planning") return "planning-operations-v1";
  if (capability === "goal_change") return "goal-change-v1";
  if (capability === "acceptance") return "acceptance-v1";
  if (capability === "history") return `history-v1|dag:${state.plan.tasks.length > 0}`;
  return "fixed";
}
function loadoutSignature(capabilities: string[]) {
  return [...new Set(capabilities)].sort().map((capability) => `${capability}|${capabilitySchemaSignature(capability)}`).join("||");
}
function registerActiveCapabilityGroups(pi: any): string[] {
  const active = activeCapabilities();
  if (state.goal.criteria?.some((item: any) => item.goalVersion === state.goal.version) && !active.includes("acceptance")) {
    setActiveCapabilities([...active, "acceptance"]);
  }
  return [...new Set(activeCapabilities().flatMap((capability) => registerCapabilityGroup(pi, capability)))];
}

function taskDefinitionSchema() {
  return Type.Object({
    id: Type.String({ minLength: 1, maxLength: 40, pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,39}$", description: "Stable ID: starts with a letter; letters, digits, underscore, hyphen only." }),
    title: Type.String({ minLength: 1, maxLength: 200, description: "Short task title." }),
    dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40, pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,39}$" }), { maxItems: 24, uniqueItems: true, description: "Real prerequisite task IDs; omit or use [] for none." })),
    acceptance: Type.String({ minLength: 1, maxLength: 400, description: "Observable completion condition for this subgoal." }),
    output: Type.Optional(Type.String({ maxLength: 400, description: "Expected artifact/evidence, if useful." })),
    executor: Type.Optional(Type.String({ enum: ["parent", "code", "subagent"], description: "Execution route: parent for semantic/coupled work; code for deterministic batching in Code Mode; subagent for bounded semantic read-only investigation. Defaults to parent." })),
    agent: Type.Optional(Type.String({ enum: ["scout", "researcher", "reviewer", "evidence-auditor", "delegate", "oracle"], description: "pi-subagents role, used only when executor=subagent. Defaults to scout." })),
    writeScope: Type.Optional(Type.String({ maxLength: 200, description: "Owned path/file/directory/glob scope for writable tasks, or exact value read-only for read-only investigations. A subagent task must be read-only." })),
    dispatchReason: Type.Optional(Type.String({ minLength: 12, maxLength: 400, description: "Required when executor=subagent: why a separate semantic context is worth the extra model call instead of using parent reasoning or deterministic Code Mode. Prefer independent exploration, coverage, or review; do not delegate trivial deterministic work." })),
  }, { additionalProperties: false });
}
function planCreateSchema() {
  return Type.Object({
    acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12, description: "Final observable acceptance conditions; do not invent unknown product semantics." }),
    tasks: Type.Array(taskDefinitionSchema(), { minItems: 2, maxItems: 24, description: "Only use a DAG for genuine dependencies or independent tracks. Include the whole graph and choose executor per task. A Subagent task must be read-only and explain why the extra semantic call is worth it in dispatchReason; otherwise use parent or code." }),
  }, { additionalProperties: false });
}
function planReviseSchema() {
  return Type.Object({
    expectedStateVersion: Type.Integer({ minimum: 0, maximum: 1_000_000_000, description: "State version observed in the latest plan status. Runtime checks it; stale revisions are rejected without mutation." }),
    changeReason: Type.String({ minLength: 1, maxLength: 600, description: "Why new evidence materially changes dependencies or the route." }),
    acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 12 }),
    tasks: Type.Array(taskDefinitionSchema(), { minItems: 2, maxItems: 24, description: "Full revised DAG. Unchanged task IDs and definitions preserve state; changed definitions and affected descendants may reset. Subagent tasks must be read-only and justify the extra semantic call in dispatchReason." }),
  }, { additionalProperties: false });
}

function registerCapabilityGroup(pi: any, capability: string): string[] {
  const names: string[] = [];
  const activeCheck = (expected: string) => assertCapability(expected);

  if (capability === "planning") {
    if (!state.plan.goal || !state.plan.tasks.length) {
      names.push(registerOnce(pi, "compass_plan_create", {
        label: "Create Goal DAG",
        description: "Create the initial dependency DAG for a complex Goal. After this tool's execution boundary, Compass automatically dispatches explicitly routed read-only Subagent tasks through pi-subagents and consumes their structured results; parent and Code Mode tasks remain for the main Agent. Use only for real dependencies or independent work; simple Goals need no DAG.",
        promptSnippet: "Create a small DAG only when the Goal has real dependencies or independent tracks.",
        parameters: planCreateSchema(),
        async execute(_id: string, params: any, ...rest: any[]) {
          return serialized(async () => {
            const ctx = getContext(rest);
            if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
            activeCheck("planning");
            if (state.plan.goal && state.plan.tasks.length) throw new Error("A DAG already exists. Use compass_plan_revise; no state changed.");
            if (!state.goal.current) throw new Error("No Goal has been captured from the Human's initial prompt.");
            const planned = noMutation(() => revisePlanState(state, { acceptanceCriteria: params.acceptanceCriteria, tasks: params.tasks }));
            state = planned.state;
            setActiveCapabilities([...activeCapabilities(), "acceptance"]);
            state.autoActivation = null;
            afterMutation(pi, contextCwd(ctx));
            const ready = readyTasks(state.plan).map((task: any) => task.id);
            return stateResult(`DAG created (r${state.plan.revision}); ${state.plan.tasks.length} tasks; ready: ${ready.join(", ") || "none"}. Acceptance tracking is active.`, { mutation: "plan_create", revision: state.plan.revision, ready });
          });
        },
      }));
      return names;
    }

    names.push(registerOnce(pi, "compass_plan_status", {
      label: "DAG Status",
      description: "Read current DAG progress and the code-derived ready task set. Returns structured revision/stateVersion/tasks/ready/blocked fields; use stateVersion directly rather than parsing the prose summary.",
      promptSnippet: "Inspect DAG progress when the next action depends on task status.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id: string, _params: any, ...rest: any[]) {
        const ctx = getContext(rest);
        if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
        activeCheck("planning");
        const plan = state.plan;
        const acceptance = acceptanceStatus(state);
        const outcome = goalOutcomeStatus(state);
        const ready = readyTasks(plan).map((task: any) => task.id);
        const blocked = plan.tasks.filter((task: any) => task.status === "blocked").map((task: any) => task.id);
        return readResult(summarizePlanStatus(state), {
          revision: plan.revision ?? 0,
          stateVersion: plan.stateVersion ?? 0,
          total: plan.tasks.length,
          done: plan.tasks.filter((task: any) => task.status === "done").length,
          inProgress: plan.tasks.filter((task: any) => task.status === "in_progress").map((task: any) => task.id),
          ready,
          blocked,
          tasks: plan.tasks.map((task: any) => ({ id: task.id, title: clip(task.title, 100), status: task.status, dependsOn: task.dependsOn, executor: task.executor || "parent", ...(task.executor === "subagent" ? { agent: task.agent || "scout" } : {}), writeScope: task.writeScope || null, reason: task.reason ? clip(task.reason, 140) : null })),
          acceptance: { status: acceptance.status, total: acceptance.total, reportedPass: acceptance.passed, failed: acceptance.failed, blocked: acceptance.blocked, unverified: acceptance.unverified },
          goalOutcome: outcome,
          execution: plan.execution ? clone(plan.execution) : null,
          executionHistory: clone(plan.executionHistory ?? []),
        });
      },
    }));
    names.push(registerOnce(pi, "compass_plan_revise", {
      label: "Revise Goal DAG",
      description: "Revise the full DAG only when new evidence materially changes the route. Submit expectedStateVersion from the latest status; unchanged tasks preserve state. Ready tasks explicitly routed to read-only Subagents are auto-dispatched after this tool completes.",
      promptSnippet: "Revise only after material new evidence; stale state versions are rejected without mutation.",
      parameters: planReviseSchema(),
      async execute(_id: string, params: any, ...rest: any[]) {
        return serialized(async () => {
          const ctx = getContext(rest);
          if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
          activeCheck("planning");
          if (!state.plan.goal || !state.plan.tasks.length) throw new Error("No DAG exists. Create one only if real dependencies or independent tracks justify it.");
          if (params.expectedStateVersion !== (state.plan.stateVersion ?? 0)) throw new Error(`Stale plan state version ${params.expectedStateVersion}; current version is ${state.plan.stateVersion ?? 0} (DAG revision ${state.plan.revision}). Read current status and revise from the latest state; no changes were made.`);
          const before = state.plan.revision;
          const eventSeqBefore = state.eventSeq ?? 1;
          const beforeStatuses = new Map(state.plan.tasks.map((task: any) => [task.id, { status: task.status, reason: task.reason || "" }]));
          const { expectedStateVersion: _expectedStateVersion, ...revisionInput } = params;
          const result = noMutation(() => revisePlanState(state, revisionInput));
          state = result.state;
          const changed = result.changed || (state.eventSeq ?? 1) !== eventSeqBefore;
          const invalidatedDetails = state.plan.tasks.filter((task: any) => {
            const beforeStatus = beforeStatuses.get(task.id)?.status;
            return ["done", "in_progress", "blocked"].includes(beforeStatus) && task.status === "pending";
          }).map((task: any) => ({
            id: task.id,
            from: beforeStatuses.get(task.id)?.status,
            to: task.status,
            reason: task.reason || "Task definition or dependency changed during plan revision.",
          }));
          const reset = invalidatedDetails.map((item: any) => item.id);
          const readyNow = readyTasks(state.plan).map((task: any) => task.id);
          const blockedNow = state.plan.tasks.filter((task: any) => task.status === "blocked").map((task: any) => task.id);
          if (changed) afterMutation(pi, contextCwd(ctx));
          const invalidatedText = invalidatedDetails.length
            ? ` Invalidated work: ${invalidatedDetails.map((item: any) => `${item.id} (${item.from} → pending; ${clip(item.reason, 100)})`).join("; ")}.`
            : "";
          return stateResult(`DAG ${state.plan.revision === before ? "unchanged" : `revised r${state.plan.revision}`}; state v${state.plan.stateVersion}. Ready: ${readyNow.join(", ") || "none"}.${invalidatedText}${blockedNow.length ? ` Blocked: ${blockedNow.join(", ")}.` : ""}`, { mutation: "plan_revise", unchanged: !changed, revision: state.plan.revision, stateVersion: state.plan.stateVersion, ready: readyNow, invalidated: reset, invalidatedDetails, blocked: blockedNow });
        });
      },
    }));

    const taskId = () => Type.String({ minLength: 1, maxLength: 40, pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,39}$", description: "Task ID from the current DAG. Runtime validates current status and dependencies." });
    names.push(registerOnce(pi, "compass_task", {
      label: "Update DAG Tasks",
      description: "One stable task-lifecycle tool. action=start requires taskIds only; done requires tasks with id/evidence; block and reopen require tasks with id/reason. Subagent-routed tasks are started and completed by Compass automatically; do not manually start them. Runtime rejects mismatched fields, stale IDs, invalid dependencies, and changes to tasks in an unresolved Subagent batch.",
      promptSnippet: "Use action=start with taskIds; use action=done/block/reopen with tasks. For done provide concrete evidence; for block/reopen provide a reason. Do not mix the two input shapes.",
      parameters: Type.Object({
        action: Type.String({ enum: ["start", "done", "block", "reopen"] }),
        taskIds: Type.Optional(Type.Array(taskId(), { minItems: 1, maxItems: 24, uniqueItems: true, description: "Required only for action=start." })),
        tasks: Type.Optional(Type.Array(Type.Object({
          id: taskId(),
          evidence: Type.Optional(Type.String({ minLength: 1, maxLength: 1600, description: "Required only for action=done; concrete command result, test output, artifact path, or observed behavior." })),
          reason: Type.Optional(Type.String({ minLength: 1, maxLength: 600, description: "Required only for action=block or reopen." })),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 24, uniqueItems: true, description: "Required for done/block/reopen; use only the fields allowed for the selected action." })),
      }, { additionalProperties: false }),
      async execute(_id: string, params: any, ...rest: any[]) {
        return serialized(async () => {
          const ctx = getContext(rest);
          if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
          activeCheck("planning");
          const action = String(params?.action ?? "");
          const hasTaskIds = Object.prototype.hasOwnProperty.call(params ?? {}, "taskIds");
          const taskIds = Array.isArray(params?.taskIds) ? params.taskIds : [];
          const tasks = Array.isArray(params?.tasks) ? params.tasks : [];
          if (action === "start") {
            if (!taskIds.length || Object.prototype.hasOwnProperty.call(params ?? {}, "tasks") || !Array.isArray(params?.taskIds)) throw new Error('action="start" requires taskIds and forbids tasks. No state changed.');
          } else if (["done", "block", "reopen"].includes(action)) {
            if (!tasks.length || hasTaskIds || !Array.isArray(params?.tasks)) throw new Error(`action="${action}" requires tasks and forbids taskIds. No state changed.`);
            for (const [index, item] of tasks.entries()) {
              const hasEvidence = Object.prototype.hasOwnProperty.call(item ?? {}, "evidence");
              const hasReason = Object.prototype.hasOwnProperty.call(item ?? {}, "reason");
              if (action === "done" && (typeof item?.evidence !== "string" || !item.evidence.trim() || hasReason)) throw new Error(`tasks[${index}] for action=done requires non-empty evidence and forbids reason. No state changed.`);
              if ((action === "block" || action === "reopen") && (typeof item?.reason !== "string" || !item.reason.trim() || hasEvidence)) throw new Error(`tasks[${index}] for action=${action} requires non-empty reason and forbids evidence. No state changed.`);
            }
          } else throw new Error('action must be one of "start", "done", "block", or "reopen". No state changed.');
          if (action === "start") {
            const delegated = taskIds.filter((id: string) => state.plan.tasks.find((task: any) => task.id === id)?.executor === "subagent");
            if (delegated.length) throw new Error(`Subagent-routed task(s) ${delegated.join(", ")} are started by Compass after DAG mutations; do not start them manually. No state changed.`);
          }
          const execution = state.plan.execution;
          if (execution && ["dispatching", "running", "unknown"].includes(execution.status)) {
            const requestedIds = action === "start" ? taskIds : tasks.map((item: any) => item.id);
            const overlap = requestedIds.filter((id: string) => execution.taskIds.includes(id));
            if (overlap.length) throw new Error(`Task(s) ${overlap.join(", ")} belong to unresolved Subagent batch ${execution.requestId}; reconcile the batch before changing their status. No state changed.`);
          }
          const items = action === "start" ? taskIds.map((id: string) => ({ id })) : tasks;
          const result = noMutation(() => transitionTasks(state, action, items, updateTasks));
          state = result.state;
          const readyNow = readyTasks(state.plan).map((task: any) => task.id);
          const remaining = state.plan.tasks.filter((task: any) => task.status !== "done").length;
          afterMutation(pi, contextCwd(ctx));
          if (action === "start") return stateResult(`Started: ${result.affected.join(", ")}. Ready next: ${readyNow.join(", ") || "none"}.`, { mutation: "task_start", affected: result.affected, ready: readyNow });
          if (action === "done") {
            const direct = result.completedWithoutStart ?? [];
            return stateResult(`Done: ${result.affected.join(", ")}.${direct.length ? ` Completed directly from ready/pending: ${direct.join(", ")}.` : ""} Ready: ${readyNow.join(", ") || "none"}. Remaining: ${remaining}.`, { mutation: "task_done", affected: result.affected, completedWithoutStart: direct, ready: readyNow, remaining });
          }
          if (action === "block") return stateResult(`Blocked: ${result.affected.join(", ")}. Other ready: ${readyNow.join(", ") || "none"}.`, { mutation: "task_block", affected: result.affected, ready: readyNow });
          const roots = tasks.map((item: any) => item.id);
          const downstream = result.affected.filter((id: string) => !roots.includes(id));
          return stateResult(`Reopened: ${roots.join(", ")}. Downstream invalidated: ${downstream.join(", ") || "none"}. Ready: ${readyNow.join(", ") || "none"}.`, { mutation: "task_reopen", affected: result.affected, roots, downstream, ready: readyNow });
        });
      },
    }));
    if (state.plan.execution && ["dispatching", "running", "unknown", "failed"].includes(state.plan.execution.status)) {
      names.push(registerOnce(pi, "compass_execution", {
        label: "Subagent Execution Recovery",
        description: "Read the current auto-dispatch batch or reconcile an unknown batch after checking native Subagent status. Resolve is available only for status=unknown, requires the exact requestId, explicit confirmation that no child run remains active, and a result for every task. Never use resolve as a substitute for checking run status.",
        promptSnippet: "If a Subagent batch is unknown, inspect its recorded run IDs with native Subagent status first. Resolve only after proving no child remains active; otherwise do not retry or revise the DAG.",
        parameters: Type.Object({
          action: Type.String({ enum: ["status", "resolve"] }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Exact request ID from the current unresolved batch." })),
          confirmedNoActiveRuns: Type.Optional(Type.Boolean({ description: "Must be true only after checking native Subagent status and confirming none of the recorded child runs remains active." })),
          confirmationEvidence: Type.Optional(Type.String({ minLength: 12, maxLength: 600, description: "Observed status output or other concrete evidence that no recorded child remains active." })),
          results: Type.Optional(Type.Array(Type.Object({
            id: taskId(),
            status: Type.String({ enum: ["done", "blocked"] }),
            evidence: Type.Optional(Type.String({ minLength: 1, maxLength: 1600 })),
            reason: Type.Optional(Type.String({ minLength: 1, maxLength: 600 })),
          }, { additionalProperties: false }), { minItems: 1, maxItems: 6, uniqueItems: true })),
        }, { additionalProperties: false }),
        async execute(_id: string, params: any, ...rest: any[]) {
          return serialized(async () => {
            const ctx = getContext(rest);
            if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
            activeCheck("planning");
            const execution = state.plan.execution;
            if (params.action === "status") {
              if (Object.keys(params).some((key) => key !== "action")) throw new Error('action="status" accepts no additional fields. No state changed.');
              if (!execution) return readResult("No Subagent execution record exists.", { execution: null });
              return readResult(`Subagent batch ${execution.status}; tasks=${(execution.taskIds ?? []).join(",")}; request=${execution.requestId}. ${execution.error || ""}`.trim(), { execution: clone(execution) });
            }
            if (params.action !== "resolve") throw new Error('action must be "status" or "resolve". No state changed.');
            if (!execution || execution.status !== "unknown") throw new Error("Only an unknown Subagent batch can be manually reconciled. No state changed.");
            if (params.requestId !== execution.requestId) throw new Error("requestId does not match the current unknown batch. Read compass_execution(action=status); no state changed.");
            if (params.confirmedNoActiveRuns !== true || typeof params.confirmationEvidence !== "string" || params.confirmationEvidence.trim().length < 12) {
              throw new Error("Resolve requires confirmedNoActiveRuns=true and concrete confirmationEvidence from checking native Subagent status. No state changed.");
            }
            if (!Array.isArray(params.results) || params.results.length !== execution.taskIds.length) {
              throw new Error(`Resolve requires one result for every batch task: ${(execution.taskIds ?? []).join(", ")}. No state changed.`);
            }
            const resultById = new Map<string, any>();
            for (const item of params.results) {
              if (!execution.taskIds.includes(item.id) || resultById.has(item.id)) throw new Error(`Unexpected or duplicate task result "${item.id}". No state changed.`);
              if (item.status === "done" && (typeof item.evidence !== "string" || !item.evidence.trim() || Object.prototype.hasOwnProperty.call(item, "reason"))) {
                throw new Error(`Resolved done task "${item.id}" requires evidence and forbids reason. No state changed.`);
              }
              if (item.status === "blocked" && (typeof item.reason !== "string" || !item.reason.trim() || Object.prototype.hasOwnProperty.call(item, "evidence"))) {
                throw new Error(`Resolved blocked task "${item.id}" requires reason and forbids evidence. No state changed.`);
              }
              resultById.set(item.id, item);
            }
            if (execution.taskIds.some((id: string) => !resultById.has(id))) throw new Error("Resolve results must cover the exact batch task set. No state changed.");

            for (const taskIdValue of execution.taskIds) {
              const item = resultById.get(taskIdValue);
              const currentTask = state.plan.tasks.find((task: any) => task.id === taskIdValue);
              if (!currentTask) throw new Error(`Task "${taskIdValue}" no longer exists in the current DAG. No state changed.`);
              if (currentTask.status === "done" || currentTask.status === "blocked") {
                if (currentTask.status !== item.status) throw new Error(`Task "${taskIdValue}" is already ${currentTask.status}; reconciliation cannot contradict that state. No state changed.`);
                continue;
              }
              if (currentTask.status !== "in_progress") throw new Error(`Task "${taskIdValue}" is ${currentTask.status}; expected in_progress for reconciliation. No state changed.`);
            }
            const doneItems = params.results.filter((item: any) => item.status === "done" && state.plan.tasks.find((task: any) => task.id === item.id)?.status === "in_progress");
            const blockedItems = params.results.filter((item: any) => item.status === "blocked" && state.plan.tasks.find((task: any) => task.id === item.id)?.status === "in_progress");
            if (doneItems.length) state = transitionTasks(state, "done", doneItems.map((item: any) => ({ id: item.id, evidence: item.evidence })), updateTasks).state;
            if (blockedItems.length) state = transitionTasks(state, "block", blockedItems.map((item: any) => ({ id: item.id, reason: item.reason })), updateTasks).state;
            const latest = state.plan.execution;
            if (!latest || latest.requestId !== params.requestId) throw new Error("Execution record changed during reconciliation. No state changed.");
            latest.results = latest.results.map((item: any) => {
              const supplied = resultById.get(item.id);
              return supplied ? {
                ...item,
                status: supplied.status,
                error: supplied.status === "blocked" ? clip(supplied.reason, 600) : "",
                summary: supplied.status === "done" ? clip(supplied.evidence, 800) : item.summary,
              } : item;
            });
            latest.status = "completed";
            latest.completedAt = now();
            latest.error = `Manually reconciled after confirmation: ${clip(params.confirmationEvidence, 400)}`;
            const historyRows = latest.results || [];
            const historyCost = historyRows.every((item: any) => Number.isFinite(item.usage?.cost) && (!item.fallbackAttempted || Number.isFinite(item.primaryUsage?.cost)))
              ? historyRows.reduce((sum: number, item: any) => sum + item.usage.cost + (item.fallbackAttempted ? item.primaryUsage.cost : 0), 0)
              : null;
            const historyDuration = historyRows.every((item: any) => Number.isFinite(item.usage?.durationMs) && (!item.fallbackAttempted || Number.isFinite(item.primaryUsage?.durationMs)))
              ? historyRows.reduce((sum: number, item: any) => sum + item.usage.durationMs + (item.fallbackAttempted ? item.primaryUsage.durationMs : 0), 0)
              : null;
            const historyWall = Math.max(0, Date.parse(latest.completedAt) - Date.parse(latest.startedAt));
            state.plan.executionHistory = [...(state.plan.executionHistory || []), {
              requestId: latest.requestId,
              planRevision: latest.planRevision,
              taskIds: [...latest.taskIds],
              status: "completed",
              startedAt: latest.startedAt,
              completedAt: latest.completedAt,
              totalCost: historyCost,
              sumDurationMs: historyDuration,
              wallDurationMs: historyWall,
              estimatedParallelSavingsMs: Number.isFinite(historyDuration) ? historyDuration - historyWall : null,
              fallbackCount: historyRows.filter((item: any) => item.fallbackAttempted).length,
              metricsComplete: false,
              policyMode: latest.policy?.mode ?? "manual_reconcile",
              policyReason: clip(latest.policy?.reason ?? "Manually reconciled; no automatic scheduling policy was applied.", 400),
              source: "manual_reconcile",
            }].slice(-8);
            state = recordExecutionEvent(state, {
              status: "completed",
              summary: "Unknown Subagent batch manually reconciled after run-status check.",
              text: latest.error,
              ref: latest.requestId,
            });
            afterMutation(pi, contextCwd(ctx));
            return stateResult(`Reconciled Subagent batch ${latest.requestId}; tasks=${latest.taskIds.join(",")}. Ready: ${readyTasks(state.plan).map((task: any) => task.id).join(", ") || "none"}.`, {
              mutation: "execution_reconcile",
              requestId: latest.requestId,
              taskIds: latest.taskIds,
              ready: readyTasks(state.plan).map((task: any) => task.id),
            });
          });
        },
      }));
    }
    return names;
  }

  if (capability === "acceptance") {
    names.push(registerOnce(pi, "compass_acceptance_status", {
      label: "Acceptance Status",
      description: "Read current Goal acceptance criteria and evidence states. A reported pass is not independent verification; no criteria is an explicit state, not an error.",
      promptSnippet: "Read acceptance status when a milestone or Goal may be complete; define criteria only when they are meaningful.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id: string, _params: any, ...rest: any[]) {
        const ctx = getContext(rest);
        if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
        activeCheck("acceptance");
        const current = (state.goal.criteria ?? []).filter((item: any) => item.goalVersion === state.goal.version);
        if (!current.length) return readResult("No acceptance criteria are defined for the current Goal. Define a small observable set only if useful.", { status: "criteria_not_defined", total: 0, goalOutcome: goalOutcomeStatus(state) });
        return readResult([`Acceptance: ${JSON.stringify(acceptanceStatus(state))}`, `Goal outcome: ${JSON.stringify(goalOutcomeStatus(state))}`, ...current.map((item: any) => `${item.id} [${item.status}] ${clip(item.text, 160)}${item.evidence ? `; evidence: ${clip(item.evidence, 180)}` : ""}`)].join("\n"), { acceptance: current, status: acceptanceStatus(state), goalOutcome: goalOutcomeStatus(state) });
      },
    }));
    names.push(registerOnce(pi, "compass_acceptance_define", {
      label: "Define Acceptance Criteria",
      description: "Define or refine observable acceptance criteria for the current Goal. If a DAG exists, update criteria through plan revision to keep dependencies and acceptance consistent.",
      promptSnippet: "Define a small set of observable Goal-level acceptance criteria when needed.",
      parameters: Type.Object({ criteria: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 12, uniqueItems: true }) }, { additionalProperties: false }),
      async execute(_id: string, params: any, ...rest: any[]) {
        return serialized(async () => {
          const ctx = getContext(rest);
          if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
          activeCheck("acceptance");
          const result = noMutation(() => defineAcceptanceCriteria(state, params.criteria));
          state = result.state;
          if (result.changed) afterMutation(pi, contextCwd(ctx));
          return stateResult(`Acceptance criteria ${result.changed ? "updated" : "unchanged"}: ${result.criteria.map((item: any) => `${item.id} [${item.status}]`).join(", ")}.`, { mutation: "acceptance_define", unchanged: !result.changed, criteria: result.criteria.map((item: any) => item.id) });
        });
      },
    }));
    names.push(registerOnce(pi, "compass_acceptance_record", {
      label: "Record Acceptance Evidence",
      description: "Record an Agent-reported result for one current Goal criterion. Criterion IDs are checked at execution so defining/revising criteria does not make this tool disappear.",
      promptSnippet: "Record concise evidence after an actual test/command/observation; reported_pass is not independent verification.",
      parameters: Type.Object({
        criterionId: Type.String({ minLength: 1, maxLength: 24, description: "Current criterion ID, e.g. AC1. Runtime rejects unknown or stale IDs without mutation." }),
        status: Type.String({ enum: ["reported_pass", "failed", "blocked", "inconclusive"] }),
        evidence: Type.String({ minLength: 1, maxLength: 2000, description: "Concrete result or reason. Do not write only 'done'. Up to 2000 characters are accepted; prefer a concise outcome plus artifact/log reference." }),
      }, { additionalProperties: false }),
      async execute(_id: string, params: any, ...rest: any[]) {
        return serialized(async () => {
          const ctx = getContext(rest);
          if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
          activeCheck("acceptance");
          const result = noMutation(() => recordAcceptanceResult(state, { ...params, source: "agent_reported" }));
          state = result.state;
          if (result.changed) afterMutation(pi, contextCwd(ctx));
          return stateResult(result.changed
            ? `Recorded ${params.criterionId} as ${params.status}. Goal acceptance remains a report, not an independent verifier result.`
            : `No change: ${params.criterionId} already has the same status and evidence.`,
          { mutation: "acceptance_record", unchanged: !result.changed, criterionId: params.criterionId, status: params.status, summary: acceptanceStatus(state) });
        });
      },
    }));
    return names;
  }

  if (capability === "issue_review") {
    names.push(registerDynamic(pi, "compass_triage", {
      label: "Issue Review",
      description: "Read-only route review. Prefer short issue text plus current event IDs from compass_state; do not copy whole logs. Exact duplicate reviews with no new state return a compact reuse result.",
      promptSnippet: "Use a concise issue and reference existing event IDs instead of repeating long errors or history.",
      parameters: Type.Object({
        issue: Type.Optional(Type.String({ minLength: 1, maxLength: 4000, description: "Prefer a short issue label (<=240 chars) and event IDs. Inputs up to 4000 chars are accepted to avoid schema-rejection retries; only a 240-char preview is retained/displayed." })),
        evidenceRefs: Type.Optional(Type.Array(Type.String({ pattern: "^E[0-9]+$", maxLength: 16 }), { minItems: 1, maxItems: 8, uniqueItems: true, description: "Current-Goal event IDs returned by compass_state, e.g. E42. Runtime rejects missing or old-Goal references." })),
      }, { additionalProperties: false }),
      async execute(_id: string, params: any, ...rest: any[]) {
        return serialized(async () => {
          const ctx = getContext(rest);
          if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
          assertCapability("issue_review");
          const result = noMutation(() => triageIssue(state, params));
          if (result.duplicate) {
            return readResult(JSON.stringify({ duplicate: true, triageId: result.item.id, noRelevantStateChange: true, summary: result.summary }), { duplicate: true, triageId: result.item.id, issueTruncated: result.item.issueTruncated === true });
          }
          state = result.state;
          afterMutation(pi, contextCwd(ctx));
          return readResult(result.review, { triageId: result.item.id, evidenceRefs: result.item.evidenceRefs, basedOnEventId: result.item.basedOnEventId, issueTruncated: result.issueTruncated === true });
        });
      },
    }));
    return names;
  }

  if (capability === "history") {
    const decisionProperties: Record<string, any> = {
      summary: Type.String({ minLength: 1, maxLength: 320 }),
      rationale: Type.Optional(Type.String({ maxLength: 500 })),
      evidence: Type.Optional(Type.String({ maxLength: 1200, description: "Evidence/reference; stored bounded to 900 characters. Prefer concise source locations and observed outcomes." })),
      supersedesDecisionIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 32, pattern: "^D[0-9]+$" }), { maxItems: 8, uniqueItems: true, description: "Current-Goal decision IDs whose route/assumption is invalidated by this new evidence. Omit for a new independent decision." })),
    };
    if (state.plan.tasks.length) {
      decisionProperties.affectedTaskIds = Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 24, uniqueItems: true, description: "Optional related IDs from the current DAG." }));
    }
    const decisionSchema = Type.Object(decisionProperties, { additionalProperties: false });
    names.push(registerDynamic(pi, "compass_decision", {
      label: "Record Decision",
      description: "Record a material decision that may matter when debugging or replanning. Works with or without a DAG; explicitly supersede prior current-Goal decisions when new evidence invalidates their route.",
      promptSnippet: "Record material decisions, not every small choice. When new evidence invalidates an earlier decision, pass its current-Goal ID in supersedesDecisionIds so the old route is marked inactive rather than leaving contradictory decisions side by side.",
      parameters: decisionSchema,
      async execute(_id: string, params: any, ...rest: any[]) {
        return serialized(async () => {
          const ctx = getContext(rest);
          if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
          activeCheck("history");
          const result = noMutation(() => recordDecision(state, params));
          state = result.state;
          afterMutation(pi, contextCwd(ctx));
          const superseded = result.supersededDecisionIds ?? [];
          const impacted = result.impactedTaskIds ?? [];
          return stateResult(`Recorded ${result.item.id}: ${clip(result.item.summary, 220)}.${superseded.length ? ` Superseded prior decisions: ${superseded.join(", ")}.` : ""}${impacted.length ? ` Reassess potentially affected tasks: ${impacted.join(", ")}.` : ""}`, { mutation: "decision", id: result.item.id, supersededDecisionIds: superseded, potentiallyAffectedTaskIds: impacted });
        });
      },
    }));
    names.push(registerDynamic(pi, "compass_checkpoint", {
      label: "Record Checkpoint",
      description: "Record a meaningful checkpoint reference. A note is not a snapshot or rollback; ref must identify a genuinely recoverable state such as a Git commit.",
      promptSnippet: "Record a recoverable checkpoint only when it can help a future rollback or comparison.",
      parameters: Type.Object({
        summary: Type.String({ minLength: 1, maxLength: 320 }),
        ref: Type.Optional(Type.String({ maxLength: 500, description: "A real, recoverable reference; omit if none exists." })),
        evidence: Type.Optional(Type.String({ maxLength: 500 })),
      }, { additionalProperties: false }),
      async execute(_id: string, params: any, ...rest: any[]) {
        return serialized(async () => {
          const ctx = getContext(rest);
          if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
          activeCheck("history");
          const result = noMutation(() => recordCheckpoint(state, params));
          state = result.state;
          afterMutation(pi, contextCwd(ctx));
          return stateResult(`Recorded ${result.item.id}: ${clip(result.item.summary, 220)}. ${result.item.ref ? `Reference: ${result.item.ref}` : "No recoverable reference; this is only a planning marker."}`, { mutation: "checkpoint", id: result.item.id });
        });
      },
    }));
    names.push(registerOnce(pi, "compass_history_recent", {
      label: "Recent Compass Events",
      description: "Read a bounded, compact event history for debugging/replanning. It includes only recorded Goal changes, Human messages, decisions, checkpoints, writes, failures, and acceptance updates—not every raw tool result.",
      promptSnippet: "Read recent structured events when the current route may depend on earlier decisions or failures.",
      parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
      async execute(_id: string, params: any, ...rest: any[]) {
        const ctx = getContext(rest);
        if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
        activeCheck("history");
        const events = buildRecentEvents(state, params.limit ?? 12);
        return readResult(events.length ? events.map((item: any) => `- ${item.id} ${item.at} [${item.kind}] goal v${item.goalVersion}: ${clip(item.summary, 200)}${item.ref ? ` (ref ${item.ref})` : ""}`).join("\n") : "No structured events have been recorded.", { events });
      },
    }));
    return names;
  }

  if (capability === "goal_details") {
    names.push(registerOnce(pi, "compass_goal_read", {
      label: "Read Goal Details",
      description: "On-demand full original Goal, current Goal, retained hard constraints, and recent Human updates. The normal context contains a compact projection. Repeated reads of an unchanged Goal add no new evidence.",
      promptSnippet: "Read Goal details only when the compact anchor is insufficient; reuse the result unless Goal version/source changes or compaction removes required details.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id: string, _params: any, ...rest: any[]) {
        const ctx = getContext(rest);
        if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
        assertCapability("goal_details");
        return readResult(buildGoalDetails(state));
      },
    }));
    return names;
  }

  if (capability === "goal_change") {
    const updates = explicitGoalChangeUpdates(state);
    if (!updates.length) throw new Error("Goal change capability is not available without an explicit recorded Goal/scope change.");
    names.push(registerOnce(pi, "compass_goal_change", {
      label: "Resolve Goal Change",
      description: "Resolve a pending Human scope-change candidate. Use action=apply only after semantic review; use action=dismiss when the current Goal remains correct. Original Goal and prior evidence are retained. Applying archives the current DAG; no code is rolled back.",
      promptSnippet: "A pending candidate is not an applied Goal change. Apply it only when the Human message changes the current target; otherwise dismiss it so it does not remain pending.",
      parameters: Type.Object({
        updateId: Type.String({ minLength: 1, maxLength: 32, description: "ID of a recorded explicit Human Goal/scope update. Runtime rejects unknown or stale IDs without mutation." }),
        action: Type.String({ enum: ["apply", "dismiss"], description: "Apply the new Goal after review, or dismiss the candidate and retain the current Goal." }),
        newGoal: Type.Optional(Type.String({ minLength: 1, maxLength: 4000, description: "Optional override for action=apply. Omit to use the proposed Goal when one was extracted; if no proposal exists, provide newGoal. Override only to clarify without narrowing scope." })),
        acceptanceCriteria: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 12 })),
      }, { additionalProperties: false }),
      async execute(_id: string, params: any, ...rest: any[]) {
        return serialized(async () => {
          const ctx = getContext(rest);
          if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
          activeCheck("goal_change");
          if (params.action === "dismiss") {
            const result = noMutation(() => dismissGoalChangeCandidate(state, params));
            state = result.state;
            afterMutation(pi, contextCwd(ctx));
            return stateResult(`Dismissed scope-change candidate ${result.updateId}; Current Goal and plan remain unchanged.`, { mutation: "goal_change_dismissed", updateId: result.updateId });
          }
          if (params.action !== "apply") throw new Error('action must be "apply" or "dismiss". No state changed.');
          const result = noMutation(() => applyGoalChange(state, params));
          state = result.state;
          afterMutation(pi, contextCwd(ctx));
          return stateResult(`Current Goal changed using Human update ${result.updateId}. Original Goal retained. Previous DAG archived (${result.archivedTaskCount} task summaries); ${state.goal.criteria.length} acceptance criteria captured for the new Goal; no code was rolled back.`, { mutation: "goal_change", updateId: result.updateId, acceptanceCriteria: state.goal.criteria.length, sourceUpdateId: state.goal.sourceUpdateId });
        });
      },
    }));
    return names;
  }

  throw new Error(`Unknown Compass capability: ${capability}`);
}

function afterMutation(pi: any, cwd?: string) {
  const root = cwd || state.projectRoot || process.cwd();
  state.projectRoot = root;
  // Do not replace schemas or change active tools inside a model tool-call batch.
  // The next context/model-request boundary performs a single state-derived refresh.
  loadoutRefreshPending = true;
  persistState(pi);
}

function ensureCurrentLoadout(pi: any, ctx: any) {
  const root = contextCwd(ctx);
  const previousRoot = state.projectRoot;
  const projectRootChanged = previousRoot !== root;
  state.projectRoot = root;
  const currentNativeToolSignature = nativeToolSetSignature(pi);
  const nativeToolSetChanged = state.nativeToolSignature !== currentNativeToolSignature;
  if (nativeToolSetChanged) state.nativeToolSignature = currentNativeToolSignature;
  const allowed = capabilitiesFor();
  const beforeActive = activeCapabilities();
  const active = beforeActive.filter((capability) => allowed.includes(capability));
  if (state.goal.criteria?.some((item: any) => item.goalVersion === state.goal.version) && allowed.includes("acceptance") && !active.includes("acceptance")) active.push("acceptance");
  // Surface the resolver only when a Human message created a pending scope
  // candidate. This does not apply the candidate; the Agent must choose apply
  // or dismiss after reviewing the full message.
  if (explicitGoalChangeUpdates(state).length && allowed.includes("goal_change") && !active.includes("goal_change")) active.push("goal_change");
  setActiveCapabilities(active);
  const currentLoader = ensureLoader(pi);
  const tools = registerActiveCapabilityGroups(pi);
  const activeChanged = beforeActive.join("|") !== activeCapabilities().join("|");
  const desiredCompassNames = [...new Set([currentLoader, ...(state.goal.current ? ["compass_state", "compass_context"] : []), ...tools].filter(Boolean))];
  const desiredSignature = loadoutSignature(activeCapabilities());
  const visibleNames = activeNames(pi);
  const visibleCompassNames = visibleNames.filter((name) => isCompassName(name));
  const desiredSet = new Set(desiredCompassNames);
  const loadoutMismatch = desiredCompassNames.some((name) => !visibleNames.includes(name))
    || visibleCompassNames.some((name) => !desiredSet.has(name));
  const stateToolMissing = Boolean(state.goal.current) && !visibleNames.includes("compass_state");
  const contextToolMissing = Boolean(state.goal.current) && !visibleNames.includes("compass_context");
  if (desiredSignature !== lastLoadoutSignature || loadoutMismatch || (Boolean(currentLoader) && !visibleNames.includes(currentLoader)) || stateToolMissing || contextToolMissing || loadoutRefreshPending) {
    setCompassLoadout(pi, desiredCompassNames);
    lastLoadoutSignature = loadoutSignature(activeCapabilities());
    loadoutRefreshPending = false;
  }
  if (activeChanged || nativeToolSetChanged || projectRootChanged) persistState(pi);
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => part?.type === "text" && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n").trim();
}
function resultText(result: any): string {
  if (typeof result === "string") return result;
  if (typeof result?.output === "string") return result.output;
  if (typeof result?.text === "string") return result.text;
  return messageText({ content: result?.content });
}
function refreshAfterHumanInput(pi: any, ctx: any) {
  state.projectRoot = contextCwd(ctx);
  loadoutRefreshPending = true;
  // Surface planning operations early when the Human's own Goal explicitly
  // describes multiple parts/workstreams. This only changes tool visibility:
  // it never creates a DAG or requires the Agent to use it.
  maybeAutoActivatePlanning(state.projectRoot);
  const revisionBeforeLoadout = state.stateRevision ?? 0;
  ensureCurrentLoadout(pi, ctx);
  // Persist the Human update exactly once. ensureCurrentLoadout may already have
  // persisted a capability/root transition; avoid an extra revision for the same event.
  if ((state.stateRevision ?? 0) === revisionBeforeLoadout) persistState(pi);
}

function explicitWriteTargets(event: any): string[] {
  const tool = String(event?.toolName ?? "");
  if (!/^(edit|write|apply_patch|amend)$/i.test(tool)) return [];
  const input = event?.input ?? event?.args ?? {};
  const candidates = [input?.path, input?.file_path, input?.filePath, input?.target, input?.file]
    .filter((value: any) => typeof value === "string" && value.trim())
    .map((value: string) => value.trim());
  if (/^apply_patch$/i.test(tool)) {
    const patchText = [input?.patch, input?.diff, input?.content, input?.patchText]
      .filter((value: any) => typeof value === "string")
      .join("\n");
    const patchPaths = [];
    const patterns = [
      /^\*\*\*\s+(?:Update|Add|Delete) File:\s*(.+?)\s*$/gm,
      /^\+\+\+\s+b\/(.+?)\s*$/gm,
      /^---\s+a\/(.+?)\s*$/gm,
    ];
    for (const pattern of patterns) {
      for (const match of patchText.matchAll(pattern)) {
        const value = String(match[1] ?? "").trim();
        if (value && value !== "/dev/null") patchPaths.push(value);
      }
    }
    candidates.push(...patchPaths);
  }
  return [...new Set(candidates)].slice(0, 24);
}
function canonicalWriteTarget(targetValue: string, cwd?: string): string {
  const target = String(targetValue ?? "").trim().replace(/\\/g, "/");
  if (!target) return "";
  // Keep drive-qualified paths stable even if Pi runs on a POSIX host.
  if (/^[a-z]:\//i.test(target)) return target.toLowerCase().replace(/\/+/g, "/");
  return path.resolve(cwd || state.projectRoot || process.cwd(), target);
}

function maybeAutoActivatePlanning(cwd?: string): boolean {
  if (!state.goal.current || state.plan.tasks.length || activeCapabilities().includes("planning")) return false;
  const currentVersion = state.goal.version ?? 1;
  const root = cwd || state.projectRoot || process.cwd();
  const goalText = [
    state.goal.current,
    ...(state.goal.current === state.goal.original ? [state.goal.original] : []),
    state.goal.sourceUpdateText,
    ...state.goal.updates.filter((item: any) => item.goalVersion === currentVersion).slice(-2).map((item: any) => item.sourceText || item.text),
  ].filter((value) => typeof value === "string" && value.trim()).join("\n");
  const explicitSignal = planningActivationSignal(goalText);
  const keys = new Set();
  for (const item of state.trace.writes.filter((entry: any) => entry.goalVersion === currentVersion)) {
    const target = canonicalWriteTarget(item?.target ?? "", root);
    if (target) keys.add(target);
  }
  const reason = explicitSignal || (keys.size >= 3 ? `${keys.size} distinct write targets attempted` : "");
  if (!reason) return false;
  state.projectRoot = root;
  setActiveCapabilities([...activeCapabilities(), "planning"]);
  state.autoActivation = {
    capability: "planning",
    at: now(),
    reason,
    trigger: explicitSignal ? "explicit_goal_complexity" : "cross_file_writes",
  };
  loadoutRefreshPending = true;
  return true;
}

function maybeEscalateIssueReview(_pi: any) {
  // Defensive guard: an in-place extension reload can leave an older dependency
  // module cached. The versioned module path should prevent that; if a broken
  // install still occurs, failure recording must never throw from this hook.
  if (typeof shouldSurfaceIssueReview !== "function") return false;
  if (!shouldSurfaceIssueReview(state) || activeCapabilities().includes("issue_review")) return false;
  const available = capabilitiesFor();
  if (!available.includes("issue_review")) return false;
  setActiveCapabilities([...activeCapabilities(), "issue_review"]);
  loadoutRefreshPending = true;
  return true;
}

function supportsSameNameSchemaReplacement(pi: any): boolean {
  if (typeof pi.registerTool !== "function" || typeof pi.getAllTools !== "function") return false;
  const probeName = "compass_internal_schema_probe";
  const activeBefore = typeof pi.getActiveTools === "function" ? namesFrom(pi.getActiveTools()) : null;
  try {
    pi.registerTool({
      name: probeName,
      exposure: "hidden",
      label: "Internal schema replacement probe",
      description: "Internal preflight probe; never exposed to the model.",
      parameters: Type.Object({ firstProbeField: Type.String() }, { additionalProperties: false }),
      execute: async () => readResult("hidden preflight probe"),
    });
    pi.registerTool({
      name: probeName,
      exposure: "hidden",
      label: "Internal schema replacement probe",
      description: "Internal preflight probe; never exposed to the model.",
      parameters: Type.Object({ replacementProbeField: Type.String() }, { additionalProperties: false }),
      execute: async () => readResult("hidden preflight probe"),
    });
    const tool = (pi.getAllTools() ?? []).find((item: any) => item?.name === probeName);
    const schema = tool?.parameters ?? tool?.inputSchema;
    return Boolean(schema?.properties?.replacementProbeField && !schema?.properties?.firstProbeField);
  } catch {
    return false;
  } finally {
    if (activeBefore) {
      try { pi.setActiveTools?.(activeBefore); } catch { /* preserve active loadout best-effort */ }
    }
  }
}

function errorSummary(event: any): string {
  const result = event?.result;
  const content = Array.isArray(result?.content) ? result.content.map((part: any) => part?.type === "text" ? part.text : "").filter(Boolean).join("\n") : "";
  return clip(event?.error || content || result?.error || "Tool execution failed without a text error.", 260);
}

export default function (pi: any) {
  state = emptyGoalRunState();
  contextState = emptyContextState();
  needsRestore = true;
  loaderName = "";
  loaderSignature = "";
  lastLoadoutSignature = "";
  mutationQueue = Promise.resolve();
  loadoutRefreshPending = true;
  statePersistedViaEntry = false;
  stableToolsByPi.delete(pi);
  dynamicToolSignaturesByPi.delete(pi);
  ensureDelegationRuntime(pi);

  // State is a compact default read after Goal capture; detailed capability groups remain progressive.
  registerStateSnapshotTool(pi);
  registerContextTool(pi);
  // Before a Goal exists no capability is applicable, so the capability loader stays hidden.
  ensureLoader(pi);
  try { setCompassLoadout(pi, [loaderName]); } catch { /* preflight reports unsupported runtime */ }

  pi.on("session_start", async (_event: any, ctx: any) => {
    await serialized(async () => {
      state = restoreState(ctx);
      needsRestore = false;
      if (state.plan?.execution && ["dispatching", "running"].includes(state.plan.execution.status)) {
        state.plan.execution.status = "unknown";
        state.plan.execution.completedAt = null;
        state.plan.execution.error = "Pi session restarted while a Subagent batch was unresolved. No automatic redispatch is allowed until recorded run IDs are checked.";
        state.plan.execution.results = (state.plan.execution.results ?? []).map((item: any) => ["dispatching", "running"].includes(item.status)
          ? { ...item, status: "unknown", error: state.plan.execution.error }
          : item);
        state = recordExecutionEvent(state, { status: "unknown", summary: "Recovered an unresolved Subagent batch as unknown.", text: state.plan.execution.error, ref: state.plan.execution.requestId });
      }
      state.projectRoot = contextCwd(ctx);
      restoreContext(ctx);
      const currentLoader = ensureLoader(pi);
      const allowed = capabilitiesFor();
      setActiveCapabilities(activeCapabilities().filter((capability) => allowed.includes(capability)));
      const tools = registerActiveCapabilityGroups(pi);
      setCompassLoadout(pi, [currentLoader, ...(state.goal.current ? ["compass_state", "compass_context"] : []), ...tools]);
      lastLoadoutSignature = loadoutSignature(activeCapabilities());
      loadoutRefreshPending = false;
      persistState(pi);
    });
  });

  pi.on("session_shutdown", async () => serialized(async () => {
    const execution = state.plan?.execution;
    if (!execution || !["dispatching", "running"].includes(execution.status)) return;
    execution.status = "unknown";
    execution.completedAt = null;
    execution.error = "Pi session shut down while a Subagent batch was unresolved. Check recorded run IDs before retrying; Compass will not duplicate it.";
    execution.results = (execution.results ?? []).map((item: any) => ["dispatching", "running"].includes(item.status)
      ? { ...item, status: "unknown", error: execution.error }
      : item);
    state = recordExecutionEvent(state, { status: "unknown", summary: "Session shutdown left a Subagent batch unresolved.", text: execution.error, ref: execution.requestId });
    persistState(pi);
  }));

  // before_agent_start captures the prompt before the model sees it. message_end
  // below catches Human steering/follow-up messages that do not start a new run.
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const prompt = typeof event?.prompt === "string" ? event.prompt : "";
    const result = await serialized(async () => {
      if (needsRestore) { state = restoreState(ctx); restoreContext(ctx); needsRestore = false; }
      const messageId = String(event?.messageId ?? event?.message?.id ?? event?.id ?? "");
      const captured = captureHumanPrompt(state, prompt, { source: "before_agent_start", messageId });
      state = captured.state;
      if (captured.captured) {
        refreshAfterHumanInput(pi, ctx);
        if (!statePersistedViaEntry) return { message: { customType: STATE_MESSAGE_TYPE, content: JSON.stringify(state), display: false } };
        return;
      }
      ensureCurrentLoadout(pi, ctx);
      return;
    });
    // A new Human veto cancels exact active structured-delegation attempts before
    // any recovery scheduling. Missing cancel/terminal acknowledgement stays unknown.
    if (explicitSubagentVisibilityRequest(prompt) === "human_prohibited_subagents") {
      cancelActiveDelegations(pi, "Latest Human instruction prohibits Subagent execution.");
    }
    // Recovery backstop: if a prior process persisted a plan but stopped before
    // its tool_result scheduler ran, resume only tasks still ready for this exact
    // Current Goal. The latest Human instruction is checked before dispatch.
    scheduleReadySubagentWaves(pi, ctx ?? {}, prompt);
    if (result?.message?.customType === STATE_MESSAGE_TYPE) result.message.content = JSON.stringify(state);
    return result;
  });

  pi.on("message_end", async (event: any, ctx: any) => {
    const message = event?.message;
    const human = message?.role === "user";
    const nativeWatch = message?.role === "custom" && ["watch-condition", "watch-lost"].includes(message.customType);
    if (!human && !nativeWatch) return;
    const text = messageText(message);
    if (!text) return;
    await serialized(async () => {
      if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
      restoreContext(ctx);
      if (nativeWatch) {
        const watchRelease = releaseWatchMessages(contextState, text);
        if (watchRelease) {
          pi.appendEntry(CONTEXT_STATE_TYPE, watchRelease.entry.data);
          restoreContext(ctx);
        }
        return;
      }
      const captured = captureHumanPrompt(state, text, { source: "message_end", messageId: String(message?.id ?? event?.messageId ?? "") });
      if (!captured.captured) return;
      state = captured.state;
      refreshAfterHumanInput(pi, ctx);
    });
    if (human && explicitSubagentVisibilityRequest(text) === "human_prohibited_subagents") {
      cancelActiveDelegations(pi, "Latest Human instruction prohibits Subagent execution.");
    }
  });

  // Goal state is reconciled by revision, not blindly overwritten by whichever
  // branch snapshot happens to be returned during context assembly.
  pi.on("context", async (event: any, ctx: any) => {
    await mutationQueue;
    if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
    else {
      const branchState = restoreState(ctx);
      if (branchState.stateRevision > (state.stateRevision ?? 0) || (!state.goal.original && branchState.goal.original)) state = branchState;
    }
    restoreContext(ctx);
    ensureCurrentLoadout(pi, ctx);
    // Do not rebuild request history or append a volatile full-state anchor.
  });

  pi.on("context_with_system", async (event: any) => {
    if (!Array.isArray(event?.messages)) return;
    // Older Compass state messages are internal persistence, not instructions.
    // Preserve Pi's original system/tool patches instead of folding them into the head.
    const messages = event.messages.filter((message: any) => !(message?.role === "custom" && [STATE_MESSAGE_TYPE, ANCHOR_MESSAGE_TYPE, "pi-compass-v2.conventions"].includes(message?.customType)));
    if (messages.length !== event.messages.length) return { messages };
  });

  // Native context edits are committed at turn_end, including an aborted turn.
  // This is the only point where Compass changes the canonical projection; it
  // never creates a second session, mutates the transcript in place, or filters
  // cloned messages by position.
  pi.on("turn_end", async (event: any, ctx: any) => serialized(async () => {
    if (needsRestore) { state = restoreState(ctx); restoreContext(ctx); needsRestore = false; }
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    restoreContext(ctx);
    try {
      const planned = planContextBoundary({ state: contextState, branch, boundary: event });
      if (planned) {
        // Pi commits only after all boundary handlers finish. Reconcile the
        // committed branch on the next read, never activate this proposal here.
        return { entries: [...(event.entries ?? []), ...planned.entries], continue: planned.continue };
      }
      const watchPlan = planWatchBoundary({ state: contextState, boundary: event });
      if (!watchPlan) return;
      return { entries: [...(event.entries ?? []), ...watchPlan.entries] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        entries: [...(event.entries ?? []), {
          type: "custom_message",
          customType: CONTEXT_MESSAGE_TYPE,
          content: `Context operation rejected: ${message}`,
          display: false,
          details: { contextError: true },
        }],
        continue: false,
      };
    }
  }));

  // Capture explicit writes, failed tools, and structured answers returned by ask-user-questions.
  // All updates are serialized so a trace event cannot overwrite a concurrent Goal update.
  pi.on("tool_call", async (event: any) => serialized(async () => {
    if (event?.toolName === "compass_context" && event?.parentToolCallId && event?.input?.action !== "search") {
      return { block: true, reason: "Context mutations require a direct standalone compass_context call, not a nested Code Mode call. No context changed." };
    }
    const rawTargets = explicitWriteTargets(event);
    if (!rawTargets.length) return;
    const cwd = state.projectRoot || process.cwd();
    let writeAdded = false;
    let driftChanged = false;
    let activated = false;
    const canonicalTargets = rawTargets.map((rawTarget) => canonicalWriteTarget(rawTarget, cwd));
    const hasActivePlan = Boolean(state.plan?.goal && state.plan.tasks.length && state.plan.goal === state.goal.current);
    for (const target of canonicalTargets) {
      const eventSeqBefore = state.eventSeq ?? 1;
      state = recordWriteTarget(state, { tool: event?.toolName, target, at: now() });
      if ((state.eventSeq ?? 1) !== eventSeqBefore) {
        writeAdded = true;
        const item = state.trace.writes.at(-1);
        persistTrace(pi, { kind: "write", item });
      }
      const guard = hasActivePlan ? writeGuardDecision({ tasks: state.plan.tasks, target, cwd, hasPlan: true, goalMatches: true }) : null;
      const driftReason = guard?.blocked ? guard.reason : executionDriftReason({ tasks: state.plan.tasks, target, cwd });
      const drift = driftReason ? recordExecutionDrift(state, { tool: event?.toolName, target, reason: driftReason }) : { state, changed: false };
      if (drift.changed) { state = drift.state; driftChanged = true; }
    }
    activated = maybeAutoActivatePlanning(cwd);
    // A plan-backed write guard is fail-closed only for deterministic, explicit
    // path writes. Simple Goals remain unrestricted; ambiguous shell/Code Mode
    // writes are not guessed from arbitrary code or shell text.
    if (hasActivePlan) {
      for (const target of canonicalTargets) {
        const decision = writeGuardDecision({ tasks: state.plan.tasks, target, cwd, hasPlan: true, goalMatches: true });
        if (decision.blocked) {
          if (writeAdded || driftChanged || activated) persistState(pi);
          return { block: true, reason: `Pi Compass write guard: ${decision.reason}` };
        }
      }
    }
    // Repeated identical writes/drift are no-ops. Observable path violations are
    // blocked before execution; the tool result carries the warning and state retains its evidence.
    if (writeAdded || driftChanged || activated) persistState(pi);
  }));
  pi.on("tool_result", async (event: any, ctx: any) => {
    const questionnaireFailure = questionnaireFailureResultPatch(event);
    if (questionnaireFailure) return questionnaireFailure;
    return handleCompassToolResult(pi, event, ctx);
  });

  pi.on("tool_execution_end", async (event: any) => serialized(async () => {
    const toolName = String(event?.toolName ?? "");
    const failed = Boolean(event?.isError || event?.result?.isError);
    if (/ask.*user.*question|ask_user_question/i.test(toolName)) {
      const result = event?.result ?? event?.output ?? event?.message;
      const text = resultText(result);
      const details = result?.details && typeof result.details === "object" && !Array.isArray(result.details) ? result.details : null;
      const sourceCallId = String(event?.toolCallId ?? event?.callId ?? "");
      if (details?.error) {
        const recorded = recordHumanQuestionnaireFailure(state, {
          source: toolName,
          sourceCallId,
          errorCode: details.error,
          reason: text,
        });
        if (recorded.captured) {
          state = recorded.state;
          persistState(pi);
        }
        return;
      }
      if (!failed && ((text && !/\b(no answer yet|waiting for user|awaiting user response|pending user input)\b/i.test(text)) || details)) {
        const captured = captureHumanDecision(state, { source: toolName, sourceCallId, text, details });
        if (captured.captured) {
          state = captured.state;
          persistState(pi);
        }
      }
      if (!failed) return;
    }
    if (!failed) {
      return;
    }
    state = recordFailure(state, { tool: toolName, error: errorSummary(event), at: now() });
    const item = state.trace.failures.at(-1);
    persistTrace(pi, { kind: "failure", item });
    maybeEscalateIssueReview(pi);
    loadoutRefreshPending = true;
    persistState(pi);
  }));

  pi.registerCommand("compass-preflight", {
    description: "Check Compass progressive disclosure and required tools in the active Pi session",
    handler: async (_args: string, ctx: any) => {
      const names = activeNames(pi);
      const allNames = typeof pi.getAllTools === "function" ? namesFrom(pi.getAllTools()) : names;
      const dynamic = typeof pi.setActiveTools === "function" && typeof pi.getActiveTools === "function";
      const schemaReplacement = supportsSameNameSchemaReplacement(pi);
      const inventory = toolInventory(pi);
      const subagentInstalled = inventory.subagents.registered || inventory.subagentLoader.registered;
      const subagentVisible = inventory.subagents.active;
      const checks = [
        { label: "GoalRun module export contract", ok: GOAL_RUN_API_VERSION === 7 && GOAL_RUN_RELEASE === PACKAGE_VERSION && typeof shouldSurfaceIssueReview === "function" && typeof buildStateSnapshot === "function" && typeof triageIssue === "function" },
        { label: "Pi active-tool read/write", ok: dynamic },
        { label: "Stable-name schema replacement", ok: schemaReplacement },
        { label: "Compass loader", ok: allNames.some((name) => name === "compass_open") || availableCapabilities(state).every((name) => activeCapabilities().includes(name)) },
        { label: "Compact state tool registered", ok: allNames.some((name) => name === "compass_state") },
        { label: "codemode", ok: names.some((name) => /code.?mode/i.test(name)) },
        { label: "pi-subagents registered", ok: subagentInstalled },
        { label: "Structured delegation event bus surface", ok: Boolean(pi.events && typeof pi.events.on === "function" && typeof pi.events.emit === "function" && delegationRuntimes.get(pi)?.installed) },
        { label: "ask-user-questions", ok: names.some((name) => /(ask.*user.*question|ask.*question|question.*user|user.*question)/i.test(name)) },
      ];
      const lines = [`Compass v${GOAL_RUN_RELEASE} preflight`];
      for (const check of checks) lines.push(`${check.ok ? "PASS" : "WARN"} ${check.label}${check.ok ? "" : " — not visible or unsupported"}`);
      lines.push(`Loaded Compass capabilities: ${activeCapabilities().join(", ") || "none"}`);
      if (!schemaReplacement) lines.push("BLOCKER: same-name schema replacement did not verify. Do not use this build; dynamic schemas require this Pi runtime behavior.");
      lines.push(`Active Compass tools: ${names.filter(isCompassName).join(", ") || "none"}`);
      lines.push(`Subagent tools: ${!subagentInstalled ? "not installed/registered" : subagentVisible ? "visible; activation owned by Pi/pi-subagents and the user" : "registered but inactive in Pi/user toolset; Compass will not force-enable it"}`);
      lines.push(`Subagent loader: ${inventory.subagentLoader.active ? "visible" : "inactive/not registered"}. Loader visibility does not mean the executor schema is active.`);
      const awaiting = inventory.await;
      lines.push(`pi-await: watch=${awaiting.watch.active}; watches=${awaiting.status.active}; unwatch=${awaiting.cancel.active}. External conditions use native watch wakes; Subagents use their native completion mechanism.`);
      lines.push("Structured-delegation surface check confirms only that Compass can emit/listen on the in-process event bus; a real Subagent request/response smoke test is still required to prove installed pi-subagents compatibility and model availability.");
      lines.push("Compass capability groups are exposed only when state or explicit task structure makes them applicable. The model-visible native Subagent tool may remain hidden; separately, Compass auto-dispatches only tasks explicitly routed as executor=subagent with read-only scope. It never infers a DAG from tool visibility, and an explicit Human prohibition blocks dispatch.");
      ctx.ui?.notify?.(lines.join("\n"), checks.every((check) => check.ok) ? "info" : "warning");
    },
  });

  // Development-only live acceptance command. It refuses non-empty sessions and
  // runs a disposable read-only DAG, so it cannot overwrite an existing Goal.
  pi.registerCommand("compass-live-acceptance", {
    description: "Run a real three-child read-only DAG acceptance test in a disposable Pi session; optional argument selects a project root; expect model usage/cost",
    handler: async (_args: string, ctx: any) => {
      const cwd = contextCwd(ctx) || process.cwd();
      const compassRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
      const fixture = resolveLiveAcceptanceFixture({ args: _args, cwd, compassRoot });
      if (!fixture) {
        ctx.ui?.notify?.(
          "Live acceptance needs a readable project root containing package.json, README.md, and at least one safe visible entry. Start Pi in such a directory or pass one explicitly: /compass-live-acceptance /path/to/project. No Goal state changed.",
          "warning",
        );
        return;
      }
      const { root: acceptanceRoot, rootEntries, packageMeta, readmeHeading } = fixture;
      if (fixture.usedFallback) {
        ctx.ui?.notify?.(`Current directory is not a package root; using the Compass package as the read-only acceptance fixture: ${acceptanceRoot}`, "info");
      }

      let priorGoal = false;
      await serialized(async () => {
        if (needsRestore) { state = restoreState(ctx); needsRestore = false; }
        priorGoal = Boolean(state.goal.current || state.goal.original || state.plan?.tasks?.length || executionUnresolved(state.plan?.execution));
        if (priorGoal) return;
        state = captureHumanPrompt(emptyGoalRunState(), "Goal: Validate the live pi-subagents structured-delegation and DAG scheduler in this disposable session. Do not modify files.", { source: "compass_live_acceptance" }).state;
        state.projectRoot = acceptanceRoot;
        const plan = revisePlanState(state, {
          acceptanceCriteria: [
            "Two independent read-only Subagent tasks complete in one parallel wave.",
            "A dependent read-only Subagent task starts only after both prerequisites complete.",
            "Code Mode and parent-owned tasks remain undispatched by Compass.",
          ],
          changeReason: "Disposable live acceptance fixture; no product files are changed.",
          tasks: [
            { id: "probe_a", title: "Inspect visible directory entries", acceptance: "Use ls to report at least one exact non-hidden top-level entry name; evidence must include the name.", output: "One exact visible entry name with evidence", dependsOn: [], executor: "subagent", agent: "scout", writeScope: "read-only", dispatchReason: "Verify the real child tool loop independently of metadata inspection." },
            { id: "probe_b", title: "Read package metadata", acceptance: `Read package.json and report exact name=${String(packageMeta.name).slice(0, 100)} and version=${String(packageMeta.version).slice(0, 60)}; evidence must reference package.json.`, output: "Exact package name/version and evidence", dependsOn: [], executor: "subagent", agent: "scout", writeScope: "read-only", dispatchReason: "Independently verify package metadata in a separate child context." },
            { id: "probe_c", title: "Read README heading after prerequisites", acceptance: `Read README.md and report the first heading exactly: ${readmeHeading.slice(0, 160)}; evidence must reference README.md:1.`, output: "Exact README first heading and evidence", dependsOn: ["probe_a", "probe_b"], executor: "subagent", agent: "scout", writeScope: "read-only", dispatchReason: "Validate dependency-gated follow-up in a fresh semantic child context." },
            { id: "probe_code", title: "Keep deterministic work in Code Mode", acceptance: "This fixture node must remain pending and must not be auto-dispatched.", dependsOn: [], executor: "code", writeScope: "read-only" },
            { id: "probe_parent", title: "Keep coupled decisions with parent", acceptance: "This fixture node must remain pending and must not be auto-dispatched.", dependsOn: [], executor: "parent", writeScope: "read-only" },
          ],
        });
        state = plan.state;
        persistState(pi);
      });
      if (priorGoal) {
        ctx.ui?.notify?.("Live acceptance refused to protect existing session state. Start a new disposable Pi session, then run /compass-live-acceptance [project-root]; no state changed.", "warning");
        return;
      }

      const startedAt = Date.now();
      // Exercise the same post-tool-result scheduling handler used by normal plan/task
      // mutations. This proves the runtime can start the DAG without a separate
      // model-issued compass_execution call; the fake-Pi suite separately verifies
      // Pi's event registration and dispatch timing.
      const schedulerTriggerResult = await handleCompassToolResult(pi, {
        toolName: "compass_plan_create",
        input: { liveAcceptance: true },
        isError: false,
        content: [{ type: "text", text: "Disposable live acceptance plan created." }],
        details: {},
      }, ctx);
      const scheduler = autoSchedulers.get(pi);
      if (scheduler?.promise) await scheduler.promise;
      await serialized(async () => { persistState(pi); });
      const tasks = state.plan?.tasks ?? [];
      const history = state.plan?.executionHistory ?? [];
      const firstWave = history[0];
      const secondWave = history[1];
      const taskById = new Map(tasks.map((task: any) => [task.id, task]));
      const entryEvidence = String(taskById.get("probe_a")?.evidence ?? "");
      const metadataEvidence = String(taskById.get("probe_b")?.evidence ?? "");
      const headingEvidence = String(taskById.get("probe_c")?.evidence ?? "");
      const checks = [
        { name: "probe bridge accepted the structured request contract", pass: history.length >= 1 && history.every((batch: any) => batch.source === "runtime") },
        { name: "shared post-tool-result scheduler dispatches without compass_execution", pass: ["scheduled", "already_running"].includes(schedulerTriggerResult?.details?.autoDispatch) && history.length >= 1 },
        { name: "two independent tasks share first parallel wave", pass: Boolean(firstWave && firstWave.taskIds.includes("probe_a") && firstWave.taskIds.includes("probe_b")) },
        { name: "dependent task starts in a later wave", pass: Boolean(secondWave && secondWave.taskIds.includes("probe_c") && firstWave?.requestId !== secondWave?.requestId) },
        { name: "child A evidence matches a real safe directory entry", pass: rootEntries.some((name) => entryEvidence.includes(name)) },
        { name: "child B evidence confirms actual package metadata", pass: metadataEvidence.includes(String(packageMeta.name)) && metadataEvidence.includes(String(packageMeta.version)) && /package\.json/i.test(String(taskById.get("probe_b")?.evidence ?? "")) },
        { name: "child C evidence confirms README heading after dependencies", pass: headingEvidence.includes(readmeHeading) && /README\.md/i.test(headingEvidence) },
        { name: "Code Mode task remains undispatched", pass: taskById.get("probe_code")?.status === "pending" },
        { name: "parent task remains undispatched", pass: taskById.get("probe_parent")?.status === "pending" },
        { name: "all three real Subagent tasks completed with evidence", pass: ["probe_a", "probe_b", "probe_c"].every((id) => taskById.get(id)?.status === "done" && String(taskById.get(id)?.evidence ?? "").trim()) },
      ];
      const allMetrics = history.flatMap((batch: any) => batch.taskMetrics ?? []);
      checks.push({ name: "each child reports observed tool activity and a supported model", pass: ["probe_a", "probe_b", "probe_c"].every((id) => {
        const metric = allMetrics.find((item: any) => item.id === id);
        const observedTools = Array.isArray(metric?.observedTools) && metric.observedTools.length > 0;
        const reportedToolCalls = Number.isFinite(metric?.toolCalls) && metric.toolCalls > 0;
        const observedCount = Number.isFinite(metric?.observedToolCount) && metric.observedToolCount > 0;
        return Boolean(metric && (observedTools || reportedToolCalls || observedCount) && isSupportedDelegatedModel(metric.model, [PRIMARY_MODEL, FALLBACK_MODEL]));
      }) });
      checks.push({ name: "usage and cost fields preserve known/unknown values", pass: allMetrics.length >= 3 && ["probe_a", "probe_b", "probe_c"].every((id) => {
        const metric = allMetrics.find((item: any) => item.id === id);
        if (!metric) return false;
        const fields = [metric.cost, metric.durationMs, metric.input, metric.output, metric.toolCalls];
        const fieldsAreKnownOrUnknown = fields.every((value: any) => value === null || (Number.isFinite(value) && value >= 0));
        const completeClaimIsHonest = metric.metricsComplete !== true || fields.every((value: any) => Number.isFinite(value) && value >= 0);
        return fieldsAreKnownOrUnknown && completeClaimIsHonest;
      }) && history.every((batch: any) => Number.isFinite(batch.wallDurationMs) && batch.wallDurationMs >= 0) });
      const report = {
        schemaVersion: 1,
        generatedAt: now(),
        compassRelease: GOAL_RUN_RELEASE,
        schedulerTrigger: "shared-post-tool-result-handler",
        explicitCompassExecutionCalls: 0,
        cwd,
        package: { name: String(packageMeta.name), version: String(packageMeta.version) },
        result: checks.every((check) => check.pass) ? "PASS" : "FAIL",
        durationMs: Date.now() - startedAt,
        checks,
        waves: history.map((batch: any) => ({ requestId: batch.requestId, taskIds: batch.taskIds, status: batch.status, wallDurationMs: batch.wallDurationMs, sumDurationMs: batch.sumDurationMs, estimatedParallelSavingsMs: batch.estimatedParallelSavingsMs, totalCost: batch.totalCost, fallbackCount: batch.fallbackCount, metricsComplete: batch.metricsComplete, policyMode: batch.policyMode, policyReason: batch.policyReason })),
        taskMetrics: allMetrics,
        taskResults: ["probe_a", "probe_b", "probe_c", "probe_code", "probe_parent"].map((id) => ({ id, status: taskById.get(id)?.status ?? "missing", evidence: clip(taskById.get(id)?.evidence ?? "", 800), reason: clip(taskById.get(id)?.reason ?? "", 300) })),
        note: "Contains only bounded smoke-test output, model usage metrics, and safe filenames/evidence; no settings or credentials are included.",
      };
      const requestedReportDir = typeof process.env.PI_COMPASS_LIVE_REPORT_DIR === "string" ? process.env.PI_COMPASS_LIVE_REPORT_DIR.trim() : "";
      const allowedReportPrefix = path.join(os.tmpdir(), "pi-compass-live-evidence-");
      const resolvedReportDir = requestedReportDir ? path.resolve(requestedReportDir) : "";
      const reportPath = resolvedReportDir.startsWith(allowedReportPrefix)
        ? path.join(resolvedReportDir, "live-acceptance.json")
        : path.join(os.tmpdir(), `pi-compass-live-acceptance-${Date.now()}.json`);
      try {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        fs.chmodSync(reportPath, 0o600);
      } catch { /* The TUI summary remains usable if /tmp is unavailable. */ }
      const totalCostComplete = history.every((batch: any) => Number.isFinite(batch.totalCost));
      const totalCost = history.reduce((sum: number, batch: any) => sum + (Number.isFinite(batch.totalCost) ? batch.totalCost : 0), 0);
      const totalWall = history.reduce((sum: number, batch: any) => sum + (batch.wallDurationMs || 0), 0);
      const totalSavings = history.reduce((sum: number, batch: any) => sum + (batch.estimatedParallelSavingsMs || 0), 0);
      const lines = [`Compass live acceptance: ${report.result}`, ...checks.map((check) => `${check.pass ? "PASS" : "FAIL"} ${check.name}`), `Subagent batches=${history.length}; ${totalCostComplete ? `total reported cost=$${totalCost.toFixed(4)}` : `reported cost incomplete (known subtotal=$${totalCost.toFixed(4)})`}; combined batch wall=${Math.round(totalWall / 1000)}s; estimated wait saved=${Math.round(totalSavings / 1000)}s; duration=${Math.round(report.durationMs / 1000)}s.`, `Fallback attempts=${history.reduce((sum: number, batch: any) => sum + (batch.fallbackCount || 0), 0)}; usage metrics=${history.every((batch: any) => batch.metricsComplete) ? "complete" : "partial"}.`, `Report: ${reportPath}`];
      ctx.ui?.notify?.(lines.join("\n"), report.result === "PASS" ? "info" : "warning");
    },
  });
}
