import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

function piPackageRoots() {
  const roots = [];
  if (process.env.PI_CODING_AGENT_PACKAGE_ROOT) roots.push(path.resolve(process.env.PI_CODING_AGENT_PACKAGE_ROOT));
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    if (globalRoot) roots.push(path.join(globalRoot, "@earendil-works", "pi-coding-agent"));
  } catch {}
  try {
    const executable = execFileSync("which", ["pi"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    if (executable) {
      const realExecutable = fs.realpathSync(executable);
      roots.push(path.resolve(path.dirname(realExecutable), "../.."));
    }
  } catch {}
  return [...new Set(roots)];
}

function isPiPackageRoot(candidate) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8"));
    return manifest.name === "@earendil-works/pi-coding-agent"
      && fs.existsSync(path.join(candidate, "node_modules", "typebox", "package.json"));
  } catch {
    return false;
  }
}

export const piRoot = piPackageRoots().find(isPiPackageRoot);
const hostParentURL = piRoot ? pathToFileURL(path.join(piRoot, "package.json")).href : null;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "typebox" || specifier.startsWith("typebox/") || specifier === "@earendil-works/pi-coding-agent") {
      if (!hostParentURL) {
        throw new Error(
          "Cannot locate Pi's host-provided TypeBox. Install Pi >=1.4.0 or set PI_CODING_AGENT_PACKAGE_ROOT to the @earendil-works/pi-coding-agent package directory. Do not install TypeBox into the Compass package.",
        );
      }
      return nextResolve(specifier, { ...context, parentURL: hostParentURL });
    }
    return nextResolve(specifier, context);
  },
});
