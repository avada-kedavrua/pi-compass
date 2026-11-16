import { createHash, randomUUID } from "node:crypto";
import { emptyDagState, readyTasks, createOrRevisePlan, taskAssessmentBinding, taskAssessmentIsCurrent } from "./dag-core.mjs";
import { approvalIsCurrent, clearDagApprovalAnswer, createDagApprovalRequest, dagApprovalBinding, matchesDagApprovalQuestion } from "./dag-approval.mjs";
import { normalizeQuestionnaireRecord } from "./questionnaire-integration.mjs";

export const GOAL_RUN_API_VERSION = 8;
export const GOAL_RUN_RELEASE = "0.10.0";

const MAX_DECISIONS = 8;
const MAX_CHECKPOINTS = 5;
const MAX_FAILURES = 12;
const MAX_WRITES = 12;
const MAX_HUMAN_DECISIONS = 8;
const MAX_EVENTS = 80;
const MAX_EVENT_TEXT = 1_200;
const MAX_ACCEPTANCE_CRITERIA = 12;
const QUESTIONNAIRE_ERRORS = new Set([
  "no_ui", "no_custom_ui", "no_questions", "empty_options", "too_many_questions",
  "duplicate_question", "duplicate_option_label", "reserved_label", "session_load_failed",
  "stale_module_cache",
]);
const CANCELLATION_TERMINAL_STATUSES = new Set([
  "completed", "failed", "timed_out", "cancelled", "interrupted", "tool_budget_exhausted",
  "structured_output_failed", "acceptance_failed", "unavailable_context", "duplicate_node",
]);

export function emptyGoalRunState() {
  return {
    schemaVersion: 8,
    stateRevision: 0,
    eventSeq: 1,
    events: [],
    goal: {
      original: null,
      current: null,
      createdAt: null,
      sourceIds: [],
      originalSourceIds: [],
      reviewedInputId: null,
      constraints: [],
      acceptanceCriteria: [],
      criteria: [],
      nextAcceptanceNumber: 1,
      version: 0,
    },
    plan: emptyDagState(),
    routeSet: null,
    humanDecisions: [],
    nextHumanDecisionNumber: 1,
    latestHumanEntryId: null,
    decisions: [],
    checkpoints: [],
    nextDecisionNumber: 1,
    nextCheckpointNumber: 1,
    trace: { failures: [], writes: [] },
    activeCapabilities: [],
    triageRuns: [],
    nextTriageNumber: 1,
    projectRoot: null,
    nativeToolSignature: null,
  };
}

const clip = (value, max = 500) => {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const timestamp = () => new Date().toISOString();

function normalizeHumanDecisionRecord(value, index, fallbackVersion = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = clip(value.text, 2600);
  const questionnaire = normalizeQuestionnaireRecord(value.questionnaire);
  if (!text && !questionnaire) return null;
  return {
    id: typeof value.id === "string" && /^H\d+$/.test(value.id) ? value.id : `H${index + 1}`,
    at: typeof value.at === "string" ? value.at.slice(0, 64) : timestamp(),
    source: clip(value.source || "unknown", 80),
    sourceEntryId: typeof value.sourceEntryId === "string" ? value.sourceEntryId.slice(0, 128) : "",
    sourceCallId: typeof value.sourceCallId === "string" ? value.sourceCallId.slice(0, 128) : "",
    goalVersion: Number.isInteger(value.goalVersion) && value.goalVersion >= 0
      ? value.goalVersion
      : (Number.isInteger(fallbackVersion) && fallbackVersion >= 0 ? fallbackVersion : 0),
    text,
    summary: clip(value.summary || text, 420),
    ...(questionnaire ? { questionnaire } : {}),
  };
}

function questionnaireSummary(questionnaire, fallbackText) {
  if (!questionnaire) return clip(String(fallbackText || "").replace(/\s+/g, " "), 420);
  if (questionnaire.outcome === "declined") {
    return clip(`Declined questionnaire${questionnaire.globalNote ? `; note: ${questionnaire.globalNote}` : ""}`, 420);
  }
  const answers = questionnaire.answers.map((answer) => {
    const values = [answer.answer, ...(answer.selected ?? [])].filter((item) => typeof item === "string" && item.trim());
    return `${answer.question} = ${values.join(" + ") || "answered"}${answer.notes ? `; note: ${answer.notes}` : ""}`;
  });
  if (questionnaire.unanswered?.length) answers.push(`${questionnaire.unanswered.length} question(s) left unanswered`);
  if (questionnaire.globalNote) answers.push(`note: ${questionnaire.globalNote}`);
  return clip(answers.join("; ") || String(fallbackText || "").replace(/\s+/g, " "), 420);
}
function normalizeProviderDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kinds = new Set(["rate_limited", "transient_other", "unknown"]);
  const last = value.lastError && typeof value.lastError === "object" ? value.lastError : null;
  const retryValue = value.retry && typeof value.retry === "object" ? value.retry : null;
  return {
    errorCount: Number.isSafeInteger(value.errorCount) && value.errorCount >= 0 ? value.errorCount : null,
    lastError: last && kinds.has(last.kind) ? {
      kind: last.kind,
      message: clip(last.message, 160),
      at: Number.isFinite(last.at) && last.at >= 0 ? last.at : null,
    } : null,
    retry: retryValue && ["backoff", "in_flight"].includes(retryValue.phase) ? {
      phase: retryValue.phase,
      attempt: Number.isSafeInteger(retryValue.attempt) && retryValue.attempt >= 0 ? retryValue.attempt : null,
      maxAttempts: Number.isSafeInteger(retryValue.maxAttempts) && retryValue.maxAttempts >= 0 ? retryValue.maxAttempts : null,
      delayMs: Number.isFinite(retryValue.delayMs) && retryValue.delayMs >= 0 ? retryValue.delayMs : null,
      scheduledAt: Number.isFinite(retryValue.scheduledAt) && retryValue.scheduledAt >= 0 ? retryValue.scheduledAt : null,
    } : null,
  };
}
function normalizeExecutionRecord(value, fallbackRevision = 1) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const suppliedRequestId = typeof value.requestId === "string" ? value.requestId.trim().slice(0, 128) : "";
  const taskIds = Array.isArray(value.taskIds)
    ? [...new Set(value.taskIds.filter((id) => typeof id === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(id)).slice(0, 6))]
    : [];
  if (!taskIds.length) return null;
  const requestId = suppliedRequestId || `unrecoverable-${taskIds[0]}`;
  const allowedStatuses = new Set(["dispatching", "running", "unknown", "completed", "failed"]);
  const status = suppliedRequestId && allowedStatuses.has(value.status) ? value.status : "unknown";
  const resultStatuses = new Set(["dispatching", "running", "unknown", "done", "blocked", "failed"]);
  const nullableMetric = (source, key) => Number.isFinite(source?.[key]) && source[key] >= 0 ? source[key] : null;
  const results = Array.isArray(value.results) ? value.results.slice(0, 6).filter((item) => item && typeof item === "object" && typeof item.id === "string").map((item) => ({
    id: item.id.slice(0, 40),
    status: resultStatuses.has(item.status) ? item.status : "unknown",
    agent: clip(item.agent || "scout", 32),
    model: clip(item.model || "unknown", 120),
    fallbackAttempted: item.fallbackAttempted === true,
    fallbackReason: clip(item.fallbackReason || "", 80) || null,
    providerDiagnostics: normalizeProviderDiagnostics(item.providerDiagnostics),
    primaryProviderDiagnostics: normalizeProviderDiagnostics(item.primaryProviderDiagnostics),
    requestId: typeof item.requestId === "string" ? item.requestId.slice(0, 128) : "",
    ownerRunId: typeof item.ownerRunId === "string" ? item.ownerRunId.slice(0, 128) : "",
    ...(typeof item.frameScope === "string" && item.frameScope.trim() ? { frameScope: item.frameScope.trim().slice(0, 64) } : {}),
    runId: typeof item.runId === "string" && item.runId.trim() ? item.runId.trim().slice(0, 128) : null,
    error: typeof item.error === "string" ? clip(item.error, 600) : "",
    primaryError: typeof item.primaryError === "string" ? clip(item.primaryError, 400) : "",
    summary: typeof item.summary === "string" ? clip(item.summary, 800) : "",
    observedToolCount: nullableMetric(item, "observedToolCount"),
    observedTools: Array.isArray(item.observedTools) ? [...new Set(item.observedTools.filter((tool) => typeof tool === "string" && tool.trim()).slice(0, 12).map((tool) => clip(tool, 80))) ] : [],
    usage: item.usage && typeof item.usage === "object" && !Array.isArray(item.usage) ? {
      input: nullableMetric(item.usage, "input"),
      output: nullableMetric(item.usage, "output"),
      cacheRead: nullableMetric(item.usage, "cacheRead"),
      cacheWrite: nullableMetric(item.usage, "cacheWrite"),
      cost: nullableMetric(item.usage, "cost"),
      turns: nullableMetric(item.usage, "turns"),
      toolCalls: nullableMetric(item.usage, "toolCalls"),
      durationMs: nullableMetric(item.usage, "durationMs"),
    } : null,
    primaryUsage: item.primaryUsage && typeof item.primaryUsage === "object" && !Array.isArray(item.primaryUsage) ? {
      input: nullableMetric(item.primaryUsage, "input"),
      output: nullableMetric(item.primaryUsage, "output"),
      cacheRead: nullableMetric(item.primaryUsage, "cacheRead"),
      cacheWrite: nullableMetric(item.primaryUsage, "cacheWrite"),
      cost: nullableMetric(item.primaryUsage, "cost"),
      turns: nullableMetric(item.primaryUsage, "turns"),
      toolCalls: nullableMetric(item.primaryUsage, "toolCalls"),
      durationMs: nullableMetric(item.primaryUsage, "durationMs"),
    } : null,
  })) : [];
  return {
    requestId,
    runId: typeof value.runId === "string" && value.runId.trim() ? value.runId.trim().slice(0, 128) : null,
    ...(typeof value.frameScope === "string" && value.frameScope.trim() ? { frameScope: value.frameScope.trim().slice(0, 64) } : {}),
    taskIds,
    planRevision: Number.isInteger(value.planRevision) && value.planRevision > 0 ? value.planRevision : fallbackRevision,
    stateVersion: Number.isInteger(value.stateVersion) && value.stateVersion >= 0 ? value.stateVersion : 0,
    status,
    startedAt: typeof value.startedAt === "string" ? value.startedAt.slice(0, 64) : timestamp(),
    completedAt: typeof value.completedAt === "string" ? value.completedAt.slice(0, 64) : null,
    error: typeof value.error === "string" ? clip(value.error, 600) : status === "unknown" ? "Persisted execution metadata requires reconciliation; verify whether a child run is still active before releasing this batch." : null,
    policy: value.policy && typeof value.policy === "object" ? {
      mode: clip(value.policy.mode || "unknown", 40),
      reason: clip(value.policy.reason || "", 400),
      observedSamples: Number.isInteger(value.policy.observedSamples) && value.policy.observedSamples >= 0 ? value.policy.observedSamples : 0,
      medianSavingsMs: Number.isFinite(value.policy.medianSavingsMs) ? value.policy.medianSavingsMs : null,
    } : null,
    results,
  };
}
function normalizeExecutionDrift(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    signature: clip(value.signature || "", 500),
    at: typeof value.at === "string" ? value.at.slice(0, 64) : timestamp(),
    goalVersion: Number.isInteger(value.goalVersion) && value.goalVersion > 0 ? value.goalVersion : 1,
    planRevision: Number.isInteger(value.planRevision) && value.planRevision > 0 ? value.planRevision : 1,
    tool: clip(value.tool || "write tool", 80),
    target: clip(value.target || "unknown target", 260),
    reason: clip(value.reason || "A write was attempted without a matching in-progress DAG task.", 300),
    resolved: value.resolved === true,
  };
}

const ROUTE_STATUSES = new Set(["candidate", "selected", "rejected", "blocked", "evaluated"]);
const ROUTE_RUN_STATUSES = new Set(["registered", "running", "completed", "failed", "unknown", "cancel_requested", "cancel_acknowledged", "cancelled"]);
const ROUTE_CANCELLATION_PHASES = new Set(["requested", "acknowledged", "terminal", "unknown"]);
const ROUTE_RESULT_STATUSES = new Set(["pass", "fail", "inconclusive"]);
const ROUTE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

function normalizeRouteCriteria(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ACCEPTANCE_CRITERIA).filter((item) => item && typeof item === "object" && typeof item.id === "string" && typeof item.text === "string" && item.text.trim()).map((item) => ({
    id: item.id.slice(0, 32),
    text: clip(item.text, 300),
  }));
}

function normalizeRouteSet(value, fallbackGoalVersion = 1) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const goalVersion = Number.isInteger(value.goalVersion) && value.goalVersion > 0 ? value.goalVersion : fallbackGoalVersion;
  const routes = Array.isArray(value.routes) ? value.routes.slice(0, 12).filter((route) => route && typeof route === "object" && typeof route.routeId === "string" && ROUTE_ID.test(route.routeId)).map((route) => ({
    routeId: route.routeId,
    summary: clip(route.summary, 500),
    rationale: clip(route.rationale, 500),
    assumptions: Array.isArray(route.assumptions) ? route.assumptions.filter((item) => typeof item === "string" && item.trim()).slice(0, 8).map((item) => clip(item, 300)) : [],
    dependencies: Array.isArray(route.dependencies) ? route.dependencies.filter((item) => typeof item === "string" && item.trim()).slice(0, 8).map((item) => clip(item, 300)) : [],
    expectedCost: clip(route.expectedCost || "unknown", 120),
    expectedLatency: clip(route.expectedLatency || "unknown", 120),
    risks: Array.isArray(route.risks) ? route.risks.filter((item) => typeof item === "string" && item.trim()).slice(0, 8).map((item) => clip(item, 300)) : [],
    status: ROUTE_STATUSES.has(route.status) ? route.status : "candidate",
    evidenceRefs: Array.isArray(route.evidenceRefs) ? route.evidenceRefs.filter((item) => typeof item === "string" && item.trim()).slice(0, 8).map((item) => clip(item, 160)) : [],
    caveats: Array.isArray(route.caveats) ? route.caveats.filter((item) => typeof item === "string" && item.trim()).slice(0, 8).map((item) => clip(item, 400)) : [],
    acceptanceGate: route.acceptanceGate === "passed" ? "passed" : route.acceptanceGate === "failed" ? "failed" : "unverified",
  })) : [];
  const routeIds = new Set(routes.map((route) => route.routeId));
  const competitorRuns = Array.isArray(value.competitorRuns) ? value.competitorRuns.slice(-24).filter((run) => run && typeof run === "object" && typeof run.runId === "string" && typeof run.routeId === "string" && routeIds.has(run.routeId)).map((run) => ({
    runId: run.runId.slice(0, 128),
    routeId: run.routeId,
    goalVersion: Number.isInteger(run.goalVersion) && run.goalVersion > 0 ? run.goalVersion : goalVersion,
    baselineRef: clip(run.baselineRef, 300),
    correlationId: clip(run.correlationId, 128),
    status: ROUTE_RUN_STATUSES.has(run.status) ? run.status : "unknown",
    registeredAt: typeof run.registeredAt === "string" ? run.registeredAt.slice(0, 64) : timestamp(),
    result: run.result && typeof run.result === "object" ? {
      criteria: normalizeRouteCriteriaResults(run.result.criteria),
      caveats: Array.isArray(run.result.caveats) ? run.result.caveats.slice(0, 8).map((item) => clip(item, 400)) : [],
      unresolvedCaveats: Array.isArray(run.result.unresolvedCaveats) ? run.result.unresolvedCaveats.slice(0, 8).map((item) => clip(item, 400)) : [],
      evidenceRefs: Array.isArray(run.result.evidenceRefs) ? run.result.evidenceRefs.slice(0, 8).map((item) => clip(item, 160)) : [],
      summary: clip(run.result.summary, 800),
      acceptanceGate: run.result.acceptanceGate === "passed" ? "passed" : run.result.acceptanceGate === "failed" ? "failed" : "unverified",
    } : null,
    cancellation: run.cancellation && typeof run.cancellation === "object" ? {
      requestId: clip(run.cancellation.requestId, 128),
      phase: ROUTE_CANCELLATION_PHASES.has(run.cancellation.phase) ? run.cancellation.phase : "requested",
      requestedAt: typeof run.cancellation.requestedAt === "string" ? run.cancellation.requestedAt.slice(0, 64) : timestamp(),
      acknowledgedAt: typeof run.cancellation.acknowledgedAt === "string" ? run.cancellation.acknowledgedAt.slice(0, 64) : null,
      terminalAt: typeof run.cancellation.terminalAt === "string" ? run.cancellation.terminalAt.slice(0, 64) : null,
      terminalStatus: typeof run.cancellation.terminalStatus === "string" ? run.cancellation.terminalStatus.slice(0, 32) : null,
    } : null,
  })) : [];
  return {
    id: clip(value.id, 128),
    goalVersion,
    baselineRef: clip(value.baselineRef, 300),
    acceptanceCriteria: normalizeRouteCriteria(value.acceptanceCriteria),
    routes,
    selectedRouteId: routeIds.has(value.selectedRouteId) ? value.selectedRouteId : null,
    winningRouteId: routeIds.has(value.winningRouteId) ? value.winningRouteId : null,
    stateVersion: Number.isInteger(value.stateVersion) && value.stateVersion >= 0 ? value.stateVersion : 0,
    selectionRequest: value.selectionRequest && typeof value.selectionRequest === "object" ? value.selectionRequest : null,
    exploration: value.exploration && typeof value.exploration === "object" ? {
      authorized: value.exploration.authorized === true,
      scope: clip(value.exploration.scope, 500),
      budget: Number.isInteger(value.exploration.budget) && value.exploration.budget > 0 ? value.exploration.budget : 0,
      routeIds: Array.isArray(value.exploration.routeIds) ? value.exploration.routeIds.filter((id) => routeIds.has(id)).slice(0, 3) : [],
      sourceEntryId: clip(value.exploration.sourceEntryId, 128),
      authorizedAt: typeof value.exploration.authorizedAt === "string" ? value.exploration.authorizedAt.slice(0, 64) : null,
      proposalBinding: clip(value.exploration.proposalBinding, 128),
    } : { authorized: false, scope: "", budget: 0, routeIds: [], sourceEntryId: "", authorizedAt: null, proposalBinding: "" },
    competitorRuns,
    comparison: value.comparison && typeof value.comparison === "object" ? {
      status: ["unverified", "inconclusive", "accepted"].includes(value.comparison.status) ? value.comparison.status : "unverified",
      summary: clip(value.comparison.summary, 800),
      caveats: Array.isArray(value.comparison.caveats) ? value.comparison.caveats.slice(0, 8).map((item) => clip(item, 400)) : [],
    } : { status: "unverified", summary: "", caveats: [] },
  };
}

function normalizeRouteCriteriaResults(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ACCEPTANCE_CRITERIA).filter((item) => item && typeof item === "object" && typeof item.id === "string").map((item) => ({
    id: item.id.slice(0, 32),
    status: ROUTE_RESULT_STATUSES.has(item.status) ? item.status : "inconclusive",
    evidence: clip(item.evidence, 1600),
  }));
}

function routeSetBinding(routeSet, goal = "") {
  return createHash("sha256").update(JSON.stringify({
    id: routeSet.id,
    goalVersion: routeSet.goalVersion,
    goal,
    baselineRef: routeSet.baselineRef,
    acceptanceCriteria: routeSet.acceptanceCriteria,
    routes: routeSet.routes.map((route) => ({ ...route })),
    exploration: Object.fromEntries(Object.entries(routeSet.exploration).filter(([key]) => key !== "proposalBinding")),
  })).digest("hex");
}
const nonEmpty = (value, name, max = 4000) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return clip(value, max);
};

function textFingerprint(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function normalizeGoalRunState(raw) {
  const empty = emptyGoalRunState();
  if (!raw) return empty;
  if (typeof raw !== "object" || raw.schemaVersion !== 8) throw new Error("Unsupported Compass GoalRun schema. Open a new session or navigate to a supported branch; no state changed.");
  const rawGoal = raw.goal && typeof raw.goal === "object" ? raw.goal : {};
  const state = {
    ...empty,
    schemaVersion: 8,
    stateRevision: Number.isSafeInteger(raw.stateRevision) && raw.stateRevision >= 0 ? raw.stateRevision : 0,
    eventSeq: Number.isSafeInteger(raw.eventSeq) && raw.eventSeq >= 1 ? raw.eventSeq : 1,
    events: Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [],
    triageRuns: Array.isArray(raw.triageRuns) ? raw.triageRuns.slice(-6) : [],
    nextTriageNumber: Number.isInteger(raw.nextTriageNumber) ? raw.nextTriageNumber : 1,
    goal: {
      ...empty.goal,
      original: rawGoal.original ?? null,
      current: rawGoal.current ?? null,
      createdAt: rawGoal.createdAt ?? null,
      sourceIds: Array.isArray(rawGoal.sourceIds) ? rawGoal.sourceIds : [],
      originalSourceIds: Array.isArray(rawGoal.originalSourceIds) ? rawGoal.originalSourceIds : [],
      reviewedInputId: rawGoal.reviewedInputId ?? null,
      constraints: Array.isArray(rawGoal.constraints) ? rawGoal.constraints : [],
      acceptanceCriteria: Array.isArray(rawGoal.acceptanceCriteria) ? rawGoal.acceptanceCriteria : [],
      criteria: Array.isArray(rawGoal.criteria) ? rawGoal.criteria : [],
      nextAcceptanceNumber: rawGoal.nextAcceptanceNumber,
      version: rawGoal.version,
    },
    plan: raw.plan && typeof raw.plan === "object" ? raw.plan : emptyDagState(),
    routeSet: normalizeRouteSet(raw.routeSet, rawGoal.version),
    humanDecisions: Array.isArray(raw.humanDecisions)
      ? raw.humanDecisions.slice(-MAX_HUMAN_DECISIONS).map((item, index) => normalizeHumanDecisionRecord(item, index, rawGoal.version)).filter(Boolean)
      : [],
    nextHumanDecisionNumber: Number.isInteger(raw.nextHumanDecisionNumber) ? raw.nextHumanDecisionNumber : 1,
    latestHumanEntryId: typeof raw.latestHumanEntryId === "string" ? raw.latestHumanEntryId : null,
    decisions: Array.isArray(raw.decisions) ? raw.decisions.slice(-MAX_DECISIONS) : [],
    checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints.slice(-MAX_CHECKPOINTS) : [],
    nextDecisionNumber: Number.isInteger(raw.nextDecisionNumber) ? raw.nextDecisionNumber : 1,
    nextCheckpointNumber: Number.isInteger(raw.nextCheckpointNumber) ? raw.nextCheckpointNumber : 1,
    trace: {
      failures: Array.isArray(raw.trace?.failures) ? raw.trace.failures.slice(-MAX_FAILURES) : [],
      writes: Array.isArray(raw.trace?.writes) ? raw.trace.writes.slice(-MAX_WRITES) : [],
    },
    projectRoot: typeof raw.projectRoot === "string" ? raw.projectRoot : null,
    nativeToolSignature: typeof raw.nativeToolSignature === "string" ? raw.nativeToolSignature : null,
  };
  state.triageRuns = Array.isArray(state.triageRuns) ? state.triageRuns.slice(-6) : [];
  const maxTriageNumber = state.triageRuns.reduce((max, item) => Math.max(max, Number(String(item?.id ?? "").replace(/^T/, "")) || 0), 0) + 1;
  state.nextTriageNumber = Math.max(Number.isInteger(state.nextTriageNumber) ? state.nextTriageNumber : 1, maxTriageNumber);
  state.goal.version = Number.isInteger(state.goal.version) && state.goal.version >= 0 ? state.goal.version : 0;
  state.goal.sourceIds = Array.isArray(state.goal.sourceIds) ? state.goal.sourceIds.filter((id) => typeof id === "string").slice(0, 16) : [];
  state.goal.originalSourceIds = Array.isArray(state.goal.originalSourceIds) ? state.goal.originalSourceIds.filter((id) => typeof id === "string").slice(0, 16) : [];
  state.goal.reviewedInputId = typeof state.goal.reviewedInputId === "string" ? state.goal.reviewedInputId : null;
  state.goal.constraints = Array.isArray(state.goal.constraints) ? state.goal.constraints.filter((item) => typeof item === "string").slice(0, 24) : [];
  state.goal.acceptanceCriteria = Array.isArray(state.goal.acceptanceCriteria) ? state.goal.acceptanceCriteria.filter((item) => typeof item === "string" && item.trim()).slice(0, MAX_ACCEPTANCE_CRITERIA) : [];
  const validAcceptanceStatuses = new Set(["unverified", "reported_pass", "failed", "blocked", "inconclusive"]);
  state.goal.criteria = Array.isArray(state.goal.criteria) ? state.goal.criteria.filter((item) => item && typeof item === "object" && typeof item.text === "string" && item.text.trim()).slice(0, MAX_ACCEPTANCE_CRITERIA).map((item, index) => ({
    ...item,
    id: typeof item.id === "string" && item.id ? item.id : `AC${index + 1}`,
    text: clip(item.text, 300),
    required: item.required !== false,
    status: validAcceptanceStatuses.has(item.status) ? item.status : "unverified",
    evidence: typeof item.evidence === "string" ? clip(item.evidence, 2000) : "",
    goalVersion: Number.isInteger(item.goalVersion) && item.goalVersion > 0 ? item.goalVersion : state.goal.version,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
  })) : [];
  state.goal.nextAcceptanceNumber = Number.isInteger(state.goal.nextAcceptanceNumber) ? state.goal.nextAcceptanceNumber : 1;
  state.plan = {
    ...emptyDagState(),
    ...state.plan,
    acceptanceCriteria: Array.isArray(state.plan.acceptanceCriteria) ? state.plan.acceptanceCriteria : [],
    planHistory: Array.isArray(state.plan.planHistory) ? state.plan.planHistory.slice(-8) : [],
    activity: Array.isArray(state.plan.activity) ? state.plan.activity.slice(-8) : [],
    executionHistory: Array.isArray(state.plan.executionHistory) ? state.plan.executionHistory.slice(-8).filter((item) => item && typeof item === "object" && typeof item.requestId === "string").map((item) => ({
      requestId: item.requestId.slice(0, 128),
      planRevision: Number.isInteger(item.planRevision) && item.planRevision > 0 ? item.planRevision : 1,
      taskIds: Array.isArray(item.taskIds) ? item.taskIds.filter((id) => typeof id === "string").slice(0, 6).map((id) => id.slice(0, 40)) : [],
      status: item.status === "completed" ? "completed" : "unknown",
      startedAt: typeof item.startedAt === "string" ? item.startedAt.slice(0, 64) : timestamp(),
      completedAt: typeof item.completedAt === "string" ? item.completedAt.slice(0, 64) : null,
      totalCost: Number.isFinite(item.totalCost) && item.totalCost >= 0 ? item.totalCost : null,
      sumDurationMs: Number.isFinite(item.sumDurationMs) && item.sumDurationMs >= 0 ? item.sumDurationMs : null,
      wallDurationMs: Number.isFinite(item.wallDurationMs) && item.wallDurationMs >= 0 ? item.wallDurationMs : null,
      estimatedParallelSavingsMs: Number.isFinite(item.estimatedParallelSavingsMs) ? item.estimatedParallelSavingsMs : null,
      fallbackCount: Number.isInteger(item.fallbackCount) && item.fallbackCount >= 0 ? item.fallbackCount : 0,
      metricsComplete: item.metricsComplete === true,
      policyMode: clip(item.policyMode || "unknown", 40),
      policyReason: clip(item.policyReason || "", 400),
      taskMetrics: Array.isArray(item.taskMetrics) ? item.taskMetrics.slice(0, 4).filter((metric) => metric && typeof metric.id === "string").map((metric) => ({
        id: metric.id.slice(0, 40),
        model: clip(metric.model || "unknown", 120),
        fallbackAttempted: metric.fallbackAttempted === true,
        fallbackReason: clip(metric.fallbackReason || "", 80) || null,
        providerErrorCount: Number.isSafeInteger(metric.providerErrorCount) && metric.providerErrorCount >= 0 ? metric.providerErrorCount : null,
        providerLastErrorKind: ["rate_limited", "transient_other", "unknown"].includes(metric.providerLastErrorKind) ? metric.providerLastErrorKind : null,
        providerRetryPhase: ["backoff", "in_flight"].includes(metric.providerRetryPhase) ? metric.providerRetryPhase : null,
        cost: Number.isFinite(metric.cost) && metric.cost >= 0 ? metric.cost : null,
        primaryCost: Number.isFinite(metric.primaryCost) && metric.primaryCost >= 0 ? metric.primaryCost : null,
        durationMs: Number.isFinite(metric.durationMs) && metric.durationMs >= 0 ? metric.durationMs : null,
        input: Number.isFinite(metric.input) && metric.input >= 0 ? metric.input : null,
        output: Number.isFinite(metric.output) && metric.output >= 0 ? metric.output : null,
        toolCalls: Number.isFinite(metric.toolCalls) && metric.toolCalls >= 0 ? metric.toolCalls : null,
        observedToolCount: Number.isFinite(metric.observedToolCount) && metric.observedToolCount >= 0 ? metric.observedToolCount : null,
        observedTools: Array.isArray(metric.observedTools) ? [...new Set(metric.observedTools.filter((tool) => typeof tool === "string" && tool.trim()).slice(0, 12).map((tool) => clip(tool, 80))) ] : [],
        metricsComplete: metric.metricsComplete === true,
        runId: typeof metric.runId === "string" ? metric.runId.slice(0, 128) : null,
      })) : [],
      source: item.source === "manual_reconcile" ? "manual_reconcile" : "runtime",
    })) : [],
    execution: normalizeExecutionRecord(state.plan.execution, state.plan.revision ?? 1),
    executionDrift: normalizeExecutionDrift(state.plan.executionDrift),
    tasks: Array.isArray(state.plan.tasks) ? state.plan.tasks.map((task) => ({
      ...task,
      executor: ["parent", "code", "subagent"].includes(task?.executor) ? task.executor : "parent",
      agent: task?.executor === "subagent" && ["scout", "researcher", "reviewer", "evidence-auditor", "delegate", "oracle"].includes(task?.agent) ? task.agent : "scout",
    })) : [],
  };
  if (!state.goal.current) {
    state.goal.original = null;
    state.goal.version = 0;
    state.goal.sourceIds = [];
    state.goal.originalSourceIds = [];
    state.goal.reviewedInputId = null;
    state.goal.constraints = [];
    state.goal.acceptanceCriteria = [];
    state.goal.criteria = [];
    state.plan = emptyDagState();
    state.routeSet = null;
  }
  if (!Array.isArray(state.plan.tasks)) state.plan.tasks = [];
  if (!state.trace || typeof state.trace !== "object") state.trace = { failures: [], writes: [] };

  const version = state.goal.version;
  state.activeCapabilities = Array.isArray(raw.activeCapabilities)
    ? [...new Set(raw.activeCapabilities.filter((item) => typeof item === "string" && item !== "root"))]
    : [];
  if (state.goal.criteria.length) state.goal.acceptanceCriteria = state.goal.criteria.filter((item) => item.goalVersion === version).map((item) => item.text);
  for (const item of state.humanDecisions) if (!Number.isInteger(item.goalVersion)) item.goalVersion = version;
  for (const item of state.decisions) if (!Number.isInteger(item.goalVersion)) item.goalVersion = version;
  for (const item of state.checkpoints) if (!Number.isInteger(item.goalVersion)) item.goalVersion = version;
  for (const item of state.trace.failures) if (!Number.isInteger(item.goalVersion)) item.goalVersion = version;
  for (const item of state.trace.writes) if (!Number.isInteger(item.goalVersion)) item.goalVersion = version;
  state.events = state.events.filter((item) => item && typeof item === "object" && typeof item.kind === "string");
  return state;
}

function appendEvent(state, kind, input = {}) {
  const event = {
    id: `E${state.eventSeq++}`,
    at: input.at || timestamp(),
    goalVersion: Number.isInteger(input.goalVersion) ? input.goalVersion : (state.goal.version ?? 1),
    kind,
    source: clip(input.source || "compass", 80),
    summary: clip(input.summary || input.text || kind, 260),
  };
  if (typeof input.text === "string" && input.text) {
    event.text = input.text.slice(0, MAX_EVENT_TEXT);
    if (input.text.length > MAX_EVENT_TEXT) event.truncated = true;
  }
  if (typeof input.ref === "string" && input.ref) event.ref = clip(input.ref, 120);
  if (typeof input.status === "string" && input.status) event.status = input.status;
  state.events = [...state.events, event].slice(-MAX_EVENTS);
  return event;
}

function syncAcceptanceCriteria(state, criteria, source = "plan") {
  const texts = validateGoalCriteria(criteria);
  const prior = new Map((state.goal.criteria ?? []).filter((item) => item.goalVersion === (state.goal.version ?? 1)).map((item) => [item.text, item]));
  const next = [];
  for (const text of texts) {
    const old = prior.get(text);
    if (old) {
      next.push({ ...old });
      prior.delete(text);
    } else {
      next.push({
        id: `AC${state.goal.nextAcceptanceNumber++}`, text, required: true,
        status: "unverified", evidence: "", source,
        goalVersion: state.goal.version ?? 1, updatedAt: null,
      });
    }
  }
  state.goal.acceptanceCriteria = texts;
  state.goal.criteria = next;
  return next;
}

export function acceptanceStatus(stateValue) {
  return acceptanceSummary(normalizeGoalRunState(stateValue));
}

function acceptanceSummary(state) {
  const criteria = state.goal.criteria.filter((item) => item.goalVersion === (state.goal.version ?? 1));
  if (!criteria.length) return { status: "criteria_not_defined", total: 0, passed: 0, failed: 0, blocked: 0, unverified: 0 };
  const passed = criteria.filter((item) => item.status === "reported_pass").length;
  const failed = criteria.filter((item) => item.status === "failed").length;
  const blocked = criteria.filter((item) => item.status === "blocked").length;
  const unverified = criteria.filter((item) => !["reported_pass", "failed", "blocked"].includes(item.status)).length;
  const status = failed || blocked ? "blocked" : passed === criteria.length ? "reported_satisfied" : "active";
  return { status, total: criteria.length, passed, failed, blocked, unverified };
}

/**
 * Deterministic outcome projection. This is deliberately not a verifier:
 * Compass can classify recorded reports and task state, but cannot independently
 * prove that an artifact or external behavior is correct.
 */
export function goalOutcomeStatus(stateValue) {
  return outcomeSummary(normalizeGoalRunState(stateValue));
}

function outcomeSummary(state, acceptance = acceptanceSummary(state)) {
  if (!state.goal.current) {
    return { status: "no_goal", evidenceLevel: "none", independentlyVerified: false, unresolvedTaskIds: [], blockedTaskIds: [], failedCriterionIds: [], blockedCriterionIds: [], unverifiedCriterionIds: [] };
  }
  const tasks = Array.isArray(state.plan?.tasks) ? state.plan.tasks : [];
  const unresolvedTaskIds = tasks.filter((task) => task.status !== "done").map((task) => task.id);
  const blockedTaskIds = tasks.filter((task) => task.status === "blocked").map((task) => task.id);
  const currentCriteria = (state.goal.criteria ?? []).filter((item) => item.goalVersion === (state.goal.version ?? 1));
  const failedCriterionIds = currentCriteria.filter((item) => item.status === "failed").map((item) => item.id);
  const blockedCriterionIds = currentCriteria.filter((item) => item.status === "blocked").map((item) => item.id);
  const unverifiedCriterionIds = currentCriteria.filter((item) => !["reported_pass", "failed", "blocked"].includes(item.status)).map((item) => item.id);
  let status = "incomplete";
  if (failedCriterionIds.length) status = "failed";
  else if (acceptance.blocked > 0 || blockedTaskIds.length) status = "blocked";
  else if (!acceptance.total && unresolvedTaskIds.length) status = "incomplete";
  else if (!acceptance.total) status = "not_assessed";
  else if (acceptance.unverified > 0 || unresolvedTaskIds.length) status = "incomplete";
  else if (acceptance.passed === acceptance.total) status = "agent_reported_satisfied";
  return {
    status,
    evidenceLevel: status === "agent_reported_satisfied" ? "agent_reported"
      : status === "failed" ? "agent_reported_failure"
        : ["no_goal", "not_assessed"].includes(status) ? "none" : "partial_or_unresolved",
    independentlyVerified: false,
    acceptanceStatus: acceptance.status,
    acceptanceTotal: acceptance.total,
    reportedPass: acceptance.passed,
    failedCriterionIds,
    blockedCriterionIds,
    unverifiedCriterionIds,
    unresolvedTaskIds,
    blockedTaskIds,
  };
}

export function defineAcceptanceCriteria(stateValue, criteria) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.goal.current) throw new Error("No Goal exists in this session.");
  if (!Array.isArray(criteria) || criteria.length < 1) throw new Error("Provide at least one concrete acceptance criterion.");
  const normalized = validateGoalCriteria(criteria);
  if (state.plan.tasks.length && JSON.stringify(normalized) !== JSON.stringify(state.plan.acceptanceCriteria)) {
    throw new Error("A DAG exists. Change Goal-level acceptance criteria through the DAG revision so task dependencies and acceptance stay consistent.");
  }
  const before = JSON.stringify(state.goal.acceptanceCriteria);
  syncAcceptanceCriteria(state, normalized, "explicit_goal_criteria");
  if (JSON.stringify(state.goal.acceptanceCriteria) !== before) {
    appendEvent(state, "acceptance_defined", { summary: `Defined ${state.goal.acceptanceCriteria.length} acceptance criteria.` });
  }
  return { state, criteria: state.goal.criteria, changed: JSON.stringify(state.goal.acceptanceCriteria) !== before };
}

export function recordAcceptanceResult(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  const criterionId = nonEmpty(input?.criterionId, "criterionId", 24);
  const status = input?.status;
  if (!["reported_pass", "failed", "blocked", "inconclusive"].includes(status)) {
    throw new Error('status must be one of: reported_pass, failed, blocked, inconclusive.');
  }
  if (typeof input?.evidence !== "string" || !input.evidence.trim() || input.evidence.trim().length > 2000) throw new Error("evidence must contain 1..2000 characters; evidence is never silently truncated. No state changed.");
  const evidence = input.evidence.trim();
  const source = typeof input?.source === "string" ? clip(input.source, 80) : "agent_reported";
  const criteria = state.goal.criteria ?? [];
  const criterion = criteria.find((item) => item.id === criterionId && item.goalVersion === (state.goal.version ?? 1));
  if (!criterion) throw new Error(`Unknown or stale acceptance criterion "${criterionId}". No state changed.`);
  if (criterion.status === status && criterion.evidence === evidence && (criterion.source ?? "agent_reported") === source) {
    return { state, criterion, status: acceptanceStatus(state), changed: false };
  }
  criterion.status = status;
  criterion.evidence = evidence;
  criterion.updatedAt = timestamp();
  criterion.source = source;
  appendEvent(state, "acceptance_result", { summary: `${criterionId} ${status}`, status, ref: criterionId, text: evidence, source: criterion.source });
  return { state, criterion, status: acceptanceStatus(state), changed: true };
}

export function observeHumanInput(stateValue, sourceEntryId) {
  const state = normalizeGoalRunState(stateValue);
  const id = typeof sourceEntryId === "string" ? sourceEntryId.trim() : "";
  if (!id || id.length > 128) throw new Error("sourceEntryId must be a non-empty stable ID of at most 128 characters. No state changed.");
  if (state.latestHumanEntryId === id) return { state, changed: false };
  state.latestHumanEntryId = id;
  return { state, changed: true };
}

function validateSourceIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("sourceIds must contain 1..16 unique Human entry IDs.");
  const ids = value.map((id, index) => {
    if (typeof id !== "string" || !id.trim() || id.trim().length > 128) throw new Error(`sourceIds[${index}] must be a non-empty ID of at most 128 characters.`);
    return id.trim();
  });
  if (new Set(ids).size !== ids.length) throw new Error("sourceIds must not contain duplicates.");
  return ids;
}

function validateGoalCriteria(value) {
  if (!Array.isArray(value) || value.length > MAX_ACCEPTANCE_CRITERIA) throw new Error(`acceptanceCriteria must be an array of at most ${MAX_ACCEPTANCE_CRITERIA} strings.`);
  const items = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.trim().length > 300) throw new Error(`acceptanceCriteria[${index}] must be a non-empty string of at most 300 characters.`);
    return item.trim();
  });
  if (new Set(items).size !== items.length) throw new Error("acceptanceCriteria must not contain duplicates.");
  return items;
}

export function setGoal(stateValue, input = {}) {
  const state = normalizeGoalRunState(stateValue);
  if (input.expectedVersion !== state.goal.version) throw new Error(`Stale Goal version: expected ${state.goal.version}, received ${input.expectedVersion}. No state changed.`);
  if (typeof input.current !== "string" || !input.current.trim() || input.current.length > 4000) throw new Error("current must be a non-empty string of at most 4000 characters; text is never clipped.");
  const current = input.current.trim();
  const sourceIds = validateSourceIds(input.sourceIds);
  if (!Array.isArray(input.constraints) || input.constraints.length > 24) throw new Error("constraints must be an array of at most 24 strings.");
  const constraints = input.constraints.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.trim().length > 600) throw new Error(`constraints[${index}] must be a non-empty string of at most 600 characters.`);
    return item.trim();
  });
  if (new Set(constraints).size !== constraints.length) throw new Error("constraints must not contain exact duplicates.");
  const replacing = Boolean(state.goal.current) && state.goal.current !== current;
  const creating = !state.goal.current;
  const criteriaProvided = Object.hasOwn(input, "acceptanceCriteria");
  const criteria = criteriaProvided ? validateGoalCriteria(input.acceptanceCriteria)
    : (creating || replacing ? [] : (state.goal.criteria ?? []).filter((item) => item.goalVersion === state.goal.version).map((item) => item.text));
  if (replacing && hasUnresolvedExecution(state)) throw new Error("Cannot replace the Goal while native execution or competitor identity is unresolved. No state changed.");
  if (!replacing && !creating && state.plan.tasks.length && criteriaProvided && JSON.stringify(criteria) !== JSON.stringify(state.goal.acceptanceCriteria)) {
    throw new Error("A DAG exists; change acceptance criteria through revisePlanState. No state changed.");
  }
  const oldConstraints = JSON.stringify(state.goal.constraints ?? []);
  const oldCriteria = JSON.stringify((state.goal.criteria ?? []).filter((item) => item.goalVersion === state.goal.version).map((item) => item.text));
  const semanticChanged = oldConstraints !== JSON.stringify(constraints) || oldCriteria !== JSON.stringify(criteria);
  const sameTextMetadataChanged = !creating && !replacing && (semanticChanged
    || JSON.stringify(state.goal.sourceIds) !== JSON.stringify(sourceIds)
    || state.goal.reviewedInputId !== state.latestHumanEntryId);
  if (!creating && !replacing && !sameTextMetadataChanged) return { state, changed: false, replaced: false };
  if (creating) {
    state.goal.original = current;
    state.goal.originalSourceIds = [...sourceIds];
    state.goal.version = 1;
    state.goal.createdAt = timestamp();
  } else if (replacing) {
    state.goal.version += 1;
    state.goal.current = current;
    state.plan = emptyDagState();
    state.routeSet = null;
    state.goal.criteria = [];
    state.goal.acceptanceCriteria = [];
  }
  state.goal.current = current;
  state.goal.sourceIds = [...sourceIds];
  state.goal.reviewedInputId = state.latestHumanEntryId;
  state.goal.constraints = constraints;
  if (criteriaProvided || creating || replacing) syncAcceptanceCriteria(state, criteria, "explicit_goal_criteria");
  if (criteriaProvided && oldCriteria !== JSON.stringify(criteria)) appendEvent(state, "acceptance_defined", { summary: `Defined ${criteria.length} explicit acceptance criteria.` });
  if (creating) appendEvent(state, "goal_created", { summary: `Explicit Goal created from ${sourceIds.length} Human source reference(s).`, ref: sourceIds[0] });
  else if (replacing) appendEvent(state, "goal_replaced", { summary: `Current Goal replaced at version ${state.goal.version}.`, ref: sourceIds[0] });
  else if (oldConstraints !== JSON.stringify(constraints)) appendEvent(state, "goal_constraints_updated", { summary: `Updated ${constraints.length} explicit Goal constraint(s).`, ref: sourceIds[0] });
  return { state, changed: true, replaced: replacing };
}

function hasUnresolvedExecution(state) {
  if (["dispatching", "running", "unknown"].includes(state.plan?.execution?.status)) return true;
  return (state.routeSet?.competitorRuns ?? []).some((run) => ["registered", "running", "unknown", "cancel_requested", "cancel_acknowledged"].includes(run.status));
}

export function captureHumanDecision(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  const source = typeof input?.source === "string" ? input.source : "ask-user-questions";
  const rawDetails = input?.details && typeof input.details === "object" && !Array.isArray(input.details) ? input.details : null;
  if (rawDetails?.error || rawDetails?.isError === true || rawDetails?.ok === false) return { state, captured: false, kind: "questionnaire_error", error: String(rawDetails.error ?? "questionnaire_error") };
  const questionnaire = normalizeQuestionnaireRecord(rawDetails);
  // Structured results are the source of truth. The package's model-facing
  // envelope may echo a selected option's full preview; preserve that raw
  // envelope in Pi history, but do not duplicate it into bounded GoalRun state.
  const text = questionnaire
    ? questionnaireSummary(questionnaire, "")
    : (typeof input?.text === "string" && input.text.trim() ? nonEmpty(input.text, "text", 2600) : "");
  if (!text && !questionnaire) return { state, captured: false, kind: "no_decision" };
  const sourceEntryId = typeof input?.sourceEntryId === "string" ? input.sourceEntryId : "";
  const sourceCallId = typeof input?.sourceCallId === "string" ? input.sourceCallId : "";
  const approvalRequest = state.plan.approvalRequest;
  const correlatedApprovalAnswer = Boolean(approvalRequest?.sourceEntryId && approvalRequest.sourceEntryId === sourceEntryId
    && approvalRequest.toolCallId && approvalRequest.toolCallId === sourceCallId);
  if (sourceEntryId && sourceCallId && state.humanDecisions.some((item) => item.sourceEntryId === sourceEntryId && item.sourceCallId === sourceCallId)) {
    return { state, captured: false, kind: "duplicate" };
  }
  const last = state.humanDecisions.at(-1);
  if (!sourceCallId && last?.source === source && last?.text === text) {
    return { state, captured: false, kind: "duplicate" };
  }
  const id = `H${state.nextHumanDecisionNumber++}`;
  const item = {
    id,
    at: timestamp(),
    source,
    sourceEntryId,
    sourceCallId,
    goalVersion: state.goal.version ?? 1,
    text,
    summary: questionnaireSummary(questionnaire, text),
    ...(questionnaire ? { questionnaire } : {}),
  };
  state.humanDecisions = [...state.humanDecisions, item].slice(-MAX_HUMAN_DECISIONS);
  if (correlatedApprovalAnswer) {
    approvalRequest.status = "answered";
    const approvalAnswerClear = clearDagApprovalAnswer(approvalRequest, questionnaire);
    const approvalDefinitionCurrent = approvalRequest.binding === dagApprovalBinding(state);
    if (approvalAnswerClear && approvalDefinitionCurrent) {
      state.plan.approval = {
        requestId: approvalRequest.id,
        binding: approvalRequest.binding,
        sourceEntryId,
        sourceCallId,
        goalVersion: state.goal.version ?? 1,
        approvedAt: timestamp(),
      };
    }
  }
  appendEvent(state, "human_decision", {
    at: item.at,
    source,
    text,
    summary: item.summary,
    ref: id,
    status: questionnaire?.outcome,
    goalVersion: item.goalVersion,
  });
  return { state, captured: true, item };
}

export function recordHumanQuestionnaireFailure(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  const source = typeof input?.source === "string" ? input.source : "ask-user-questions";
  const sourceEntryId = typeof input?.sourceEntryId === "string" ? input.sourceEntryId.slice(0, 128) : "";
  const sourceCallId = typeof input?.sourceCallId === "string" ? input.sourceCallId.slice(0, 120) : "";
  const suppliedCode = typeof input?.errorCode === "string" ? input.errorCode : "";
  const errorCode = QUESTIONNAIRE_ERRORS.has(suppliedCode) ? suppliedCode : "unknown";
  const hasIdentity = Boolean(sourceEntryId && sourceCallId);
  if (hasIdentity && state.events.some((event) => event.kind === "human_questionnaire_error"
    && event.sourceEntryId === sourceEntryId && event.sourceCallId === sourceCallId)) {
    return { state, captured: false, kind: "duplicate" };
  }
  if (state.plan.approvalRequest?.sourceEntryId === sourceEntryId
    && state.plan.approvalRequest?.toolCallId && state.plan.approvalRequest.toolCallId === sourceCallId) {
    state.plan.approvalRequest.status = "questionnaire_error";
  }
  const reason = clip(input?.reason, 360);
  const event = appendEvent(state, "human_questionnaire_error", {
    at: timestamp(),
    source,
    summary: `Questionnaire unavailable (${errorCode}).`,
    text: reason || `The questionnaire did not produce a Human decision. Error code: ${errorCode}.`,
    ref: sourceEntryId || sourceCallId,
    status: errorCode,
    goalVersion: state.goal.version ?? 1,
  });
  if (hasIdentity) {
    event.sourceEntryId = sourceEntryId;
    event.sourceCallId = sourceCallId;
  }
  return { state, captured: true, kind: "error", event };
}

export function recordDecision(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.goal.current) throw new Error("No Goal exists in this session.");
  const summary = nonEmpty(input?.summary, "summary", 320);
  const rationale = clip(input?.rationale, 500);
  const evidence = clip(input?.evidence, 900);
  const affectedTaskIds = Array.isArray(input?.affectedTaskIds) ? [...new Set(input.affectedTaskIds.map((id) => nonEmpty(id, "affectedTaskIds[]", 40)))] : [];
  const supersedesDecisionIds = Array.isArray(input?.supersedesDecisionIds)
    ? [...new Set(input.supersedesDecisionIds.map((id) => nonEmpty(id, "supersedesDecisionIds[]", 32)))]
    : [];
  if (supersedesDecisionIds.length > 8) throw new Error("supersedesDecisionIds accepts at most 8 IDs. No state changed.");
  const currentVersion = state.goal.version ?? 1;
  const currentDecisions = state.decisions.filter((decision) => decision.goalVersion === currentVersion);
  const byId = new Map(currentDecisions.map((decision) => [decision.id, decision]));
  const unknownDecisions = supersedesDecisionIds.filter((id) => !byId.has(id));
  if (unknownDecisions.length) throw new Error(`Unknown or stale decision IDs: ${unknownDecisions.join(", ")}. Only current-Goal decisions can be superseded. No state changed.`);
  const alreadySuperseded = supersedesDecisionIds.filter((id) => byId.get(id)?.supersededBy);
  if (alreadySuperseded.length) throw new Error(`Decision IDs already superseded: ${alreadySuperseded.map((id) => `${id} by ${byId.get(id).supersededBy}`).join(", ")}. No state changed.`);
  const taskIds = new Set((state.plan.tasks ?? []).map((task) => task.id));
  if (affectedTaskIds.length && taskIds.size === 0) throw new Error("No DAG exists; omit affectedTaskIds or create a DAG only if real dependencies justify it. No state changed.");
  const unknown = affectedTaskIds.filter((id) => !taskIds.has(id));
  if (unknown.length) throw new Error(`Unknown affected task ids: ${unknown.join(", ")}. Current task IDs: ${[...taskIds].join(", ") || "none"}. Read current DAG status and use exact IDs. No state changed.`);
  const impactedTaskIds = [...new Set(supersedesDecisionIds.flatMap((supersededId) => byId.get(supersededId)?.affectedTaskIds ?? []))];
  const id = `D${state.nextDecisionNumber++}`;
  const at = timestamp();
  for (const supersededId of supersedesDecisionIds) {
    const prior = byId.get(supersededId);
    prior.supersededBy = id;
    prior.supersededAt = at;
    appendEvent(state, "decision_superseded", { at, summary: `${prior.id} superseded by ${id}`, text: `${summary}${rationale ? `; ${rationale}` : ""}`, ref: prior.id, goalVersion: currentVersion });
  }
  const item = { id, at, goalVersion: currentVersion, summary, rationale, evidence, affectedTaskIds, supersedesDecisionIds };
  state.decisions = [...state.decisions, item].slice(-MAX_DECISIONS);
  appendEvent(state, "decision_recorded", { at: item.at, summary, text: [rationale, evidence].filter(Boolean).join("; "), ref: id, goalVersion: item.goalVersion });
  return { state, item, supersededDecisionIds: supersedesDecisionIds, impactedTaskIds };
}

export function recordCheckpoint(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.goal.current) throw new Error("No Goal exists in this session.");
  const summary = nonEmpty(input?.summary, "summary", 320);
  const ref = clip(input?.ref, 500);
  const evidence = clip(input?.evidence, 900);
  const id = `C${state.nextCheckpointNumber++}`;
  const item = { id, at: timestamp(), goalVersion: state.goal.version ?? 1, summary, ref, evidence };
  state.checkpoints = [...state.checkpoints, item].slice(-MAX_CHECKPOINTS);
  appendEvent(state, "checkpoint_recorded", { at: item.at, summary, text: [ref, evidence].filter(Boolean).join("; "), ref: id, goalVersion: item.goalVersion });
  return { state, item };
}

export function recordFailure(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  const item = {
    at: input?.at || timestamp(),
    goalVersion: state.goal.version ?? 1,
    tool: clip(input?.tool, 80) || "unknown",
    error: clip(input?.error, 260) || "Tool failed without a readable error summary.",
  };
  state.trace.failures = [...state.trace.failures, item].slice(-MAX_FAILURES);
  appendEvent(state, "tool_failure", { at: item.at, source: item.tool, summary: item.error, goalVersion: item.goalVersion });
  return state;
}

export function recordExecutionDrift(stateValue, input = {}) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.plan.goal || !state.plan.tasks.length) return { state, changed: false };
  const tool = clip(input.tool || "write tool", 80);
  const target = clip(input.target || "unknown target", 260);
  const reason = clip(input.reason || "A write was attempted without a matching in-progress DAG task.", 300);
  const signature = `${state.goal.version}|${state.plan.revision}|${state.plan.stateVersion ?? 0}|${tool}|${target}|${reason}`;
  if (state.plan.executionDrift?.signature === signature) return { state, changed: false };
  state.plan.executionDrift = {
    signature,
    at: timestamp(),
    goalVersion: state.goal.version,
    planRevision: state.plan.revision,
    tool,
    target,
    reason,
    resolved: false,
  };
  appendEvent(state, "execution_drift", { summary: `Execution drift warning: ${tool} targeted ${target}.`, text: reason });
  return { state, changed: true };
}

export function recordExecutionEvent(stateValue, input = {}) {
  const state = normalizeGoalRunState(stateValue);
  appendEvent(state, "subagent_execution", {
    source: "pi-subagents",
    status: typeof input.status === "string" ? input.status : "",
    summary: clip(input.summary || "Subagent execution state changed.", 260),
    text: typeof input.text === "string" ? input.text.slice(0, 1600) : "",
    ref: typeof input.ref === "string" ? input.ref : "",
  });
  return state;
}

export function recordWriteTarget(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  const target = clip(input?.target, 600);
  if (!target) return state;
  const item = { at: input?.at || timestamp(), goalVersion: state.goal.version ?? 1, tool: clip(input?.tool, 80) || "write", target };
  const prior = state.trace.writes.at(-1);
  if (prior?.goalVersion === item.goalVersion && prior?.tool === item.tool && prior?.target === target) return state;
  state.trace.writes = [...state.trace.writes, item].slice(-MAX_WRITES);
  appendEvent(state, "write_attempt", { at: item.at, source: item.tool, summary: item.target, goalVersion: item.goalVersion });
  return state;
}

export function mergeTrace(stateValue, traceEntries = []) {
  const state = normalizeGoalRunState(stateValue);
  for (const entry of traceEntries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.kind === "failure" && entry.item) {
      const key = `${entry.item.at}|${entry.item.tool}|${entry.item.error}`;
      if (!state.trace.failures.some((x) => `${x.at}|${x.tool}|${x.error}` === key)) state.trace.failures.push(entry.item);
      const eventExists = state.events.some((event) => event.kind === "tool_failure" && event.at === entry.item.at && event.source === entry.item.tool && event.summary === entry.item.error);
      if (!eventExists) appendEvent(state, "tool_failure", { at: entry.item.at, source: entry.item.tool, summary: entry.item.error, goalVersion: entry.item.goalVersion });
    } else if (entry.kind === "write" && entry.item) {
      const key = `${entry.item.at}|${entry.item.tool}|${entry.item.target}`;
      if (!state.trace.writes.some((x) => `${x.at}|${x.tool}|${x.target}` === key)) state.trace.writes.push(entry.item);
      const eventExists = state.events.some((event) => event.kind === "write_attempt" && event.at === entry.item.at && event.source === entry.item.tool && event.summary === entry.item.target);
      if (!eventExists) appendEvent(state, "write_attempt", { at: entry.item.at, source: entry.item.tool, summary: entry.item.target, goalVersion: entry.item.goalVersion });
    }
  }
  state.trace.failures = state.trace.failures.slice(-MAX_FAILURES);
  state.trace.writes = state.trace.writes.slice(-MAX_WRITES);
  return state;
}

export function hasUsefulTrace(stateValue) {
  const state = normalizeGoalRunState(stateValue);
  const version = state.goal.version ?? 1;
  return state.trace.failures.some((item) => item.goalVersion === version) || state.trace.writes.some((item) => item.goalVersion === version);
}

function stripQuotedRegions(text) {
  if (typeof text !== "string") return "";
  const output = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const token = marker[1];
      if (!fence) fence = { char: token[0], length: token.length };
      else if (token[0] === fence.char && token.length >= fence.length) fence = null;
      continue;
    }
    if (fence || /^\s*>/.test(line)) continue;
    output.push(line);
  }
  return output.join("\n").trim();
}

function normalizeHeading(line) {
  return String(line ?? "").trim().replace(/^#{1,6}\s*/, "").replace(/\s*[:：]\s*$/, "").trim();
}

function isAcceptanceHeading(line) {
  const value = String(line ?? "").trim().replace(/^#{1,6}\s*/, "");
  return /^(?:acceptance(?:\s+(?:criteria|conditions?|checks?))?|验收(?:标准|条件|准则|要求)?)\s*(?:\([^)]*\))?\s*(?:[:：].*)?$/i.test(value);
}

function isConventionHeading(line) {
  const raw = String(line ?? "").trim().replace(/^#{1,6}\s*/, "");
  const value = raw.replace(/\s*[:：].*$/, "").trim();
  return /^(?:conventions?|working conventions?|coding conventions?|preferences?|coding preferences|工作约定|编码约定|开发习惯|工作偏好|偏好)$/i.test(value);
}

function isOtherSectionHeading(line) {
  const raw = String(line ?? "").trim();
  if (/^#{1,6}\s+/.test(raw)) return true;
  const value = String(raw).replace(/\s*[:：].*$/, "").trim();
  return /^(?:goal|objective|scope|current state|context|background|deliverables?|constraints?|restrictions?|requirements?|rules?|implementation plan|workflow|interaction flow|core effects|verification|约束|限制|需求|要求|交付物|范围|当前状态|上下文|背景|核心效果|交互流程|实现流程|验证|必读契约|已完成|已知问题|问题列表|仓库与现状)$/i.test(value);
}

function failureSignature(item) {
  const error = String(item?.error ?? "").toLowerCase()
    .replace(/(?:[a-z]:)?[\\/][^\s:'"<>]+/g, "<path>")
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return `${item?.tool || "unknown"}|${error.slice(0, 140)}`;
}

export function shouldSurfaceIssueReview(stateValue) {
  const state = normalizeGoalRunState(stateValue);
  const version = state.goal.version;
  const failures = state.trace.failures.filter((item) => item.goalVersion === version).slice(-6);
  if (failures.length < 3) return false;
  const last = failures.slice(-3);
  if (new Set(last.map((item) => item.tool)).size > 2) return false;
  const counts = new Map();
  for (const item of last) {
    const signature = failureSignature(item);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return [...counts.values()].some((count) => count >= 2);
}

export function buildGoalDetails(stateValue) {
  const state = normalizeGoalRunState(stateValue);
  return {
    goal: state.goal.current ? { version: state.goal.version, original: state.goal.original, current: state.goal.current, originalSourceIds: state.goal.originalSourceIds, sourceIds: state.goal.sourceIds, constraints: state.goal.constraints } : null,
    reviewedInputId: state.goal.reviewedInputId,
    ...(state.latestHumanEntryId ? { input: { id: state.latestHumanEntryId, reviewed: state.goal.reviewedInputId === state.latestHumanEntryId } } : {}),
    criteria: state.goal.criteria.filter((item) => item.goalVersion === state.goal.version).map((item) => ({ id: item.id, text: item.text, status: item.status })),
    humanAnswers: state.humanDecisions.filter((item) => item.goalVersion === state.goal.version).map((item) => ({ id: item.id, sourceEntryId: item.sourceEntryId, sourceCallId: item.sourceCallId, ...(item.questionnaire ? { questionnaire: item.questionnaire } : { text: item.text }) })),
  };
}

export function buildIssueReview(stateValue, issue, evidenceRefs = []) {
  const state = normalizeGoalRunState(stateValue);
  const version = state.goal.version ?? 1;
  const refs = [...new Set((Array.isArray(evidenceRefs) ? evidenceRefs : []).map((value) => String(value)))].slice(0, 8);
  const referenced = refs.map((id) => state.events.find((event) => event.id === id && event.goalVersion === version)).filter(Boolean);
  const issueText = String(issue || referenced.map((item) => item.summary).join("; ") || "unspecified");
  const lines = [
    "Route review: evidence only; Agent owns semantic choice.",
    `Issue: ${clip(issueText, 240)}`,
    ...(issueText.length > 240 ? [`Issue preview only (${issueText.length} input characters); detailed evidence should be referenced by event ID, not copied into future reviews.`] : []),
    `Goal v${version}: ${clip(state.goal.current || "unknown", 260)}`,
    ...(state.goal.current !== state.goal.original ? [`Original Goal (historical): ${clip(state.goal.original || "unknown", 180)}`] : []),
    `Acceptance: ${acceptanceStatus(state).status} (${acceptanceStatus(state).passed}/${acceptanceStatus(state).total} reported pass; ${acceptanceStatus(state).failed} failed; ${acceptanceStatus(state).blocked} blocked).`,
    `Goal outcome: ${goalOutcomeStatus(state).status}; evidence=${goalOutcomeStatus(state).evidenceLevel}; independentlyVerified=false.`,
  ];
  if (referenced.length) {
    lines.push("Referenced current-Goal events:", ...referenced.map((event) => `- ${event.id} ${event.kind} ${event.at}: ${clip(event.summary, 150)}`));
  }
  if (state.plan?.tasks?.length) {
    const plan = state.plan;
    const ready = readyTasks(plan).map((task) => task.id);
    const done = plan.tasks.filter((task) => task.status === "done").length;
    const inProgress = plan.tasks.filter((task) => task.status === "in_progress").map((task) => task.id);
    const blocked = plan.tasks.filter((task) => task.status === "blocked").map((task) => task.id);
    lines.push(`DAG r${plan.revision}/s${plan.stateVersion ?? 0}: ${done}/${plan.tasks.length} done; in-progress=${inProgress.join(",") || "-"}; blocked=${blocked.join(",") || "-"}; ready=${ready.join(",") || "-"}.`);
    const changed = plan.planHistory?.at(-1);
    if (changed) lines.push(`Last plan change: ${clip(changed.summary, 120)}; reason: ${clip(changed.reason || "not recorded", 120)}.`);
  } else lines.push("No DAG exists; do not create one solely for triage.");
  const decisions = state.decisions.filter((item) => item.goalVersion === version).slice(-2);
  if (decisions.length) lines.push("Recent decisions:", ...decisions.map((item) => `- ${item.id}: ${clip(item.summary, 120)}; rationale=${clip(item.rationale || "?", 90)}; evidence=${clip(item.evidence || "?", 90)}`));
  const checkpoints = state.checkpoints.filter((item) => item.goalVersion === version && item.ref).slice(-1);
  if (checkpoints.length) lines.push(`Latest recoverable checkpoint: ${checkpoints[0].id} ${clip(checkpoints[0].summary, 100)}; ref=${clip(checkpoints[0].ref, 100)}.`);
  if (!referenced.length) {
    const failures = state.trace.failures.filter((item) => item.goalVersion === version).slice(-3);
    if (failures.length) lines.push("Recent failures (observations, not diagnoses):", ...failures.map((item) => `- ${item.at} ${item.tool}: ${clip(item.error, 130)}`));
    const writes = state.trace.writes.filter((item) => item.goalVersion === version).slice(-2);
    if (writes.length) lines.push("Recent writes:", ...writes.map((item) => `- ${item.tool}: ${clip(item.target, 120)}`));
  }
  lines.push("Before acting, compare with the existing plan and evidence. Decide whether to continue, locally repair, revise the plan, or use a real recoverable checkpoint. No automatic rollback.");
  const result = lines.join("\n");
  return result.length > 2800 ? `${result.slice(0, 2730)}\n[Details omitted; reference event IDs for focused review.]` : result;
}

function eventSequence(id) {
  const match = typeof id === "string" ? id.match(/^E(\d+)$/) : null;
  return match ? Number(match[1]) : null;
}

function compactEvent(event) {
  return {
    id: event.id,
    at: event.at,
    goalVersion: event.goalVersion,
    kind: event.kind,
    summary: clip(event.summary, 140),
    ...(event.ref ? { ref: event.ref } : {}),
    ...(event.status ? { status: event.status } : {}),
  };
}

export function parseStateCursor(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = value.match(/^R(\d+)-E(\d+)-C(\d+)$/);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  return values.every(Number.isSafeInteger) ? { revision: values[0], eventSeq: values[1], contextRevision: values[2] } : null;
}

export function stateCursor(state, contextRevision = 0) {
  const revision = Number.isSafeInteger(state?.stateRevision) ? state.stateRevision : 0;
  const latestEvent = Number.isSafeInteger(state?.eventSeq) ? Math.max(0, state.eventSeq - 1) : 0;
  const context = Number.isSafeInteger(contextRevision) && contextRevision >= 0 ? contextRevision : 0;
  return `R${revision}-E${latestEvent}-C${context}`;
}

export function buildStateSnapshot(stateValue, afterCursor = null, runtime = {}) {
  const state = normalizeGoalRunState(stateValue);
  const contextRevision = Number.isSafeInteger(runtime?.contextRevision) && runtime.contextRevision >= 0 ? runtime.contextRevision : 0;
  const cursor = stateCursor(state, contextRevision);
  const revision = state.stateRevision;
  const latestSeq = Math.max(0, state.eventSeq - 1);
  const frame = runtime?.contextFrame?.active === true && typeof runtime.contextFrame.id === "string" ? runtime.contextFrame.id : "root";
  if (afterCursor !== null && afterCursor !== undefined && (typeof afterCursor !== "string" || afterCursor.length > 64 || !parseStateCursor(afterCursor))) {
    throw new Error('cursor must be an opaque cursor returned by compass_state, e.g. "R12-E42-C3". No state changed.');
  }
  const prior = afterCursor == null ? null : parseStateCursor(afterCursor);
  const ahead = Boolean(prior && (prior.revision > revision || prior.eventSeq > latestSeq || prior.contextRevision > contextRevision));
  const exact = Boolean(prior && prior.revision === revision && prior.eventSeq === latestSeq && prior.contextRevision === contextRevision);
  if (exact) return { unchanged: true, cursor };
  const firstSeq = state.events.length ? eventSequence(state.events[0].id) ?? latestSeq : latestSeq + 1;
  const gap = Boolean(prior && prior.eventSeq < firstSeq - 1 && prior.eventSeq < latestSeq);
  const currentEvents = state.events.filter((event) => event.goalVersion === state.goal.version);
  const matchingEvents = prior && !gap && !ahead
    ? currentEvents.filter((event) => (eventSequence(event.id) ?? 0) > prior.eventSeq)
    : currentEvents;
  const deltaEvents = matchingEvents.slice(prior && !gap && !ahead ? -8 : -4);
  const omitted = matchingEvents.length - deltaEvents.length;
  const plan = state.plan?.goal && state.plan.tasks.length ? {
    revision: state.plan.revision,
    total: state.plan.tasks.length,
    done: state.plan.tasks.filter((task) => task.status === "done").length,
    inProgress: state.plan.tasks.filter((task) => task.status === "in_progress").length,
    blocked: state.plan.tasks.filter((task) => task.status === "blocked").length,
    remaining: state.plan.tasks.filter((task) => task.status !== "done").length,
  } : undefined;
  const criteria = state.goal.criteria.filter((item) => item.goalVersion === state.goal.version);
  const acceptanceStatusValue = acceptanceSummary(state);
  const outcome = outcomeSummary(state, acceptanceStatusValue);
  const outcomeCaveat = acceptanceStatusValue.status === "reported_satisfied" && state.plan.tasks.some((task) => task.status === "blocked")
    ? `Acceptance is Agent-reported satisfied, but DAG task(s) remain blocked: ${state.plan.tasks.filter((task) => task.status === "blocked").map((task) => task.id).join(", ")}. Explain the blocker before claiming the overall Goal outcome is achieved.`
    : null;
  const result = {
    cursor,
    frame,
    goal: state.goal.current ? { version: state.goal.version, current: clip(state.goal.current, 240), ...(state.goal.current.length > 240 ? { currentTruncated: true } : {}) } : null,
    ...(outcome.status !== "no_goal" ? { outcome: outcome.status } : {}),
    ...(outcomeCaveat ? { caveat: clip(outcomeCaveat, 320) } : {}),
    ...(state.latestHumanEntryId ? { input: { id: state.latestHumanEntryId, ...(state.goal.current ? { reviewed: state.goal.reviewedInputId === state.latestHumanEntryId } : {}) } } : {}),
    ...(plan ? { plan } : {}),
    ...(criteria.length ? { acceptance: { status: acceptanceStatusValue.status, total: criteria.length, counts: {
      passed: acceptanceStatusValue.passed, failed: acceptanceStatusValue.failed,
      blocked: acceptanceStatusValue.blocked, unverified: acceptanceStatusValue.unverified,
    } } } : {}),
    ...(prior && (deltaEvents.length || omitted || gap || ahead) ? { delta: { events: deltaEvents.map(compactEvent), ...(omitted ? { omitted } : {}), ...(gap ? { historyGap: true } : {}), ...(ahead ? { cursorAhead: true } : {}) } } : {}),
  };
  return result;
}

function triageFingerprint(state, issue, refs) {
  const version = state.goal.version ?? 1;
  const materialEvents = state.events.filter((event) => event.goalVersion === version && event.kind !== "triage_review");
  const latestMaterialSeq = materialEvents.length ? (eventSequence(materialEvents.at(-1).id) ?? 0) : 0;
  const acceptance = state.goal.criteria.filter((item) => item.goalVersion === version).map((item) => [item.id, item.status, item.evidence]);
  return textFingerprint(JSON.stringify({
    goalVersion: version,
    issue: String(issue || "").toLowerCase().replace(/\s+/g, " ").trim(),
    refs: [...refs].sort(),
    latestMaterialSeq,
    planRevision: state.plan.revision ?? 0,
    planStateVersion: state.plan.stateVersion ?? 0,
    acceptance,
  }));
}

export function triageIssue(stateValue, input = {}) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.goal.current) throw new Error("No Goal exists; issue review is unavailable.");
  if (input.issue !== undefined && typeof input.issue !== "string") throw new Error("issue must be a string. No state changed.");
  const issue = typeof input.issue === "string" ? input.issue.trim() : "";
  // A hard 240-character schema limit caused avoidable validation failures
  // when a model included a little more context. Accept a bounded input, retain
  // only a short preview in state/output, and fingerprint the full normalized
  // issue so long inputs do not create ambiguous duplicate matches.
  if (issue.length > 4000) throw new Error("issue must be at most 4000 characters; summarize the problem and reference event IDs instead of pasting a log. No state changed.");
  const refs = [...new Set((Array.isArray(input.evidenceRefs) ? input.evidenceRefs : []).map((value) => String(value)))];
  if (refs.length > 8) throw new Error("At most 8 evidenceRefs are allowed. No state changed.");
  if (!issue && !refs.length) throw new Error("Provide a concise issue or at least one evidenceRefs event ID. No state changed.");
  const version = state.goal.version ?? 1;
  for (const ref of refs) {
    if (eventSequence(ref) === null) throw new Error(`Invalid evidence reference "${ref}"; expected an event ID such as E42. No state changed.`);
    const event = state.events.find((item) => item.id === ref);
    if (!event) throw new Error(`Evidence reference "${ref}" is not in retained history. Use a current event ID from compass_state or provide a concise issue. No state changed.`);
    if (event.goalVersion !== version) throw new Error(`Evidence reference "${ref}" belongs to Goal v${event.goalVersion}, not current Goal v${version}. No state changed.`);
  }
  const fingerprint = triageFingerprint(state, issue, refs);
  const prior = state.triageRuns.find((item) => item.fingerprint === fingerprint && item.goalVersion === version);
  if (prior) return { state, duplicate: true, item: prior, review: "", summary: clip(prior.summary, 520) };
  const review = buildIssueReview(state, issue || refs.map((ref) => state.events.find((event) => event.id === ref)?.summary).filter(Boolean).join("; "), refs);
  const item = {
    id: `T${state.nextTriageNumber++}`,
    at: timestamp(),
    goalVersion: version,
    fingerprint,
    issue: clip(issue || refs.join(", "), 240),
    issueLength: issue.length,
    issueTruncated: issue.length > 240,
    evidenceRefs: refs,
    basedOnEventId: `E${Math.max(0, (state.eventSeq ?? 1) - 1)}`,
    summary: clip(review, 700),
  };
  state.triageRuns = [...state.triageRuns, item].slice(-6);
  appendEvent(state, "triage_review", { summary: `Triage ${item.id}: ${clip(item.issue, 160)}.`, ref: item.id, goalVersion: version });
  return { state, duplicate: false, item, review, summary: item.summary, issueTruncated: item.issueTruncated };
}

export function availableCapabilities(stateValue) {
  const state = normalizeGoalRunState(stateValue);
  return state.goal.current ? ["planning", "routes", "acceptance", "history", "goal_details", "issue_review", "context"] : ["context"];
}

export function buildRecentEvents(stateValue, limit = 12) {
  const state = normalizeGoalRunState(stateValue);
  const count = Math.max(1, Math.min(20, Number.isInteger(limit) ? limit : 12));
  return state.events.filter((item) => item.kind !== "goal_created").slice(-count).map((item) => ({
    id: item.id, at: item.at, goalVersion: item.goalVersion, kind: item.kind,
    source: item.source, summary: item.summary, ref: item.ref ?? null, status: item.status ?? null,
  }));
}

export function summarizePlanStatus(stateValue) {
  const state = normalizeGoalRunState(stateValue);
  const plan = state.plan;
  if (!plan.goal || !plan.tasks.length) return "No DAG exists. Use planning capability only if this Goal has real dependencies or independent tracks.";
  const done = plan.tasks.filter((task) => task.status === "done").length;
  const ready = readyTasks(plan);
  const inProgress = plan.tasks.filter((task) => task.status === "in_progress");
  const blocked = plan.tasks.filter((task) => task.status === "blocked");
  const acceptance = acceptanceStatus(state);
  const outcome = goalOutcomeStatus(state);
  const approved = approvalIsCurrent(state);
  const lines = [`DAG revision: ${plan.revision}; stateVersion: ${plan.stateVersion ?? 0}; ${done}/${plan.tasks.length} tasks done; ${inProgress.length} in progress; ${blocked.length} blocked.`, `DAG approval: ${approved ? "current" : "missing or stale"}${approved ? "" : "; all progression is locked until a correlated structured Human approval"}.`, `Goal outcome: ${outcome.status} (evidence=${outcome.evidenceLevel}; independentlyVerified=false).`, `Goal acceptance: ${acceptance.status} (${acceptance.passed}/${acceptance.total} reported pass; ${acceptance.failed} failed; ${acceptance.blocked} blocked).`];
  if (blocked.length && acceptance.status === "reported_satisfied") {
    lines.push(`Outcome caveat: acceptance is Agent-reported satisfied, but task(s) remain blocked: ${blocked.map((task) => task.id).join(", ")}. Do not claim the overall Goal outcome is achieved without explaining the blocker.`);
  }
  for (const task of plan.tasks) {
    lines.push(`- ${task.id} [${task.status}] ${clip(task.title, 110)}; executor=${task.executor || "parent"}${task.executor === "subagent" ? `/${task.agent || "scout"}` : ""}${task.dependsOn.length ? ` <- ${task.dependsOn.join(", ")}` : ""}${task.reason ? `; ${clip(task.reason, 140)}` : ""}`);
  }
  lines.push(`${approved ? "Progression-ready" : "Dependency-ready (approval locked)"}: ${ready.length ? ready.map((task) => task.id).join(", ") : "none"}.`);
  const parallel = ready.filter((task) => task.executor === "subagent" && String(task.writeScope || "").toLowerCase() === "read-only");
  if (parallel.length >= 2) lines.push(`Explicitly routed read-only Subagent candidates: ${parallel.map((task) => task.id).join(", ")}. Dependency readiness and write scope are code-derived; semantic independence and expected savings still require judgment.`);
  return lines.join("\n");
}

function routeStateVersion(state, input) {
  const expected = input?.expectedStateVersion;
  if (!Number.isInteger(expected) || expected < 0) throw new Error("expectedStateVersion is required for RouteSet mutations. No state changed.");
  const actual = state.routeSet?.stateVersion ?? 0;
  if (expected !== actual) throw new Error(`Stale RouteSet state version ${expected}; current version is ${actual}. No state changed.`);
}

function routeInput(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.goal.current) throw new Error("No Goal has been captured in this session. No state changed.");
  if (!state.routeSet) throw new Error("No RouteSet exists for the current Goal. No state changed.");
  if (state.routeSet.goalVersion !== state.goal.version || state.routeSet.baselineRef === "") throw new Error("RouteSet is stale for the current Goal or has no baseline. No state changed.");
  routeStateVersion(state, input);
  return state;
}

function routeOptionQuestion(state, includeExploration = false) {
  const routeSet = state.routeSet;
  const routePreview = (route) => [
    `Current Goal v${state.goal.version}: ${state.goal.current}`,
    `RouteSet ${routeSet.id}; baseline=${routeSet.baselineRef}`,
    `Route ${route.routeId}: ${route.summary}`,
    `Rationale: ${route.rationale || "not specified"}`,
    `Assumptions: ${route.assumptions.join("; ") || "none specified"}`,
    `Dependencies: ${route.dependencies.join("; ") || "none specified"}`,
    `Expected cost: ${route.expectedCost}; expected latency: ${route.expectedLatency}`,
    `Risks: ${route.risks.join("; ") || "none specified"}`,
    `Shared acceptance criteria:\n${routeSet.acceptanceCriteria.map((item) => `- ${item.id}: ${item.text}`).join("\n")}`,
  ].join("\n");
  return {
    question: "Which route should Compass use for this Goal?",
    header: "Route selection",
    multiSelect: false,
    options: [
      ...routeSet.routes.map((route) => ({ label: route.routeId, description: route.summary, preview: routePreview(route) })),
      ...(includeExploration ? [{
        label: "parallel_exploration",
        description: "Authorize exactly the proposed parallel exploration.",
        preview: [
          `Current Goal v${state.goal.version}: ${state.goal.current}`,
          `RouteSet ${routeSet.id}; baseline=${routeSet.baselineRef}`,
          `Alternatives (proposed routes marked [included]):\n${routeSet.routes.map((route) => `- ${routeSet.exploration.routeIds.includes(route.routeId) ? "[included] " : "[not included] "}${route.routeId}: ${route.summary}; rationale=${route.rationale || "not specified"}; assumptions=${route.assumptions.join("; ") || "none"}; dependencies=${route.dependencies.join("; ") || "none"}; cost=${route.expectedCost}; latency=${route.expectedLatency}; risks=${route.risks.join("; ") || "none"}`).join("\n")}`,
          `Shared acceptance criteria:\n${routeSet.acceptanceCriteria.map((item) => `- ${item.id}: ${item.text}`).join("\n")}`,
          `Proposed scope: ${routeSet.exploration.scope}`,
          `Maximum competitor runs: ${routeSet.exploration.budget}`,
        ].join("\n"),
      }] : []),
    ],
  };
}

function sameJsonValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && sameJsonValue(left[key], right[key]));
}

function renewRouteSelectionRequest(state, includeExploration = false) {
  const routeSet = state.routeSet;
  const request = {
    id: randomUUID(),
    binding: "",
    goalVersion: state.goal.version,
    status: "awaiting_questionnaire",
    sourceEntryId: "",
    toolCallId: "",
    questionnaire: null,
    createdAt: timestamp(),
  };
  routeSet.selectionRequest = request;
  request.questionnaire = routeOptionQuestion(state, includeExploration);
  request.binding = routeSetBinding(routeSet, state.goal.current);
  return request;
}

export function createRouteSet(stateValue, input = {}) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.goal.current) throw new Error("No Goal has been captured in this session. No state changed.");
  if (state.routeSet) {
    routeStateVersion(state, input);
    if (state.routeSet.competitorRuns.some((run) => ["registered", "running", "unknown", "cancel_requested", "cancel_acknowledged"].includes(run.status))) {
      throw new Error("Cannot replace a RouteSet while a competitor run is unresolved. No state changed.");
    }
  } else if (input.expectedStateVersion !== undefined && input.expectedStateVersion !== 0) {
    throw new Error("The initial RouteSet expectedStateVersion must be 0. No state changed.");
  }
  const baselineRef = nonEmpty(input.baselineRef, "baselineRef", 300);
  if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length < 1) throw new Error("acceptanceCriteria must contain the shared criteria for every route. No state changed.");
  const acceptanceCriteria = input.acceptanceCriteria.map((item, index) => {
    if (typeof item === "string") return { id: `C${index + 1}`, text: nonEmpty(item, `acceptanceCriteria[${index}]`, 300) };
    if (!item || typeof item !== "object") throw new Error(`acceptanceCriteria[${index}] must be a string or object. No state changed.`);
    return { id: nonEmpty(item.id, `acceptanceCriteria[${index}].id`, 32), text: nonEmpty(item.text, `acceptanceCriteria[${index}].text`, 300) };
  });
  const criterionIds = new Set();
  for (const criterion of acceptanceCriteria) {
    if (criterionIds.has(criterion.id)) throw new Error(`Duplicate shared acceptance criterion ID "${criterion.id}". No state changed.`);
    criterionIds.add(criterion.id);
  }
  if (!Array.isArray(input.routes) || input.routes.length < 2 || input.routes.length > 3) throw new Error("routes must contain 2..3 alternatives so the Human questionnaire stays within Pi's four-option limit. No state changed.");
  const ids = new Set();
  const routes = input.routes.map((route, index) => {
    if (!route || typeof route !== "object") throw new Error(`routes[${index}] must be an object. No state changed.`);
    const routeId = nonEmpty(route.routeId, `routes[${index}].routeId`, 40);
    if (!ROUTE_ID.test(routeId) || routeId === "parallel_exploration") throw new Error(`Route ID "${routeId}" is invalid or reserved. No state changed.`);
    if (ids.has(routeId)) throw new Error(`Duplicate route ID "${routeId}". No state changed.`);
    ids.add(routeId);
    return {
      routeId,
      summary: nonEmpty(route.summary, `routes[${index}].summary`, 500),
      rationale: clip(route.rationale, 500),
      assumptions: Array.isArray(route.assumptions) ? route.assumptions.map((item, itemIndex) => nonEmpty(item, `routes[${index}].assumptions[${itemIndex}]`, 300)).slice(0, 8) : [],
      dependencies: Array.isArray(route.dependencies) ? route.dependencies.map((item, itemIndex) => nonEmpty(item, `routes[${index}].dependencies[${itemIndex}]`, 300)).slice(0, 8) : [],
      expectedCost: clip(route.expectedCost || "unknown", 120),
      expectedLatency: clip(route.expectedLatency || "unknown", 120),
      risks: Array.isArray(route.risks) ? route.risks.map((item, itemIndex) => nonEmpty(item, `routes[${index}].risks[${itemIndex}]`, 300)).slice(0, 8) : [],
      status: "candidate",
      evidenceRefs: [],
      caveats: [],
      acceptanceGate: "unverified",
    };
  });
  const id = `RS${state.goal.version}-${state.eventSeq}`;
  const routeSet = {
    id,
    goalVersion: state.goal.version,
    baselineRef,
    acceptanceCriteria,
    routes,
    selectedRouteId: null,
    winningRouteId: null,
    stateVersion: 1,
    selectionRequest: null,
    exploration: { authorized: false, scope: "", budget: 0, routeIds: [], sourceEntryId: "", authorizedAt: null, proposalBinding: "" },
    competitorRuns: [],
    comparison: { status: "unverified", summary: "", caveats: [] },
  };
  state.routeSet = routeSet;
  renewRouteSelectionRequest(state);
  appendEvent(state, "route_set_created", { summary: `RouteSet ${id} created with ${routes.length} alternatives.`, ref: id });
  return { state, routeSet };
}

export function bindRouteSetQuestionnaire(stateValue, input, sourceEntryId, toolCallId = "") {
  const state = routeInput(stateValue, input);
  const request = state.routeSet.selectionRequest;
  if (!request || request.status !== "awaiting_questionnaire") return { state, bound: false };
  if (typeof sourceEntryId !== "string" || !sourceEntryId.trim() || typeof toolCallId !== "string" || !toolCallId.trim()) return { state, bound: false };
  const provided = input?.questionnaire ?? input;
  if (!sameJsonValue(provided, { questions: [request.questionnaire] })
    || request.binding !== routeSetBinding(state.routeSet, state.goal.current)) return { state, bound: false };
  request.sourceEntryId = sourceEntryId.slice(0, 128);
  request.toolCallId = toolCallId.slice(0, 128);
  request.status = "presented";
  return { state, bound: true, requestId: request.id };
}

export function recordRouteSelection(stateValue, input = {}) {
  const state = routeInput(stateValue, input);
  const request = state.routeSet.selectionRequest;
  if (!request || request.status !== "presented" || request.id !== input.selectionRequestId || request.sourceEntryId !== input.sourceEntryId
    || request.toolCallId !== (typeof input.sourceCallId === "string" ? input.sourceCallId : "")) throw new Error("Route selection questionnaire identity is stale or was not presented. No state changed.");
  if (request.binding !== routeSetBinding(state.routeSet, state.goal.current)) throw new Error("Route selection proposal changed after presentation. No state changed.");
  const questionnaire = input.questionnaire;
  const answer = questionnaire?.answers?.length === 1 ? questionnaire.answers[0] : null;
  const expectedQuestion = request.questionnaire.question;
  if (!answer || questionnaire.outcome !== "answered" || questionnaire.unanswered?.length
    || questionnaire.globalNote?.trim() || answer.questionIndex !== 0 || answer.question !== expectedQuestion
    || answer.kind !== "option" || answer.notes?.trim()
    || !Array.isArray(answer.selected) || answer.selected.length !== 1 || answer.answer !== answer.selected[0]) {
    throw new Error("Route selection requires one clear, note-free, correlated structured Human answer. No state changed.");
  }
  const selected = answer.answer;
  const route = state.routeSet.routes.find((item) => item.routeId === selected);
  if (selected === "parallel_exploration") {
    const proposal = state.routeSet.exploration;
    if (proposal.authorized || !proposal.scope || !proposal.budget || proposal.routeIds.length < 2
      || proposal.proposalBinding !== routeSetBinding(state.routeSet, state.goal.current)) {
      throw new Error("No current scoped and budgeted exploration proposal is available for Human authorization. No state changed.");
    }
    proposal.authorized = true;
    proposal.sourceEntryId = input.sourceEntryId.slice(0, 128);
    proposal.authorizedAt = timestamp();
    request.status = "answered";
    state.routeSet.stateVersion += 1;
    appendEvent(state, "route_exploration_authorized", { summary: `Human authorized the exact exploration proposal for ${state.routeSet.id}.`, ref: state.routeSet.id });
    return { state, selected: null, exploration: proposal };
  }
  if (!route) throw new Error(`Unknown or stale route identity "${selected}". No state changed.`);
  bindSelectedRoute(state, route);
  request.status = "answered";
  state.routeSet.stateVersion += 1;
  appendEvent(state, "route_selected", { summary: `Human selected route ${route.routeId}.`, ref: route.routeId });
  return { state, selected: route.routeId, exploration: state.routeSet.exploration };
}

export function proposeRouteExploration(stateValue, input = {}) {
  const state = routeInput(stateValue, input);
  if (state.routeSet.competitorRuns.some((run) => ["registered", "running", "unknown", "cancel_requested", "cancel_acknowledged"].includes(run.status))) {
    throw new Error("Cannot replace an exploration proposal while a competitor run is unresolved. No state changed.");
  }
  const scope = nonEmpty(input.scope, "scope", 500);
  const budget = input.budget;
  if (!Number.isInteger(budget) || budget < 2 || budget > 24) throw new Error("budget must be an integer from 2 to 24. No state changed.");
  const routeIds = input.routeIds;
  if (!Array.isArray(routeIds) || routeIds.length < 2 || routeIds.length > 3
    || new Set(routeIds).size !== routeIds.length
    || routeIds.some((id) => !state.routeSet.routes.some((item) => item.routeId === id))) {
    throw new Error("routeIds must name 2..3 distinct exact RouteSet routes. No state changed.");
  }
  state.routeSet.exploration = {
    authorized: false,
    scope,
    budget,
    routeIds: [...routeIds],
    sourceEntryId: "",
    authorizedAt: null,
    proposalBinding: "",
  };
  renewRouteSelectionRequest(state, true);
  state.routeSet.exploration.proposalBinding = routeSetBinding(state.routeSet, state.goal.current);
  state.routeSet.stateVersion += 1;
  appendEvent(state, "route_exploration_proposed", { summary: `A scoped exploration proposal was prepared for ${state.routeSet.id}; Human authorization is pending.`, ref: state.routeSet.id });
  return { state, exploration: state.routeSet.exploration, selectionRequest: state.routeSet.selectionRequest };
}

export function registerCompetitorRun(stateValue, input = {}) {
  const state = routeInput(stateValue, input);
  const routeSet = state.routeSet;
  if (!routeSet.exploration.authorized) throw new Error("Parallel exploration is not explicitly Human-authorized. No state changed.");
  const runId = nonEmpty(input.runId, "runId", 128);
  const routeId = nonEmpty(input.routeId, "routeId", 40);
  if (!routeSet.exploration.routeIds.includes(routeId)) throw new Error(`Route ${routeId} is outside the authorized exploration set. No state changed.`);
  if (routeSet.competitorRuns.some((run) => run.runId === runId)) throw new Error(`Competitor run identity ${runId} already exists. No state changed.`);
  if (routeSet.competitorRuns.length >= routeSet.exploration.budget) throw new Error("The authorized competitor budget is exhausted. No state changed.");
  const baselineRef = nonEmpty(input.baselineRef, "baselineRef", 300);
  if (baselineRef !== routeSet.baselineRef) throw new Error("Competitor baseline does not match the RouteSet baseline. No state changed.");
  const correlationId = nonEmpty(input.correlationId, "correlationId", 128);
  const run = { runId, routeId, goalVersion: state.goal.version, baselineRef, correlationId, status: "registered", registeredAt: timestamp(), result: null, cancellation: null };
  routeSet.competitorRuns.push(run);
  routeSet.stateVersion += 1;
  appendEvent(state, "route_competitor_registered", { summary: `Registered competitor ${runId} for route ${routeId}.`, ref: runId });
  return { state, run };
}

export function recordCompetitorResult(stateValue, input = {}) {
  const state = routeInput(stateValue, input);
  const run = state.routeSet.competitorRuns.find((item) => item.runId === input.runId && item.routeId === input.routeId);
  if (!run) throw new Error(`Unknown competitor run ${input.runId ?? "(missing runId)"} for route ${input.routeId ?? "(missing routeId)"}. result records a registered native competitor, not a route-level verdict. No state changed.`);
  if (run.goalVersion !== state.goal.version || run.baselineRef !== state.routeSet.baselineRef || run.correlationId !== input.correlationId) throw new Error("Competitor Goal version, baseline, or correlation is stale. No state changed.");
  if (["cancel_requested", "cancel_acknowledged"].includes(run.status) || run.cancellation) throw new Error(`Competitor ${run.runId} is already terminal or cancellation is in progress. No state changed.`);
  const criteria = input.criteria;
  if (!Array.isArray(criteria) || criteria.length !== state.routeSet.acceptanceCriteria.length) throw new Error("Competitor result must report every shared acceptance criterion. No state changed.");
  const expected = new Set(state.routeSet.acceptanceCriteria.map((item) => item.id));
  const seen = new Set();
  const normalizedCriteria = criteria.map((item, index) => {
    if (!item || !expected.has(item.id) || seen.has(item.id) || !ROUTE_RESULT_STATUSES.has(item.status)) throw new Error(`Invalid or duplicate result criterion at index ${index}. No state changed.`);
    seen.add(item.id);
    return { id: item.id, status: item.status, evidence: nonEmpty(item.evidence, `criteria[${index}].evidence`, 1600) };
  });
  if (seen.size !== expected.size) throw new Error("Competitor result omitted a shared acceptance criterion. No state changed.");
  const caveats = (input.caveats ?? []).map((item, index) => nonEmpty(item, `caveats[${index}]`, 400));
  const unresolvedCaveats = (input.unresolvedCaveats ?? []).map((item, index) => nonEmpty(item, `unresolvedCaveats[${index}]`, 400));
  const acceptanceGate = normalizedCriteria.every((item) => item.status === "pass") && unresolvedCaveats.length === 0 ? "passed" : "failed";
  run.status = input.status === "failed" ? "failed" : "completed";
  run.result = { criteria: normalizedCriteria, caveats: [...new Set(caveats)], unresolvedCaveats: [...new Set(unresolvedCaveats)], evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs.slice(0, 8).map((item) => clip(item, 160)) : [], summary: clip(input.summary, 800), acceptanceGate };
  const route = state.routeSet.routes.find((item) => item.routeId === run.routeId);
  route.acceptanceGate = acceptanceGate;
  route.caveats = run.result.caveats.concat(run.result.unresolvedCaveats);
  route.evidenceRefs = run.result.evidenceRefs;
  route.status = "evaluated";
  if (state.routeSet.winningRouteId === route.routeId && acceptanceGate !== "passed") state.routeSet.winningRouteId = null;
  routeSetComparison(state);
  state.routeSet.stateVersion += 1;
  appendEvent(state, "route_competitor_result", { summary: `Recorded ${run.runId} result for route ${run.routeId}; acceptance gate ${acceptanceGate}.`, ref: run.runId, status: acceptanceGate });
  return { state, run, acceptanceGate };
}

function routeSetComparison(state) {
  const results = state.routeSet.routes.filter((route) => route.acceptanceGate !== "unverified");
  const winner = results.find((route) => route.acceptanceGate === "passed");
  state.routeSet.comparison = {
    status: winner ? "accepted" : results.length ? "inconclusive" : "unverified",
    summary: winner ? `Route ${winner.routeId} satisfies all shared acceptance criteria without unresolved caveats.` : results.length ? "No evaluated route has passed the shared acceptance gate." : "No route result has been recorded.",
    caveats: results.flatMap((route) => route.caveats).slice(0, 8),
  };
}

function bindSelectedRoute(state, route) {
  const plan = state.plan;
  if (plan.tasks.length && plan.routeId !== route.routeId
    && plan.execution && ["dispatching", "running", "unknown"].includes(plan.execution.status)) {
    throw new Error("Reconcile the unresolved DAG execution before binding a route. No state changed.");
  }
  state.routeSet.selectedRouteId = route.routeId;
  route.status = "selected";
  if (plan.tasks.length && plan.routeId !== route.routeId) {
    plan.routeId = route.routeId;
    plan.revision += 1;
    plan.stateVersion += 1;
    plan.tasks = plan.tasks.map((task) => ({ ...task, status: "pending", evidence: "", reason: "", assessment: null }));
    plan.execution = null;
    plan.executionDrift = null;
    plan.approval = null;
    plan.approvalRequest = null;
    plan.approvalRequest = createDagApprovalRequest(state);
  }
}

export function selectRoute(stateValue, input = {}) {
  const state = routeInput(stateValue, input);
  const route = state.routeSet.routes.find((item) => item.routeId === input.routeId);
  if (!route) throw new Error(`Unknown or stale route identity "${input.routeId}". No state changed.`);
  if (state.routeSet.selectedRouteId !== route.routeId && route.acceptanceGate !== "passed") {
    throw new Error(`Route ${route.routeId} has no correlated Human selection or passing competitor result. Request ${state.routeSet.selectionRequest?.id ?? "none"} is ${state.routeSet.selectionRequest?.status ?? "unavailable"}; read compass_route(action=status) and pass its complete questionnaire to ask_user_question unchanged. Recreate the RouteSet with the current expectedStateVersion if Human rejected every alternative. No state changed.`);
  }
  bindSelectedRoute(state, route);
  if (route.acceptanceGate === "passed") {
    state.routeSet.winningRouteId = route.routeId;
    state.routeSet.comparison.status = "accepted";
  }
  state.routeSet.stateVersion += 1;
  appendEvent(state, "route_selected", { summary: `Selected route ${route.routeId}; acceptance gate ${route.acceptanceGate}.`, ref: route.routeId });
  return { state, route, acceptanceGated: route.acceptanceGate === "passed" };
}

export function updateCompetitorCancellation(stateValue, input = {}) {
  const state = routeInput(stateValue, input);
  const run = state.routeSet.competitorRuns.find((item) => item.runId === input.runId && item.routeId === input.routeId);
  if (!run || run.goalVersion !== state.goal.version || run.baselineRef !== state.routeSet.baselineRef || run.correlationId !== input.correlationId) throw new Error("Competitor identity, Goal version, baseline, or correlation is stale. No state changed.");
  if (input.action === "request") {
    if (run.cancellation?.phase === "unknown") throw new Error(`Competitor ${run.runId} has unknown cancellation termination; reconcile native identity before requesting again. No state changed.`);
    const winner = state.routeSet.routes.find((route) => route.routeId === state.routeSet.winningRouteId);
    if (!winner || winner.acceptanceGate !== "passed" || state.routeSet.selectedRouteId !== winner.routeId || state.routeSet.comparison.status !== "accepted") throw new Error("Competitor cancellation is acceptance-gated; no current accepted winning route exists. No state changed.");
    if (run.routeId === winner.routeId) throw new Error("The accepted route cannot be cancelled as a competitor. No state changed.");
    if (!["registered", "running", "unknown"].includes(run.status)) throw new Error(`Competitor ${run.runId} is not cancellable from status ${run.status}. No state changed.`);
    const requestId = nonEmpty(input.requestId, "requestId", 128);
    run.cancellation = { requestId, phase: "requested", requestedAt: timestamp(), acknowledgedAt: null, terminalAt: null, terminalStatus: null };
    run.status = "cancel_requested";
  } else {
    const cancellation = run.cancellation;
    if (!cancellation || cancellation.requestId !== input.requestId) throw new Error("Cancellation request identity is stale or unknown. No state changed.");
    if (input.action === "ack") {
      if (cancellation.phase !== "requested") throw new Error("Cancellation acknowledgement is out of order. No state changed.");
      if (run.result) throw new Error(`Competitor ${run.runId} already has terminal result evidence. No state changed.`);
      cancellation.phase = "acknowledged";
      cancellation.acknowledgedAt = timestamp();
      run.status = "cancel_acknowledged";
    } else if (input.action === "terminal") {
      if (!["requested", "acknowledged"].includes(cancellation.phase)) throw new Error("Cancellation terminal acknowledgement is out of order. No state changed.");
      if (run.result) throw new Error(`Competitor ${run.runId} already has terminal result evidence. No state changed.`);
      const terminalStatus = nonEmpty(input.terminalStatus, "terminalStatus", 32);
      if (!CANCELLATION_TERMINAL_STATUSES.has(terminalStatus)) {
        throw new Error(`terminalStatus "${terminalStatus}" is not a documented native terminal outcome. No state changed.`);
      }
      cancellation.phase = "terminal";
      cancellation.terminalAt = timestamp();
      cancellation.terminalStatus = terminalStatus;
      run.status = terminalStatus === "cancelled" ? "cancelled" : terminalStatus === "completed" ? "completed" : "failed";
    } else if (input.action === "unknown") {
      if (!["requested", "acknowledged"].includes(cancellation.phase)) throw new Error("Unknown cancellation acknowledgement is out of order. No state changed.");
      cancellation.phase = "unknown";
      cancellation.terminalAt = timestamp();
      cancellation.terminalStatus = "unknown";
      run.status = "unknown";
    } else throw new Error(`Unknown cancellation action ${input.action}. No state changed.`);
  }
  state.routeSet.stateVersion += 1;
  appendEvent(state, "route_cancellation", { summary: `Competitor ${run.runId} cancellation ${run.cancellation.phase}.`, ref: run.runId, status: run.cancellation.phase });
  return { state, run, cancellation: run.cancellation };
}

export function routeSetStatus(stateValue) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.routeSet) return { exists: false, stateVersion: 0 };
  return {
    exists: true,
    id: state.routeSet.id,
    goalVersion: state.routeSet.goalVersion,
    baselineRef: state.routeSet.baselineRef,
    stateVersion: state.routeSet.stateVersion,
    selectedRouteId: state.routeSet.selectedRouteId,
    winningRouteId: state.routeSet.winningRouteId,
    exploration: { ...state.routeSet.exploration },
    comparison: { ...state.routeSet.comparison },
    routes: state.routeSet.routes.map((route) => ({ routeId: route.routeId, status: route.status, acceptanceGate: route.acceptanceGate, caveats: route.caveats, evidenceRefs: route.evidenceRefs })),
    competitorRuns: state.routeSet.competitorRuns.map((run) => ({ runId: run.runId, routeId: run.routeId, goalVersion: run.goalVersion, baselineRef: run.baselineRef, correlationId: run.correlationId, status: run.status, cancellation: run.cancellation, result: run.result })),
    selectionRequest: state.routeSet.selectionRequest ? { id: state.routeSet.selectionRequest.id, status: state.routeSet.selectionRequest.status, sourceEntryId: state.routeSet.selectionRequest.sourceEntryId, questionnaire: state.routeSet.selectionRequest.questionnaire } : null,
  };
}

export function revisePlanState(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.goal.current) throw new Error("No Goal has been captured in this session.");
  if (!Array.isArray(input.acceptanceCriteria) || !Array.isArray(input.tasks)) throw new Error("acceptanceCriteria and tasks must be arrays.");
  const criteria = input.acceptanceCriteria.map((item, i) => nonEmpty(item, `acceptanceCriteria[${i}]`, 300)).slice(0, 12);
  if (!criteria.length) throw new Error("acceptanceCriteria must contain at least one concrete criterion.");
  const planInput = {
    goal: state.goal.current,
    acceptanceCriteria: criteria,
    tasks: input.tasks,
    ...(input.changeReason ? { changeReason: input.changeReason } : {}),
  };
  const previousRevision = state.plan.revision ?? 0;
  const nextPlan = createOrRevisePlan(state.plan, planInput);
  const changed = nextPlan.revision !== previousRevision;
  if (changed && state.plan.execution && ["dispatching", "running", "unknown"].includes(state.plan.execution.status)) {
    throw new Error(`Cannot materially revise the DAG while Subagent batch ${state.plan.execution.requestId} is ${state.plan.execution.status}; reconcile the batch first.`);
  }
  state.plan = nextPlan;
  if (state.routeSet?.selectedRouteId) state.plan.routeId = state.routeSet.selectedRouteId;
  if (changed) {
    state.plan.execution = null;
    state.plan.executionDrift = null;
    state.plan.approval = null;
    state.plan.approvalRequest = null;
  }
  syncAcceptanceCriteria(state, criteria, "dag");
  if (changed) state.plan.approvalRequest = createDagApprovalRequest(state);
  if (changed) appendEvent(state, previousRevision ? "plan_revised" : "plan_created", {
    summary: `DAG r${state.plan.revision}: ${state.plan.tasks.length} tasks.`,
    text: input.changeReason || (previousRevision ? "Reason not recorded." : "Initial plan."),
  });
  return { state, changed, summary: summarizePlanStatus(state) };
}

export function renewDagApprovalRequest(stateValue) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.plan?.tasks?.length || state.plan.goal !== state.goal.current) throw new Error("A current Goal DAG is required to request approval. No state changed.");
  if (state.plan.execution && ["dispatching", "running", "unknown"].includes(state.plan.execution.status)) throw new Error("Cannot request new approval while a Subagent batch is unresolved. No state changed.");
  state.plan.approvalRequest = null;
  state.plan.approval = null;
  state.plan.approvalRequest = createDagApprovalRequest(state);
  return { state, request: state.plan.approvalRequest };
}

export function bindDagApprovalQuestionnaire(stateValue, input, sourceEntryId, toolCallId = "") {
  const state = normalizeGoalRunState(stateValue);
  const request = state.plan.approvalRequest;
  if (!request || request.status !== "awaiting_questionnaire" || !matchesDagApprovalQuestion(request, input)) return { state, bound: false };
  if (typeof sourceEntryId !== "string" || !sourceEntryId.trim() || typeof toolCallId !== "string" || !toolCallId.trim()) return { state, bound: false };
  request.sourceEntryId = sourceEntryId.slice(0, 128);
  request.toolCallId = toolCallId.slice(0, 128);
  request.status = "presented";
  return { state, bound: true, requestId: request.id };
}

export function recordTaskAssessment(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  if (!approvalIsCurrent(state)) throw new Error("The current Goal DAG has no current correlated Human approval. No assessment was recorded.");
  if (!input || !["pass", "fail", "inconclusive"].includes(input.status)) throw new Error('status must be "pass", "fail", or "inconclusive". No assessment was recorded.');
  const id = nonEmpty(input.taskId, "taskId", 40);
  const task = state.plan.tasks.find((item) => item.id === id);
  if (!task) throw new Error(`Unknown or stale task ID "${id}". No assessment was recorded.`);
  if (task.status !== "done") throw new Error(`Task "${id}" must be completed before assessment. No assessment was recorded.`);
  const evidence = nonEmpty(input.evidence, "evidence", 1600);
  if (!Array.isArray(input.caveats ?? []) || (input.caveats ?? []).some((item) => typeof item !== "string" || !item.trim())) throw new Error("caveats must be an array of non-empty strings. No assessment was recorded.");
  if (!Array.isArray(input.unresolvedCaveats ?? []) || (input.unresolvedCaveats ?? []).some((item) => typeof item !== "string" || !item.trim())) throw new Error("unresolvedCaveats must be an array of non-empty strings. No assessment was recorded.");
  const unresolvedCaveats = [...new Set((input.unresolvedCaveats ?? []).map((item) => nonEmpty(item, "unresolvedCaveat", 400)))];
  if (input.status === "pass" && unresolvedCaveats.length) throw new Error(`Task "${id}" cannot pass with unresolved caveats. Record fail or inconclusive, or resolve the caveats first. No assessment was recorded.`);
  task.assessment = {
    status: input.status,
    criteria: task.acceptance,
    evidence,
    caveats: [...new Set((input.caveats ?? []).map((item) => nonEmpty(item, "caveat", 400)))],
    unresolvedCaveats,
    goalVersion: state.goal.version ?? 1,
    planRevision: state.plan.revision,
    approvalBinding: state.plan.approval.binding,
    binding: taskAssessmentBinding(state.plan, task),
    assessedAt: timestamp(),
  };
  state.plan.stateVersion = (state.plan.stateVersion ?? 0) + 1;
  appendEvent(state, "task_assessed", {
    summary: `Task ${id} assessment: ${input.status}.`,
    text: `${evidence}${task.assessment.caveats.length ? `\nCaveats: ${task.assessment.caveats.join("; ")}` : ""}${unresolvedCaveats.length ? `\nUnresolved caveats: ${unresolvedCaveats.join("; ")}` : ""}`,
    ref: id,
    status: input.status,
  });
  return { state, assessment: task.assessment };
}

export function dagApprovalStatus(stateValue) {
  const state = normalizeGoalRunState(stateValue);
  return {
    approved: approvalIsCurrent(state),
    requestId: state.plan.approvalRequest?.id ?? null,
    status: approvalIsCurrent(state) ? "approved" : state.plan.approvalRequest?.status ?? "not_requested",
    currentBinding: dagApprovalBinding(state),
  };
}

export function reconcileUnknownExecutionTasks(stateValue, requestId, items, updateTasksFn) {
  const state = normalizeGoalRunState(stateValue);
  const execution = state.plan.execution;
  if (!execution || execution.status !== "unknown" || execution.requestId !== requestId) throw new Error("Only the exact current unknown execution batch can be reconciled. No task state changed.");
  if (!Array.isArray(items) || items.length !== execution.taskIds.length) throw new Error("Reconciliation requires one result for every exact batch task. No task state changed.");
  const batchIds = new Set(execution.taskIds);
  const seen = new Set();
  const updates = items.map((item, index) => {
    const id = nonEmpty(item?.id, `items[${index}].id`, 40);
    if (!batchIds.has(id) || seen.has(id)) throw new Error(`Unexpected or duplicate batch task "${id}". No task state changed.`);
    seen.add(id);
    const task = state.plan.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error(`Task "${id}" is missing from this batch. No task state changed.`);
    if (item.status === "done") {
      const update = { id, status: "done", evidence: nonEmpty(item.evidence, `items[${index}].evidence`, 1600) };
      if (task.status === "done") return null;
      if (task.status !== "in_progress") throw new Error(`Task "${id}" is not in progress for this batch. No task state changed.`);
      return update;
    }
    if (item.status === "blocked") {
      const update = { id, status: "blocked", reason: nonEmpty(item.reason, `items[${index}].reason`, 600) };
      if (task.status === "blocked") return null;
      if (task.status !== "in_progress") throw new Error(`Task "${id}" is not in progress for this batch. No task state changed.`);
      return update;
    }
    throw new Error(`Invalid terminal task result for "${id}". No task state changed.`);
  });
  if (seen.size !== batchIds.size) throw new Error("Reconciliation must cover the exact batch task set. No task state changed.");
  const changed = updates.filter(Boolean);
  if (changed.length) {
    state.plan = updateTasksFn(state.plan, changed);
    state.plan.executionDrift = null;
    appendEvent(state, "execution_tasks_reconciled", { summary: `Reconciled exact unknown batch ${requestId}: ${changed.map((item) => item.id).join(", ")}.` });
  }
  return { state, affected: changed.map((item) => item.id) };
}

export function transitionTasks(stateValue, action, items, updateTasksFn) {
  const state = normalizeGoalRunState(stateValue);
  if (!approvalIsCurrent(state) && action !== "block") throw new Error("The current Goal DAG has no current correlated Human approval. No task state changed.");
  const tasks = state.plan.tasks ?? [];
  if (!tasks.length) throw new Error("No DAG exists. Create a plan before changing task state.");
  if (!Array.isArray(items) || items.length === 0) throw new Error("At least one task is required.");
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set();
  const updates = [];
  const completedWithoutStart = [];
  for (const [index, item] of items.entries()) {
    const id = nonEmpty(item?.id, `items[${index}].id`, 40);
    if (seen.has(id)) throw new Error(`Task "${id}" appears more than once. Submit each task once.`);
    seen.add(id);
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown or stale task ID "${id}". No state changed; read current DAG status before retrying.`);
    if (action === "start") {
      if (task.status !== "pending") throw new Error(`Task "${id}" is ${task.status}; only pending tasks can start.`);
      const unfinished = task.dependsOn.filter((dep) => {
        const prerequisite = byId.get(dep);
        return prerequisite?.status !== "done" || prerequisite.assessment?.status !== "pass"
          || !taskAssessmentIsCurrent(state.plan, prerequisite);
      });
      if (unfinished.length) throw new Error(`Task "${id}" is not ready; dependencies unfinished or not semantically checked: ${unfinished.join(", ")}.`);
      updates.push({ id, status: "in_progress" });
    } else if (action === "done") {
      if (task.status === "pending") {
        const unfinished = task.dependsOn.filter((dep) => {
          const prerequisite = byId.get(dep);
          return prerequisite?.status !== "done" || prerequisite.assessment?.status !== "pass"
            || !taskAssessmentIsCurrent(state.plan, prerequisite);
        });
        if (unfinished.length) throw new Error(`Task "${id}" is pending and not ready; dependencies unfinished or not semantically checked: ${unfinished.join(", ")}.`);
        completedWithoutStart.push(id);
      } else if (task.status !== "in_progress") {
        throw new Error(`Task "${id}" is ${task.status}; only ready pending or in-progress tasks can be marked done.`);
      }
      updates.push({ id, status: "done", evidence: nonEmpty(item.evidence, `items[${index}].evidence`, 1600) });
    } else if (action === "block") {
      if (!new Set(["pending", "in_progress"]).has(task.status)) throw new Error(`Task "${id}" is ${task.status}; only pending or in-progress tasks can be blocked.`);
      updates.push({ id, status: "blocked", reason: nonEmpty(item.reason, `items[${index}].reason`, 600) });
    } else if (action === "reopen") {
      if (!new Set(["done", "blocked"]).has(task.status)) throw new Error(`Task "${id}" is ${task.status}; only done or blocked tasks can be reopened.`);
      nonEmpty(item.reason, `items[${index}].reason`, 600);
      // Reopening is handled below as a dependency-aware invalidation, not a raw status update.
    } else throw new Error(`Unknown task transition "${action}".`);
  }
  if (action === "reopen") {
    state.plan.executionDrift = null;
    const roots = new Set(items.map((item) => item.id));
    const invalidate = new Set(roots);
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (!invalidate.has(task.id) && task.dependsOn.some((dep) => invalidate.has(dep))) {
          invalidate.add(task.id);
          changed = true;
        }
      }
    }
    const reasons = new Map(items.map((item) => [item.id, nonEmpty(item.reason, `reason for ${item.id}`, 600)]));
    const resetUpdates = [...invalidate].map((id) => ({ id, status: "pending", reason: reasons.get(id) || `Reset because prerequisite task was reopened (${[...roots].join(", ")}).` }));
    state.plan = updateTasksFn(state.plan, resetUpdates);
    // updateTasks clears reason for pending states; reapply the reason after the validated transition.
    state.plan.tasks = state.plan.tasks.map((task) => invalidate.has(task.id)
      ? { ...task, reason: reasons.get(task.id) || `Reset because prerequisite task was reopened (${[...roots].join(", ")}).` }
      : task);
    appendEvent(state, "task_reopen", { summary: `Reopened ${[...roots].join(", ")}; invalidated ${[...invalidate].join(", ")}.`, text: [...roots].map((id) => `${id}: ${reasons.get(id)}`).join("\n") });
    return { state, affected: [...invalidate] };
  }
  state.plan = updateTasksFn(state.plan, updates);
  state.plan.executionDrift = null;
  appendEvent(state, `task_${action}`, {
    summary: `${action} task(s): ${updates.map((item) => item.id).join(", ")}.`,
    text: updates.map((item) => `${item.id}${completedWithoutStart.includes(item.id) ? " (completed directly from ready/pending)" : ""}: ${item.evidence || item.reason || item.status || action}`).join("\n"),
  });
  return { state, affected: updates.map((item) => item.id), ...(action === "done" ? { completedWithoutStart } : {}) };
}
