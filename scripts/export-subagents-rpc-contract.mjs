#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const packageRoot = path.resolve(option("--package", path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents")));
const outputPath = path.resolve(option("--out", path.join(os.tmpdir(), "pi-subagents-delegation-contract.txt")));
const sections = [];
const read = (file) => {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
};
const add = (title, body) => { if (body.trim()) sections.push(`\n===== ${title} =====\n${body.trim()}\n`); };

if (!fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) {
  console.error(`pi-subagents package directory not found: ${packageRoot}`);
  console.error("Pass --package with the installed pi-subagents directory. No settings or credentials are read.");
  process.exit(2);
}
const manifestPath = path.join(packageRoot, "package.json");
const manifestText = read(manifestPath);
if (!manifestText) {
  console.error(`package.json not found under ${packageRoot}`);
  process.exit(2);
}
let manifest;
try { manifest = JSON.parse(manifestText); } catch (error) {
  console.error(`Invalid package.json: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
add("Installed package identity", JSON.stringify({ name: manifest.name, version: manifest.version, exports: manifest.exports, pi: manifest.pi }, null, 2));

const docPatterns = {
  "docs/extension-api.md": /Structured delegation API|SUBAGENT_DELEGATION|prompt-template:subagent|foreground-only|duplicate_node|requestId|ownerRunId|nodeId|toolBudget|legacy direct delegation/i,
  "docs/tool-reference.md": /workflowScript|workflow: true|runs\.all|result schema|structured output|timeoutMs|toolBudget/i,
  "docs/configuration.md": /defaultModel|defaultThinking|modelScope|agentOverrides|tools|fallbackModels|globalConcurrencyLimit|maxSubagentDepth/i,
};
for (const [relative, pattern] of Object.entries(docPatterns)) {
  const body = read(path.join(packageRoot, relative));
  if (!body) continue;
  const lines = body.split(/\r?\n/);
  const included = new Set();
  let count = 0;
  for (let i = 0; i < lines.length && count < 120; i += 1) {
    if (!pattern.test(lines[i])) continue;
    count += 1;
    for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 5); j += 1) included.add(j);
  }
  add(relative, [...included].sort((a, b) => a - b).map((index) => `${index + 1}: ${lines[index]}`).join("\n"));
}
for (const relative of ["src/api/delegation.d.ts", "src/api/capability-ceiling.d.ts", "bundle/delegation.js"]) {
  const body = read(path.join(packageRoot, relative));
  if (body) add(relative, body.slice(0, 45_000));
}
const bundlePath = path.join(packageRoot, "bundle", "index.js");
const bundle = read(bundlePath);
if (bundle) {
  const lines = bundle.split(/\r?\n/);
  const patterns = [
    /prompt-template:subagent:(?:request|started|update|response|cancel)/i,
    /SUBAGENT_DELEGATION_(?:REQUEST|STARTED|UPDATE|RESPONSE|CANCEL)_EVENT/,
    /duplicate_node|structured_output_failed|unavailable_context/,
    /ownerRunId|nodeId|requestId/,
  ];
  const included = new Set();
  for (const pattern of patterns) {
    let count = 0;
    for (let i = 0; i < lines.length && count < 18; i += 1) {
      if (!pattern.test(lines[i])) continue;
      count += 1;
      for (let j = Math.max(0, i - 8); j <= Math.min(lines.length - 1, i + 12); j += 1) included.add(j);
    }
  }
  add("bundle/index.js structured-delegation snippets", [...included].sort((a, b) => a - b).map((index) => `${index + 1}: ${lines[index]}`).join("\n").slice(0, 45_000));
}

const hasTypes = sections.some((section) => section.includes("src/api/delegation.d.ts"));
const hasBundle = sections.some((section) => section.includes("bundle/delegation.js") || section.includes("bundle/index.js structured-delegation"));
if (!hasTypes || !hasBundle) {
  console.error("Package metadata was found, but exact structured-delegation type/bundle excerpts were missing. Upload the installed pi-subagents package archive instead.");
  process.exit(3);
}
const output = [
  "pi-subagents structured-delegation compatibility evidence",
  `Package root: ${packageRoot}`,
  `Generated at: ${new Date().toISOString()}`,
  "This report contains package metadata, selected docs, delegation type declarations, and bundle source excerpts. It does not read Pi settings, API keys, or credentials.",
  ...sections,
].join("\n");
fs.writeFileSync(outputPath, output, "utf8");
console.log(`Wrote ${outputPath} (${Buffer.byteLength(output)} bytes)`);
console.log(`Package: ${manifest.name}@${manifest.version}`);
