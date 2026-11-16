import { mkdirSync, statSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function emptyState() {
  return { schemaVersion: 1, revision: 0, rules: [] };
}

export class GuardStore {
  constructor({ path, normalize }) {
    if (typeof path !== 'string' || !path) throw new TypeError('path must be a non-empty string');
    if (typeof normalize !== 'function') throw new TypeError('normalize must be a function');
    this.path = path;
    this.normalize = normalize;
    this.db = null;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) throw new Error('GuardStore is closed');
  }

  #normalize(state) {
    const value = this.normalize(state);
    if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.rules)) {
      throw new TypeError('normalize must return schemaVersion 1, a non-negative integer revision, and rules array');
    }
    return value;
  }

  #exists() {
    let current;
    try { current = statSync(this.path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (this.db) throw new Error('Guard store disappeared; restore it or reload the runtime explicitly');
      return false;
    }
    if (this.identity && (current.dev !== this.identity.dev || current.ino !== this.identity.ino)) throw new Error('Guard store was replaced; reload the runtime explicitly');
    return true;
  }

  #open() {
    this.#assertOpen();
    if (this.db) return this.db;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const existed = (() => { try { statSync(this.path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } })();
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(this.path, { timeout: 0 });
    try {
      if (!existed) chmodSync(this.path, 0o600);
      db.exec('PRAGMA busy_timeout=0;');
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) throw new Error(`Unsupported guard store schema version ${version}`);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='namespaces'").get();
      if (version === 0 && (tables || existed)) throw new Error('Corrupt guard store: schema version 0 is only valid for a new database');
      if (version === 0) {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec('CREATE TABLE namespaces (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, rules TEXT NOT NULL); PRAGMA user_version=1; COMMIT;');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      } else if (!tables) {
        throw new Error('Corrupt guard store: namespaces table is missing');
      } else {
        const columns = db.prepare('PRAGMA table_info(namespaces)').all().map(column => column.name);
        if (!['key', 'revision', 'rules'].every(name => columns.includes(name))) throw new Error('Corrupt guard store: invalid namespaces table');
      }
      db.exec('PRAGMA journal_mode=WAL;');
      this.db = db;
      this.identity = statSync(this.path);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  snapshot(keys) {
    this.#assertOpen();
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) throw new TypeError('keys must be an array of strings');
    if (!this.#exists()) return keys.map(() => emptyState());
    if (keys.length === 0) return [];
    const db = this.#open();
    db.exec('BEGIN');
    try {
      const placeholders = keys.map(() => '?').join(',');
      const rows = db.prepare(`SELECT key, revision, rules FROM namespaces WHERE key IN (${placeholders})`).all(...keys);
      const byKey = new Map(rows.map(row => [row.key, row]));
      const states = keys.map(key => {
        const row = byKey.get(key);
        if (!row) return this.#normalize(emptyState());
        let rules;
        try { rules = JSON.parse(row.rules); } catch { throw new Error(`Corrupt guard store snapshot for namespace ${key}`); }
        const state = this.#normalize({ schemaVersion: 1, revision: row.revision, rules });
        if (state.revision !== row.revision || JSON.stringify(state.rules) !== row.rules) throw new Error(`Corrupt guard store snapshot for namespace ${key}`);
        return state;
      });
      db.exec('COMMIT');
      return states;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  versions(keys) {
    this.#assertOpen();
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) throw new TypeError('keys must be an array of strings');
    if (keys.length === 0) return [];
    if (!this.#exists()) return keys.map(() => 0);
    const db = this.#open();
    const placeholders = keys.map(() => '?').join(',');
    const rows = db.prepare(`SELECT key, revision FROM namespaces WHERE key IN (${placeholders})`).all(...keys);
    const revisions = new Map(rows.map(row => [row.key, row.revision]));
    return keys.map(key => revisions.get(key) ?? 0);
  }

  mutate(key, expectedRevision, updater) {
    this.#assertOpen();
    if (typeof key !== 'string' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof updater !== 'function') throw new TypeError('invalid mutate arguments');
    this.#exists();
    const db = this.#open();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT revision, rules FROM namespaces WHERE key = ?').get(key);
      const current = row ? this.#normalize({ schemaVersion: 1, revision: row.revision, rules: JSON.parse(row.rules) }) : this.#normalize(emptyState());
      if (current.revision !== expectedRevision) throw new Error(`Stale revision: expected ${expectedRevision}, actual ${current.revision}`);
      const revision = current.revision;
      const before = JSON.stringify(current.rules);
      const original = this.#normalize({ schemaVersion: 1, revision, rules: JSON.parse(before) });
      const proposed = this.#normalize(updater(current));
      const after = JSON.stringify(proposed.rules);
      if (before === after) {
        db.exec('ROLLBACK');
        return { changed: false, state: original };
      }
      const state = this.#normalize({ schemaVersion: 1, revision: revision + 1, rules: proposed.rules });
      db.prepare('INSERT INTO namespaces(key, revision, rules) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision, rules=excluded.rules').run(key, state.revision, JSON.stringify(state.rules));
      db.exec('COMMIT');
      return { changed: true, state };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.db) { this.db.close(); this.db = null; }
  }
}
