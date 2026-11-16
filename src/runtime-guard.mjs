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

export class RuntimeGuards {
  constructor(pi, { profileDir, vm = new GuardVM() } = {}) {
    this.pi = pi;
    this.profileDir = profileDir;
    this.vm = vm;
    this.session = emptyGuardState();
    this.epoch = 0;
    this.notices = new Map();
    this.parents = new Map();
    this.pending = Promise.resolve();
    this.cache = null;
    this.omitted = 0;
  }
  restore(ctx) {
    this.epoch++;
    this.notices.clear();
    this.parents.clear();
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
      const dir = typeof this.profileDir === "function" ? await this.profileDir()
        : this.profileDir ?? (await import("@earendil-works/pi-coding-agent")).getAgentDir();
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
    const scopeKey = ctx.sessionManager?.getSessionId?.() ?? "native-session";
    const cursor = createHash("sha256").update(JSON.stringify([store.path, project, scopeKey, ...GUARD_SCOPES.map((s) => states[s].revision), this.epoch])).digest("hex").slice(0, 32);
    return { states, cursor, project, keys, store };
  }
  control(operation, ctx, signal = ctx.signal) {
    const result = this.pending.then(() => this.#control(operation, ctx, signal));
    this.pending = result.catch(() => {});
    return result;
  }
  async #cases(rule, cases, ctx, signal) {
    const checks = cases.map((item) => matchesGuard(rule, item.event.toolName)
      ? { source: rule.check, event: projectGuardEvent(rule, item.event, item.event.cwd ?? ctx.cwd) }
      : { source: 'e=>({verdict:"pass"})', event: {} });
    const results = await this.vm.evaluate(checks, { signal });
    return results.map((result, index) => ({ index, expected: cases[index].expected, ...result, passed: result.verdict === cases[index].expected }));
  }
  async #control(op, ctx, signal) {
    if (this.closed || signal?.aborted) throw new Error("Guard operation cancelled before activation.");
    if (!op || !["get", "put", "remove", "test"].includes(op.action)) throw new Error("Unknown guard operation.");
    if (this.restoreError) throw this.restoreError;
    const epoch = this.epoch;
    const scope = op.scope ?? "session";
    if (!GUARD_SCOPES.includes(scope)) throw new Error("scope must be global|local|session.");
    const view = await this.snapshot(ctx);
    if (op.action === "get") {
      if (op.scope) view.cursor = createHash("sha256").update(`${view.cursor}:${scope}`).digest("hex").slice(0, 32);
      if (op.cursor === view.cursor && !op.id) return { cursor: view.cursor, unchanged: true };
      if (op.id) {
        const rule = view.states[scope].rules.find((item) => item.id === op.id);
        if (!rule) throw new Error(`Unknown guard ${scope}/${op.id}.`);
        return { scope, revision: view.states[scope].revision, rule, cursor: view.cursor };
      }
      return { cursor: view.cursor, coverage: "tool_call observed inputs; direct and nested, not post-plugin final inputs or independent child processes", scopes: Object.fromEntries(GUARD_SCOPES.map((s) => [s, view.states[s].revision])),
        rules: GUARD_SCOPES.filter((s) => !op.scope || s === scope).flatMap((s) => view.states[s].rules.map(({ id, tools, effect }) => ({ scope: s, id, tools, effect }))) };
    }
    if (op.action === "test") {
      const rule = view.states[scope].rules.find((item) => item.id === op.id);
      if (!rule) throw new Error(`Unknown guard ${scope}/${op.id}.`);
      return { stateChanged: false, cases: await this.#cases(rule, guardCases(op.cases), ctx, signal) };
    }
    const current = view.states[scope];
    if (op.expectedRevision !== current.revision) throw new Error(`Stale ${scope} scope revision: expected ${current.revision}, received ${op.expectedRevision}.`);
    let rules;
    if (op.action === "put") {
      const rule = normalizeGuardRule(op.rule);
      // Identical definitions need no VM or persistence round trip.
      const old = current.rules.find((item) => item.id === rule.id);
      if (JSON.stringify(old) === JSON.stringify(rule)) {
        if (epoch !== this.epoch) throw new Error("Guard branch changed during registration.");
        if (scope !== "session") view.store.mutate(scope === "global" ? "global" : `local:${view.project}`, op.expectedRevision, (value) => value);
        return { resultStatus: "unchanged", scope, id: rule.id, revision: current.revision, cursor: view.cursor };
      }
      const compiled = await this.vm.evaluate([{ source: rule.check, compileOnly: true }], { signal });
      if (compiled[0].verdict !== "pass" || compiled[0].error) throw new Error(`Invalid guard check: ${compiled[0].error ?? compiled[0].reason ?? "invalid function"}`);
      if (rule.cases) {
        const failed = (await this.#cases(rule, rule.cases, ctx, signal)).filter((item) => !item.passed);
        if (failed.length) throw new Error(`Guard cases failed: ${JSON.stringify(failed)}`);
      }
      rules = [...current.rules.filter((item) => item.id !== rule.id), rule];
    } else {
      if (!current.rules.some((item) => item.id === op.id)) throw new Error(`Unknown guard ${scope}/${op.id}.`);
      rules = current.rules.filter((item) => item.id !== op.id);
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
      view.store.mutate(scope === "global" ? "global" : `local:${view.project}`, op.expectedRevision, () => candidate);
      this.cache = null;
    }
    try {
      const next = await this.snapshot(ctx);
      if (epoch !== this.epoch) throw new Error("The native branch changed after the guard committed.");
      const names = new Set((this.pi.getAllTools?.() ?? []).map((tool) => tool.name));
      const unresolvedTargets = op.action === "put" ? op.rule.tools.filter((name) => name !== "*" && !names.has(name)) : [];
      return { resultStatus: "applied", scope, id: op.rule?.id ?? op.id, revision: next.states[scope].revision, ...(next.states[scope].revision !== candidate.revision ? { appliedRevision: candidate.revision } : {}), cursor: next.cursor, ...(unresolvedTargets.length ? { unresolvedTargets } : {}) };
    } catch (cause) {
      const error = new Error("Guard committed but receipt refresh failed; get current state before another mutation.", { cause });
      error.stateChanged = true;
      throw error;
    }
  }
  note(event, hit) {
    let root = event.toolCallId;
    for (let depth = 0; depth < 32 && this.parents.get(root); depth++) root = this.parents.get(root);
    const key = JSON.stringify([root, hit.scope, hit.id, hit.revision, hit.effect, hit.verdict, hit.reason]);
    const old = this.notices.get(key);
    if (old) { old.count++; return; }
    if (this.notices.size < 16) this.notices.set(key, { toolCallId: root, ...hit, count: 1 });
    else this.omitted++;
  }
  block(event, reason) {
    if (event.parentToolCallId) this.note(event, { runtimeError: true, effect: "block", verdict: "unknown", reason });
    return { block: true, reason };
  }
  async check(event, ctx) {
    if (event.toolName === "runtime_guard") return;
    this.parents.set(event.toolCallId, event.parentToolCallId ?? null);
    const epoch = this.epoch;
    let view;
    try {
      if (this.restoreError) throw this.restoreError;
      view = await this.snapshot(ctx);
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
        return this.block(event, "Guard scope changed during checking. This call was not executed; reassess with the current scope.");
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
    } catch (error) { return this.block(event, `Guard runtime unavailable; call not executed. Repair via runtime_guard. ${String(error.message).slice(0, 240)}`); }
  }
  flush(event) {
    this.parents.clear();
    if (!this.notices.size) return;
    const hits = [];
    for (const hit of this.notices.values()) {
      if (Buffer.byteLength(JSON.stringify([...hits, hit])) <= 1900) hits.push(hit);
      else this.omitted += hit.count;
    }
    const content = JSON.stringify({ runtimeGuard: "notice", hits, ...(this.omitted ? { omitted: this.omitted } : {}) });
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
      catch (error) { return { ...agentResult({ resultStatus: error.stateChanged === true ? "applied" : error.stateChanged === "unknown" ? "unknown" : "rejected", stateChanged: error.stateChanged ?? false, error: String(error.message) }), isError: true }; }
    },
  });
  for (const name of ["session_start", "session_tree", "before_agent_start"]) pi.on(name, (_event, ctx) => guards.restore(ctx));
  pi.on("tool_call", (event, ctx) => guards.check(event, ctx));
  pi.on("turn_end", (event) => guards.flush(event));
  pi.on("session_shutdown", () => guards.close());
  return guards;
}
