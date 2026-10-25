import pg from 'pg';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { toPostgres, shouldReturnId, POSTGRES_SCHEMA } from './sql-dialect.mjs';

const TABLES = [
  'users','events','team','tasks','comments','expenses','guests','files','activities',
  'chat_messages','app_settings','ai_turns','program_items','notification_state','surveys',
  'survey_questions','survey_responses','survey_answers','registration_fields','guest_answers',
  'invites','catalog_items','announcements','outbox','sessions'
];
pg.types.setTypeParser(20, v => Number(v));
pg.types.setTypeParser(1700, v => Number(v));
const NO_ID_TABLES = /^\s*INSERT INTO\s+(sessions|app_settings|guest_answers|notification_state)\b/i;

export async function openPostgresDatabase(url, directory) {
  mkdirSync(join(directory, 'uploads'), { recursive: true });
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  for (let attempt = 1; ; attempt++) {
    try { await pool.query('SELECT 1'); break; }
    catch (error) {
      if (attempt >= 30) throw error;
      console.log(`Waiting for PostgreSQL (${error.code || error.message})...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  await pool.query(POSTGRES_SCHEMA);
  const db = makeAdapter(pool);
  const hasUsers = await db.get('SELECT id FROM users LIMIT 1');
  if (!hasUsers) await copySeedFromSqlite(db, directory);
  else {
    const setting = await db.get("SELECT value FROM app_settings WHERE key='installation_id'");
    if (!setting) await db.run("INSERT INTO app_settings(key,value) VALUES(?,?)", 'installation_id', randomUUID());
  }
  return db;
}

function makeAdapter(pool) {
  const txStore = new AsyncLocalStorage();
  const client = () => txStore.getStore() || pool;

  async function query(sql, params = []) {
    const text = toPostgres(sql);
    return client().query(text, params);
  }

  return {
    dialect: 'postgres',
    async get(sql, ...params) {
      const r = await query(sql, params);
      return r.rows[0];
    },
    async all(sql, ...params) {
      const r = await query(sql, params);
      return r.rows;
    },
    async run(sql, ...params) {
      let text = toPostgres(sql);
      if (shouldReturnId(text) && !NO_ID_TABLES.test(text)) text += ' RETURNING id';
      const r = await client().query(text, params);
      return {
        lastInsertRowid: r.rows[0]?.id ?? 0,
        changes: r.rowCount ?? 0
      };
    },
    async exec(sql) {
      if (/^\s*BEGIN\b/i.test(sql) || /^\s*COMMIT\b/i.test(sql) || /^\s*ROLLBACK\b/i.test(sql)) {
        throw new Error('Use db.transaction() instead of BEGIN/COMMIT/ROLLBACK');
      }
      await client().query(toPostgres(sql));
    },
    async transaction(fn) {
      if (txStore.getStore()) return fn();
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const result = await txStore.run(c, fn);
        await c.query('COMMIT');
        return result;
      } catch (error) {
        try { await c.query('ROLLBACK'); } catch {}
        throw error;
      } finally {
        c.release();
      }
    },
    async close() {
      await pool.end();
    }
  };
}

async function copySeedFromSqlite(pgDb, directory) {
  const { openDatabase } = await import('./db.mjs');
  const seedDir = join(directory, '.pg-seed');
  mkdirSync(join(seedDir, 'uploads'), { recursive: true });
  openDatabase(seedDir);
  const sqlite = new DatabaseSync(join(seedDir, 'eventgo.sqlite'), { readOnly: true });
  try {
    await pgDb.transaction(async () => {
      for (const table of TABLES) {
        const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
        if (!rows.length) continue;
        const cols = Object.keys(rows[0]);
        const placeholders = cols.map(() => '?').join(',');
        const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;
        for (const row of rows) {
          await pgDb.run(sql, ...cols.map(c => row[c]));
        }
        if (cols.includes('id')) {
          await pgDb.exec(`SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`);
        }
      }
    });
  } finally {
    sqlite.close();
  }
  const uploadsSrc = join(seedDir, 'uploads');
  const uploadsDst = join(directory, 'uploads');
  if (existsSync(uploadsSrc)) {
    for (const name of readdirSync(uploadsSrc)) {
      writeFileSync(join(uploadsDst, name), readFileSync(join(uploadsSrc, name)));
    }
  }
}
