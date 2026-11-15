// Pi owns Human message payloads. Compass keeps only branch-local identities.
export function latestHumanSource(branch) {
  if (!Array.isArray(branch)) throw new Error("Native active branch is unavailable. No state changed.");
  return branch.findLast((entry) => entry?.type === "message" && entry.message?.role === "user" && typeof entry.id === "string")?.id ?? null;
}

export function validateGoalSources(branch, sourceIds) {
  if (!Array.isArray(branch) || !Array.isArray(sourceIds)) throw new Error("Native Human sources are required. No state changed.");
  const byId = new Map(branch.map((entry) => [entry.id, entry]));
  for (const id of sourceIds) {
    const entry = byId.get(id);
    if (entry?.type !== "message" || entry.message?.role !== "user") {
      throw new Error(`Goal source ${id} is unknown, wrong-branch, or not a native Human message. No state changed.`);
    }
  }
}
