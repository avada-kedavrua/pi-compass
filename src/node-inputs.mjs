import { readyTasks } from "./dag-core.mjs";
import { sourceIndex } from "./context-core.mjs";
import { contextSelection, currentValue } from "./context-values.mjs";

export function nextParentNode(plan, resolveInputs) {
  for (const task of readyTasks(plan)) {
    if (task.executor !== "parent") continue;
    try { return { task, inputs: resolveInputs(task) }; }
    catch { /* blocked input is separately reported in the plan view */ }
  }
  return null;
}

// Use one native source index for all checks against the same context snapshot.
export function nodeInputResolver(plan, context, branch, preview, freshExports = []) {
  let index;
  let byId;
  return (task) => {
    const refs = new Set(task.inputRefs ?? []);
    for (const id of task.fromTasks ?? []) {
      byId ??= new Map(plan.tasks.map((node) => [node.id, node]));
      const producer = byId.get(id);
      if (!producer?.artifacts?.length) throw new Error(`Artifact input from ${id} is missing. Reopen the producer to export it, or patch the input.`);
      for (const ref of producer.artifacts) refs.add(ref);
    }
    if (!refs.size) return { captures: [], caveats: [] };
    index ??= sourceIndex(branch, { context: preview() });
    const captures = [...refs].map((ref) => {
      const selection = contextSelection(ref);
      const fresh = freshExports.find((draft) => draft.details.sourceId === selection.id);
      if (fresh && fresh.details.key === selection.binding && fresh.details.version === selection.version) return { ...selection, mode: "ref" };
      const value = currentValue(context, index, selection.id, { key: selection.binding, allowHidden: true });
      if (value.version !== selection.version || index.byId.get(selection.id)?.details?.action !== "export") {
        throw new Error(`Artifact input ${ref} is stale or is not a frame export. Patch the input with a current exact export.`);
      }
      return { ...selection, mode: "ref" };
    });
    const caveats = plan.tasks.filter((node) => node.artifacts?.some((ref) => refs.has(ref))).flatMap((node) => node.assessment?.caveats ?? []);
    return { captures, caveats: [...new Set(caveats)] };
  };
}
