// A stand-in for Cloudflare D1 using Node's built-in SQLite, with all migrations applied.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

export function fakeD1(extraEnv = {}) {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { db, DB: { prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); } }, ...extraEnv };
}
