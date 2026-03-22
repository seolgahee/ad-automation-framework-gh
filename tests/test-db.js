/**
 * Test DB Helper — sql.js wrapper with better-sqlite3-compatible API
 *
 * Provides .prepare(sql).run/get/all() interface matching better-sqlite3
 * so integration tests work in environments where native modules can't build.
 */
import initSqlJs from 'sql.js';

let SQL;

export async function createTestDB() {
  if (!SQL) SQL = await initSqlJs();
  const rawDb = new SQL.Database();

  /** Wrap sql.js with better-sqlite3-like API */
  const db = {
    _raw: rawDb,

    exec(sql) {
      rawDb.run(sql);
    },

    pragma(str) {
      try { rawDb.run(`PRAGMA ${str}`); } catch { /* some pragmas unsupported */ }
    },

    prepare(sql) {
      return {
        run(...params) {
          rawDb.run(sql, params);
          return { changes: rawDb.getRowsModified() };
        },
        get(...params) {
          const stmt = rawDb.prepare(sql);
          stmt.bind(params);
          if (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            stmt.free();
            const row = {};
            cols.forEach((c, i) => { row[c] = vals[i]; });
            return row;
          }
          stmt.free();
          return undefined;
        },
        all(...params) {
          const rows = [];
          const stmt = rawDb.prepare(sql);
          stmt.bind(params);
          while (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            const row = {};
            cols.forEach((c, i) => { row[c] = vals[i]; });
            rows.push(row);
          }
          stmt.free();
          return rows;
        },
      };
    },

    transaction(fn) {
      return (...args) => {
        rawDb.run('BEGIN TRANSACTION');
        try {
          const result = fn(...args);
          rawDb.run('COMMIT');
          return result;
        } catch (err) {
          rawDb.run('ROLLBACK');
          throw err;
        }
      };
    },

    close() {
      rawDb.close();
    },
  };

  return db;
}
