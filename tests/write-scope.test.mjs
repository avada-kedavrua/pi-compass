import test from "node:test";
import assert from "node:assert/strict";
import { executionDriftReason, writeScopeMatches } from "../src/write-scope.mjs";

const root = "/tmp/project";

test("write scopes match exact files, directories, and conservative glob patterns", () => {
  assert.equal(writeScopeMatches("/tmp/project/src/a.ts", "src/a.ts", root), true);
  assert.equal(writeScopeMatches("/tmp/project/src/a.ts", "src", root), true);
  assert.equal(writeScopeMatches("/tmp/project/src/nested/a.ts", "src/**", root), true);
  assert.equal(writeScopeMatches("/tmp/project/src/a.ts", "src/*.ts", root), true);
  assert.equal(writeScopeMatches("/tmp/project/src/nested/a.ts", "src/*.ts", root), false);
  assert.equal(writeScopeMatches("/tmp/project/src/nested/a.ts", "src/**/*.ts", root), true);
  assert.equal(writeScopeMatches("/tmp/project/src/a.ts", "read-only", root), false);
  assert.equal(writeScopeMatches("/tmp/project/SRC/a.ts", "src/**", root), false, "POSIX path scopes are case-sensitive");
});

test("drift warning requires a writable in-progress task and checks declared path scopes", () => {
  assert.match(executionDriftReason({ tasks: [], target: "/tmp/project/src/a.ts", cwd: root }), /no writable DAG task/i);
  assert.match(executionDriftReason({ tasks: [{ id: "inspect", status: "in_progress", executor: "subagent", writeScope: "read-only" }], target: "/tmp/project/src/a.ts", cwd: root }), /no writable DAG task/i);
  assert.equal(executionDriftReason({ tasks: [{ id: "edit-a", status: "in_progress", executor: "code", writeScope: "src/**" }], target: "/tmp/project/src/a.ts", cwd: root }), "");
  assert.match(executionDriftReason({ tasks: [{ id: "edit-a", status: "in_progress", executor: "code", writeScope: "src/a.ts" }], target: "/tmp/project/src/b.ts", cwd: root }), /outside every declared scope/i);
  assert.equal(executionDriftReason({ tasks: [{ id: "edit-a", status: "in_progress", executor: "parent", writeScope: "" }], target: "/tmp/project/src/b.ts", cwd: root }), "", "an unscoped writer is not enough evidence to assert a path violation");
});
