// Deterministic DAG-to-Subagent delegation contract for pi-subagents.
// This uses the public structured-delegation event family; it does not call the
// model-visible `subagent` tool recursively and does not create a second runner.

export const DELEGATION_EVENTS = Object.freeze({
  request: "prompt-template:subagent:request",
  started: "prompt-template:subagent:started",
  update: "prompt-template:subagent:update",
  response: "prompt-template:subagent:response",
  cancel: "prompt-template:subagent:cancel",
});

export const PRIMARY_MODEL = "cliproxyapi/gpt-6-luna";
export const FALLBACK_MODEL = "jrt/deepseek-v4.1-flash";
export const REVIEW_MODEL = "cliproxyapi/gpt-6.1-sol";
const RECOGNIZED_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Pi-subagents may report the effective thinking level as `provider/id:high`.
// Preserve the observed string in execution history, but validate the underlying
// exact model identity plus a *recognized* suffix; no prefix/substring matching.
export function isSupportedDelegatedModel(value, allowed = [PRIMARY_MODEL, REVIEW_MODEL, FALLBACK_MODEL]) {
  if (typeof value !== "string") return false;
  const model = value.trim();
  return allowed.some((id) => model === id || (model.startsWith(`${id}:`) && RECOGNIZED_THINKING.has(model.slice(id.length + 1))));
}
export const DEFAULT_THINKING = "high";
export const DEFAULT_TIMEOUT_MS = 600_000;
export const MAX_WAVE_TASKS = 4;
export const START_ACK_TIMEOUT_MS = 30_000;
export const MIN_PARALLEL_SAVINGS_MS = 5_000;

export const TASK_RESULT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "blocked", "failed"] },
    summary: { type: "string", minLength: 1, maxLength: 800 },
    evidence: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 600 },
      maxItems: 6,
    },
    reason: { type: "string", maxLength: 600 },
  },
  required: ["status", "summary", "evidence", "reason"],
  additionalProperties: false,
});

const ALLOWED_AGENTS = new Set(["scout", "researcher", "reviewer", "evidence-auditor", "delegate", "oracle"]);
const TASK_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
const ROLE_TOOLS = Object.freeze({
  scout: ["read", "grep", "find", "ls"],
  delegate: ["read", "grep", "find", "ls"],
  reviewer: ["read", "grep", "find", "ls"],
  oracle: ["read", "grep", "find", "ls"],
  researcher: ["web_search", "web_fetch"],
  "evidence-auditor": ["web_search", "web_fetch"],
});

export function selectReadySubagentTasks(plan, maxTasks = MAX_WAVE_TASKS) {
  if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length) return [];
  if (!Number.isInteger(maxTasks) || maxTasks < 1) throw new Error("maxTasks must be a positive integer.");
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  return plan.tasks.filter((task) => task.status === "pending"
    && task.executor === "subagent"
    && String(task.writeScope ?? "").trim().toLowerCase() === "read-only"
    && typeof task.dispatchReason === "string" && task.dispatchReason.trim().length >= 12
    && (task.dependsOn ?? []).every((dep) => byId.get(dep)?.status === "done"))
    .slice(0, Math.min(MAX_WAVE_TASKS, maxTasks));
}

export function assessWavePolicy(readyTasks, history = [], maxTasks = MAX_WAVE_TASKS) {
  const candidates = Array.isArray(readyTasks) ? readyTasks.filter((task) =>
    task?.status === "pending"
    && task.executor === "subagent"
    && String(task.writeScope ?? "").trim().toLowerCase() === "read-only"
    && typeof task.dispatchReason === "string" && task.dispatchReason.trim().length >= 12
  ) : [];
  const limit = Math.min(MAX_WAVE_TASKS, Math.max(1, Number.isInteger(maxTasks) ? maxTasks : MAX_WAVE_TASKS), candidates.length || 1);
  if (candidates.length <= 1) {
    return { mode: "single", maxTasks: candidates.length, reason: "Only one eligible independent read-only Subagent task is ready.", observedSamples: 0, medianSavingsMs: null };
  }

  const completedHistory = (Array.isArray(history) ? history : [])
    .filter((item) => item?.status === "completed" && Array.isArray(item?.taskIds));
  let trailingSerialSuccesses = 0;
  for (const item of [...completedHistory].reverse()) {
    if (item.taskIds.length !== 1 || (Number.isInteger(item.fallbackCount) && item.fallbackCount > 0)) break;
    trailingSerialSuccesses += 1;
  }

  // A low-savings decision gets a short, reversible serial cooldown. Once two
  // serial attempts succeed, re-probe parallelism and start a fresh measurement
  // window because later nodes may differ in duration or independence.
  let lastSerialPolicyIndex = -1;
  for (let index = completedHistory.length - 1; index >= 0; index -= 1) {
    if (completedHistory[index].policyMode === "serial_short_tasks") {
      lastSerialPolicyIndex = index;
      break;
    }
  }
  const historyAfterSerialPolicy = lastSerialPolicyIndex >= 0
    ? completedHistory.slice(lastSerialPolicyIndex + 1)
    : completedHistory;
  const hasPostCooldownParallelWave = historyAfterSerialPolicy.some((item) => item.taskIds.length >= 2);
  if (lastSerialPolicyIndex >= 0 && !hasPostCooldownParallelWave) {
    const priorMultiWaves = completedHistory.slice(0, lastSerialPolicyIndex).filter((item) => item.taskIds.length >= 2).slice(-3);
    const priorMeasured = priorMultiWaves.filter((item) => item.metricsComplete === true && Number.isFinite(item.estimatedParallelSavingsMs));
    const priorMedian = median(priorMeasured.map((item) => item.estimatedParallelSavingsMs));
    if (trailingSerialSuccesses < 2) {
      return { mode: "serial_short_tasks", maxTasks: 1, reason: `A prior low-savings policy is in its two-wave serial cooldown (${trailingSerialSuccesses}/2 successful single-child waves).`, observedSamples: priorMeasured.length, medianSavingsMs: priorMedian };
    }
    return { mode: "parallel_reprobe", maxTasks: limit, reason: "Two successful single-child waves completed after the low-savings policy; run a bounded parallel probe and start a fresh measurement window because later tasks may differ.", observedSamples: 0, medianSavingsMs: null };
  }

  // Only compare the current measurement window; pre-cooldown waves must not
  // immediately re-lock the scheduler after a successful parallel re-probe.
  const policyHistory = lastSerialPolicyIndex >= 0 ? historyAfterSerialPolicy : completedHistory;
  const recentWaves = policyHistory.filter((item) => item.taskIds.length >= 2).slice(-3);
  const fallbackWaves = recentWaves.filter((item) => Number.isInteger(item.fallbackCount) && item.fallbackCount > 0).length;
  // Repeated fallback triggers a reversible provider-pressure cooldown.
  if (recentWaves.length >= 3 && fallbackWaves >= 2 && trailingSerialSuccesses < 2) {
    return { mode: "provider_cooldown", maxTasks: 1, reason: `At least two of the last three multi-task waves in the current measurement window needed model fallback; serialize until two consecutive single-child waves complete without fallback (currently ${trailingSerialSuccesses}/2).`, observedSamples: recentWaves.length, medianSavingsMs: median(recentWaves.map((item) => item.estimatedParallelSavingsMs).filter(Number.isFinite)) };
  }
  const measured = recentWaves.filter((item) => item.metricsComplete === true && Number.isFinite(item.estimatedParallelSavingsMs));
  if (measured.length >= 3) {
    const medianSavingsMs = median(measured.map((item) => item.estimatedParallelSavingsMs));
    if (medianSavingsMs <= MIN_PARALLEL_SAVINGS_MS) {
      return { mode: "serial_short_tasks", maxTasks: 1, reason: `Median observed wait savings across the last three measured multi-task waves was ${Math.round(medianSavingsMs)}ms, at or below the ${MIN_PARALLEL_SAVINGS_MS}ms coordination threshold; run one child at a time for a short cooldown.`, observedSamples: measured.length, medianSavingsMs };
    }
    return { mode: "parallel_observed_benefit", maxTasks: limit, reason: `Median observed wait savings was ${Math.round(medianSavingsMs)}ms, above the ${MIN_PARALLEL_SAVINGS_MS}ms threshold; parallelize explicitly justified independent tasks within the concurrency cap.`, observedSamples: measured.length, medianSavingsMs };
  }
  return {
    mode: "parallel_cold_start",
    maxTasks: limit,
    reason: "No three-wave comparable history exists. Each child has an explicit separate-context justification; run independent read-only tasks together because serializing the same planned child work does not inherently reduce its token cost, and measure actual cost/latency for future waves.",
    observedSamples: measured.length,
    medianSavingsMs: null,
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function buildTaskPrompt({ goal, task, constraints = [] }) {
  const boundedGoal = String(goal ?? "").trim().slice(0, 2400);
  const boundedConstraints = (Array.isArray(constraints) ? constraints : [])
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, 12)
    .map((item) => item.trim().slice(0, 240));
  return [
    "You are a read-only child agent executing one explicitly assigned Compass DAG task.",
    "Do not edit, write, delete, install, commit, or run commands that mutate files or external state.",
    "Inspect only the assigned scope. Do not expand into unrelated research. Stop when the acceptance condition has enough evidence.",
    "Return the required structured result. Set status=done only when the task acceptance condition is met and evidence contains concrete paths, line references, command output, or authoritative source URLs. Use blocked when a prerequisite, permission, or missing input prevents completion. Use failed only when the assigned work was attempted but could not be completed. Never claim independent verification of the overall Goal.",
    `Current Goal: ${boundedGoal || "Not supplied"}`,
    ...(boundedConstraints.length ? ["Hard Human constraints:", ...boundedConstraints.map((item) => `- ${item}`)] : []),
    `Task ID: ${task.id}`,
    `Why a separate Subagent context is justified: ${String(task.dispatchReason ?? "Not supplied").slice(0, 400)}`,
    `Task: ${String(task.title ?? "").slice(0, 500)}`,
    `Acceptance condition: ${String(task.acceptance ?? "").slice(0, 800)}`,
    `Expected output: ${String(task.output ?? "Not specified").slice(0, 500)}`,
    `Dependencies: ${(Array.isArray(task.dependsOn) ? task.dependsOn : []).join(", ") || "none"}`,
    "Structured result rules: summary is concise; evidence is an array of 1–6 concrete observations for status=done and may be empty otherwise; reason is empty for done and explains the blocker/failure otherwise.",
  ].join("\n");
}

export function buildSubagentDelegationRequest({
  task,
  goal,
  constraints = [],
  cwd,
  ownerRunId,
  requestId,
  model = PRIMARY_MODEL,
  thinking = DEFAULT_THINKING,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!task || !TASK_ID.test(String(task.id ?? ""))) throw new Error("A valid DAG task ID is required.");
  if (!ALLOWED_AGENTS.has(String(task.agent ?? "scout"))) throw new Error(`Unsupported read-only Subagent role: ${task.agent}.`);
  if (String(task.executor) !== "subagent" || String(task.writeScope ?? "").trim().toLowerCase() !== "read-only") {
    throw new Error(`Task ${task.id} is not explicitly routed to a read-only Subagent.`);
  }
  if (!String(cwd ?? "").trim()) throw new Error("A non-empty working directory is required.");
  if (!String(ownerRunId ?? "").trim() || !String(requestId ?? "").trim()) throw new Error("ownerRunId and requestId are required.");
  if (!String(model ?? "").trim()) throw new Error("A model ID is required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be a positive safe integer.");

  return {
    requestId,
    ownerRunId,
    nodeId: task.id,
    agent: task.agent || "scout",
    task: buildTaskPrompt({ goal, task, constraints }),
    context: "fresh",
    cwd,
    model,
    thinking,
    timeoutMs,
    // This is a read-only investigation budget, not a write-safety boundary.
    // Actual tool access must be restricted by the configured agent profile.
    toolBudget: { soft: 18, hard: 28, block: [...(ROLE_TOOLS[task.agent || "scout"] ?? ROLE_TOOLS.scout)] },
    result: { kind: "structured", schema: TASK_RESULT_SCHEMA },
  };
}

function boundedString(value, max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Unknown is not zero. Keeping absent provider metrics as null prevents the
  // cost report and adaptive scheduler from treating missing usage as free work.
  const number = (key) => Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : null;
  return {
    input: number("input"),
    output: number("output"),
    cacheRead: number("cacheRead"),
    cacheWrite: number("cacheWrite"),
    cost: number("cost"),
    turns: number("turns"),
    toolCalls: number("toolCalls"),
    durationMs: number("durationMs"),
  };
}

export function normalizeProviderDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowedKinds = new Set(["rate_limited", "transient_other", "unknown"]);
  const rawLast = value.lastError && typeof value.lastError === "object" ? value.lastError : null;
  const lastError = rawLast && allowedKinds.has(rawLast.kind) ? {
    kind: rawLast.kind,
    message: boundedString(rawLast.message, 160),
    at: Number.isFinite(rawLast.at) && rawLast.at >= 0 ? rawLast.at : null,
  } : null;
  const rawRetry = value.retry && typeof value.retry === "object" ? value.retry : null;
  const retry = rawRetry && ["backoff", "in_flight"].includes(rawRetry.phase) ? {
    phase: rawRetry.phase,
    attempt: Number.isSafeInteger(rawRetry.attempt) && rawRetry.attempt >= 0 ? rawRetry.attempt : null,
    maxAttempts: Number.isSafeInteger(rawRetry.maxAttempts) && rawRetry.maxAttempts >= 0 ? rawRetry.maxAttempts : null,
    delayMs: Number.isFinite(rawRetry.delayMs) && rawRetry.delayMs >= 0 ? rawRetry.delayMs : null,
    scheduledAt: Number.isFinite(rawRetry.scheduledAt) && rawRetry.scheduledAt >= 0 ? rawRetry.scheduledAt : null,
  } : null;
  return {
    errorCount: Number.isSafeInteger(value.errorCount) && value.errorCount >= 0 ? value.errorCount : null,
    lastError,
    retry,
  };
}

export function hasCompleteUsageMetrics(value) {
  return Boolean(value && typeof value === "object" && ["input", "output", "cost", "toolCalls", "durationMs"].every((key) => Number.isFinite(value[key]) && value[key] >= 0));
}

export function parseSubagentDelegationResponse(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof expected.requestId === "string" && value.requestId !== expected.requestId) return null;
  if (typeof expected.ownerRunId === "string" && value.ownerRunId !== expected.ownerRunId) return null;
  if (typeof expected.nodeId === "string" && value.nodeId !== expected.nodeId) return null;

  const status = boundedString(value.status, 40);
  const error = boundedString(value.error, 600);
  const model = boundedString(value.model, 160) || boundedString(expected.model, 160) || "unknown";
  const progress = value.__compassProgress && typeof value.__compassProgress === "object" ? value.__compassProgress : null;
  const observedTools = Array.isArray(progress?.tools)
    ? [...new Set(progress.tools.filter((item) => typeof item === "string" && item.trim()).slice(0, 12).map((item) => item.trim().slice(0, 80)))]
    : [];
  const common = {
    id: boundedString(value.nodeId || expected.nodeId, 40),
    requestId: boundedString(value.requestId, 128),
    ownerRunId: boundedString(value.ownerRunId, 128),
    runId: boundedString(value.runId, 128) || null,
    model,
    usage: normalizeUsage(value.usage),
    providerDiagnostics: normalizeProviderDiagnostics(value.providerDiagnostics),
    observedToolCount: Number.isFinite(progress?.toolCount) && progress.toolCount >= 0 ? progress.toolCount : null,
    observedTools,
    error,
  };
  if (!["completed", "failed", "timed_out", "cancelled", "interrupted", "tool_budget_exhausted", "structured_output_failed", "acceptance_failed", "invalid_request", "unavailable_context", "duplicate_node"].includes(status)) return null;

  if (status !== "completed") {
    return {
      ...common,
      status: "blocked",
      summary: "",
      evidence: [],
      reason: error || `Subagent terminated with status ${status}.`,
      terminalStatus: status,
    };
  }

  const result = value.result;
  if (result?.kind !== "structured" || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) {
    return {
      ...common,
      status: "blocked",
      summary: "",
      evidence: [],
      reason: "Subagent completed without the required structured result.",
      terminalStatus: "structured_output_failed",
    };
  }
  const payload = result.value;
  const taskStatus = boundedString(payload.status, 40);
  const summary = boundedString(payload.summary, 800);
  const evidence = Array.isArray(payload.evidence)
    ? payload.evidence.filter((item) => typeof item === "string" && item.trim()).slice(0, 6).map((item) => item.trim().slice(0, 600))
    : [];
  const reason = boundedString(payload.reason, 600);
  if (!["done", "blocked", "failed"].includes(taskStatus) || !summary) {
    return {
      ...common,
      status: "blocked",
      summary,
      evidence,
      reason: "Structured result is missing a valid status or summary.",
      terminalStatus: "structured_output_failed",
    };
  }
  if (taskStatus === "done" && evidence.length === 0) {
    return {
      ...common,
      status: "blocked",
      summary,
      evidence: [],
      reason: "Subagent reported done without concrete evidence; task was not auto-completed.",
      terminalStatus: "structured_output_failed",
    };
  }
  if (taskStatus !== "done" && !reason) {
    return {
      ...common,
      status: "blocked",
      summary,
      evidence,
      reason: "Subagent reported a blocker/failure without explaining it.",
      terminalStatus: "structured_output_failed",
    };
  }
  return {
    ...common,
    status: taskStatus,
    summary,
    evidence,
    reason,
    terminalStatus: status,
  };
}

export function providerFallbackReason(response) {
  if (!response || response.status !== "failed") return null;
  const text = `${response.error ?? ""} ${response.message ?? ""}`;
  // Never retry a child/task deadline or ambiguous transport timeout: the caller
  // must not mistake an unknown execution outcome for a provider quota failure.
  if (/(?:child|subagent|workflow|task|run).{0,20}(?:deadline|timed? out|timeout)|\bETIMEDOUT\b|\bECONNRESET\b/i.test(text)) return null;

  // Explicit account exhaustion is a distinct fallback reason. The upstream
  // diagnostic intentionally labels it unknown rather than rate_limited; Compass
  // still uses the user's explicitly requested DeepSeek backup for clear quota
  // exhaustion, but does not treat a bare mention of "quota" or "billing" as proof.
  if (/(?:insufficient(?:[_\s-]+)?quota|quota.{0,30}(?:exhausted|exceeded|depleted|empty|not available|ran out|run out)|(?:no|not enough|out of|exhausted|depleted).{0,24}(?:quota|credits?|credit balance)|(?:credits?|credit balance).{0,30}(?:exhausted|depleted|empty|insufficient)|usage limit.{0,30}(?:exceeded|exhausted)|billing.{0,30}(?:disabled|inactive|exhausted|payment required))/i.test(text)) {
    return "primary_account_quota_exhausted";
  }

  const diagnosticKind = response.providerDiagnostics?.lastError?.kind;
  if (diagnosticKind === "rate_limited") return "primary_provider_rate_limited";
  if (diagnosticKind === "transient_other") return "primary_provider_transient_error";
  if (/(?:\b429\b|too many requests|rate.?limit|\b502\b|\b503\b|\b504\b|provider.{0,30}(?:unavailable|overload)|model.{0,30}(?:unavailable|not found))/i.test(text)) {
    return "primary_provider_unavailable";
  }
  return null;
}

export function isRetryableProviderFailure(response) {
  return providerFallbackReason(response) !== null;
}
