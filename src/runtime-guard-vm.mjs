import { Worker } from "node:worker_threads";

// One lazy worker; fresh public Code Mode VMs inside it. This is a bounded CPU
// queue, not an Agent loop. A timeout terminates the worker before reuse.
export class GuardVM {
  #worker;
  #ready = false;
  #idle;
  #active;
  #queue = [];
  #closed = false;
  #sequence = 0;
  #stopping;
  #idleMs;
  #createWorker;

  constructor({ idleMs = 30000, createWorker = (...args) => new Worker(...args) } = {}) {
    this.#idleMs = idleMs;
    this.#createWorker = createWorker;
  }

  evaluate(checks, { signal, timeoutMs = 1000 } = {}) {
    if (!checks.length) return Promise.resolve([]);
    if (this.#closed) return Promise.reject(new Error("Guard evaluator is closed"));
    if (signal?.aborted) return Promise.reject(new Error("Guard evaluation aborted"));
    if (this.#queue.length >= 16) return Promise.reject(new Error("Guard evaluator capacity exceeded"));
    return new Promise((resolve, reject) => {
      const job = { id: ++this.#sequence, checks, resolve, reject, signal };
      job.abort = () => this.#fail(job, new Error("Guard evaluation aborted"));
      job.timer = setTimeout(() => this.#fail(job, new Error("Guard evaluation deadline exceeded")), timeoutMs);
      signal?.addEventListener("abort", job.abort, { once: true });
      this.#queue.push(job);
      this.#pump();
    });
  }

  #settle(job, error, results) {
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.abort);
    if (error) job.reject(error); else job.resolve(results);
  }

  #fail(job, error) {
    if (this.#active === job) {
      this.#active = undefined;
      this.#settle(job, error);
      this.#retire();
    } else {
      const index = this.#queue.indexOf(job);
      if (index < 0) return;
      this.#queue.splice(index, 1);
      this.#settle(job, error);
    }
  }

  #pump() {
    if (this.#closed || this.#active || this.#stopping || !this.#queue.length) return;
    clearTimeout(this.#idle);
    const job = this.#queue.shift();
    this.#active = job;
    try {
      if (!this.#worker) {
        const worker = this.#createWorker(new URL("./runtime-guard-worker.mjs", import.meta.url), {
          execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
        });
        this.#worker = worker;
        this.#ready = false;
        worker.on("message", (message) => {
          if (this.#worker !== worker) return;
          if (message.ready) {
            this.#ready = true;
            if (this.#active) worker.postMessage({ id: this.#active.id, checks: this.#active.checks });
          } else if (message.id === this.#active?.id) {
            const current = this.#active;
            this.#active = undefined;
            this.#settle(current, message.error ? new Error(message.error) : null, message.results);
            worker.unref();
            this.#pump();
            if (!this.#active && !this.#queue.length) {
              this.#idle = setTimeout(() => this.#retire(), this.#idleMs);
              this.#idle.unref();
            }
          }
        });
        worker.on("error", (error) => {
          if (this.#worker !== worker || !this.#active) return;
          const failure = error.code === "ERR_MODULE_NOT_FOUND"
            ? new Error("Guard sandbox dependency missing. Run npm ci --ignore-scripts --omit=peer in the Compass checkout, then rerun /compass-preflight.", { cause: error })
            : error;
          this.#fail(this.#active, failure);
        });
        worker.on("exit", () => {
          if (this.#worker !== worker) return;
          this.#worker = undefined;
          if (this.#active) this.#fail(this.#active, new Error("Guard worker exited without a verdict"));
        });
      }
      this.#worker.ref();
      if (this.#ready) this.#worker.postMessage({ id: job.id, checks: job.checks });
    } catch (error) { this.#fail(job, error); }
  }

  #retire() {
    void this.#stop().then(() => this.#pump(), (failure) => {
      this.#closed = true;
      for (const queued of this.#queue.splice(0)) this.#settle(queued, failure);
    });
  }

  #stop() {
    if (this.#stopping) return this.#stopping;
    const worker = this.#worker;
    this.#worker = undefined;
    this.#ready = false;
    clearTimeout(this.#idle);
    this.#stopping = (worker ? worker.terminate() : Promise.resolve()).finally(() => { this.#stopping = undefined; });
    return this.#stopping;
  }

  async close() {
    this.#closed = true;
    for (const job of this.#queue.splice(0)) this.#settle(job, new Error("Guard evaluator closed"));
    if (this.#active) {
      this.#settle(this.#active, new Error("Guard evaluator closed"));
      this.#active = undefined;
    }
    await this.#stop();
  }
}
