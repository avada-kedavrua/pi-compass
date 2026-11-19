import { createHash } from "node:crypto";

const TASK_STATUSES = new Set(["pending", "in_progress", "done", "blocked"]);
const MAX_PLAN_HISTORY = 8;
const MAX_ACTIVITY = 8;
const ALLOWED_EXECUTORS = new Set(["parent", "code", "subagent"]);
const ALLOWED_AGENTS = new Set(["scout", "researcher", "reviewer", "evidence-auditor", "delegate", "oracle"]);

export function emptyDagState() {
  return {
    goal: null,
    tasks: [],
    revision: 0,
    stateVersion: 0,
    planHistory: [],
    activity: [],
    executionHistory: [],
    executions: [],
    executionDrift: null,
    stopped: null,
    approvalRequest: null,
    approval: null,
  };
}

export function executionUnresolved(record) {
  return ["dispatching", "running", "unknown"].includes(record?.status);
}

// Unresolved attempts are never evicted. Completion metrics have a separate bounded history.
export function retainExecutions(records) {
  const latestTerminal = records.findLast((record) => !executionUnresolved(record));
  return records.filter((record) => executionUnresolved(record) || record === latestTerminal);
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
    tasks: Array.isArray(source.tasks) ? source.tasks : [],
    stateVersion: Number.isInteger(source.stateVersion) ? source.stateVersion : 0,
    planHistory: Array.isArray(source.planHistory) ? source.planHistory : [],
    activity: Array.isArray(source.activity) ? source.activity : [],
    executionHistory: Array.isArray(source.executionHistory) ? source.executionHistory.slice(-8) : [],
  };
}

export function taskDependencies(task) {
  return [...new Set([...(task.dependsOn ?? []), ...(task.fromTasks ?? [])])];
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
  const fromTasks = raw.fromTasks ?? [];
  const inputRefs = raw.inputRefs ?? [];
  for (const list of [fromTasks, inputRefs]) {
    if (!Array.isArray(list) || list.length > 8 || list.some((item) => typeof item !== "string" || !item.trim()) || new Set(list).size !== list.length) throw new Error(`Task ${id} has invalid or duplicate artifact inputs.`);
  }
  const executor = raw.executor === undefined ? "parent" : raw.executor;
  if (!ALLOWED_EXECUTORS.has(executor)) {
    throw new Error(`tasks[${index}].executor must be one of: ${[...ALLOWED_EXECUTORS].join(", ")}.`);
  }
  if (executor !== "parent" && (fromTasks.length || inputRefs.length)) throw new Error(`Task ${id}: artifact inputs currently require a same-session parent node.`);
  const agent = raw.agent === undefined ? "scout" : raw.agent;
  if (!ALLOWED_AGENTS.has(agent)) {
    throw new Error(`tasks[${index}].agent must be one of: ${[...ALLOWED_AGENTS].join(", ")}.`);
  }
  const writeScope = typeof raw.writeScope === "string" ? raw.writeScope.trim() : "";
  const dispatchReason = clipped(raw.dispatchReason, 400);
  const frameScope = optionalText(raw.frameScope);
  if (frameScope.length > 64) throw new Error(`Task "${id}" frameScope must be at most 64 characters.`);
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
    ...(fromTasks.length ? { fromTasks } : {}), ...(inputRefs.length ? { inputRefs } : {}),
    acceptance,
    output: typeof raw.output === "string" ? raw.output.trim() : "",
    writeScope,
    executor,
    agent,
    dispatchReason,
    ...(frameScope ? { frameScope } : {}),
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
    for (const dep of taskDependencies(task)) {
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
    fromTasks: task.fromTasks ?? [], inputRefs: task.inputRefs ?? [],
    acceptance: task.acceptance,
    output: task.output ?? "",
    writeScope: task.writeScope ?? "",
    executor: ALLOWED_EXECUTORS.has(task.executor) ? task.executor : "parent",
    agent: task.executor === "subagent" && ALLOWED_AGENTS.has(task.agent) ? task.agent : "",
    dispatchReason: task.executor === "subagent" ? (task.dispatchReason ?? "") : "",
    frameScope: task.frameScope ?? "",
  });
}

function planDelta(previous, goal, definitionKey, tasks) {
  const oldById = new Map((previous?.tasks ?? []).map((task) => [task.id, task]));
  const nextById = new Map(tasks.map((task) => [task.id, task]));
  const added = tasks.filter((task) => !oldById.has(task.id)).map((task) => task.id);
  const removed = [...oldById.keys()].filter((id) => !nextById.has(id));
  const changed = tasks.filter((task) => oldById.has(task.id) && taskSignature(oldById.get(task.id)) !== taskSignature(task)).map((task) => task.id);
  const goalChanged = Boolean(previous?.goal) && previous.goal !== goal;
  const acceptanceChanged = Boolean(previous?.goal) && previous?.definitionKey !== definitionKey;
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
  const definitionKey = text(input.definitionKey, "definitionKey");
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
  const delta = planDelta(previous, goal, definitionKey, tasks);

  // Task evidence belongs to this Goal; a replacement Goal starts fresh.
  const sameGoal = previous.goal === goal;
  const oldById = new Map((sameGoal ? previous.tasks : []).map((task) => [task.id, task]));
  const preservedTasks = tasks.map((task) => {
    const old = oldById.get(task.id);
    if (sameGoal && old && taskSignature(old) === taskSignature(task)) {
      return { ...task, status: old.status, evidence: old.evidence ?? "", reason: old.reason ?? "", assessment: old.assessment ?? null, ...(old.artifacts?.length ? { artifacts: old.artifacts } : {}) };
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
        && taskDependencies(task).some((dep) => preservedById.get(dep)?.status !== "done")) {
        task.status = "pending";
        task.evidence = "";
        task.assessment = null;
        delete task.artifacts;
        task.reason = "Invalidated because a prerequisite changed during replanning.";
        invalidated = true;
      }
    }
  } while (invalidated);

  const changedGoal = Boolean(previous.goal) && previous.goal !== goal;
  // A revision identifies a material change within this Goal, not another plan() call.
  const revision = changedGoal ? 1 : previous.revision + (delta.material ? 1 : 0);
  const baseHistory = changedGoal ? [] : previous.planHistory;
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
    definitionKey,
    tasks: preservedTasks,
    revision,
    stateVersion: previous.stateVersion + (delta.material ? 1 : 0),
    planHistory,
    activity: baseActivity,
    executionHistory: changedGoal ? [] : (previous.executionHistory ?? []).slice(-8),
  };
}

export function taskAssessmentBinding(plan, task) {
  return createHash("sha256").update(JSON.stringify({
    goal: plan?.goal ?? null,
    definitionKey: plan?.definitionKey ?? "",
    task: taskSignature(task),
  })).digest("hex");
}

export function taskAssessmentIsCurrent(plan, task) {
  return task?.assessment?.binding === taskAssessmentBinding(plan, task);
}

export function readyTasks(state) {
  if (state?.stopped) return [];
  const byId = new Map((state?.tasks ?? []).map((task) => [task.id, task]));
  return (state?.tasks ?? []).filter((task) => task.status === "pending"
    && taskDependencies(task).every((dep) => {
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
    if (update.status === "pending") { task.assessment = null; delete task.artifacts; }
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
      const unfinished = taskDependencies(task).filter((dep) => {
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
