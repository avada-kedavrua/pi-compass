import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { piRoot } from "../scripts/register-pi-host-typebox.mjs";

const run = promisify(execFile);
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("unpatched Pi loader admits state reads and executes guard VM/storage through the production factory", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "compass-host-"));
  try {
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import path from "node:path";
      const { discoverAndLoadExtensions, ExtensionRunner, SessionManager, getAgentDir } = await import(process.argv[1]);
      const cwd = process.argv[3];
      const loaded = await discoverAndLoadExtensions([process.argv[2]], cwd, getAgentDir());
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, 1);
      const manager = SessionManager.inMemory(cwd);
      const tools = loaded.extensions[0].tools;
      let active = [...tools.keys()];
      Object.assign(loaded.runtime, {
        appendEntry: (type, data) => manager.appendCustomEntry(type, data),
        getActiveTools: () => active,
        setActiveTools: (names) => { active = names; },
        getAllTools: () => [...tools.values()].map(({ definition }) => definition),
      });
      const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, manager, undefined);
      const errors = [];
      runner.onError((error) => errors.push(error));
      try {
        await runner.emit({ type: "session_start" });
        const context = runner.createContext();
        assert.equal(await runner.emitToolCall({ type: "tool_call", toolName: "compass_state", toolCallId: "state", input: {} }), undefined);
        const state = await tools.get("compass_state").definition.execute("state", {}, undefined, undefined, context);
        assert.notEqual(state.isError, true);
        const control = async (operation) => {
          const result = await tools.get("runtime_guard").definition.execute("guard", { operation }, undefined, undefined, context);
          assert.notEqual(result.isError, true, JSON.stringify(result));
          return JSON.parse(result.content[0].text);
        };
        assert.deepEqual((await control({ action: "get" })).scopes, { global: 0, local: 0, session: 0 });
        assert.equal(fs.existsSync(path.join(getAgentDir(), "runtime-guards.sqlite")), false);
        const rule = { id: "host-check", tools: ["bash"], read: ["input.command"], effect: "block", check: 'e=>({verdict:e.input.command==="blocked"?"violation":"pass"})', hint: "Use an allowed command." };
        await control({ action: "put", scope: "global", expectedRevision: 0, rule });
        assert.equal(fs.existsSync(path.join(getAgentDir(), "runtime-guards.sqlite")), true);
        assert.equal((await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "blocked", input: { command: "blocked" } })).block, true);
        assert.equal(await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "allowed", input: { command: "allowed" } }), undefined);
        assert.deepEqual(errors, []);
        console.log("native factory, empty-policy read, owned VM and profile storage passed");
      } finally { await runner.emit({ type: "session_shutdown" }); }
    `, pathToFileURL(path.join(piRoot, "dist/index.js")).href, entry, cwd], {
      env: { ...process.env, NODE_OPTIONS: "", PI_CODING_AGENT_DIR: path.join(cwd, "profile") },
      timeout: 15000,
    });
    assert.match(stdout, /profile storage passed/);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
