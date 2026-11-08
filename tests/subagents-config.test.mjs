import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const patch = JSON.parse(fs.readFileSync(path.join(root, "config", "pi-subagents-settings.v0.84.0.patch.json"), "utf8"));
const runtime = JSON.parse(fs.readFileSync(path.join(root, "config", "pi-subagents-runtime.v0.84.0.json"), "utf8"));

function containsKey(value, key) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([name, child]) => name === key || containsKey(child, key));
}

test("recommended pi-subagents 0.84.0 configuration separates Pi settings from extension runtime config", () => {
  assert.ok(patch.packages.includes("npm:pi-subagents@0.84.0"));
  assert.equal(patch.subagents.defaultModel, "cliproxyapi/gpt-6-luna");
  assert.equal(patch.subagents.defaultThinking, "high");
  assert.ok(patch.subagents.modelScope.allow.includes("jrt/deepseek-v4.1-flash"));
  for (const model of [
    "cliproxyapi/gpt-5.6-luna", "cliproxyapi/gpt-5.6-sol", "cliproxyapi/gpt-5.6-terra",
    "cliproxyapi/gpt-6-astra", "cliproxyapi/gpt-6-luna", "cliproxyapi/gpt-6-sol",
    "cliproxyapi/gpt-6.1-sol", "cliproxyapi/gpt-6.1-terra", "jrt/deepseek-v4.1-flash",
  ]) assert.ok(patch.subagents.modelScope.allow.includes(model), `global strict model scope must preserve reported model ${model}`);
  assert.deepEqual(patch.subagents.modelScope.agents.reviewer.allow, ["cliproxyapi/gpt-6.1-sol", "jrt/deepseek-v4.1-flash"]);
  assert.deepEqual(patch.subagents.modelScope.agents.scout.allow, ["cliproxyapi/gpt-6-luna", "jrt/deepseek-v4.1-flash"]);
  assert.equal(containsKey(patch.subagents.agentOverrides, "fallbackModels"), false);

  const runtimeOnlyKeys = ["toolActivation", "disabledFeatures", "parallel", "globalConcurrencyLimit", "maxSubagentDepth", "maxSubagentSpawnsPerRun", "maxSubagentSpawnsPerSession", "scheduledRuns", "missions", "inlineToolDisplay", "toolDescriptionMode", "asyncByDefault", "timeoutMs"];
  for (const key of runtimeOnlyKeys) assert.ok(!(key in patch.subagents), `runtime option ${key} must not be placed under settings.subagents`);
  assert.deepEqual(runtime.parallel, { maxTasks: 4, concurrency: 4 });
  assert.equal(runtime.globalConcurrencyLimit, 4);
  assert.equal(runtime.maxSubagentDepth, 1);
  assert.equal(runtime.maxSubagentSpawnsPerRun, 24, "the per-run spawn cap must cover the maximum 24-node DAG");
  assert.equal(runtime.maxSubagentSpawnsPerSession, 100, "the session cap must not exhaust after one 24-node DAG");
  assert.equal(runtime.scheduledRuns.enabled, false);
  assert.equal(runtime.missions.enabled, false);
  assert.equal(runtime.toolDescriptionMode, "compact");
  assert.equal(runtime.inlineToolDisplay, "summary");
  assert.equal(runtime.asyncByDefault, false);
  assert.equal(runtime.timeoutMs, 3600000);
  assert.ok(!("toolActivation" in runtime), "undocumented toolActivation must not be emitted");
  assert.ok(!("disabledFeatures" in runtime), "disabledFeatures is not a documented global runtime config key");
});

test("subagents config checker validates both configuration surfaces and fails unsafe or misplaced settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compass-subagents-config-"));
  const settingsPath = path.join(dir, "settings.json");
  const runtimePath = path.join(dir, "config.json");
  const packagePath = path.join(dir, "pi-subagents-package.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...patch, subagents: structuredClone(patch.subagents) }, null, 2));
  fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2));
  fs.writeFileSync(packagePath, JSON.stringify({ name: "pi-subagents", version: "0.84.0" }));
  const script = path.join(root, "scripts", "check-subagents-config.mjs");
  const args = [script, "--settings", settingsPath, "--runtime-config", runtimePath, "--package", packagePath, "--strict"];
  const good = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(good.status, 0, `${good.stdout}\n${good.stderr}`);
  assert.match(good.stdout, /PASS Removed fallbackModels field/);
  assert.match(good.stdout, /PASS Configuration surface separation/);
  assert.match(good.stdout, /PASS global concurrency limit/);

  const broken = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  broken.subagents.agentOverrides.researcher.fallbackModels = ["jrt/deepseek-v4.1-flash"];
  fs.writeFileSync(settingsPath, JSON.stringify(broken, null, 2));
  const bad = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL Removed fallbackModels field/);

  const widened = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  delete widened.subagents.agentOverrides.researcher.fallbackModels;
  widened.subagents.agentOverrides.scout.tools = ["read", "grep", "bash"];
  fs.writeFileSync(settingsPath, JSON.stringify(widened, null, 2));
  const unsafe = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stdout, /FAIL Read-only tool allowlist scout/);

  const misplaced = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  misplaced.subagents.parallel = { concurrency: 4, maxTasks: 4 };
  fs.writeFileSync(settingsPath, JSON.stringify(misplaced, null, 2));
  const wrongSurface = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(wrongSurface.status, 1);
  assert.match(wrongSurface.stdout, /FAIL Configuration surface separation/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("installed package contract exporter includes delegation declarations and runtime event excerpts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compass-subagents-contract-"));
  const packageRoot = path.join(dir, "pi-subagents");
  const out = path.join(dir, "contract.txt");
  for (const subdir of ["docs", "src/api", "bundle"]) fs.mkdirSync(path.join(packageRoot, subdir), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "pi-subagents",
    version: "0.84.0",
    exports: { "./delegation": { types: "./src/api/delegation.d.ts", default: "./bundle/delegation.js" } },
    pi: { extensions: ["./bundle/index.js"] },
  }));
  fs.writeFileSync(path.join(packageRoot, "docs", "extension-api.md"), "Structured delegation API uses prompt-template:subagent:request and prompt-template:subagent:response.\\n");
  fs.writeFileSync(path.join(packageRoot, "src/api", "delegation.d.ts"), "export type SubagentDelegationRequest = { requestId: string; ownerRunId: string; nodeId: string; };\\n");
  fs.writeFileSync(path.join(packageRoot, "bundle", "delegation.js"), 'export const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";\\n');
  fs.writeFileSync(path.join(packageRoot, "bundle", "index.js"), 'const response = "prompt-template:subagent:response"; // ownerRunId nodeId requestId\\n');
  const script = path.join(root, "scripts", "export-subagents-rpc-contract.mjs");
  const result = spawnSync(process.execPath, [script, "--package", packageRoot, "--out", out], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\\n${result.stderr}`);
  const report = fs.readFileSync(out, "utf8");
  assert.match(report, /pi-subagents structured-delegation compatibility evidence/);
  assert.ok(report.includes("src/api/delegation.d.ts"));
  assert.ok(report.includes("bundle/delegation.js"));
  assert.match(report, /prompt-template:subagent:request/);
  assert.match(report, /ownerRunId/);
  fs.rmSync(dir, { recursive: true, force: true });
});


test("installed pi-subagents contract checker validates the pinned structured-delegation API", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compass-contract-check-"));
  const packageRoot = path.join(dir, "pi-subagents");
  fs.mkdirSync(path.join(packageRoot, "src/api"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "bundle"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "docs"), { recursive: true });
  const events = {
    SUBAGENT_DELEGATION_REQUEST_EVENT: "prompt-template:subagent:request",
    SUBAGENT_DELEGATION_STARTED_EVENT: "prompt-template:subagent:started",
    SUBAGENT_DELEGATION_UPDATE_EVENT: "prompt-template:subagent:update",
    SUBAGENT_DELEGATION_RESPONSE_EVENT: "prompt-template:subagent:response",
    SUBAGENT_DELEGATION_CANCEL_EVENT: "prompt-template:subagent:cancel",
  };
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "pi-subagents", version: "0.84.0",
    exports: { "./delegation": { types: "./src/api/delegation.d.ts", default: "./bundle/delegation.js" } },
    pi: { extensions: ["./bundle/index.js"] },
  }));
  const constants = Object.entries(events).map(([name, value]) => `export declare const ${name} = "${value}";`).join("\n");
  const declarations = `${constants}\nexport interface SubagentDelegationRequest { requestId: string; ownerRunId: string; nodeId: string; agent: string; task: string; context: "fresh" | "fork"; cwd: string; result: SubagentDelegationResultRequest; }\nexport interface SubagentDelegationStarted {}\nexport interface SubagentDelegationUpdate {}\nexport interface SubagentDelegationTerminalResponse {}\nexport interface SubagentDelegationInvalidResponse {}\nexport type SubagentDelegationStatus = "completed" | "failed" | "timed_out" | "cancelled" | "interrupted" | "tool_budget_exhausted" | "structured_output_failed" | "acceptance_failed" | "invalid_request" | "unavailable_context" | "duplicate_node";`;
  fs.writeFileSync(path.join(packageRoot, "src/api/delegation.d.ts"), declarations);
  fs.writeFileSync(path.join(packageRoot, "bundle/delegation.js"), `export { ${Object.keys(events).join(", ")} };`);
  fs.writeFileSync(path.join(packageRoot, "docs/extension-api.md"), "Structured delegation API is foreground-only and must not be integrated by recursively invoking the `subagent` tool inside a tool_call hook.");
  const script = path.join(root, "scripts", "check-subagents-contract.mjs");
  const good = spawnSync(process.execPath, [script, "--package", packageRoot, "--expected", "0.84.0"], { encoding: "utf8" });
  assert.equal(good.status, 0, `${good.stdout}\n${good.stderr}`);
  assert.match(good.stdout, /Contract check passed/);
  const reportPath = path.join(dir, "collected-contract.txt");
  const exporter = spawnSync(process.execPath, [path.join(root, "scripts", "export-subagents-rpc-contract.mjs"), "--package", packageRoot, "--out", reportPath], { encoding: "utf8" });
  assert.equal(exporter.status, 0, `${exporter.stdout}\n${exporter.stderr}`);
  const reportCheck = spawnSync(process.execPath, [script, "--report", reportPath, "--expected", "0.84.0"], { encoding: "utf8" });
  assert.equal(reportCheck.status, 0, `${reportCheck.stdout}\n${reportCheck.stderr}`);
  assert.match(reportCheck.stdout, /Contract check passed: .*collected report/);
  const badManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  badManifest.version = "0.83.0";
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(badManifest));
  const bad = spawnSync(process.execPath, [script, "--package", packageRoot, "--expected", "0.84.0"], { encoding: "utf8" });
  assert.notEqual(bad.status, 0, "a stale installed package must fail closed");
  assert.match(bad.stdout, /FAIL pinned version/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dual config proposal separates settings and runtime config, migrates misplaced keys, and preserves both originals", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compass-settings-merge-"));
  const settingsPath = path.join(dir, "settings.json");
  const runtimePath = path.join(dir, "config.json");
  const settingsOut = path.join(dir, "settings.proposed.json");
  const runtimeOut = path.join(dir, "runtime.proposed.json");
  const original = {
    providers: { privateProviderConfig: "do-not-print" },
    packages: ["npm:pi-subagents@0.82.1", "npm:other-extension@1.2.3"],
    subagents: {
      defaultModel: "old-model",
      defaultExtensions: ["/custom/child-extension.js"],
      parallel: { concurrency: 2, maxTasks: 2 },
      globalConcurrencyLimit: 2,
      disabledFeatures: ["custom-disabled-feature"],
      agentOverrides: {
        researcher: { fallbackModels: ["old-fallback"], customRetainedField: "preserve-me" },
        unrelated: { fallbackModels: ["legacy"], tools: ["read"] },
      },
    },
  };
  const originalRuntime = { customRuntimeOption: "preserve-runtime-value", scheduledRuns: { enabled: true, storeRoot: "~/private-schedules" }, parallel: { concurrency: 2, maxTasks: 2 } };
  fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2), { mode: 0o600 });
  fs.writeFileSync(runtimePath, JSON.stringify(originalRuntime, null, 2), { mode: 0o600 });
  const originalBytes = fs.readFileSync(settingsPath);
  const originalRuntimeBytes = fs.readFileSync(runtimePath);
  const script = path.join(root, "scripts", "merge-subagents-settings.mjs");
  const settingsPatchPath = path.join(root, "config", "pi-subagents-settings.v0.84.0.patch.json");
  const runtimePatchPath = path.join(root, "config", "pi-subagents-runtime.v0.84.0.json");
  const result = spawnSync(process.execPath, [script, "--settings", settingsPath, "--runtime-config", runtimePath, "--patch", settingsPatchPath, "--runtime-patch", runtimePatchPath, "--out", settingsOut, "--runtime-out", runtimeOut], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(!result.stdout.includes("do-not-print"), "settings values must not be printed");
  assert.deepEqual(fs.readFileSync(settingsPath), originalBytes, "original settings are not modified");
  assert.deepEqual(fs.readFileSync(runtimePath), originalRuntimeBytes, "original runtime config is not modified");
  const merged = JSON.parse(fs.readFileSync(settingsOut, "utf8"));
  const mergedRuntime = JSON.parse(fs.readFileSync(runtimeOut, "utf8"));
  assert.deepEqual(merged.providers, original.providers);
  assert.ok(merged.packages.includes("npm:other-extension@1.2.3"));
  assert.ok(merged.subagents.defaultExtensions.includes("/custom/child-extension.js"), "unrelated child extensions are preserved");
  assert.ok(merged.subagents.defaultExtensions.includes(patch.subagents.defaultExtensions[0]), "the configured model provider extension is added");
  assert.equal(merged.packages.filter((item) => item.startsWith("npm:pi-subagents@")).length, 1);
  assert.ok(merged.packages.includes("npm:pi-subagents@0.84.0"));
  assert.equal(merged.subagents.defaultModel, "cliproxyapi/gpt-6-luna");
  assert.equal(merged.subagents.agentOverrides.researcher.customRetainedField, "preserve-me");
  assert.ok(!("fallbackModels" in merged.subagents.agentOverrides.researcher));
  assert.ok(!("fallbackModels" in merged.subagents.agentOverrides.unrelated));
  assert.ok(!("parallel" in merged.subagents), "misplaced runtime settings are removed from the proposed Pi settings");
  assert.ok(!("globalConcurrencyLimit" in merged.subagents));
  assert.ok(!("disabledFeatures" in merged.subagents));
  assert.deepEqual(mergedRuntime.customRuntimeOption, originalRuntime.customRuntimeOption);
  assert.equal(mergedRuntime.parallel.concurrency, 4);
  assert.equal(mergedRuntime.parallel.maxTasks, 4);
  assert.equal(mergedRuntime.scheduledRuns.enabled, false);
  assert.equal(mergedRuntime.scheduledRuns.storeRoot, "~/private-schedules", "unrelated runtime config subkeys are preserved");
  assert.equal(fs.statSync(settingsOut).mode & 0o777, 0o600);
  assert.equal(fs.statSync(runtimeOut).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});
