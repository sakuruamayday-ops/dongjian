/** Enterprise-partitioned Graph Memory integration for 共创企业助手. */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { BlockAssembler, createMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import s from '@deepseek-ai/schemastery'
import { Extractor } from './extractor/extract.ts'
import { assembleContext } from './format/assemble.ts'
import { detectCommunities } from './graph/community.ts'
import { computeGlobalPageRank, invalidateGraphCache } from './graph/pagerank.ts'
import { Recaller } from './recaller/recall.ts'
import { openDb, stableStoredMessageId } from './store/db.ts'
import {
  allEdges, clearMemoryData, findByName, getBySession, getStats, getUnextracted,
  markExtracted, saveMessageOnce, upsertEdge, upsertNode,
} from './store/store.ts'
import {
  DEFAULT_CONFIG, type GmConfig, type GongchuangGraphMemoryConfigureRequest,
  type GongchuangGraphMemorySnapshot,
} from './types.ts'
import type { DatabaseSyncInstance } from './sqlite.ts'

export type * from './types.ts'

const PLUGIN = 'gongchuang-graph-memory'
const MAX_TOOL_TEXT = 12_000

/** Product configuration for local extraction and recall. */
export interface Config {
  /** Directory containing the personal store and isolated enterprise stores. */
  rootDir?: string
  /** Whether completed turns are asynchronously extracted. */
  extractionEnabled?: boolean
  /** Whether relevant local memory is assembled for new user prompts. */
  recallEnabled?: boolean
  /** Maximum recalled graph nodes for one request. */
  recallMaxNodes?: number
  /** Maximum graph traversal depth for one request. */
  recallMaxDepth?: number
  /** Completed-turn interval for PageRank and community maintenance. */
  maintenanceInterval?: number
  /** Auxiliary extraction output ceiling. */
  llmMaxTokens?: number
}

/** One memory database selected for a conversation. */
export type MemoryScope =
  | { readonly kind: 'personal'; readonly key: 'personal'; readonly label: '个人记忆' }
  | { readonly kind: 'enterprise'; readonly key: string; readonly label: string }

interface Route {
  provider: string
  model: string
}

interface Partition {
  readonly scope: MemoryScope
  readonly path: string
  readonly db: DatabaseSyncInstance
  readonly recaller: Recaller
}

interface MutablePreferences {
  enabled: boolean
  includeToolResults: boolean
  updatedAt: string | null
}

interface MemoryRuntime {
  snapshot: () => Promise<GongchuangGraphMemorySnapshot>
  clearAll: () => Promise<void>
}

interface StoredPreferences {
  readonly schemaVersion: 1
  readonly enabled: boolean
  readonly includeToolResults: boolean
  readonly updatedAt: string
}

function defaultRoot(): string {
  const configured = process.env.GONGCHUANG_GRAPH_MEMORY_DIR?.trim()
  if (configured) return resolve(configured)
  const dshHome = process.env.DSH_HOME?.trim()
  return join(dshHome ? resolve(dshHome) : join(homedir(), '.dsh'), 'graph-memory')
}

function positiveInteger(value: number | undefined, fallback: number, label: string, maximum: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError(`${label} 必须是 1 至 ${String(maximum)} 的整数`)
  }
  return resolved
}

function safePartitionName(scope: MemoryScope): string {
  if (scope.kind === 'personal') return 'personal.db'
  const suffix = createHash('sha256').update(scope.key).digest('hex').slice(0, 24)
  return `enterprise-${suffix}.db`
}

/**
 * Resolve exactly one personal or enterprise memory scope for a Session.
 * Workspace membership wins; canonical cwd matching covers a newly created
 * enterprise Session before its membership index has published.
 * @param workspaces - Current durable workspace projections.
 * @param session - Session whose id and canonical cwd select the store.
 * @returns The isolated memory scope for this conversation.
 */
export function resolveMemoryScope(
  workspaces: readonly Pick<Workspace, 'id' | 'path' | 'title' | 'sessionIds'>[],
  session: Pick<Session, 'id' | 'header'>,
): MemoryScope {
  const byMembership = workspaces.filter(workspace => workspace.sessionIds.includes(session.id))
  if (byMembership.length > 1) {
    throw new Error(`会话 ${String(session.id)} 同时属于多个企业空间，长期记忆保持关闭`)
  }
  const cwd = session.header.cwd
  const byPath = cwd === undefined ? [] : workspaces.filter(workspace => workspace.path === cwd)
  if (byPath.length > 1) {
    throw new Error(`目录 ${cwd} 同时注册为多个企业空间，长期记忆保持关闭`)
  }
  const workspace = byMembership[0] ?? byPath[0]
  if (workspace === undefined) return { kind: 'personal', key: 'personal', label: '个人记忆' }
  return {
    kind: 'enterprise',
    key: String(workspace.id),
    label: `${workspace.title}企业记忆`,
  }
}

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const row = block as { type?: unknown; text?: unknown; content?: unknown }
    if ((row.type === 'text' || row.type === 'reasoning') && typeof row.text === 'string') {
      parts.push(row.text)
    } else if (row.type === 'tool-result') {
      parts.push(textBlocks(row.content))
    }
  }
  return parts.join('\n').trim()
}

function messageText(message: Pick<UserMessage, 'content'> | undefined): string {
  return textBlocks(message?.content)
}

function eventMessage(event: SessionEvent, includeToolResults: boolean): {
  role: string
  messageId: string
  message: unknown
} | undefined {
  if (event.type === 'user/message') {
    if (event.data.source.kind !== 'user') return undefined
    return { role: 'user', messageId: String(event.data.id), message: event.data }
  }
  if (event.type === 'assistant/message') {
    return { role: 'assistant', messageId: String(event.data.message.id), message: event.data.message }
  }
  if (includeToolResults && event.type === 'tool/result') {
    return { role: 'tool', messageId: String(event.data.message.id), message: event.data.message }
  }
  return undefined
}

function routeFromEvent(event: SessionEvent): Route | undefined {
  if (event.type !== 'request/header') return undefined
  const { provider, model } = event.data.header.config
  return provider !== '' && model !== '' ? { provider, model } : undefined
}

function bounded(value: string, maximum = MAX_TOOL_TEXT): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 16)}\n[内容已截断]`
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim()
  if (normalized === '' || normalized.length > maximum) {
    throw new Error(`${label}必须为 1 至 ${String(maximum)} 个字符`)
  }
  return normalized
}

function stringOutput(title: string) {
  return {
    schema: { type: 'string' as const },
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    presentationMeta: () => ({ title }),
  }
}

async function databaseFiles(rootDir: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && (entry.name === 'personal.db' || /^enterprise-[a-f0-9]{24}\.db$/u.test(entry.name)))
      .map(entry => join(rootDir, entry.name))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function parsePreferences(raw: string): StoredPreferences {
  const value = JSON.parse(raw) as Partial<StoredPreferences>
  if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean'
    || typeof value.includeToolResults !== 'boolean' || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('长期记忆设置文件无效')
  }
  return value as StoredPreferences
}

async function readPreferences(path: string, fallback: MutablePreferences): Promise<MutablePreferences> {
  try {
    const value = parsePreferences(await readFile(path, 'utf8'))
    return { enabled: value.enabled, includeToolResults: value.includeToolResults, updatedAt: value.updatedAt }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

async function writePreferences(path: string, preferences: MutablePreferences): Promise<void> {
  const value: StoredPreferences = {
    schemaVersion: 1,
    enabled: preferences.enabled,
    includeToolResults: preferences.includeToolResults,
    updatedAt: preferences.updatedAt ?? new Date().toISOString(),
  }
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/** Mount the local partitioned memory runtime owned by the service fiber. */
function mountGraphMemory(
  ctx: Context,
  input: Config,
  preferences: MutablePreferences,
  rootDir: string,
): MemoryRuntime {
  const logger = ctx.logger('gongchuang-graph-memory')
  const config: GmConfig = {
    ...DEFAULT_CONFIG,
    dbPath: '',
    compactTurnCount: positiveInteger(input.maintenanceInterval, DEFAULT_CONFIG.compactTurnCount, 'maintenanceInterval', 1_000),
    recallMaxNodes: positiveInteger(input.recallMaxNodes, DEFAULT_CONFIG.recallMaxNodes, 'recallMaxNodes', 30),
    recallMaxDepth: positiveInteger(input.recallMaxDepth, DEFAULT_CONFIG.recallMaxDepth, 'recallMaxDepth', 8),
  }
  const llmMaxTokens = positiveInteger(input.llmMaxTokens, 4_096, 'llmMaxTokens', 32_768)
  const partitions = new Map<string, Partition>()
  const latestRoute = new Map<string, Route>()
  const latestPrompt = new Map<string, string>()
  const recallCache = new Map<string, { query: string; value: Promise<Awaited<ReturnType<Recaller['recall']>>> }>()
  const extractChains = new Map<string, Promise<void>>()
  const turnCounts = new Map<string, number>()
  let closing = false

  function scopeFor(session: Pick<Session, 'id' | 'header'>): MemoryScope {
    return resolveMemoryScope(ctx.workspaceRegistry.list(), session)
  }

  function partitionFor(session: Pick<Session, 'id' | 'header'>): Partition {
    const scope = scopeFor(session)
    const current = partitions.get(scope.key)
    if (current !== undefined) return current
    const path = join(rootDir, safePartitionName(scope))
    const db = openDb(path)
    const partition = { scope, path, db, recaller: new Recaller(db, config) }
    partitions.set(scope.key, partition)
    logger.info('%s 已启用 FTS5 本地召回', scope.label)
    return partition
  }

  function partitionFromTool(exec: ToolRunContext): Partition {
    if (!preferences.enabled) throw new Error('本地长期记忆已在设置中关闭')
    if (exec.agent === undefined) throw new Error('长期记忆工具必须在当前会话中使用')
    return partitionFor(exec.agent.session)
  }

  async function complete(session: Session, route: Route | undefined, system: string, user: string): Promise<string> {
    const selected = route
    if (selected === undefined) throw new Error('当前会话尚未产生可复用的模型路由')
    const assembler = new BlockAssembler()
    const message = createMessage({
      role: 'user',
      content: [{ type: 'text', text: user }],
      source: { kind: 'plugin', plugin: PLUGIN },
    })
    for await (const chunk of ctx.llm.stream({
      provider: selected.provider,
      model: selected.model,
      system,
      temperature: 0.1,
      maxTokens: llmMaxTokens,
      messages: [message],
      sessionId: session.id,
    })) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
    const text = assembler.blocks()
      .filter((block): block is Extract<(typeof block), { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text === '') throw new Error('模型没有返回可提取的记忆内容')
    return text
  }

  function ingest(session: Session, event: SessionEvent): boolean {
    const route = routeFromEvent(event)
    if (route !== undefined) latestRoute.set(String(session.id), route)
    if (!preferences.enabled) return false
    const converted = eventMessage(event, preferences.includeToolResults)
    if (converted === undefined) return false
    const partition = partitionFor(session)
    return saveMessageOnce(
      partition.db,
      stableStoredMessageId(`dsh:${String(session.id)}`, converted.role, converted.messageId),
      `dsh:${String(session.id)}`,
      event.seq,
      converted.role,
      converted.message,
    )
  }

  function backfill(agent: Agent): void {
    for (const event of agent.session.snapshotEvents()) ingest(agent.session, event)
  }

  async function extractPending(session: Session): Promise<void> {
    if (!preferences.enabled || closing) return
    const partition = partitionFor(session)
    const sessionKey = `dsh:${String(session.id)}`
    const messages = getUnextracted(partition.db, sessionKey, 50)
    if (messages.length === 0) return
    try {
      const extractor = new Extractor(config, (system, user) =>
        complete(session, latestRoute.get(String(session.id)), system, user))
      const existingNames = getBySession(partition.db, sessionKey).map(node => node.name)
      const result = await extractor.extract({ messages, existingNames })
      const names = new Map<string, string>()
      for (const candidate of result.nodes) {
        const { node } = upsertNode(partition.db, candidate, sessionKey)
        names.set(node.name, node.id)
      }
      for (const edge of result.edges) {
        const fromId = names.get(edge.from) ?? findByName(partition.db, edge.from)?.id
        const toId = names.get(edge.to) ?? findByName(partition.db, edge.to)?.id
        if (fromId === undefined || toId === undefined) continue
        upsertEdge(partition.db, {
          fromId,
          toId,
          type: edge.type,
          instruction: edge.instruction,
          ...(edge.condition === undefined ? {} : { condition: edge.condition }),
          sessionId: sessionKey,
        })
      }
      markExtracted(partition.db, sessionKey, Math.max(...messages.map(message => message.turn_index)))
      if (result.nodes.length > 0 || result.edges.length > 0) invalidateGraphCache(partition.db)
      logger.info('%s 从会话 %s 提取 %d 个节点和 %d 条关系', partition.scope.label, String(session.id), result.nodes.length, result.edges.length)
    } catch (error) {
      logger.warn('%s 提取暂缓，原会话不受影响：%o', partition.scope.label, error)
    }
  }

  function scheduleExtract(session: Session): void {
    const key = String(session.id)
    const previous = extractChains.get(key) ?? Promise.resolve()
    const next = previous.then(() => extractPending(session))
    extractChains.set(key, next)
    void next.finally(() => {
      if (extractChains.get(key) === next) extractChains.delete(key)
    })
  }

  function maintain(session: Session): void {
    if (!preferences.enabled) return
    const key = String(session.id)
    const turns = (turnCounts.get(key) ?? 0) + 1
    turnCounts.set(key, turns)
    if (turns % config.compactTurnCount !== 0) return
    const partition = partitionFor(session)
    try {
      invalidateGraphCache(partition.db)
      computeGlobalPageRank(partition.db, config)
      detectCommunities(partition.db)
    } catch (error) {
      logger.warn('%s 图谱维护失败：%o', partition.scope.label, error)
    }
  }

  ctx.on('agent/session-start', ({ agent }) => {
    backfill(agent)
  })
  ctx.on('session/event', (session, event) => {
    ingest(session, event)
    if (event.type === 'turn/end') {
      scheduleExtract(session)
      maintain(session)
    }
  })
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (message.source.kind !== 'user') return
    const query = messageText(message)
    if (query === '') return
    const key = String(agent.id)
    latestPrompt.set(key, query)
    recallCache.delete(key)
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    if (!preferences.enabled || closing || context.agent === undefined) return assembled
    const key = String(context.agent.id)
    const query = latestPrompt.get(key)
    if (query === undefined) return assembled
    try {
      const partition = partitionFor(context.agent.session)
      let cached = recallCache.get(key)
      if (cached === undefined || cached.query !== query) {
        cached = { query, value: partition.recaller.recall(query) }
        recallCache.set(key, cached)
      }
      const recalled = await cached.value
      context.signal?.throwIfAborted()
      if (recalled.nodes.length === 0) return assembled
      const sessionKey = `dsh:${String(context.agent.id)}`
      const activeNodes = getBySession(partition.db, sessionKey)
      const activeIds = new Set(activeNodes.map(node => node.id))
      const activeEdges = allEdges(partition.db)
        .filter(edge => activeIds.has(edge.fromId) && activeIds.has(edge.toId))
      const built = assembleContext(partition.db, {
        tokenBudget: 0,
        activeNodes,
        activeEdges,
        recalledNodes: recalled.nodes,
        recalledEdges: recalled.edges,
      })
      const text = bounded([
        '以下是当前记忆分区召回的本地历史参考。当前用户指令始终优先；易变事实必须重新核验。',
        built.systemPrompt,
        built.xml,
        built.episodicXml,
      ].filter(Boolean).join('\n\n'))
      assembled.contexts.push({ name: 'gongchuang-graph-memory:recall', text })
    } catch (error) {
      logger.warn('本地长期记忆召回失败，当前请求继续执行：%o', error)
    }
    return assembled
  })

  const tools = [
    defineTool({
      name: 'gm_status',
      description: '查看当前会话使用的本地长期记忆分区及启用状态。',
      parameters: {},
      output: stringOutput('长期记忆状态'),
      isConcurrencySafe: () => true,
      execute: (_args, exec) => {
        if (exec.agent === undefined) throw new Error('长期记忆工具必须在当前会话中使用')
        const partition = partitionFor(exec.agent.session)
        const stats = getStats(partition.db)
        return Promise.resolve(`${partition.scope.label}\n节点：${String(stats.totalNodes)}\n关系：${String(stats.totalEdges)}\n长期记忆：${preferences.enabled ? '已启用' : '已关闭'}\n工具结果：${preferences.includeToolResults ? '参与提取' : '不参与提取'}\n检索：本机 FTS5`)
      },
      presentCall: () => ({ card: 'generic', title: '查看长期记忆状态', kind: 'read', rawInput: '' }),
    }),
    defineTool({
      name: 'gm_search',
      description: '只搜索当前个人或企业空间的本地长期记忆，不跨企业空间。',
      parameters: { query: { type: 'string', required: true, description: '需要召回的问题或关键词。' } },
      output: stringOutput('搜索长期记忆'),
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const partition = partitionFromTool(exec)
        const query = requiredText(args.query, '检索内容', 1_000)
        const result = await partition.recaller.recall(query)
        if (result.nodes.length === 0) return '当前记忆分区未找到相关内容。'
        return bounded(result.nodes.map(node => `[${node.type}] ${node.name}\n${node.description}\n${node.content}`).join('\n\n'))
      },
      presentCall: args => ({ card: 'generic', title: '搜索长期记忆', kind: 'read', rawInput: args.query }),
    }),
    defineTool({
      name: 'gm_record',
      description: '在用户明确要求记住，或形成可复用方法时，将一条结构化记忆写入当前个人或企业空间。',
      parameters: {
        name: { type: 'string', required: true, description: '简短稳定的记忆名称。' },
        type: { type: 'string', required: true, enum: ['TASK', 'SKILL', 'EVENT'], description: '任务、技能或事件。' },
        description: { type: 'string', required: true, description: '适用场景或触发条件。' },
        content: { type: 'string', required: true, description: '需要长期复用的完整内容。' },
      },
      output: stringOutput('记录长期记忆'),
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        const partition = partitionFromTool(exec)
        const agent = exec.agent
        if (agent === undefined) throw new Error('长期记忆记录必须归属当前会话')
        const { node } = upsertNode(partition.db, {
          name: requiredText(args.name, '记忆名称', 128),
          type: args.type,
          description: requiredText(args.description, '记忆说明', 1_000),
          content: requiredText(args.content, '记忆内容', 8_000),
        }, `dsh:${String(agent.id)}`)
        invalidateGraphCache(partition.db)
        return Promise.resolve(`已记录到${partition.scope.label}：${node.name}`)
      },
      presentCall: args => ({ card: 'generic', title: '记录长期记忆', kind: 'execute', rawInput: args.name }),
    }),
    defineTool({
      name: 'gm_stats',
      description: '统计当前个人或企业空间的本地图记忆节点、关系和社区数量。',
      parameters: {},
      output: stringOutput('长期记忆统计'),
      isConcurrencySafe: () => true,
      execute: (_args, exec) => {
        const partition = partitionFromTool(exec)
        const stats = getStats(partition.db)
        return Promise.resolve(`${partition.scope.label}\n节点：${String(stats.totalNodes)}\n关系：${String(stats.totalEdges)}\n社区：${String(stats.communities)}\n类型：${JSON.stringify(stats.byType)}`)
      },
      presentCall: () => ({ card: 'generic', title: '查看长期记忆统计', kind: 'read', rawInput: '' }),
    }),
  ]
  for (const tool of tools) ctx.effect(() => ctx.tools.register(tool), `graph-memory.tool.${tool.name}`)

  async function snapshot(): Promise<GongchuangGraphMemorySnapshot> {
    await Promise.allSettled([...extractChains.values()])
    const paths = await databaseFiles(rootDir)
    let personalNodes = 0
    let totalNodes = 0
    let totalEdges = 0
    let enterpriseStores = 0
    for (const path of paths) {
      const active = [...partitions.values()].find(partition => partition.path === path)
      const db = active?.db ?? openDb(path)
      try {
        const stats = getStats(db)
        totalNodes += stats.totalNodes
        totalEdges += stats.totalEdges
        if (basename(path) === 'personal.db') personalNodes = stats.totalNodes
        else enterpriseStores += 1
      } finally {
        if (active === undefined) db.close()
      }
    }
    return Object.freeze({
      enabled: preferences.enabled,
      includeToolResults: preferences.includeToolResults,
      personalNodes,
      enterpriseStores,
      totalNodes,
      totalEdges,
      updatedAt: preferences.updatedAt,
    })
  }

  async function clearAll(): Promise<void> {
    await Promise.allSettled([...extractChains.values()])
    const paths = await databaseFiles(rootDir)
    for (const path of paths) {
      const active = [...partitions.values()].find(partition => partition.path === path)
      const db = active?.db ?? openDb(path)
      try {
        clearMemoryData(db)
        invalidateGraphCache(db)
      } finally {
        if (active === undefined) db.close()
      }
    }
    recallCache.clear()
    turnCounts.clear()
  }

  ctx.effect(() => async () => {
    closing = true
    await Promise.allSettled([...extractChains.values()])
    for (const partition of partitions.values()) partition.db.close()
    partitions.clear()
    latestRoute.clear()
    latestPrompt.clear()
    recallCache.clear()
    extractChains.clear()
    turnCounts.clear()
  }, 'graph-memory.close')

  return { snapshot, clearAll }
}

/** Host-owned local graph memory with client-safe preferences and aggregate statistics. */
export class GongchuangGraphMemoryService extends TypertRemoteService {
  static inject = ['tools', 'llm', 'systemPrompt', 'workspaceRegistry']
  static Config: s<Config> = s.object({
    rootDir: s.string().default(''),
    extractionEnabled: s.boolean().default(true),
    recallEnabled: s.boolean().default(true),
    recallMaxNodes: s.number().step(1).min(1).max(30).default(DEFAULT_CONFIG.recallMaxNodes),
    recallMaxDepth: s.number().step(1).min(1).max(8).default(DEFAULT_CONFIG.recallMaxDepth),
    maintenanceInterval: s.number().step(1).min(1).max(1_000).default(DEFAULT_CONFIG.compactTurnCount),
    llmMaxTokens: s.number().step(1).min(1).max(32_768).default(4_096),
  })

  private readonly rootDir: string
  private readonly preferencesPath: string
  private readonly preferences: MutablePreferences
  private runtime?: MemoryRuntime
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'gongchuangGraphMemory')
    const configuredRoot = config.rootDir?.trim() ?? ''
    this.rootDir = resolve(configuredRoot === '' ? defaultRoot() : configuredRoot)
    this.preferencesPath = join(this.rootDir, 'preferences.json')
    this.preferences = {
      enabled: (config.extractionEnabled ?? true) && (config.recallEnabled ?? true),
      includeToolResults: true,
      updatedAt: null,
    }
  }

  protected async [Service.init](): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    Object.assign(this.preferences, await readPreferences(this.preferencesPath, this.preferences))
    this.runtime = mountGraphMemory(this.ctx, this.config, this.preferences, this.rootDir)
  }

  /**
   * Read aggregate local-memory state without exposing content or filesystem paths.
   * @returns Current enabled state and aggregate graph counts.
   */
  @Remote('snapshot')
  async snapshot(): Promise<GongchuangGraphMemorySnapshot> {
    await this.mutationTail
    return this.requireRuntime().snapshot()
  }

  /**
   * Persist and immediately apply the user-controlled local-memory preferences.
   * @param request - Complete enabled and tool-result preference values.
   * @returns Updated aggregate local-memory state.
   */
  @Remote('configure')
  configure(request: GongchuangGraphMemoryConfigureRequest): Promise<GongchuangGraphMemorySnapshot> {
    return this.mutate(async () => {
      const next: MutablePreferences = {
        enabled: request.enabled,
        includeToolResults: request.includeToolResults,
        updatedAt: new Date().toISOString(),
      }
      await writePreferences(this.preferencesPath, next)
      Object.assign(this.preferences, next)
      return this.requireRuntime().snapshot()
    })
  }

  /**
   * Permanently clear every personal and enterprise graph-memory database on this device.
   * @returns Aggregate local-memory state after clearing the databases.
   */
  @Remote('clearAll')
  clearAll(): Promise<GongchuangGraphMemorySnapshot> {
    return this.mutate(async () => {
      await this.requireRuntime().clearAll()
      const next = { ...this.preferences, updatedAt: new Date().toISOString() }
      await writePreferences(this.preferencesPath, next)
      Object.assign(this.preferences, next)
      return this.requireRuntime().snapshot()
    })
  }

  private requireRuntime(): MemoryRuntime {
    if (this.runtime === undefined) throw new Error('本地长期记忆尚未启动')
    return this.runtime
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutationTail.then(operation)
    this.mutationTail = task.then(() => undefined, () => undefined)
    return task
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gongchuangGraphMemory: GongchuangGraphMemoryService
  }
}

export default GongchuangGraphMemoryService
