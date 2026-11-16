import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { piRoot } from "../scripts/register-pi-host-typebox.mjs";
import { contextSearchSchema, contextToolSchema } from "../src/context-tool-schema.mjs";

const base = pathToFileURL(`${piRoot}/`);
const { validateToolArguments } = await import(new URL("node_modules/@earendil-works/pi-ai/dist/utils/validation.js", base));
const { renderToolSignature } = await import(new URL("node_modules/@earendil-works/pi-codemode/dist/declarations.js", base));
const schema = contextToolSchema();
const tool = { name: "compass_context", parameters: schema };
const searchTool = { name: "compass_context_search", parameters: contextSearchSchema() };
const validate = (definition, args) => validateToolArguments(definition, { name: definition.name, arguments: args });
const check = (operation) => validate(tool, { operation }).operation;
const values = { expectedRevision: 0, task: "local task", ids: ["source"], version: "a".repeat(24), versions: [{ id: "source", version: "a".repeat(24) }], handling: "handled", reason: "already checked", content: "replacement", range: { startLine: 1, endLine: 2 }, path: "artifacts/value.json", purpose: "retain evidence", watchIds: ["watch-1"], watchScope: "root" };

test("installed Pi validates action-specific fields, not a bag of optional parameters", () => {
  for (const variant of schema.properties.operation.anyOf.flatMap((branch) => branch.anyOf ?? [branch])) {
    const input = Object.fromEntries(variant.required.map((key) => [key, key === "action" ? variant.properties.action.enum[0] : values[key]]));
    if (variant.properties.ids?.minItems === 2) { input.ids = ["first", "second"]; input.versions = input.ids.map((id) => ({ id, version: values.version })); }
    assert.deepEqual(check(input), input);
    const variantTool = { ...tool, parameters: { ...schema, properties: { operation: variant } } };
    for (const key of variant.required) {
      const missing = { ...input };
      delete missing[key];
      assert.throws(() => validate(variantTool, { operation: missing }), undefined, `${input.action} requires ${key}`);
    }
    assert.throws(() => check({ ...input, unrelated: true }), undefined, `${input.action} rejects unrecognized fields`);
  }
  assert.throws(() => validate(tool, { action: "search" }), /operation/);
  assert.throws(() => check({ action: "search", expectedRevision: 0 }));
  assert.throws(() => check({ action: "pin", expectedRevision: 0, ids: [] }));
  assert.throws(() => check({ action: "load", expectedRevision: 0, ids: ["a", "b"], version: values.version }));
  assert.throws(() => check({ action: "move", expectedRevision: 0, ids: ["a"], version: values.version, range: {}, verifiedAgainst: { id: "b", version: values.version } }));
  assert.throws(() => check({ action: "spill", expectedRevision: 0, ids: ["a"], version: values.version, path: "a.json", purpose: "retain", range: {} }));
  assert.deepEqual(validate(searchTool, {}), {});
  assert.throws(() => validate(searchTool, { scope: "all" }));
  assert.throws(() => validate(searchTool, { expectedRevision: 0 }));
  assert.throws(() => validate(searchTool, { action: "pin", ids: ["source"] }));
  assert.throws(() => check({ action: "pin" }), (error) => {
    assert.match(error.message, /operation.ids: missing/);
    assert.match(error.message, /operation.expectedRevision: missing/);
    assert.doesNotMatch(error.message, /expected one of \["call"\]/);
    return true;
  });
  assert.equal(check({ action: "return", expectedRevision: "0", result: null }).expectedRevision, 0, "native coercion remains authoritative");
});

test("root-object provider shape retains operation validation and native Code Mode types", () => {
  // Anthropic's non-strict adapter preserves root properties/required, not root unions.
  const projected = { type: "object", properties: schema.properties, required: schema.required };
  assert.deepEqual(validate({ ...tool, parameters: projected }, { operation: { action: "call", expectedRevision: 0, task: "local" } }), { operation: { action: "call", expectedRevision: 0, task: "local" } });
  assert.throws(() => validate({ ...tool, parameters: projected }, { operation: { action: "spill" } }));
  const signature = renderToolSignature({ name: tool.name, inputSchema: schema });
  assert.doesNotMatch(signature, /args: unknown|operation: unknown/);
  assert.match(signature, /task: string/);
  assert.match(signature, /watchIds: Array<string>/);
  assert.ok(signature.length < 16000, "large declarations must not degrade to unknown");
});
