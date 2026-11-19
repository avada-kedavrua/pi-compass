import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Use the SDK shipped by the registered native tool, not a separately installed copy.
export async function loadDelegationPreflight(tool, importSdk) {
  if (typeof tool?.sourceInfo?.path !== "string" || !path.isAbsolute(tool.sourceInfo.path)) return null;
  const entry = realpathSync(tool.sourceInfo.path);
  for (let root = path.dirname(entry); root !== path.dirname(root); root = path.dirname(root)) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (manifest.name !== "pi-subagents" || !manifest.pi?.extensions?.some((file) => path.resolve(root, file) === entry)) return null;
    const target = realpathSync(createRequire(entry).resolve("pi-subagents/preflight"));
    if (!target.startsWith(root + path.sep)) return null;
    const sdk = await importSdk(pathToFileURL(target).href);
    return typeof sdk.resolveSubagentLaunchContract === "function" ? sdk.resolveSubagentLaunchContract : null;
  }
  return null;
}

export function launchPreflightInput(pi, ctx, request) {
  const { agent, task, cwd, model, thinking, context, intercomBridge } = request;
  return {
    agent, task, cwd, model, thinking, context, intercomBridge,
    outputSchema: request.result.schema,
    projectTrusted: ctx.isProjectTrusted?.(),
    parentModel: ctx.model,
    availableModels: ctx.modelRegistry?.getAvailable(),
    knownProviders: () => ctx.modelRegistry?.getAll().map(({ provider }) => provider) ?? [],
    parentSessionId: ctx.sessionManager?.getSessionId?.(),
    parentSessionFile: ctx.sessionManager?.getSessionFile?.(),
    runtimeSnapshotHost: pi,
  };
}
