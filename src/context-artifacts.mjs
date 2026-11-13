import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { contentVersion } from "./context-values.mjs";

const FORMAT = "pi-compass-v2.context-artifact";
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function withArtifactTarget(projectRoot, relativePath, fn) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\")) throw new Error("Artifact path must be project-root relative.");
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("Artifact path may not contain dot, parent or empty segments.");
  // Node has no openat/openat2 interface. Linux descriptor paths let each single
  // component be opened with NOFOLLOW, while a held parent descriptor prevents
  // a concurrent ancestor-to-symlink replacement from redirecting the next open.
  // Other platforms fail closed instead of silently using a check/open race.
  if (process.platform !== "linux") throw new Error("Race-safe context artifacts require Linux /proc/self/fd; no artifact was opened.");
  const root = await realpath(projectRoot);
  const directories = [];
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    directories.push(await open(root, flags));
    if (await realpath(`/proc/self/fd/${directories[0].fd}`) !== root) throw new Error("Artifact root changed during resolution.");
    for (const segment of segments.slice(0, -1)) {
      directories.push(await open(`/proc/self/fd/${directories.at(-1).fd}/${segment}`, flags));
    }
    return await fn({ root, target: `/proc/self/fd/${directories.at(-1).fd}/${segments.at(-1)}` });
  } finally {
    await Promise.allSettled(directories.map((directory) => directory.close()));
  }
}
function validateSelection({ source, binding, version, purpose, caveats, provenance, content, range }) {
  if (typeof source !== "string" || !source || typeof binding !== "string" || !binding || !/^[a-f0-9]{24}$/.test(version)) throw new Error("Artifact requires exact source/binding/version identity.");
  if (typeof purpose !== "string" || !purpose.trim() || purpose.length > 1000) throw new Error("Artifact purpose must contain 1..1000 characters.");
  if (!Array.isArray(caveats) || caveats.length > 12 || caveats.some((item) => typeof item !== "string" || item.length > 600)) throw new Error("Invalid artifact caveats.");
  if (!Array.isArray(provenance) || provenance.length > 32 || provenance.some((item) => typeof item !== "string")) throw new Error("Invalid artifact provenance.");
  if (content === undefined || (!range && contentVersion(content) !== version)) throw new Error("Artifact content does not match the full source version.");
  if (range !== null && (!range || typeof range !== "object" || !Number.isInteger(range.part) || range.part < 0)) throw new Error("Invalid artifact range.");
}
async function verifiedRead(request, descriptor) {
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256) || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1) throw new Error("An immutable artifact digest and byte length are required.");
  const bytes = await withArtifactTarget(request.projectRoot, request.relativePath, async ({ root, target }) => {
    if (descriptor.projectRoot !== root) throw new Error("Artifact belongs to a different project root.");
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== descriptor.bytes) throw new Error("Artifact byte length or file type changed.");
      return await handle.readFile();
    } finally { await handle.close(); }
  });
  if (bytes.byteLength !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) throw new Error("Artifact digest or byte length does not verify.");
  let envelope;
  try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Artifact is not valid UTF-8 JSON."); }
  if (envelope?.format !== FORMAT || envelope.formatVersion !== 1 || !envelope.manifest) throw new Error("Unsupported artifact format.");
  const manifest = envelope.manifest;
  validateSelection({ ...manifest, content: envelope.content });
  if (contentVersion(envelope.content) !== manifest.contentVersion) throw new Error("Artifact payload version does not verify.");
  for (const key of ["source", "binding", "version", "purpose"]) if (request[key] !== undefined && manifest[key] !== request[key]) throw new Error(`Artifact ${key} does not match the requested value.`);
  if (request.range !== undefined && JSON.stringify(manifest.range) !== JSON.stringify(request.range)) throw new Error("Artifact range does not match the requested selection.");
  return { manifest, content: envelope.content, verified: true, path: request.relativePath };
}
export async function writeContextArtifact({ projectRoot, relativePath, source, binding, version, range = null, purpose, caveats = [], provenance = [], content }) {
  let created = false;
  try {
    const manifest = { source, binding, version, range, purpose, caveats: [...caveats], provenance: [...provenance], contentVersion: contentVersion(content) };
    validateSelection({ ...manifest, content });
    const bytes = Buffer.from(JSON.stringify({ format: FORMAT, formatVersion: 1, manifest, content }), "utf8");
    const root = await withArtifactTarget(projectRoot, relativePath, async ({ root, target }) => {
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      return root;
    });
    // The receipt covers the complete envelope, including caveats/provenance,
    // not just payload bytes whose metadata could otherwise be changed silently.
    const artifact = { path: relativePath, projectRoot: root, sha256: sha256(bytes), bytes: bytes.byteLength, ...manifest };
    const loaded = await verifiedRead({ projectRoot, relativePath, source, binding, version, range, purpose }, artifact);
    return { ok: true, artifact, content: loaded.content, contextChanged: false };
  } catch (error) {
    return { ok: false, error: error.message, contextChanged: false, possibleOrphan: created ? { path: relativePath, exists: true } : null };
  }
}
export async function loadContextArtifact({ projectRoot, relativePath, artifact, ...expected }) {
  if (!artifact || artifact.path !== relativePath) throw new Error("An exact artifact receipt is required; no history fallback was used.");
  return verifiedRead({ projectRoot, relativePath, ...expected }, artifact);
}
