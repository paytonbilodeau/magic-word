import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

const migrationDir = new URL('../migrations/', import.meta.url);

export function openStore(file, seed) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  try {
    transaction(() => {
      db.exec('CREATE TABLE IF NOT EXISTS host_migrations (name TEXT PRIMARY KEY)');
      const applied = db.prepare('SELECT name FROM host_migrations WHERE name = ?');
      const mark = db.prepare('INSERT INTO host_migrations VALUES (?)');
      const files = [
        new URL('../schema.sql', import.meta.url),
        ...readdirSync(migrationDir)
          .filter((f) => f.endsWith('.sql'))
          .sort()
          .map((f) => new URL(f, migrationDir)),
      ];
      for (const file of files) {
        const name = file.pathname.split('/').pop();
        if (applied.get(name)) continue;
        db.exec(readFileSync(file, 'utf8'));
        mark.run(name);
      }
      if (seed && !applied.get('demo-seed')) {
        db.exec(seed());
        mark.run('demo-seed');
      }
    });
  } catch (error) {
    db.close();
    throw error;
  }
  function prepare(query, args = []) {
    const stmt = db.prepare(query);
    return {
      bind: (...args) => prepare(query, args),
      rows: () => ({ success: true, results: stmt.all(...args) }),
      async all() {
        return this.rows();
      },
      first: async () => stmt.get(...args) ?? null,
      async run() {
        const result = stmt.run(...args);
        return {
          success: true,
          meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
        };
      },
    };
  }
  return {
    prepare,
    batch: async (statements) => transaction(() => statements.map((s) => s.rows())),
    close: () => db.close(),
  };
}
