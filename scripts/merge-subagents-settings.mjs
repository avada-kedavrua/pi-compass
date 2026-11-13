#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const settingsInput = option("--settings");
const runtimeInput = path.resolve(option("--runtime-config", path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json")));
const settingsPatchPath = path.resolve(option("--patch", path.join(scriptDir, "..", "config", "pi-subagents-settings.patch.json")));
const runtimePatchPath = path.resolve(option("--runtime-patch", path.join(scriptDir, "..", "config", "pi-subagents-runtime.json")));
const settingsOut = path.resolve(option("--out", path.join(os.tmpdir(), "pi-settings.proposed.json")));
const runtimeOut = path.resolve(option("--runtime-out", path.join(os.tmpdir(), "pi-subagents-config.proposed.json")));

if (!settingsInput) {
  console.error("Usage: node scripts/merge-subagents-settings.mjs --settings ~/.pi/agent/settings.json [--runtime-config ~/.pi/agent/extensions/subagent/config.json] [--out /tmp/pi-settings.proposed.json] [--runtime-out /tmp/pi-subagents-config.proposed.json]");
  process.exit(2);
}
const settingsPath = path.resolve(settingsInput);
const forbiddenSamePaths = [
  [settingsPath, settingsOut, "settings input and settings output"],
  [runtimeInput, runtimeOut, "runtime config input and runtime output"],
  [settingsPath, runtimeOut, "settings input and runtime output"],
  [runtimeInput, settingsOut, "runtime config input and settings output"],
  [settingsOut, runtimeOut, "the two proposal outputs"],
];
for (const [left, right, label] of forbiddenSamePaths) {
  if (left === right) {
    console.error(`Refusing to overwrite or conflate ${label}. Choose separate paths.`);
    process.exit(2);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readJson(file, { optional = false } = {}) {
  if (optional && !fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isRecord(value)) throw new Error("JSON root must be an object");
    return value;
  } catch (error) {
    console.error(`Cannot read valid JSON from ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
function packageName(spec) {
  if (typeof spec !== "string") return "";
  const normalized = spec.replace(/^npm:/, "");
  if (normalized.startsWith("@")) {
    const slash = normalized.indexOf("/");
    const at = normalized.indexOf("@", slash + 1);
    return at >= 0 ? normalized.slice(0, at) : normalized;
  }
  const at = normalized.indexOf("@");
  return at > 0 ? normalized.slice(0, at) : normalized;
}
function merge(base, patch, key = "") {
  if (key === "packages" && Array.isArray(base) && Array.isArray(patch)) {
    const result = [...base];
    for (const spec of patch) {
      const name = packageName(spec);
      const index = result.findIndex((current) => packageName(current) === name);
      if (index >= 0) result[index] = spec;
      else result.push(spec);
    }
    return result;
  }
  if (key === "defaultExtensions" && Array.isArray(base) && Array.isArray(patch)) {
    return [...new Set([...base, ...patch])];
  }
  if (isRecord(base) && isRecord(patch)) {
    const result = { ...base };
    for (const [childKey, value] of Object.entries(patch)) {
      result[childKey] = childKey in result ? merge(result[childKey], value, childKey) : structuredClone(value);
    }
    return result;
  }
  return structuredClone(patch);
}
function removeKeyRecursively(value, keyToRemove) {
  if (Array.isArray(value)) {
    for (const item of value) removeKeyRecursively(item, keyToRemove);
    return;
  }
  if (!isRecord(value)) return;
  delete value[keyToRemove];
  for (const child of Object.values(value)) removeKeyRecursively(child, keyToRemove);
}
function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { fs.chmodSync(file, 0o600); } catch {}
}
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const originalSettings = readJson(settingsPath);
const originalRuntime = readJson(runtimeInput, { optional: true });
const settingsPatch = readJson(path.resolve(settingsPatchPath));
const runtimePatch = readJson(path.resolve(runtimePatchPath));
const mergedSettings = merge(originalSettings, settingsPatch);
const mergedRuntime = merge(originalRuntime, runtimePatch);
const removedUnsupportedRuntime = [];
for (const key of ["toolActivation", "disabledFeatures"]) {
  if (Object.hasOwn(mergedRuntime, key)) {
    delete mergedRuntime[key];
    removedUnsupportedRuntime.push(key);
  }
}

// Previous RCs mistakenly placed extension-runtime options under settings.subagents.
// Remove those misplaced keys from the proposed Pi settings; the supported values
// are independently proposed in ~/.pi/agent/extensions/subagent/config.json.
const runtimeOnlyKeys = [
  "toolActivation", "disabledFeatures", "parallel", "globalConcurrencyLimit",
  "maxSubagentDepth", "maxSubagentSpawnsPerRun", "maxSubagentSpawnsPerSession",
  "scheduledRuns", "missions", "inlineToolDisplay", "toolDescriptionMode",
  "asyncByDefault", "timeoutMs",
];
const removedMisplaced = [];
if (isRecord(mergedSettings.subagents)) {
  for (const key of runtimeOnlyKeys) {
    if (Object.hasOwn(mergedSettings.subagents, key)) {
      delete mergedSettings.subagents[key];
      removedMisplaced.push(key);
    }
  }
  const overrides = mergedSettings.subagents.agentOverrides;
  if (isRecord(overrides)) removeKeyRecursively(overrides, "fallbackModels");
}

// Use exclusive creation to avoid overwriting any existing file, including an
// accidental path collision. The caller may remove/re-name an old proposal first.
if (fs.existsSync(settingsOut) || fs.existsSync(runtimeOut)) {
  console.error(`Refusing to overwrite an existing proposal. Remove or rename the existing file(s): ${[settingsOut, runtimeOut].filter((file) => fs.existsSync(file)).join(", ")}`);
  process.exit(2);
}
let settingsWritten = false;
let runtimeWritten = false;
try {
  writePrivateJson(settingsOut, mergedSettings);
  settingsWritten = true;
  writePrivateJson(runtimeOut, mergedRuntime);
  runtimeWritten = true;
} catch (error) {
  if (settingsWritten) fs.rmSync(settingsOut, { force: true });
  if (runtimeWritten) fs.rmSync(runtimeOut, { force: true });
  console.error(`Could not write proposals: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

console.log(`Wrote Pi settings proposal: ${settingsOut}`);
console.log(`Original settings SHA-256: ${sha256(settingsPath)}`);
console.log(`Wrote pi-subagents runtime config proposal: ${runtimeOut}`);
console.log(`Original runtime config: ${fs.existsSync(runtimeInput) ? runtimeInput : "not present (proposal starts from an empty object)"}`);
if (fs.existsSync(runtimeInput)) console.log(`Original runtime config SHA-256: ${sha256(runtimeInput)}`);
console.log(`Removed obsolete fallbackModels keys under subagents.agentOverrides: yes`);
console.log(`Removed misplaced runtime keys from proposed Pi settings: ${removedMisplaced.length ? removedMisplaced.join(", ") : "none"}`);
console.log(`Removed unsupported keys from proposed runtime config: ${removedUnsupportedRuntime.length ? removedUnsupportedRuntime.join(", ") : "none"}`);
console.log("Neither original file was modified. The settings proposal may contain credentials; keep both proposals local and do not upload them.");
