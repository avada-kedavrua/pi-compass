import { emptyDagState, readyTasks, createOrRevisePlan, taskAssessmentBinding, taskAssessmentIsCurrent } from "./dag-core.mjs";
import { approvalIsCurrent, clearDagApprovalAnswer, createDagApprovalRequest, dagApprovalBinding, matchesDagApprovalQuestion } from "./dag-approval.mjs";
import { normalizeQuestionnaireRecord } from "./questionnaire-integration.mjs";

export const GOAL_RUN_API_VERSION = 7;
export const GOAL_RUN_RELEASE = "0.9.1";

const MAX_UPDATES = 10;
const MAX_DECISIONS = 8;
const MAX_CHECKPOINTS = 5;
const MAX_GOAL_CHANGES = 5;
const MAX_FAILURES = 12;
const MAX_WRITES = 12;
const MAX_HUMAN_DECISIONS = 8;
const MAX_SESSION_DIRECTIVES = 24;
const MAX_HARD_SESSION_DIRECTIVES = 48;
const MAX_EVENTS = 80;
const MAX_EVENT_TEXT = 1_200;
const MAX_CAPTURE_LEDGER = 12;
const MAX_ACCEPTANCE_CRITERIA = 12;
const MAX_TEXT = 12_000;
const MAX_UPDATE_TEXT = 1_800;
const QUESTIONNAIRE_ERRORS = new Set([
  "no_ui", "no_custom_ui", "no_questions", "empty_options", "too_many_questions",
  "duplicate_question", "duplicate_option_label", "reserved_label", "session_load_failed",
  "stale_module_cache",
]);

export function emptyGoalRunState() {
  return {
    schemaVersion: 7,
    stateRevision: 0,
    eventSeq: 1,
    events: [],
    captureLedger: [],
    goal: {
      original: null,
      current: null,
      createdAt: null,
      originalTruncated: false,
      sourceUpdateId: null,
      sourceUpdateText: null,
      sourceUpdateTruncated: false,
      acceptanceCriteria: [],
      criteria: [],
      nextAcceptanceNumber: 1,
      updates: [],
      nextUpdateNumber: 1,
      changes: [],
      version: 1,
    },
    plan: emptyDagState(),
    humanDecisions: [],
    nextHumanDecisionNumber: 1,
    sessionDirectives: [],
    nextDirectiveNumber: 1,
    decisions: [],
    checkpoints: [],
    nextDecisionNumber: 1,
    nextCheckpointNumber: 1,
    goalChanges: [],
    trace: { failures: [], writes: [] },
    activeCapabilities: [],
    activeCapability: "root", // Compatibility projection for v0.2.x readers.
    autoActivation: null,
    triageRuns: [],
    nextTriageNumber: 1,
    projectRoot: null,
  };
}

const clip = (value, max = 500) => {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const timestamp = () => new Date().toISOString();

function normalizeHumanDecisionRecord(value, index, fallbackVersion = 1) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = clip(value.text, 2600);
  const questionnaire = normalizeQuestionnaireRecord(value.questionnaire);
  if (!text && !questionnaire) return null;
  return {
    id: typeof value.id === "string" && /^H\d+$/.test(value.id) ? value.id : `H${index + 1}`,
    at: typeof value.at === "string" ? value.at.slice(0, 64) : timestamp(),
    source: clip(value.source || "migration", 80),
    sourceCallId: typeof value.sourceCallId === "string" ? value.sourceCallId.slice(0, 128) : "",
    goalVersion: Number.isInteger(value.goalVersion) && value.goalVersion > 0
      ? value.goalVersion
      : (Number.isInteger(fallbackVersion) && fallbackVersion > 0 ? fallbackVersion : 1),
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
    return `${answer.question} = ${values.join(" + ") || "answered"}`;
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
function canonicalDirective(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}
function isHardDirective(value) {
  const text = String(value ?? "");
  return /\b(?:must(?:\s+not)?|do\s+not|don't|should\s+not|never|only|read-only|readonly|forbid(?:den)?|prohibit(?:ed)?)\b|(?:只允许|只能|只有|只从|仅限|不得|禁止|不许|绝不|严禁|必须|务必|不能|不允许|不应该|不需要考虑|不要|别再|别|不可|不以|不假设|不替换|不覆盖|不落盘|零进程残留)/i.test(text);
}
function textFingerprint(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

// Keep the most recent updates, but pin the update that established the
// current Goal and a bounded number of unresolved scope candidates. Otherwise
// a long session can evict the very Human message needed to explain the active
// Goal, or evict a candidate before the Agent resolves it.
function retainGoalUpdates(items, sourceUpdateId = null) {
  const list = Array.isArray(items) ? items : [];
  const keep = new Set(list.slice(-MAX_UPDATES).map((item) => item?.id).filter(Boolean));
  if (sourceUpdateId) keep.add(sourceUpdateId);
  const pending = list.filter((item) => item?.goalChangeCandidate === true && item?.goalChangeResolution === "pending");
  for (const item of pending.slice(-MAX_GOAL_CHANGES)) if (item?.id) keep.add(item.id);
  return list.filter((item) => keep.has(item?.id));
}

function compactCaptureLedgerItem(item) {
  const legacyText = typeof item?.text === "string" ? item.text : "";
  const preview = typeof item?.preview === "string" ? item.preview : legacyText;
  return {
    ...(typeof item?.messageId === "string" && item.messageId ? { messageId: item.messageId } : {}),
    source: clip(item?.source || "unknown", 48),
    fingerprint: typeof item?.fingerprint === "string" ? item.fingerprint : textFingerprint(legacyText || preview),
    textLength: Number.isSafeInteger(item?.textLength) && item.textLength >= 0 ? item.textLength : legacyText.length,
    preview: clip(preview, 140),
    at: typeof item?.at === "string" ? item.at : timestamp(),
  };
}

const nonEmpty = (value, name, max = 4000) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return clip(value, max);
};

export function normalizeGoalRunState(raw) {
  const empty = emptyGoalRunState();
  if (!raw || typeof raw !== "object" || ![2, 3, 4, 5, 6, 7].includes(raw.schemaVersion)) return empty;
  const state = {
    ...empty,
    ...raw,
    schemaVersion: 7,
    stateRevision: Number.isSafeInteger(raw.stateRevision) && raw.stateRevision >= 0 ? raw.stateRevision : 0,
    eventSeq: Number.isSafeInteger(raw.eventSeq) && raw.eventSeq >= 1 ? raw.eventSeq : 1,
    events: Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [],
    captureLedger: Array.isArray(raw.captureLedger) ? raw.captureLedger.slice(-MAX_CAPTURE_LEDGER) : [],
    autoActivation: raw.autoActivation && typeof raw.autoActivation === "object" ? raw.autoActivation : null,
    triageRuns: Array.isArray(raw.triageRuns) ? raw.triageRuns.slice(-6) : [],
    nextTriageNumber: Number.isInteger(raw.nextTriageNumber) ? raw.nextTriageNumber : 1,
    goal: { ...empty.goal, ...(raw.goal ?? {}) },
    plan: raw.plan && typeof raw.plan === "object" ? raw.plan : emptyDagState(),
    humanDecisions: Array.isArray(raw.humanDecisions)
      ? raw.humanDecisions.slice(-MAX_HUMAN_DECISIONS).map((item, index) => normalizeHumanDecisionRecord(item, index, raw.goal?.version)).filter(Boolean)
      : [],
    nextHumanDecisionNumber: Number.isInteger(raw.nextHumanDecisionNumber) ? raw.nextHumanDecisionNumber : 1,
    sessionDirectives: Array.isArray(raw.sessionDirectives)
      ? raw.sessionDirectives.slice(-((MAX_SESSION_DIRECTIVES + MAX_HARD_SESSION_DIRECTIVES) * 4))
      : [],
    nextDirectiveNumber: Number.isInteger(raw.nextDirectiveNumber) ? raw.nextDirectiveNumber : 1,
    decisions: Array.isArray(raw.decisions) ? raw.decisions.slice(-MAX_DECISIONS) : [],
    checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints.slice(-MAX_CHECKPOINTS) : [],
    goalChanges: Array.isArray(raw.goalChanges) ? raw.goalChanges.slice(-MAX_GOAL_CHANGES) : [],
    trace: {
      failures: Array.isArray(raw.trace?.failures) ? raw.trace.failures.slice(-MAX_FAILURES) : [],
      writes: Array.isArray(raw.trace?.writes) ? raw.trace.writes.slice(-MAX_WRITES) : [],
    },
  };
  state.goal.updates = Array.isArray(state.goal.updates) ? state.goal.updates : [];
  state.triageRuns = Array.isArray(state.triageRuns) ? state.triageRuns.slice(-6) : [];
  const maxTriageNumber = state.triageRuns.reduce((max, item) => Math.max(max, Number(String(item?.id ?? "").replace(/^T/, "")) || 0), 0) + 1;
  state.nextTriageNumber = Math.max(Number.isInteger(state.nextTriageNumber) ? state.nextTriageNumber : 1, maxTriageNumber);
  delete state.capabilityEpoch;
  state.goal.changes = Array.isArray(state.goal.changes) ? state.goal.changes.slice(-MAX_GOAL_CHANGES) : [];
  state.goal.version = Number.isInteger(state.goal.version) && state.goal.version > 0 ? state.goal.version : 1;
  state.goal.sourceUpdateId = typeof state.goal.sourceUpdateId === "string" ? state.goal.sourceUpdateId : null;
  state.goal.sourceUpdateText = typeof state.goal.sourceUpdateText === "string" ? state.goal.sourceUpdateText.slice(0, MAX_TEXT) : null;
  state.goal.sourceUpdateTruncated = raw.goal?.sourceUpdateTruncated === true;
  if (!state.goal.sourceUpdateId && state.goal.version > 1) {
    const latestChange = state.goalChanges.at(-1);
    if (latestChange?.updateId && state.goal.updates.some((item) => item.id === latestChange.updateId)) state.goal.sourceUpdateId = latestChange.updateId;
  }
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
    decisions: Array.isArray(state.plan.decisions) ? state.plan.decisions.slice(-MAX_DECISIONS) : [],
    checkpoints: Array.isArray(state.plan.checkpoints) ? state.plan.checkpoints.slice(-MAX_CHECKPOINTS) : [],
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
      // Existing DAGs are never silently delegated during migration.
      executor: raw.schemaVersion >= 6 && ["parent", "code", "subagent"].includes(task?.executor) ? task.executor : "parent",
      agent: raw.schemaVersion >= 6 && task?.executor === "subagent" && ["scout", "researcher", "reviewer", "evidence-auditor", "delegate", "oracle"].includes(task?.agent) ? task.agent : "scout",
    })) : [],
  };
  if (!state.goal.current && state.goal.original) state.goal.current = state.goal.original;
  if (!state.goal.original) {
    state.goal.current = null;
    state.goal.acceptanceCriteria = [];
    state.goal.criteria = [];
    state.plan = emptyDagState();
  }
  if (!Array.isArray(state.plan.tasks)) state.plan.tasks = [];
  if (!state.trace || typeof state.trace !== "object") state.trace = { failures: [], writes: [] };

  const version = state.goal.version;
  // Migrate v0.2.x single-capability state to additive capability state.
  const legacyCapability = typeof raw.activeCapability === "string" ? raw.activeCapability : "root";
  state.activeCapabilities = Array.isArray(raw.activeCapabilities)
    ? [...new Set(raw.activeCapabilities.filter((item) => typeof item === "string" && item !== "root"))]
    : legacyCapability !== "root" ? [legacyCapability] : [];
  state.activeCapability = state.activeCapabilities.at(-1) ?? "root";

  // Existing v0.2.x criteria were strings only. Migrate them to explicit evidence states.
  if (!state.goal.criteria.length && state.goal.acceptanceCriteria.length) {
    state.goal.criteria = state.goal.acceptanceCriteria.map((text, index) => ({
      id: `AC${index + 1}`, text, required: true, status: "unverified", evidence: "",
      goalVersion: version, updatedAt: null,
    }));
    state.goal.nextAcceptanceNumber = Math.max(state.goal.nextAcceptanceNumber, state.goal.criteria.length + 1);
  }
  if (state.goal.criteria.length) state.goal.acceptanceCriteria = state.goal.criteria.filter((item) => item.goalVersion === version).map((item) => item.text);
  const sortedGoalChanges = [...state.goalChanges].sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
  for (const [index, item] of state.goal.updates.entries()) {
    if (!Number.isInteger(item.goalVersion)) {
      let inferredVersion = 1;
      for (const change of sortedGoalChanges) {
        if (Date.parse(item.at || 0) < Date.parse(change.at || 0)) break;
        inferredVersion = (change.previousGoalVersion ?? inferredVersion) + 1;
      }
      item.goalVersion = Math.min(version, inferredVersion);
    }
    if (!item.id) item.id = `U${index + 1}`;
    if (typeof item.sourceText === "string" && item.sourceText.length > MAX_TEXT) {
      item.sourceText = item.sourceText.slice(0, MAX_TEXT);
      item.sourceTextTruncated = true;
    }
  }
  const legacyLedgerTextFor = (update) => {
    if (!update) return "";
    const exact = update.messageId
      ? state.captureLedger.find((item) => item?.messageId === update.messageId && typeof item?.text === "string")
      : null;
    if (exact) return exact.text;
    const prefix = String(update.text ?? "").slice(0, Math.min(160, String(update.text ?? "").length));
    const fallback = prefix ? [...state.captureLedger].reverse().find((item) => typeof item?.text === "string" && item.text.startsWith(prefix)) : null;
    return fallback?.text ?? "";
  };
  // Recover full source text from v5 snapshots created before the capture ledger
  // was compacted. Pending candidates keep their bounded source until resolved.
  for (const update of state.goal.updates) {
    if (update?.goalChangeCandidate === true && update?.goalChangeResolution === "pending" && typeof update.sourceText !== "string") {
      const sourceText = legacyLedgerTextFor(update);
      if (sourceText) {
        update.sourceText = sourceText.slice(0, MAX_TEXT);
        update.sourceTextTruncated = sourceText.length > MAX_TEXT;
      }
    }
  }
  if (!state.goal.sourceUpdateText && state.goal.sourceUpdateId) {
    const sourceUpdate = state.goal.updates.find((item) => item.id === state.goal.sourceUpdateId);
    const sourceText = legacyLedgerTextFor(sourceUpdate) || sourceUpdate?.sourceText || sourceUpdate?.text || "";
    if (sourceText) {
      state.goal.sourceUpdateText = sourceText.slice(0, MAX_TEXT);
      state.goal.sourceUpdateTruncated = sourceText.length > MAX_TEXT || sourceUpdate?.sourceTextTruncated === true;
    }
  }
  state.goal.updates = retainGoalUpdates(state.goal.updates, state.goal.sourceUpdateId);
  // The ledger exists only for duplicate detection. Full prompts belong in the
  // Goal/source fields or unresolved candidate, never in every persisted state
  // snapshot. This also migrates old raw-text ledger entries in place.
  state.captureLedger = state.captureLedger.map(compactCaptureLedgerItem).slice(-MAX_CAPTURE_LEDGER);
  const directiveSourceTexts = [state.goal.original, state.goal.current, state.goal.sourceUpdateText,
    ...state.goal.updates.map((item) => item.sourceText || item.text)]
    .filter((item) => typeof item === "string" && item);
  const initialPinnedDirectives = new Set(directiveSourceTexts.flatMap((text) => extractSessionDirectiveFragments(text)
    .filter((item) => item.pinned)
    .map((item) => canonicalDirective(item.text))));
  state.sessionDirectives = state.sessionDirectives.map((item, index) => ({
    ...item,
    id: typeof item.id === "string" && item.id ? item.id : `S${index + 1}`,
    text: clip(item.text, 260),
    goalVersion: Number.isInteger(item.goalVersion) && item.goalVersion > 0 ? item.goalVersion : version,
    reaffirmations: Number.isInteger(item.reaffirmations) && item.reaffirmations > 0 ? item.reaffirmations : 1,
    lastConfirmedAt: typeof item.lastConfirmedAt === "string" ? item.lastConfirmedAt : (typeof item.at === "string" ? item.at : timestamp()),
    pinned: item.pinned === true || initialPinnedDirectives.has(canonicalDirective(item.text)),
    hard: item.hard === true || item.pinned === true || isHardDirective(item.text) || initialPinnedDirectives.has(canonicalDirective(item.text)),
  }));
  state.sessionDirectives = retainSessionDirectives(state.sessionDirectives, version);
  for (const item of state.humanDecisions) if (!Number.isInteger(item.goalVersion)) item.goalVersion = version;
  for (const item of state.decisions) if (!Number.isInteger(item.goalVersion)) item.goalVersion = version;
  for (const item of state.checkpoints) if (!Number.isInteger(item.goalVersion)) item.goalVersion = version;
  for (const item of state.trace.failures) if (!Number.isInteger(item.goalVersion)) item.goalVersion = version;
  for (const item of state.trace.writes) if (!Number.isInteger(item.goalVersion)) item.goalVersion = version;
  state.events = state.events.filter((item) => item && typeof item === "object" && typeof item.kind === "string");
  if ([2, 3].includes(raw.schemaVersion) && state.events.length === 0) {
    if (state.goal.original) appendEvent(state, "goal_created", { at: state.goal.createdAt || timestamp(), source: "migration", summary: "Original Goal migrated from v0.2 state.", goalVersion: 1 });
    for (const update of state.goal.updates) appendEvent(state, "human_update", { at: update.at, source: "migration", summary: update.summary || update.text, text: update.text, ref: update.id, goalVersion: update.goalVersion });
    for (const item of state.humanDecisions) appendEvent(state, "human_decision", { at: item.at, source: item.source || "migration", summary: item.summary || item.text, text: item.text, ref: item.id, status: item.questionnaire?.outcome, goalVersion: item.goalVersion });
    for (const item of state.decisions) appendEvent(state, "decision_recorded", { at: item.at, summary: item.summary, text: [item.rationale, item.evidence].filter(Boolean).join("; "), ref: item.id, goalVersion: item.goalVersion });
    for (const item of state.checkpoints) appendEvent(state, "checkpoint_recorded", { at: item.at, summary: item.summary, text: [item.ref, item.evidence].filter(Boolean).join("; "), ref: item.id, goalVersion: item.goalVersion });
    for (const item of state.trace.failures) appendEvent(state, "tool_failure", { at: item.at, source: item.tool, summary: item.error, goalVersion: item.goalVersion });
    for (const item of state.trace.writes) appendEvent(state, "write_attempt", { at: item.at, source: item.tool, summary: item.target, goalVersion: item.goalVersion });
    state.events.sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
    state.events.forEach((item, index) => { item.id = `E${index + 1}`; });
    state.eventSeq = state.events.length + 1;
  }
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
  const texts = (Array.isArray(criteria) ? criteria : []).map((item, index) => nonEmpty(item, `acceptanceCriteria[${index}]`, 300)).slice(0, MAX_ACCEPTANCE_CRITERIA);
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
  const state = normalizeGoalRunState(stateValue);
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
  const state = normalizeGoalRunState(stateValue);
  if (!state.goal.current) {
    return { status: "no_goal", evidenceLevel: "none", independentlyVerified: false, unresolvedTaskIds: [], blockedTaskIds: [], failedCriterionIds: [], blockedCriterionIds: [], unverifiedCriterionIds: [] };
  }
  const acceptance = acceptanceStatus(state);
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

/**
 * Deterministic, deliberately conservative planning activation.
 * A numbered list alone is ambiguous (it can be a problem report, evidence list,
 * or implementation plan), so it is not sufficient. Explicit planning/multi-stage
 * phrases are accepted, as are numbered items whose opening words are clearly
 * actionable. This only changes tool visibility; it never creates a DAG.
 */
export function planningActivationSignal(value) {
  const source = stripConventionSections(String(value ?? ""))
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, " ")
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
  if (!source.trim()) return null;
  const explicit = [
    [/\b(?:multi[- ](?:stage|track|phase)|multiple\s+(?:independent\s+)?(?:workstreams|tracks|stages|phases|subgoals|deliverables)|cross[- ](?:file|module|project)|dependency graph|interdependent tasks|decompose(?: the)? (?:task|goal|work)|break (?:this|the work|the goal) down|task graph|\bDAG\b|implementation roadmap)\b/i, "explicit multi-stage/workstream or planning intent"],
    [/(?:多阶段|多条(?:工作流|线|路线)|多个(?:子目标|工作流|项目|模块|交付物|独立任务)|跨(?:多个)?(?:文件|模块|项目)|依赖关系|分阶段|并行(?:执行|任务|工作)|拆解任务|分解任务|制定计划|任务图|实施路线图)/i, "明确的多阶段/多工作流或规划意图"],
  ];
  for (const [pattern, reason] of explicit) if (pattern.test(source)) return reason;

  // Keep this lexical gate intentionally small. Diagnostic headings such as
  // phenomenon/root-cause/evidence/impact are not actionable work items.
  const items = [...source.matchAll(/(?:^|[\s])(?:[1-9]\d?[.)、])\s+([\s\S]*?)(?=(?:\s+[1-9]\d?[.)、]\s+)|$)/g)]
    .map((match) => match[1].split(/\r?\n/)[0].trim());
  const action = /^(?:implement|create|add|remove|fix|update|build|test|verify|deploy|migrate|integrate|restrict|preserve|rewrite|refactor|run|write|configure|replace|inspect|compare|measure|validate|实现|新增|增加|删除|修复|修改|构建|测试|验证|部署|迁移|接入|保留|重写|重构|运行|编写|配置|替换|检查|比较|测量|确认|限制|拆分|完成)(?:\b|[，,：:：、\s])/i;
  const actionable = items.filter((item) => action.test(item));
  if (actionable.length >= 2) return "numbered actionable work items";
  return null;
}

export function defineAcceptanceCriteria(stateValue, criteria) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.goal.current) throw new Error("No Goal exists in this session.");
  if (!Array.isArray(criteria) || criteria.length < 1) throw new Error("Provide at least one concrete acceptance criterion.");
  const normalized = criteria.map((item, index) => nonEmpty(item, `criteria[${index}]`, 300)).slice(0, MAX_ACCEPTANCE_CRITERIA);
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
  const evidence = nonEmpty(input?.evidence, "evidence", 2000);
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

function summarizeNonDirectiveContent(text, directiveFragments) {
  let remainder = stripQuotedRegions(text);
  for (const fragment of [...directiveFragments].sort((a, b) => b.text.length - a.text.length)) {
    if (fragment.text) remainder = remainder.replaceAll(fragment.text, " ");
  }
  remainder = remainder
    .replace(/^\s*(?:constraints?|restrictions?)\s*[:：]\s*/gim, " ")
    .replace(/[，,；;。！？.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return remainder.length >= 16 ? clip(remainder, 220) : "";
}

export function captureHumanPrompt(stateValue, prompt, meta = {}) {
  const state = normalizeGoalRunState(stateValue);
  if (typeof prompt !== "string" || !prompt.trim()) return { state, captured: false, kind: "empty" };
  const text = prompt.trim();
  const source = clip(meta?.source || "unknown", 48);
  const messageId = typeof meta?.messageId === "string" ? meta.messageId : "";
  const receivedAt = timestamp();
  const canonical = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  // A restored v0.2 Goal is often followed by the same initial prompt when the
  // extension is upgraded in-place. Treat that as the same Goal, not a new
  // Human update/directive. Exact repeats do not change scope.
  if (state.goal.original && [state.goal.original, state.goal.current].some((known) =>
    known && canonical(known) === canonical(text))) {
    return { state, captured: false, kind: "duplicate_goal" };
  }
  const ledger = state.captureLedger ?? [];
  const fingerprint = textFingerprint(text);
  const priorById = messageId && ledger.find((item) => item.messageId === messageId);
  // before_agent_start and message_end may describe the same Human message,
  // with only one event carrying an ID. Deduplicate across those event sources,
  // but never collapse two different non-empty message IDs.
  const priorCrossEvent = [...ledger].reverse().find((item) =>
    item.fingerprint === fingerprint && item.textLength === text.length && item.source !== source
    && (Date.now() - Date.parse(item.at || 0)) < 60_000
    && (!item.messageId || !messageId || item.messageId === messageId));
  if (priorById || priorCrossEvent) return { state, captured: false, kind: "duplicate" };
  state.captureLedger = [...ledger, {
    messageId, source, fingerprint, textLength: text.length, preview: clip(text, 140), at: receivedAt,
  }].slice(-MAX_CAPTURE_LEDGER);

  if (!state.goal.original) {
    const original = text.slice(0, MAX_TEXT);
    state.goal.original = original;
    state.goal.current = original;
    state.goal.originalTruncated = text.length > MAX_TEXT;
    state.goal.createdAt = receivedAt;
    appendEvent(state, "goal_created", { at: receivedAt, source, text, summary: clip(text.replace(/\s+/g, " "), 240) });
    // The first prompt is also where many users place the only copy of hard
    // constraints and acceptance criteria. Preserve those as structured state
    // before compaction can reduce the prompt to a short preview.
    const initialCriteria = extractAcceptanceCriteria(original);
    if (initialCriteria.length) {
      syncAcceptanceCriteria(state, initialCriteria, "initial_human_prompt");
      appendEvent(state, "acceptance_defined", { at: receivedAt, source, summary: `Captured ${initialCriteria.length} explicitly labelled acceptance criteria from the initial Human prompt.` });
    }
    addSessionDirectives(state, extractSessionDirectiveFragments(original), { updateId: null, goalVersion: state.goal.version ?? 1, at: receivedAt });
    return { state, captured: true, kind: "original" };
  }

  // One-shot reports/reviews remain traceable events but never become persistent instructions.
  if (isOneShotMetaPrompt(text)) {
    appendEvent(state, "human_meta_prompt", { at: receivedAt, source, text, summary: clip(text.replace(/\s+/g, " "), 240) });
    return { state, captured: true, kind: "one_shot_meta" };
  }

  const explicitGoal = extractExplicitGoalTarget(text);
  const candidateGoal = explicitGoal || extractGoalScopeCandidate(text);
  const applyPending = isApplyPendingGoalChangeCommand(text);
  const isScopeCandidate = Boolean(candidateGoal) || (hasExplicitGoalChangeLanguage(text) && !applyPending);
  const id = `U${state.goal.nextUpdateNumber++}`;
  const full = text.slice(0, MAX_UPDATE_TEXT);
  const directiveFragments = extractSessionDirectiveFragments(text);
  const nonDirectiveSummary = directiveFragments.length ? summarizeNonDirectiveContent(text, directiveFragments) : "";
  const update = {
    id,
    at: receivedAt,
    goalVersion: state.goal.version ?? 1,
    source,
    messageId,
    text: full,
    truncated: text.length > MAX_UPDATE_TEXT,
    quote: full.slice(0, 1200),
    summary: clip(full.replace(/\s+/g, " "), 220),
    directiveCount: directiveFragments.length,
    nonDirectiveSummary,
    goalChangeCandidate: isScopeCandidate,
    goalChangeResolution: isScopeCandidate ? "pending" : null,
    proposedGoal: candidateGoal || null,
    ...(isScopeCandidate ? { sourceText: text.slice(0, MAX_TEXT), sourceTextTruncated: text.length > MAX_TEXT } : {}),
  };
  state.goal.updates = retainGoalUpdates([...state.goal.updates, update], state.goal.sourceUpdateId);
  const eventSummary = update.directiveCount > 0
    ? (update.nonDirectiveSummary || `${update.directiveCount} Human directive(s) captured`)
    : update.summary;
  appendEvent(state, "human_update", { at: receivedAt, source, text: eventSummary, summary: eventSummary, ref: id, goalVersion: update.goalVersion });

  // Store short, atomic directives rather than clipping an entire long prompt.
  // Quoted/fenced task material is excluded so a review of old instructions does
  // not silently turn those instructions into active constraints. Directives
  // repeated inside a pending Goal-change message are associated with that update
  // so they move with the new Goal if the Human/Agent explicitly applies it.
  addSessionDirectives(state, directiveFragments, {
    updateId: id,
    goalVersion: state.goal.version ?? 1,
    at: receivedAt,
    reassignDuplicateToUpdate: isScopeCandidate,
  });

  // Only a direct top-level Goal label/replacement command applies automatically.
  // Goal-scope language embedded in a larger instruction is recorded as a candidate
  // for semantic review, not silently promoted to the active Goal.
  if (explicitGoal) {
    const applied = applyGoalChange(state, { updateId: id, newGoal: explicitGoal });
    return { state: applied.state, captured: true, kind: "goal_changed", id, changedFromUpdateId: id };
  }
  if (applyPending) {
    const pending = explicitGoalChangeUpdates(state).slice().reverse().map((item) => ({ ...item, resolvedGoal: item.proposedGoal || extractExplicitGoalTarget(item.text) })).find((item) => item.id !== id && item.resolvedGoal);
    if (pending) {
      const applied = applyGoalChange(state, { updateId: pending.id, newGoal: pending.resolvedGoal, relatedUpdateIds: [id] });
      return { state: applied.state, captured: true, kind: "goal_changed", id, changedFromUpdateId: pending.id };
    }
  }
  return { state, captured: true, kind: "update", id };
}

export function captureHumanDecision(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  const source = typeof input?.source === "string" ? input.source : "ask-user-questions";
  const rawDetails = input?.details && typeof input.details === "object" && !Array.isArray(input.details) ? input.details : null;
  if (rawDetails?.error) return { state, captured: false, kind: "questionnaire_error", error: String(rawDetails.error) };
  const questionnaire = normalizeQuestionnaireRecord(rawDetails);
  // Structured results are the source of truth. The package's model-facing
  // envelope may echo a selected option's full preview; preserve that raw
  // envelope in Pi history, but do not duplicate it into bounded GoalRun state.
  const text = questionnaire
    ? questionnaireSummary(questionnaire, "")
    : (typeof input?.text === "string" && input.text.trim() ? nonEmpty(input.text, "text", 2600) : "");
  if (!text && !questionnaire) return { state, captured: false, kind: "no_decision" };
  const sourceCallId = typeof input?.sourceCallId === "string" ? input.sourceCallId : "";
  const approvalRequest = state.plan.approvalRequest;
  const correlatedApprovalAnswer = Boolean(approvalRequest?.toolCallId && approvalRequest.toolCallId === sourceCallId);
  if (sourceCallId && state.humanDecisions.some((item) => item.sourceCallId === sourceCallId)) {
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
  const sourceCallId = typeof input?.sourceCallId === "string" ? input.sourceCallId.slice(0, 120) : "";
  const suppliedCode = typeof input?.errorCode === "string" ? input.errorCode : "";
  const errorCode = QUESTIONNAIRE_ERRORS.has(suppliedCode) ? suppliedCode : "unknown";
  if (sourceCallId && state.events.some((event) => event.kind === "human_questionnaire_error" && event.ref === sourceCallId)) {
    return { state, captured: false, kind: "duplicate" };
  }
  if (state.plan.approvalRequest?.toolCallId && state.plan.approvalRequest.toolCallId === sourceCallId) {
    state.plan.approvalRequest.status = "questionnaire_error";
  }
  const reason = clip(input?.reason, 360);
  const event = appendEvent(state, "human_questionnaire_error", {
    at: timestamp(),
    source,
    summary: `Questionnaire unavailable (${errorCode}).`,
    text: reason || `The questionnaire did not produce a Human decision. Error code: ${errorCode}.`,
    ref: sourceCallId,
    status: errorCode,
    goalVersion: state.goal.version ?? 1,
  });
  return { state, captured: true, kind: "error", event };
}

export function explicitGoalChangeUpdates(stateValue) {
  const state = normalizeGoalRunState(stateValue);
  return state.goal.updates.filter((update) => update.goalVersion === (state.goal.version ?? 1)
    && !state.goalChanges.some((change) => change.updateId === update.id)
    && update.goalChangeResolution !== "dismissed"
    && (update.goalChangeCandidate === true || hasExplicitGoalChangeLanguage(update.text))).slice(-8);
}

export function applyGoalChange(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.goal.original) throw new Error("No Goal has been captured in this session.");
  const updateId = nonEmpty(input?.updateId, "updateId", 32);
  const update = explicitGoalChangeUpdates(state).find((item) => item.id === updateId);
  if (!update) throw new Error(`Update "${updateId}" is not an explicit Goal/scope change or has expired. No state changed.`);
  const newGoal = nonEmpty(input?.newGoal || update.proposedGoal, "newGoal", 4000);
  if (newGoal === state.goal.current) throw new Error("newGoal is already the current Goal; no state changed.");
  const sourceText = sourceTextForUpdate(state, update) || update.text || "";
  const sourceTextTruncated = sourceText.length > MAX_TEXT || update.sourceTextTruncated === true;
  const previousPlan = state.plan;
  const prior = {
    at: timestamp(),
    updateId,
    relatedUpdateIds: Array.isArray(input?.relatedUpdateIds) ? input.relatedUpdateIds.slice(0, 4) : [],
    previousGoal: clip(state.goal.current, 1000),
    previousSourceUpdateId: state.goal.sourceUpdateId ?? null,
    newGoal,
    previousGoalVersion: state.goal.version ?? 1,
    planRevision: previousPlan.revision ?? 0,
    previousAcceptanceCriteria: (state.goal.acceptanceCriteria ?? []).slice(0, 12),
    previousCriteria: (state.goal.criteria ?? []).filter((item) => item.goalVersion === (state.goal.version ?? 1)).slice(0, MAX_ACCEPTANCE_CRITERIA).map((item) => ({ id: item.id, text: clip(item.text, 240), status: item.status, evidence: clip(item.evidence, 240) })),
    previousPlan: {
      goal: clip(previousPlan.goal || state.goal.current, 1000),
      revision: previousPlan.revision ?? 0,
      acceptanceCriteria: (previousPlan.acceptanceCriteria ?? []).slice(0, 12),
      tasks: (previousPlan.tasks ?? []).slice(0, 24).map((task) => ({
        id: task.id, title: clip(task.title, 180), status: task.status,
        dependsOn: (task.dependsOn ?? []).slice(0, 24),
        acceptance: clip(task.acceptance, 260), evidence: clip(task.evidence, 260),
        reason: clip(task.reason, 220),
      })),
      planHistory: (previousPlan.planHistory ?? []).slice(-4).map((item) => ({ revision: item.revision, summary: clip(item.summary, 220), reason: clip(item.reason, 220) })),
    },
    traceCounts: {
      failures: state.trace.failures.filter((item) => item.goalVersion === (state.goal.version ?? 1)).length,
      writes: state.trace.writes.filter((item) => item.goalVersion === (state.goal.version ?? 1)).length,
    },
    decisions: state.decisions.filter((item) => item.goalVersion === (state.goal.version ?? 1)).slice(-MAX_DECISIONS).map((item) => ({ id: item.id, at: item.at, summary: clip(item.summary, 180), rationale: clip(item.rationale, 180), evidence: clip(item.evidence, 160) })),
    checkpoints: state.checkpoints.filter((item) => item.goalVersion === (state.goal.version ?? 1)).slice(-MAX_CHECKPOINTS).map((item) => ({ id: item.id, at: item.at, summary: clip(item.summary, 180), ref: clip(item.ref, 180), evidence: clip(item.evidence, 160) })),
    humanDecisions: state.humanDecisions.filter((item) => item.goalVersion === (state.goal.version ?? 1)).slice(-4).map((item) => ({ id: item.id, at: item.at, source: item.source, summary: clip(item.summary, 300) })),
  };
  state.goalChanges = [...state.goalChanges, prior].slice(-MAX_GOAL_CHANGES);
  state.goal.changes = [...state.goalChanges];
  const previousVersion = state.goal.version ?? 1;
  update.goalChangeResolution = "applied";
  state.goal.current = newGoal;
  state.goal.version = previousVersion + 1;
  state.goal.sourceUpdateId = updateId;
  state.goal.sourceUpdateText = sourceText.slice(0, MAX_TEXT);
  state.goal.sourceUpdateTruncated = sourceTextTruncated;
  // The current Goal now owns the bounded source snapshot. Avoid keeping the
  // same long Human message in both the update record and Goal state.
  delete update.sourceText;
  delete update.sourceTextTruncated;
  // Directives written in the same Human message as this scope change belong to
  // the new Goal. Pending candidates remain on the old version until explicitly
  // applied; when applied, their associated directives move with them.
  state.sessionDirectives = state.sessionDirectives.map((item) =>
    item.updateId === updateId && item.goalVersion === previousVersion
      ? { ...item, goalVersion: state.goal.version }
      : item);
  state.sessionDirectives = retainSessionDirectives(state.sessionDirectives, state.goal.version);
  const suppliedCriteria = Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : extractAcceptanceCriteria(sourceText);
  const nextCriteria = suppliedCriteria
    .map((item, i) => nonEmpty(item, `acceptanceCriteria[${i}]`, 300)).slice(0, MAX_ACCEPTANCE_CRITERIA);
  state.goal.acceptanceCriteria = [];
  state.goal.criteria = [];
  state.plan = emptyDagState();
  state.plan.goal = newGoal;
  if (nextCriteria.length) syncAcceptanceCriteria(state, nextCriteria, "goal_change");
  state.plan.acceptanceCriteria = [...state.goal.acceptanceCriteria];
  // Keep broadly applicable capability groups loaded across a Goal change. Hiding
  // history/planning/acceptance here caused stale-tool "not found" failures on the
  // next turn. The next request boundary filters this set against current availability;
  // only Goal-specific review/change capabilities are dropped.
  state.activeCapabilities = (state.activeCapabilities ?? []).filter((capability) => !["goal_change", "issue_review"].includes(capability));
  state.activeCapability = state.activeCapabilities.at(-1) ?? "root";
  state.autoActivation = null;
  appendEvent(state, "goal_changed", {
    summary: `Goal v${previousVersion} replaced by Goal v${state.goal.version}.`,
    ref: updateId,
    text: `Previous Goal: ${prior.previousGoal}\nCurrent Goal: ${newGoal}`,
    goalVersion: state.goal.version,
  });
  return { state, archivedTaskCount: prior.previousPlan.tasks.length, updateId };
}

export function dismissGoalChangeCandidate(stateValue, input) {
  const state = normalizeGoalRunState(stateValue);
  const updateId = nonEmpty(input?.updateId, "updateId", 32);
  const update = explicitGoalChangeUpdates(state).find((item) => item.id === updateId);
  if (!update) throw new Error(`Update "${updateId}" is not a pending Goal/scope candidate. No state changed.`);
  update.goalChangeResolution = "dismissed";
  delete update.sourceText;
  delete update.sourceTextTruncated;
  appendEvent(state, "goal_change_candidate_dismissed", {
    summary: `Kept current Goal after reviewing candidate ${updateId}.`,
    ref: updateId,
    text: update.summary,
  });
  return { state, updateId };
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

export function stripConventionSections(value) {
  const lines = String(value ?? "").split(/\r?\n/);
  const output = [];
  let skipping = false;
  let fenced = false;
  let blankInSection = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      if (!skipping) output.push(line);
      continue;
    }
    if (fenced) {
      if (!skipping) output.push(line);
      continue;
    }
    if (isConventionHeading(line)) {
      skipping = true;
      blankInSection = false;
      continue;
    }
    if (skipping) {
      const heading = normalizeHeading(line);
      const resumes = isAcceptanceHeading(line)
        || /^(?:goal|objective|scope|current state|context|background|deliverables?|hard constraints?|hard restrictions?|constraints?|restrictions?|requirements?|rules?|implementation plan|workflow|verification|约束|限制|硬性约束|硬性限制|需求|要求|交付物|范围|当前状态|上下文|背景|必读契约)$/i.test(heading)
        || /^\s*#{1,6}\s+/.test(line);
      const ordinaryProseAfterBlank = blankInSection && line.trim() && !/^\s*(?:[-*+]\s+|\d+[.)、]\s+)/.test(line);
      if (resumes || ordinaryProseAfterBlank) {
        skipping = false;
      } else {
        if (!line.trim()) blankInSection = true;
        else blankInSection = false;
        continue;
      }
    }
    output.push(line);
  }
  return output.join("\n");
}

function extractAcceptanceCriteria(text) {
  const clean = stripQuotedRegions(text);
  if (!clean) return [];
  const criteria = [];
  let active = false;
  let current = "";
  let blankAfterCriterion = false;
  const flush = () => {
    const value = current.replace(/\s+/g, " ").trim();
    if (value && criteria.length < MAX_ACCEPTANCE_CRITERIA) criteria.push(clip(value, 300));
    current = "";
  };
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (isAcceptanceHeading(rawLine)) {
      flush();
      active = true;
      blankAfterCriterion = false;
      const inline = rawLine.match(/^\s*(?:#{1,6}\s*)?(?:acceptance(?:\s+(?:criteria|conditions?|checks?))?|验收(?:标准|条件|准则|要求)?)\s*(?:\([^)]*\))?\s*[:：]\s*(.+)$/i)?.[1]?.trim();
      if (inline) current = inline;
      continue;
    }
    if (!active) continue;
    if (!line) {
      flush();
      if (criteria.length) blankAfterCriterion = true;
      continue;
    }
    if (isOtherSectionHeading(rawLine)) {
      flush();
      active = false;
      continue;
    }
    const bullet = rawLine.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+|AC\s*\d+\s*[:：.)-]\s*)(.+)$/i);
    if (blankAfterCriterion && !bullet) {
      // A blank line followed by ordinary prose is the end of the labelled
      // acceptance list, not another criterion. Blank-separated list items
      // remain supported because a new bullet clears this marker.
      active = false;
      continue;
    }
    blankAfterCriterion = false;
    if (bullet) {
      flush();
      current = bullet[1].trim();
    } else if (current) {
      current += ` ${line}`;
    } else {
      current = line;
    }
    if (criteria.length >= MAX_ACCEPTANCE_CRITERIA) break;
  }
  flush();
  return [...new Set(criteria)].slice(0, MAX_ACCEPTANCE_CRITERIA);
}

function isOneShotMetaPrompt(text) {
  if (typeof text !== "string") return false;
  const s = stripQuotedRegions(text);
  if (!s) return false;
  const pattern = /(?:复盘本轮|复盘(?:当前|本次)?(?:session|会话|任务)|回顾本轮|回顾本次会话|总结本轮|总结本次会话|分析本轮|分析本次会话|review (?:this|the) (?:session|turn|run)|retrospect(?:ion)? (?:on|of) (?:this|the) (?:session|turn|run)|summari[sz]e (?:this|the) (?:session|turn|run)|report on (?:this|the) (?:session|turn|run))/i;
  const firstLine = s.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  return pattern.test(firstLine) || (s.length <= 1200 && pattern.test(s));
}

function directiveClauseMatches(clause) {
  const s = String(clause ?? "").trim().replace(/^\s*(?:constraint|constraints|restriction|restrictions)\s*[:：]\s*/i, "");
  if (!s || s.length < 3) return false;
  return /\b(?:do not|don't|never|must(?: not)?|should(?: not)?|prefer|avoid|only|always|stop|wait|keep|read-only|readonly|no\s+cd|please use|use .{1,80} instead of|all .{1,50} conclusions? .{0,30}(?:evidence|reference))\b|(?:不要|别(?:再)?|不许|不得|禁止|不以|不假设|必须|务必|优先|请用|用.{1,80}不用|用\s*(?:pi[- ]?)?compass|先.{1,80}再|只允许|只能|只有|只从|必须先|不能|不应该|不需要考虑|不落盘|保持|等到|等待|不用|只写用例名|有问题不要死磕|你就在 cwd|当前就在 cwd|最小|最核心|快准省|输入和输出由你自己定义|及时问我|写清楚|结论.{0,30}(?:evidence|reference|证据|引用)|都要有.{0,20}(?:evidence|reference|证据|引用))/i.test(s);
}

function extractSessionDirectiveFragments(text) {
  if (typeof text !== "string" || isOneShotMetaPrompt(text)) return [];
  const clean = stripQuotedRegions(text);
  const fragments = [];
  const seen = new Map();
  let sectionMode = "general";
  const addClause = (value, force = false, explicitHard = false, pinned = false) => {
    const clause = String(value ?? "").trim().replace(/^\s*(?:constraint|constraints|restriction|restrictions)\s*[:：]\s*/i, "").replace(/[。.!?]+$/, "").trim();
    if (!clause || clause.length < 3 || (!force && !directiveClauseMatches(clause))) return;
    const key = canonicalDirective(clause);
    const hard = explicitHard || isHardDirective(clause);
    if (!key) return;
    if (seen.has(key)) {
      const existing = fragments[seen.get(key)];
      existing.hard = existing.hard || hard;
      existing.pinned = existing.pinned || pinned;
    } else {
      seen.set(key, fragments.length);
      fragments.push({ text: clause, hard, pinned });
    }
  };
  const lines = clean.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim() && (sectionMode === "constraints" || sectionMode === "conventions")) {
      const nextNonEmpty = lines.slice(lineIndex + 1).find((item) => item.trim()) ?? "";
      if (!/^\s*(?:[-*+]\s+|\d+[.)、]\s+)/.test(nextNonEmpty)) sectionMode = "general";
      continue;
    }
    const heading = normalizeHeading(line);
    if (isConventionHeading(line)) {
      sectionMode = "conventions";
      continue;
    }
    if (isAcceptanceHeading(line)) {
      sectionMode = "acceptance";
      continue;
    }
    const inlineConstraint = line.match(/^\s*(?:#{1,6}\s*)?(?:constraints?|restrictions?|hard constraints?|rules?|约束|限制|硬性约束|硬性限制|必须遵守)\s*[:：]\s*(.+)$/i);
    if (inlineConstraint) {
      sectionMode = "constraints";
      addClause(inlineConstraint[1], true, true, true);
      continue;
    }
    const isConstraintHeading = /^(?:constraints?|restrictions?|hard constraints?|rules?|约束|限制|硬性约束|硬性限制|必须遵守)$/i.test(heading);
    if (isConstraintHeading) {
      sectionMode = "constraints";
      const inline = line.match(/^\s*(?:#{1,6}\s*)?(?:constraints?|restrictions?|hard constraints?|rules?|约束|限制|硬性约束|硬性限制|必须遵守)\s*[:：]\s*(.+)$/i)?.[1];
      if (inline) addClause(inline, true, true, true);
      continue;
    }
    if (isOtherSectionHeading(line)) {
      sectionMode = "general";
      continue;
    }
    if (sectionMode === "acceptance" || sectionMode === "conventions") continue;
    const isNumberedItem = /^\s*\d+[.)、]\s+/.test(line);
    const unbulleted = line.trim().replace(/^(?:[-*+\s]+|\d+[.)、]\s+)/, "");
    if (!unbulleted) continue;
    // Split natural-language sentences before matching broad phrases such as
    // "use X instead of Y"; do not split dots inside paths or version numbers.
    for (const clause of unbulleted.split(/[，,；;。！？]+|(?<=\.)\s+(?=[A-Za-z])/)) {
      const pinNumberedHard = isNumberedItem && isHardDirective(clause);
      addClause(clause, sectionMode === "constraints", sectionMode === "constraints", sectionMode === "constraints" || pinNumberedHard);
    }
  }
  return fragments.slice(-((MAX_SESSION_DIRECTIVES + MAX_HARD_SESSION_DIRECTIVES) * 4));
}

function addSessionDirectives(state, directiveFragments, { updateId = null, goalVersion = state.goal.version ?? 1, at = timestamp(), reassignDuplicateToUpdate = false } = {}) {
  for (const fragment of directiveFragments ?? []) {
    const directiveText = typeof fragment === "string" ? fragment : fragment?.text;
    if (typeof directiveText !== "string" || !directiveText.trim()) continue;
    const canonical = canonicalDirective(directiveText);
    const pinned = fragment?.pinned === true;
    const hard = pinned || fragment?.hard === true || isHardDirective(directiveText);
    const existing = state.sessionDirectives.find((item) =>
      item.goalVersion === goalVersion
      && canonicalDirective(item.text) === canonical);
    if (existing) {
      existing.reaffirmations = (existing.reaffirmations ?? 1) + 1;
      existing.lastConfirmedAt = at;
      existing.hard = existing.hard === true || hard;
      existing.pinned = existing.pinned === true || pinned;
      if (reassignDuplicateToUpdate && updateId) existing.updateId = updateId;
      continue;
    }
    state.sessionDirectives.push({
      id: `S${state.nextDirectiveNumber++}`,
      updateId,
      at,
      lastConfirmedAt: at,
      reaffirmations: 1,
      goalVersion,
      text: clip(directiveText, 260),
      summary: clip(directiveText.replace(/\s+/g, " "), 200),
      hard,
      pinned,
    });
  }
  state.sessionDirectives = retainSessionDirectives(state.sessionDirectives, goalVersion);
}

function firstTopLevelLine(text) {
  return stripQuotedRegions(text).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function hasExplicitGoalChangeLanguage(text) {
  const line = firstTopLevelLine(text);
  if (!line) return false;
  const firstClause = line.split(/[。！？.!?]/)[0].trim();
  return /^(?:(?:好|好的|那么|那|另外|现在|当前)[，,。；;:\s]*)?(?:goal(?:\s+v\d+)?|目标)\s*[:：]|^(?:(?:好|好的|那么|那|另外)[，,。；;:\s]*)?(?:我(?:现在)?(?:要)?换(?:一个|个)?\s*(?:新的?\s*)?(?:goal|目标)|(?:把|将)(?:当前|现在的)?(?:compass\s*)?(?:goal|目标).{0,18}(?:改为|改成|换成|调整为)|(?:current\s+)?goal\s+(?:is now|changed to|replaced by))\b|^(?:actually[,，]?\s*)?i\s+(?:need|want)\b.{0,140}\b(?:instead of|rather than)\b|^(?:不再需要|不要.{0,40}而是|不是.{0,60}而是|范围调整为|目标改为|目标改成|换(?:一个|个)?目标)/i.test(firstClause);
}

function extractGoalScopeCandidate(text) {
  const clean = stripQuotedRegions(text);
  if (!clean) return "";
  if (/(?:not a replacement(?: command)?|not a goal change|not changing the goal|not a scope change|不是.{0,36}(?:目标变更|目标替换|替换命令|改目标)|不代表.{0,24}目标(?:变更|替换))/i.test(clean)) return "";
  // A versioned Goal label embedded in a longer structured engineering prompt
  // is a strong scope-change signal, but not enough to silently replace Goal.
  // Preserve it as a candidate so the Agent can explicitly apply or dismiss it.
  const versionedGoal = clean.match(/(?:^|[\s#（(，,;；:])(?:goal|目标)\s+v\d+\s*[:：]\s*([^\n]+)/i);
  if (versionedGoal?.[1]?.trim()) return clip(versionedGoal[1].trim(), 4000);
  const patterns = [
    /(?:当前|现在的|本轮)?目标\s*(?:就是|改为|改成|调整为|换成)\s*([^。\n；;]+)/i,
    /(?:the\s+)?goal\s+(?:for this session\s+)?(?:is now|changed to|replaced by|is to)\s*[:：=]?\s*([^\n.;]+)/i,
    /(?:current\s+)?scope\s+(?:is now|changed to|should be)\s*[:：=]?\s*([^\n.;]+)/i,
  ];
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    const target = match?.[1]?.trim().replace(/[，,。；;\s]+$/, "");
    if (target && target.length >= 3 && !/^(?:什么|哪个|whether|if)\b/i.test(target)) return clip(target, 4000);
  }
  return "";
}

function extractExplicitGoalTarget(text) {
  if (typeof text !== "string" || !text.trim()) return "";
  const clean = stripQuotedRegions(text);
  const firstLine = clean.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  if (!firstLine) return "";
  // Questions/proposals and embedded Goal mentions are not a replacement command.
  if (/(?:是否|要不要|建议|我建议|考虑一下|如果|should we|could we|maybe|perhaps|consider changing|what if)/i.test(firstLine)) return "";

  const goalLabel = firstLine.match(/^(?:(?:好|好的|那么|那|另外)[，,。；;:\s]*)?(?:我来更新[，,。；; ]*)?(?:当前的?\s*)?(?:goal|目标)(?:\s+v\d+)?\s*[:：]\s*(.*)$/i);
  if (goalLabel) {
    const colon = firstLine.search(/[:：]/);
    const fullOffset = clean.indexOf(firstLine) + colon + 1;
    const remainder = clean.slice(fullOffset).trim();
    const lines = remainder.split(/\r?\n/);
    const goalLines = [];
    for (const line of lines) {
      const trimmed = line.trim();
      const heading = normalizeHeading(trimmed);
      const rawHeading = trimmed.replace(/^#{1,6}\s*/, "");
      if (/^(?:constraints?|restrictions?|acceptance(?:\s+(?:criteria|conditions?))?|requirements?|deliverables?|scope|current state|context|约束|限制|验收(?:标准|条件|准则|要求)?|需求|要求|交付物|范围|当前状态|上下文)\s*(?:[:：].*)?$/i.test(rawHeading)) break;
      goalLines.push(line);
    }
    const target = goalLines.join("\n").trim();
    return target.length >= 3 ? clip(target, 4000) : "";
  }

  const directPatterns = [
    /^(?:好[，,。；; ]*)?(?:那)?我(?:现在)?(?:要)?换(?:一个|个)?\s*(?:新的?\s*)?(?:goal|目标)[，,。；; ]*(?:现在的?\s*)?(?:goal|目标)\s*(?:就)?是\s*([^\n。；;，,]+)/i,
    /^(?:好[，,。；; ]*)?(?:当前|现在的?)\s*(?:goal|目标)\s*(?:就)?(?:改为|改成|换成|调整为)\s*([^\n。；;，,]+)/i,
    /^(?:好[，,。；; ]*)?(?:把|将)(?:当前|现在的)?(?:compass\s*)?(?:goal|目标)(?:给我)?(?:改为|换成|调整为|改成)\s*([^\n。；;，,]+)/i,
    /^(?:好[，,。；; ]*)?(?:new\s+goal|(?:the\s+)?goal\s+is\s+now|current\s+goal\s+is)\s*[:：=\-]?\s*([^\n.;，,]+)/i,
  ];
  for (const pattern of directPatterns) {
    const match = firstLine.match(pattern);
    const target = match?.[1]?.trim().replace(/[，,。；;\s]+$/, "");
    if (target && target.length >= 3 && !/^(?:什么|哪个|whether|if)\b/i.test(target)) return clip(target, 4000);
  }
  return "";
}

function isApplyPendingGoalChangeCommand(text) {
  const line = firstTopLevelLine(text);
  if (!line) return false;
  return /^(?:好[，,。；; ]*)?(?:把.{0,28}(?:compass\s*(?:的)?\s*)?(?:goal|目标).{0,14}(?:换|改|更新)|(?:change|switch|update)\s+(?:the\s+)?(?:compass\s*)?(?:goal|objective)\b)/i.test(line);
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
  const version = state.goal.version ?? 1;
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

function directivePriority(item) {
  const text = String(item?.text ?? "").toLowerCase();
  let score = 0;
  if (item?.pinned === true) score += 12;
  if (item?.hard === true || isHardDirective(text)) score += 8;
  if (/(?:token|credential|secret|凭据|密钥|安全|security|read-only|readonly|pid|进程残留|不得回传|不能推送|不允许写)/i.test(text)) score += 4;
  if (/(?:use .* instead|用.{1,80}不用|必须先|先.{1,80}再|及时问我|有问题不要死磕|写清楚|evidence|reference|证据|引用)/i.test(text)) score += 3;
  if (/(?:最小|最核心|快准省|cwd|compass|rg|fd|amend)/i.test(text)) score += 1;
  score += Math.min(2, Math.log2(Math.max(1, Number(item?.reaffirmations) || 1)));
  return score;
}

function retainSessionDirectives(items, currentVersion = 1) {
  const candidates = (Array.isArray(items) ? items : []).slice(-((MAX_SESSION_DIRECTIVES + MAX_HARD_SESSION_DIRECTIVES) * 4));
  const isHard = (item) => item?.hard === true || isHardDirective(item?.text);
  const hard = candidates.filter(isHard);
  const soft = candidates.filter((item) => !isHard(item));
  if (hard.length <= MAX_HARD_SESSION_DIRECTIVES && soft.length <= MAX_SESSION_DIRECTIVES) return candidates;
  const rank = (a, b) => {
    const currentBiasA = a.goalVersion === currentVersion ? 100 : 0;
    const currentBiasB = b.goalVersion === currentVersion ? 100 : 0;
    return (directivePriority(b) + currentBiasB) - (directivePriority(a) + currentBiasA)
      || Date.parse(b.lastConfirmedAt || b.at || 0) - Date.parse(a.lastConfirmedAt || a.at || 0);
  };
  const keep = new Set([
    ...hard.sort(rank).slice(0, MAX_HARD_SESSION_DIRECTIVES),
    ...soft.sort(rank).slice(0, MAX_SESSION_DIRECTIVES),
  ].map((item) => item.id));
  return candidates.filter((item) => keep.has(item.id));
}

function prioritizedCurrentDirectives(state, limit = 8) {
  const version = state.goal.version ?? 1;
  return state.sessionDirectives
    .filter((item) => item.goalVersion === version)
    .filter((item) => item.text !== state.goal.original && item.text !== state.goal.current)
    .slice()
    .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true)
      || Number(isHardDirective(b.text) || b.hard === true) - Number(isHardDirective(a.text) || a.hard === true)
      || directivePriority(b) - directivePriority(a)
      || Date.parse(b.lastConfirmedAt || b.at || 0) - Date.parse(a.lastConfirmedAt || a.at || 0))
    .slice(0, limit);
}

function sourceTextForUpdate(state, update) {
  if (!update) return "";
  if (update.id && update.id === state.goal.sourceUpdateId && typeof state.goal.sourceUpdateText === "string") {
    return state.goal.sourceUpdateText;
  }
  if (typeof update.sourceText === "string") return update.sourceText;
  const exact = update.messageId
    ? state.captureLedger.find((item) => item.messageId === update.messageId)
    : null;
  const prefix = String(update.text ?? "").slice(0, Math.min(160, String(update.text ?? "").length));
  const fallback = prefix ? [...state.captureLedger].reverse().find((item) => typeof item.text === "string" && item.text.startsWith(prefix)) : null;
  return exact?.text ?? fallback?.text ?? update.text ?? "";
}

function unresolvedAcceptanceRange(state) {
  const version = state.goal.version ?? 1;
  const currentCriteria = (state.goal.criteria ?? []).filter((item) => item.goalVersion === version);
  const sourceUpdate = state.goal.sourceUpdateId
    ? sourceTextForUpdate(state, state.goal.updates.find((item) => item.id === state.goal.sourceUpdateId))
    : "";
  const source = `${state.goal.current ?? ""}\n${sourceUpdate}\n${state.goal.current === state.goal.original ? state.goal.original ?? "" : ""}`;
  const ranges = [...source.matchAll(/\bAC\s*(\d+)\s*[-–—至到]\s*AC?\s*(\d+)\b/gi)];
  if (!ranges.length) return null;
  const ids = new Set(currentCriteria.map((item) => String(item.id ?? "").toUpperCase().replace(/\s+/g, "")));
  for (const match of ranges) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 40) {
      return { range: `AC${match[1]}-AC${match[2]}`, missing: [] };
    }
    const missing = [];
    for (let number = start; number <= end; number += 1) {
      if (!ids.has(`AC${number}`)) missing.push(`AC${number}`);
    }
    if (missing.length) return { range: `AC${start}-AC${end}`, missing };
  }
  return null;
}

export function buildGoalAnchor(stateValue, maxChars = 2200, runtime = null) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.goal.original) return "";
  const version = state.goal.version ?? 1;
  const original = state.goal.original;
  const current = state.goal.current || original;
  const sameAsOriginal = current === original;
  const acceptance = acceptanceStatus(state);
  const outcome = goalOutcomeStatus(state);
  const acceptanceRangeMismatch = unresolvedAcceptanceRange(state);
  const lines = ["[Compass GoalRun v6 — compact continuity projection; facts from runtime, route choice belongs to Agent]"];
  if (sameAsOriginal) {
    lines.push(`Original Goal preview (${original.length} stored chars): ${clip(original.replace(/\s+/g, " "), 360)}${original.length > 360 ? " [preview truncated; retrieve Goal details for the retained original text when needed]" : ""}${state.goal.originalTruncated ? " [original prompt exceeded the storage limit; inspect the original Human message for omitted details]" : ""}`);
    lines.push(`Current Goal v${version}: same as Original Goal.`);
  } else {
    lines.push(`Current Goal v${version}: ${clip(current.replace(/\s+/g, " "), 400)}${current.length > 400 ? " [preview truncated; retrieve Goal details if omitted scope matters]" : ""}`);
    lines.push(`Original Goal preview: ${clip(original.replace(/\s+/g, " "), 180)}${original.length > 180 ? " [truncated]" : ""}`);
  }
  lines.push(`Goal outcome: ${outcome.status}; evidence=${outcome.evidenceLevel}; independently verified by Compass=no.`);
  lines.push(`Acceptance: ${acceptance.status} (${acceptance.passed}/${acceptance.total} reported pass; ${acceptance.failed} failed; ${acceptance.blocked} blocked; ${acceptance.unverified} unverified). A reported pass is not an independent verifier result.`);
  if (acceptanceRangeMismatch) {
    const missing = acceptanceRangeMismatch.missing.length
      ? ` Missing IDs: ${acceptanceRangeMismatch.missing.slice(0, 6).join(", ")}${acceptanceRangeMismatch.missing.length > 6 ? ", …" : ""}.`
      : " The referenced range could not be reconciled.";
    lines.push(`Acceptance reference warning: source mentions ${acceptanceRangeMismatch.range}, but current criteria do not cover that range.${missing} Retrieve authoritative criteria or ask Human; do not infer definitions.`);
  }

  const allCurrentDirectives = state.sessionDirectives.filter((item) => item.goalVersion === version)
    .filter((item) => item.text !== original && item.text !== current);
  const rankedDirectives = prioritizedCurrentDirectives(state, MAX_HARD_SESSION_DIRECTIVES + MAX_SESSION_DIRECTIVES);
  // Explicit Restrictions/Constraints clauses are a distinct class: preserve
  // their source order and surface all of them before later hard-sounding
  // instructions. Otherwise a ranking heuristic can hide a pinned boundary.
  const pinnedDirectives = allCurrentDirectives.filter((item) => item.pinned === true);
  const pinnedIds = new Set(pinnedDirectives.map((item) => item.id));
  const otherHardDirectives = rankedDirectives.filter((item) => !pinnedIds.has(item.id) && (item.hard === true || isHardDirective(item.text)));
  const hardDirectives = [...pinnedDirectives, ...otherHardDirectives];
  const hardIds = new Set(hardDirectives.map((item) => item.id));
  const softDirectives = rankedDirectives.filter((item) => !hardIds.has(item.id));
  const hardShownLimit = maxChars >= 2000 ? 12 : 6;
  const hardShown = hardDirectives.slice(0, hardShownLimit);
  if (hardShown.length) {
    lines.push("Hard Human constraints (pinned/high-priority; full retained text is available in Goal details):");
    for (const item of hardShown) lines.push(`- ${item.id}: ${clip(item.text.replace(/\s+/g, " "), 72)}`);
    if (hardDirectives.length > hardShown.length) {
      lines.push(`- ${hardDirectives.length - hardShown.length} additional hard constraint(s) retained; inspect details only if the planned action may conflict.`);
    }
  }

  const plan = state.plan;
  if (plan?.goal && Array.isArray(plan.tasks) && plan.tasks.length) {
    const tasks = plan.tasks;
    const done = tasks.filter((task) => task.status === "done").length;
    const inProgress = tasks.filter((task) => task.status === "in_progress").map((task) => task.id);
    const blocked = tasks.filter((task) => task.status === "blocked").map((task) => task.id);
    const ready = readyTasks(plan).map((task) => task.id);
    lines.push(`DAG r${plan.revision}/s${plan.stateVersion ?? 0}: ${done}/${tasks.length} done; ready=${ready.slice(0, 6).join(",") || "-"}; in-progress=${inProgress.slice(0, 4).join(",") || "-"}; blocked=${blocked.slice(0, 4).join(",") || "-"}.`);
    const subagentReady = tasks.filter((task) => task.status === "pending" && task.executor === "subagent" && String(task.writeScope || "").toLowerCase() === "read-only" && String(task.dispatchReason || "").trim().length >= 12 && task.dependsOn.every((dep) => tasks.find((candidate) => candidate.id === dep)?.status === "done"));
    const subagentNeedsRationale = tasks.filter((task) => task.status === "pending" && task.executor === "subagent" && String(task.writeScope || "").toLowerCase() === "read-only" && String(task.dispatchReason || "").trim().length < 12);
    const codeReady = tasks.filter((task) => task.status === "pending" && task.executor === "code" && task.dependsOn.every((dep) => tasks.find((candidate) => candidate.id === dep)?.status === "done"));
    const parentReady = tasks.filter((task) => task.status === "pending" && task.executor === "parent" && task.dependsOn.every((dep) => tasks.find((candidate) => candidate.id === dep)?.status === "done"));
    if (subagentReady.length) lines.push(`Execution routing: ${subagentReady.length} ready read-only Subagent task(s) (${subagentReady.slice(0, 4).map((task) => `${task.id}/${task.agent || "scout"}`).join(", ")}). Compass auto-dispatches only when dispatchReason justifies a separate semantic context; deterministic work stays in Code Mode and tightly coupled reasoning stays with the parent.`);
    if (subagentNeedsRationale.length) lines.push(`Subagent dispatch is gated for ${subagentNeedsRationale.map((task) => task.id).slice(0, 6).join(", ")}: add dispatchReason explaining why a separate semantic call is worth the cost, or change executor to parent/code. No child is dispatched until justified.`);
    const childEvidence = tasks.filter((task) => task.executor === "subagent" && task.status === "done" && task.evidence).slice(-4);
    if (childEvidence.length) lines.push(`Child-reported findings (task evidence, not independent Goal acceptance): ${childEvidence.map((task) => `${task.id}=${clip(task.evidence, 180)}`).join("; ")}.`);
    if (codeReady.length) lines.push(`Code Mode tasks ready: ${codeReady.slice(0, 4).map((task) => task.id).join(", ")}; the parent Agent executes deterministic/batched native-tool operations through Code Mode, then records evidence with compass_task(action=done). Code Mode is not a semantic Subagent and does not imply child delegation.`);
    if (parentReady.length) lines.push(`Parent-owned tasks ready: ${parentReady.slice(0, 4).map((task) => task.id).join(", ")}; execute in the parent session and record evidence with compass_task(action=done).`);
    if (plan.executionDrift) lines.push(`Execution drift detected at ${clip(plan.executionDrift.at || "unknown time", 28)}: ${clip(plan.executionDrift.reason || "write outside an active task", 140)}. This warning was generated by the runtime, not by the Agent. Before further writes, reconcile the DAG and start/revise the appropriate task. Compass warns rather than blocking all writes.`);
    if (plan.execution && ["dispatching", "running", "unknown"].includes(plan.execution.status)) {
      const resultSummary = (plan.execution.results || []).slice(0, 4).map((item) => `${item.id}:${item.status}${item.runId ? `@${clip(item.runId, 18)}` : ""}${item.fallbackAttempted ? "(DeepSeek fallback)" : ""}`).join(", ");
      lines.push(`Subagent batch ${plan.execution.status}: tasks=${(plan.execution.taskIds || []).join(",")}; request=${clip(plan.execution.requestId || "unknown", 36)}; results=${resultSummary || "-"}. Reconcile this batch before dispatching another; do not duplicate it.`);
      if (plan.execution.error) lines.push(`Subagent execution warning: ${clip(plan.execution.error, 180)}.`);
    } else if (plan.execution && plan.execution.status === "failed" && plan.execution.error) {
      lines.push(`Subagent auto-dispatch unavailable: ${clip(plan.execution.error, 200)}. Tasks remain pending when no child was confirmed. Respect the user's tool preference; enable Subagents or revise the executor to parent/code before retrying.`);
    } else if (plan.execution?.status === "completed" && Array.isArray(plan.execution.results) && plan.execution.results.length) {
      const results = plan.execution.results.slice(0, 4).map((item) => `${item.id}:${item.status}@${clip(item.model, 28)}${item.fallbackAttempted ? "(fallback)" : ""}`).join(", ");
      const latestCostComplete = plan.execution.results.every((item) => Number.isFinite(item.usage?.cost) && (!item.fallbackAttempted || Number.isFinite(item.primaryUsage?.cost)));
      const latestCost = plan.execution.results.reduce((sum, item) => sum + (Number.isFinite(item.usage?.cost) ? item.usage.cost : 0) + (item.fallbackAttempted && Number.isFinite(item.primaryUsage?.cost) ? item.primaryUsage.cost : 0), 0);
      const latestWallRaw = Date.parse(plan.execution.completedAt || "") - Date.parse(plan.execution.startedAt || "");
      const latestWall = Number.isFinite(latestWallRaw) ? Math.max(0, latestWallRaw) : 0;
      lines.push(`Latest Subagent batch completed: ${results}${plan.execution.results.length > 4 ? `, +${plan.execution.results.length - 4} more` : ""}; ${latestCostComplete ? `reported child cost=$${latestCost.toFixed(4)}` : `reported child cost incomplete (known subtotal=$${latestCost.toFixed(4)})`}; batch wall=${Math.round(latestWall / 1000)}s.`);
      if (plan.execution.policy?.mode) lines.push(`Scheduling policy: ${plan.execution.policy.mode}; ${clip(plan.execution.policy.reason || "No policy reason recorded.", 220)}.`);
      const history = Array.isArray(plan.executionHistory) ? plan.executionHistory.slice(-8) : [];
      if (history.length) {
        const observedCostComplete = history.every((item) => Number.isFinite(item.totalCost));
        const observedDurationComplete = history.every((item) => Number.isFinite(item.sumDurationMs));
        const observedSavingsComplete = history.every((item) => Number.isFinite(item.estimatedParallelSavingsMs));
        const observedCost = history.reduce((sum, item) => sum + (Number.isFinite(item.totalCost) ? item.totalCost : 0), 0);
        const observedChildMs = history.reduce((sum, item) => sum + (Number.isFinite(item.sumDurationMs) ? item.sumDurationMs : 0), 0);
        const observedWallMs = history.reduce((sum, item) => sum + (Number.isFinite(item.wallDurationMs) ? item.wallDurationMs : 0), 0);
        const estimatedNetSavedMs = history.reduce((sum, item) => sum + (Number.isFinite(item.estimatedParallelSavingsMs) ? item.estimatedParallelSavingsMs : 0), 0);
        const metricsComplete = history.every((item) => item.metricsComplete === true);
        lines.push(`Observed Subagent metrics over ${history.length} recent batch(es): ${observedCostComplete ? `cost=$${observedCost.toFixed(4)}` : `cost incomplete (known subtotal=$${observedCost.toFixed(4)})`}; ${observedDurationComplete ? `summed child duration=${Math.round(observedChildMs / 1000)}s` : `summed child duration incomplete (known subtotal=${Math.round(observedChildMs / 1000)}s)`}; batch wall=${Math.round(observedWallMs / 1000)}s; ${observedSavingsComplete ? `estimated net wait saved=${Math.round(estimatedNetSavedMs / 1000)}s` : `estimated net wait saved incomplete (known subtotal=${Math.round(estimatedNetSavedMs / 1000)}s)`}; usage completeness=${metricsComplete ? "complete" : "partial"}. This is an observed scheduling estimate, not a counterfactual parent-only cost comparison.`);
      }
    }
    if (blocked.length) lines.push(`Unresolved task blockers: ${blocked.slice(0, 3).map((id) => { const task = tasks.find((item) => item.id === id); return `${id} ${clip(task?.reason || task?.title || "blocked", 64)}`; }).join("; ")}.`);
    if (blocked.length && acceptance.status === "reported_satisfied") lines.push(`Outcome caveat: acceptance is Agent-reported satisfied, but task(s) remain blocked (${blocked.join(", ")}); explain the blocker before claiming the overall Goal outcome is achieved.`);
    if (done === tasks.length && acceptance.status !== "reported_satisfied") lines.push("All DAG tasks are done, but Goal acceptance is not reported satisfied. Do not equate task closure with Goal completion.");
    const change = plan.planHistory?.at(-1);
    if (change) lines.push(`Latest plan change r${change.revision}: ${clip(change.summary, 80)}; reason=${clip(change.reason || "not recorded", 60)}.`);
  } else {
    const subagentsUnavailable = runtime?.subagents && runtime.subagents.active === false && [true, false].includes(runtime.subagents.registered);
    lines.push(subagentsUnavailable
      ? `No DAG is active. Native Subagents are ${runtime.subagents.registered === true ? "registered but inactive in the Pi/user toolset" : "not registered"}; Compass will not force-enable them.`
      : "No DAG is active. Native tool activation belongs to Pi and its extensions; a DAG is optional.");
    if (state.autoActivation?.capability === "planning" && state.autoActivation?.trigger === "explicit_goal_complexity") {
      lines.push(`Planning tools were surfaced because of ${clip(state.autoActivation.reason || "an explicit multi-part Goal", 80)}; no DAG was created. Use them only if they reduce coordination cost.`);
    }
  }

  const optional = [];
  const subagentsUnavailable = runtime?.subagents && runtime.subagents.active === false && [true, false].includes(runtime.subagents.registered);
  if (subagentsUnavailable && Boolean(plan?.tasks?.length)) {
    optional.push(`Native Subagents ${runtime.subagents.registered === true ? "are registered but inactive in the Pi/user toolset" : "are not registered"}; Compass will not force-enable them.`);
  }
  const pending = explicitGoalChangeUpdates(state).at(-1);
  if (pending) optional.push(`Pending scope change ${pending.id}: ${clip(pending.summary, 130)}${pending.proposedGoal ? `; proposed: ${clip(pending.proposedGoal, 150)}` : ""}. Review before applying.`);
  if (shouldSurfaceIssueReview(state)) {
    const failures = state.trace.failures.filter((item) => item.goalVersion === version).slice(-3);
    const signature = failures.at(-1);
    if (signature) optional.push(`Repeated failure pattern (observation, not diagnosis): ${signature.tool} at ${clip(signature.at, 24)} — ${clip(signature.error, 150)}. Compare prior attempts/evidence before choosing a retry or route change.`);
  }
  const activeDecision = [...state.decisions].reverse().find((item) => item.goalVersion === version && !item.supersededBy);
  if (activeDecision) optional.push(`Latest active decision ${activeDecision.id}: ${clip(activeDecision.summary, 100)}; rationale=${clip(activeDecision.rationale || "?", 60)}${activeDecision.supersedesDecisionIds?.length ? `; supersedes ${activeDecision.supersedesDecisionIds.join(",")}` : ""}.`);
  const checkpoint = [...state.checkpoints].reverse().find((item) => item.goalVersion === version);
  if (checkpoint) optional.push(`Latest checkpoint ${checkpoint.id}: ${clip(checkpoint.summary, 80)}; ref=${clip(checkpoint.ref || "none", 70)}${checkpoint.evidence ? `; evidence=${clip(checkpoint.evidence, 70)}` : ""}.`);
  if (state.goal.sourceUpdateId) {
    const sourceUpdate = state.goal.updates.find((item) => item.id === state.goal.sourceUpdateId);
    if (sourceUpdate) optional.push(`Current Goal source ${sourceUpdate.id}: ${clip(sourceUpdate.summary || sourceUpdate.text.replace(/\s+/g, " "), 150)}; full retained source is in Goal details${state.goal.sourceUpdateTruncated ? " (source truncated at storage limit)" : ""}.`);
  }
  const criteria = state.goal.criteria.filter((item) => item.goalVersion === version);
  if (criteria.length) {
    const prioritized = [...criteria].sort((a, b) => {
      const rank = (item) => ({ failed: 0, blocked: 1, inconclusive: 2, unverified: 3, reported_pass: 4 }[item.status] ?? 5);
      return rank(a) - rank(b);
    }).slice(0, 3);
    optional.push(`Criteria: ${prioritized.map((item) => `${item.id}[${item.status}] ${clip(item.text, 84)}`).join("; ")}${criteria.length > prioritized.length ? `; +${criteria.length - prioritized.length} more` : ""}.`);
  }
  const decisions = state.humanDecisions.filter((item) => item.goalVersion === version).slice(-2);
  if (decisions.length) optional.push(`Human decisions: ${decisions.map((item) => `${item.id}: ${clip(item.summary, 95)}`).join(" | ")}.`);
  const directiveTexts = new Set(allCurrentDirectives.map((item) => item.text.replace(/\s+/g, " ").trim()));
  const updates = state.goal.updates.filter((item) => item.goalVersion === version)
    .filter((item) => item.text !== original && item.text !== current && !directiveTexts.has(item.text.replace(/\s+/g, " ").trim()))
    .map((item) => ({ ...item, anchorSummary: item.directiveCount > 0 ? item.nonDirectiveSummary : item.summary }))
    .filter((item) => Boolean(item.anchorSummary))
    .slice(-2).reverse();
  if (updates.length) optional.push(`Recent Human updates: ${updates.map((item) => `${item.id}: ${clip(item.anchorSummary, 110)}`).join(" | ")}`);
  if (state.autoActivation?.capability === "planning" && !state.plan.tasks.length && state.autoActivation?.trigger !== "explicit_goal_complexity") {
    optional.push(`Planning was surfaced: ${clip(state.autoActivation.reason || "cross-file write signal", 90)}; no DAG was created. Use it only if it reduces coordination cost.`);
  }
  for (const item of softDirectives.slice(0, 4)) {
    optional.push(`Human preference ${item.id}: ${clip(item.text.replace(/\s+/g, " "), 88)}${(item.reaffirmations ?? 1) > 1 ? ` (${item.reaffirmations}x)` : ""}.`);
  }
  const finalLine = "Compass is advisory: no tool blacklist or universal step sequence. Choose tools/routes freely within Human constraints; validate at risk-appropriate milestones. Use state deltas/details only when they add information beyond this projection.";
  const mandatoryText = lines.join("\n");
  const budget = Math.max(0, maxChars - mandatoryText.length - finalLine.length - 80);
  let optionalUsed = 0;
  let omitted = 0;
  for (const line of optional) {
    const cost = line.length + 1;
    if (optionalUsed + cost <= budget) {
      lines.push(line);
      optionalUsed += cost;
    } else omitted += 1;
  }
  if (omitted) lines.push(`Omitted ${omitted} secondary item(s); retrieve focused details only when relevant.`);
  lines.push(finalLine);
  return lines.join("\n");
}

export function buildGoalDetails(stateValue, maxChars = 26000) {
  const state = normalizeGoalRunState(stateValue);
  if (!state.goal.original) return "No Goal has been captured for this session.";
  const version = state.goal.version ?? 1;
  const original = state.goal.original;
  const current = state.goal.current || original;
  const canonical = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const sameAsOriginal = canonical(current) === canonical(original);
  const lines = [
    `Current Goal v${version}${sameAsOriginal ? " (unchanged from original)" : ""}:`,
    current,
    `Acceptance: ${acceptanceStatus(state).status}.`,
  ];
  const directives = state.sessionDirectives.filter((item) => item.goalVersion === version)
    .filter((item) => canonical(item.text) !== canonical(original) && canonical(item.text) !== canonical(current));
  const directiveTexts = new Set(directives.map((item) => canonical(item.text)));
  const hardDirectives = prioritizedCurrentDirectives(state, MAX_HARD_SESSION_DIRECTIVES)
    .filter((item) => item.hard === true || isHardDirective(item.text));
  if (hardDirectives.length) {
    lines.push("Hard Human constraints (full retained text; do not treat as optional preferences):");
    for (const item of hardDirectives) lines.push(`- ${item.id}: ${item.text}`);
  }
  if (state.goal.originalTruncated) lines.push(`[Original Goal stored up to ${MAX_TEXT} characters; inspect the original Human message for omitted details.]`);
  if (state.goal.sourceUpdateId) {
    const sourceUpdate = state.goal.updates.find((item) => item.id === state.goal.sourceUpdateId);
    if (sourceUpdate) {
      lines.push(`Human message that established Current Goal (${sourceUpdate.id}; source message is retained):`);
      const sourceText = sourceTextForUpdate(state, sourceUpdate);
      lines.push(sourceText);
      if (state.goal.sourceUpdateTruncated) lines.push(`[source update stored up to ${MAX_TEXT} characters; original message was longer]`);
      else if (sourceUpdate.truncated && sourceText.length <= sourceUpdate.text.length) lines.push("[source update was truncated in GoalRun; inspect the original Human message if omitted details matter]");
    }
  }
  const criteria = state.goal.criteria.filter((item) => item.goalVersion === version);
  lines.push(criteria.length
    ? `Acceptance criteria: ${criteria.map((item) => `${item.id}[${item.status}] ${item.text}${item.evidence ? ` — ${clip(item.evidence, 180)}` : ""}`).join("; ")}`
    : "Acceptance criteria: not defined.");
  if (!sameAsOriginal) lines.push("Original Goal (historical; current Goal takes precedence for this run):", original);

  const softDirectives = directives.filter((item) => !(item.hard === true || isHardDirective(item.text))).slice(-6);
  if (softDirectives.length) {
    lines.push("Recent Human preferences:");
    for (const item of softDirectives) lines.push(`- ${item.id}: ${clip(item.text.replace(/\s+/g, " "), 260)}`);
  }

  const seenUpdates = new Set();
  const updates = state.goal.updates.filter((item) => item.goalVersion === version)
    .filter((item) => {
      const normalized = canonical(item.text);
      if (!normalized || normalized === canonical(original) || normalized === canonical(current) || directiveTexts.has(normalized) || seenUpdates.has(normalized)) return false;
      seenUpdates.add(normalized);
      return true;
    }).slice(-4);
  if (updates.length) {
    lines.push("Other recent Human updates:");
    for (const item of updates) lines.push(`- ${item.id}: ${clip(item.summary || item.text.replace(/\s+/g, " "), 220)}${item.truncated ? " [truncated]" : ""}`);
  }

  const decisions = state.humanDecisions.filter((item) => item.goalVersion === version).slice(-4);
  if (decisions.length) {
    lines.push("Human decisions:");
    const detailedDecisionIds = new Set(decisions.slice(-2).map((item) => item.id));
    for (const item of decisions) {
      const outcome = item.questionnaire?.outcome ? ` [${item.questionnaire.outcome}]` : "";
      lines.push(`- ${item.id}${outcome}: ${clip(item.summary || item.text, 220)}`);
      if (item.questionnaire && detailedDecisionIds.has(item.id)) {
        for (const answer of item.questionnaire.answers) {
          const selected = [answer.answer, ...(answer.selected ?? [])].filter((value) => typeof value === "string" && value.trim());
          lines.push(`  - Q${answer.questionIndex + 1}: ${clip(answer.question, 120)} => ${clip(selected.join(" + ") || "answered", 140)}${answer.notes ? `; note: ${clip(answer.notes, 100)}` : ""}${answer.hasPreview ? " [preview selected]" : ""}`);
        }
        if (item.questionnaire.unanswered?.length) lines.push(`  - Unanswered question indexes: ${item.questionnaire.unanswered.join(", ")}`);
        if (item.questionnaire.globalNote) lines.push(`  - Global note: ${clip(item.questionnaire.globalNote, 180)}`);
      }
    }
  }
  if (state.goalChanges.length) {
    const changes = state.goalChanges.slice(-2);
    lines.push("Recent Goal changes (summary only):", ...changes.map((item) => `- ${item.updateId}: v${item.previousGoalVersion} -> v${(item.previousGoalVersion ?? 1) + 1}; ${clip(item.summary || item.newGoal, 180)}`));
  }
  const result = lines.join("\n");
  return result.length > maxChars ? `${result.slice(0, maxChars - 45)}\n[Output truncated; use History for event chronology.]` : result;
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

function parseStateCursor(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^R(\d+)-E(\d+)$/);
  if (!match) return null;
  const revision = Number(match[1]);
  const eventSeq = Number(match[2]);
  if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(eventSeq)) return null;
  return { revision, eventSeq };
}

export function buildStateSnapshot(stateValue, afterCursor = null, runtime = {}) {
  const state = normalizeGoalRunState(stateValue);
  const latestSeq = Math.max(0, (state.eventSeq ?? 1) - 1);
  const revision = Number.isInteger(state.stateRevision) ? state.stateRevision : 0;
  const cursor = `R${revision}-E${latestSeq}`;
  if (!state.goal.current) return { v: 6, hasGoal: false, stateRevision: revision, cursor, goalOutcome: goalOutcomeStatus(state), message: "No Goal captured." };

  if (afterCursor !== null && afterCursor !== undefined && (typeof afterCursor !== "string" || afterCursor.length > 32 || !parseStateCursor(afterCursor))) {
    throw new Error('cursor must be an opaque cursor returned by compass_state, e.g. "R12-E42". No state changed.');
  }
  const version = state.goal.version ?? 1;
  const parsedCursor = afterCursor == null ? null : parseStateCursor(afterCursor);
  const cursorAhead = Boolean(parsedCursor && (parsedCursor.revision > revision || parsedCursor.eventSeq > latestSeq));
  const exactCursor = Boolean(parsedCursor && parsedCursor.revision === revision && parsedCursor.eventSeq === latestSeq);
  if (exactCursor) {
    return { v: 6, unchanged: true, stateRevision: revision, goalVersion: version, cursor };
  }

  const allEvents = state.events;
  const firstSeq = allEvents.length ? (eventSequence(allEvents[0].id) ?? latestSeq) : latestSeq + 1;
  const historyGap = Boolean(parsedCursor && parsedCursor.eventSeq < firstSeq - 1 && parsedCursor.eventSeq < latestSeq);
  const stateChanged = Boolean(parsedCursor && parsedCursor.revision !== revision);
  const currentEvents = allEvents.filter((event) => event.goalVersion === version);
  let deltaEvents;
  if (!parsedCursor || historyGap || cursorAhead) deltaEvents = currentEvents.slice(-4);
  else deltaEvents = currentEvents.filter((event) => (eventSequence(event.id) ?? 0) > parsedCursor.eventSeq).slice(-8);
  const matchingCount = !parsedCursor || cursorAhead
    ? currentEvents.length
    : currentEvents.filter((event) => (eventSequence(event.id) ?? 0) > parsedCursor.eventSeq).length;
  const noNewCurrentGoalEvents = Boolean(parsedCursor && !historyGap && !cursorAhead && matchingCount === 0);

  const plan = state.plan?.tasks?.length ? (() => {
    const tasks = state.plan.tasks;
    return {
      revision: state.plan.revision,
      stateVersion: state.plan.stateVersion ?? 0,
      total: tasks.length,
      done: tasks.filter((task) => task.status === "done").length,
      inProgress: tasks.filter((task) => task.status === "in_progress").map((task) => task.id).slice(0, 8),
      blocked: tasks.filter((task) => task.status === "blocked").map((task) => task.id).slice(0, 8),
      ready: readyTasks(state.plan).map((task) => task.id).slice(0, 8),
      remaining: tasks.filter((task) => task.status !== "done").length,
    };
  })() : null;
  const acceptance = acceptanceStatus(state);
  const outcome = goalOutcomeStatus(state);
  const blockedTaskIds = plan?.blocked ?? [];
  const snapshot = {
    v: 6,
    stateRevision: revision,
    goalOutcome: outcome,
    goal: { version, current: clip(state.goal.current, 240), currentTruncated: state.goal.current.length > 240, originalTruncated: state.goal.originalTruncated === true, differsFromOriginal: state.goal.current !== state.goal.original },
    plan,
    acceptance: {
      status: acceptance.status,
      total: acceptance.total,
      reportedPass: acceptance.passed,
      failed: acceptance.failed,
      blocked: acceptance.blocked,
      unverified: acceptance.unverified,
      referencedRangeWithoutDefinitions: Boolean(unresolvedAcceptanceRange(state)),
      referenceMismatch: unresolvedAcceptanceRange(state),
    },
    ...(blockedTaskIds.length && acceptance.status === "reported_satisfied"
      ? { goalOutcomeCaveat: `Acceptance is Agent-reported satisfied, but DAG task(s) remain blocked: ${blockedTaskIds.join(", ")}. Explain the blocker before claiming the overall Goal outcome is achieved.` }
      : {}),
    cursor,
    delta: {
      after: afterCursor ?? null,
      hasNewEvents: matchingCount > 0,
      stateChanged,
      historyGap,
      cursorAhead,
      omitted: Math.max(0, matchingCount - deltaEvents.length),
      events: deltaEvents.map(compactEvent),
    },
    runtime: runtime && typeof runtime === "object" ? runtime : {},
  };
  // State can change without adding a user-facing event (for example, a trace
  // merge). A revision change must still return a fresh snapshot, never a false
  // "unchanged" response based only on event sequence.
  if (!noNewCurrentGoalEvents || stateChanged || historyGap || cursorAhead) {
    const directives = prioritizedCurrentDirectives(state, 8).map((item) => ({ id: item.id, text: clip(item.text, 180), hard: item.hard === true || isHardDirective(item.text), pinned: item.pinned === true, reaffirmations: item.reaffirmations ?? 1 }));
    const decisions = state.humanDecisions.filter((item) => item.goalVersion === version).slice(-2).map((item) => ({
      id: item.id,
      summary: clip(item.summary, 140),
      ...(item.questionnaire?.outcome ? { outcome: item.questionnaire.outcome } : {}),
    }));
    const pending = explicitGoalChangeUpdates(state).at(-1);
    if (directives.length) snapshot.directives = directives;
    if (decisions.length) snapshot.humanDecisions = decisions;
    if (pending) snapshot.pendingGoalChange = { id: pending.id, summary: clip(pending.summary, 180), proposedGoal: pending.proposedGoal ?? null };
  }
  return snapshot;
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
  if (!state.goal.original) return [];
  const version = state.goal.version ?? 1;
  const goalText = stripConventionSections([
    state.goal.current,
    state.goal.sourceUpdateText,
    ...state.goal.updates.filter((item) => item.goalVersion === version).slice(-2).map((item) => item.sourceText || item.text),
  ].filter((value) => typeof value === "string" && value.trim()).join("\n"));
  const active = Array.isArray(state.activeCapabilities) ? state.activeCapabilities : [];
  const hasPlan = Boolean(state.plan?.goal && state.plan.tasks.length);
  const planningSignal = planningActivationSignal(goalText);
  const acceptanceSignal = /(?:acceptance criteria|acceptance test|definition of done|goal-level verification|验收标准|验收条件|完成标准|验收要求)/i.test(goalText);
  const detailsSignal = Boolean(state.goal.originalTruncated || state.goal.sourceUpdateTruncated
    || String(state.goal.current ?? "").length > 1600
    || state.goal.updates.some((item) => item.goalVersion === version)
    || explicitGoalChangeUpdates(state).length
    || /(?:full original prompt|full goal details|show the original message|完整原始提示|完整目标详情|查看原始消息)/i.test(goalText));
  const historySignal = hasPlan
    || state.decisions.some((item) => item.goalVersion === version && !item.supersededBy)
    || state.checkpoints.some((item) => item.goalVersion === version)
    || state.trace.failures.some((item) => item.goalVersion === version)
    || /(?:checkpoint|decision log|route decision|recovery point|decision history|检查点|决策记录|路线决策|恢复点|决策历史)/i.test(goalText);
  const currentCriteria = (state.goal.criteria ?? []).some((item) => item.goalVersion === version);
  const currentFailures = state.trace.failures.some((item) => item.goalVersion === version);
  const caps = [];
  if (planningSignal || hasPlan || active.includes("planning") || state.autoActivation?.capability === "planning") caps.push("planning");
  if (currentCriteria || hasPlan || acceptanceSignal || active.includes("acceptance")) caps.push("acceptance");
  if (historySignal || active.includes("history")) caps.push("history");
  if (detailsSignal || active.includes("goal_details")) caps.push("goal_details");
  if (currentFailures || shouldSurfaceIssueReview(state) || active.includes("issue_review")) caps.push("issue_review");
  if (explicitGoalChangeUpdates(state).length > 0) caps.push("goal_change");
  return caps;
}

export function buildRecentEvents(stateValue, limit = 12) {
  const state = normalizeGoalRunState(stateValue);
  const count = Math.max(1, Math.min(20, Number.isInteger(limit) ? limit : 12));
  const canonical = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const knownGoals = [state.goal.original, state.goal.current].filter(Boolean).map(canonical);
  const relevant = state.events.filter((item) => {
    if (item.kind === "goal_created") return false; // Goal details are available directly from GoalRun.
    if (item.kind !== "human_update") return true;
    const text = canonical(item.text);
    // Goal text is available from GoalRun itself; don't echo it as an event.
    return !text || !knownGoals.includes(text);
  });
  return relevant.slice(-count).map((item) => ({
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
  state.plan.approvalRequest = createDagApprovalRequest(state);
  state.plan.approval = null;
  return { state, request: state.plan.approvalRequest };
}

export function bindDagApprovalQuestionnaire(stateValue, input, toolCallId) {
  const state = normalizeGoalRunState(stateValue);
  const request = state.plan.approvalRequest;
  if (!request || request.status !== "awaiting_questionnaire" || !matchesDagApprovalQuestion(request, input)) return { state, bound: false };
  if (typeof toolCallId !== "string" || !toolCallId.trim()) return { state, bound: false };
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
