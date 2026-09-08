/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

/**
 * graph-memory 类型定义
 *
 * 节点：TASK / SKILL / EVENT
 * 边：USED_SKILL / SOLVED_BY / REQUIRES / PATCHES / CONFLICTS_WITH
 */

// ─── 节点 ─────────────────────────────────────────────────────

export type NodeType = 'TASK' | 'SKILL' | 'EVENT'
/**
 * Type contract for node status.
 */
export type NodeStatus = 'active' | 'deprecated'

/**
 * Data contract for gm node.
 */
export interface GmNode {
  id: string
  type: NodeType
  name: string
  description: string
  content: string
  status: NodeStatus
  validatedCount: number
  sourceSessions: string[]
  communityId: string | null
  pagerank: number
  createdAt: number
  updatedAt: number
}

// ─── 边 ───────────────────────────────────────────────────────

/**
 * Type contract for edge type.
 */
export type EdgeType =
  | 'USED_SKILL'
  | 'SOLVED_BY'
  | 'REQUIRES'
  | 'PATCHES'
  | 'CONFLICTS_WITH'

/**
 * Data contract for gm edge.
 */
export interface GmEdge {
  id: string
  fromId: string
  toId: string
  type: EdgeType
  instruction: string
  condition?: string
  sessionId: string
  createdAt: number
}

// ─── 信号 ─────────────────────────────────────────────────────

/**
 * Type contract for signal type.
 */
export type SignalType =
  | 'tool_error'
  | 'tool_success'
  | 'skill_invoked'
  | 'user_correction'
  | 'explicit_record'
  | 'task_completed'

/**
 * Data contract for signal.
 */
export interface Signal {
  type: SignalType
  turnIndex: number
  data: Record<string, unknown>
}

// ─── 提取结果 ─────────────────────────────────────────────────

/**
 * Data contract for extraction result.
 */
export interface ExtractionResult {
  nodes: Array<{
    type: NodeType
    name: string
    description: string
    content: string
  }>
  edges: Array<{
    from: string
    to: string
    type: EdgeType
    instruction: string
    condition?: string
  }>
}

/**
 * Data contract for finalize result.
 */
export interface FinalizeResult {
  promotedSkills: Array<{
    type: 'SKILL'
    name: string
    description: string
    content: string
  }>
  newEdges: Array<{
    from: string
    to: string
    type: EdgeType
    instruction: string
  }>
  invalidations: string[]
}

// ─── 召回结果 ─────────────────────────────────────────────────

/**
 * Data contract for recall result.
 */
export interface RecallResult {
  nodes: GmNode[]
  edges: GmEdge[]
  tokenEstimate: number
}

// ─── Embedding 配置 ──────────────────────────────────────────

/**
 * Data contract for embedding config.
 */
export interface EmbeddingConfig {
  apiKey?: string
  /** Runtime-only credential resolver. Host adapters use this to avoid putting secrets in config. */
  apiKeyResolver?: () => Promise<string | undefined>
  baseURL?: string
  /** Alias used by OpenClaw and several OpenAI-compatible providers. */
  baseUrl?: string
  model?: string
  dimensions?: number
}

// ─── 插件配置 ─────────────────────────────────────────────────

/**
 * Data contract for gm config.
 */
export interface GmConfig {
  dbPath: string
  compactTurnCount: number
  recallMaxNodes: number
  recallMaxDepth: number
  freshTailCount: number
  embedding?: EmbeddingConfig
  llm?: {
    apiKey?: string
    baseURL?: string
    /** Alias used by OpenClaw and several OpenAI-compatible providers. */
    baseUrl?: string
    model?: string
  }
  /** 向量去重阈值，余弦相似度超过此值视为重复 (0-1) */
  dedupThreshold: number
  /** PageRank 阻尼系数 */
  pagerankDamping: number
  /** PageRank 迭代次数 */
  pagerankIterations: number
}

/**
 * Canonical value for default config.
 */
export const DEFAULT_CONFIG: GmConfig = {
  dbPath: '~/.dsh/graph-memory/personal.db',
  compactTurnCount: 6,
  recallMaxNodes: 6,
  recallMaxDepth: 2,
  freshTailCount: 10,
  dedupThreshold: 0.90,
  pagerankDamping: 0.85,
  pagerankIterations: 20,
}

// ─── 共创客户端设置 ──────────────────────────────────────────────

/** Client-safe local memory status. Filesystem paths and stored content stay in Host. */
export interface GongchuangGraphMemorySnapshot {
  readonly enabled: boolean
  readonly includeToolResults: boolean
  readonly personalNodes: number
  readonly enterpriseStores: number
  readonly totalNodes: number
  readonly totalEdges: number
  readonly updatedAt: string | null
}

/** Complete replacement of the two user-controlled memory preferences. */
export interface GongchuangGraphMemoryConfigureRequest {
  readonly enabled: boolean
  readonly includeToolResults: boolean
}
