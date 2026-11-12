import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { piRoot } from "../scripts/register-pi-host-typebox.mjs";
import extensionFactory from "../src/index.ts";

// Use the installed host's real transformation/serialization code. This tests
// request construction, not a live provider's cache hit rate or Pi compatibility.
assert.ok(piRoot, "The full suite requires an installed Pi host");
const host = pathToFileURL(`${piRoot}/`);
const { ExtensionRunner } = await import(new URL("dist/core/extensions/runner.js", host));
const { convertToLlm } = await import(new URL("dist/core/messages.js", host));
const { convertResponsesMessages } = await import(new URL("node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js", host));

function setup() {
  const handlers = new Map();
  const tools = new Map();
  const entries = [];
  let active = ["read", "subagents_enable", "watch", "watches", "unwatch"];
  const sessionManager = { getBranch: () => entries, getEntries: () => entries };
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    events: { on() { return () => {}; }, emit() {} },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    getActiveTools() { return [...active]; },
    getAllTools() { return [...new Set([...active, ...tools.keys()])].map((name) => ({ name })); },
    setActiveTools(names) { active = [...names]; },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
  };
  extensionFactory(pi);
  const runner = new ExtensionRunner([{ path: "compass-prefix-test", handlers }], {}, "/project", sessionManager, undefined);
  const errors = [];
  runner.errorListeners.add((error) => errors.push(error));
  return { handlers, runner, errors, ctx: { cwd: "/project", sessionManager } };
}

const tool = (name) => ({ name, description: name, parameters: { type: "object", properties: {}, additionalProperties: false } });
const first = [
  { role: "system", content: "", sections: { preamble: "Stable reserved instructions." }, toolsAdded: [tool("read")], timestamp: 1 },
  { role: "user", content: "Inspect the project.", timestamp: 2 },
];
const second = [
  ...first,
  { role: "system", content: "", toolsAdded: [tool("compass_state")], timestamp: 3 },
  { role: "user", content: "Continue.", timestamp: 4 },
];
const model = { provider: "test", api: "openai-responses", id: "test", name: "test", reasoning: false, input: ["text"] };
function serialize(messages) {
  return convertResponsesMessages(model, { messages: convertToLlm(messages) }, new Set(["test"]), {
    supportsMidConvoSystemMessages: true,
    supportsAdditionalTools: true,
  });
}

test("Compass preserves the complete prior request prefix across a native tool addition", async () => {
  const { handlers, runner, errors, ctx } = setup();
  await handlers.get("session_start")[0]({}, ctx);
  const result = await handlers.get("before_agent_start")[0]({ prompt: "Goal: inspect the project." }, ctx);
  assert.equal(result, undefined, "persisted GoalRun state does not create a full-state model message");
  const a = serialize(await runner.emitContext(first));
  const b = serialize(await runner.emitContext(second));
  assert.deepEqual(b.slice(0, a.length), a);
  assert.deepEqual(a[0].tools.map((entry) => entry.name), ["read"]);
  assert.deepEqual(errors, []);
});

test("legacy Compass internals are excluded without folding system patches or dropping native wakes", async () => {
  const { runner, errors } = setup();
  const wakes = ["watch-condition", "watch-lost", "subagent-result"].map((customType, i) => ({
    role: "custom", customType, content: `Native evidence ${i}`, display: true, timestamp: 10 + i,
  }));
  const old = ["pi-compass-v2.goalrun-state", "pi-compass-v2.goalrun-anchor", "pi-compass-v2.conventions"].map((customType) => ({
    role: "custom", customType, content: "Old internal state", display: false, timestamp: 8,
  }));
  const projected = await runner.emitContext([...second, ...old, ...wakes]);
  assert.deepEqual(projected, [...second, ...wakes]);
  assert.equal(projected.filter((message) => message.role === "system").length, 2);
  assert.deepEqual(errors, []);
});
