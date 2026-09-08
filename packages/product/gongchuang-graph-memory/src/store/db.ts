/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import { createHash } from 'node:crypto'
import { DatabaseSync, type DatabaseSyncInstance } from '../sqlite.ts'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

let _db: DatabaseSyncInstance | null = null

/**
 * Perform the resolve path operation.
 * @param p - The p value.
 * @returns The resolve path result.
 */
export function resolvePath(p: string): string {
  return p.replace(/^~/, homedir())
}

/**
 * Open an independently owned database instance.
 *
 * Host adapters with explicit lifecycles (for example a DSH Cordis fiber)
 * should use this API and close the returned instance from their disposer.
 * The legacy OpenClaw adapter continues to use getDb() below.
 * @param dbPath - The db path value.
 * @returns The open db result.
 */
export function openDb(dbPath: string): DatabaseSyncInstance {
  const resolved = resolvePath(dbPath)

  // 修复：同时处理 Windows 和 Unix 路径分隔符
  const lastSeparator = Math.max(
    resolved.lastIndexOf('/'),
    resolved.lastIndexOf('\\'),
  )

  if (lastSeparator > 0) {
    const dirPath = resolved.substring(0, lastSeparator)
    mkdirSync(dirPath, { recursive: true })
  } else if (lastSeparator === 0) {
    // 路径像是 "/file.db" 或 "C:file.db"
    // 在根目录或驱动器根目录，不需要创建目录
  } else {
    // lastSeparator === -1，路径没有分隔符
    // 像是 "file.db"，使用当前目录，不需要创建目录
  }

  const db = new DatabaseSync(resolved)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

/**
 * Legacy process-wide database accessor retained for OpenClaw compatibility.
 * New host adapters must prefer openDb() so each plugin instance owns its
 * connection and can dispose it without affecting another profile/fiber.
 * @param dbPath - The db path value.
 * @returns The get db result.
 */
export function getDb(dbPath: string): DatabaseSyncInstance {
  if (_db) return _db
  _db = openDb(dbPath)
  return _db
}

/** 仅用于测试：关闭并重置单例 */
export function closeDb(): void {
  if (_db) { _db.close(); _db = null }
}

function migrate(db: DatabaseSyncInstance): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (v INTEGER PRIMARY KEY, at INTEGER NOT NULL)')
  const cur = (db.prepare('SELECT MAX(v) as v FROM _migrations').get() as { v: number | null } | undefined)?.v ?? 0
  const steps: Array<(database: DatabaseSyncInstance) => void> = [
    m1_core,
    m2_messages,
    m3_signals,
    m4_fts5,
    m5_vectors,
    m6_communities,
    m7_community_signature,
    m8_backfill_community_signatures,
    m9_stable_message_ids,
  ]
  for (let i = cur; i < steps.length; i++) {
    const step = steps[i]
    if (step === undefined) throw new Error(`[graph-memory] missing migration ${String(i + 1)}`)
    step(db)
    db.prepare('INSERT INTO _migrations (v,at) VALUES (?,?)').run(i + 1, Date.now())
  }
}

/**
 * Build the durable graph-memory identity for one model-visible message.
 * @param sessionId - Session that owns the message.
 * @param role - Durable message role used to separate actor namespaces.
 * @param messageId - Stable message identity preserved by Session migrations.
 * @returns Graph-memory primary key independent of mutable event sequence numbers.
 */
export function stableStoredMessageId(sessionId: string, role: string, messageId: string): string {
  return `${sessionId}:message:${role}:${encodeURIComponent(messageId)}`
}

// ─── 核心表：节点 + 边 ──────────────────────────────────────

function m1_core(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_nodes (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL CHECK(type IN ('TASK','SKILL','EVENT')),
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated')),
      validated_count INTEGER NOT NULL DEFAULT 1,
      source_sessions TEXT NOT NULL DEFAULT '[]',
      community_id    TEXT,
      pagerank        REAL NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_gm_nodes_name ON gm_nodes(name);
    CREATE INDEX IF NOT EXISTS ix_gm_nodes_type_status ON gm_nodes(type, status);
    CREATE INDEX IF NOT EXISTS ix_gm_nodes_community ON gm_nodes(community_id);

    CREATE TABLE IF NOT EXISTS gm_edges (
      id          TEXT PRIMARY KEY,
      from_id     TEXT NOT NULL REFERENCES gm_nodes(id),
      to_id       TEXT NOT NULL REFERENCES gm_nodes(id),
      type        TEXT NOT NULL CHECK(type IN ('USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH')),
      instruction TEXT NOT NULL,
      condition   TEXT,
      session_id  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_edges_from ON gm_edges(from_id);
    CREATE INDEX IF NOT EXISTS ix_gm_edges_to   ON gm_edges(to_id);
  `)
}

// ─── 消息存储 ────────────────────────────────────────────────

function m2_messages(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      turn_index  INTEGER NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      extracted   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_msg_session ON gm_messages(session_id, turn_index);
  `)
}

// ─── 信号存储 ────────────────────────────────────────────────

function m3_signals(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_signals (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      turn_index  INTEGER NOT NULL,
      type        TEXT NOT NULL,
      data        TEXT NOT NULL DEFAULT '{}',
      processed   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_sig_session ON gm_signals(session_id, processed);
  `)
}

// ─── FTS5 全文索引 ───────────────────────────────────────────

function m4_fts5(db: DatabaseSyncInstance): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS gm_nodes_fts USING fts5(
        name,
        description,
        content,
        content=gm_nodes,
        content_rowid=rowid
      );
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS gm_nodes_ai AFTER INSERT ON gm_nodes BEGIN
        INSERT INTO gm_nodes_fts(rowid, name, description, content)
        VALUES (NEW.rowid, NEW.name, NEW.description, NEW.content);
      END;
      CREATE TRIGGER IF NOT EXISTS gm_nodes_ad AFTER DELETE ON gm_nodes BEGIN
        INSERT INTO gm_nodes_fts(gm_nodes_fts, rowid, name, description, content)
        VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.content);
      END;
      CREATE TRIGGER IF NOT EXISTS gm_nodes_au AFTER UPDATE ON gm_nodes BEGIN
        INSERT INTO gm_nodes_fts(gm_nodes_fts, rowid, name, description, content)
        VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.content);
        INSERT INTO gm_nodes_fts(rowid, name, description, content)
        VALUES (NEW.rowid, NEW.name, NEW.description, NEW.content);
      END;
    `)
  } catch {
    // FTS5 不可用时静默降级到 LIKE 搜索
  }
}

// ─── 向量存储 ────────────────────────────────────────────────

function m5_vectors(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_vectors (
      node_id      TEXT PRIMARY KEY REFERENCES gm_nodes(id),
      content_hash TEXT NOT NULL,
      embedding    BLOB NOT NULL
    );
  `)
}

// ─── 社区描述存储 ────────────────────────────────────────────

function m6_communities(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_communities (
      id               TEXT PRIMARY KEY,
      summary          TEXT NOT NULL,
      node_count       INTEGER NOT NULL DEFAULT 0,
      embedding        BLOB,
      member_signature TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
  `)
}

function m7_community_signature(db: DatabaseSyncInstance): void {
  const cols = db.prepare('PRAGMA table_info(gm_communities)').all() as Array<{ name?: string }>
  const hasMemberSignature = cols.some(col => col.name === 'member_signature')
  if (!hasMemberSignature) {
    db.exec('ALTER TABLE gm_communities ADD COLUMN member_signature TEXT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS ix_gm_communities_member_signature ON gm_communities(member_signature)')
}

function m8_backfill_community_signatures(db: DatabaseSyncInstance): void {
  const missing = db.prepare(`
    SELECT id FROM gm_communities
    WHERE member_signature IS NULL OR member_signature=''
  `).all() as Array<{ id: string }>

  for (const row of missing) {
    const members = db.prepare(`
      SELECT id FROM gm_nodes
      WHERE community_id=? AND status='active'
      ORDER BY id
    `).all(row.id) as Array<{ id: string }>

    if (!members.length) continue

    const memberSignature = createHash('sha1')
      .update(members.map(member => member.id).join(','))
      .digest('hex')

    db.prepare(`
      UPDATE gm_communities
      SET member_signature=?, updated_at=updated_at
      WHERE id=?
    `).run(memberSignature, row.id)
  }
}

/**
 * Reconcile the old seq-based keys before a v2 session backfill runs.
 *
 * Session migration may renumber events, so an event seq is not a durable
 * message identity. The embedded message.id survives migration and restart.
 * Keeping the extracted bit prevents an already processed message from being
 * sent through the auxiliary extractor again.
 */
function m9_stable_message_ids(db: DatabaseSyncInstance): void {
  const rows = db.prepare(`
    SELECT id, session_id, role, content, extracted, created_at
    FROM gm_messages
  `).all() as Array<{
    id: string
    session_id: string
    role: string
    content: string
    extracted: number
    created_at: number
  }>

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of rows) {
      let messageId: unknown
      try {
        messageId = (JSON.parse(row.content) as { id?: unknown }).id
      } catch {
        continue
      }
      if (typeof messageId !== 'string' || messageId === '') continue
      const stableId = stableStoredMessageId(row.session_id, row.role, messageId)
      if (stableId === row.id) continue
      const existing = db.prepare(`
        SELECT extracted, created_at FROM gm_messages WHERE id=?
      `).get(stableId) as { extracted: number; created_at: number } | undefined
      if (existing === undefined) {
        db.prepare('UPDATE gm_messages SET id=? WHERE id=?').run(stableId, row.id)
        continue
      }
      db.prepare(`
        UPDATE gm_messages
        SET extracted=?, created_at=?
        WHERE id=?
      `).run(
        Math.max(existing.extracted, row.extracted),
        Math.min(existing.created_at, row.created_at),
        stableId,
      )
      db.prepare('DELETE FROM gm_messages WHERE id=?').run(row.id)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
