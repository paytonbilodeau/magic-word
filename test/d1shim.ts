// Minimal D1 stand-in over node:sqlite so the real SQL runs in tests.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private params: unknown[] = []) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params);
  }
  rows<T>() {
    return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[] };
  }
  async all<T>() {
    return this.rows<T>();
  }
  async first<T>() {
    return (this.db.prepare(this.sql).get(...(this.params as never[])) as T) ?? null;
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...(this.params as never[]));
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}

export function makeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url).href), "utf8"));
  // Then every ALTER in migrations/, in name order, like the live DB.
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url).href);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(dir + f, "utf8"));
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    // Atomic and synchronous, like D1's: two batches running side by side never interleave.
    batch: async (stmts: Stmt[]) => {
      db.exec("BEGIN");
      const out = stmts.map((s) => s.rows()); // like D1: each statement's rows (RETURNING, SELECT)
      db.exec("COMMIT");
      return out;
    },
  } as unknown as D1Database;
}
