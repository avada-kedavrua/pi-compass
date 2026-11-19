import test from "node:test";
import assert from "node:assert/strict";
import {
  createOrRevisePlan,
  emptyDagState,
  readyTasks,
  taskAssessmentBinding,
  updateTasks,
} from "../src/dag-core.mjs";

function plan(state = emptyDagState(), tasks = [
  { id: "inspect-api", title: "Inspect backend API", acceptance: "Existing health/readiness behavior is documented", dependsOn: [], writeScope: "read-only" },
  { id: "inspect-ui", title: "Inspect frontend entry", acceptance: "Primary route and startup behavior are documented", dependsOn: [], writeScope: "read-only" },
  { id: "design-smoke", title: "Design smoke flow", acceptance: "One smoke flow and prerequisites are specified", dependsOn: ["inspect-api", "inspect-ui"], writeScope: "read-only" },
]) {
  return createOrRevisePlan(state, {
    goal: "Create a repeatable full-stack smoke test",
    definitionKey: "fixture-[\"One documented command or sequence checks the intended critical path\", \"Failure output identifies which layer failed\", \"The run cleans up processes it starts\"]",
    tasks,
  });
}

test("initial plan marks independent tasks ready and dependent task blocked", () => {
  const state = plan();
  assert.deepEqual(readyTasks(state).map((task) => task.id), ["inspect-api", "inspect-ui"]);
});

test("frame artifact dependencies cannot name an executor that cannot export", () => {
  const graph = (executor) => [
    { id: "producer", title: "Inspect", acceptance: "Observation", executor, writeScope: "read-only", dispatchReason: "Read-only separate observation" },
    { id: "consumer", title: "Combine", acceptance: "Summary", fromTasks: ["producer"] },
  ];
  for (const executor of ["code", "subagent"]) assert.throws(() => plan(emptyDagState(), graph(executor)), /only parent node frames export artifacts/);
  assert.doesNotThrow(() => plan(emptyDagState(), graph("parent")));
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

test("changing the Goal definition digest preserves task evidence but invalidates assessments", () => {
  let state = plan();
  state = updateTasks(state, [{ id: "inspect-api", status: "done", evidence: "API routes inspected." }]);
  const changed = createOrRevisePlan(state, {
    goal: state.goal,
    definitionKey: "fixture-[...state.acceptanceCriteria, \"Smoke must run in CI\"]",
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
    definitionKey: "fixture-state.acceptanceCriteria",
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

test("re-submitting an identical plan does not create a false revision", () => {
  const first = plan();
  const second = plan(first, first.tasks.map(({ id, title, acceptance, dependsOn, output, writeScope }) => ({ id, title, acceptance, dependsOn, output, writeScope })));
  assert.equal(second.revision, first.revision);
  assert.equal(second.planHistory.length, first.planHistory.length);
});
