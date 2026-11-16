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
    const { stdout } = await run(process.execPath, [fileURLToPath(new URL("./helpers/native-compass-consumer.mjs", import.meta.url)), pathToFileURL(path.join(piRoot, "dist/index.js")).href, entry, cwd], {
      env: { ...process.env, NODE_OPTIONS: "", PI_CODING_AGENT_DIR: path.join(cwd, "profile") },
      timeout: 15000,
    });
    assert.match(stdout, /profile storage passed/);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
