import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { piRoot } from "../scripts/register-pi-host-typebox.mjs";
import compass from "../src/index.ts";
import { revisePlanState } from "../src/goal-run.mjs";
import { DELEGATION_EVENTS } from "../src/execution-orchestrator.mjs";
import { PLAN_STOP_MESSAGE_TYPE } from "../src/context-core.mjs";
import { approveDefinitions, createGoalState } from "./helpers/goal-state.mjs";

const host = pathToFileURL(`${piRoot}/`);
const { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(new URL("dist/index.js", host));
const { createAssistantMessageEventStream } = await import(new URL("node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js", host));
const snapshotType = "pi-compass-v2.goalrun";
const model = {
  id: "fixture", name: "Fixture", api: "openai-completions", provider: "fixture", baseUrl: "http://127.0.0.1:1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512,
};

function recordRequests(runtime, reply) {
  const contexts = [];
  // Only the model stream is injected; AgentSession owns all idle/wake,
  // transcript, extension, and turn scheduling behavior. No provider is called.
  runtime.streamSimple = (_model, context) => {
    contexts.push(context.messages);
    const stream = createAssistantMessageEventStream();
    const tool = reply?.(contexts.length);
    const content = tool ? [{ type: "toolCall", id: `fixture-${contexts.length}`, ...tool }] : [{ type: "text", text: "Fixture turn completed." }];
    const message = {
      role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: tool ? "toolUse" : "stop", timestamp: Date.now(),
    };
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end();
    return stream;
  };
  return contexts;
}

async function offlineSession(cwd, manager, extensionFactories, reply) {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, defaultTools: ["+codemode"] });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, extensionFactories });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: path.join(cwd, "models.json") });
  const calls = recordRequests(modelRuntime, reply);
  const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime, model, settingsManager, resourceLoader, sessionManager: manager });
  const errors = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  return { session, calls, errors };
}

function scopeStart(session) {
  return session.sendCustomMessage({ customType: "compass-test", content: "Begin the already-approved work.", display: false }, { triggerTurn: true });
}

test("the native idle session wakes once for a committed delegated throw, without a provider", { timeout: 5000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "compass-stop-host-"));
  const manager = SessionManager.inMemory(cwd);
  const childStarted = Promise.withResolvers();
  let respond;
  let session;
  try {
    const sourceId = manager.appendMessage({ role: "user", content: "Check the fixture route without changing files.", timestamp: Date.now() });
    const initial = createGoalState("Check the fixture route", { sourceId });
    manager.appendCustomEntry(snapshotType, approveDefinitions(revisePlanState(initial, { tasks: [
      { id: "inspect", executor: "subagent", agent: "scout", title: "Inspect route", acceptance: "Route observed", writeScope: "read-only", dispatchReason: "Use isolated context to inspect the route." },
      { id: "report", executor: "parent", title: "Report route", acceptance: "Report backed by evidence", dependsOn: ["inspect"] },
    ] }).state));
    const fixture = (pi) => {
      compass(pi, async () => ({ agent, context }) => ({ ok: true, contract: { agent: { name: agent }, context, intercomBridge: { active: false }, tools: { explicitAllowlist: true, effectiveAllowlist: ["read"], effectiveMcpTools: [], fanoutAuthorized: false } } }));
      pi.registerTool({ name: "subagent", label: "Fixture bridge", description: "Test registry entry; never executed", parameters: { type: "object", properties: {} }, execute() { throw new Error("unexpected native tool invocation"); } });
      pi.events.on(DELEGATION_EVENTS.request, ({ requestId, ownerRunId, nodeId, task, model: selected }) => {
        const identity = { requestId, ownerRunId, nodeId };
        if (!task) { pi.events.emit(DELEGATION_EVENTS.response, { ...identity, status: "invalid_request" }); return; }
        pi.events.emit(DELEGATION_EVENTS.started, identity);
        const response = { ...identity, model: selected, status: "completed", runId: "fixture-native-child", result: { kind: "structured", value: {
          status: "throw", summary: "Wrong route", evidence: ["fixture: missing configured route"], reason: "The route does not exist.", sideEffects: "None observed.",
        } } };
        respond = () => pi.events.emit(DELEGATION_EVENTS.response, response);
        childStarted.resolve();
      });
    };
    const fixtureHost = await offlineSession(cwd, manager, [fixture]);
    ({ session } = fixtureHost);
    const { calls, errors } = fixtureHost;
    await scopeStart(session);
    await childStarted.promise;
    assert.equal(session.isStreaming, false);
    assert.equal(calls.length, 1);
    const woken = Promise.withResolvers();
    session.subscribe((event) => { if (event.type === "agent_settled") woken.resolve(); });
    respond();
    respond();
    await woken.promise;
    assert.equal(calls.length, 2);
    assert.match(JSON.stringify(calls[1]), /Compass DAG stopped by child inspect: The route does not exist/);
    const branch = manager.getBranch();
    assert.equal(branch.filter((entry) => entry.customType === PLAN_STOP_MESSAGE_TYPE).length, 1);
    assert.equal(branch.findLast((entry) => entry.customType === snapshotType).data.plan.tasks[1].status, "pending");
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("MindStudio trace replay: native Code Mode blocks a stale start and never undoes an earlier successful call", { timeout: 5000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "compass-codemode-replay-"));
  const manager = SessionManager.inMemory(cwd);
  let session;
  try {
    const sourceId = manager.appendMessage({ role: "user", content: "Publish a smoke contract only after reviewing the plan.", timestamp: Date.now() });
    const draft = revisePlanState(createGoalState("Produce a smoke contract", { sourceId }), { tasks: [
      { id: "smoke-contract", executor: "code", title: "Check the smoke contract", acceptance: "Contract check recorded" },
      { id: "verify", executor: "code", dependsOn: ["smoke-contract"], title: "Verify dependency", acceptance: "Verification reported" },
    ] }).state;
    const signed = approveDefinitions(draft);
    manager.appendCustomEntry(snapshotType, signed);
    const planStart = 'await tools.compass_plan({action:"start",taskIds:["smoke-contract"]});';
    const script = (code) => ({ name: "codemode", arguments: { code } });
    const fixtureHost = await offlineSession(cwd, manager, [(pi) => compass(pi), createCodemodeExtension({ mode: "on" })], (request) => {
      if (request === 1) {
        // Recreate the field order: newer native input precedes execution but
        // Compass's observation hooks have not yet consumed the input.
        manager.appendMessage({ role: "user", content: "Is the plan ready?", timestamp: Date.now() });
        return script(planStart);
      }
      if (request === 2) return { name: "compass_goal", arguments: { action: "update" } };
      if (request === 3) return script(`${planStart}\nawait tools.compass_context({action:"call",task:"Unsupported nested frame"});`);
      return undefined;
    });
    ({ session } = fixtureHost);
    await scopeStart(session);
    const branch = manager.getBranch();
    assert.equal(fixtureHost.calls.length, 4, "one stale rejection, one review, one authorized batch, one final reply");
    const results = branch.filter((entry) => entry.message?.toolName === "codemode").map(({ message }) => message);
    assert.equal(results.length, 2);
    assert.match(JSON.stringify(results[0].content), /Review the latest Human input.*compass_goal/);
    assert.match(JSON.stringify(results[1].content), /compass_context does not exist/);
    assert.match(JSON.stringify(results[1].content), /compass_plan \(ok\)/);
    const latest = branch.findLast((entry) => entry.customType === snapshotType).data;
    assert.equal(latest.plan.approval.requestId, signed.plan.approval.requestId, "unchanged review does not request another stamp");
    assert.deepEqual(latest.plan.tasks.map(({ status }) => status), ["in_progress", "pending"]);
    assert.deepEqual(fixtureHost.errors, []);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
