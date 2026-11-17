#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { piRoot } from "./register-pi-host-typebox.mjs";
import { toolSchemas, COMPASS_TOOL_NAMES } from "../src/tool-schema.mjs";
import { guardToolSchema } from "../src/runtime-guard-core.mjs";

const { renderToolSignature } = await import(new URL("node_modules/@earendil-works/pi-codemode/dist/declarations.js", pathToFileURL(`${piRoot}/`)));
const schemas = { ...toolSchemas, runtime_guard: guardToolSchema() };
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const tools = COMPASS_TOOL_NAMES.map((name) => {
  const schema = schemas[name];
  const signature = renderToolSignature({ name, inputSchema: schema });
  return {
    name,
    schemaBytes: bytes(schema),
    signatureChars: signature.length,
    signatureInputPreserved: !signature.includes("args: unknown"),
    exclusiveActionCases: schema.anyOf?.flatMap((branch) => branch.anyOf ?? [branch]).length ?? null,
  };
});
console.log(JSON.stringify({
  toolCount: tools.length,
  schemaBytes: tools.reduce((sum, tool) => sum + tool.schemaBytes, 0),
  signatureChars: tools.reduce((sum, tool) => sum + tool.signatureChars, 0),
  maxSignatureChars: Math.max(...tools.map((tool) => tool.signatureChars)),
  tools,
}));
