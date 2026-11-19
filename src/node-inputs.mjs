import { sourceIndex } from "./context-core.mjs";
import { contextSelection, currentValue } from "./context-values.mjs";

// Use one native source index for all checks against the same context snapshot.
export function nodeInputResolver(plan, context, branch, preview) {
  let index;
  let byId;
  return (task) => {
    if (context.frames.length) throw new Error("Return to the root frame before starting a parent DAG node.");
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
      const value = currentValue(context, index, selection.id, { key: selection.binding });
      if (value.version !== selection.version || index.byId.get(selection.id)?.details?.action !== "export") {
        throw new Error(`Artifact input ${ref} is stale or is not a frame export. Patch the input with a current exact export.`);
      }
      return { ...selection, mode: "ref" };
    });
    const caveats = plan.tasks.filter((node) => node.artifacts?.some((ref) => refs.has(ref))).flatMap((node) => node.assessment?.caveats ?? []);
    return { captures, caveats: [...new Set(caveats)] };
  };
}
