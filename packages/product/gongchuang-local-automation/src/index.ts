/** Durable local automation scheduler for 共创企业助手. */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { Context, Service } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type {
  AutomationBindSessionRequest, AutomationClaim, AutomationCompleteRequest, AutomationCreateRequest,
  AutomationDeleteRequest, AutomationDispatchRequest, AutomationEnableRequest,
  AutomationRunId, AutomationRunRequest, AutomationSnapshot, AutomationTaskId,
  AutomationTaskView, AutomationUpdateRequest,
} from './types.ts'

export type * from './types.ts'

const MIN_INTERVAL_SECONDS = 300
const MAX_INTERVAL_SECONDS = 31_536_000
const MAX_TASKS = 100
const MAX_RUNS = 200
const CLAIM_TIMEOUT_MS = 15 * 60_000
const STOP_TIMEOUT_MS = 30_000
const RUN_REQUEST_PREFIX = 'automation-run:'
const CREATE_AUTOMATION_TOOL = 'gongchuang_create_automation'

interface CreationIntegrityState {
  readonly turn: number
  corrected?: boolean
}

function textOfMessage(message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return message.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n').trim()
}

function explicitAutomationCreationIntent(text: string): boolean {
  const creation = /(?:创建|新建|添加|设置|安排|建立|帮我.{0,8}(?:建|创建|设置))/u.test(text)
  const automation = /(?:自动化任务|定时任务|定时提醒|定时推送|每日推送|每天.{0,12}推送)/u.test(text)
  return creation && automation && !/(?:如何|怎么|怎样|能否|可否).{0,12}(?:创建|新建|设置)/u.test(text)
}

function automationCompletionClaim(text: string): boolean {
  return /(?:^|[，。；：:\n])\s*(?:✅\s*)?(?:(?:定时|自动化)?任务\s*)?(?:已经|已|成功)(?:为.{0,8})?(?:全部|都|均)?(?:创建|新建|保存|启用)/u.test(text)
    || /(?:^|[，。；：:\n])\s*(?:全部|所有任务)(?:已)?(?:创建|保存|启用)成功/u.test(text)
    || /(?:任务编号|任务 ID|任务ID)\s*[：:]?\s*`?automation-[0-9a-f-]{8,}/iu.test(text)
}

function latestAssistantClaim(agent: Agent, turn: number): { seq: number; text: string } | undefined {
  const event = agent.session.snapshotEvents()
    .findLast(candidate => candidate.type === 'assistant/message' && candidate.data.turn === turn)
  if (event?.type !== 'assistant/message') return undefined
  return { seq: event.seq, text: textOfMessage(event.data.message) }
}

function automationExecution(agent: Agent, turn: number): {
  attempted: boolean
  succeeded: boolean
  incomplete: boolean
  taskIds: ReadonlySet<string>
} {
  const calls = new Map<string, boolean | null>()
  const taskIds = new Set<string>()
  const collectIds = (content: readonly { type: string; text?: string }[]) => {
    for (const block of content) {
      if (block.type !== 'text' || block.text === undefined) continue
      try {
        const value: unknown = JSON.parse(block.text)
        if (typeof value === 'object' && value !== null && 'status' in value && value.status === 'saved'
          && 'id' in value && typeof value.id === 'string') taskIds.add(value.id)
      } catch { /* Only structured tool receipts identify saved tasks. */ }
    }
  }
  let openTurn: number | null = null
  const nativeCalls = new Set<string>()
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'turn/start') {
      openTurn = event.data.turn
      continue
    }
    if (event.type === 'turn/end') {
      openTurn = null
      continue
    }
    if (event.type === 'tool/call' && event.data.turn === turn && event.data.name === CREATE_AUTOMATION_TOOL) {
      calls.set(String(event.data.callId), null)
      nativeCalls.add(String(event.data.callId))
      continue
    }
    if (event.type === 'tool/result' && event.data.turn === turn
      && nativeCalls.has(String(event.data.message.source.callId))) {
      const successful = event.data.message.content.filter(block => !block.isError)
      calls.set(String(event.data.message.source.callId), successful.length > 0)
      for (const block of successful) collectIds(block.content)
      continue
    }
    // 新 PTC 事件会直接携带 turn；旧版持久化日志没有该字段。保留 openTurn
    // 回退可读取升级前历史，但新事件必须优先使用自身位置，避免异步分发跨轮误归属。
    if ((event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch')
      && (event.data.turn ?? openTurn) === turn && event.data.name === CREATE_AUTOMATION_TOOL) {
      calls.set(String(event.data.subCallId), event.type === 'tool/code-dispatch' ? !event.data.isError : null)
      if (event.type === 'tool/code-dispatch' && !event.data.isError) collectIds(event.data.content)
    }
  }
  return {
    attempted: calls.size > 0,
    succeeded: [...calls.values()].includes(true),
    incomplete: [...calls.values()].some(success => success !== true),
    taskIds,
  }
}

interface StoredTask {
  id: AutomationTaskId
  templateId: string | null
  name: string
  prompt: string
  workspaceId: string
  conversationSessionId: string | null
  everySeconds: number
  cadenceLabel: string
  enabled: boolean
  scheduleAnchorAt: string
  nextRunAt: string | null
  createdAt: string
  updatedAt: string
}

interface StoredRun {
  runId: AutomationRunId
  status: 'running' | 'dispatched' | 'failed'
  startedAt: string
  finishedAt: string | null
  message: string
  taskId: AutomationTaskId
  tokenHash: string
  scheduledAt: string
  manual: boolean
  sessionId: string | null
  requestId?: string
}

interface AutomationRegistry {
  schemaVersion: 1
  revision: number
  tasks: StoredTask[]
  runs: StoredRun[]
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function timestamp(value: number): string {
  return new Date(value).toISOString()
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function currentWorkspace(ctx: Context, exec: ToolExecution): Workspace {
  const sessionId = exec.agent?.id
  if (sessionId === undefined) throw new Error('自动化任务必须归属当前会话')
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) throw new Error('企业空间服务未启动，无法创建自动化任务')
  const matches = registry.list().filter(workspace => workspace.sessionIds.includes(sessionId))
  if (matches.length !== 1) throw new Error('当前会话未唯一绑定企业空间，无法创建自动化任务')
  const workspace = matches[0]
  if (workspace === undefined) throw new Error('当前会话未绑定企业空间，无法创建自动化任务')
  return workspace
}

function normalizedFirstRunAt(value: string): string {
  // Date alone normalizes invalid calendar dates and assumes a host timezone.
  if (!z.iso.datetime({ offset: true }).safeParse(value).success) {
    throw new Error('首次执行时间必须是带时区的有效日期时间')
  }
  return new Date(value).toISOString()
}

function requiredText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized === '' || normalized.length > maxLength) throw new Error(`${label}必须为 1 至 ${String(maxLength)} 个字符`)
  return normalized
}

function validateInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_INTERVAL_SECONDS || value > MAX_INTERVAL_SECONDS) {
    throw new Error(`执行周期必须为 ${String(MIN_INTERVAL_SECONDS)} 至 ${String(MAX_INTERVAL_SECONDS)} 秒的整数`)
  }
  return value
}

function scheduledDefinition(
  firstRunAt: string | undefined,
  everySeconds: number,
  enabled: boolean,
  now: number,
): { scheduleAnchorAt: string; nextRunAt: string | null } {
  const scheduleAnchorAt = firstRunAt === undefined
    ? timestamp(now + everySeconds * 1_000) : normalizedFirstRunAt(firstRunAt)
  if (!validTimestamp(scheduleAnchorAt)) throw new Error('首次执行时间必须是有效的 ISO 时间')
  if (enabled && Date.parse(scheduleAnchorAt) < now + 30_000) throw new Error('首次执行时间至少应晚于当前时间 30 秒')
  return { scheduleAnchorAt, nextRunAt: enabled ? scheduleAnchorAt : null }
}

function taskId(value: string): AutomationTaskId {
  if (!/^automation-[0-9a-f-]{36}$/.test(value)) throw new Error('自动化任务 ID 无效')
  return value as AutomationTaskId
}

function runId(value: string): AutomationRunId {
  if (!/^run-[0-9a-f-]{36}$/.test(value)) throw new Error('自动化运行 ID 无效')
  return value as AutomationRunId
}

function parseRegistry(raw: string): AutomationRegistry {
  const value = JSON.parse(raw) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('自动化任务注册表必须是 JSON 对象')
  const registry = value as Partial<AutomationRegistry>
  if (registry.schemaVersion !== 1 || !Number.isSafeInteger(registry.revision)
    || !Array.isArray(registry.tasks) || !Array.isArray(registry.runs)
    || registry.tasks.length > MAX_TASKS || registry.runs.length > MAX_RUNS) {
    throw new Error('自动化任务注册表结构无效')
  }
  const tasksMissingConversation = new Set<StoredTask>()
  for (const task of registry.tasks) {
    // V0.1 preview registries created before schedule anchors used nextRunAt as
    // their only clock. Preserve that value during the additive migration.
    const legacyAnchor = Reflect.get(task, 'scheduleAnchorAt')
    if (typeof legacyAnchor !== 'string') task.scheduleAnchorAt = task.nextRunAt ?? task.updatedAt
    if (!Reflect.has(task, 'conversationSessionId')) {
      task.conversationSessionId = null
      tasksMissingConversation.add(task)
    }
    taskId(String(task.id))
    requiredText(task.name, '任务名称', 128)
    requiredText(task.prompt, '任务指令', 8_000)
    requiredText(task.workspaceId, '企业空间 ID', 256)
    requiredText(task.cadenceLabel, '周期说明', 128)
    validateInterval(task.everySeconds)
    if (task.templateId !== null && (typeof task.templateId !== 'string' || task.templateId.length > 128)) throw new Error('任务模板 ID 无效')
    if (typeof task.enabled !== 'boolean' || !validTimestamp(task.createdAt) || !validTimestamp(task.updatedAt)
      || !validTimestamp(task.scheduleAnchorAt)
      || (task.nextRunAt !== null && !validTimestamp(task.nextRunAt))
      || (task.conversationSessionId !== null
        && (typeof task.conversationSessionId !== 'string' || task.conversationSessionId.trim() === ''
          || task.conversationSessionId.length > 256))) throw new Error('自动化任务状态无效')
  }
  for (const run of registry.runs) {
    run.sessionId ??= null
    runId(String(run.runId))
    taskId(String(run.taskId))
    if (!['running', 'dispatched', 'failed'].includes(run.status) || !validTimestamp(run.startedAt)
      || (run.finishedAt !== null && !validTimestamp(run.finishedAt)) || !validTimestamp(run.scheduledAt)
      || !/^[a-f0-9]{64}$/.test(run.tokenHash) || typeof run.manual !== 'boolean'
      || typeof run.message !== 'string' || run.message.length > 1_000
      || (run.requestId !== undefined && run.requestId !== `${RUN_REQUEST_PREFIX}${run.runId}`)
      || (run.sessionId !== null && (typeof run.sessionId !== 'string' || run.sessionId.trim() === '' || run.sessionId.length > 256))) throw new Error('自动化运行回执无效')
  }
  // Registries written before task-level conversation ownership retained only
  // per-run session receipts. Continue the latest materialized conversation so
  // an upgrade never scatters later executions into another thread.
  for (const task of tasksMissingConversation) {
    task.conversationSessionId = [...registry.runs].reverse()
      .find(run => run.taskId === task.id && run.sessionId !== null)?.sessionId ?? null
  }
  return registry as AutomationRegistry
}

async function readRegistry(path: string): Promise<AutomationRegistry> {
  try {
    return parseRegistry(await readFile(path, 'utf8'))
  } catch (error) {
    const previousPath = `${path}.previous`
    try {
      const previous = parseRegistry(await readFile(previousPath, 'utf8'))
      await writeFileAtomic(path, `${JSON.stringify(previous, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      return previous
    } catch (previousError) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT'
        && (previousError as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, revision: 0, tasks: [], runs: [] }
      }
      throw new AggregateError([error, previousError], '自动化任务注册表及固定回滚槽均不可读取')
    }
  }
}

async function writeRegistry(path: string, registry: AutomationRegistry): Promise<void> {
  try {
    const current = await readFile(path, 'utf8')
    parseRegistry(current)
    await writeFileAtomic(`${path}.previous`, current, { mode: 0o600, dirMode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await writeFileAtomic(path, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

function advance(nextRunAt: string, everySeconds: number, now: number): string {
  const step = everySeconds * 1_000
  const previous = Date.parse(nextRunAt)
  const jumps = Math.max(1, Math.floor((now - previous) / step) + 1)
  return timestamp(previous + jumps * step)
}

/** Display the interval the scheduler actually executes, not caller-supplied prose. */
function intervalLabel(seconds: number): string {
  if (seconds >= 172_800 && seconds % 86_400 === 0) return `每 ${String(seconds / 86_400)} 天`
  if (seconds % 3_600 === 0) return `每 ${String(seconds / 3_600)} 小时`
  if (seconds % 60 === 0) return `每 ${String(seconds / 60)} 分钟`
  return `每 ${String(seconds)} 秒`
}

/** Host-owned persistent automation registry and claim broker. */
export class GongchuangLocalAutomationService extends TypertRemoteService {
  static inject = ['tools']

  private readonly registryPath: string
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly creationIntegrity = new WeakMap<Agent, CreationIntegrityState>()
  private readonly deletions = new Map<AutomationTaskId, Promise<{ id: AutomationTaskId }>>()
  private readonly ownedTurns = new Map<string, { agent: Agent; turn: number }>()

  constructor(ctx: Context) {
    super(ctx, 'gongchuangLocalAutomation')
    const configured = process.env.GONGCHUANG_AUTOMATION_DIR
    if (configured === undefined || configured.trim() === '') throw new Error('自动化任务目录未由桌面宿主绑定')
    this.registryPath = join(resolve(configured), 'registry.json')
  }

  protected async [Service.init](): Promise<void> {
    await mkdir(dirname(this.registryPath), { recursive: true, mode: 0o700 })
    await readRegistry(this.registryPath)
    this.ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const source = message.source
      if (source.kind === 'user' && 'rpcId' in source && source.rpcId.startsWith(RUN_REQUEST_PREFIX)) {
        this.ownedTurns.set(source.rpcId, { agent, turn })
      }
    })
    this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      for (const [requestId, owner] of this.ownedTurns) {
        if (owner.agent.session === session && owner.turn === event.data.turn) this.ownedTurns.delete(requestId)
      }
    })
    const tools = this.ctx.get('tools')
    if (tools === undefined) throw new Error('模型工具服务未启动，自动化创建入口保持关闭')
    tools.register(defineTool({
      name: CREATE_AUTOMATION_TOOL,
      description: '在当前企业空间创建一个本机周期自动化任务。仅当用户明确要求创建自动化任务，且任务内容、首次执行时间与周期均已明确时调用。该工具始终需要用户在调用卡片中再次确认。',
      parameters: {
        name: { type: 'string', required: true, description: '用户可识别的任务名称。' },
        prompt: { type: 'string', required: true, description: '到点后发送到企业空间会话的完整任务指令。' },
        first_run_at: { type: 'string', required: true, description: '首次执行时间，必须是带时区的 ISO 8601 日期时间。' },
        every_seconds: { type: 'integer', required: true, description: '固定执行周期秒数，范围 300 至 31536000。' },
        cadence_label: { type: 'string', required: true, description: '面向用户的中文周期说明，例如“每天”或“每 90 分钟”。' },
        enabled: { type: 'boolean', required: true, description: '用户要求立即启用时为 true；只保存草稿时为 false。' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            status: { type: 'string', required: true, enum: ['saved'] },
            id: { type: 'string', required: true },
            name: { type: 'string', required: true },
            workspace_id: { type: 'string', required: true },
            workspace_title: { type: 'string', required: true },
            enabled: { type: 'boolean', required: true },
            cadence_label: { type: 'string', required: true },
            next_run_at: {
              oneOf: [{ type: 'string' }, { type: 'null' }],
              required: true,
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        const workspace = currentWorkspace(this.ctx, exec)
        const task = await this.createTask({
          name: args.name,
          prompt: args.prompt,
          workspaceId: workspace.id,
          everySeconds: args.every_seconds,
          cadenceLabel: args.cadence_label,
          enabled: args.enabled,
          firstRunAt: normalizedFirstRunAt(args.first_run_at),
        })
        return {
          status: 'saved' as const,
          id: task.id,
          name: task.name,
          workspace_id: workspace.id,
          workspace_title: workspace.title,
          enabled: task.enabled,
          cadence_label: task.cadenceLabel,
          next_run_at: task.nextRunAt,
        }
      },
      presentCall: args => ({
        card: 'generic',
        title: args.enabled ? '保存并启用自动化任务' : '保存自动化任务',
        kind: 'execute',
        rawInput: `${args.name} · ${intervalLabel(args.every_seconds)} · ${args.first_run_at}`,
      }),
    }))
    this.ctx.on('agent/pre-step', ({ agent, messages, turn }, next): Promise<PreStepDecision> => {
      const current = [...messages].reverse().find(message => message.source.kind === 'user')
      if (current !== undefined && explicitAutomationCreationIntent(textOfMessage(current))) {
        const state = this.creationIntegrity.get(agent)
        if (state?.turn !== turn) this.creationIntegrity.set(agent, { turn })
      }
      return next()
    })
    this.ctx.on('agent/turn-stopping', ({ agent, turn, signal }): void => {
      if (signal.aborted) return
      const state = this.creationIntegrity.get(agent)
      if (state?.turn !== turn) return
      const claim = latestAssistantClaim(agent, turn)
      if (claim === undefined || state.corrected
        || !automationCompletionClaim(claim.text)) return
      const execution = automationExecution(agent, turn)
      const wrongId = [...claim.text.matchAll(/\bautomation-[0-9a-f-]{36}\b/gu)]
        .some(match => !execution.taskIds.has(match[0]))
      const claimsAll = /(?:全部|所有|均|都).{0,16}(?:创建|保存|启用|成功)/u.test(claim.text)
      if (execution.succeeded && !wrongId && !(execution.incomplete && claimsAll)) return
      // One factual correction per turn, never an unbounded repair loop or retry
      // of an already successful or user-cancelled creation operation.
      state.corrected = true
      const correction = execution.succeeded
        ? `本轮存在已保存的自动化任务，但不能宣称全部成功或使用未确认的任务编号。受信任任务编号：${[...execution.taskIds].join('、') || '未记录'}。请只更正最终说明，保留失败或用户取消的结果，不要重建已成功任务或重试已取消的操作。`
        : execution.attempted
          ? '自动化任务工具没有成功保存任务，当前轮次不得宣称“已创建”“已启用”，也不得生成任务编号。请根据真实工具错误或用户取消结果如实说明，自动化任务页应保持原状态。'
          : '你刚才没有调用 gongchuang_create_automation，自动化任务并未创建。请立即调用该工具并等待用户在确认卡中决定；用户确认前不得宣称“已创建”“已启用”，也不得生成任务编号。'
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: correction }],
        source: {
          kind: 'plugin',
          plugin: 'gongchuang-local-automation',
          form: 'notice',
          summary: execution.attempted ? '自动化创建未成功' : '自动化创建尚未确认',
        },
      }))
    })
  }

  /**
   * Read the complete local automation registry.
   * @returns Persisted tasks and aggregate run state after pending mutations settle.
   */
  @Remote('snapshot')
  async snapshot(): Promise<AutomationSnapshot> {
    await this.mutationTail
    return this.snapshotFrom(await readRegistry(this.registryPath))
  }

  /**
   * Create a task or update the task already bound to the same template id.
   * @param request - Validated local schedule, prompt, and enterprise workspace selection.
   * @returns Persisted client-safe task state.
   */
  @Remote('createTask')
  async createTask(request: AutomationCreateRequest): Promise<AutomationTaskView> {
    return this.mutate((registry, now) => {
      const name = requiredText(request.name, '任务名称', 128)
      const prompt = requiredText(request.prompt, '任务指令', 8_000)
      const workspaceId = requiredText(request.workspaceId, '企业空间 ID', 256)
      this.requireWorkspace(workspaceId)
      requiredText(request.cadenceLabel, '周期说明', 128)
      const everySeconds = validateInterval(request.everySeconds)
      const cadenceLabel = intervalLabel(everySeconds)
      const schedule = scheduledDefinition(request.firstRunAt, everySeconds, request.enabled, now)
      const normalizedTemplate = request.templateId === undefined ? null : requiredText(request.templateId, '任务模板 ID', 128)
      const existing = normalizedTemplate === null ? undefined : registry.tasks.find(task => task.templateId === normalizedTemplate)
      const iso = timestamp(now)
      if (existing !== undefined) {
        // Template-backed upserts share the same conversation ownership rule as
        // the edit form: once a task has a result thread, moving it to another
        // enterprise would strand that binding across workspace boundaries.
        if (workspaceId !== existing.workspaceId && (existing.conversationSessionId !== null
          || registry.runs.some(run => run.taskId === existing.id && run.status === 'running'))) {
          throw new Error('该任务已绑定结果对话，不能更换企业空间；请在目标空间重新创建任务')
        }
        Object.assign(existing, {
          name, prompt, workspaceId, cadenceLabel, everySeconds, enabled: request.enabled,
          ...schedule, updatedAt: iso,
        })
        return this.taskView(registry, existing)
      }
      if (registry.tasks.length >= MAX_TASKS) throw new Error('自动化任务数量已达到 100 项上限')
      const task: StoredTask = {
        id: taskId(`automation-${randomUUID()}`), templateId: normalizedTemplate, name, prompt, workspaceId,
        conversationSessionId: null,
        everySeconds, cadenceLabel, enabled: request.enabled,
        ...schedule,
        createdAt: iso, updatedAt: iso,
      }
      registry.tasks.push(task)
      return this.taskView(registry, task)
    })
  }

  /**
   * Edit an existing task without replacing its identity or run history.
   * @param request - Existing task id plus its complete editable definition.
   * @returns Updated persisted task state.
   */
  @Remote('updateTask')
  async updateTask(request: AutomationUpdateRequest): Promise<AutomationTaskView> {
    return this.mutate((registry, now) => {
      if (this.deletions.has(request.id)) throw new Error('任务正在停止并删除，请稍后重试')
      const task = this.requireTask(registry, request.id)
      const everySeconds = validateInterval(request.everySeconds)
      const workspaceId = requiredText(request.workspaceId, '企业空间 ID', 256)
      this.requireWorkspace(workspaceId)
      // A claim owns its original workspace even before bindRunSession returns.
      if (workspaceId !== task.workspaceId && (task.conversationSessionId !== null
        || registry.runs.some(run => run.taskId === task.id && run.status === 'running'))) {
        throw new Error('该任务已绑定结果对话，不能更换企业空间；请在目标空间重新创建任务')
      }
      task.name = requiredText(request.name, '任务名称', 128)
      task.prompt = requiredText(request.prompt, '任务指令', 8_000)
      task.workspaceId = workspaceId
      task.everySeconds = everySeconds
      requiredText(request.cadenceLabel, '周期说明', 128)
      task.cadenceLabel = intervalLabel(everySeconds)
      task.enabled = request.enabled
      Object.assign(task, scheduledDefinition(request.firstRunAt, everySeconds, request.enabled, now))
      task.updatedAt = timestamp(now)
      return this.taskView(registry, task)
    })
  }

  /**
   * Enable or disable one task and recompute its next local run time.
   * @param request - Opaque task id and desired scheduler state.
   * @returns Updated persisted task state.
   */
  @Remote('setTaskEnabled')
  async setTaskEnabled(request: AutomationEnableRequest): Promise<AutomationTaskView> {
    return this.mutate((registry, now) => {
      if (this.deletions.has(request.id)) throw new Error('任务正在停止并删除，请稍后重试')
      const task = this.requireTask(registry, request.id)
      task.enabled = request.enabled
      task.nextRunAt = request.enabled
        ? (Date.parse(task.scheduleAnchorAt) >= now + 30_000
          ? task.scheduleAnchorAt
          : advance(task.scheduleAnchorAt, task.everySeconds, now))
        : null
      task.updatedAt = timestamp(now)
      return this.taskView(registry, task)
    })
  }

  /**
   * Stop owned execution and remove the task; conversation and files stay intact.
   * @param request - Opaque task id.
   * @returns The removed task id for client confirmation.
   */
  @Remote('deleteTask')
  async deleteTask(request: AutomationDeleteRequest): Promise<{ id: AutomationTaskId }> {
    const existing = this.deletions.get(request.id)
    if (existing !== undefined) return await existing
    const deletion = this.deleteStoppedTask(request.id)
    this.deletions.set(request.id, deletion)
    try {
      return await deletion
    } finally {
      if (this.deletions.get(request.id) === deletion) this.deletions.delete(request.id)
    }
  }

  private async deleteStoppedTask(id: AutomationTaskId): Promise<{ id: AutomationTaskId }> {
    const running = await this.mutate((registry, now) => {
      const task = this.requireTask(registry, id)
      task.enabled = false
      task.nextRunAt = null
      task.updatedAt = timestamp(now)
      return registry.runs.filter(run => run.taskId === id
        && (run.status === 'running' || this.ownedTurns.has(`${RUN_REQUEST_PREFIX}${run.runId}`)))
    })
    // 先持久化停用，再等待准确的执行结束。停止超时保留任务供重试，不能假报删除成功。
    for (const run of running) await this.stopOwnedRun(run)
    return this.mutate((registry) => {
      const task = this.requireTask(registry, id)
      registry.tasks = registry.tasks.filter(candidate => candidate.id !== task.id)
      registry.runs = registry.runs.filter(run => run.taskId !== task.id)
      return { id: task.id }
    })
  }

  private async stopOwnedRun(run: StoredRun): Promise<void> {
    if (run.sessionId === null) return
    const sessions = this.ctx.get('sessionController')
    if (sessions === undefined) throw new Error('无法连接结果会话；任务已停用，请稍后重试删除')
    const resolved = await sessions.resolveAgent(SessionId(run.sessionId))
    if ('error' in resolved) {
      if (resolved.error.code === 'session/not-found') return
      throw resolved.error
    }
    const { agent } = resolved
    const requestId = run.requestId ?? `${RUN_REQUEST_PREFIX}${run.runId}`
    let removed = false
    for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
      if (message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === requestId) {
        removed = agent.inbox.remove(message.id) || removed
      }
    }
    const owner = this.ownedTurns.get(requestId)
    if (owner === undefined || owner.agent !== agent) {
      // 升级前没有请求标识的运行不猜测归属，避免停止用户随后发起的手动消息。
      if (!removed && run.requestId === undefined && agent.status === 'running') {
        throw new Error('旧任务无法确认正在执行的轮次；任务已停用，请在结果对话停止后重试删除')
      }
      return
    }
    await new Promise<void>((resolve, reject) => {
      const unsubscribe = this.ctx.on('session/event', (session, event) => {
        if (session !== agent.session || event.type !== 'turn/end' || event.data.turn !== owner.turn) return
        clearTimeout(timer)
        unsubscribe()
        resolve()
      })
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error('停止执行尚未完成；任务已停用，请稍后重试删除'))
      }, STOP_TIMEOUT_MS)
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    })
  }

  /**
   * Atomically claim the earliest task whose local schedule is due.
   * @returns The earliest due one-time claim, or `null` when no task is due.
   */
  @Remote('claimDue')
  async claimDue(): Promise<AutomationClaim | null> {
    return this.mutate((registry, now) => {
      // A long run may cross its next cadence boundary. Skip only that task so
      // its earlier due time cannot prevent another independent task claiming.
      const runningTaskIds = new Set(registry.runs
        .filter(run => run.status === 'running')
        .map(run => run.taskId))
      const due = registry.tasks.filter(task => task.enabled
        && !runningTaskIds.has(task.id)
        && task.nextRunAt !== null
        && Date.parse(task.nextRunAt) <= now)
        .sort((left, right) => Date.parse(left.nextRunAt ?? '') - Date.parse(right.nextRunAt ?? ''))[0]
      if (due === undefined) return null
      const scheduledAt = due.nextRunAt
      if (scheduledAt === null) throw new Error('到期任务缺少下次运行时间')
      due.nextRunAt = advance(scheduledAt, due.everySeconds, now)
      due.updatedAt = timestamp(now)
      return this.createClaim(registry, due, scheduledAt, false, now)
    })
  }

  /**
   * Issue a one-time manual execution claim without changing the periodic schedule.
   * @param request - Opaque id of the task to run.
   * @returns New claim containing a secret completion token.
   */
  @Remote('runTaskNow')
  async runTaskNow(request: AutomationRunRequest): Promise<AutomationClaim> {
    return this.mutate((registry, now) => {
      if (this.deletions.has(request.id)) throw new Error('任务正在停止并删除，请稍后重试')
      const task = this.requireTask(registry, request.id)
      return this.createClaim(registry, task, timestamp(now), true, now)
    })
  }

  /**
   * Persist the dedicated conversation before an active run sends its prompt.
   * Repeating the same binding is idempotent. Replacement requires the active
   * run and task to still match the caller's previous id, so deletion recovery
   * cannot overwrite a newer conversation chosen by another client.
   * @param request - Authenticated active run plus the materialized Session id.
   * @returns Updated task view carrying the durable conversation binding.
   */
  @Remote('bindRunSession')
  async bindRunSession(request: AutomationBindSessionRequest): Promise<AutomationTaskView> {
    return this.mutate((registry) => {
      const run = this.requireActiveRun(registry, request.runId, request.runToken)
      const sessionId = requiredText(request.sessionId, '结果会话 ID', 256)
      const previousSessionId = request.previousSessionId === undefined
        ? null
        : requiredText(request.previousSessionId, '待替换结果会话 ID', 256)
      const task = this.requireTask(registry, run.taskId)
      if (this.deletions.has(task.id)) throw new Error('任务正在停止并删除，未发送新消息')
      if (task.conversationSessionId !== null && task.conversationSessionId !== sessionId) {
        if (previousSessionId !== task.conversationSessionId || run.sessionId !== null) {
          throw new Error('自动化任务结果会话已变更，请刷新后重试')
        }
      }
      if (run.sessionId !== null && run.sessionId !== sessionId && previousSessionId !== run.sessionId) {
        throw new Error('本次自动化运行已绑定其他结果会话')
      }
      const workspace = this.ctx.get('workspaceRegistry')?.list()
        .find(candidate => candidate.id === task.workspaceId)
      if (workspace === undefined || !workspace.sessionIds.some(candidate => String(candidate) === sessionId)) {
        throw new Error('结果会话不属于任务绑定的企业空间')
      }
      task.conversationSessionId = sessionId
      run.sessionId = sessionId
      return this.taskView(registry, task)
    })
  }

  /** Admit a claimed prompt through the upstream Session API under the same queue as deletion.
   * @param request - Active claim and the exact task message to send.
   * @returns Identity of the admitted user message for completion tracking.
   */
  @Remote('dispatchRun')
  async dispatchRun(request: AutomationDispatchRequest): Promise<{ requestId: SessionRequestId }> {
    return this.mutate(async (registry) => {
      const run = this.requireActiveRun(registry, request.runId, request.runToken)
      if (this.deletions.has(run.taskId)) throw new Error('任务正在停止并删除，未发送新消息')
      if (run.sessionId === null) throw new Error('自动化任务尚未绑定结果会话')
      const requestId = `${RUN_REQUEST_PREFIX}${run.runId}` as SessionRequestId
      if (run.requestId !== undefined) return { requestId }
      const sessions = this.ctx.get('sessionController')
      if (sessions === undefined) throw new Error('结果会话服务尚未就绪')
      await sessions.prompt({
        sessionId: SessionId(run.sessionId), requestId, mode: 'queue',
        content: [{ type: 'text', text: requiredText(request.content, '任务消息', 16_000) }],
      }, new AbortController().signal)
      run.requestId = requestId
      return { requestId }
    })
  }

  /**
   * Settle one active claim after authenticating its one-time token.
   * @param request - Run id, claim token, terminal status, and bounded receipt message.
   * @returns Updated task view containing the terminal run state.
   */
  @Remote('completeRun')
  async completeRun(request: AutomationCompleteRequest): Promise<AutomationTaskView | null> {
    if (request.status === 'failed') {
      const ownedRun = await this.mutate((registry) => {
        if (!registry.runs.some(run => run.runId === request.runId)) return null
        const run = this.requireActiveRun(registry, request.runId, request.runToken)
        if (request.sessionId !== undefined && request.sessionId !== run.sessionId) {
          throw new Error('运行回执与已绑定结果会话不一致')
        }
        requiredText(request.message, '运行回执', 1_000)
        return { ...run }
      })
      // 客户端等待超时不代表模型已经停止。只等待本次执行，且不占用任务写入队列，
      // 防止遗留运行与下一次定时触发重叠，也不阻塞其他任务或手动消息。
      if (ownedRun?.requestId !== undefined) await this.stopOwnedRun(ownedRun)
    }
    return this.mutate((registry, now) => {
      // 删除与执行结果回传可以交错。已删除的运行不复活，也不产生“回执失败”假故障。
      if (!registry.runs.some(run => run.runId === request.runId)) return null
      const run = this.requireActiveRun(registry, request.runId, request.runToken)
      const task = this.requireTask(registry, run.taskId)
      const requestSessionId = request.sessionId === undefined
        ? null
        : requiredText(request.sessionId, '结果会话 ID', 256)
      if (requestSessionId !== null && requestSessionId !== run.sessionId) {
        throw new Error('运行回执与已绑定结果会话不一致')
      }
      if (request.status === 'dispatched' && run.sessionId === null) {
        throw new Error('自动化任务完成前必须先绑定结果会话')
      }
      run.status = request.status
      run.finishedAt = timestamp(now)
      run.message = requiredText(request.message, '运行回执', 1_000)
      return this.taskView(registry, task)
    })
  }

  private mutate<T>(operation: (registry: AutomationRegistry, now: number) => T | Promise<T>): Promise<T> {
    const task = this.mutationTail.then(async () => {
      const registry = await readRegistry(this.registryPath)
      const now = Date.now()
      const previousContent = JSON.stringify(registry)
      this.recoverClaims(registry, now)
      const result = await operation(registry, now)
      if (JSON.stringify(registry) === previousContent) return result
      registry.revision += 1
      // Retention removes completed history, never a live completion token.
      let excess = registry.runs.length - MAX_RUNS
      if (excess > 0) registry.runs = registry.runs.filter(run => run.status === 'running' || excess-- <= 0)
      await writeRegistry(this.registryPath, registry)
      return result
    })
    this.mutationTail = task.then(() => undefined, () => undefined)
    return task
  }

  private recoverClaims(registry: AutomationRegistry, now: number): void {
    for (const run of registry.runs) {
      if (run.status !== 'running' || now - Date.parse(run.startedAt) <= CLAIM_TIMEOUT_MS) continue
      if (this.ownedTurns.has(`${RUN_REQUEST_PREFIX}${run.runId}`)) continue
      run.status = 'failed'
      run.finishedAt = timestamp(now)
      run.message = '客户端在 15 分钟内未提交执行回执，已按异常中断处理。'
    }
  }

  private createClaim(
    registry: AutomationRegistry,
    task: StoredTask,
    scheduledAt: string,
    manual: boolean,
    now: number,
  ): AutomationClaim {
    if (registry.runs.some(run => run.taskId === task.id && run.status === 'running')) throw new Error('该任务已有一次运行正在执行')
    const runToken = randomBytes(32).toString('base64url')
    const run: StoredRun = {
      runId: runId(`run-${randomUUID()}`), taskId: task.id, status: 'running',
      startedAt: timestamp(now), finishedAt: null, message: '', tokenHash: sha256(runToken), scheduledAt, manual,
      sessionId: null,
    }
    registry.runs.push(run)
    return Object.freeze({
      runId: run.runId, runToken, taskId: task.id, taskName: task.name, prompt: task.prompt,
      workspaceId: task.workspaceId, conversationSessionId: task.conversationSessionId, scheduledAt, manual,
    })
  }

  private requireActiveRun(
    registry: AutomationRegistry,
    id: AutomationRunId,
    token: string,
  ): StoredRun {
    const run = registry.runs.find(candidate => candidate.runId === id)
    if (run === undefined || run.status !== 'running') throw new Error('自动化运行不存在或已经结算')
    if (sha256(token) !== run.tokenHash) throw new Error('自动化运行令牌无效')
    return run
  }

  private requireTask(registry: AutomationRegistry, id: AutomationTaskId): StoredTask {
    const task = registry.tasks.find(candidate => candidate.id === id)
    if (task === undefined) throw new Error('自动化任务不存在')
    return task
  }

  private requireWorkspace(id: string): void {
    if (!this.ctx.get('workspaceRegistry')?.list().some(workspace => workspace.id === id)) {
      throw new Error('企业空间不存在，请重新选择后保存')
    }
  }

  private taskView(registry: AutomationRegistry, task: StoredTask): AutomationTaskView {
    const recent = registry.runs.filter(run => run.taskId === task.id).slice(-20).reverse()
    const last = recent[0]
    return Object.freeze({
      ...task,
      cadenceLabel: intervalLabel(task.everySeconds),
      lastRun: last === undefined ? null : Object.freeze({
        runId: last.runId, status: last.status, startedAt: last.startedAt,
        finishedAt: last.finishedAt, scheduledAt: last.scheduledAt, manual: last.manual,
        message: last.message, sessionId: last.sessionId,
      }),
      recentRuns: Object.freeze(recent.map(run => Object.freeze({
        runId: run.runId, status: run.status, startedAt: run.startedAt,
        finishedAt: run.finishedAt, scheduledAt: run.scheduledAt, manual: run.manual,
        message: run.message, sessionId: run.sessionId,
      }))),
    })
  }

  private snapshotFrom(registry: AutomationRegistry): AutomationSnapshot {
    return Object.freeze({
      revision: registry.revision,
      tasks: Object.freeze(registry.tasks.map(task => this.taskView(registry, task))),
      running: registry.runs.filter(run => run.status === 'running').length,
      dispatched: registry.runs.filter(run => run.status === 'dispatched').length,
      failed: registry.runs.filter(run => run.status === 'failed').length,
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gongchuangLocalAutomation: GongchuangLocalAutomationService
  }
}

export default GongchuangLocalAutomationService
