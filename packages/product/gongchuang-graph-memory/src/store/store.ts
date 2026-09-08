/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import type { DatabaseSyncInstance } from '../sqlite.ts'
import { createHash } from 'node:crypto'
import { stableStoredMessageId } from './db.ts'
import type {
  EdgeType,
  GmEdge,
  GmNode,
  NodeStatus,
  NodeType,
  Signal,
  SignalType,
} from '../types.ts'

// ─── 工具 ─────────────────────────────────────────────────────

function uid(p: string): string {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function typedRows<T>(rows: unknown): T[] {
  return rows as T[]
}

interface NodeRow {
  id: string
  type: NodeType
  name: string
  description: string | null
  content: string
  status: NodeStatus
  validated_count: number
  source_sessions: string | null
  community_id: string | null
  pagerank: number | null
  created_at: number
  updated_at: number
}

interface EdgeRow {
  id: string
  from_id: string
  to_id: string
  type: EdgeType
  instruction: string
  condition: string | null
  session_id: string
  created_at: number
}

/**
 * Data contract for stored message row.
 */
export interface StoredMessageRow {
  id: string
  session_id: string
  turn_index: number
  role: string
  content: string
  extracted: number
  created_at: number
}

interface EpisodicMessageRow {
  turn_index: number
  role: string
  content: string
  created_at: number
}

interface SignalRow {
  type: SignalType
  turn_index: number
  data: string
}

interface CommunityRow {
  id: string
  summary: string
  node_count: number
  member_signature: string | null
  embedding: Uint8Array | null
  created_at: number
  updated_at: number
}

function parseStringArray(value: string | null): string[] {
  const parsed = JSON.parse(value ?? '[]') as unknown
  return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
}

function parseSignalData(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
}

function toNode(r: NodeRow): GmNode {
  return {
    id: r.id, type: r.type, name: r.name,
    description: r.description ?? '', content: r.content,
    status: r.status, validatedCount: r.validated_count,
    sourceSessions: parseStringArray(r.source_sessions),
    communityId: r.community_id ?? null,
    pagerank: r.pagerank ?? 0,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

function toEdge(r: EdgeRow): GmEdge {
  return {
    id: r.id, fromId: r.from_id, toId: r.to_id, type: r.type,
    instruction: r.instruction,
    ...(r.condition === null ? {} : { condition: r.condition }),
    sessionId: r.session_id, createdAt: r.created_at,
  }
}

/** 标准化 name：全小写，空格转连字符，保留中文 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

// ─── 节点 CRUD ───────────────────────────────────────────────

/**
 * Perform the find by name operation.
 * @param db - The db value.
 * @param name - The name value.
 * @returns The find by name result.
 */
export function findByName(db: DatabaseSyncInstance, name: string): GmNode | null {
  const r = db.prepare('SELECT * FROM gm_nodes WHERE name = ?').get(normalizeName(name)) as NodeRow | undefined
  return r ? toNode(r) : null
}

/**
 * Perform the find by id operation.
 * @param db - The db value.
 * @param id - The id value.
 * @returns The find by id result.
 */
export function findById(db: DatabaseSyncInstance, id: string): GmNode | null {
  const r = db.prepare('SELECT * FROM gm_nodes WHERE id = ?').get(id) as NodeRow | undefined
  return r ? toNode(r) : null
}

/**
 * Perform the all active nodes operation.
 * @param db - The db value.
 * @returns The all active nodes result.
 */
export function allActiveNodes(db: DatabaseSyncInstance): GmNode[] {
  return typedRows<NodeRow>(db.prepare("SELECT * FROM gm_nodes WHERE status='active'").all()).map(toNode)
}

/**
 * Perform the all edges operation.
 * @param db - The db value.
 * @returns The all edges result.
 */
export function allEdges(db: DatabaseSyncInstance): GmEdge[] {
  return typedRows<EdgeRow>(db.prepare('SELECT * FROM gm_edges').all()).map(toEdge)
}

/**
 * Perform the upsert node operation.
 * @param db - The db value.
 * @param c - The c value.
 * @param sessionId - The session id value.
 * @returns The upsert node result.
 */
export function upsertNode(
  db: DatabaseSyncInstance,
  c: { type: NodeType; name: string; description: string; content: string },
  sessionId: string,
): { node: GmNode; isNew: boolean } {
  const name = normalizeName(c.name)
  const ex = findByName(db, name)

  if (ex) {
    const sessions = JSON.stringify(Array.from(new Set([...ex.sourceSessions, sessionId])))
    const content = c.content.length > ex.content.length ? c.content : ex.content
    const desc = c.description.length > ex.description.length ? c.description : ex.description
    const count = ex.validatedCount + 1
    db.prepare(`UPDATE gm_nodes SET content=?, description=?, validated_count=?,
      source_sessions=?, updated_at=? WHERE id=?`)
      .run(content, desc, count, sessions, Date.now(), ex.id)
    return { node: { ...ex, content, description: desc, validatedCount: count }, isNew: false }
  }

  const id = uid('n')
  db.prepare(`INSERT INTO gm_nodes
    (id, type, name, description, content, status, validated_count, source_sessions, created_at, updated_at)
    VALUES (?,?,?,?,?,'active',1,?,?,?)`)
    .run(id, c.type, name, c.description, c.content, JSON.stringify([sessionId]), Date.now(), Date.now())
  const node = findByName(db, name)
  if (!node) throw new Error(`[graph-memory] inserted node could not be read: ${name}`)
  return { node, isNew: true }
}

/** 按 name 精确更新 description / content；找不到返回 null（调用方决定报错语义）
 * @param db - The db value.
 * @param name - The name value.
 * @param patch - The patch value.
 * @returns The update node result.
 */
export function updateNode(
  db: DatabaseSyncInstance,
  name: string,
  patch: { description?: string; content?: string },
): GmNode | null {
  const ex = findByName(db, name)
  if (!ex) return null
  const now = Date.now()
  const description = patch.description ?? ex.description
  const content = patch.content ?? ex.content
  db.prepare('UPDATE gm_nodes SET description=?, content=?, updated_at=? WHERE id=?')
    .run(description, content, now, ex.id)
  return { ...ex, description, content, updatedAt: now }
}

/**
 * Perform the deprecate operation.
 * @param db - The db value.
 * @param nodeId - The node id value.
 */
export function deprecate(db: DatabaseSyncInstance, nodeId: string): void {
  db.prepare("UPDATE gm_nodes SET status='deprecated', updated_at=? WHERE id=?")
    .run(Date.now(), nodeId)
}

/** 合并两个节点：keepId 保留，mergeId 标记 deprecated，边迁移
 * @param db - The db value.
 * @param keepId - The keep id value.
 * @param mergeId - The merge id value.
 */
export function mergeNodes(db: DatabaseSyncInstance, keepId: string, mergeId: string): void {
  const keep = findById(db, keepId)
  const merge = findById(db, mergeId)
  if (!keep || !merge) return

  // 合并 validatedCount + sourceSessions
  const sessions = JSON.stringify(
    Array.from(new Set([...keep.sourceSessions, ...merge.sourceSessions])),
  )
  const count = keep.validatedCount + merge.validatedCount
  const content = keep.content.length >= merge.content.length ? keep.content : merge.content
  const desc = keep.description.length >= merge.description.length ? keep.description : merge.description

  db.prepare(`UPDATE gm_nodes SET content=?, description=?, validated_count=?,
    source_sessions=?, updated_at=? WHERE id=?`)
    .run(content, desc, count, sessions, Date.now(), keepId)

  // 迁移边：mergeId 的边指向 keepId
  db.prepare('UPDATE gm_edges SET from_id=? WHERE from_id=?').run(keepId, mergeId)
  db.prepare('UPDATE gm_edges SET to_id=? WHERE to_id=?').run(keepId, mergeId)

  // 删除自环（合并后可能出现 keepId → keepId）
  db.prepare('DELETE FROM gm_edges WHERE from_id = to_id').run()

  // 删除重复边（同 from+to+type 只保留一条）
  db.prepare(`
    DELETE FROM gm_edges WHERE id NOT IN (
      SELECT MIN(id) FROM gm_edges GROUP BY from_id, to_id, type
    )
  `).run()

  deprecate(db, mergeId)
}

/** 批量更新 PageRank 分数
 * @param db - The db value.
 * @param scores - The scores value.
 */
export function updatePageranks(db: DatabaseSyncInstance, scores: Map<string, number>): void {
  const stmt = db.prepare('UPDATE gm_nodes SET pagerank=? WHERE id=?')
  db.exec('BEGIN')
  try {
    for (const [id, score] of scores) {
      stmt.run(score, id)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** 批量更新社区 ID
 * @param db - The db value.
 * @param labels - The labels value.
 */
export function updateCommunities(db: DatabaseSyncInstance, labels: Map<string, string>): void {
  const stmt = db.prepare('UPDATE gm_nodes SET community_id=? WHERE id=?')
  db.exec('BEGIN')
  try {
    for (const [id, cid] of labels) {
      stmt.run(cid, id)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ─── 边 CRUD ─────────────────────────────────────────────────

/**
 * Perform the upsert edge operation.
 * @param db - The db value.
 * @param e - The e value.
 */
export function upsertEdge(
  db: DatabaseSyncInstance,
  e: { fromId: string; toId: string; type: EdgeType; instruction: string; condition?: string; sessionId: string },
): void {
  const ex = db.prepare('SELECT id FROM gm_edges WHERE from_id=? AND to_id=? AND type=?')
    .get(e.fromId, e.toId, e.type) as Pick<EdgeRow, 'id'> | undefined
  if (ex) {
    db.prepare('UPDATE gm_edges SET instruction=? WHERE id=?')
      .run(e.instruction, ex.id)
    return
  }
  db.prepare(`INSERT INTO gm_edges (id, from_id, to_id, type, instruction, condition, session_id, created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(uid('e'), e.fromId, e.toId, e.type, e.instruction, e.condition ?? null, e.sessionId, Date.now())
}

/**
 * Perform the edges from operation.
 * @param db - The db value.
 * @param id - The id value.
 * @returns The edges from result.
 */
export function edgesFrom(db: DatabaseSyncInstance, id: string): GmEdge[] {
  return typedRows<EdgeRow>(db.prepare('SELECT * FROM gm_edges WHERE from_id=?').all(id)).map(toEdge)
}

/**
 * Perform the edges to operation.
 * @param db - The db value.
 * @param id - The id value.
 * @returns The edges to result.
 */
export function edgesTo(db: DatabaseSyncInstance, id: string): GmEdge[] {
  return typedRows<EdgeRow>(db.prepare('SELECT * FROM gm_edges WHERE to_id=?').all(id)).map(toEdge)
}

// ─── FTS5 搜索 ───────────────────────────────────────────────

// FTS support belongs to a concrete connection. A process-global boolean is
// incorrect when multiple host profiles use different SQLite builds or when
// tests/DSH fibers own independent databases.
const fts5Availability = new WeakMap<object, boolean>()

function fts5Available(db: DatabaseSyncInstance): boolean {
  const cached = fts5Availability.get(db)
  if (cached !== undefined) return cached
  try {
    db.prepare('SELECT * FROM gm_nodes_fts LIMIT 0').all()
    fts5Availability.set(db, true)
    return true
  } catch {
    fts5Availability.set(db, false)
    return false
  }
}

/**
 * Perform the search nodes operation.
 * @param db - The db value.
 * @param query - The query value.
 * @param limit - The limit value.
 * @returns The search nodes result.
 */
export function searchNodes(db: DatabaseSyncInstance, query: string, limit = 6): GmNode[] {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8)
  if (!terms.length) return topNodes(db, limit)

  if (fts5Available(db)) {
    try {
      const ftsQuery = terms.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ')
      const rows = typedRows<NodeRow>(db.prepare(`
        SELECT n.*, rank FROM gm_nodes_fts fts
        JOIN gm_nodes n ON n.rowid = fts.rowid
        WHERE gm_nodes_fts MATCH ? AND n.status = 'active'
        ORDER BY rank LIMIT ?
      `).all(ftsQuery, limit))
      if (rows.length > 0) return rows.map(toNode)
    } catch { /* FTS 查询失败，降级 */ }
  }

  const where = terms.map(() => '(name LIKE ? OR description LIKE ? OR content LIKE ?)').join(' OR ')
  const likes = terms.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`])
  return typedRows<NodeRow>(db.prepare(`
    SELECT * FROM gm_nodes WHERE status='active' AND (${where})
    ORDER BY pagerank DESC, validated_count DESC, updated_at DESC LIMIT ?
  `).all(...likes, limit)).map(toNode)
}

/** 热门节点：综合 pagerank + validatedCount 排序
 * @param db - The db value.
 * @param limit - The limit value.
 * @returns The top nodes result.
 */
export function topNodes(db: DatabaseSyncInstance, limit = 6): GmNode[] {
  return typedRows<NodeRow>(db.prepare(`
    SELECT * FROM gm_nodes WHERE status='active'
    ORDER BY pagerank DESC, validated_count DESC, updated_at DESC LIMIT ?
  `).all(limit)).map(toNode)
}

// ─── 递归 CTE 图遍历 ────────────────────────────────────────

/**
 * Perform the graph walk operation.
 * @param db - The db value.
 * @param seedIds - The seed ids value.
 * @param maxDepth - The max depth value.
 * @returns The graph walk result.
 */
export function graphWalk(
  db: DatabaseSyncInstance,
  seedIds: string[],
  maxDepth: number,
): { nodes: GmNode[]; edges: GmEdge[] } {
  if (!seedIds.length) return { nodes: [], edges: [] }

  const placeholders = seedIds.map(() => '?').join(',')

  const walkRows = typedRows<{ node_id: string }>(db.prepare(`
    WITH RECURSIVE walk(node_id, depth) AS (
      SELECT id, 0 FROM gm_nodes WHERE id IN (${placeholders}) AND status='active'
      UNION
      SELECT
        CASE WHEN e.from_id = w.node_id THEN e.to_id ELSE e.from_id END,
        w.depth + 1
      FROM walk w
      JOIN gm_edges e ON (e.from_id = w.node_id OR e.to_id = w.node_id)
      WHERE w.depth < ?
    )
    SELECT DISTINCT node_id FROM walk
  `).all(...seedIds, maxDepth))

  const nodeIds = walkRows.map(r => r.node_id)
  if (!nodeIds.length) return { nodes: [], edges: [] }

  const np = nodeIds.map(() => '?').join(',')
  const nodes = typedRows<NodeRow>(db.prepare(`
    SELECT * FROM gm_nodes WHERE id IN (${np}) AND status='active'
  `).all(...nodeIds)).map(toNode)

  const edges = typedRows<EdgeRow>(db.prepare(`
    SELECT * FROM gm_edges WHERE from_id IN (${np}) AND to_id IN (${np})
  `).all(...nodeIds, ...nodeIds)).map(toEdge)

  return { nodes, edges }
}

// ─── 按 session 查询 ────────────────────────────────────────

/**
 * Perform the get by session operation.
 * @param db - The db value.
 * @param sessionId - The session id value.
 * @returns The get by session result.
 */
export function getBySession(db: DatabaseSyncInstance, sessionId: string): GmNode[] {
  return typedRows<NodeRow>(db.prepare(`
    SELECT DISTINCT n.* FROM gm_nodes n, json_each(n.source_sessions) j
    WHERE j.value = ? AND n.status = 'active'
  `).all(sessionId)).map(toNode)
}

// ─── 消息 CRUD ───────────────────────────────────────────────

/**
 * Perform the save message operation.
 * @param db - The db value.
 * @param sid - The sid value.
 * @param turn - The turn value.
 * @param role - The role value.
 * @param content - The content value.
 */
export function saveMessage(
  db: DatabaseSyncInstance, sid: string, turn: number, role: string, content: unknown,
): void {
  db.prepare(`INSERT OR IGNORE INTO gm_messages (id, session_id, turn_index, role, content, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(uid('m'), sid, turn, role, JSON.stringify(content), Date.now())
}

/**
 * Persist one host event exactly once.
 *
 * The caller supplies the embedded message.id scoped to its session and role.
 * Event seq values are deliberately excluded because format migration may
 * renumber them while preserving the same model-visible message.
 * @param db - The db value.
 * @param eventId - The event id value.
 * @param sid - The sid value.
 * @param turn - The turn value.
 * @param role - The role value.
 * @param content - The content value.
 * @returns The save message once result.
 */
export function saveMessageOnce(
  db: DatabaseSyncInstance,
  eventId: string,
  sid: string,
  turn: number,
  role: string,
  content: unknown,
): boolean {
  const messageId = typeof content === 'object' && content !== null
    ? (content as { id?: unknown }).id
    : undefined
  const durableId = typeof messageId === 'string' && messageId !== ''
    ? stableStoredMessageId(sid, role, messageId)
    : eventId
  const result = db.prepare(`INSERT OR IGNORE INTO gm_messages
    (id, session_id, turn_index, role, content, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(durableId, sid, turn, role, JSON.stringify(content), Date.now())
  if (result.changes > 0) return true
  // A migrated/replayed message keeps its extraction state but follows the
  // current log's ordering and exact serialized content.
  db.prepare(`
    UPDATE gm_messages SET session_id=?, turn_index=?, role=?, content=? WHERE id=?
  `).run(sid, turn, role, JSON.stringify(content), durableId)
  return false
}

/**
 * Perform the get messages operation.
 * @param db - The db value.
 * @param sid - The sid value.
 * @param limit - The limit value.
 * @returns The get messages result.
 */
export function getMessages(db: DatabaseSyncInstance, sid: string, limit?: number): StoredMessageRow[] {
  if (limit) {
    return typedRows<StoredMessageRow>(db.prepare('SELECT * FROM gm_messages WHERE session_id=? ORDER BY turn_index DESC LIMIT ?')
      .all(sid, limit))
  }
  return typedRows<StoredMessageRow>(db.prepare('SELECT * FROM gm_messages WHERE session_id=? ORDER BY turn_index')
    .all(sid))
}

/**
 * Perform the get unextracted operation.
 * @param db - The db value.
 * @param sid - The sid value.
 * @param limit - The limit value.
 * @returns The get unextracted result.
 */
export function getUnextracted(db: DatabaseSyncInstance, sid: string, limit: number): StoredMessageRow[] {
  return typedRows<StoredMessageRow>(db.prepare('SELECT * FROM gm_messages WHERE session_id=? AND extracted=0 ORDER BY turn_index LIMIT ?')
    .all(sid, limit))
}

/**
 * Perform the mark extracted operation.
 * @param db - The db value.
 * @param sid - The sid value.
 * @param upToTurn - The up to turn value.
 */
export function markExtracted(db: DatabaseSyncInstance, sid: string, upToTurn: number): void {
  db.prepare('UPDATE gm_messages SET extracted=1 WHERE session_id=? AND turn_index<=?')
    .run(sid, upToTurn)
}

/**
 * 溯源选拉：按 session 拉取 user/assistant 核心对话（跳过 tool/toolResult）
 * 用于 assemble 时补充三元组的原始上下文
 *
 * @param nearTime  优先取时间最接近的消息（节点的 updatedAt）
 * @param maxChars  总字符上限
 * @param db - The db value.
 * @param sessionIds - The session ids value.
 * @returns The get episodic messages result.
 */
export function getEpisodicMessages(
  db: DatabaseSyncInstance,
  sessionIds: string[],
  nearTime: number,
  maxChars: number = 1500,
): Array<{ sessionId: string; turnIndex: number; role: string; text: string; createdAt: number }> {
  if (!sessionIds.length) return []

  const results: Array<{ sessionId: string; turnIndex: number; role: string; text: string; createdAt: number }> = []
  let usedChars = 0

  // 按 session 逐个拉，优先最近的 session
  for (const sid of sessionIds) {
    if (usedChars >= maxChars) break

    // 只拉 user 和 assistant，按时间距离 nearTime 最近排序
    const rows = typedRows<EpisodicMessageRow>(db.prepare(`
      SELECT turn_index, role, content, created_at FROM gm_messages
      WHERE session_id = ? AND role IN ('user', 'assistant')
      ORDER BY ABS(created_at - ?) ASC
      LIMIT 6
    `).all(sid, nearTime))

    for (const r of rows) {
      if (usedChars >= maxChars) break
      let text = ''
      try {
        const parsed = JSON.parse(r.content) as unknown
        text = extractStoredText(parsed)
      } catch {
        text = r.content.slice(0, 300)
      }

      if (!text.trim()) continue
      const truncated = text.slice(0, Math.min(text.length, maxChars - usedChars))
      results.push({
        sessionId: sid,
        turnIndex: r.turn_index,
        role: r.role,
        text: truncated,
        createdAt: r.created_at,
      })
      usedChars += truncated.length
    }
  }

  return results
}

/** Read text from legacy OpenClaw payloads and DSH block-based messages. */
function extractStoredText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractStoredText).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if ((record.type === 'text' || record.type === 'reasoning') && typeof record.text === 'string') {
    return record.text
  }
  if (record.content !== undefined) return extractStoredText(record.content)
  if (record.message !== undefined) return extractStoredText(record.message)
  return ''
}

// ─── 信号 CRUD ───────────────────────────────────────────────

/**
 * Perform the save signal operation.
 * @param db - The db value.
 * @param sid - The sid value.
 * @param s - The s value.
 */
export function saveSignal(db: DatabaseSyncInstance, sid: string, s: Signal): void {
  db.prepare(`INSERT INTO gm_signals (id, session_id, turn_index, type, data, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(uid('s'), sid, s.turnIndex, s.type, JSON.stringify(s.data), Date.now())
}

/**
 * Perform the pending signals operation.
 * @param db - The db value.
 * @param sid - The sid value.
 * @returns The pending signals result.
 */
export function pendingSignals(db: DatabaseSyncInstance, sid: string): Signal[] {
  return typedRows<SignalRow>(db.prepare('SELECT * FROM gm_signals WHERE session_id=? AND processed=0 ORDER BY turn_index')
    .all(sid))
    .map(r => ({ type: r.type, turnIndex: r.turn_index, data: parseSignalData(r.data) }))
}

/**
 * Perform the mark signals done operation.
 * @param db - The db value.
 * @param sid - The sid value.
 */
export function markSignalsDone(db: DatabaseSyncInstance, sid: string): void {
  db.prepare('UPDATE gm_signals SET processed=1 WHERE session_id=?').run(sid)
}

// ─── 统计 ────────────────────────────────────────────────────

/**
 * Perform the get stats operation.
 * @param db - The db value.
 * @returns The get stats result.
 */
export function getStats(db: DatabaseSyncInstance): {
  totalNodes: number
  byType: Record<string, number>
  totalEdges: number
  byEdgeType: Record<string, number>
  communities: number
} {
  const totalNodes = (db.prepare("SELECT COUNT(*) as c FROM gm_nodes WHERE status='active'").get() as { c: number }).c
  const byType: Record<string, number> = {}
  for (const r of typedRows<{ type: string; c: number }>(db.prepare("SELECT type, COUNT(*) as c FROM gm_nodes WHERE status='active' GROUP BY type").all())) {
    byType[r.type] = r.c
  }
  const totalEdges = (db.prepare('SELECT COUNT(*) as c FROM gm_edges').get() as { c: number }).c
  const byEdgeType: Record<string, number> = {}
  for (const r of typedRows<{ type: string; c: number }>(db.prepare('SELECT type, COUNT(*) as c FROM gm_edges GROUP BY type').all())) {
    byEdgeType[r.type] = r.c
  }
  const communities = (db.prepare(
    "SELECT COUNT(DISTINCT community_id) as c FROM gm_nodes WHERE status='active' AND community_id IS NOT NULL",
  ).get() as { c: number }).c
  return { totalNodes, byType, totalEdges, byEdgeType, communities }
}

/** Remove all user-derived graph, message, signal, vector and community data.
 * @param db - The db value.
 */
export function clearMemoryData(db: DatabaseSyncInstance): void {
  db.exec('BEGIN')
  try {
    db.exec(`
      DELETE FROM gm_edges;
      DELETE FROM gm_vectors;
      DELETE FROM gm_nodes;
      DELETE FROM gm_messages;
      DELETE FROM gm_signals;
      DELETE FROM gm_communities;
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// ─── 向量存储 + 搜索 ────────────────────────────────────────

/**
 * Perform the save vector operation.
 * @param db - The db value.
 * @param nodeId - The node id value.
 * @param content - The content value.
 * @param vec - The vec value.
 */
export function saveVector(db: DatabaseSyncInstance, nodeId: string, content: string, vec: number[]): void {
  const hash = createHash('md5').update(content).digest('hex')
  const f32 = new Float32Array(vec)
  const blob = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
  db.prepare(`INSERT INTO gm_vectors (node_id, content_hash, embedding) VALUES (?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET content_hash=excluded.content_hash, embedding=excluded.embedding`)
    .run(nodeId, hash, blob)
}

/**
 * Perform the get vector hash operation.
 * @param db - The db value.
 * @param nodeId - The node id value.
 * @returns The get vector hash result.
 */
export function getVectorHash(db: DatabaseSyncInstance, nodeId: string): string | null {
  return (db.prepare('SELECT content_hash FROM gm_vectors WHERE node_id=?').get(nodeId) as { content_hash: string } | undefined)?.content_hash ?? null
}

/**
 * Perform the get vector stats operation.
 * @param db - The db value.
 * @returns The get vector stats result.
 */
export function getVectorStats(db: DatabaseSyncInstance): { count: number; dimensions: number[] } {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM gm_vectors').get() as { c: number } | undefined)?.c ?? 0
  const rows = db.prepare('SELECT embedding FROM gm_vectors').all() as Array<{ embedding: Uint8Array }>
  const dimensions = [...new Set(rows.map(row => row.embedding.byteLength / 4))].sort((a, b) => a - b)
  return { count, dimensions }
}

/** 获取所有向量（供去重/聚类用）
 * @param db - The db value.
 * @returns The get all vectors result.
 */
export function getAllVectors(db: DatabaseSyncInstance): Array<{ nodeId: string; embedding: Float32Array }> {
  const rows = typedRows<{ node_id: string; embedding: Uint8Array }>(db.prepare(`
    SELECT v.node_id, v.embedding FROM gm_vectors v
    JOIN gm_nodes n ON n.id = v.node_id WHERE n.status = 'active'
  `).all())
  return rows.map((r) => {
    const raw = r.embedding
    return {
      nodeId: r.node_id,
      embedding: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
    }
  })
}

/**
 * Type contract for scored node.
 */
export type ScoredNode = { node: GmNode; score: number }

/**
 * Perform the vector search with score operation.
 * @param db - The db value.
 * @param queryVec - The query vec value.
 * @param limit - The limit value.
 * @param minScore - The min score value.
 * @returns The vector search with score result.
 */
export function vectorSearchWithScore(db: DatabaseSyncInstance, queryVec: number[], limit: number, minScore = 0.35): ScoredNode[] {
  const rows = typedRows<NodeRow & { node_id: string; embedding: Uint8Array }>(db.prepare(`
    SELECT v.node_id, v.embedding, n.*
    FROM gm_vectors v JOIN gm_nodes n ON n.id = v.node_id
    WHERE n.status = 'active'
  `).all())

  if (!rows.length) return []

  const q = new Float32Array(queryVec)
  const qNorm = Math.sqrt(q.reduce((s, x) => s + x * x, 0))
  if (qNorm === 0) return []

  return rows
    .map((row) => {
      const raw = row.embedding
      const v = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
      let dot = 0, vNorm = 0
      if (v.length !== q.length) return { score: Number.NEGATIVE_INFINITY, node: toNode(row) }
      for (let i = 0; i < q.length; i++) {
        const value = v[i]
        const queryValue = q[i]
        if (value === undefined || queryValue === undefined) continue
        dot += value * queryValue
        vNorm += value * value
      }
      return { score: dot / (Math.sqrt(vNorm) * qNorm + 1e-9), node: toNode(row) }
    })
    .filter(s => s.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** 兼容旧接口
 * @param db - The db value.
 * @param queryVec - The query vec value.
 * @param limit - The limit value.
 * @param minScore - The min score value.
 * @returns The vector search result.
 */
export function vectorSearch(db: DatabaseSyncInstance, queryVec: number[], limit: number, minScore = 0.35): GmNode[] {
  return vectorSearchWithScore(db, queryVec, limit, minScore).map(s => s.node)
}

/**
 * 社区代表节点：每个社区取最近更新的 topN 个节点
 * 用于泛化召回 —— 用户问"做了哪些工作"时按领域返回概览
 * @param db - The db value.
 * @param perCommunity - The per community value.
 * @returns The community representatives result.
 */
export function communityRepresentatives(db: DatabaseSyncInstance, perCommunity = 2): GmNode[] {
  const rows = typedRows<NodeRow>(db.prepare(`
    SELECT * FROM gm_nodes
    WHERE status = 'active' AND community_id IS NOT NULL
    ORDER BY community_id, updated_at DESC
  `).all())

  const byCommunity = new Map<string, GmNode[]>()
  for (const r of rows) {
    const node = toNode(r)
    const cid = r.community_id
    if (cid === null) continue
    const list = byCommunity.get(cid) ?? []
    if (!byCommunity.has(cid)) byCommunity.set(cid, list)
    if (list.length < perCommunity) list.push(node)
  }

  // 社区按最新更新时间排序
  const communities = Array.from(byCommunity.entries())
    .sort((a, b) => {
      const aTime = Math.max(...a[1].map(n => n.updatedAt))
      const bTime = Math.max(...b[1].map(n => n.updatedAt))
      return bTime - aTime
    })

  const result: GmNode[] = []
  for (const [, nodes] of communities) {
    result.push(...nodes)
  }
  return result
}

// ─── 社区描述 CRUD ──────────────────────────────────────────

/**
 * Data contract for community summary.
 */
export interface CommunitySummary {
  id: string
  summary: string
  nodeCount: number
  memberSignature: string | null
  createdAt: number
  updatedAt: number
}

/**
 * Perform the upsert community summary operation.
 * @param db - The db value.
 * @param id - The id value.
 * @param summary - The summary value.
 * @param nodeCount - The node count value.
 * @param embedding - The embedding value.
 * @param memberSignature - The member signature value.
 */
export function upsertCommunitySummary(
  db: DatabaseSyncInstance,
  id: string,
  summary: string,
  nodeCount: number,
  embedding?: number[] | Uint8Array,
  memberSignature?: string,
): void {
  const now = Date.now()
  const blob = embedding
    ? embedding instanceof Uint8Array
      ? embedding
      : new Uint8Array(new Float32Array(embedding).buffer)
    : null
  const ex = db.prepare('SELECT id FROM gm_communities WHERE id=?').get(id) as Pick<CommunityRow, 'id'> | undefined
  if (ex) {
    // A summary/member change invalidates the previous embedding. Persist null
    // when regeneration is unavailable instead of retaining a stale vector.
    db.prepare('UPDATE gm_communities SET summary=?, node_count=?, embedding=?, member_signature=?, updated_at=? WHERE id=?')
      .run(summary, nodeCount, blob, memberSignature ?? null, now, id)
  } else {
    db.prepare('INSERT INTO gm_communities (id, summary, node_count, embedding, member_signature, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, summary, nodeCount, blob, memberSignature ?? null, now, now)
  }
}

/**
 * Perform the get community summary operation.
 * @param db - The db value.
 * @param id - The id value.
 * @returns The get community summary result.
 */
export function getCommunitySummary(db: DatabaseSyncInstance, id: string): CommunitySummary | null {
  const r = db.prepare('SELECT * FROM gm_communities WHERE id=?').get(id) as CommunityRow | undefined
  if (!r) return null
  return {
    id: r.id,
    summary: r.summary,
    nodeCount: r.node_count,
    memberSignature: r.member_signature ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/**
 * Perform the get community summary by signature operation.
 * @param db - The db value.
 * @param memberSignature - The member signature value.
 * @returns The get community summary by signature result.
 */
export function getCommunitySummaryBySignature(
  db: DatabaseSyncInstance,
  memberSignature: string,
): (CommunitySummary & { embedding?: Uint8Array }) | null {
  const r = db.prepare(`
    SELECT * FROM gm_communities
    WHERE member_signature=?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(memberSignature) as CommunityRow | undefined
  if (!r) return null
  return {
    id: r.id,
    summary: r.summary,
    nodeCount: r.node_count,
    memberSignature: r.member_signature ?? null,
    ...(r.embedding ? { embedding: r.embedding } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/**
 * Perform the get all community summaries operation.
 * @param db - The db value.
 * @returns The get all community summaries result.
 */
export function getAllCommunitySummaries(db: DatabaseSyncInstance): CommunitySummary[] {
  return typedRows<CommunityRow>(db.prepare('SELECT * FROM gm_communities ORDER BY node_count DESC').all())
    .map(r => ({
      id: r.id,
      summary: r.summary,
      nodeCount: r.node_count,
      memberSignature: r.member_signature ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
}

/**
 * Type contract for scored community.
 */
export type ScoredCommunity = { id: string; summary: string; score: number; nodeCount: number }

/**
 * 社区向量搜索：用 query 向量匹配社区 embedding，返回按相似度排序的社区
 * @param db - The db value.
 * @param queryVec - The query vec value.
 * @param minScore - The min score value.
 * @returns The community vector search result.
 */
export function communityVectorSearch(db: DatabaseSyncInstance, queryVec: number[], minScore = 0.15): ScoredCommunity[] {
  const rows = typedRows<Pick<CommunityRow, 'id' | 'summary' | 'node_count' | 'embedding'>>(db.prepare(
    'SELECT id, summary, node_count, embedding FROM gm_communities WHERE embedding IS NOT NULL',
  ).all())

  if (!rows.length) return []

  const q = new Float32Array(queryVec)
  const qNorm = Math.sqrt(q.reduce((s, x) => s + x * x, 0))
  if (qNorm === 0) return []

  return rows
    .map((r) => {
      const raw = r.embedding
      if (raw === null) {
        return { id: r.id, summary: r.summary, score: Number.NEGATIVE_INFINITY, nodeCount: r.node_count }
      }
      const v = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
      if (v.length !== q.length) {
        return { id: r.id, summary: r.summary, score: Number.NEGATIVE_INFINITY, nodeCount: r.node_count }
      }
      let dot = 0, vNorm = 0
      for (let i = 0; i < q.length; i++) {
        const value = v[i]
        const queryValue = q[i]
        if (value === undefined || queryValue === undefined) continue
        dot += value * queryValue
        vNorm += value * value
      }
      return {
        id: r.id,
        summary: r.summary,
        score: dot / (Math.sqrt(vNorm) * qNorm + 1e-9),
        nodeCount: r.node_count,
      }
    })
    .filter(s => s.score > minScore)
    .sort((a, b) => b.score - a.score)
}

/**
 * 按社区 ID 列表获取成员节点（按时间倒序）
 * @param db - The db value.
 * @param communityIds - The community ids value.
 * @param perCommunity - The per community value.
 * @returns The nodes by community ids result.
 */
export function nodesByCommunityIds(db: DatabaseSyncInstance, communityIds: string[], perCommunity = 3): GmNode[] {
  if (!communityIds.length) return []
  const placeholders = communityIds.map(() => '?').join(',')
  const rows = typedRows<NodeRow>(db.prepare(`
    SELECT * FROM gm_nodes
    WHERE community_id IN (${placeholders}) AND status='active'
    ORDER BY community_id, updated_at DESC
  `).all(...communityIds))

  const byCommunity = new Map<string, GmNode[]>()
  for (const r of rows) {
    const node = toNode(r)
    const cid = r.community_id
    if (cid === null) continue
    const list = byCommunity.get(cid) ?? []
    if (!byCommunity.has(cid)) byCommunity.set(cid, list)
    if (list.length < perCommunity) list.push(node)
  }

  const result: GmNode[] = []
  for (const cid of communityIds) {
    const members = byCommunity.get(cid)
    if (members) result.push(...members)
  }
  return result
}

/** 清除已不存在的社区描述
 * @param db - The db value.
 * @returns The prune community summaries result.
 */
export function pruneCommunitySummaries(db: DatabaseSyncInstance): number {
  const result = db.prepare(`
    DELETE FROM gm_communities WHERE id NOT IN (
      SELECT DISTINCT community_id FROM gm_nodes WHERE community_id IS NOT NULL AND status='active'
    )
  `).run()
  return Number(result.changes)
}
