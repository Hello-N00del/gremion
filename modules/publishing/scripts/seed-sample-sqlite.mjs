#!/usr/bin/env node
/**
 * scripts/seed-sample-sqlite.mjs — build a REAL initNewsletterDb-shaped SQLite
 * fixture for backfill acceptance + local dress-rehearsal.
 *
 * Produces a synthetic source store with rows in EVERY backfilled table,
 * including the §D edge rows (one `sending`, one `scheduled` newsletter) and
 * live (far-future) unsubscribe tokens, with explicit GAPPED ids so a backfill
 * run visibly preserves identity. NOT production data — synthetic example.org
 * addresses and placeholder tokens only.
 *
 * Usage (run under Node 22 — better-sqlite3 is N22-only on this host):
 *   node scripts/seed-sample-sqlite.mjs [outPath]
 * Default outPath: services/newsletter/test/fixtures/sample.db
 *
 * The integration suite builds its own in-tmpdir copy; this script materializes
 * the committed fixture the runbook's acceptance line points at.
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = path.resolve(__dirname, '..', 'test', 'fixtures', 'sample.db')
const UTC_TS = '2026-01-15 09:30:00' // SQLite canonical UTC datetime('now') form

function build(outPath) {
  mkdirSync(path.dirname(outPath), { recursive: true })
  // Fresh file each run so the fixture is deterministic (drop WAL siblings too).
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(outPath + suffix)) rmSync(outPath + suffix)
  }

  const db = new Database(outPath)
  // DELETE journal mode (not WAL) so the committed fixture is a SINGLE clean
  // file with no -wal/-shm siblings. The runtime store uses WAL; the fixture
  // only needs to be a valid, self-contained snapshot the backfill reader opens.
  db.pragma('journal_mode = DELETE')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE mailing_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE mailing_list_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL REFERENCES mailing_lists(id) ON DELETE CASCADE,
      email TEXT NOT NULL, name TEXT,
      source TEXT NOT NULL CHECK(source IN ('csv','manual')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(list_id, email)
    );
    CREATE TABLE newsletters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, odt_path TEXT NOT NULL, subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','scheduled','sending','sent','failed')),
      scheduled_at TEXT, sent_at TEXT, error TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE newsletter_recipients (
      newsletter_id INTEGER NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
      mailing_list_id INTEGER REFERENCES mailing_lists(id),
      keycloak_group_id TEXT,
      CHECK((mailing_list_id IS NOT NULL) OR (keycloak_group_id IS NOT NULL)),
      CHECK(NOT (mailing_list_id IS NOT NULL AND keycloak_group_id IS NOT NULL))
    );
    CREATE TABLE unsubscribes (
      email TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE,
      unsubscribed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE send_tokens (
      token TEXT PRIMARY KEY,
      newsletter_id INTEGER NOT NULL REFERENCES newsletters(id),
      email TEXT NOT NULL,
      expires_at TEXT NOT NULL DEFAULT (datetime('now','+7 days')),
      UNIQUE(newsletter_id, email)
    );
    CREATE TABLE newsletter_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      newsletter_id INTEGER NOT NULL, actor_sub TEXT NOT NULL, action TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)

  db.prepare(`INSERT INTO mailing_lists (id, name, created_at) VALUES (?,?,?)`).run(1, 'AStA', UTC_TS)
  db.prepare(`INSERT INTO mailing_lists (id, name, created_at) VALUES (?,?,?)`).run(5, 'Fachschaft', UTC_TS)

  const mIns = db.prepare(
    `INSERT INTO mailing_list_members (id, list_id, email, name, source, created_at) VALUES (?,?,?,?,?,?)`,
  )
  mIns.run(2, 1, 'alice@example.org', 'Alice', 'manual', UTC_TS)
  mIns.run(7, 1, 'bob@example.org', 'Bob', 'csv', UTC_TS)
  mIns.run(9, 5, 'carol@example.org', null, 'manual', UTC_TS)

  const nIns = db.prepare(
    `INSERT INTO newsletters
       (id, title, odt_path, subject, status, scheduled_at, sent_at, error, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
  nIns.run(3, 'Sent NL', '/a.odt', 'Subj A', 'sent', null, UTC_TS, null, 'admin', UTC_TS, UTC_TS)
  nIns.run(10, 'Sending NL', '/b.odt', 'Subj B', 'sending', null, null, null, 'admin', UTC_TS, UTC_TS)
  nIns.run(11, 'Scheduled NL', '/c.odt', 'Subj C', 'scheduled', UTC_TS, null, null, 'admin', UTC_TS, UTC_TS)

  db.prepare(
    `INSERT INTO newsletter_recipients (newsletter_id, mailing_list_id, keycloak_group_id) VALUES (?,?,?)`,
  ).run(3, 1, null)
  db.prepare(
    `INSERT INTO newsletter_recipients (newsletter_id, mailing_list_id, keycloak_group_id) VALUES (?,?,?)`,
  ).run(11, null, 'kc-group-1')

  db.prepare(`INSERT INTO unsubscribes (email, token, unsubscribed_at) VALUES (?,?,?)`).run(
    'gone@example.org', 'unsub-tok-1', UTC_TS,
  )

  const sIns = db.prepare(
    `INSERT INTO send_tokens (token, newsletter_id, email, expires_at) VALUES (?,?,?,?)`,
  )
  sIns.run('live-tok-aaa', 3, 'alice@example.org', '2099-01-01 00:00:00')
  sIns.run('live-tok-bbb', 3, 'bob@example.org', '2099-01-01 00:00:00')

  const aIns = db.prepare(
    `INSERT INTO newsletter_audit (id, newsletter_id, actor_sub, action, created_at) VALUES (?,?,?,?,?)`,
  )
  aIns.run(4, 3, 'admin', 'sent', UTC_TS)
  aIns.run(8, 10, 'admin', 'send-started', UTC_TS)

  db.close()
}

const out = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUT
build(out)
console.log(`[seed-sample-sqlite] wrote ${out}`)
