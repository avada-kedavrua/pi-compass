import { emptyGoalRunState, observeHumanInput, setGoal } from "../../src/goal-run.mjs";

export function createGoalState(current, { constraints = [], acceptanceCriteria, sourceId = "human-source" } = {}) {
  const observed = observeHumanInput(emptyGoalRunState(), sourceId).state;
  return setGoal(observed, { expectedVersion: 0, current, sourceIds: [sourceId], constraints, ...(acceptanceCriteria ? { acceptanceCriteria } : {}) }).state;
}
