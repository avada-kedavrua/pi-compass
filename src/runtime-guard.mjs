import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { agentResult } from "./compass-result.mjs";
import { GuardStore } from "./runtime-guard-store.mjs";
import { GuardVM } from "./runtime-guard-vm.mjs";
import {
  GUARD_STATE_TYPE, GUARD_NOTICE_TYPE, GUARD_SCOPES, emptyGuardState,
  normalizeGuardState, normalizeGuardRule, matchesGuard, projectGuardEvent,
  guardCases, guardToolSchema,
} from "./runtime-guard-core.mjs";

const installed = new WeakMap();
const canonical = (cwd) => { try { return fs.realpathSync(cwd); } catch { return path.resolve(cwd); } };

function readGuard(view, op, scope, sessionId) {
  if (op.id) {
    if (op.cursor !== undefined) throw new Error("Use a cursor only for a guard listing, not with id.");
    const rule = view.states[scope].rules.find((item) => item.id === op.id);
    if (!rule) throw new Error(`Unknown guard ${scope}/${op.id}.`);
    return { scope, revision: view.states[scope].revision, rule };
  }
  const selected = op.scope ? [scope] : GUARD_SCOPES;
  const scopes = Object.fromEntries(selected.map((name) => [name, view.states[name].revision]));
  // Revisions can repeat on different native branches; the restore epoch can
  // also change on the same branch without changing any definitions.
  const identity = [view.store.path, scopes];
  if (Object.hasOwn(scopes, "local")) identity.push(view.project);
  if (Object.hasOwn(scopes, "session")) identity.push(sessionId, view.states.session.rules);
  const cursor = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
  if (op.cursor === cursor) return { unchanged: true, cursor };
  const rules = selected.flatMap((name) => view.states[name].rules.map(({ id, tools, effect }) => ({ scope: name, id, tools, effect })));
  return { cursor, scopes, rules };
}

function noticeLine({ tool, scope, id, effect, verdict, reason, hint, count }) {
  let action = effect === "block" ? "Blocked" : "Warned";
  if (verdict === "unknown") action += " (check unavailable)";
  const subject = [scope && `${scope}/${id}`, count > 1 && `${count} calls`].filter(Boolean).join(", ");
  const next = [reason, hint].filter(Boolean).join(" — ").replace(/\s+/g, " ").trim();
  return `- ${action} ${tool}${subject ? ` (${subject})` : ""}: ${next}`;
}

export class RuntimeGuards {
  constructor(pi, { profileDir, vm = new GuardVM() } = {}) {
    if (typeof profileDir !== "function" && (typeof profileDir !== "string" || !profileDir)) throw new Error("Runtime guards require the host profileDir provider.");
    this.pi = pi;
    this.profileDir = profileDir;
    this.vm = vm;
    this.session = emptyGuardState();
    this.epoch = 0;
    this.notices = new Map();
    this.pending = Promise.resolve();
    this.cache = null;
    this.omitted = 0;
  }
  restore(ctx) {
    this.epoch++;
    this.notices.clear();
    this.omitted = 0;
    try {
      if (!ctx.sessionManager?.getBranch) throw new Error("Native guard branch is unavailable.");
      const entry = ctx.sessionManager.getBranch().findLast((item) => item.type === "custom" && item.customType === GUARD_STATE_TYPE);
      this.session = entry ? normalizeGuardState(entry.data) : emptyGuardState();
      this.restoreError = null;
    } catch (error) { this.restoreError = error; }
  }
  async store() {
    this.storeReady ??= (async () => {
      const dir = typeof this.profileDir === "function" ? await this.profileDir() : this.profileDir;
      if (this.closed) throw new Error("Guard runtime is closed.");
      return this.database = new GuardStore({ path: path.join(dir, "runtime-guards.sqlite"), normalize: normalizeGuardState });
    })();
    return this.storeReady;
  }
  async snapshot(ctx) {
    const store = await this.store();
    const project = canonical(ctx.cwd ?? process.cwd());
    const keys = ["global", `local:${project}`];
    const versions = store.versions(keys);
    if (!this.cache || this.cache.project !== project || versions.some((rev, index) => rev !== this.cache.versions[index])) {
      const states = store.snapshot(keys);
      this.cache = { project, versions: states.map((s) => s.revision), states };
    }
    const states = { global: this.cache.states[0], local: this.cache.states[1], session: this.session };
    return { states, project, keys, store };
  }
  control(operation, ctx, signal = ctx.signal) {
    const epoch = this.epoch;
    const result = this.pending.then(() => {
      if (epoch !== this.epoch) throw new Error("Guard branch changed while the operation was queued; no state changed.");
      return this.#control(operation, ctx, signal);
    });
    this.pending = result.catch(() => {});
    return result;
  }
  async #cases(rule, cases, ctx, signal) {
    const checks = cases.map((item) => matchesGuard(rule, item.event.toolName)
      ? { source: rule.check, event: projectGuardEvent(rule, item.event, item.event.cwd ?? ctx.cwd) }
      : { source: 'e=>({verdict:"pass"})', event: {} });
    const results = await this.vm.evaluate(checks, { signal });
    return results.map((result, index) => result.verdict === cases[index].expected ? result : { ...result, expected: cases[index].expected });
  }
  async #validateRule(rule, ctx, signal) {
    const [compiled] = await this.vm.evaluate([{ source: rule.check, compileOnly: true }], { signal });
    if (compiled.verdict !== "pass" || compiled.error) throw new Error(`Invalid guard check: ${compiled.error ?? compiled.reason ?? "invalid function"}`);
    if (!rule.cases) return;
    const results = await this.#cases(rule, rule.cases, ctx, signal);
    const failed = results.flatMap(({ expected, verdict, error, reason }, index) => expected ? [`case ${index + 1}: expected ${expected}, got ${verdict}${error || reason ? ` (${error || reason})` : ""}`] : []);
    if (failed.length) throw new Error(`Guard cases failed: ${failed.join("; ")}`);
  }
  async #control(op, ctx, signal) {
    if (this.closed || signal?.aborted) throw new Error("Guard operation cancelled before activation.");
    if (!op || !["get", "put", "remove", "test"].includes(op.action)) throw new Error("Unknown guard operation.");
    if (this.restoreError) throw this.restoreError;
    const epoch = this.epoch;
    const scope = op.scope ?? "session";
    if (!GUARD_SCOPES.includes(scope)) throw new Error("scope must be global|local|session.");
    const view = await this.snapshot(ctx);
    if (epoch !== this.epoch) throw new Error("Guard branch changed during state loading; no state changed.");
    if (op.action === "get") return readGuard(view, op, scope, ctx.sessionManager?.getSessionId?.());
    if (op.action === "test") {
      const rule = view.states[scope].rules.find((item) => item.id === op.id);
      if (!rule) throw new Error(`Unknown guard ${scope}/${op.id}.`);
      const cases = await this.#cases(rule, guardCases(op.cases), ctx, signal);
      if (epoch !== this.epoch) throw new Error("Guard branch changed during testing.");
      return { cases };
    }
    const current = view.states[scope];
    if (op.expectedRevision !== current.revision) throw new Error(`Stale ${scope} scope revision: expected ${current.revision}, received ${op.expectedRevision}.`);
    const rule = op.action === "put" ? normalizeGuardRule(op.rule) : null;
    const id = rule?.id ?? op.id;
    const old = current.rules.find((item) => item.id === id);
    if (!rule && !old) throw new Error(`Unknown guard ${scope}/${id}.`);
    const key = scope === "global" ? view.keys[0] : view.keys[1];
    const names = new Set(rule ? (this.pi.getAllTools?.() ?? []).map((tool) => tool.name) : []);
    const unresolvedTargets = rule?.tools.filter((name) => name !== "*" && !names.has(name)) ?? [];
    const receipt = { scope, id, ...(unresolvedTargets.length ? { unresolvedTargets } : {}) };
    if (rule && JSON.stringify(old) === JSON.stringify(rule)) {
      if (scope !== "session") view.store.mutate(key, op.expectedRevision, (value) => value);
      return { resultStatus: "unchanged", ...receipt, revision: current.revision };
    }
    const rules = current.rules.filter((item) => item.id !== id);
    if (rule) {
      await this.#validateRule(rule, ctx, signal);
      rules.push(rule);
    }
    const candidate = normalizeGuardState({ ...current, revision: current.revision + 1, rules });
    if (epoch !== this.epoch) throw new Error("Guard branch changed during validation; no rule was activated.");
    if (this.closed || signal?.aborted) throw new Error("Guard operation cancelled before activation.");
    if (scope === "session") {
      if (this.session.revision !== op.expectedRevision) throw new Error("Session guard scope changed during validation.");
      try { this.pi.appendEntry(GUARD_STATE_TYPE, candidate); }
      catch (cause) {
        this.restore(ctx);
        const error = new Error("Session guard persistence outcome is unknown; get current state before retrying.", { cause });
        error.stateChanged = "unknown";
        throw error;
      }
      this.session = candidate;
    } else {
      view.store.mutate(key, op.expectedRevision, () => candidate);
      this.cache = null;
    }
    return { resultStatus: "applied", ...receipt, revision: candidate.revision };
  }
  note(event, hit) {
    const key = JSON.stringify([event.toolName, hit.scope, hit.id, hit.revision, hit.effect, hit.verdict, hit.reason, hit.hint]);
    const old = this.notices.get(key);
    if (old) { old.count++; return; }
    if (this.notices.size < 16) this.notices.set(key, { tool: event.toolName, ...hit, count: 1 });
    else this.omitted++;
  }
  block(event, reason, epoch) {
    if (epoch === this.epoch && event.parentToolCallId) this.note(event, { effect: "block", verdict: "unknown", reason });
    return { block: true, reason };
  }
  async check(event, ctx) {
    if (event.toolName === "runtime_guard") return;
    const epoch = this.epoch;
    let view;
    try {
      if (this.restoreError) throw this.restoreError;
      view = await this.snapshot(ctx);
      if (epoch !== this.epoch) return this.block(event, "Guard branch changed during state loading. This call was not executed.", epoch);
      const selected = GUARD_SCOPES.flatMap((scope) => view.states[scope].rules.filter((rule) => matchesGuard(rule, event.toolName)).map((rule) => ({ scope, revision: view.states[scope].revision, rule })));
      if (!selected.length) return;
      const checks = selected.map(({ rule }) => {
        try { return { source: rule.check, event: projectGuardEvent(rule, event, ctx.cwd) }; }
        catch (error) { return { source: `e=>({verdict:"unknown",reason:${JSON.stringify(String(error.message).slice(0, 240))}})`, event: {} }; }
      });
      let results;
      try { results = await this.vm.evaluate(checks, { signal: ctx.signal }); }
      catch (error) { results = selected.map(() => ({ verdict: "unknown", error: String(error.message).slice(0, 240) })); }
      const latest = view.store.versions(view.keys);
      if (epoch !== this.epoch || view.states.session.revision !== this.session.revision || latest.some((revision, index) => revision !== view.states[index === 0 ? "global" : "local"].revision)) {
        return this.block(event, "Guard scope changed during checking. This call was not executed; reassess with the current scope.", epoch);
      }
      let block;
      for (let index = 0; index < selected.length; index++) {
        const { scope, revision, rule } = selected[index];
        const result = results[index];
        if (result.verdict === "pass") continue;
        const reason = result.error ?? result.reason;
        const hit = { scope, id: rule.id, revision, effect: rule.effect, verdict: result.verdict, ...(reason && reason !== rule.hint ? { reason } : {}), hint: rule.hint };
        if (rule.effect === "warn" || event.parentToolCallId) this.note(event, hit);
        if (rule.effect === "block" && !block) block = { block: true, reason: `Guard ${scope}/${rule.id}@${revision} ${result.verdict === "violation" ? "blocked" : "could not check"}: ${hit.reason ? `${hit.reason}. ` : ""}${rule.hint}` };
      }
      return block;
    } catch (error) { return this.block(event, `Guard runtime unavailable; call not executed. Reload the extension or repair its host/store. ${String(error.message).slice(0, 240)}`, epoch); }
  }
  flush(event) {
    if (!this.notices.size) return;
    const lines = ["Runtime guard"];
    let bytes = Buffer.byteLength(lines[0]);
    for (const hit of this.notices.values()) {
      const line = noticeLine(hit);
      const size = Buffer.byteLength(line) + 1;
      if (bytes + size > 1840) this.omitted += hit.count;
      else { lines.push(line); bytes += size; }
    }
    if (this.omitted) lines.push(`- ${this.omitted} more calls omitted.`);
    const content = lines.join("\n");
    this.notices.clear();
    this.omitted = 0;
    return { entries: [...(event.entries ?? []), { type: "custom_message", customType: GUARD_NOTICE_TYPE, content, display: false }] };
  }
  async close() {
    this.closed = true;
    await this.vm.close();
    const store = await this.storeReady?.catch(() => null);
    store?.close();
  }
}

export function registerRuntimeGuards(pi, options) {
  if (installed.has(pi)) return installed.get(pi);
  const guards = new RuntimeGuards(pi, options);
  installed.set(pi, guards);
  pi.registerTool({
    name: "runtime_guard", label: "Runtime Guards",
    description: "Register/refine/remove scoped Agent-written pure JS checks. Native tool_call boundary only (direct and Code Mode nested); later plugin input mutations and independent children are outside coverage. get lists compact IDs/scope revisions; get+id fetches code. put validates code/cases then activates immediately for subsequent admissions. warn leaves business results intact and sends a boundary notice; block prevents execution but returns an error. Default session scope, local/global persist in this profile; local never overrides global. No automatic semantic inference, retries, or filesystem rollback.",
    promptSnippet: "Compile only worthwhile mechanical requirements into runtime guards; reuse IDs/revisions, do not register every turn or read full rules routinely.",
    parameters: guardToolSchema(),
    async execute(_id, args, signal, ...rest) {
      const ctx = rest.findLast((item) => item?.sessionManager) ?? {};
      try { return agentResult(await guards.control(args.operation, ctx, signal)); }
      catch (error) { return { ...agentResult({ stateChanged: error.stateChanged ?? false, error: String(error.message) }), isError: true }; }
    },
  });
  for (const name of ["session_start", "session_tree", "before_agent_start"]) pi.on(name, (_event, ctx) => guards.restore(ctx));
  pi.on("tool_call", (event, ctx) => guards.check(event, ctx));
  pi.on("turn_end", (event) => guards.flush(event));
  pi.on("session_shutdown", () => guards.close());
  return guards;
}
