import fs from "node:fs";
import path from "node:path";

function safeEntries(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !/(?:secret|credential|token|password|auth|private|\.env|\.key$)/i.test(name))
    .sort()
    .slice(0, 80);
}

function readFixture(root) {
  try {
    if (!fs.statSync(root).isDirectory()) return null;
    const rootEntries = safeEntries(root);
    const packageMeta = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const readmeHeading = fs.readFileSync(path.join(root, "README.md"), "utf8")
      .split(/\r?\n/)
      .find((line) => /^#\s+/.test(line))
      ?.replace(/^#\s+/, "")
      .trim() ?? "";
    if (!rootEntries.length || typeof packageMeta?.name !== "string" || !packageMeta.name
      || typeof packageMeta?.version !== "string" || !packageMeta.version || !readmeHeading) return null;
    return { root, rootEntries, packageMeta, readmeHeading };
  } catch {
    return null;
  }
}

/**
 * Resolve the read-only project fixture for the live Subagent smoke.
 * An explicit argument is authoritative. Without one, prefer the current
 * project and fall back to the Compass package so the command does not
 * require Pi to have been launched from a particular working directory.
 */
export function resolveLiveAcceptanceFixture({ args = "", cwd = process.cwd(), compassRoot } = {}) {
  const currentRoot = path.resolve(cwd);
  const requested = String(args ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
  const candidates = requested
    ? [path.resolve(currentRoot, requested)]
    : [currentRoot, ...(compassRoot ? [path.resolve(compassRoot)] : [])];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const fixture = readFixture(candidate);
    if (fixture) return { ...fixture, usedFallback: !requested && candidate !== currentRoot, explicit: Boolean(requested) };
  }
  return null;
}
