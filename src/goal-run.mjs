import { createHash } from "node:crypto";
import { emptyDagState, createOrRevisePlan, executionUnresolved, retainExecutions, dependentTaskIds, taskAssessmentBinding, unmetTaskPrerequisites } from "./dag-core.mjs";
import { approvalIsCurrent, clearDagApprovalAnswer, createDagApprovalRequest, dagApprovalBinding, matchesDagApprovalQuestion } from "./dag-approval.mjs";
import { normalizeQuestionnaireRecord } from "./questionnaire-integration.mjs";
import { normalizeProviderDiagnostics } from "./execution-orchestrator.mjs";

export const GOAL_RUN_API_VERSION = 10;
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

export function emptyGoalRunState() {
  return {
    schemaVersion: GOAL_RUN_API_VERSION,
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
      criteria: [],
      nextAcceptanceNumber: 1,
      version: 0,
    },
    plan: emptyDagState(),
    humanDecisions: [],
    nextHumanDecisionNumber: 1,
    latestHumanEntryId: null,
    decisions: [],
    checkpoints: [],
    nextDecisionNumber: 1,
    nextCheckpointNumber: 1,
    trace: { failures: [], writes: [] },
    projectRoot: null,
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
    ...(item.cancelRequested === true ? { cancelRequested: true } : {}),
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

const nonEmpty = (value, name, max = 4000) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${name} must be at most ${max} characters; text is never clipped.`);
  return text;
};


export function normalizeGoalRunState(input) {
  const empty = emptyGoalRunState();
  if (input === undefined || input === null) return empty;
  if (typeof input !== "object" || Array.isArray(input) || input.schemaVersion !== GOAL_RUN_API_VERSION) throw new Error("Unsupported Compass GoalRun schema. Open a new session or navigate to a supported branch; no state changed.");
  // Every transition owns its entire candidate, including nested proposal/assessment records.
  // Never mutate a previous state or Pi's persisted entry through a shallow copy.
  const raw = structuredClone(input);
  if (!raw.goal || typeof raw.goal !== "object" || !raw.plan || !Array.isArray(raw.plan.tasks)
    || !Number.isSafeInteger(raw.goal.version) || raw.goal.version < 0
    || !(raw.goal.current === null || typeof raw.goal.current === "string" && raw.goal.current.trim() && raw.goal.current.length <= 4000)
    || !Array.isArray(raw.goal.constraints) || raw.goal.constraints.length > 24 || raw.goal.constraints.some((text) => typeof text !== "string" || !text.trim() || text.length > 600)
    || !Array.isArray(raw.goal.criteria) || raw.goal.criteria.length > MAX_ACCEPTANCE_CRITERIA
    || raw.goal.criteria.some((item) => !item || !/^AC[1-9]\d*$/.test(item.id) || typeof item.text !== "string" || !item.text.trim() || item.text.length > 300)
    || raw.plan.tasks.length > 24 || raw.plan.tasks.some((task) => !task || !["parent", "code", "subagent"].includes(task.executor) || task.executor === "subagent" && task.writeScope !== "read-only")
    || (!raw.goal.current && (raw.goal.version !== 0 || raw.plan.tasks.length || raw.goal.criteria.length))) throw new Error("Invalid current GoalRun metadata; no reset or state change. Recover a supported native branch.");
  const rawGoal = raw.goal;
  const state = {
    ...empty,
    schemaVersion: GOAL_RUN_API_VERSION,
    stateRevision: Number.isSafeInteger(raw.stateRevision) && raw.stateRevision >= 0 ? raw.stateRevision : 0,
    eventSeq: Number.isSafeInteger(raw.eventSeq) && raw.eventSeq >= 1 ? raw.eventSeq : 1,
    events: Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [],
    goal: {
      ...empty.goal,
      original: rawGoal.original ?? null,
      current: rawGoal.current ?? null,
      createdAt: rawGoal.createdAt ?? null,
      sourceIds: Array.isArray(rawGoal.sourceIds) ? rawGoal.sourceIds : [],
      originalSourceIds: Array.isArray(rawGoal.originalSourceIds) ? rawGoal.originalSourceIds : [],
      reviewedInputId: rawGoal.reviewedInputId ?? null,
      constraints: Array.isArray(rawGoal.constraints) ? rawGoal.constraints : [],
      criteria: Array.isArray(rawGoal.criteria) ? rawGoal.criteria : [],
      nextAcceptanceNumber: rawGoal.nextAcceptanceNumber,
      version: rawGoal.version,
    },
    plan: raw.plan && typeof raw.plan === "object" ? raw.plan : emptyDagState(),
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
  };
  state.goal.version = Number.isInteger(state.goal.version) && state.goal.version >= 0 ? state.goal.version : 0;
  state.goal.sourceIds = Array.isArray(state.goal.sourceIds) ? state.goal.sourceIds.filter((id) => typeof id === "string").slice(0, 16) : [];
  state.goal.originalSourceIds = Array.isArray(state.goal.originalSourceIds) ? state.goal.originalSourceIds.filter((id) => typeof id === "string").slice(0, 16) : [];
  state.goal.reviewedInputId = typeof state.goal.reviewedInputId === "string" ? state.goal.reviewedInputId : null;
  state.goal.constraints = Array.isArray(state.goal.constraints) ? state.goal.constraints.filter((item) => typeof item === "string").slice(0, 24) : [];
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
  if (!Array.isArray(state.plan.executions)) throw new Error("Unsupported Compass execution snapshot. Select a current native branch; no state changed.");
  state.plan = {
    ...emptyDagState(),
    ...state.plan,
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
        providerDiagnostics: normalizeProviderDiagnostics(metric.providerDiagnostics),
        primaryProviderDiagnostics: normalizeProviderDiagnostics(metric.primaryProviderDiagnostics),
        cost: Number.isFinite(metric.cost) && metric.cost >= 0 ? metric.cost : null,
        primaryCost: Number.isFinite(metric.primaryCost) && metric.primaryCost >= 0 ? metric.primaryCost : null,
        durationMs: Number.isFinite(metric.durationMs) && metric.durationMs >= 0 ? metric.durationMs : null,
        primaryDurationMs: Number.isFinite(metric.primaryDurationMs) && metric.primaryDurationMs >= 0 ? metric.primaryDurationMs : null,
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
    executions: retainExecutions(state.plan.executions.map((record) => normalizeExecutionRecord(record, state.plan.revision ?? 1)).filter(Boolean)),
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
    state.goal.criteria = [];
    state.plan = emptyDagState();
  }
  if (!Array.isArray(state.plan.tasks)) state.plan.tasks = [];
  if (!state.trace || typeof state.trace !== "object") state.trace = { failures: [], writes: [] };

  const version = state.goal.version;
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

function syncAcceptanceCriteria(state, criteria, source = "goal") {
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
  const tasks = state.plan.approval || planHasActiveWork(state) ? state.plan.tasks : [];
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
  if (!Array.isArray(value) || value.length > MAX_ACCEPTANCE_CRITERIA) throw new Error(`criteria must be an array of at most ${MAX_ACCEPTANCE_CRITERIA} strings.`);
  const items = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.trim().length > 300) throw new Error(`criteria[${index}] must be a non-empty string of at most 300 characters.`);
    return item.trim();
  });
  if (new Set(items).size !== items.length) throw new Error("criteria must not contain duplicates.");
  return items;
}

function goalDefinitionKey(goal) {
  return createHash("sha256").update(JSON.stringify({ current: goal.current, constraints: goal.constraints, criteria: goal.criteria.filter((item) => item.goalVersion === goal.version).map(({ id, text }) => ({ id, text })) })).digest("hex");
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
  const criteriaProvided = Object.hasOwn(input, "criteria");
  const criteria = criteriaProvided ? validateGoalCriteria(input.criteria)
    : (creating || replacing ? [] : (state.goal.criteria ?? []).filter((item) => item.goalVersion === state.goal.version).map((item) => item.text));
  if (replacing && planHasActiveWork(state)) throw new Error("Cannot replace the Goal while work is active or unresolved. No state changed.");
  const oldConstraints = JSON.stringify(state.goal.constraints ?? []);
  const oldCriteria = JSON.stringify((state.goal.criteria ?? []).filter((item) => item.goalVersion === state.goal.version).map((item) => item.text));
  const semanticChanged = oldConstraints !== JSON.stringify(constraints) || oldCriteria !== JSON.stringify(criteria);
  if (!creating && semanticChanged && hasUnresolvedExecution(state)) throw new Error("Cannot change Goal definitions while native execution is unresolved. Consume terminal results or reconcile first. No state changed.");
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
    state.goal.criteria = [];
  }
  state.goal.current = current;
  state.goal.sourceIds = [...sourceIds];
  state.goal.reviewedInputId = state.latestHumanEntryId;
  state.goal.constraints = constraints;
  if (criteriaProvided || creating || replacing) syncAcceptanceCriteria(state, criteria, "goal");
  if (semanticChanged && !creating && !replacing) {
    if (state.plan.tasks.length) {
      state.plan.definitionKey = goalDefinitionKey(state.goal);
      refreshPlanApproval(state);
    }
  }
  if (criteriaProvided && oldCriteria !== JSON.stringify(criteria)) appendEvent(state, "acceptance_defined", { summary: `Defined ${criteria.length} explicit acceptance criteria.` });
  if (creating) appendEvent(state, "goal_created", { summary: `Explicit Goal created from ${sourceIds.length} Human source reference(s).`, ref: sourceIds[0] });
  else if (replacing) appendEvent(state, "goal_replaced", { summary: `Current Goal replaced at version ${state.goal.version}.`, ref: sourceIds[0] });
  else if (oldConstraints !== JSON.stringify(constraints)) appendEvent(state, "goal_constraints_updated", { summary: `Updated ${constraints.length} explicit Goal constraint(s).`, ref: sourceIds[0] });
  return { state, changed: true, replaced: replacing };
}

export function addressedConstraints(constraints) {
  return constraints.map((text) => ({ id: `C.${createHash("sha256").update(text).digest("hex").slice(0, 16)}`, text }));
}

function patchGoalDefinitions(current, edits, label) {
  if (edits === undefined) return current.map((item) => item.text);
  if (!Array.isArray(edits) || !edits.length) throw new Error(`Provide at least one ${label} edit.`);
  const next = new Map(current.map(({ id, text }) => [id, text]));
  const seen = new Set();
  for (const edit of edits) {
    const { id, text } = edit;
    if (id === undefined) {
      next.set(Symbol(), nonEmpty(text, label));
      continue;
    }
    if (!next.has(id) || seen.has(id)) throw new Error(`Unknown, stale, or duplicate ${label} ID ${id}. Use an existing ID from compass_state(view=goal), or omit id to add.`);
    seen.add(id);
    if (text === undefined) next.delete(id);
    else next.set(id, nonEmpty(text, label));
  }
  return [...next.values()];
}

export function updateGoal(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.goal.current) throw new Error("Create a Goal before updating its definitions.");
  return setGoal(state, {
    expectedVersion: state.goal.version, current: state.goal.current, sourceIds: state.goal.sourceIds,
    constraints: patchGoalDefinitions(addressedConstraints(state.goal.constraints), input.constraintEdits, "constraint"),
    ...(input.criterionEdits === undefined ? {} : { criteria: patchGoalDefinitions(state.goal.criteria.filter((item) => item.goalVersion === state.goal.version), input.criterionEdits, "criterion") }),
  });
}

function hasUnresolvedExecution(state) {
  return state.plan.executions.some(executionUnresolved);
}

function planHasActiveWork(state) {
  return hasUnresolvedExecution(state) || state.plan.tasks.some((task) => task.status === "in_progress");
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
    const approvalAnswerClear = clearDagApprovalAnswer(approvalRequest, questionnaire, rawDetails);
    approvalRequest.status = questionnaire?.outcome === "declined" ? "declined" : approvalAnswerClear ? "answered" : "modified";
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
    ...(state.plan.stopped ? { stoppedBy: state.plan.stopped.taskId } : {}),
    remaining: state.plan.tasks.filter((task) => task.status !== "done").length,
  } : undefined;
  const criteria = state.goal.criteria.filter((item) => item.goalVersion === state.goal.version);
  const acceptanceStatusValue = acceptanceSummary(state);
  const outcome = outcomeSummary(state, acceptanceStatusValue);
  const outcomeCaveat = acceptanceStatusValue.status === "reported_satisfied" && outcome.blockedTaskIds.length
    ? `Acceptance is Agent-reported satisfied, but DAG task(s) remain blocked: ${outcome.blockedTaskIds.join(", ")}. Explain the blocker before claiming the overall Goal outcome is achieved.`
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

export function buildRecentEvents(stateValue, limit = 12) {
  const state = normalizeGoalRunState(stateValue);
  const count = Math.max(1, Math.min(20, Number.isInteger(limit) ? limit : 12));
  return state.events.filter((item) => item.kind !== "goal_created").slice(-count).map((item) => ({
    id: item.id, at: item.at, goalVersion: item.goalVersion, kind: item.kind,
    source: item.source, summary: item.summary, ref: item.ref ?? null, status: item.status ?? null,
  }));
}

/** Resolve an explicit proposal ref only; unrelated questionnaires remain byte-identical. */
export function expandApprovalProposal(stateValue, input) {
  const markers = (input?.questions ?? []).flatMap((question) => (question.options ?? []).map((option) => option.preview)).filter((value) => typeof value === "string" && value.startsWith("P."));
  if (!markers.length) return null;
  if (markers.length !== 1 || input.questions.length !== 1) throw new Error("Present one Compass proposal per questionnaire. No state changed.");
  const state = normalizeGoalRunState(stateValue);
  const id = markers[0].slice(2);
  const request = state.plan.approvalRequest;
  if (request?.id !== id || request.status !== "awaiting_questionnaire") throw new Error("Compass proposal expired. Read current plan state and request a fresh proposal. No state changed.");
  if (state.goal.reviewedInputId !== state.latestHumanEntryId) throw new Error("Review the latest Human input with compass_goal before requesting approval. No state changed.");
  if (request.binding !== dagApprovalBinding(state)) throw new Error("Compass proposal changed. Request a fresh proposal; no state changed.");
  return [structuredClone(request.questionnaire)];
}

export function patchPlanState(state, input) {
  if (!state.plan.tasks.length) throw new Error("Define a DAG before editing it.");
  const tasks = new Map(state.plan.tasks.map((task) => [task.id, task]));
  const touched = new Set();
  for (const id of input.removeTasks ?? []) {
    if (!tasks.delete(id)) throw new Error(`Unknown or duplicate task to remove: ${id}.`);
    touched.add(id);
  }
  for (const task of input.upsertTasks ?? []) {
    if (touched.has(task.id)) throw new Error(`Conflicting edits for task ${task.id}.`);
    touched.add(task.id);
    tasks.set(task.id, { ...tasks.get(task.id), ...task });
  }
  if (!touched.size) throw new Error("Provide at least one task edit.");
  return revisePlanState(state, { tasks: [...tasks.values()], changeReason: input.changeReason });
}

export function revisePlanState(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.goal.current) throw new Error("No Goal has been captured in this session.");
  if (!Array.isArray(input.tasks) || input.tasks.length > 24) throw new Error("tasks must be an array of at most 24 tasks.");
  const criteria = state.goal.criteria.filter((item) => item.goalVersion === state.goal.version);
  if (!criteria.length) throw new Error("Define Goal acceptance criteria before creating a DAG.");
  const planInput = {
    goal: state.goal.current,
    definitionKey: goalDefinitionKey(state.goal),
    tasks: input.tasks,
    ...(input.changeReason ? { changeReason: input.changeReason } : {}),
  };
  const previousRevision = state.plan.revision ?? 0;
  const nextPlan = createOrRevisePlan(state.plan, planInput);
  const changed = nextPlan.revision !== previousRevision;
  if (changed && planHasActiveWork(state)) throw new Error("Cannot materially revise the DAG while a task remains active. Consume terminal results or reconcile first.");
  state.plan = nextPlan;
  if (changed) {
    state.plan.stopped = null;
    state.plan.executions = [];
    state.plan.executionDrift = null;
    refreshPlanApproval(state);
  }
  if (changed) appendEvent(state, previousRevision ? "plan_revised" : "plan_created", {
    summary: `DAG r${state.plan.revision}: ${state.plan.tasks.length} tasks.`,
    text: input.changeReason || (previousRevision ? "Reason not recorded." : "Initial plan."),
  });
  return { state, changed };
}

export function discardPlan(stateValue) {
  const state = normalizeGoalRunState(stateValue);
  if (planHasActiveWork(state)) throw new Error("Cannot discard a DAG while work is active or unresolved. Consume terminal results or reconcile first. No state changed.");
  if (!state.plan.tasks.length) return { state, changed: false };
  state.plan = { ...emptyDagState(), revision: state.plan.revision };
  return { state, changed: true };
}

function refreshPlanApproval(state) {
  // The previous request must not exclude its own answer from a new proposal’s binding.
  state.plan.approval = null;
  state.plan.approvalRequest = null;
  if (state.goal.criteria.length) state.plan.approvalRequest = createDagApprovalRequest(state);
}

export function renewDagApprovalRequest(stateValue) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.plan?.tasks?.length || state.plan.goal !== state.goal.current) throw new Error("A current Goal DAG is required to request approval. No state changed.");
  if (state.plan.stopped) throw new Error("The DAG was stopped; revise its definition before requesting approval. No state changed.");
  if (!state.goal.criteria.length) throw new Error("Define Goal acceptance criteria before requesting approval. No state changed.");
  if (state.goal.reviewedInputId !== state.latestHumanEntryId) throw new Error("Review the latest Human input with compass_goal before requesting approval. No state changed.");
  const request = state.plan.approvalRequest;
  if (approvalIsCurrent(state) || (request?.status === "awaiting_questionnaire" && request.binding === dagApprovalBinding(state))) return { state, request, changed: false };
  if (hasUnresolvedExecution(state)) throw new Error("Cannot request new approval while a Subagent batch is unresolved. No state changed.");
  refreshPlanApproval(state);
  return { state, request: state.plan.approvalRequest, changed: true };
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
  if (input.status === "pass" && unmetTaskPrerequisites(state.plan, task).length) throw new Error(`Task "${id}" cannot pass while a prerequisite lacks a current pass. No assessment was recorded.`);
  const previous = task.assessment;
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
  const semanticFields = ({ status, evidence, caveats, unresolvedCaveats }) => JSON.stringify([status, evidence, caveats, unresolvedCaveats]);
  if (!previous || semanticFields(previous) !== semanticFields(task.assessment)) {
    const affected = dependentTaskIds(state.plan.tasks, [id]);
    for (const other of state.plan.tasks) if (other.id !== id && affected.has(other.id)) other.assessment = null;
  }
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
  const approved = approvalIsCurrent(state);
  const request = state.plan.approvalRequest;
  // An answered request that no longer matches current input/definitions is stale,
  // never approved: "answered" alone would misreport withdrawn authorization.
  let status = request?.status ?? "not_requested";
  if (approved) status = "approved";
  else if (status === "answered" || (status === "awaiting_questionnaire" && request.binding !== dagApprovalBinding(state))) status = "stale";
  return { approved, status };
}

export function reconcileUnknownExecutionTasks(stateValue, requestId, items, updateTasksFn) {
  const state = normalizeGoalRunState(stateValue);
  const execution = state.plan.executions.find((record) => record.requestId === requestId);
  if (execution?.status !== "unknown") throw new Error("Only an exact unknown execution batch can be reconciled.");
  const remaining = new Set(execution.results.filter(executionUnresolved).map(({ id }) => id));
  if (!remaining.size || !Array.isArray(items) || items.length !== remaining.size) throw new Error("Provide exactly one result per unresolved attempt, excluding already recorded terminal results.");
  const updates = items.map((item) => {
    const id = item?.id;
    if (!remaining.delete(id)) throw new Error(`Unexpected or duplicate unresolved task ${id}.`);
    if (state.plan.tasks.find((task) => task.id === id)?.status !== "in_progress") throw new Error(`Task ${id} is not in progress for this batch.`);
    if (item.status === "done" && item.reason === undefined) return { id, status: "done", evidence: nonEmpty(item.evidence, "evidence", 1600) };
    if (item.status === "blocked" && item.evidence === undefined) return { id, status: "blocked", reason: nonEmpty(item.reason, "reason", 600) };
    throw new Error(`Invalid terminal result for ${id}: use done with evidence or blocked with a reason.`);
  });
  state.plan = updateTasksFn(state.plan, updates, { terminalEvidence: true });
  state.plan.executionDrift = null;
  return { state, affected: updates.map(({ id }) => id) };
}

export function stopPlan(stateValue, input, updateTasksFn) {
  const state = normalizeGoalRunState(stateValue);
  const taskId = nonEmpty(input.taskId, "taskId", 40);
  const task = state.plan.tasks.find((item) => item.id === taskId);
  if (task?.status !== "in_progress") throw new Error("Only an active task can report a semantic stop. No state changed.");
  const reason = nonEmpty(input.reason, "reason", 600);
  const evidence = nonEmpty(input.evidence, "evidence", 1600);
  const sideEffects = input.sideEffects === undefined ? "unknown" : nonEmpty(input.sideEffects, "sideEffects", 800);
  state.plan = updateTasksFn(state.plan, [{ id: taskId, status: "blocked", reason, evidence }]);
  state.plan.stopped ??= { taskId, reason, evidence, sideEffects };
  appendEvent(state, "plan_thrown", { summary: `Task ${taskId} stopped the plan.`, text: `${reason}\n${evidence}\nSide effects: ${sideEffects}`, ref: taskId });
  return state;
}

export function transitionTasks(stateValue, action, items, updateTasksFn) {
  const state = normalizeGoalRunState(stateValue);
  if (!approvalIsCurrent(state) && action !== "block") throw new Error("The current Goal DAG has no current correlated Human approval. No task state changed.");
  if (state.plan.stopped && ["start", "reopen"].includes(action)) throw new Error("The DAG was stopped; revise its definition before starting more work. No state changed.");
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
      const unfinished = unmetTaskPrerequisites(state.plan, task, byId);
      if (unfinished.length) throw new Error(`Task "${id}" is not ready; dependencies unfinished or not semantically checked: ${unfinished.join(", ")}.`);
      updates.push({ id, status: "in_progress" });
    } else if (action === "done") {
      if (task.status === "pending") {
        if (state.plan.stopped) throw new Error("The DAG was stopped; a pending task cannot complete. No state changed.");
        const unfinished = unmetTaskPrerequisites(state.plan, task, byId);
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
    const invalidate = dependentTaskIds(tasks, roots);
    const inFlight = tasks.find((task) => invalidate.has(task.id) && task.status === "in_progress");
    if (inFlight) throw new Error(`Task ${inFlight.id} is still active; confirm its terminal result before reopening a prerequisite. No state changed.`);
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
  state.plan = updateTasksFn(state.plan, updates, { terminalEvidence: action === "done" });
  state.plan.executionDrift = null;
  appendEvent(state, `task_${action}`, {
    summary: `${action} task(s): ${updates.map((item) => item.id).join(", ")}.`,
    text: updates.map((item) => `${item.id}${completedWithoutStart.includes(item.id) ? " (completed directly from ready/pending)" : ""}: ${item.evidence || item.reason || item.status || action}`).join("\n"),
  });
  return { state, affected: updates.map((item) => item.id), ...(action === "done" ? { completedWithoutStart } : {}) };
}
