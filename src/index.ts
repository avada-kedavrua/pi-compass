import { getAgentDir, type ExtensionCommandContext, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { launchPreflightInput, loadDelegationPreflight } from "./delegation-preflight.mjs";
import { executionDriftReason } from "./write-scope.mjs";
import { questionnaireFailureResultPatch, normalizeQuestionnaireRecord } from "./questionnaire-integration.mjs";
import { latestHumanSource, resolveGoalSources } from "./goal-sources.mjs";
import { agentResult } from "./compass-result.mjs";
import { agentState } from "./agent-state.mjs";
import { toolSchemas, COMPASS_TOOL_NAMES } from "./tool-schema.mjs";
import { approvalPrompt } from "./dag-approval.mjs";
import { agentSearch, agentContextOperation, retainedContext } from "./context-agent.mjs";
import { contextSelection, currentValue, RESERVED_CUSTOM_TYPES } from "./context-values.mjs";
import { registerRuntimeGuards } from "./runtime-guard.mjs";
import { DELEGATION_EVENTS, FALLBACK_MODEL, PRIMARY_MODEL, REVIEW_MODEL, DEFAULT_TIMEOUT_MS, MAX_WAVE_TASKS, START_ACK_TIMEOUT_MS, assessWavePolicy, hasCompleteUsageMetrics, buildSubagentDelegationRequest, selectReadySubagentTasks, parseSubagentDelegationResponse, normalizeProviderDiagnostics, providerFallbackReason, readOnlyLaunchRefusal } from "./execution-orchestrator.mjs";
import { executionUnresolved, readyTasks, retainExecutions, taskDependencies, updateTasks } from "./dag-core.mjs";
import { setGoal, updateGoal, patchPlanState, addressedConstraints, observeHumanInput, stateCursor, GOAL_RUN_API_VERSION, GOAL_RUN_RELEASE, recordAcceptanceResult, bindDagApprovalQuestionnaire, captureHumanDecision, dagApprovalStatus, recordTaskAssessment, renewDagApprovalRequest, emptyGoalRunState, mergeTrace, normalizeGoalRunState, recordCheckpoint, recordDecision, recordFailure, recordHumanQuestionnaireFailure, recordExecutionDrift, recordExecutionEvent, recordWriteTarget, revisePlanState, stopPlan, transitionTasks, reconcileUnknownExecutionTasks, expandApprovalProposal } from "./goal-run.mjs";
import { CONTEXT_MESSAGE_TYPE, CONTEXT_STATE_TYPE, emptyContextState, normalizeContextState, pinnedContextOverlay, planContextBoundary, planRetentionBoundary, planObservationBoundary, planWatchBoundary, prepareContextOperation, validateContextOperation, releaseWatchMessages, restoreContextState, sourceIndex } from "./context-core.mjs";

const STATE_ENTRY_TYPE = "pi-compass-v2.goalrun";
const MAX_TRACE_ENTRIES = 24;
// A settled-UNKNOWN request keeps its correlation so a genuinely late terminal
// event stays attributable evidence. Bounded so abandoned children cannot pin memory.
const LATE_RESULT_RETENTION_MS = 10 * 60_000;
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export default function (pi: any, resolvePreflight = (tool: unknown) => loadDelegationPreflight(tool, (url: string) => import(url))) {
let state: any = emptyGoalRunState();
let contextState: any = emptyContextState();
let needsRestore = true;
let mutationQueue: Promise<any> = Promise.resolve();
let activePi: any = pi;
let branchGeneration = 0;
let lastCommittedState: any = emptyGoalRunState();
const delegationRuntimes = new WeakMap<object, any>();
const autoSchedulers = new WeakMap<object, Promise<unknown>>();
function clone<T>(value: T): T {
  return structuredClone(value);
}
function clip(value: unknown, max = 300): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function now() { return new Date().toISOString(); }

function namesFrom(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((tool: any) => typeof tool === "string" ? tool : String(tool?.name ?? "")).filter(Boolean);
}
function getContext(rest: any[]): any {
  return rest.find((item) => item && typeof item === "object" && (item.sessionManager || typeof item.cwd === "string" || item.hasUI !== undefined)) ?? {};
}
function parseState(value: any): any {
  if (!value || typeof value !== "object" || !value.goal || !value.plan) {
    throw new Error("Invalid Compass GoalRun snapshot; no state changed. Recover a supported native branch.");
  }
  return normalizeGoalRunState(value);
}
function stateFromEntry(entry: any): any | null {
  if (!entry || typeof entry !== "object") return null;
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
function persistedAssistantEntryId(ctx: any, toolCallId: string): string {
  if (!toolCallId) return "";
  let branch: any[] = [];
  try { branch = ctx?.sessionManager?.getBranch?.() ?? []; } catch { return ""; }
  for (const entry of [...branch].reverse()) {
    const message = entry?.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const matchingCall = message.content.some((part: any) => part?.type === "toolCall" && part.id === toolCallId);
    if (!matchingCall) continue;
    const id = entry.id ?? entry.entryId;
    return typeof id === "string" && id.trim() ? id : "";
  }
  return "";
}
function restoreState(ctx: any): any {
  let restored: any = null;
  const branch = ctx?.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) throw new Error("Native active branch is unavailable; no GoalRun state changed.");
  const latest = branch.findLast((entry: any) => entry?.type === "custom" && entry.customType === STATE_ENTRY_TYPE);
  if (latest) restored = stateFromEntry(latest);
  if (!restored) restored = emptyGoalRunState();
  restored = mergeTrace(restored, traceFromEntries(branch));
  return normalizeGoalRunState(restored);
}
function adoptBranchState(ctx: any) {
  const restored = restoreState(ctx);
  lastCommittedState = clone(restored);
  state = restored;
  // Adoption follows a new lifecycle scope or uncertain persistence. An old
  // running record no longer has an owning scheduler generation, so it must be
  // resolvable as unknown rather than stranded forever as running.
  if (markUnresolvedExecutionUnknown("Dispatch scope was reloaded or invalidated. Check native request/run identities before reconciliation; no automatic redispatch is allowed.")) persistState(activePi);
  return state;
}
function persistState(pi: any, value = state) {
  if (pi !== activePi) throw new Error("Stale Compass session cannot persist GoalRun state.");
  const next = clone(value);
  next.stateRevision = (Number.isInteger(next.stateRevision) ? next.stateRevision : 0) + 1;
  try {
    if (typeof pi.appendEntry !== "function") throw new Error("Pi custom-entry persistence is required.");
    pi.appendEntry(STATE_ENTRY_TYPE, next);
  } catch (error) {
    // Every writer, not just model-facing mutations, shares this commit boundary.
    // A host may append and then throw: re-read its branch before retrying rather
    // than assert that native persistence was rolled back.
    state = clone(lastCommittedState);
    needsRestore = true;
    branchGeneration += 1;
    autoSchedulers.delete(pi);
    throw new Error("GoalRun persistence failed; candidate not activated. Reconcile the native branch before retrying.", { cause: error });
  }
  value.stateRevision = next.stateRevision;
  // Reuse the immutable snapshot handed to native persistence, not a second copy.
  lastCommittedState = next;
}
function persistTrace(pi: any, item: any) {
  try { pi.appendEntry?.(`${STATE_ENTRY_TYPE}.trace`, clone(item)); } catch { /* trace is best-effort */ }
}
function sameIds(left: any[], right: any[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function executionBatch(requestId: string) {
  return state.plan.executions.find((batch: any) => batch.requestId === requestId);
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
    if (activePi !== pi) return;
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
    void serializedInBranch(pi, pending.generation, async () => {
      const execution = executionBatch(pending.request.ownerRunId);
      if (!executionUnresolved(execution)) return;
      const index = executionResultIndex(execution, pending.request.nodeId);
      const prior = execution.results[index];
      if (prior?.requestId !== pending.request.requestId || !executionUnresolved(prior)) return;
      const runId = typeof payload.runId === "string" && payload.runId.trim() ? payload.runId.trim() : prior.runId;
      const nextStatus = prior.status === "unknown" ? "unknown" : "running";
      const progressCount = pending.progress?.toolCount ?? prior.observedToolCount ?? null;
      const progressTools = pending.progress?.tools ?? prior.observedTools ?? [];
      if (prior.status === nextStatus && prior.runId === runId
        && prior.observedToolCount === progressCount
        && JSON.stringify(prior.observedTools ?? []) === JSON.stringify(progressTools)) return;
      execution.results[index] = { ...prior, status: nextStatus, runId, observedToolCount: progressCount, observedTools: progressTools };
      if (execution.status === "dispatching") execution.status = "running";
      persistState(pi);
    }).catch(() => {});
  };
  subscribe(DELEGATION_EVENTS.started, recordProgress);
  subscribe(DELEGATION_EVENTS.update, recordProgress);
  subscribe(DELEGATION_EVENTS.response, (payload) => {
    const pending = matchingPending(runtime, payload);
    if (!pending) return;
    const response = { ...payload, __compassProgress: pending.progress ?? null };
    const parsed = parseSubagentDelegationResponse(response, pending.request);
    if (!parsed) {
      pending.finishUnknown("Terminal response failed model/shape validation; awaiting valid correlated evidence. No retry was attempted.");
      return;
    }
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    if (pending.responseTimer) clearTimeout(pending.responseTimer);
    if (pending.retainTimer) clearTimeout(pending.retainTimer);
    runtime.pending.delete(pending.request.requestId);
    if (pending.settled) {
      void consumeDelegationResponse(pi, pending.generation, pending.request, { response, parsed }, pending.ctx, runtime, false)
        .catch((error) => reportDispatchError(pending.ctx, error));
      return;
    }
    pending.settled = true;
    pending.resolve({ response, parsed });
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
function dispatchOneDelegation(pi: any, generation: number, runtime: any, request: any, ctx: any): Promise<any> {
  if (!inCurrentBranch(pi, generation)) return Promise.resolve({ __compassUnknown: true, reason: "Delegation scope changed before dispatch; no request emitted." });
  return new Promise((resolve) => {
    const pending: any = {
      request,
      generation,
      ctx,
      resolve,
      settled: false,
      started: false,
      ackTimer: null,
      responseTimer: null,
      retainTimer: null,
    };
    const finishUnknown = (reason: string) => {
      if (pending.settled) return;
      if (pending.ackTimer) clearTimeout(pending.ackTimer);
      if (pending.responseTimer) clearTimeout(pending.responseTimer);
      pending.ackTimer = null;
      pending.responseTimer = null;
      pending.settled = true;
      // Settling the caller must not delete the correlation: a late terminal
      // response is the only recovery path that avoids a second dispatch.
      pending.retainTimer = setTimeout(() => {
        if (runtime.pending.get(request.requestId) === pending) runtime.pending.delete(request.requestId);
      }, LATE_RESULT_RETENTION_MS);
      // Retention is background bookkeeping; it must never hold the process open.
      pending.retainTimer.unref?.();
      resolve({ __compassUnknown: true, requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, model: request.model, reason });
    };
    pending.finishUnknown = finishUnknown;
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
async function executionAvailability(pi: any, cwd: string) {
  const runtime = ensureDelegationRuntime(pi);
  const tool = pi.getAllTools?.().find((item: any) => item.name === "subagent");
  if (!tool) return { ok: false, runtime, reason: "pi-subagents is not registered in this Pi session; no task was dispatched." };
  // Native activation remains Pi-owned. Structured execution requires exact
  // Human approval and an Agent interpretation of the latest Human input.
  if (!runtime?.installed) return { ok: false, runtime, reason: "The Pi event bus does not expose the structured-delegation contract; no task was dispatched." };
  const bridge = await probeDelegationBridge(pi, runtime, cwd);
  if (!bridge.ok) return { ok: false, runtime, reason: bridge.reason };
  try {
    if (runtime.preflightSource !== tool.sourceInfo?.path || !runtime.preflight) {
      runtime.preflight = await resolvePreflight(tool);
      runtime.preflightSource = tool.sourceInfo?.path;
    }
    if (runtime.preflight) return { ok: true, runtime, reason: "" };
  } catch (error) {
    return { ok: false, runtime, reason: `Native launch preflight could not load: ${clip(String(error), 280)}` };
  }
  return { ok: false, runtime, reason: "Cannot resolve the registered pi-subagents launch preflight; no child was dispatched." };
}
async function checkLaunch(pi: any, ctx: any, runtime: any, request: any) {
  try {
    const result = await runtime.preflight(launchPreflightInput(pi, ctx, request));
    return readOnlyLaunchRefusal(request, result);
  } catch (error) {
    return `Cannot verify the native read-only profile: ${clip(String(error), 280)}`;
  }
}
function primaryModelForTask(task: any): string {
  return ["reviewer", "evidence-auditor", "oracle"].includes(String(task?.agent ?? ""))
    ? REVIEW_MODEL
    : PRIMARY_MODEL;
}
function goalInputIsCurrent(ctx: any): boolean {
  return state.goal.reviewedInputId === latestHumanSource(ctx?.sessionManager?.getBranch?.());
}
function executionRecordForWave(waveId: string, tasks: any[], planRevision: number, stateVersion: number, requestIds: string[], policy: any, frameScope: string | null = null) {
  return {
    requestId: waveId,
    runId: null,
    ...(frameScope ? { frameScope } : {}),
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
      ...((task.frameScope || frameScope) ? { frameScope: task.frameScope || frameScope } : {}),
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
function parsedTaskEvidence(parsed: any): string {
  return clip([parsed.summary, ...(parsed.evidence ?? []).map((item: string) => `Evidence: ${item}`)].filter(Boolean).join("\n"), 1600);
}
// Absorb a terminal result that arrived after the request was settled UNKNOWN.
// Only an execution still awaiting this exact request may take it: a manually
// reconciled or superseded batch is evidence too and must not be overwritten.

function applyDelegationOutcomeUnlocked(pi: any, waveId: string, task: any, parsed: any, fallbackAttempted: boolean, primaryError = "") {
  let execution = executionBatch(waveId);
  if (!execution) return;
  let index = executionResultIndex(execution, task.id);
  if (index < 0) return;
  const currentResult = execution.results[index];
  const taskStatus = state.plan.tasks.find((item: any) => item.id === task.id)?.status;
  if (taskStatus === "in_progress") {
    if (parsed.status === "throw") {
      state = stopPlan(state, { taskId: task.id, reason: parsed.reason, evidence: parsedTaskEvidence(parsed), sideEffects: parsed.sideEffects }, updateTasks);
    } else if (parsed.status === "done") {
      // A correlated terminal response is a fact, not approval for further work.
      // Preserve it even if new Human input has paused semantic progression.
      state.plan = updateTasks(state.plan, [{ id: task.id, status: "done", evidence: parsedTaskEvidence(parsed) }], { terminalEvidence: true });
    } else {
      const reason = clip(`${parsed?.terminalStatus ? `Subagent ${parsed.terminalStatus}: ` : ""}${parsed?.reason || parsed?.summary || "Subagent returned no valid task evidence."}`, 600);
      state.plan = updateTasks(state.plan, [{ id: task.id, status: "blocked", reason }]);
    }
  }
  execution = executionBatch(waveId);
  if (!execution) return;
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
  settleDelegationWave(waveId);
  persistState(pi);
}
function settleDelegationWave(waveId: string, confirmation = "") {
  const execution = executionBatch(waveId);
  if (!executionUnresolved(execution)) return;
  const unresolved = execution.results.some(executionUnresolved);
  const hasUnknown = execution.results.some((row: any) => row.status === "unknown");
  if (unresolved && !hasUnknown) {
    if (execution.status === "unknown") { execution.status = "running"; execution.error = null; }
    return;
  }
  if (hasUnknown && execution.status === "unknown") return;
  execution.status = hasUnknown ? "unknown" : "completed";
  execution.completedAt = hasUnknown ? null : now();
  execution.error = hasUnknown
    ? "At least one delegated task has no correlated terminal result. Inspect recorded run IDs and reconcile before retrying; Compass will not duplicate the batch."
    : confirmation || null;
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
      metricsComplete: !confirmation && rows.every((item: any) => hasCompleteUsageMetrics(item.usage) && (!item.fallbackAttempted || hasCompleteUsageMetrics(item.primaryUsage))),
      policyMode: execution.policy?.mode ?? "unknown",
      policyReason: clip(execution.policy?.reason ?? "No recorded wave policy.", 400),
      taskMetrics: rows.map((item: any) => ({
        id: item.id,
        model: clip(item.model || "unknown", 120),
        fallbackAttempted: item.fallbackAttempted === true,
        fallbackReason: clip(item.fallbackReason || "", 80) || null,
        providerDiagnostics: normalizeProviderDiagnostics(item.providerDiagnostics),
        primaryProviderDiagnostics: normalizeProviderDiagnostics(item.primaryProviderDiagnostics),
        cost: Number.isFinite(item.usage?.cost) ? item.usage.cost : null,
        primaryCost: Number.isFinite(item.primaryUsage?.cost) ? item.primaryUsage.cost : null,
        durationMs: Number.isFinite(item.usage?.durationMs) ? item.usage.durationMs : null,
        primaryDurationMs: Number.isFinite(item.primaryUsage?.durationMs) ? item.primaryUsage.durationMs : null,
        input: Number.isFinite(item.usage?.input) ? item.usage.input : null,
        output: Number.isFinite(item.usage?.output) ? item.usage.output : null,
        toolCalls: Number.isFinite(item.usage?.toolCalls) ? item.usage.toolCalls : null,
        observedToolCount: Number.isFinite(item.observedToolCount) ? item.observedToolCount : null,
        observedTools: Array.isArray(item.observedTools) ? item.observedTools.slice(0, 12) : [],
        metricsComplete: hasCompleteUsageMetrics(item.usage) && (!item.fallbackAttempted || hasCompleteUsageMetrics(item.primaryUsage)),
        runId: clip(item.runId || "", 128) || null,
      })),
      source: confirmation ? "manual_reconcile" : "runtime",
    }].slice(-8);
  }
  state.plan.executions = retainExecutions(state.plan.executions);
  state = recordExecutionEvent(state, {
    status: execution.status,
    summary: `Subagent batch ${execution.status}.`,
    text: confirmation || execution.results.map((item: any) => `${item.id}=${item.status}${item.fallbackAttempted ? " (DeepSeek fallback)" : ""}${item.error ? `: ${clip(item.error, 160)}` : ""}`).join("\n"),
    ref: waveId,
  });
  return true;
}
async function runDelegatedNode(pi: any, generation: number, ctx: any, runtime: any, request: any) {
  const response = await dispatchOneDelegation(pi, generation, runtime, request, ctx);
  const result = await consumeDelegationResponse(pi, generation, request, response, ctx, runtime, true);
  if (!result) return;
  const terminal = await result.response;
  await consumeDelegationResponse(pi, generation, result.request, terminal, ctx, runtime, false);
}

function consumeDelegationResponse(pi: any, generation: number, request: any, outcome: any, ctx: any, runtime: any, allowFallback: boolean) {
  return serializedInBranch(pi, generation, async () => {
    const { ownerRunId: waveId, nodeId, requestId } = request;
    const execution = executionBatch(waveId);
    if (!execution) return;
    const index = executionResultIndex(execution, nodeId);
    const row = execution.results[index];
    if (row?.requestId !== requestId || !executionUnresolved(row)) return;
    const { parsed, response } = outcome;
    if (!parsed) {
      execution.results[index] = { ...row, status: "unknown", error: outcome.reason };
      settleDelegationWave(waveId);
      persistState(pi);
      return;
    }
    const fallbackReason = allowFallback && !row.cancelRequested && !state.plan.stopped
      && !state.plan.executions.some((batch: any) => batch.status === "unknown") && providerFallbackReason(response);
    if (fallbackReason && dagApprovalStatus(state).approved && goalInputIsCurrent(ctx)) {
      const fallback = { ...request, model: FALLBACK_MODEL, requestId: randomUUID() };
      const refusal = await checkLaunch(pi, ctx, runtime, fallback);
      if (!inCurrentBranch(pi, generation)) return;
      if (refusal) parsed.reason += ` Fallback refused: ${refusal}`;
      if (!refusal && dagApprovalStatus(state).approved && goalInputIsCurrent(ctx)) {
        execution.results[index] = { ...row,
          status: "dispatching", requestId: fallback.requestId, model: FALLBACK_MODEL,
          fallbackAttempted: true, fallbackReason, primaryError: clip(parsed.reason, 400),
          primaryUsage: parsed.usage, primaryProviderDiagnostics: parsed.providerDiagnostics,
          runId: null, error: "", observedToolCount: null, observedTools: [],
        };
        persistState(pi);
        if (!inCurrentBranch(pi, generation)) return;
        if (!state.plan.stopped && dagApprovalStatus(state).approved && goalInputIsCurrent(ctx)) {
          // Return the promise boxed to release the state queue before waiting.
          return { request: fallback, response: dispatchOneDelegation(pi, generation, runtime, fallback, ctx) };
        }
        execution.results[index] = row;
      }
    }
    applyDelegationOutcomeUnlocked(pi, waveId, { id: nodeId }, parsed, row.fallbackAttempted, row.primaryError);
    if (inCurrentBranch(pi, generation)) scheduleReadySubagentWaves(pi, ctx);
  });
}
function readyForDispatch(ctx: any) {
  if (!state.goal.current || state.plan.stopped || !dagApprovalStatus(state).approved || !goalInputIsCurrent(ctx)) return [];
  const batches = state.plan.executions;
  if (batches.some((batch: any) => batch.status === "unknown")) return [];
  const active = batches.reduce((count: number, batch: any) => count + batch.results.filter(executionUnresolved).length, 0);
  const available = MAX_WAVE_TASKS - active;
  return available > 0 ? selectReadySubagentTasks(state.plan, available) : [];
}

function recordDispatchFailure(pi: any, tasks: any[], reason: string) {
  const ids = tasks.map((task) => task.id);
  const previous = state.plan.executions.findLast((batch: any) => batch.status === "failed");
  if (previous?.error === reason && sameIds(previous.taskIds, ids)) return;
  const requestId = randomUUID();
  state.plan.executions = retainExecutions([...state.plan.executions, {
    requestId, taskIds: ids, planRevision: state.plan.revision, status: "failed", startedAt: now(),
    completedAt: now(), error: reason, results: [],
  }]);
  state = recordExecutionEvent(state, { status: "failed", summary: "Subagent dispatch did not start.", text: reason, ref: requestId });
  persistState(pi);
}

function reportDispatchError(ctx: any, error: unknown) {
  if (needsRestore) ctx?.abort?.();
  ctx?.ui?.notify?.(`Compass dispatch could not finish: ${error instanceof Error ? error.message : String(error)}`, "error");
}

async function admitReadySubagents(pi: any, generation: number, ctx: any) {
  if (!inCurrentBranch(pi, generation) || !readyForDispatch(ctx).length) return;
  const cwd = contextCwd(ctx);
  const availability = await executionAvailability(pi, cwd);
  await serializedInBranch(pi, generation, async () => {
    const candidates = readyForDispatch(ctx);
    if (!candidates.length) return;
    const policy = assessWavePolicy(candidates, state.plan.executionHistory, candidates.length);
    if (["serial_short_tasks", "provider_cooldown"].includes(policy.mode) && state.plan.executions.some(executionUnresolved)) return;
    const ready = candidates.slice(0, policy.maxTasks);
    if (!availability.ok) {
      recordDispatchFailure(pi, ready, availability.reason);
      return;
    }
    const waveId = randomUUID();
    const frameScope = restoreContextState(ctx.sessionManager.getBranch()).frames.at(-1)?.id ?? null;
    let requests;
    try {
      requests = ready.map((task: any) => buildSubagentDelegationRequest({
        task, goal: state.goal.current, constraints: state.goal.constraints, cwd,
        ownerRunId: waveId, requestId: randomUUID(), model: primaryModelForTask(task),
      }));
    } catch (error) {
      recordDispatchFailure(pi, ready, error instanceof Error ? error.message : String(error));
      return;
    }
    const refusals = await Promise.all(requests.map((request: any) => checkLaunch(pi, ctx, availability.runtime, request)));
    if (!inCurrentBranch(pi, generation) || !goalInputIsCurrent(ctx)) return;
    const denied = refusals.findIndex(Boolean);
    if (denied >= 0) {
      recordDispatchFailure(pi, ready, `${ready[denied].id}: ${refusals[denied]} No child was dispatched.`);
      return;
    }
    state = transitionTasks(state, "start", ready.map((task: any) => ({ id: task.id })), updateTasks).state;
    const batch = executionRecordForWave(waveId, ready, state.plan.revision, state.plan.stateVersion, requests.map((request: any) => request.requestId), policy, frameScope);
    state.plan.executions.push(batch);
    state = recordExecutionEvent(state, {
      status: "dispatching", summary: `Prepared ${ready.length} read-only Subagent task(s).`, text: policy.reason, ref: waveId,
    });
    persistState(pi);
    for (const [i, request] of requests.entries()) {
      if (!inCurrentBranch(pi, generation)) return;
      if (!dagApprovalStatus(state).approved || !goalInputIsCurrent(ctx)) {
        const staged = executionBatch(waveId);
        const pendingIds = staged.taskIds.slice(i);
        state.plan = updateTasks(state.plan, pendingIds.map((id: string) => ({ id, status: "pending" })));
        if (i === 0) state.plan.executions = state.plan.executions.filter((item: any) => item.requestId !== waveId);
        else { staged.taskIds = staged.taskIds.slice(0, i); staged.results = staged.results.slice(0, i); }
        state = recordExecutionEvent(state, { status: "blocked", summary: "New Human input paused child launch.", ref: waveId });
        persistState(pi);
        return;
      }
      void runDelegatedNode(pi, generation, ctx, availability.runtime, request).catch((error) => reportDispatchError(ctx, error));
    }
  });
}

// Claim dispatch in the branch queue, but never hold admission while children run.
function scheduleReadySubagentWaves(pi: any, ctx: any) {
  if (autoSchedulers.has(pi) || !readyForDispatch(ctx).length) return false;
  const generation = branchGeneration;
  const admission = Promise.resolve().then(() => admitReadySubagents(pi, generation, ctx));
  autoSchedulers.set(pi, admission);
  void admission.catch((error) => reportDispatchError(ctx, error)).finally(() => {
    if (autoSchedulers.get(pi) === admission) autoSchedulers.delete(pi);
  });
  return true;
}
async function handleCompassToolResult(pi: any, event: any, ctx: any) {
  if (event?.isError || !["compass_goal", "compass_plan"].includes(event?.toolName)) return;
  return serialized(() => {
    if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; }
    if (!scheduleReadySubagentWaves(pi, ctx)) return;
    const receipt = JSON.parse(event.content?.[0]?.text ?? "{}");
    return { content: [{ type: "text", text: JSON.stringify({ ...receipt, dispatch: "queued" }) }] };
  });
}

function markUnresolvedExecutionUnknown(reason: string): boolean {
  const changed = [];
  for (const execution of state.plan.executions.filter(executionUnresolved)) {
    const wasRunning = execution.status !== "unknown" || execution.results.some((row: any) => ["dispatching", "running"].includes(row.status));
    if (!wasRunning) continue;
    execution.status = "unknown";
    execution.completedAt = null;
    execution.error = reason;
    execution.results = execution.results.map((item: any) => executionUnresolved(item)
      ? { ...item, status: "unknown", error: reason } : item);
    changed.push(execution.requestId);
  }
  for (const ref of changed) state = recordExecutionEvent(state, { status: "unknown", summary: "Native lifecycle changed; unresolved Subagent batch is unknown.", text: reason, ref });
  return changed.length > 0;
}
function inCurrentBranch(pi: any, generation: number): boolean {
  return activePi === pi && branchGeneration === generation;
}
function serializedInBranch<T>(pi: any, generation: number, fn: () => Promise<T> | T): Promise<T | undefined> {
  return serialized(() => inCurrentBranch(pi, generation) ? fn() : undefined);
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
function observeCurrentHumanInput(ctx: any): boolean {
  const id = latestHumanSource(ctx?.sessionManager?.getBranch?.());
  if (!id) return false;
  const observed = observeHumanInput(state, id);
  if (observed.changed) state = observed.state;
  return observed.changed;
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
function nodeInputs(task: any, ctx: any) {
  const from = (task.fromTasks ?? []).map((id: string) => state.plan.tasks.find((item: any) => item.id === id));
  const refs = [...(task.inputRefs ?? [])];
  for (const prerequisite of from) {
    if (!prerequisite?.artifacts?.length) throw new Error(`Node ${prerequisite?.id ?? "prerequisite"} has no exported artifact. Patch the plan or return an artifact from that node. No state changed.`);
    refs.push(...prerequisite.artifacts);
  }
  const index = sourceIndex(ctx.sessionManager.getBranch(), { context: contextBoundaryPreview(ctx) });
  const captures = [...new Set(refs)].map((ref: any) => {
    const selection = contextSelection(ref);
    const value = currentValue(contextState, index, selection.id, { key: selection.binding });
    if (value.version !== selection.version || index.byId.get(selection.id)?.details?.action !== "export") {
      throw new Error("The planned artifact is stale or is not an exported frame value. Select the current exact export. No state changed.");
    }
    return { ...selection, mode: "ref" };
  });
  const carried = state.plan.tasks.filter((item: any) => (item.artifacts ?? []).some((ref: string) => refs.includes(ref)));
  const caveats = [...from, ...carried].flatMap((item: any) => item.assessment?.caveats ?? []);
  return { captures, caveats: [...new Set(caveats)] };
}

function verifyNodeOperation(operation: any, ctx: any) {
  const { node, outcome } = operation;
  if (!node) return;
  const { taskId, goalVersion, planRevision } = node;
  const task = state.plan.tasks.find((item: any) => item.id === taskId);
  if (!task || state.goal.version !== goalVersion || state.plan.revision !== planRevision) throw new Error("The node belongs to an older Goal or plan. No state changed.");
  if (operation.action === "call") {
    if (!goalInputIsCurrent(ctx) || !dagApprovalStatus(state).approved || !readyTasks(state.plan).some((item: any) => item.id === taskId)) {
      throw new Error("The node is not ready under a current exact approval. No state changed.");
    }
    if (task.executor !== "parent" || contextState.frames.length) throw new Error("Start a parent node from the root frame; Code Mode and native children have separate execution routes. No state changed.");
    return task;
  } else if (operation.action === "return") {
    if (contextState.frames.at(-1)?.node?.taskId !== taskId || task.status !== "in_progress") throw new Error("Only the active node frame can submit this outcome. No state changed.");
    if (outcome?.status === "throw") noMutation(() => stopPlan(state, { taskId, ...outcome }, updateTasks));
    else {
      const field = outcome?.status === "done" ? "evidence" : "reason";
      if (!["done", "blocked"].includes(outcome?.status) || !outcome[field]?.trim()) throw new Error("A node return needs done with evidence, blocked with a reason, or throw with both. No state changed.");
    }
  }
}

function reconcileNodeFrame(ctx: any) {
  const effect = contextState.nodeEffect;
  if (!effect || effect.revision <= (state.plan.nodeContextRevision ?? 0)) return;
  const { node, outcome, artifacts } = effect;
  const task = state.plan.tasks.find((item: any) => item.id === node.taskId);
  if (!task || state.goal.version !== node.goalVersion || state.plan.revision !== node.planRevision) return;
  let expired = false;
  if (!outcome) {
    if (task.status === "pending" && goalInputIsCurrent(ctx) && dagApprovalStatus(state).approved && readyTasks(state.plan).some((item: any) => item.id === task.id)) {
      state = transitionTasks(state, "start", [{ id: task.id }], updateTasks).state;
    } else {
      expired = true;
      state = recordExecutionEvent(state, { status: "blocked", summary: "The node frame opened after authorization expired; do not start work. Return from the frame and review the plan.", ref: task.id });
    }
  } else if (task.status === "in_progress") {
    if (outcome.status === "throw") state = stopPlan(state, { taskId: task.id, ...outcome }, updateTasks);
    else state.plan = updateTasks(state.plan, [{ id: task.id, ...outcome }], { terminalEvidence: true });
    if (outcome.status === "done" && artifacts.length) state.plan.tasks.find((item: any) => item.id === task.id).artifacts = artifacts;
    state = recordExecutionEvent(state, { status: outcome.status, summary: `Node ${task.id} frame returned: ${outcome.status}.`, ref: task.id, text: outcome.evidence || outcome.reason });
  }
  state.plan.nodeContextRevision = effect.revision;
  persistState(activePi);
  if (expired) throw new Error("Node frame was not authorized at commit. Return without an outcome and review the plan before working.");
}

function restoreContext(ctx: any) {
  try {
    const branch = ctx?.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) throw new Error("Native active-branch context is unavailable; no context state was reset.");
    contextState = restoreContextState(branch);
    const frame = contextState.frames.at(-1);
    if (ctx?.hasUI) ctx.ui?.setStatus?.("compass-frame", frame ? `frame ${contextState.frames.length} · ${frame.id}` : "frame: root");
    return contextState;
  } catch (error) {
    // Hook exceptions alone do not stop Pi's provider request. Abort through the
    // public lifecycle API if a context commit is corrupt or incomplete.
    ctx?.abort?.();
    throw error;
  }
}
function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => part?.type === "text" && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n").trim();
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

function errorSummary(event: any): string {
  const result = event?.result;
  const content = Array.isArray(result?.content) ? result.content.map((part: any) => part?.type === "text" ? part.text : "").filter(Boolean).join("\n") : "";
  return clip(event?.error || content || result?.error || "Tool execution failed without a text error.", 260);
}

function canPresentApproval(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui?.custom === "function";
}

function contextCwd(ctx: any) { return typeof ctx?.cwd === "string" && ctx.cwd.trim() ? ctx.cwd : process.cwd(); }
function afterMutation(pi: any, cwd: string) { state.projectRoot = cwd; persistState(pi); }
function stateResult(data: any = {}, unchanged = false) {
  return agentResult({ ...(unchanged ? { unchanged: true } : {}), ...data, cursor: stateCursor(state, contextState.revision) }, { stateRevision: state.stateRevision });
}
function planResult(data: any = {}, unchanged = false) {
  const approval = dagApprovalStatus(state);
  const prompt = !approval.approved ? approvalPrompt(state.plan.approvalRequest) : null;
  return stateResult({ ...data, approval: approval.approved ? "approved" : approval.status, ...(prompt ? { prompt } : {}), ...(approval.approved ? { ready: readyTasks(state.plan).map((task: any) => task.id) } : {}) }, unchanged);
}
function refreshAfterHumanInput(pi: any, ctx: any) { state.projectRoot = contextCwd(ctx); persistState(pi); }
function restoreForTool(ctx: any, readOnly: boolean) {
  if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; }
  restoreContext(ctx);
  if (!readOnly) reconcileNodeFrame(ctx);
}
function handleQuestionResult(pi: any, event: any, ctx: any) {
  return serialized(async () => {
    if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; }
    const callId = String(event.toolCallId ?? "");
    const sourceId = persistedAssistantEntryId(ctx, callId);
    const details = event.details;
    const dagRequest = state.plan.approvalRequest;
    const owned = dagRequest?.sourceEntryId === sourceId && dagRequest?.toolCallId === callId;
    const failure = questionnaireFailureResultPatch(event);
    if (event.isError || failure) {
      const recorded = recordHumanQuestionnaireFailure(state, { source: "ask_user_question", sourceEntryId: sourceId, sourceCallId: callId, errorCode: details?.error ?? "unknown", reason: messageText({ content: failure?.content ?? event.content }) });
      if (recorded.captured) { state = recorded.state; persistState(pi); }
      return failure;
    }
    if (!sourceId) return;
    const captured = captureHumanDecision(state, { source: "ask_user_question", sourceEntryId: sourceId, sourceCallId: callId, text: messageText(event), details });
    if (!captured.captured) return;
    state = captured.state;
    persistState(pi);
    if (dagApprovalStatus(state).approved) scheduleReadySubagentWaves(pi, ctx);
    const complete = normalizeQuestionnaireRecord(details, { preserveFullText: true });
    const decision = complete ? { outcome: complete.outcome, answers: complete.answers.map(({ question, answer, selected, notes }) => ({ question, answer, ...(selected ? { selected } : {}), ...(notes ? { notes } : {}) })), ...(complete.globalNote ? { note: complete.globalNote } : {}), ...(complete.unanswered?.length ? { unanswered: complete.unanswered } : {}) } : null;
    if (owned) return { content: agentResult({ decision, ...(dagApprovalStatus(state).approved ? { plan: "approved" } : {}) }).content };
  });
}

function registerTools(pi: any) {
  const definitions: Record<string, {
    label: string;
    description: string;
    readOnly?: boolean;
    exposure?: "model-only";
    execute(input: Record<string, unknown>, context: unknown, toolCallId: string): Promise<unknown>;
  }> = {
    compass_goal: {
      label: "Goal", description: "Own semantic Goal, complete Human constraints and acceptance definitions. set explicitly creates/reaffirms/replaces; sources identify the actual original instructions, not just the latest follow-up. decide records a material decision; checkpoint records a real recoverable reference. No Human approval is inferred.",
      execute: async (params: any, ctx: any) => {
        if (params.action === "set") {
          const branch = ctx.sessionManager.getBranch();
          const latest = latestHumanSource(branch);
          const candidate = latest ? observeHumanInput(state, latest).state : state;
          const result = noMutation(() => setGoal(candidate, { expectedVersion: candidate.goal.version, current: params.current, constraints: params.constraints, sourceIds: resolveGoalSources(branch, params.sources), ...(Object.hasOwn(params, "criteria") ? { criteria: params.criteria } : {}) }));
          if (result.changed) { state = result.state; afterMutation(pi, contextCwd(ctx)); }
          return stateResult({ ...(result.replaced ? { replaced: true } : {}), ...(Object.hasOwn(params, "criteria") ? { criteria: state.goal.criteria.map(({ id, text }: any) => ({ id, text })) } : {}), ...(state.plan.tasks.length && !dagApprovalStatus(state).approved ? { approval: "required" } : {}) }, !result.changed);
        }
        if (params.action === "update") {
          const latest = latestHumanSource(ctx.sessionManager.getBranch());
          const candidate = latest ? observeHumanInput(state, latest).state : state;
          const result = noMutation(() => updateGoal(candidate, params));
          if (result.changed) { state = result.state; afterMutation(pi, contextCwd(ctx)); }
          return stateResult({
            ...(params.constraintEdits ? { constraints: addressedConstraints(state.goal.constraints) } : {}),
            ...(params.criterionEdits ? { criteria: state.goal.criteria.map(({ id, text }: any) => ({ id, text })) } : {}),
            ...(state.plan.tasks.length && !dagApprovalStatus(state).approved ? { approval: "required" } : {}),
          }, !result.changed);
        }
        if (params.action === "decide") {
          const result = noMutation(() => recordDecision(state, { ...params, supersedesDecisionIds: params.supersedes, affectedTaskIds: params.taskIds }));
          state = result.state; afterMutation(pi, contextCwd(ctx));
          return stateResult({ decision: result.item?.id ?? state.decisions.at(-1)?.id });
        }
        if (params.action === "checkpoint") {
          const result = noMutation(() => recordCheckpoint(state, { summary: params.note ?? "Recoverable checkpoint", ref: params.ref }));
          state = result.state; afterMutation(pi, contextCwd(ctx));
          return stateResult({ checkpoint: result.item?.id ?? state.checkpoints.at(-1)?.id });
        }
        throw new Error("Unknown Goal action. No state changed.");
      },
    },
    compass_state: {
      label: "State", description: "Read only the missing Goal, plan, acceptance, execution or bounded history view. Default summary is compact; reuse returned cursors instead of polling. Full requested evidence/caveats are preserved. No tool activation or semantic mutation.", readOnly: true,
      execute: async (params: any, ctx: any) => {
        const branch = ctx.sessionManager.getBranch();
        if (params.view === "retained") {
          if (params.cursor !== undefined) throw new Error("cursor applies only to summary. No state changed.");
          return agentResult(retainedContext(branch, { context: contextBoundaryPreview(ctx) }, contextState, state.goal.version, params.limit ?? 12));
        }
        const latest = latestHumanSource(branch);
        const observed = latest && latest !== state.latestHumanEntryId ? observeHumanInput(state, latest).state : state;
        return agentResult(agentState(observed, branch, contextState, params));
      },
    },
    compass_context_search: {
      label: "Find Context", description: "Recover missing Human instructions, observed data or working memory. Query uses literal keywords; exact refs recover across available scopes. Short snippets default; handles omits text; details adds qualifications. No mutation.", readOnly: true,
      execute: async (params: any, ctx: any) => agentResult(agentSearch(ctx.sessionManager.getBranch(), { context: contextBoundaryPreview(ctx) }, contextState, params)),
    },
    compass_context: {
      label: "Context", exposure: "model-only", description: "Retain compact qualified memory or full originals; manage same-session attention frames and work values. Reuse opaque refs. One pin/unpin/remember may accompany sibling tools; other operations must be standalone. queued is provisional; use the native applied/rejected receipt, never poll. A frame is not filesystem rollback. Export retained values explicitly to preserve their lifetime in the parent.",
      execute: async (input: any, ctx: any, toolCallId: string) => {
        const branch = ctx.sessionManager.getBranch();
        const boundary = { context: contextBoundaryPreview(ctx) };
        const normalized: any = agentContextOperation(branch, boundary, contextState, input);
        if (input.action === "call" && input.taskId !== undefined) {
          if (input.task !== undefined) throw new Error("Choose taskId for a plan node or task for ordinary attention, not both. No state changed.");
          normalized.node = { taskId: input.taskId, goalVersion: state.goal.version, planRevision: state.plan.revision };
          const task = verifyNodeOperation(normalized, ctx);
          const { captures, caveats } = (task.fromTasks?.length || task.inputRefs?.length) ? nodeInputs(task, ctx) : { captures: [], caveats: [] };
          normalized.capture = [...captures, ...(normalized.capture ?? [])];
          normalized.task = [task.title, `Acceptance: ${task.acceptance}`, task.writeScope ? `Write scope: ${task.writeScope}` : "", ...caveats.map((note) => `Input caveat: ${note}`)].filter(Boolean).join("\n");
        }
        if (input.action === "return") {
          const node = contextState.frames.at(-1)?.node;
          const active = node && state.plan.tasks.some((item: any) => item.id === node.taskId && item.status === "in_progress");
          if (active || input.outcome) {
            if (!node) throw new Error("outcome applies only to a plan node frame. No state changed.");
            normalized.node = node;
            normalized.outcome = input.outcome;
            if ((normalized.exportIds?.length ?? 0) > 8) throw new Error("A node may export up to eight explicit artifacts. No state changed.");
            verifyNodeOperation(normalized, ctx);
          }
        }
        const prepared = await prepareContextOperation({ state: contextState, branch, boundary, operation: { ...normalized, callId: toolCallId, goalVersion: state.goal.version }, projectRoot: contextCwd(ctx) });
        const operation = prepared.operation;
        try { validateContextOperation({ state: contextState, branch, boundary, operation, content: prepared.content ?? [] }); }
        catch (error) {
          if (operation.artifact) throw new Error(String(error instanceof Error ? error.message : error) + "; verified artifact remains at " + operation.artifact.path + "; filesystem effects were not rolled back.");
          throw error;
        }
        return { content: [...agentResult({ queued: true, ...(operation.artifact?.path ? { artifact: operation.artifact.path } : {}) }).content, ...(prepared.content?.slice(1) ?? [])], details: { contextOperation: operation } };
      },
    },
    compass_plan: {
      label: "Plan", description: "Own an optional DAG: define replaces its full task graph, request_approval renews a proposal, start/done/block/reopen update tasks, assess records semantic criterion checks, throw stops progression with evidence and known side effects, cancel requests cancellation of one exact native attempt without settling it, resolve reconciles a verified terminal unknown batch. Goal alone defines criteria. Definition is a draft, not authorization. Forward the small returned prompt to native ask_user_question; code supplies its full exact proposal. Read plans through compass_state.",
      execute: async (params: any, ctx: any) => {
        const action = params.action;
        if (action === "define" || action === "patch") {
          const input = { ...params, changeReason: params.reason };
          const result = noMutation(() => action === "patch" ? patchPlanState(state, input) : revisePlanState(state, input));
          state = result.state;
          if (!result.changed) return planResult({}, true);
          afterMutation(pi, contextCwd(ctx));
          const { added, changed, removed } = state.plan.planHistory.at(-1);
          const warnings = state.plan.tasks.every((task: any) => taskDependencies(task).length === 0)
            ? ["No dependencies: check that the tasks are independent and that a DAG adds value."] : [];
          return planResult({ diff: { added, changed, removed }, ...(warnings.length ? { warnings } : {}) });
        }
        if (action === "request_approval") {
          const result = noMutation(() => renewDagApprovalRequest(state));
          state = result.state; afterMutation(pi, contextCwd(ctx));
          return planResult();
        }
        if (action === "assess") {
          const result = noMutation(() => recordTaskAssessment(state, params));
          state = result.state; afterMutation(pi, contextCwd(ctx));
          return planResult({ task: params.taskId, assessment: result.assessment.status });
        }
        if (action === "resolve") return resolveExecution(pi, params, ctx);
        if (action === "cancel") return cancelDelegatedAttempt(pi, params);
        if (action === "throw") {
          if (contextState.frames.some((frame: any) => frame.node?.taskId === params.taskId)) throw new Error("Submit throw in compass_context return so the task frame closes. No state changed.");
          if (state.plan.tasks.find((task: any) => task.id === params.taskId)?.executor === "subagent") throw new Error("Only a correlated child result can report throw for a delegated task. No state changed.");
          state = noMutation(() => stopPlan(state, params, updateTasks));
          afterMutation(pi, contextCwd(ctx));
          return planResult({ stopped: state.plan.stopped });
        }
        if (!["start", "done", "block", "reopen"].includes(action)) throw new Error("Unknown plan action. No state changed.");
        const items = action === "start" ? params.taskIds.map((id: string) => ({ id })) : params.tasks;
        if (state.plan.stopped && action === "start") throw new Error("The DAG was stopped; revise the plan. No state changed.");
        const claimed = contextState.frames.find((frame: any) => frame.node)?.node;
        if (items.some(({ id }: any) => state.plan.tasks.some((task: any) => task.id === id && task.executor === "parent" && (action === "start" || action === "done" || (action === "block" && claimed?.taskId === id))))) {
          throw new Error("Parent tasks use compass_context call with taskId and return with an outcome. No state changed.");
        }
        if (action === "start" || action === "done") {
          const delegated = items.filter(({ id }: any) => state.plan.tasks.find((task: any) => task.id === id)?.executor === "subagent");
          if (delegated.length) throw new Error("Read-only Subagent tasks start and complete by correlated native dispatch; use resolve for unknown attempts. No state changed.");
        }
        if (state.plan.executions.some((batch: any) => batch.results.some((row: any) => executionUnresolved(row) && items.some((item: any) => item.id === row.id)))) throw new Error("Task belongs to an unresolved native attempt; read execution state and reconcile it first. No state changed.");
        const result = noMutation(() => transitionTasks(state, action, items, updateTasks));
        state = result.state; afterMutation(pi, contextCwd(ctx));
        return planResult({ affected: result.affected });
      },
    },
    compass_acceptance: {
      label: "Acceptance Evidence", description: "Record evidence outcomes for existing Goal criteria; never define criteria or infer independent verification. Report actual observations as reported_pass/failed/blocked/inconclusive. A task marked done is not a verified Goal. Use compass_goal for definitions and compass_state for reads.",
      execute: async (params: any, ctx: any) => {
        let candidate = state; let changed = false; const recorded = [];
        if (new Set(params.results.map((item: any) => item.criterion)).size !== params.results.length) throw new Error("Report each criterion once per batch. No state changed.");
        for (const item of params.results) {
          const result = noMutation(() => recordAcceptanceResult(candidate, { criterionId: item.criterion, status: item.status, evidence: item.evidence, source: "agent_reported" }));
          candidate = result.state; changed ||= result.changed; recorded.push({ criterion: item.criterion, status: result.criterion.status });
        }
        if (changed) { state = candidate; afterMutation(pi, contextCwd(ctx)); }
        return stateResult({ recorded }, !changed);
      },
    },
  };
  for (const [name, definition] of Object.entries(definitions)) {
    const { readOnly, execute: run, ...declaration } = definition;
    pi.registerTool({ name, ...declaration, parameters: toolSchemas[name], annotations: { readOnlyHint: readOnly === true, destructiveHint: false, openWorldHint: false },
      async execute(id: string, args: any, ...rest: any[]) {
        return serialized(async () => { const ctx = getContext(rest); restoreForTool(ctx, readOnly === true); return run(args, ctx, id); });
      },
    });
  }
}
function cancelDelegatedAttempt(pi: any, params: any) {
  const execution = state.plan.executions.find((batch: any) => batch.results.some((item: any) => item.requestId === params.requestId && item.id === params.taskId));
  const row = execution?.results.find((item: any) => item.id === params.taskId);
  if (!executionUnresolved(execution) || !executionUnresolved(row) || row.requestId !== params.requestId) {
    throw new Error("Cancellation requires the exact unresolved native attempt. No state changed.");
  }
  const request = { requestId: row.requestId, ownerRunId: execution.requestId, nodeId: row.id };
  const pending = matchingPending(delegationRuntimes.get(pi), request);
  if (!pending || !inCurrentBranch(pi, pending.generation)) {
    throw new Error("This branch no longer tracks the exact native attempt. Check native status before reconciliation. No state changed.");
  }
  const result = { task: row.id, requestId: row.requestId, cancelRequested: true, terminal: false };
  if (row.cancelRequested) return stateResult(result, true);
  row.cancelRequested = true;
  persistState(pi);
  try {
    pi.events.emit(DELEGATION_EVENTS.cancel, request);
  } catch {
    return stateResult({ ...result, warning: "Cancellation delivery is unconfirmed. Check native status; the attempt remains unresolved." });
  }
  return stateResult(result);
}

function resolveExecution(pi: any, params: any, ctx: any) {
  const execution = executionBatch(params.requestId);
  if (execution?.status !== "unknown") throw new Error("requestId must identify an unknown batch. Read compass_state(view=execution); no state changed.");
  if (params.confirmedNoActiveRuns !== true || typeof params.confirmationEvidence !== "string" || params.confirmationEvidence.trim().length < 12) {
    throw new Error("Resolve requires confirmedNoActiveRuns=true and concrete confirmationEvidence from native Subagent status. No state changed.");
  }
  const result = noMutation(() => reconcileUnknownExecutionTasks(state, params.requestId, params.results, updateTasks));
  state = result.state;
  const latest = executionBatch(params.requestId);
  const byId = new Map(params.results.map((item: any) => [item.id, item]));
  latest.results = latest.results.map((row: any) => {
    if (!executionUnresolved(row)) return row;
    const item: any = byId.get(row.id);
    return { ...row, status: item.status, ...(item.status === "done" ? { summary: clip(item.evidence, 800), error: "" } : { error: clip(item.reason, 600) }) };
  });
  settleDelegationWave(params.requestId, clip(params.confirmationEvidence, 600));
  afterMutation(pi, contextCwd(ctx));
  return planResult({ requestId: params.requestId, settled: result.affected });
}

registerTools(pi);
pi.on("session_start", async (_event: any, ctx: any) => {
  branchGeneration += 1; autoSchedulers.delete(pi);
  await serialized(() => { state = adoptBranchState(ctx); needsRestore = false; state.projectRoot = contextCwd(ctx); restoreContext(ctx); });
});
pi.on("session_tree", async (_event: any, ctx: any) => {
  branchGeneration += 1; autoSchedulers.delete(pi);
  return serialized(() => { state = adoptBranchState(ctx); needsRestore = false; state.projectRoot = contextCwd(ctx); restoreContext(ctx); });
});
pi.on("session_shutdown", async (_event: any, ctx: any) => {
  branchGeneration += 1; autoSchedulers.delete(pi);
  await serialized(() => { if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; } if (markUnresolvedExecutionUnknown("Pi session shut down; verify recorded native child runs before reconciliation.")) persistState(pi); });
  const runtime = delegationRuntimes.get(pi);
  if (runtime) {
    for (const pending of runtime.pending.values()) { clearTimeout(pending.ackTimer); clearTimeout(pending.responseTimer); clearTimeout(pending.retainTimer); if (pending.settled) continue; pending.settled = true; pending.resolve({ __compassUnknown: true, reason: "Runtime shut down; native child outcome requires reconciliation." }); }
    runtime.pending.clear();
    for (const probe of runtime.probeWaiters.values()) probe.resolve(null);
    runtime.probeWaiters.clear();
    for (const dispose of runtime.disposers) dispose();
    delegationRuntimes.delete(pi);
  }
  activePi = null;
});
  // Observe native identity only. Meaning, scope and constraints belong to the
  // Agent's explicit compass_goal submission, never to prompt classifiers.
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    await serialized(async () => {
      if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; }
      restoreContext(ctx);
      reconcileNodeFrame(ctx);
      if (observeCurrentHumanInput(ctx)) refreshAfterHumanInput(pi, ctx);
    });
    // Recovery can dispatch only an already approved Goal interpretation of the
    // latest native Human input. A fresh message pauses, rather than guesses.
    scheduleReadySubagentWaves(pi, ctx ?? {});
  });

  pi.on("message_end", async (event: any, ctx: any) => {
    const message = event?.message;
    const human = message?.role === "user";
    const nativeWatch = message?.role === "custom" && ["watch-condition", "watch-lost"].includes(message.customType);
    if (!human && !nativeWatch) return;
    await serialized(async () => {
      if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; }
      restoreContext(ctx);
      if (nativeWatch) {
        const released = releaseWatchMessages(contextState, messageText(message));
        if (released) {
          pi.appendEntry(CONTEXT_STATE_TYPE, released.entry.data);
          restoreContext(ctx);
        }
      } else if (observeCurrentHumanInput(ctx)) refreshAfterHumanInput(pi, ctx);
    });
  });

  // Goal state is reconciled by revision, not blindly overwritten by whichever
  // branch snapshot happens to be returned during context assembly.
  pi.on("context", async (_event: any, ctx: any) => {
    await mutationQueue;
    try {
      if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; }
      else {
        const branchState = restoreState(ctx);
        if (branchState.stateRevision > (state.stateRevision ?? 0) || (!state.goal.original && branchState.goal.original)) {
          state = branchState;
          lastCommittedState = clone(branchState);
        }
      }
      restoreContext(ctx);
      reconcileNodeFrame(ctx);
      // Do not rebuild request history or append a volatile full-state state message.
    } catch (error) {
      needsRestore = true;
      ctx?.abort?.();
      throw error;
    }
  });

  pi.on("context_with_system", async (event: any, ctx: any) => {
    await mutationQueue;
    if (!Array.isArray(event?.messages)) return;
    // Retired Compass-internal messages are persistence, never instructions.
    // Preserve Pi's original system/tool patches instead of folding them into the head.
    const messages = event.messages.filter((message: any) => !(message?.role === "custom" && RESERVED_CUSTOM_TYPES.includes(message?.customType)));
    try {
      if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; }
      const branch = ctx?.sessionManager?.getBranch?.();
      if (!Array.isArray(branch)) throw new Error("Native branch is unavailable; retained pins cannot be restored for this request.");
      const committed = restoreContextState(branch);
      if (!committed.pins.length) {
        if (messages.length !== event.messages.length) return { messages };
        return;
      }
      const overlays = pinnedContextOverlay(branch, committed, messages, state.goal.version);
      const output = [...messages, ...overlays];
      if (messages.length !== event.messages.length || overlays.length) return { messages: output };
    } catch (error) {
      // Request-only retention is fail-closed: do not silently send a request
      // that omits a required pin. The public abort path is the only supported
      // lifecycle control; the handler error remains visible to the host.
      ctx?.abort?.();
      throw error;
    }
  });

  // Native context edits are committed at turn_end, including an aborted turn.
  // This is the only point where Compass changes the canonical projection; it
  // never creates a second session, mutates the transcript in place, or filters
  // cloned messages by position.
  pi.on("turn_end", async (event: any, ctx: any) => serialized(async () => {
    if (needsRestore) { state = adoptBranchState(ctx); restoreContext(ctx); needsRestore = false; }
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    restoreContext(ctx);
    try {
      const nodeOperation = event.toolResults?.find((result: any) => !result.isError && result.toolName === "compass_context" && result.details?.contextOperation?.node)?.details.contextOperation;
      if (nodeOperation) {
        const task = verifyNodeOperation(nodeOperation, ctx);
        if (task && (task.fromTasks?.length || task.inputRefs?.length)) nodeInputs(task, ctx);
      }
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
          content: JSON.stringify({ resultStatus: "rejected", stateChanged: false, error: message }),
          display: false,
          details: { contextError: true, status: "rejected", stateChanged: false, contextRevision: contextState.revision },
        }],
        continue: false,
      };
    }
  }));

  // Pi rebuilds this preview after the preceding boundary handler. Compose from
  // its proposed state without activating it; persist only through Pi's commit.
  pi.on("turn_end", async (event: any, ctx: any) => serialized(async () => {
    try {
      const branch = ctx?.sessionManager?.getBranch?.() ?? [];
      const proposed = (event.entries ?? []).findLast((entry: any) => entry.type === "custom" && entry.customType === CONTEXT_STATE_TYPE);
      const input = proposed ? normalizeContextState(proposed.data) : restoreContext(ctx);
      const observed = planObservationBoundary({ state: input, branch, boundary: event, goalVersion: state.goal.version });
      const prefix = [...(event.entries ?? []), ...(observed?.entries ?? [])];
      // Only our appended data snapshots are synthesized here. Native view edits
      // remain Pi-owned; the following presence check never attributes other content.
      const snapshots = (observed?.entries ?? []).filter((entry: any) => entry.type === "custom_message" && entry.customType === "pi-compass-v2.value").map((entry: any) => ({ ...entry, role: "custom", timestamp: 0 }));
      const preview = { ...event, entries: prefix, context: { ...event.context, contextMessages: [...event.context.contextMessages, ...snapshots] } };
      const planned = planRetentionBoundary({ state: observed?.state ?? input, branch, boundary: preview });
      if (observed || planned) return { entries: [...prefix, ...(planned?.entries ?? [])] };
    } catch (error) {
      ctx?.abort?.();
      throw error;
    }
  }));


pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => serialized(async () => {
  if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; }
  if (event.toolName === "ask_user_question") {
    let questions: ReturnType<typeof expandApprovalProposal>;
    try { questions = expandApprovalProposal(state, event.input); }
    catch (error) {
      // An expired or malformed proposal is a corrective Agent error, not a host crash.
      return { block: true, reason: (error instanceof Error ? error.message : String(error)) + " Request a fresh proposal; no approval changed." };
    }
    if (questions) {
      if (!canPresentApproval(ctx)) return { block: true, reason: `Compass approval requires interactive Pi with full-preview TUI (mode=${ctx.mode}, hasUI=${ctx.hasUI}). No approval or state changed.` };
      Object.assign(event.input, { questions });
      const callId = String(event.toolCallId ?? "");
      const sourceId = persistedAssistantEntryId(ctx, callId);
      const result = bindDagApprovalQuestionnaire(state, event.input, sourceId, callId);
      if (!result.bound) return { block: true, reason: "Native proposal identity could not be bound. Request a fresh proposal; no approval changed." };
      state = result.state; persistState(pi);
    }
  }
    const rawTargets = explicitWriteTargets(event);
    if (!rawTargets.length) return;
    const cwd = state.projectRoot || process.cwd();
    let writeAdded = false;
    let driftChanged = false;
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
      const driftReason = hasActivePlan ? executionDriftReason({ tasks: state.plan.tasks, target, cwd }) : "";
      const drift = driftReason ? recordExecutionDrift(state, { tool: event?.toolName, target, reason: driftReason }) : { state, changed: false };
      if (drift.changed) { state = drift.state; driftChanged = true; }
    }
    // Path-scope drift is advisory evidence. Compass does not coordinate
    // worktrees or act as a global write lock; the Agent/native executor owns
    // filesystem coordination.
    // Repeated identical writes/drift are no-ops. Observable path violations are
    // retained as advisory evidence.
    if (writeAdded || driftChanged) persistState(pi);
  }));
  pi.on("tool_result", async (event: any, ctx: any) => event.toolName === "ask_user_question" ? handleQuestionResult(pi, event, ctx) : handleCompassToolResult(pi, event, ctx));

  pi.on("tool_execution_end", async (event: any, ctx: any) => serialized(async () => {
    if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; }
    const toolName = String(event?.toolName ?? "");
    const failed = Boolean(event?.isError || event?.result?.isError);
    // Code Mode emits native completion events for nested calls without adding
    // their results to the transcript/turn_end list. Consume deterministic watch
    // receipts here; the top-level boundary observes the same receipt as a no-op.
    if (!failed && ["watch", "unwatch"].includes(toolName)) {
      restoreContext(ctx);
      const result = event?.result ?? event?.output ?? event?.message;
      const planned = planWatchBoundary({ state: contextState, boundary: { toolResults: [{ ...result, toolName }] } });
      if (planned) {
        pi.appendEntry(CONTEXT_STATE_TYPE, planned.state);
        restoreContext(ctx);
      }
      return;
    }
    if (!failed) {
      return;
    }
    state = recordFailure(state, { tool: toolName, error: errorSummary(event), at: now() });
    const item = state.trace.failures.at(-1);
    persistTrace(pi, { kind: "failure", item });
    persistState(pi);
  }));


const runtimeGuards = registerRuntimeGuards(pi, { profileDir: getAgentDir });
pi.registerCommand("compass-preflight", { description: "Check Compass tools, native host/scope health and optional DAG dependencies", handler: async (_args: string, ctx: ExtensionCommandContext) => {
  const all = namesFrom(pi.getAllTools?.() ?? []);
  let guardError = "";
  try { await runtimeGuards.control({ action: "get" }, ctx); } catch (error) { guardError = String(error instanceof Error ? error.message : error); }
  const checks = [
    { name: "Release", ok: PACKAGE_VERSION === GOAL_RUN_RELEASE, detail: GOAL_RUN_RELEASE },
    { name: "GoalRun", ok: GOAL_RUN_API_VERSION === 10, detail: String(GOAL_RUN_API_VERSION) },
    { name: "Fixed tool registry", ok: COMPASS_TOOL_NAMES.every((name) => all.includes(name)) && !all.some((name) => name.startsWith("compass_") && !COMPASS_TOOL_NAMES.includes(name)), detail: COMPASS_TOOL_NAMES.join(", ") },
    { name: "Runtime guard host/scope read", ok: !guardError, detail: guardError || "ready; observed-input boundary only" },
  ];
  const approvalIssue = !canPresentApproval(ctx)
    ? `need Pi full-preview TUI (mode=${ctx.mode}, hasUI=${ctx.hasUI})`
    : !namesFrom(pi.getActiveTools?.()).includes("ask_user_question") && "enable the native ask_user_question tool";
  const delegation = await executionAvailability(pi, ctx.cwd);
  const body = [
    ...checks.map((check) => `${check.ok ? "PASS" : "BLOCKER"} ${check.name}: ${check.detail}`),
    approvalIssue ? `UNAVAILABLE DAG approval: ${approvalIssue}` : "PASS DAG approval transport: Pi TUI and active questionnaire",
    delegation.ok ? "PASS Native DAG delegation: bridge and launch preflight available; individual child profiles are checked at dispatch" : `UNAVAILABLE Native DAG delegation: ${delegation.reason}`,
  ].join("\n");
  ctx.ui.notify(body, checks.every((check) => check.ok) ? "info" : "error");
} });
}
