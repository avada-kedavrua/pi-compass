#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
import { SessionManager, contextPreview, applyOperation } from "../tests/helpers/context-host.mjs";
import { restoreContextState, pinnedContextOverlay } from "../src/context-core.mjs";
import { agentSearch, agentContextOperation } from "../src/context-agent.mjs";
import { contextSelection } from "../src/context-values.mjs";

// Replay the frozen pre-refactor search/pin case, without writing its session.
if (!process.argv[2]) throw new Error("Pass the recorded session JSONL path.");
const entries = [];
let pin;
let query;
let original;
const input = fs.createReadStream(process.argv[2], { encoding: "utf8" });
const lines = readline.createInterface({ input });
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    const message = entry.message;
    if (message?.role === "assistant") {
      const calls = Array.isArray(message.content) ? message.content.filter((item) => item.type === "toolCall") : [];
      const search = calls.find((call) => call.name === "compass_context_search");
      if (search) query = search.arguments;
      pin = calls.find((call) => call.name === "compass_context" && call.arguments?.operation?.action === "pin");
      if (pin) break;
    }
    if (message?.role === "toolResult" && message.toolName === "compass_context_search") original = message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    entries.push(entry);
  }
} finally { lines.close(); input.destroy(); }
const ids = pin?.arguments?.operation?.ids;
if (!ids?.length || !query || !original) throw new Error("Expected a recorded pre-refactor search followed by an ID-based pin attempt.");
function fixture() {
  const manager = SessionManager.inMemory(process.cwd(), undefined, structuredClone(entries));
  return { manager, state: restoreContextState(manager.getBranch()), boundary: { context: contextPreview(manager) } };
}
const base = fixture();
const report = { originalSearchChars: original.length };
let refs;
for (const view of ["snippets", "handles", "details"]) {
  const result = agentSearch(base.manager.getBranch(), base.boundary, base.state, { ...query, view });
  report[view] = { chars: JSON.stringify(result).length, bytes: Buffer.byteLength(JSON.stringify(result)), hits: result.hits.length };
  if (view === "handles") refs = result.hits.filter((hit) => ids.includes(contextSelection(hit.ref).id)).map((hit) => hit.ref);
}
if (refs.length !== ids.length) throw new Error("The bounded search did not recover every selected source.");
for (const action of ["pin", "remember"]) {
  const f = fixture();
  const request = action === "pin" ? { action, sources: refs } : {
    action, sources: refs,
    text: "设置页入口授权与后端管理接口权限存在代码层不一致；运行时根因尚未证实。自动更新的真实渲染仍待复现。",
    caveats: ["Code evidence only; runtime verification pending."],
  };
  const operation = agentContextOperation(f.manager.getBranch(), f.boundary, f.state, request);
  const committed = applyOperation(f.manager, { ...operation, goalVersion: 1 });
  f.manager.appendCompaction("summary", null, 0, {}, true);
  const overlays = pinnedContextOverlay(f.manager.getBranch(), committed.state, f.manager.buildSessionProjection().messages, 1);
  report[action] = { selected: refs.length, retainedContentBytes: Buffer.byteLength(JSON.stringify(overlays.map((item) => item.content))), retainedValues: overlays.length };
}
console.log(JSON.stringify(report));
