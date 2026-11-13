#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const reportPath = option("--report", "");
const packageRoot = path.resolve(option("--package", path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents")));
const releaseManifest = JSON.parse(fs.readFileSync(new URL("../RELEASE-MANIFEST.json", import.meta.url), "utf8"));
const expectedVersion = option("--expected", releaseManifest.piSubagentsPinned);
let reportText = "";
if (reportPath) {
  try { reportText = fs.readFileSync(path.resolve(reportPath), "utf8"); }
  catch (error) {
    console.error(`Cannot read contract report ${reportPath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
function extractSection(name) {
  if (!reportText) return "";
  const lines = reportText.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`===== ${name}`) && line.endsWith(" ====="));
  if (index < 0) return "";
  let end = index + 1;
  while (end < lines.length && !lines[end].startsWith("=====")) end += 1;
  return lines.slice(index + 1, end).join("\n").trimEnd();
}
function stripFileMetadata(section) {
  return section.replace(/^Path:.*\nSHA-256:.*\nBytes:.*\n\n/, "");
}
let manifest = null;
let declarations = "";
let bundle = "";
let docs = "";
if (reportText) {
  try { manifest = JSON.parse(extractSection("Installed package identity")); } catch { manifest = null; }
  declarations = stripFileMetadata(extractSection("src/api/delegation.d.ts"));
  bundle = stripFileMetadata(extractSection("bundle/delegation.js"));
  docs = stripFileMetadata(extractSection("docs/extension-api.md"));
} else {
  const read = (relative) => {
    try { return fs.readFileSync(path.join(packageRoot, relative), "utf8"); }
    catch { return ""; }
  };
  try { manifest = JSON.parse(read("package.json")); } catch {}
  declarations = read("src/api/delegation.d.ts");
  bundle = read("bundle/delegation.js");
  docs = read("docs/extension-api.md");
}
const checks = [];
const add = (ok, name, detail) => checks.push({ ok, name, detail });
if (reportText) add(Boolean(extractSection("Installed package identity")), "report metadata", `source=${path.resolve(reportPath)}`);
add(Boolean(manifest && manifest.name === "pi-subagents"), "package identity", manifest ? `${manifest.name}@${manifest.version}` : "package identity metadata missing or invalid");
add(Boolean(manifest && manifest.version === expectedVersion), "pinned version", `expected pi-subagents@${expectedVersion}; found ${manifest?.version ?? "missing"}`);
const exportEntry = manifest?.exports?.["./delegation"];
add(Boolean(exportEntry?.types === "./src/api/delegation.d.ts" && exportEntry?.default === "./bundle/delegation.js"), "delegation export map", JSON.stringify(exportEntry ?? null));
add(Boolean(Array.isArray(manifest?.pi?.extensions) && manifest.pi.extensions.includes("./bundle/index.js")), "Pi extension entry", "package metadata should load ./bundle/index.js");
add(Boolean(declarations), "delegation declarations exist", "src/api/delegation.d.ts");
add(Boolean(bundle), "delegation runtime subpath exists", "bundle/delegation.js");
const eventNames = {
  SUBAGENT_DELEGATION_REQUEST_EVENT: "prompt-template:subagent:request",
  SUBAGENT_DELEGATION_STARTED_EVENT: "prompt-template:subagent:started",
  SUBAGENT_DELEGATION_UPDATE_EVENT: "prompt-template:subagent:update",
  SUBAGENT_DELEGATION_RESPONSE_EVENT: "prompt-template:subagent:response",
  SUBAGENT_DELEGATION_CANCEL_EVENT: "prompt-template:subagent:cancel",
};
for (const [constant, event] of Object.entries(eventNames)) {
  add(declarations.includes(`${constant} = "${event}"`), `event declaration ${constant}`, event);
  add(bundle.includes(constant), `runtime export ${constant}`, "exported from bundle/delegation.js");
}
for (const token of [
  "interface SubagentDelegationRequest",
  "interface SubagentDelegationStarted",
  "interface SubagentDelegationUpdate",
  "interface SubagentDelegationTerminalResponse",
  "interface SubagentDelegationInvalidResponse",
  "requestId: string",
  "ownerRunId: string",
  "nodeId: string",
  "agent: string",
  "task: string",
  'context: "fresh" | "fork"',
  "cwd: string",
  "result: SubagentDelegationResultRequest",
  '"tool_budget_exhausted"',
  '"structured_output_failed"',
  '"acceptance_failed"',
  '"unavailable_context"',
  '"duplicate_node"',
]) {
  add(declarations.includes(token), `declaration token ${token}`, declarations.includes(token) ? "present" : "missing");
}
add(!declarations.includes('"turn_budget_exhausted"'), "status union excludes undocumented turn_budget_exhausted", "status values match the installed declaration rather than the previous guessed alias");
add(/Structured delegation API/i.test(docs) && /foreground-only/i.test(docs) && /not.{0,100}recursively invoking the `subagent` tool/i.test(docs), "documented integration constraints", "structured delegation is foreground-only and must not recursively call the model-visible subagent tool from a tool_call hook");

for (const item of checks) process.stdout.write(`${item.ok ? "PASS" : "FAIL"} ${item.name} — ${item.detail}\n`);
const failed = checks.filter((item) => !item.ok);
if (failed.length) {
  process.stderr.write(`Contract check failed: ${failed.length}/${checks.length} check(s). Do not run live dispatch against this package.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Contract check passed: ${checks.length}/${checks.length}; pi-subagents@${expectedVersion}${reportText ? " (collected report)" : " (installed package)"}.\n`);
}
