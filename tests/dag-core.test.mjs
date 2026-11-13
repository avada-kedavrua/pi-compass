import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContinuityContext,
  createOrRevisePlan,
  emptyDagState,
  readyTasks,
  taskAssessmentBinding,
  recordContinuityNote,
  updateTasks,
} from "../src/dag-core.mjs";

function plan(state = emptyDagState(), tasks = [
  { id: "inspect-api", title: "Inspect backend API", acceptance: "Existing health/readiness behavior is documented", dependsOn: [], writeScope: "read-only" },
  { id: "inspect-ui", title: "Inspect frontend entry", acceptance: "Primary route and startup behavior are documented", dependsOn: [], writeScope: "read-only" },
  { id: "design-smoke", title: "Design smoke flow", acceptance: "One smoke flow and prerequisites are specified", dependsOn: ["inspect-api", "inspect-ui"], writeScope: "read-only" },
]) {
  return createOrRevisePlan(state, {
    goal: "Create a repeatable full-stack smoke test",
    acceptanceCriteria: ["One documented command or sequence checks the intended critical path", "Failure output identifies which layer failed", "The run cleans up processes it starts"],
    tasks,
  });
}

test("initial plan marks independent tasks ready and dependent task blocked", () => {
  const state = plan();
  assert.deepEqual(readyTasks(state).map((task) => task.id), ["inspect-api", "inspect-ui"]);
});

test("rejects duplicate task ids", () => {
  assert.throws(() => plan(emptyDagState(), [
    { id: "same", title: "A", acceptance: "A" },
    { id: "same", title: "B", acceptance: "B" },
  ]), /Duplicate task id/);
});

test("rejects unknown dependencies and dependency cycles", () => {
  assert.throws(() => plan(emptyDagState(), [
    { id: "alpha", title: "A", acceptance: "A", dependsOn: ["missing"] },
    { id: "beta", title: "B", acceptance: "B" },
  ]), /unknown task/);

  assert.throws(() => plan(emptyDagState(), [
    { id: "alpha", title: "A", acceptance: "A", dependsOn: ["beta"] },
    { id: "beta", title: "B", acceptance: "B", dependsOn: ["alpha"] },
  ]), /cycle/);
});

test("cannot mark a task done without concrete evidence", () => {
  const state = plan();
  assert.throws(() => updateTasks(state, [{ id: "inspect-api", status: "done" }]), /without concrete evidence/);
});

test("dependencies require an explicit semantic pass after task completion", () => {
  let state = plan();
  state = updateTasks(state, [
    { id: "inspect-api", status: "done", evidence: "Read server routes; /health exists and checks process liveness only." },
    { id: "inspect-ui", status: "done", evidence: "Read router and package scripts; primary route is /dashboard." },
  ]);
  assert.deepEqual(readyTasks(state).map((task) => task.id), []);
  for (const id of ["inspect-api", "inspect-ui"]) {
    const task = state.tasks.find((item) => item.id === id);
    task.assessment = { status: "pass", planRevision: state.revision, binding: taskAssessmentBinding(state, task) };
  }
  assert.deepEqual(readyTasks(state).map((task) => task.id), ["design-smoke"]);
});

test("rejects completing a dependent task before its prerequisites", () => {
  const state = plan();
  assert.throws(() => updateTasks(state, [
    { id: "design-smoke", status: "done", evidence: "A plan was written." },
  ]), /until dependencies are done/);
});

test("preserves status only for unchanged tasks under the same goal", () => {
  let state = plan();
  state = updateTasks(state, [{ id: "inspect-api", status: "done", evidence: "API routes inspected." }]);
  const revised = plan(state, [
    { id: "inspect-api", title: "Inspect backend API", acceptance: "Existing health/readiness behavior is documented", dependsOn: [], writeScope: "read-only" },
    { id: "inspect-ui", title: "Inspect frontend entry", acceptance: "Primary route and startup behavior are documented", dependsOn: [], writeScope: "read-only" },
    { id: "design-smoke", title: "Design smoke flow", acceptance: "One smoke flow and prerequisites are specified", dependsOn: ["inspect-api", "inspect-ui"], writeScope: "read-only" },
    { id: "review-ci", title: "Inspect CI integration", acceptance: "Existing CI conventions are documented", dependsOn: [], writeScope: "read-only" },
  ]);
  assert.equal(revised.tasks.find((task) => task.id === "inspect-api").status, "done");
  assert.equal(revised.tasks.find((task) => task.id === "review-ci").status, "pending");
  assert.equal(revised.revision, 2);
});

test("changing acceptance criteria preserves unchanged task status and evidence", () => {
  let state = plan();
  state = updateTasks(state, [{ id: "inspect-api", status: "done", evidence: "API routes inspected." }]);
  const changed = createOrRevisePlan(state, {
    goal: state.goal,
    acceptanceCriteria: [...state.acceptanceCriteria, "Smoke must run in CI"],
    tasks: state.tasks.map(({ id, title, acceptance, dependsOn, output, writeScope }) => ({ id, title, acceptance, dependsOn, output, writeScope })),
  });
  assert.equal(changed.tasks.find((task) => task.id === "inspect-api").status, "done");
  assert.equal(changed.tasks.find((task) => task.id === "inspect-api").evidence, "API routes inspected.");
});

test("ignores inline task state when a full status object is copied into a plan", () => {
  const state = plan(emptyDagState(), [
    { id: "inspect-api", title: "Inspect backend API", acceptance: "API behavior documented", status: "done", evidence: "Copied stale evidence" },
    { id: "inspect-ui", title: "Inspect frontend entry", acceptance: "UI behavior documented", status: "in_progress" },
  ]);
  assert.equal(state.tasks.find((task) => task.id === "inspect-api").status, "pending");
  assert.equal(state.tasks.find((task) => task.id === "inspect-api").evidence, "");
});


test("replanning invalidates completed descendants when a prerequisite changes", () => {
  let state = plan();
  state = updateTasks(state, [
    { id: "inspect-api", status: "done", evidence: "API inspected." },
    { id: "inspect-ui", status: "done", evidence: "UI inspected." },
  ]);
  for (const id of ["inspect-api", "inspect-ui"]) {
    const task = state.tasks.find((item) => item.id === id);
    task.assessment = { status: "pass", planRevision: state.revision, binding: taskAssessmentBinding(state, task) };
  }
  state = updateTasks(state, [{ id: "design-smoke", status: "done", evidence: "Smoke path chosen." }]);
  const revised = plan(state, [
    { id: "inspect-api", title: "Inspect backend API", acceptance: "Existing health/readiness behavior is documented", dependsOn: [], writeScope: "read-only" },
    { id: "inspect-ui", title: "Inspect frontend entry", acceptance: "Primary route and startup behavior are documented", dependsOn: [], writeScope: "read-only" },
    { id: "inspect-ci", title: "Inspect CI conventions", acceptance: "CI execution conventions are documented", dependsOn: [], writeScope: "read-only" },
    { id: "design-smoke", title: "Design smoke flow", acceptance: "One smoke flow and prerequisites are specified", dependsOn: ["inspect-api", "inspect-ui", "inspect-ci"], writeScope: "read-only" },
  ]);
  assert.equal(revised.tasks.find((task) => task.id === "inspect-api").status, "done");
  assert.equal(revised.tasks.find((task) => task.id === "design-smoke").status, "pending");
  assert.match(revised.tasks.find((task) => task.id === "design-smoke").reason, /replanning/);
});


test("material replans preserve a concise reason and changed-task history", () => {
  let state = plan();
  state = updateTasks(state, [{ id: "inspect-api", status: "done", evidence: "API routes inspected." }]);
  const revised = createOrRevisePlan(state, {
    goal: state.goal,
    acceptanceCriteria: state.acceptanceCriteria,
    changeReason: "The first route depended on a liveness-only endpoint; inspect readiness before selecting the smoke path.",
    tasks: [
      { id: "inspect-api", title: "Inspect backend API", acceptance: "Readiness behavior documented", dependsOn: [], writeScope: "read-only" },
      { id: "inspect-ui", title: "Inspect frontend entry", acceptance: "Primary route and startup behavior are documented", dependsOn: [], writeScope: "read-only" },
      { id: "design-smoke", title: "Select smoke flow", acceptance: "Critical path selected", dependsOn: ["inspect-api", "inspect-ui"], writeScope: "read-only" },
    ],
  });
  assert.equal(revised.planHistory.at(-1).reason, "The first route depended on a liveness-only endpoint; inspect readiness before selecting the smoke path.");
  assert.deepEqual(revised.planHistory.at(-1).changed, ["inspect-api", "design-smoke"]);
  assert.equal(revised.tasks.find((task) => task.id === "inspect-ui").status, "pending");
});

test("task updates retain a timestamped activity trail", () => {
  const state = plan();
  const updated = updateTasks(state, [{ id: "inspect-api", status: "blocked", reason: "API server requires credentials." }]);
  assert.equal(updated.activity.length, 1);
  assert.match(updated.activity[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(updated.activity[0].changes.map((change) => [change.id, change.from, change.to]), [["inspect-api", "pending", "blocked"]]);
});

test("decision notes and checkpoints are retained for continuity", () => {
  let state = plan();
  let result = recordContinuityNote(state, {
    kind: "decision",
    summary: "Keep subagents read-only",
    rationale: "Concurrent writes have collided in this repository before.",
    evidence: "Prior session showed source edits from the wrong workspace.",
    affectedTasks: ["inspect-api"],
  });
  state = result.state;
  assert.match(result.message, /Recorded D1/);
  result = recordContinuityNote(state, {
    kind: "checkpoint",
    summary: "All existing tests passed before the refactor",
    ref: "git:abc1234",
    evidence: "npm test: 681 passed.",
  });
  assert.match(result.message, /git:abc1234/);
  assert.equal(result.state.decisions[0].id, "D1");
  assert.equal(result.state.checkpoints[0].id, "C1");
  assert.match(buildContinuityContext(result.state), /Keep subagents read-only/);
  assert.match(buildContinuityContext(result.state), /git:abc1234/);
});

test("continuity context reminds the Agent to relate new issues to Goal and history without adding a DAG for simple tasks", () => {
  assert.equal(buildContinuityContext(emptyDagState()), "");
  const state = plan();
  const context = buildContinuityContext(state);
  assert.match(context, /Goal: Create a repeatable full-stack smoke test/);
  assert.match(context, /Continuity check for a material new issue/);
  assert.match(context, /not a mandatory extra tool call/);
});

test("a new Goal does not inherit unrelated decisions and checkpoints", () => {
  let state = plan();
  state = recordContinuityNote(state, { kind: "decision", summary: "Old-goal decision", rationale: "Old context." }).state;
  state = recordContinuityNote(state, { kind: "checkpoint", summary: "Old-goal checkpoint", ref: "git:old" }).state;
  const next = createOrRevisePlan(state, {
    goal: "A different goal",
    acceptanceCriteria: ["New goal criterion"],
    tasks: [
      { id: "new-a", title: "New A", acceptance: "A done", dependsOn: [] },
      { id: "new-b", title: "New B", acceptance: "B done", dependsOn: ["new-a"] },
    ],
  });
  assert.equal(next.revision, 1);
  assert.equal(next.decisions.length, 0);
  assert.equal(next.checkpoints.length, 0);
  assert.match(buildContinuityContext(next), /A different goal/);
  assert.doesNotMatch(buildContinuityContext(next), /Old-goal decision/);
});


test("continuity snapshot stays bounded for a large Goal and graph", () => {
  let state = createOrRevisePlan(emptyDagState(), {
    goal: "A complex Goal ".repeat(100),
    acceptanceCriteria: Array.from({ length: 20 }, (_, index) => `Acceptance criterion ${index} `.repeat(20)),
    tasks: Array.from({ length: 30 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index} `.repeat(20),
      acceptance: `Task acceptance ${index}`,
      dependsOn: index === 0 ? [] : [`task-${index - 1}`],
    })),
  });
  state = recordContinuityNote(state, {
    kind: "decision",
    summary: "A material design decision",
    rationale: "Why it was selected. ".repeat(50),
    evidence: "Evidence. ".repeat(50),
  }).state;
  assert.ok(buildContinuityContext(state).length <= 3600);
});


test("re-submitting an identical plan does not create a false revision", () => {
  const first = plan();
  const second = plan(first, first.tasks.map(({ id, title, acceptance, dependsOn, output, writeScope }) => ({ id, title, acceptance, dependsOn, output, writeScope })));
  assert.equal(second.revision, first.revision);
  assert.equal(second.planHistory.length, first.planHistory.length);
});
