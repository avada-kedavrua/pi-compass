#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { piRoot } from "./register-pi-host-typebox.mjs";
import { contextSearchSchema, contextToolSchema } from "../src/context-tool-schema.mjs";

const { renderToolSignature } = await import(new URL("node_modules/@earendil-works/pi-codemode/dist/declarations.js", pathToFileURL(`${piRoot}/`)));
const mutations = contextToolSchema();
const search = contextSearchSchema();
const signature = renderToolSignature({ name: "compass_context_search", inputSchema: search });
console.log(JSON.stringify({
  parameterBytes: Buffer.byteLength(JSON.stringify(mutations)) + Buffer.byteLength(JSON.stringify(search)),
  codemodeSearchSignatureChars: signature.length,
  inputTypePreserved: !signature.includes("args: unknown"),
  mutationActions: mutations.properties.operation.anyOf.length,
  mutationCases: mutations.properties.operation.anyOf.flatMap((branch) => branch.anyOf ?? [branch]).length,
  searchTools: 1,
}));
