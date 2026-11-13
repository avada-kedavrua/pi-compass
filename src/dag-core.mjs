import { createHash } from "node:crypto";

const TASK_STATUSES = new Set(["pending", "in_progress", "done", "blocked"]);
const MAX_PLAN_HISTORY = 8;
const MAX_DECISIONS = 8;
const MAX_CHECKPOINTS = 5;
const MAX_ACTIVITY = 8;
const ALLOWED_EXECUTORS = new Set(["parent", "code", "subagent"]);
const ALLOWED_AGENTS = new Set(["scout", "researcher", "reviewer", "evidence-auditor", "delegate", "oracle"]);

export function emptyDagState() {
  return {
    goal: null,
    acceptanceCriteria: [],
    tasks: [],
    revision: 0,
    stateVersion: 0,
    planHistory: [],
    decisions: [],
    checkpoints: [],
    activity: [],
    executionHistory: [],
    approvalRequest: null,
    approval: null,
    nextDecisionNumber: 1,
    nextCheckpointNumber: 1,
  };
}

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clipped(value, max = 240) {
  const normalized = optionalText(value);
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function now() {
  return new Date().toISOString();
}

function withStateDefaults(state) {
  const source = state && typeof state === "object" ? state : {};
  return {
    ...emptyDagState(),
    ...source,
    acceptanceCriteria: Array.isArray(source.acceptanceCriteria) ? source.acceptanceCriteria : [],
    tasks: Array.isArray(source.tasks) ? source.tasks : [],
    stateVersion: Number.isInteger(source.stateVersion) ? source.stateVersion : 0,
    planHistory: Array.isArray(source.planHistory) ? source.planHistory : [],
    decisions: Array.isArray(source.decisions) ? source.decisions : [],
    checkpoints: Array.isArray(source.checkpoints) ? source.checkpoints : [],
    activity: Array.isArray(source.activity) ? source.activity : [],
    executionHistory: Array.isArray(source.executionHistory) ? source.executionHistory.slice(-8) : [],
    nextDecisionNumber: Number.isInteger(source.nextDecisionNumber) ? source.nextDecisionNumber : 1,
    nextCheckpointNumber: Number.isInteger(source.nextCheckpointNumber) ? source.nextCheckpointNumber : 1,
  };
}

function normalizeTask(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`tasks[${index}] must be an object.`);
  }
  const id = text(raw.id, `tasks[${index}].id`);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(id)) {
    throw new Error(`Task id "${id}" must start with a letter and contain only letters, digits, _ or - (max 40 chars).`);
  }
  const title = text(raw.title, `tasks[${index}].title`);
  const acceptance = text(raw.acceptance, `tasks[${index}].acceptance`);
  const dependsOn = raw.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.some((dep) => typeof dep !== "string" || dep.trim() === "")) {
    throw new Error(`tasks[${index}].dependsOn must be an array of task ids.`);
  }
  const normalizedDeps = [...new Set(dependsOn.map((dep) => dep.trim()))];
  const executor = raw.executor === undefined ? "parent" : raw.executor;
  if (!ALLOWED_EXECUTORS.has(executor)) {
    throw new Error(`tasks[${index}].executor must be one of: ${[...ALLOWED_EXECUTORS].join(", ")}.`);
  }
  const agent = raw.agent === undefined ? "scout" : raw.agent;
  if (!ALLOWED_AGENTS.has(agent)) {
    throw new Error(`tasks[${index}].agent must be one of: ${[...ALLOWED_AGENTS].join(", ")}.`);
  }
  const writeScope = typeof raw.writeScope === "string" ? raw.writeScope.trim() : "";
  const dispatchReason = clipped(raw.dispatchReason, 400);
  if (executor === "subagent" && writeScope.toLowerCase() !== "read-only") {
    throw new Error(`Task "${id}" uses executor=subagent and must set writeScope="read-only".`);
  }
  if (executor === "subagent" && dispatchReason.length < 12) {
    throw new Error(`Task "${id}" uses executor=subagent and must provide dispatchReason explaining why a separate semantic context is worth the added model call; otherwise choose parent or code.`);
  }
  return {
    id,
    title,
    dependsOn: normalizedDeps,
    acceptance,
    output: typeof raw.output === "string" ? raw.output.trim() : "",
    writeScope,
    executor,
    agent,
    dispatchReason,
    status: "pending",
    evidence: "",
    reason: "",
    assessment: null,
  };
}

function assertAcyclic(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  const children = new Map(tasks.map((task) => [task.id, []]));

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) throw new Error(`Task "${task.id}" cannot depend on itself.`);
      if (!byId.has(dep)) throw new Error(`Task "${task.id}" depends on unknown task "${dep}".`);
      indegree.set(task.id, indegree.get(task.id) + 1);
      children.get(dep).push(task.id);
    }
  }

  const queue = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited += 1;
    for (const child of children.get(id)) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  if (visited !== tasks.length) throw new Error("The task graph contains a dependency cycle.");
}

function taskSignature(task) {
  return JSON.stringify({
    title: task.title,
    dependsOn: [...(task.dependsOn ?? [])].sort(),
    acceptance: task.acceptance,
    output: task.output ?? "",
    writeScope: task.writeScope ?? "",
    executor: ALLOWED_EXECUTORS.has(task.executor) ? task.executor : "parent",
    agent: task.executor === "subagent" && ALLOWED_AGENTS.has(task.agent) ? task.agent : "",
    dispatchReason: task.executor === "subagent" ? (task.dispatchReason ?? "") : "",
  });
}

function planDelta(previous, goal, acceptanceCriteria, tasks) {
  const oldById = new Map((previous?.tasks ?? []).map((task) => [task.id, task]));
  const nextById = new Map(tasks.map((task) => [task.id, task]));
  const added = tasks.filter((task) => !oldById.has(task.id)).map((task) => task.id);
  const removed = [...oldById.keys()].filter((id) => !nextById.has(id));
  const changed = tasks.filter((task) => oldById.has(task.id) && taskSignature(oldById.get(task.id)) !== taskSignature(task)).map((task) => task.id);
  const goalChanged = Boolean(previous?.goal) && previous.goal !== goal;
  const acceptanceChanged = Boolean(previous?.goal) && JSON.stringify(previous?.acceptanceCriteria ?? []) !== JSON.stringify(acceptanceCriteria);
  return {
    goalChanged,
    acceptanceChanged,
    added,
    removed,
    changed,
    material: !previous?.goal || goalChanged || acceptanceChanged || added.length > 0 || removed.length > 0 || changed.length > 0,
  };
}

function planDeltaSummary(delta) {
  const parts = [];
  if (delta.goalChanged) parts.push("Goal changed");
  if (delta.acceptanceChanged) parts.push("acceptance criteria changed");
  if (delta.added.length) parts.push(`added ${delta.added.join(", ")}`);
  if (delta.changed.length) parts.push(`changed ${delta.changed.join(", ")}`);
  if (delta.removed.length) parts.push(`removed ${delta.removed.join(", ")}`);
  return parts.length ? parts.join("; ") : "no material definition changes";
}

export function createOrRevisePlan(currentState, input) {
  const previous = withStateDefaults(currentState);
  const goal = text(input.goal, "goal");
  if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length === 0) {
    throw new Error("acceptanceCriteria must contain at least one concrete acceptance criterion.");
  }
  const acceptanceCriteria = input.acceptanceCriteria.map((item, index) => text(item, `acceptanceCriteria[${index}]`));
  if (!Array.isArray(input.tasks) || input.tasks.length < 2) {
    throw new Error("Use a DAG only when it is useful: provide at least two tasks with meaningful dependencies or independent work.");
  }

  const tasks = input.tasks.map(normalizeTask);
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id "${task.id}".`);
    ids.add(task.id);
  }
  assertAcyclic(tasks);
  const delta = planDelta(previous, goal, acceptanceCriteria, tasks);

  // The Goal is the boundary for carrying task evidence and continuity history forward.
  // A different Goal starts a fresh continuity record; prior-goal decisions are not injected.
  const sameGoal = previous.goal === goal;
  const oldById = new Map((sameGoal ? previous.tasks : []).map((task) => [task.id, task]));
  const preservedTasks = tasks.map((task) => {
    const old = oldById.get(task.id);
    if (sameGoal && old && taskSignature(old) === taskSignature(task)) {
      return { ...task, status: old.status, evidence: old.evidence ?? "", reason: old.reason ?? "", assessment: old.assessment ?? null };
    }
    if (old && (old.status !== "pending" || old.evidence || old.reason)) {
      return { ...task, reason: "Reset because this task's definition or dependencies changed during replanning." };
    }
    return task;
  });

  // If a prerequisite is no longer complete, its completed descendants are stale too.
  const preservedById = new Map(preservedTasks.map((task) => [task.id, task]));
  let invalidated;
  do {
    invalidated = false;
    for (const task of preservedTasks) {
      if ((task.status === "done" || task.status === "in_progress")
        && task.dependsOn.some((dep) => preservedById.get(dep)?.status !== "done")) {
        task.status = "pending";
        task.evidence = "";
        task.reason = "Invalidated because a prerequisite changed during replanning.";
        invalidated = true;
      }
    }
  } while (invalidated);

  const changedGoal = Boolean(previous.goal) && previous.goal !== goal;
  // A revision identifies a material change within this Goal, not another plan() call.
  const revision = changedGoal ? 1 : previous.revision + (delta.material ? 1 : 0);
  const baseHistory = changedGoal ? [] : previous.planHistory;
  const baseDecisions = changedGoal ? [] : previous.decisions;
  const baseCheckpoints = changedGoal ? [] : previous.checkpoints;
  const baseActivity = changedGoal ? [] : previous.activity;
  const changeReason = clipped(input.changeReason, 500);
  let planHistory = baseHistory;
  if (delta.material) {
    planHistory = [...baseHistory, {
      revision,
      at: now(),
      summary: planDeltaSummary(delta),
      reason: changeReason || (previous.goal && !changedGoal ? "Not recorded" : changedGoal ? "New Goal" : "Initial plan created"),
      reasonMissing: Boolean(previous.goal && !changedGoal && !changeReason),
      added: delta.added.slice(0, 12),
      changed: delta.changed.slice(0, 12),
      removed: delta.removed.slice(0, 12),
      acceptanceChanged: delta.acceptanceChanged,
      goalChanged: delta.goalChanged,
    }].slice(-MAX_PLAN_HISTORY);
  }

  return {
    ...previous,
    goal,
    acceptanceCriteria,
    tasks: preservedTasks,
    revision,
    stateVersion: previous.stateVersion + (delta.material ? 1 : 0),
    planHistory,
    decisions: baseDecisions,
    checkpoints: baseCheckpoints,
    activity: baseActivity,
    executionHistory: changedGoal ? [] : (previous.executionHistory ?? []).slice(-8),
    nextDecisionNumber: changedGoal ? 1 : previous.nextDecisionNumber,
    nextCheckpointNumber: changedGoal ? 1 : previous.nextCheckpointNumber,
  };
}

export function taskAssessmentBinding(plan, task) {
  return createHash("sha256").update(JSON.stringify({
    goal: plan?.goal ?? null,
    acceptanceCriteria: plan?.acceptanceCriteria ?? [],
    task: taskSignature(task),
  })).digest("hex");
}

export function taskAssessmentIsCurrent(plan, task) {
  return task?.assessment?.binding === taskAssessmentBinding(plan, task);
}

export function readyTasks(state) {
  const byId = new Map((state?.tasks ?? []).map((task) => [task.id, task]));
  return (state?.tasks ?? []).filter((task) => task.status === "pending"
    && task.dependsOn.every((dep) => {
      const prerequisite = byId.get(dep);
      return prerequisite?.status === "done" && prerequisite.assessment?.status === "pass"
        && taskAssessmentIsCurrent(state, prerequisite);
    }));
}

export function updateTasks(state, updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error("updates must contain at least one task update.");
  }
  const next = withStateDefaults(state);
  next.tasks = structuredClone(next.tasks);
  const byId = new Map(next.tasks.map((task) => [task.id, task]));
  const seen = new Set();
  const activityItems = [];

  for (const [index, update] of updates.entries()) {
    if (!update || typeof update !== "object" || Array.isArray(update)) {
      throw new Error(`updates[${index}] must be an object.`);
    }
    const id = text(update.id, `updates[${index}].id`);
    if (seen.has(id)) throw new Error(`Task "${id}" appears more than once in updates.`);
    seen.add(id);
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown task id "${id}".`);
    if (!TASK_STATUSES.has(update.status)) {
      throw new Error(`Invalid status for "${id}". Use pending, in_progress, done, or blocked.`);
    }
    if (update.status === "done" && (typeof update.evidence !== "string" || update.evidence.trim() === "")) {
      throw new Error(`Task "${id}" cannot be marked done without concrete evidence.`);
    }
    const before = { status: task.status, evidence: task.evidence ?? "", reason: task.reason ?? "" };
    task.status = update.status;
    if (update.status === "pending") task.assessment = null;
    if (update.status === "done") {
      task.evidence = update.evidence.trim();
      task.reason = "";
    } else if (update.status === "blocked") {
      task.reason = typeof update.reason === "string" ? update.reason.trim() : "";
      task.evidence = typeof update.evidence === "string" ? update.evidence.trim() : "";
    } else if (update.status === "pending") {
      task.evidence = "";
      task.reason = "";
    } else {
      task.evidence = "";
      task.reason = "";
    }
    if (before.status !== task.status || before.evidence !== task.evidence || before.reason !== task.reason) {
      activityItems.push({
        id,
        from: before.status,
        to: task.status,
        evidence: clipped(task.evidence, 180),
        reason: clipped(task.reason, 180),
      });
    }
  }

  for (const task of next.tasks) {
    if (task.status === "done" || task.status === "in_progress") {
      const unfinished = task.dependsOn.filter((dep) => {
        const prerequisite = byId.get(dep);
        return prerequisite?.status !== "done" || prerequisite.assessment?.status !== "pass"
          || !taskAssessmentIsCurrent(next, prerequisite);
      });
      if (unfinished.length > 0) {
        throw new Error(`Task "${task.id}" cannot be ${task.status} until dependencies are done: ${unfinished.join(", ")}. Revise the DAG if this dependency is no longer valid.`);
      }
    }
  }

  if (activityItems.length) {
    next.stateVersion = (Number.isInteger(next.stateVersion) ? next.stateVersion : 0) + 1;
    next.activity = [...next.activity, {
      at: now(),
      changes: activityItems.slice(0, 12),
      omittedCount: Math.max(0, activityItems.length - 12),
    }].slice(-MAX_ACTIVITY);
  }
  return next;
}

export function recordContinuityNote(state, input) {
  const next = withStateDefaults(state);
  if (!next.goal) throw new Error("Create a Goal DAG before recording a decision or checkpoint.");
  const kind = input.kind;
  if (kind !== "decision" && kind !== "checkpoint") {
    throw new Error('kind must be "decision" or "checkpoint".');
  }
  const summary = clipped(text(input.summary, "summary"), 400);
  const rationale = clipped(input.rationale, 500);
  const evidence = clipped(input.evidence, 500);
  const ref = clipped(input.ref, 300);
  const affectedTasks = input.affectedTasks ?? [];
  if (!Array.isArray(affectedTasks) || affectedTasks.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("affectedTasks must be an array of task ids.");
  }
  const knownIds = new Set(next.tasks.map((task) => task.id));
  const normalizedAffected = [...new Set(affectedTasks.map((id) => id.trim()))];
  const unknown = normalizedAffected.filter((id) => !knownIds.has(id));
  if (unknown.length) throw new Error(`Unknown affected task ids: ${unknown.join(", ")}.`);

  if (kind === "decision") {
    const id = `D${next.nextDecisionNumber}`;
    next.nextDecisionNumber += 1;
    next.decisions = [...next.decisions, {
      id,
      at: now(),
      summary,
      rationale,
      evidence,
      affectedTasks: normalizedAffected,
    }].slice(-MAX_DECISIONS);
    return {
      state: next,
      message: `Recorded ${id}: ${summary}${rationale ? `\nRationale: ${clipped(rationale, 260)}` : "\nRationale not recorded."}${evidence ? `\nEvidence: ${clipped(evidence, 260)}` : ""}`,
    };
  }

  const id = `C${next.nextCheckpointNumber}`;
  next.nextCheckpointNumber += 1;
  next.checkpoints = [...next.checkpoints, {
    id,
    at: now(),
    summary,
    ref,
    evidence,
    affectedTasks: normalizedAffected,
  }].slice(-MAX_CHECKPOINTS);
  return {
    state: next,
    message: `Recorded checkpoint ${id}: ${summary}${ref ? `\nReference: ${ref}` : "\nNo recoverable code reference supplied; this is a planning marker, not a rollback point."}${evidence ? `\nEvidence: ${clipped(evidence, 260)}` : ""}`,
  };
}

function compactTask(task, includeEvidence = false) {
  let line = `${task.id} (${task.status}): ${task.title}`;
  if (task.reason) line += ` — reason: ${clipped(task.reason, 160)}`;
  if (includeEvidence && task.evidence) line += ` — evidence: ${clipped(task.evidence, 180)}`;
  return line;
}

export function buildContinuityContext(state) {
  const current = withStateDefaults(state);
  if (!current.goal || current.tasks.length === 0) return "";

  const ready = readyTasks(current);
  const inProgress = current.tasks.filter((task) => task.status === "in_progress");
  const blocked = current.tasks.filter((task) => task.status === "blocked");
  const doneCount = current.tasks.filter((task) => task.status === "done").length;
  const lines = [
    "[Compass continuity snapshot — current branch state; compact index, not a new Goal]",
    `Goal: ${clipped(current.goal, 900)}`,
    `Plan revision: ${current.revision}; progress: ${doneCount}/${current.tasks.length} tasks done.`,
  ];

  if (current.acceptanceCriteria.length) {
    lines.push("Acceptance:");
    for (const criterion of current.acceptanceCriteria.slice(0, 3)) lines.push(`- ${clipped(criterion, 150)}`);
    if (current.acceptanceCriteria.length > 3) lines.push(`- … ${current.acceptanceCriteria.length - 3} more in the planning capability details.`);
  }
  if (inProgress.length) lines.push(`In progress: ${inProgress.slice(0, 3).map((task) => compactTask(task)).join("; ")}`);
  if (ready.length) lines.push(`Ready: ${ready.slice(0, 4).map((task) => `${task.id}: ${clipped(task.title, 80)}`).join("; ")}`);
  if (blocked.length) lines.push(`Blocked: ${blocked.slice(0, 2).map((task) => compactTask(task)).join("; ")}`);
  if (!inProgress.length && !ready.length && !blocked.length && doneCount === current.tasks.length) lines.push("DAG tasks are all marked done; check the original Goal acceptance before claiming overall completion.");

  const recentPlanChanges = current.planHistory.slice(-1).reverse();
  if (recentPlanChanges.length) {
    lines.push("Recent plan changes:");
    for (const change of recentPlanChanges) {
      lines.push(`- r${change.revision} (${change.at}): ${clipped(change.summary, 220)}; why: ${clipped(change.reason || "not recorded", 220)}${change.reasonMissing ? " [reason missing]" : ""}`);
    }
  }
  const recentDecisions = current.decisions.slice(-2).reverse();
  if (recentDecisions.length) {
    lines.push("Recent material decisions:");
    for (const decision of recentDecisions) {
      const affected = decision.affectedTasks?.length ? `; tasks: ${decision.affectedTasks.join(", ")}` : "";
      lines.push(`- ${decision.id} (${decision.at}): ${clipped(decision.summary, 180)}; why: ${clipped(decision.rationale || "not recorded", 160)}; evidence: ${clipped(decision.evidence || "not recorded", 160)}${affected}`);
    }
  }
  const recentCheckpoints = current.checkpoints.slice(-1).reverse();
  if (recentCheckpoints.length) {
    lines.push("Recent checkpoints (references only; Compass does not roll code back):");
    for (const checkpoint of recentCheckpoints) {
      lines.push(`- ${checkpoint.id} (${checkpoint.at}): ${clipped(checkpoint.summary, 180)}; ref: ${clipped(checkpoint.ref || "none — not directly recoverable", 180)}; evidence: ${clipped(checkpoint.evidence || "not recorded", 140)}`);
    }
  }
  const recentActivity = current.activity.slice(-1).reverse();
  if (recentActivity.length) {
    lines.push("Recent task-state changes:");
    for (const activity of recentActivity) {
      const changes = (activity.changes ?? []).slice(0, 5).map((change) => `${change.id} ${change.from}→${change.to}${change.reason ? ` (${clipped(change.reason, 90)})` : change.from === change.to && change.evidence ? ` [evidence: ${clipped(change.evidence, 90)}]` : ""}`).join("; ");
      lines.push(`- ${activity.at}: ${changes || "state updated"}`);
    }
  }

  lines.push("Continuity check for a material new issue: compare it with the original Goal, current plan, and recent decisions/changes. Ask whether it is already planned, whether a recent decision or edit introduced it, and whether to continue, make a local fix, replan, or return to a genuinely recoverable checkpoint. Preserve unaffected completed work. Ask Human only for unresolved material intent/permission/trade-offs. This is reasoning guidance, not a mandatory extra tool call.");
  const result = lines.join("\n");
  const maxChars = 3600;
  return result.length > maxChars ? `${result.slice(0, maxChars - 70)}\n[Older/less relevant continuity details omitted; open planning capability for details if needed.]` : result;
}

export function summarizeDag(state) {
  const current = withStateDefaults(state);
  if (!current.goal) return "No Compass DAG exists in this session.";
  const lines = [
    `Goal: ${current.goal}`,
    `Revision: ${current.revision}`,
    "Acceptance:",
    ...current.acceptanceCriteria.map((item) => `- ${item}`),
    "Tasks:",
  ];
  for (const task of current.tasks) {
    const deps = task.dependsOn.length ? ` <- ${task.dependsOn.join(", ")}` : "";
    lines.push(`- [${task.status}] ${task.id}: ${task.title}${deps}`);
    if (task.writeScope) lines.push(`  Write scope: ${task.writeScope}`);
    if (task.evidence) lines.push(`  Evidence: ${task.evidence}`);
    if (task.reason) lines.push(`  Reason: ${task.reason}`);
  }
  const ready = readyTasks(current);
  lines.push(`Ready now: ${ready.length ? ready.map((task) => task.id).join(", ") : "none"}`);

  for (const change of current.planHistory.slice(-3)) {
    lines.push(`Plan change r${change.revision} (${change.at}): ${clipped(change.summary, 260)}; why: ${clipped(change.reason, 300)}${change.reasonMissing ? " [reason missing]" : ""}`);
  }
  for (const decision of current.decisions.slice(-3)) {
    lines.push(`Decision ${decision.id} (${decision.at}): ${clipped(decision.summary, 260)}${decision.rationale ? `; why: ${clipped(decision.rationale, 300)}` : "; rationale not recorded"}${decision.evidence ? `; evidence: ${clipped(decision.evidence, 300)}` : ""}`);
  }
  for (const checkpoint of current.checkpoints.slice(-2)) {
    lines.push(`Checkpoint ${checkpoint.id} (${checkpoint.at}): ${clipped(checkpoint.summary, 260)}; ref: ${clipped(checkpoint.ref || "none — not directly recoverable", 220)}${checkpoint.evidence ? `; evidence: ${clipped(checkpoint.evidence, 260)}` : ""}`);
  }
  for (const activity of current.activity.slice(-2)) {
    const changes = (activity.changes ?? []).map((change) => `${change.id} ${change.from}→${change.to}`).join("; ");
    lines.push(`Recent task activity (${activity.at}): ${changes}${activity.omittedCount ? `; ${activity.omittedCount} more state changes omitted` : ""}`);
  }
  return lines.join("\n");
}
