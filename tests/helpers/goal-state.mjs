import { emptyGoalRunState, observeHumanInput, setGoal } from "../../src/goal-run.mjs";

export function createGoalState(current, { constraints = [], criteria = ["Goal result is supported by evidence"], sourceId = "human-source" } = {}) {
  const observed = observeHumanInput(emptyGoalRunState(), sourceId).state;
  return setGoal(observed, { expectedVersion: 0, current, sourceIds: [sourceId], constraints, criteria }).state;
}
