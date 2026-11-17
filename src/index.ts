import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { executionDriftReason } from "./write-scope.mjs";
import { questionnaireFailureResultPatch, normalizeQuestionnaireRecord } from "./questionnaire-integration.mjs";
import { latestHumanSource, resolveGoalSources } from "./goal-sources.mjs";
import { agentResult } from "./compass-result.mjs";
import { agentState } from "./agent-state.mjs";
import { toolSchemas, COMPASS_TOOL_NAMES } from "./tool-schema.mjs";
import { approvalPrompt } from "./dag-approval.mjs";
import { agentSearch, agentContextOperation } from "./context-agent.mjs";
import { RESERVED_CUSTOM_TYPES } from "./context-values.mjs";
import { registerRuntimeGuards } from "./runtime-guard.mjs";
import { DELEGATION_EVENTS, FALLBACK_MODEL, PRIMARY_MODEL, REVIEW_MODEL, DEFAULT_THINKING, DEFAULT_TIMEOUT_MS, MAX_WAVE_TASKS, START_ACK_TIMEOUT_MS, assessWavePolicy, hasCompleteUsageMetrics, buildSubagentDelegationRequest, selectReadySubagentTasks, parseSubagentDelegationResponse, normalizeProviderDiagnostics, providerFallbackReason } from "./execution-orchestrator.mjs";
import { readyTasks, updateTasks } from "./dag-core.mjs";
import { setGoal, observeHumanInput, stateCursor, GOAL_RUN_API_VERSION, GOAL_RUN_RELEASE, recordAcceptanceResult, bindDagApprovalQuestionnaire, bindRouteSetQuestionnaire, captureHumanDecision, dagApprovalStatus, recordTaskAssessment, renewDagApprovalRequest, emptyGoalRunState, mergeTrace, normalizeGoalRunState, recordCheckpoint, recordDecision, recordFailure, recordHumanQuestionnaireFailure, recordExecutionDrift, recordExecutionEvent, recordWriteTarget, createRouteSet, recordRouteSelection, proposeRouteExploration, registerCompetitorRun, recordCompetitorResult, acceptRouteResult, updateCompetitorCancellation, renewRouteProposal, revisePlanState, transitionTasks, reconcileUnknownExecutionTasks, expandApprovalProposal } from "./goal-run.mjs";
import { CONTEXT_MESSAGE_TYPE, CONTEXT_STATE_TYPE, emptyContextState, normalizeContextState, pinnedContextOverlay, planContextBoundary, planRetentionBoundary, planObservationBoundary, planWatchBoundary, prepareContextOperation, validateContextOperation, releaseWatchMessages, restoreContextState } from "./context-core.mjs";

const STATE_ENTRY_TYPE = "pi-compass-v2.goalrun";
const MAX_TRACE_ENTRIES = 24;
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export default function (pi: any) {
let state: any = emptyGoalRunState();
let contextState: any = emptyContextState();
let needsRestore = true;
let mutationQueue: Promise<any> = Promise.resolve();
let activePi: any = pi;
let branchGeneration = 0;
let lastCommittedState: any = emptyGoalRunState();
const delegationRuntimes = new WeakMap<object, any>();
const autoSchedulers = new WeakMap<object, { promise: Promise<unknown> | null }>();
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
function dispatchOneDelegation(pi: any, generation: number, runtime: any, request: any): Promise<any> {
  if (!inCurrentBranch(pi, generation)) return Promise.resolve({ __compassUnknown: true, reason: "Delegation scope changed before dispatch; no request emitted." });
  return new Promise((resolve) => {
    const pending: any = {
      request,
      generation,
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
  const allNames = (() => {
    try { return typeof pi.getAllTools === "function" ? namesFrom(pi.getAllTools()) : []; }
    catch { return []; }
  })();
  const registered = allNames.some((name: string) => /^(?:subagent|subagents)$/i.test(name));
  if (!registered) return { ok: false, runtime, reason: "pi-subagents is not registered in this Pi session; no task was dispatched." };
  // Native activation remains Pi-owned. Structured execution requires exact
  // Human approval and an Agent interpretation of the latest Human input.
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
function executionConstraints() { return state.goal.constraints; }
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
function setExecutionResult(pi: any, generation: number, waveId: string, taskId: string, patch: any) {
  return serializedInBranch(pi, generation, async () => {
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
async function applyDelegationOutcome(pi: any, generation: number, waveId: string, task: any, parsed: any, fallbackAttempted: boolean, primaryError = "") {
  await serializedInBranch(pi, generation, async () => {
    let execution = state.plan?.execution;
    if (!execution || execution.requestId !== waveId) return;
    let index = executionResultIndex(execution, task.id);
    if (index < 0) return;
    const currentResult = execution.results[index];
    if (parsed?.status === "done" && state.plan.tasks.find((item: any) => item.id === task.id)?.status === "in_progress") {
      const evidence = parsedTaskEvidence(parsed);
      // A correlated terminal response is a fact, not approval for further work.
      // Preserve it even if new Human input has paused semantic progression.
      state.plan = updateTasks(state.plan, [{ id: task.id, status: "done", evidence }]);
    } else if (state.plan.tasks.find((item: any) => item.id === task.id)?.status === "in_progress") {
      const reason = clip(`${parsed?.terminalStatus ? `Subagent ${parsed.terminalStatus}: ` : ""}${parsed?.reason || parsed?.summary || "Subagent returned no valid task evidence."}`, 600);
      state.plan = updateTasks(state.plan, [{ id: task.id, status: "blocked", reason }]);
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
  });
}
async function runReadySubagentWaves(pi: any, generation: number, ctx: any) {
  if (!inCurrentBranch(pi, generation)) return;
  if (!state.goal.current || !state.plan?.tasks?.length) return;
  if (!dagApprovalStatus(state).approved) return;
  if (state.plan.goal && state.plan.goal !== state.goal.current) return;
  // A restored or timed-out wave is never automatically re-dispatched: absence
  // of a response is not proof that a child did not start.
  if (executionUnresolved(state.plan.execution)) return;
  for (let wave = 0; wave < 24; wave += 1) {
    if (!inCurrentBranch(pi, generation)) return;
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
          await serializedInBranch(pi, generation, async () => {
            const requestId = randomUUID();
            state.plan.execution = { requestId, runId: null, taskIds: ids, planRevision: state.plan.revision, stateVersion: state.plan.stateVersion ?? 0, status: "failed", startedAt: now(), completedAt: now(), error: reason, results: [] };
            state = recordExecutionEvent(state, { status: "failed", summary: "Subagent dispatch rationale missing.", text: reason, ref: requestId });
            persistState(pi);
          });
        }
      }
      return;
    }
    const availability = await executionAvailability(pi, contextCwd(ctx) || state.projectRoot || process.cwd());
    if (!inCurrentBranch(pi, generation)) return;
    if (!availability.ok) {
      const existing = state.plan.execution;
      const ids = ready.map((task: any) => task.id);
      if (existing?.status === "failed" && existing.planRevision === state.plan.revision
        && sameIds(existing.taskIds ?? [], ids) && existing.error === availability.reason) return;
      await serializedInBranch(pi, generation, async () => {
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
      });
      return;
    }

    const waveId = randomUUID();
    const selectedPlanRevision = state.plan.revision;
    const frameScope = (() => {
      try { return restoreContextState(ctx?.sessionManager?.getBranch?.() ?? []).frames.at(-1)?.id ?? null; }
      catch { return null; }
    })();
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
    const prepared = await serializedInBranch(pi, generation, async () => {
      const currentReady = selectReadySubagentTasks(state.plan, MAX_WAVE_TASKS).slice(0, wavePolicy.maxTasks);
      if (!dagApprovalStatus(state).approved || state.plan.revision !== selectedPlanRevision || state.goal.version !== selectedGoalVersion
        || !currentReady.length || !sameIds(currentReady.map((task: any) => task.id), ready.map((task: any) => task.id))
        || executionUnresolved(state.plan.execution)) return false;
      const started = transitionTasks(state, "start", currentReady.map((task: any) => ({ id: task.id })), updateTasks);
      state = started.state;
      state.plan.execution = executionRecordForWave(waveId, currentReady, state.plan.revision, state.plan.stateVersion ?? 0, requestIds, wavePolicy, frameScope);
      state = recordExecutionEvent(state, {
        status: "dispatching",
        summary: `Auto-dispatched ${currentReady.length} read-only Subagent task(s) (${wavePolicy.mode}).`,
        text: `${wavePolicy.reason}
${currentReady.map((task: any) => `${task.id}/${task.agent || "scout"}`).join(", ")}`,
        ref: waveId,
      });
      persistState(pi);
      return true;
    });
    if (!prepared || !inCurrentBranch(pi, generation)) return;
    // Human input can arrive while availability is being checked or the prepared
    // execution record is being persisted. Recheck the exact approval and veto
    // synchronously immediately before the first provider-facing dispatch.
    if (!dagApprovalStatus(state).approved || !goalInputIsCurrent(ctx)) {
      await serializedInBranch(pi, generation, async () => {
        const execution = state.plan?.execution;
        if (!execution || execution.requestId !== waveId || execution.status !== "dispatching") return;
        state.plan = updateTasks(state.plan, execution.taskIds.map((id: string) => ({ id, status: "pending" })));
        state.plan.execution = null;
        state = recordExecutionEvent(state, {
          status: "failed",
          summary: "Prepared dispatch cancelled before child launch.",
          text: "The approval became stale or a new Human input awaits Agent interpretation before child dispatch. Tasks remain pending; no child was dispatched.",
          ref: waveId,
        });
        persistState(pi);
      });
      return;
    }

    const primaryResponses = await Promise.all(requests.map((request: any) => dispatchOneDelegation(pi, generation, availability.runtime, request)));
    if (!inCurrentBranch(pi, generation)) return;
    const fallbackJobs: any[] = [];
    let unknown = false;
    for (let index = 0; index < requests.length; index += 1) {
      if (!inCurrentBranch(pi, generation)) return;
      const request = requests[index];
      const task = ready.find((item: any) => item.id === request.nodeId);
      const response = primaryResponses[index];
      if (response?.__compassUnknown) {
        unknown = true;
        await setExecutionResult(pi, generation, waveId, task.id, { status: "unknown", error: response.reason });
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
        await setExecutionResult(pi, generation, waveId, task.id, { status: "unknown", error: "Terminal response failed correlation/shape validation; no automatic retry was attempted." });
        continue;
      }
      const fallbackReason = providerFallbackReason(response);
      if (fallbackReason) {
        fallbackJobs.push({
          task, parsed, response, fallbackReason,
          primaryError: clip(response.error || response.message || "Primary provider failed.", 400),
          request: buildSubagentDelegationRequest({
            task,
            goal: state.goal.current,
            constraints: executionConstraints(),
            cwd: contextCwd(ctx) || state.projectRoot || process.cwd(),
            ownerRunId: waveId,
            requestId: randomUUID(),
            model: FALLBACK_MODEL,
            thinking: DEFAULT_THINKING,
            timeoutMs: DEFAULT_TIMEOUT_MS,
          }),
        });
        continue;
      }
      await applyDelegationOutcome(pi, generation, waveId, task, parsed, false);
    }

    if (!inCurrentBranch(pi, generation)) return;
    if (fallbackJobs.length) {
      const fallbackResponses = await Promise.all(fallbackJobs.map(async (job: any) => {
        const launched = await serializedInBranch(pi, generation, () => {
          const execution = state.plan?.execution;
          if (!execution || execution.requestId !== waveId || !dagApprovalStatus(state).approved || !goalInputIsCurrent(ctx)) return null;
          const index = executionResultIndex(execution, job.task.id);
          if (index < 0) return null;
          const primary = execution.results[index];
          execution.results[index] = { ...primary,
            status: "dispatching", requestId: job.request.requestId, model: FALLBACK_MODEL,
            fallbackAttempted: true, fallbackReason: job.fallbackReason, primaryError: job.primaryError,
            primaryUsage: job.response.usage ?? null,
            primaryProviderDiagnostics: normalizeProviderDiagnostics(job.response.providerDiagnostics),
            runId: null, error: "",
          };
          persistState(pi);
          if (!inCurrentBranch(pi, generation)) return null;
          if (!dagApprovalStatus(state).approved || !goalInputIsCurrent(ctx)) {
            execution.results[index] = primary;
            persistState(pi);
            return null;
          }
          // Persist identity and emit without an await gap. The wrapper releases
          // the state queue before waiting for the provider's terminal result.
          return { response: dispatchOneDelegation(pi, generation, availability.runtime, job.request) };
        });
        if (!launched) {
          await applyDelegationOutcome(pi, generation, waveId, job.task, job.parsed, false);
          return null;
        }
        return launched.response;
      }));
      if (!inCurrentBranch(pi, generation)) return;
      for (let index = 0; index < fallbackJobs.length; index += 1) {
        if (!inCurrentBranch(pi, generation)) return;
        const job = fallbackJobs[index];
        const response = fallbackResponses[index];
        if (!response) continue;
        if (response?.__compassUnknown) {
          unknown = true;
          await setExecutionResult(pi, generation, waveId, job.task.id, { status: "unknown", error: response.reason, fallbackAttempted: true, primaryError: job.primaryError });
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
          await setExecutionResult(pi, generation, waveId, job.task.id, { status: "unknown", error: "Fallback response failed correlation/shape validation; no further retry was attempted." });
          continue;
        }
        await applyDelegationOutcome(pi, generation, waveId, job.task, parsed, true, job.primaryError);
      }
    }

    await serializedInBranch(pi, generation, async () => {
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
    });
    if (executionUnresolved(state.plan.execution)) return;
    // Keep running deterministic waves while ready Subagent tasks exist. Parent
    // and Code Mode tasks are deliberately left to the main Agent.
  }
}

async function recordAutoDispatchFailure(pi: any, generation: number, error: any, ctx: any) {
  await serializedInBranch(pi, generation, async () => {
    if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; }
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
  });
}
async function runReadySubagentWavesSafely(pi: any, generation: number, ctx: any) {
  if (!inCurrentBranch(pi, generation)) return;
  try {
    await runReadySubagentWaves(pi, generation, ctx);
  } catch (error) {
    try {
      if (inCurrentBranch(pi, generation)) await recordAutoDispatchFailure(pi, generation, error, ctx);
    } catch (recordingError) {
      ctx?.abort?.();
      ctx?.ui?.notify?.(`Compass could not persist the dispatch failure: ${recordingError instanceof Error ? recordingError.message : String(recordingError)}`, "error");
      return;
    }
    if (activePi === pi && needsRestore) {
      ctx?.abort?.();
      ctx?.ui?.notify?.(`Compass dispatch persistence is unconfirmed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
}
function hasAutoDispatchWork() {
  if (!state.goal.current || !state.plan?.tasks?.length || !dagApprovalStatus(state).approved) return false;
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
function scheduleReadySubagentWaves(pi: any, ctx: any) {
  let scheduler = autoSchedulers.get(pi);
  if (!scheduler) {
    scheduler = { promise: null };
    autoSchedulers.set(pi, scheduler);
  }
  if (scheduler.promise) {
    // The active runner owns the current plan and already advances through
    // dependency-ready waves. A second trigger must not queue a duplicate
    // bridge probe or redispatch after a fail-closed result.
    return { started: false, coalesced: true };
  }
  if (!hasAutoDispatchWork()) return { started: false, coalesced: false };
  const generation = branchGeneration;
  const running = Promise.resolve().then(() => runReadySubagentWavesSafely(pi, generation, ctx));
  scheduler.promise = running.finally(() => {
    scheduler!.promise = null;
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
    return `Compass Subagent execution is UNKNOWN for tasks ${(execution.taskIds ?? []).join(", ")}; do not redispatch. Inspect run IDs with native Subagent status, then use compass_state(view=execution), then compass_plan(action=resolve) only after all children are terminal.`;
  }
  if (execution?.status === "failed" && execution.error) {
    return `Compass could not auto-dispatch Subagent tasks ${(execution.taskIds ?? []).join(", ")}. No child was confirmed; tasks remain pending. ${clip(execution.error, 240)} Revise executor to parent/code or enable the user's native Subagent tool before retrying.`;
  }
  return null;
}

async function handleCompassToolResult(pi: any, event: any, ctx: any) {
  return serialized(async () => {
    if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; }
    const toolName = String(event?.toolName ?? "");
    if (event?.isError || !["compass_goal", "compass_plan"].includes(toolName)) return;

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

    const summary = automaticExecutionSummary(previousHistoryIds)
      ?? (readyBefore.length && scheduled.started
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
    // These owned results are object JSON. Appending prose made Code Mode's
    // concatenated text unparseable as soon as automatic dispatch was active.
    const receipt = JSON.parse(content[0]?.text ?? "{}");
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("Compass dispatch requires an object JSON receipt.");
    return { content: [{ type: "text", text: JSON.stringify({ ...receipt, dispatch: summary }) }, ...content.slice(1)], details };
  });
}

function markUnresolvedExecutionUnknown(reason: string): boolean {
  const execution = state.plan?.execution;
  if (!execution || !["dispatching", "running"].includes(execution.status)) return false;
  execution.status = "unknown";
  execution.completedAt = null;
  execution.error = reason;
  execution.results = (execution.results ?? []).map((item: any) => ["dispatching", "running"].includes(item.status)
    ? { ...item, status: "unknown", error: reason } : item);
  state = recordExecutionEvent(state, { status: "unknown", summary: "Native lifecycle changed; unresolved Subagent batch is unknown.", text: reason, ref: execution.requestId });
  return true;
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
function resultText(result: any): string {
  if (typeof result === "string") return result;
  if (typeof result?.output === "string") return result.output;
  if (typeof result?.text === "string") return result.text;
  return messageText({ content: result?.content });
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
function restoreForTool(ctx: any) {
  if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; }
  restoreContext(ctx);
}
function handleQuestionResult(pi: any, event: any, ctx: any) {
  return serialized(async () => {
    if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; }
    const callId = String(event.toolCallId ?? "");
    const sourceId = persistedAssistantEntryId(ctx, callId);
    const details = event.details;
    const dagRequest = state.plan.approvalRequest;
    const routeRequest = state.routeSet?.selectionRequest;
    const owned = [dagRequest, routeRequest].some((request) => request?.sourceEntryId === sourceId && request?.toolCallId === callId);
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
    if (routeRequest?.sourceEntryId === sourceId && routeRequest?.toolCallId === callId && captured.item?.questionnaire) {
      try {
        state = recordRouteSelection(state, { expectedStateVersion: state.routeSet.stateVersion, selectionRequestId: routeRequest.id, sourceEntryId: sourceId, sourceCallId: callId, questionnaire: captured.item.questionnaire, details }).state;
      } catch {
        state.routeSet.selectionRequest.status = captured.item.questionnaire.outcome === "declined" ? "declined" : "modified";
      }
    }
    persistState(pi);
    if (dagApprovalStatus(state).approved) scheduleReadySubagentWaves(pi, ctx);
    const complete = normalizeQuestionnaireRecord(details, { preserveFullText: true });
    const decision = complete ? { outcome: complete.outcome, answers: complete.answers.map(({ question, answer, selected, notes }) => ({ question, answer, ...(selected ? { selected } : {}), ...(notes ? { notes } : {}) })), ...(complete.globalNote ? { note: complete.globalNote } : {}), ...(complete.unanswered?.length ? { unanswered: complete.unanswered } : {}) } : null;
    if (owned) return { content: agentResult({ decision, ...(dagApprovalStatus(state).approved ? { plan: "approved" } : {}), ...(state.routeSet?.selectedRouteId ? { route: state.routeSet.selectedRouteId } : {}) }).content };
  });
}

function registerTools(pi: any) {
  const definitions: Record<string, any> = {
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
      label: "State", description: "Read only the missing Goal, plan, acceptance, route, execution or bounded history view. Default summary is compact; reuse returned cursors instead of polling. Full requested evidence/caveats are preserved. No tool activation or semantic mutation.", readOnly: true,
      execute: async (params: any, ctx: any) => { observeCurrentHumanInput(ctx); return agentResult(agentState(state, ctx.sessionManager.getBranch(), contextState, params)); },
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
        const normalized = agentContextOperation(branch, boundary, contextState, input);
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
      label: "Plan", description: "Own an optional DAG: define replaces its full task graph, request_approval renews a proposal, start/done/block/reopen update tasks, assess records semantic criterion checks, resolve reconciles a verified terminal unknown batch. Goal alone defines criteria. Definition is a draft, not authorization. Forward the small returned prompt to native ask_user_question; code supplies its full exact proposal. Read plans through compass_state.",
      execute: async (params: any, ctx: any) => {
        const action = params.action;
        if (action === "define") {
          const result = noMutation(() => revisePlanState(state, { tasks: params.tasks, ...(params.reason ? { changeReason: params.reason } : {}) }));
          state = result.state;
          if (result.changed) afterMutation(pi, contextCwd(ctx));
          return planResult({}, !result.changed);
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
        if (!["start", "done", "block", "reopen"].includes(action)) throw new Error("Unknown plan action. No state changed.");
        const items = action === "start" ? params.taskIds.map((id: string) => ({ id })) : params.tasks;
        if (action === "start") {
          const delegated = items.filter(({ id }: any) => state.plan.tasks.find((task: any) => task.id === id)?.executor === "subagent");
          if (delegated.length) throw new Error("Read-only Subagent tasks are started by approved native dispatch; do not start them manually. No state changed.");
        }
        const execution = state.plan.execution;
        if (executionUnresolved(execution) && items.some(({ id }: any) => execution.taskIds.includes(id))) throw new Error("Task belongs to an unresolved native batch; read execution state and reconcile it first. No state changed.");
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
    compass_route: {
      label: "Route", description: "Own alternative strategies, explicit Human route/exploration authorization, correlated competitor results and acceptance-gated cancellation. Alternatives are not DAG tasks. define supplies 2–3 routes and a shared baseline, using current Goal criterion IDs. Forward returned prompt to native ask_user_question. A Human selection applies automatically; there is no extra select step. Read through compass_state.",
      execute: async (params: any, ctx: any) => {
        const action = params.action;
        const current = { ...params, expectedStateVersion: state.routeSet?.stateVersion ?? 0 };
        let result: any;
        if (action === "define") result = noMutation(() => createRouteSet(state, { ...current, criteria: params.criteria ?? state.goal.criteria.filter((item: any) => item.goalVersion === state.goal.version).map((item: any) => item.id) }));
        else if (action === "request_selection") result = noMutation(() => renewRouteProposal(state, current));
        else if (action === "explore") result = noMutation(() => proposeRouteExploration(state, current));
        else if (action === "register") result = noMutation(() => registerCompetitorRun(state, current));
        else if (action === "result") result = noMutation(() => recordCompetitorResult(state, current));
        else if (action === "accept") result = noMutation(() => acceptRouteResult(state, current));
        else if (action.startsWith("cancel_")) result = noMutation(() => updateCompetitorCancellation(state, { ...current, action: action.slice(7) }));
        else throw new Error("Unknown route action. No state changed.");
        state = result.state; afterMutation(pi, contextCwd(ctx));
        const prompt = approvalPrompt(state.routeSet.selectionRequest);
        return stateResult({ ...(prompt ? { prompt } : {}), ...(result.run ? { run: { runId: result.run.runId, status: result.run.status, ...(result.run.result ? { result: result.run.result } : {}), ...(result.run.cancellation ? { cancellation: result.run.cancellation } : {}) } } : {}), ...(result.route ? { routeId: result.route.routeId, acceptanceGate: result.route.acceptanceGate, ...(result.route.caveats?.length ? { caveats: result.route.caveats } : {}) } : {}) });
      },
    },
  };
  for (const [name, definition] of Object.entries(definitions)) {
    const { readOnly, execute: run, ...declaration } = definition;
    pi.registerTool({ name, ...declaration, parameters: toolSchemas[name], annotations: { readOnlyHint: readOnly === true, destructiveHint: false, openWorldHint: false },
      async execute(id: string, args: any, ...rest: any[]) {
        return serialized(async () => { const ctx = getContext(rest); restoreForTool(ctx); return run(args, ctx, id); });
      },
    });
  }
}
function resolveExecution(pi: any, params: any, ctx: any) {
const execution = state.plan.execution;
            if (params.action !== "resolve") throw new Error('action must be "status" or "resolve". No state changed.');
            if (!execution || execution.status !== "unknown") throw new Error("Only an unknown Subagent batch can be manually reconciled. No state changed.");
            if (params.requestId !== execution.requestId) throw new Error("requestId does not match the current unknown batch. Read compass_state(view=execution); no state changed.");
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
            state = reconcileUnknownExecutionTasks(state, params.requestId, params.results, updateTasks).state;
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
            return stateResult({

              requestId: latest.requestId,
              taskIds: latest.taskIds,
              ready: readyTasks(state.plan).map((task: any) => task.id),
            });

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
    for (const pending of runtime.pending.values()) { clearTimeout(pending.ackTimer); clearTimeout(pending.responseTimer); pending.resolve({ __compassUnknown: true, reason: "Runtime shut down; native child outcome requires reconciliation." }); }
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
      if (needsRestore) { state = adoptBranchState(ctx); restoreContext(ctx); needsRestore = false; }
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
  pi.on("context", async (event: any, ctx: any) => {
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


pi.on("tool_call", async (event: any, ctx: any) => serialized(async () => {
  if (needsRestore) { state = adoptBranchState(ctx); needsRestore = false; }
  if (event.toolName === "ask_user_question") {
    let expanded: any;
    try { expanded = expandApprovalProposal(state, event.input); }
    catch (error) {
      // An expired or malformed proposal is a corrective Agent error, not a host crash.
      return { block: true, reason: (error instanceof Error ? error.message : String(error)) + " Request a fresh proposal; no approval changed." };
    }
    if (expanded) {
      if (ctx?.mode !== "interactive" || ctx?.hasUI !== true || typeof ctx?.ui?.custom !== "function") return { block: true, reason: "Compass approval requires interactive Pi with full-preview TUI. RPC/unknown/no-UI cannot establish complete presentation; no approval or state changed." };
      event.input.questions = expanded.questions;
      const callId = String(event.toolCallId ?? "");
      const sourceId = persistedAssistantEntryId(ctx, callId);
      const result = expanded.kind === "plan" ? bindDagApprovalQuestionnaire(state, event.input, sourceId, callId) : bindRouteSetQuestionnaire(state, { expectedStateVersion: state.routeSet.stateVersion, questionnaire: event.input }, sourceId, callId);
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
pi.registerCommand("compass-preflight", { description: "Check Compass fixed tool registry and native host/scope health", handler: async (_args: string, ctx: any) => {
  const all = namesFrom(pi.getAllTools?.() ?? []);
  let guardError = "";
  try { await runtimeGuards.control({ action: "get" }, ctx); } catch (error) { guardError = String(error instanceof Error ? error.message : error); }
  const checks = [
    { name: "Release", ok: PACKAGE_VERSION === GOAL_RUN_RELEASE, detail: GOAL_RUN_RELEASE },
    { name: "GoalRun", ok: GOAL_RUN_API_VERSION === 9, detail: String(GOAL_RUN_API_VERSION) },
    { name: "Fixed tool registry", ok: COMPASS_TOOL_NAMES.every((name) => all.includes(name)) && !all.some((name) => name.startsWith("compass_") && !COMPASS_TOOL_NAMES.includes(name)), detail: COMPASS_TOOL_NAMES.join(", ") },
    { name: "Runtime guard host/scope read", ok: !guardError, detail: guardError || "ready; observed-input boundary only" },
  ];
  const body = checks.map((check) => (check.ok ? "PASS" : "BLOCKER") + " " + check.name + ": " + check.detail).join("\n");
  ctx.ui?.notify?.(body, checks.every((check) => check.ok) ? "info" : "error");
} });
}
