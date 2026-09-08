import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type PreToolDecision } from '@deepseek-ai/dsh-tools'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GongchuangLocalAutomationService from '../src/index.ts'

function messageText(message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return message.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n').trim()
}

async function boot(root?: string, workspaces: readonly Workspace[] = []): Promise<{
  ctx: Context
  service: GongchuangLocalAutomationService
  root: string
  dispose: () => Promise<void>
}> {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'gongchuang-local-automation-'))
  process.env.GONGCHUANG_AUTOMATION_DIR = directory
  const ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  ctx.provide('workspaceRegistry', { list: () => [...workspaces] } as never)
  const fiber: Fiber = ctx.plugin(GongchuangLocalAutomationService)
  await fiber.await()
  const service = ctx.get('gongchuangLocalAutomation')
  if (service === undefined) throw new Error('local automation service did not mount')
  return { ctx, service, root: directory, dispose: () => fiber.dispose() }
}

function workspace(id: string, sessionIds: readonly string[]): Workspace {
  return { id, title: id, sessionIds } as unknown as Workspace
}

afterEach(() => {
  vi.useRealTimers()
  delete process.env.GONGCHUANG_AUTOMATION_DIR
})

describe('GongchuangLocalAutomationService', () => {
  it('exports the durable task and claim operations', async () => {
    const { ctx, service, dispose } = await boot()
    expect(remoteMethods(service).map(method => method.exportName ?? method.method).sort()).toEqual([
      'bindRunSession', 'claimDue', 'completeRun', 'createTask', 'deleteTask', 'dispatchRun', 'runTaskNow', 'setTaskEnabled',
      'snapshot', 'updateTask',
    ])
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('gongchuang_create_automation')
    await dispose()
  })

  it('persists only after approval and publishes the new task in the next snapshot revision', async () => {
    const sessionId = SessionId('session-approved-automation')
    const workspace = {
      id: 'workspace-approved-automation', title: '杭州示例企业', sessionIds: [sessionId],
    } as unknown as Workspace
    const { ctx, service, dispose } = await boot(undefined, [workspace])
    await ctx.plugin(ApprovalService)
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.name === 'gongchuang_create_automation') return { kind: 'ask', reason: '创建本机自动化任务需要用户确认' }
      return next()
    })
    const outcomes: Array<ApprovalOutcome | Promise<ApprovalOutcome>> = ['rejected']
    ctx.on('approval/request', () => Promise.resolve(outcomes.shift() ?? 'cancelled'))
    const session = Session.create(sessionId)
    session.append('turn/start', { turn: 1 })
    const agent = { id: sessionId, session } as unknown as Agent
    const execute = (callId: string) => ctx.tools.execute({
      callId: ToolCallId(callId), name: 'gongchuang_create_automation',
      arguments: {
        name: '每日股票热点推送', prompt: '整理当日股票热点并推送到当前企业空间。',
        first_run_at: '2030-08-19T08:00:00+08:00', every_seconds: 86_400,
        cadence_label: '每天 08:00', enabled: true,
      },
      agent, signal: new AbortController().signal,
    })

    await expect(execute('automation-rejected')).resolves.toMatchObject({ isError: true })
    await expect(service.snapshot()).resolves.toMatchObject({ revision: 0, tasks: [] })

    const approval = Promise.withResolvers<ApprovalOutcome>()
    outcomes.push(approval.promise)
    const pending = execute('automation-approved')
    await vi.waitFor(async () => {
      await expect(service.snapshot()).resolves.toMatchObject({ revision: 0, tasks: [] })
    })
    approval.resolve('allowed-once')
    await expect(pending).resolves.toMatchObject({ isError: false })
    await expect(service.snapshot()).resolves.toMatchObject({
      revision: 1,
      tasks: [{
        name: '每日股票热点推送', workspaceId: 'workspace-approved-automation', enabled: true,
      }],
    })
    await dispose()
  })

  it('creates an approved model-requested task only in the current enterprise workspace', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T02:00:00.000Z'))
    const sessionId = SessionId('session-conversation-automation')
    const workspace = {
      id: 'workspace-conversation-automation',
      title: '杭州示例企业',
      sessionIds: [sessionId],
    } as unknown as Workspace
    const { ctx, service, dispose } = await boot(undefined, [workspace])
    const result = await ctx.tools.execute({
      callId: ToolCallId('call-create-automation'),
      name: 'gongchuang_create_automation',
      arguments: {
        name: '政策巡检',
        prompt: '检查最新政策原文并保留来源。',
        first_run_at: '2026-08-16T09:00:00+08:00',
        every_seconds: 86_400,
        cadence_label: '每天',
        enabled: true,
      },
      agent: { id: sessionId } as Agent,
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({
      isError: false,
      value: {
        status: 'saved',
        name: '政策巡检',
        workspace_id: 'workspace-conversation-automation',
        workspace_title: '杭州示例企业',
        enabled: true,
        cadence_label: '每 24 小时',
        next_run_at: '2026-08-16T01:00:00.000Z',
      },
    })
    await expect(service.snapshot()).resolves.toMatchObject({
      tasks: [{ workspaceId: 'workspace-conversation-automation', enabled: true }],
    })
    await dispose()
  })

  it('rejects conversation automation when the session has no unique enterprise workspace', async () => {
    const sessionId = SessionId('session-without-enterprise')
    const { ctx, dispose } = await boot()
    const result = await ctx.tools.execute({
      callId: ToolCallId('call-create-automation-no-workspace'),
      name: 'gongchuang_create_automation',
      arguments: {
        name: '无空间任务',
        prompt: '检查材料完整性。',
        first_run_at: '2026-08-16T09:00:00+08:00',
        every_seconds: 86_400,
        cadence_label: '每天',
        enabled: true,
      },
      agent: { id: sessionId } as Agent,
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ isError: true })
    expect(JSON.stringify(result.content)).toContain('未唯一绑定企业空间')
    await dispose()
  })

  it('corrects a fabricated completion claim when no automation tool ran', async () => {
    const { ctx, service, dispose } = await boot()
    const session = Session.create(SessionId('session-fabricated-automation'))
    const steer = vi.fn<(message: ReturnType<typeof createUserMessage>) => void>()
    const agent = { id: session.id, session, steer } as unknown as Agent
    const message = createUserMessage({
      content: [{ type: 'text', text: '帮我创建一个每天早上八点推送股票热点的自动化任务' }],
      source: { kind: 'user' },
    })
    await ctx.waterfall(ctx as never, 'agent/pre-step', {
      agent, messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [message] }))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '✅ 定时任务已创建并启用，任务编号：automation-1f4547cc-a3f3-47a1-9c1a-1659bacc3be8' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1, signal: new AbortController().signal,
    })
    expect(steer).toHaveBeenCalledOnce()
    const correction = steer.mock.calls[0]?.[0]
    expect(correction).toBeDefined()
    if (correction === undefined) throw new Error('missing automation correction message')
    expect(messageText(correction)).toContain('并未创建')
    await expect(service.snapshot()).resolves.toMatchObject({ tasks: [] })
    await dispose()
  })

  it('allows a truthful failure after an automation dispatch is rejected', async () => {
    const { ctx, dispose } = await boot()
    const session = Session.create(SessionId('session-failed-automation'))
    const steer = vi.fn<(message: ReturnType<typeof createUserMessage>) => void>()
    const agent = { id: session.id, session, steer } as unknown as Agent
    const message = createUserMessage({
      content: [{ type: 'text', text: '新建每天执行一次的定时任务' }], source: { kind: 'user' },
    })
    await ctx.waterfall(ctx as never, 'agent/pre-step', {
      agent, messages: [message], turn: 2, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [message] }))
    session.append('turn/start', { turn: 2 })
    session.append('tool/code-dispatch-start', {
      rootCallId: ToolCallId('root'), parentCallId: ToolCallId('root'), subCallId: ToolCallId('root:code:1'),
      name: 'gongchuang_create_automation', arguments: {},
    })
    session.append('tool/code-dispatch', {
      rootCallId: ToolCallId('root'), parentCallId: ToolCallId('root'), subCallId: ToolCallId('root:code:1'),
      name: 'gongchuang_create_automation', arguments: {}, isError: true,
      content: [{ type: 'text', text: '用户取消' }],
    })
    session.append('assistant/message', {
      stream: [],
      turn: 2, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '你取消了确认，因此任务没有创建。' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 2, signal: new AbortController().signal,
    })
    expect(steer).not.toHaveBeenCalled()
    await dispose()
  })

  it('accepts an alpha PTC success whose dispatch events inherit the enclosing turn', async () => {
    const { ctx, dispose } = await boot()
    const session = Session.create(SessionId('session-ptc-automation-success'))
    const steer = vi.fn<(message: ReturnType<typeof createUserMessage>) => void>()
    const agent = { id: session.id, session, steer } as unknown as Agent
    const message = createUserMessage({
      content: [{ type: 'text', text: '帮我创建一个每天执行的自动化任务' }], source: { kind: 'user' },
    })
    await ctx.waterfall(ctx as never, 'agent/pre-step', {
      agent, messages: [message], turn: 3, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [message] }))
    session.append('turn/start', { turn: 3 })
    session.append('tool/code-dispatch-start', {
      rootCallId: ToolCallId('ptc-root'), parentCallId: ToolCallId('ptc-root'),
      subCallId: ToolCallId('ptc-root:code:1'), name: 'gongchuang_create_automation', arguments: {},
    })
    session.append('tool/code-dispatch', {
      rootCallId: ToolCallId('ptc-root'), parentCallId: ToolCallId('ptc-root'),
      subCallId: ToolCallId('ptc-root:code:1'), name: 'gongchuang_create_automation', arguments: {},
      isError: false, content: [{ type: 'text', text: '{"status":"saved"}' }],
    })
    session.append('assistant/message', {
      stream: [],
      turn: 3, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '定时任务已创建并启用。' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 3, signal: new AbortController().signal,
    })
    expect(steer).not.toHaveBeenCalled()
    await dispose()
  })

  it('accepts a native successful tool result before a completion claim', async () => {
    const { ctx, dispose } = await boot()
    const steer = vi.fn<(message: ReturnType<typeof createUserMessage>) => void>()
    const callId = ToolCallId('native-automation-success')
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: '定时任务已创建并启用。' }],
      source: { provider: 'mock', model: 'mock' },
    })
    const events = [
      { type: 'tool/call', seq: 1, data: { turn: 3, step: 1, callId, name: 'gongchuang_create_automation', arguments: '{}' } },
      {
        type: 'tool/result', seq: 2,
        data: {
          turn: 3, step: 1,
          message: createToolResultMessage({
            callId, content: [{ type: 'text', text: '{"status":"saved"}' }], isError: false,
          }),
        },
      },
      { type: 'assistant/message', seq: 3, data: { turn: 3, step: 1, message: assistant } },
    ]
    const agent = {
      session: {
        // alpha.4 removed the public mutable `events` array. Product code must
        // read an immutable point-in-time snapshot through this API.
        snapshotEvents: () => events,
      },
      steer,
    } as unknown as Agent
    const message = createUserMessage({
      content: [{ type: 'text', text: '帮我创建一个每天执行的自动化任务' }], source: { kind: 'user' },
    })
    await ctx.waterfall(ctx as never, 'agent/pre-step', {
      agent, messages: [message], turn: 3, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [message] }))
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 3, signal: new AbortController().signal,
    })
    expect(steer).not.toHaveBeenCalled()
    await dispose()
  })

  it.each(['partial', 'wrong-id', 'truthful-partial'] as const)(
    'checks per-call creation receipts without repeating a correction: %s', async (scenario) => {
      const { ctx, dispose } = await boot()
      const session = Session.create(SessionId(`creation-receipts-${scenario}`))
      const steer = vi.fn()
      const agent = { id: session.id, session, steer } as unknown as Agent
      const message = createUserMessage({
        content: [{ type: 'text', text: '创建两个自动化任务' }], source: { kind: 'user' },
      })
      await ctx.waterfall(ctx as never, 'agent/pre-step', {
        agent, messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
      }, () => Promise.resolve({ kind: 'enter' as const, messages: [message] }))
      session.append('turn/start', { turn: 1 })
      const savedId = 'automation-00000000-0000-4000-8000-000000000001'
      for (const [index, isError] of [[1, false], [2, true]] as const) {
        const callId = ToolCallId(`create-${String(index)}`)
        session.append('tool/call', {
          turn: 1, step: 1, callId, name: 'gongchuang_create_automation', arguments: '{}',
        })
        session.append('tool/result', {
          turn: 1, step: 1,
          message: createToolResultMessage({
            callId, isError, content: [{ type: 'text', text: isError ? '用户取消' : JSON.stringify({ status: 'saved', id: savedId }) }],
          }),
        }, { surfaceOp: 'append' })
      }
      const text = scenario === 'partial' ? '已全部创建成功。'
        : scenario === 'wrong-id' ? '任务编号：automation-00000000-0000-4000-8000-000000000002'
          : `已创建一个任务，另一个已取消。任务编号：${savedId}`
      const closing = () => session.append('assistant/message', {
        stream: [],
        turn: 1, step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'mock', model: 'mock' } }),
      }, { surfaceOp: 'append' })
      closing()
      await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: new AbortController().signal })
      expect(steer).toHaveBeenCalledTimes(scenario === 'truthful-partial' ? 0 : 1)
      closing()
      await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: new AbortController().signal })
      expect(steer).toHaveBeenCalledTimes(scenario === 'truthful-partial' ? 0 : 1)
      await dispose()
    },
  )

  it('uses a selected first run time and edits the task without losing history', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'))
    const { service, dispose } = await boot(undefined, [workspace('workspace-edit', ['session-edit-result'])])
    const task = await service.createTask({
      name: '可编辑任务', prompt: '检查政策原文和来源。', workspaceId: 'workspace-edit',
      everySeconds: 86_400, cadenceLabel: '每 24 小时', enabled: true,
      firstRunAt: '2026-08-15T01:30:00.000Z',
    })
    expect(task).toMatchObject({
      scheduleAnchorAt: '2026-08-15T01:30:00.000Z',
      nextRunAt: '2026-08-15T01:30:00.000Z',
    })
    const claim = await service.runTaskNow({ id: task.id })
    await service.bindRunSession({
      runId: claim.runId, runToken: claim.runToken, sessionId: 'session-edit-result',
    })
    await service.completeRun({
      runId: claim.runId, runToken: claim.runToken, status: 'dispatched', message: '执行完成',
      sessionId: 'session-edit-result',
    })
    const updated = await service.updateTask({
      id: task.id, name: '已编辑任务', prompt: '复核政策原文、时点和证据边界。',
      workspaceId: 'workspace-edit', everySeconds: 604_800, cadenceLabel: '每 7 天', enabled: true,
      firstRunAt: '2026-08-20T09:00:00.000Z',
    })
    expect(updated).toMatchObject({
      id: task.id, name: '已编辑任务', nextRunAt: '2026-08-20T09:00:00.000Z',
      recentRuns: [{ status: 'dispatched', manual: true, message: '执行完成' }],
    })
    await dispose()
  })

  it('retains the selected schedule anchor while disabled and resumes on its cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'))
    const { service, dispose } = await boot(undefined, [workspace('workspace-anchor', [])])
    const task = await service.createTask({
      name: '停用保留计划', prompt: '检查本机时间锚点。', workspaceId: 'workspace-anchor',
      everySeconds: 86_400, cadenceLabel: '每 24 小时', enabled: true,
      firstRunAt: '2026-08-15T01:30:00.000Z',
    })
    const disabled = await service.setTaskEnabled({ id: task.id, enabled: false })
    expect(disabled).toMatchObject({
      enabled: false, scheduleAnchorAt: '2026-08-15T01:30:00.000Z', nextRunAt: null,
    })
    vi.setSystemTime(new Date('2026-08-17T02:00:00.000Z'))
    const enabled = await service.setTaskEnabled({ id: task.id, enabled: true })
    expect(enabled).toMatchObject({
      enabled: true, scheduleAnchorAt: '2026-08-15T01:30:00.000Z', nextRunAt: '2026-08-18T01:30:00.000Z',
    })
    await dispose()
  })

  it('removes one task together with its retained run history', async () => {
    const { service, dispose } = await boot(undefined, [workspace('workspace-delete', ['session-delete-result'])])
    const task = await service.createTask({
      name: '待删除任务', prompt: '验证删除任务时同步清理运行回执。', workspaceId: 'workspace-delete',
      everySeconds: 86_400, cadenceLabel: '每 24 小时', enabled: true,
    })
    const claim = await service.runTaskNow({ id: task.id })
    await service.bindRunSession({
      runId: claim.runId, runToken: claim.runToken, sessionId: 'session-delete-result',
    })
    await service.completeRun({
      runId: claim.runId, runToken: claim.runToken, status: 'dispatched', message: '已完成',
      sessionId: 'session-delete-result',
    })
    await expect(service.deleteTask({ id: task.id })).resolves.toEqual({ id: task.id })
    await expect(service.snapshot()).resolves.toMatchObject({ tasks: [], running: 0, dispatched: 0, failed: 0 })
    await expect(service.deleteTask({ id: task.id })).rejects.toThrow('自动化任务不存在')
    await dispose()
  })

  it('persists a task and records an authenticated manual dispatch receipt', async () => {
    const policyWorkspace = workspace('workspace-policy', ['session-policy-result', 'session-other-result'])
    const first = await boot(undefined, [policyWorkspace, workspace('workspace-other', [])])
    const task = await first.service.createTask({
      templateId: 'policy-watch', name: '政策更新监测', prompt: '检查政策变化并保留来源。',
      workspaceId: 'workspace-policy', everySeconds: 86_400, cadenceLabel: '每 24 小时', enabled: true,
    })
    const claim = await first.service.runTaskNow({ id: task.id })
    await expect(first.service.completeRun({
      runId: claim.runId, runToken: 'wrong-token', status: 'dispatched', message: '已提交',
    })).rejects.toThrow('令牌无效')
    await first.service.bindRunSession({
      runId: claim.runId, runToken: claim.runToken, sessionId: 'session-policy-result',
    })
    await expect(first.service.bindRunSession({
      runId: claim.runId, runToken: claim.runToken, sessionId: 'session-other-result',
    })).rejects.toThrow('结果会话已变更')
    await first.service.completeRun({
      runId: claim.runId, runToken: claim.runToken, status: 'dispatched',
      message: '已提交到企业空间会话', sessionId: 'session-policy-result',
    })
    await first.dispose()

    const second = await boot(first.root, [policyWorkspace, workspace('workspace-other', [])])
    await expect(second.service.snapshot()).resolves.toMatchObject({
      tasks: [{ id: task.id, enabled: true, conversationSessionId: 'session-policy-result', lastRun: {
        status: 'dispatched', message: '已提交到企业空间会话', sessionId: 'session-policy-result',
      } }],
      running: 0, dispatched: 1, failed: 0,
    })
    const repeated = await second.service.runTaskNow({ id: task.id })
    expect(repeated.conversationSessionId).toBe('session-policy-result')
    await expect(second.service.snapshot()).resolves.toMatchObject({
      tasks: [{ id: task.id, conversationSessionId: 'session-policy-result', lastRun: {
        status: 'running', sessionId: null,
      } }],
    })
    await expect(second.service.completeRun({
      runId: repeated.runId, runToken: repeated.runToken, status: 'dispatched', message: '不应成功',
    })).rejects.toThrow('完成前必须先绑定')
    await second.service.bindRunSession({
      runId: repeated.runId, runToken: repeated.runToken, sessionId: 'session-other-result',
      previousSessionId: 'session-policy-result',
    })
    await second.service.completeRun({
      runId: repeated.runId, runToken: repeated.runToken, status: 'failed',
      message: '删除后换绑回归演练', sessionId: 'session-other-result',
    })
    await expect(second.service.snapshot()).resolves.toMatchObject({
      tasks: [{ id: task.id, conversationSessionId: 'session-other-result' }],
    })
    await expect(second.service.createTask({
      templateId: 'policy-watch', name: '政策更新监测', prompt: '检查政策变化并保留来源。',
      workspaceId: 'workspace-other', everySeconds: 86_400, cadenceLabel: '每 24 小时', enabled: true,
    })).rejects.toThrow('已绑定结果对话，不能更换企业空间')
    await second.dispose()
  })

  it('migrates an older run receipt into the task-level conversation binding', async () => {
    const legacyWorkspace = workspace('workspace-legacy', ['session-legacy-result'])
    const first = await boot(undefined, [legacyWorkspace])
    const task = await first.service.createTask({
      name: '旧任务', prompt: '继续使用已有结果对话。', workspaceId: 'workspace-legacy',
      everySeconds: 300, cadenceLabel: '每 5 分钟', enabled: true,
    })
    const claim = await first.service.runTaskNow({ id: task.id })
    await first.service.bindRunSession({
      runId: claim.runId, runToken: claim.runToken, sessionId: 'session-legacy-result',
    })
    await first.service.completeRun({
      runId: claim.runId, runToken: claim.runToken, status: 'dispatched', message: '旧版完成',
      sessionId: 'session-legacy-result',
    })
    await first.dispose()
    const path = join(first.root, 'registry.json')
    const legacy = JSON.parse(await readFile(path, 'utf8')) as { tasks: Array<Record<string, unknown>> }
    delete legacy.tasks[0]?.['conversationSessionId']
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')

    const second = await boot(first.root, [legacyWorkspace])
    await expect(second.service.snapshot()).resolves.toMatchObject({
      tasks: [{ id: task.id, conversationSessionId: 'session-legacy-result' }],
    })
    const repeated = await second.service.runTaskNow({ id: task.id })
    expect(repeated.conversationSessionId).toBe('session-legacy-result')
    await second.dispose()
  })

  it('keeps an unbound active claim in its workspace until settlement', async () => {
    const { service, dispose } = await boot(undefined, [workspace('workspace-owner', []), workspace('workspace-other', [])])
    const definition = {
      templateId: 'claim-owner', name: '运行归属', prompt: '检查当前空间。', workspaceId: 'workspace-owner',
      everySeconds: 300, cadenceLabel: '每 5 分钟', enabled: true,
    }
    const task = await service.createTask(definition)
    const claim = await service.runTaskNow({ id: task.id })
    await expect(service.updateTask({ ...definition, id: task.id, workspaceId: 'workspace-other' }))
      .rejects.toThrow('不能更换企业空间')
    await expect(service.createTask({ ...definition, workspaceId: 'workspace-other' }))
      .rejects.toThrow('不能更换企业空间')
    await expect(service.deleteTask({ id: task.id })).resolves.toEqual({ id: task.id })
    await expect(service.dispatchRun({ ...claim, content: '迟到消息' })).rejects.toThrow('自动化运行不存在')
    await expect(service.completeRun({ ...claim, status: 'failed', message: '运行已停止' })).resolves.toBeNull()
    await dispose()
  })

  it.each(['active', 'queued'] as const)('stops only the owned %s message before removing a task', async (mode) => {
    const session = Session.create(SessionId(`delete-${mode}`))
    const { ctx, service, dispose } = await boot(undefined, [workspace('workspace-stop', [session.id])])
    const pending: ReturnType<typeof createUserMessage>[] = []
    const cancel = vi.fn()
    const agent = { id: session.id, session, status: 'running', cancel, inbox: {
      nextTurn: pending, nextStep: [],
      remove: vi.fn((id: string) => {
        const index = pending.findIndex(message => message.id === id)
        if (index < 0) return false
        pending.splice(index, 1)
        return true
      }),
    } } as unknown as Agent
    const prompt = vi.fn(async (request: { requestId: string; content: { type: 'text'; text: string }[] }) => {
      const message = createUserMessage({ content: request.content, source: { kind: 'user', rpcId: request.requestId } })
      if (mode === 'queued') pending.push(message)
      else agentEvents(ctx, agent).emit('agent/inbox/claimed', { message, turn: 1 })
      return { accepted: true }
    })
    ctx.provide('sessionController', { prompt, resolveAgent: async () => ({ agent }) } as never)
    const manual = createUserMessage({ content: [{ type: 'text', text: '手动消息' }], source: { kind: 'user', rpcId: 'manual' } })
    pending.push(manual)
    try {
      const task = await service.createTask({ name: '停止测试', prompt: '测试内容', workspaceId: 'workspace-stop', everySeconds: 300, cadenceLabel: '每5分钟', enabled: true })
      const claim = await service.runTaskNow({ id: task.id })
      await service.bindRunSession({ ...claim, sessionId: session.id })
      await service.dispatchRun({ ...claim, content: '自动任务消息' })
      await service.dispatchRun({ ...claim, content: '自动任务消息' })
      expect(prompt).toHaveBeenCalledOnce()
      const deletion = service.deleteTask({ id: task.id })
      if (mode === 'active') {
        await vi.waitFor(() => { expect(cancel).toHaveBeenCalledOnce() })
        expect((await service.snapshot()).tasks[0]).toMatchObject({ enabled: false, nextRunAt: null })
        await expect(service.runTaskNow({ id: task.id })).rejects.toThrow('正在停止并删除')
        session.append('turn/start', { turn: 1 })
        const ended = session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
        ctx.emit('session/event', session, ended)
      }
      await expect(deletion).resolves.toEqual({ id: task.id })
      expect(pending).toEqual([manual])
      expect(cancel).toHaveBeenCalledTimes(mode === 'active' ? 1 : 0)
      expect((await service.snapshot()).tasks).toEqual([])
      expect(agent.session).toBe(session)
      await expect(service.completeRun({ ...claim, status: 'failed', message: '已取消' })).resolves.toBeNull()
    } finally {
      await dispose()
    }
  })

  it('keeps a timed-out stop disabled and lets the user retry deletion', async () => {
    const session = Session.create(SessionId('stop-timeout'))
    const { ctx, service, dispose } = await boot(undefined, [workspace('workspace-stop', [session.id])])
    const cancel = vi.fn()
    const agent = { id: session.id, session, status: 'running', cancel, inbox: { nextTurn: [], nextStep: [] } } as unknown as Agent
    ctx.provide('sessionController', {
      resolveAgent: async () => ({ agent }),
      prompt: async (request: { requestId: string }) => {
        agentEvents(ctx, agent).emit('agent/inbox/claimed', {
          turn: 1, message: createUserMessage({ content: [], source: { kind: 'user', rpcId: request.requestId } }),
        })
        return { accepted: true }
      },
    } as never)
    try {
      const task = await service.createTask({ name: '停止超时', prompt: '测试内容', workspaceId: 'workspace-stop', everySeconds: 300, cadenceLabel: '每5分钟', enabled: true })
      const claim = await service.runTaskNow({ id: task.id })
      await service.bindRunSession({ ...claim, sessionId: session.id })
      await service.dispatchRun({ ...claim, content: '自动任务消息' })
      vi.useFakeTimers()
      const deletion = service.deleteTask({ id: task.id })
      const failure = expect(deletion).rejects.toThrow('停止执行尚未完成')
      await vi.waitFor(() => { expect(cancel).toHaveBeenCalledOnce() })
      await vi.advanceTimersByTimeAsync(30_001)
      await failure
      expect((await service.snapshot()).tasks[0]).toMatchObject({ enabled: false, nextRunAt: null })
      cancel.mockImplementation(() => {
        session.append('turn/start', { turn: 1 })
        const ended = session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
        ctx.emit('session/event', session, ended)
      })
      await expect(service.deleteTask({ id: task.id })).resolves.toEqual({ id: task.id })
    } finally {
      await dispose()
    }
  })

  it('waits for a timed-out execution to stop without blocking other task operations', async () => {
    const session = Session.create(SessionId('failed-run-stop'))
    const { ctx, service, dispose } = await boot(undefined, [workspace('workspace-stop', [session.id])])
    const cancel = vi.fn()
    const agent = { id: session.id, session, status: 'running', cancel, inbox: { nextTurn: [], nextStep: [] } } as unknown as Agent
    ctx.provide('sessionController', {
      resolveAgent: async () => ({ agent }),
      prompt: async (request: { requestId: string }) => {
        agentEvents(ctx, agent).emit('agent/inbox/claimed', {
          turn: 1, message: createUserMessage({ content: [], source: { kind: 'user', rpcId: request.requestId } }),
        })
        return { accepted: true }
      },
    } as never)
    try {
      const task = await service.createTask({ name: '等待超时', prompt: '测试内容', workspaceId: 'workspace-stop', everySeconds: 300, cadenceLabel: '每5分钟', enabled: true })
      const claim = await service.runTaskNow({ id: task.id })
      await service.bindRunSession({ ...claim, sessionId: session.id })
      await service.dispatchRun({ ...claim, content: '自动任务消息' })
      const completion = service.completeRun({ ...claim, status: 'failed', message: '等待结果超时' })
      await vi.waitFor(() => { expect(cancel).toHaveBeenCalledOnce() })
      await expect(service.runTaskNow({ id: task.id })).rejects.toThrow('已有一次运行正在执行')
      const other = await service.createTask({ name: '另一任务', prompt: '独立内容', workspaceId: 'workspace-stop', everySeconds: 300, cadenceLabel: '每5分钟', enabled: false })
      await expect(service.runTaskNow({ id: other.id })).resolves.toMatchObject({ taskId: other.id })
      session.append('turn/start', { turn: 1 })
      const ended = session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      ctx.emit('session/event', session, ended)
      await expect(completion).resolves.toMatchObject({ lastRun: { status: 'failed', message: '等待结果超时' } })
    } finally {
      await dispose()
    }
  })

  it('retains an active completion token when newer history exceeds the limit', async () => {
    const { service, dispose } = await boot(undefined, [workspace('workspace-retention', [])])
    const definition = {
      name: '长任务', prompt: '检查当前空间。', workspaceId: 'workspace-retention',
      everySeconds: 300, cadenceLabel: '每 5 分钟', enabled: true,
    }
    const longTask = await service.createTask(definition)
    const shortTask = await service.createTask({ ...definition, name: '短任务' })
    const active = await service.runTaskNow({ id: longTask.id })
    for (let index = 0; index < 201; index++) {
      const finished = await service.runTaskNow({ id: shortTask.id })
      await service.completeRun({ ...finished, status: 'failed', message: '测试结算' })
    }
    await expect(service.snapshot()).resolves.toMatchObject({ running: 1, failed: 199 })
    await expect(service.runTaskNow({ id: longTask.id })).rejects.toThrow('已有一次运行')
    await expect(service.completeRun({ ...active, status: 'failed', message: '长任务已停止' }))
      .resolves.toMatchObject({ lastRun: { runId: active.runId, status: 'failed' } })
    await dispose()
  }, 20_000)

  it('derives the displayed cadence from the executed interval on create and edit', async () => {
    const { service, dispose } = await boot(undefined, [workspace('workspace-cadence', [])])
    const definition = {
      name: '周期一致性', prompt: '检查当前空间。', workspaceId: 'workspace-cadence',
      everySeconds: 300, cadenceLabel: '每天', enabled: false,
    }
    const task = await service.createTask(definition)
    expect(task.cadenceLabel).toBe('每 5 分钟')
    await expect(service.updateTask({ ...definition, id: task.id, everySeconds: 5_400 }))
      .resolves.toMatchObject({ cadenceLabel: '每 90 分钟', everySeconds: 5_400 })
    await expect(service.snapshot()).resolves.toMatchObject({ tasks: [{ cadenceLabel: '每 90 分钟' }] })
    await dispose()
  })

  it('rejects stale workspace selections without changing the task registry', async () => {
    const workspaces = [workspace('workspace-stale', [])]
    const { service, root, dispose } = await boot(undefined, workspaces)
    const definition = {
      name: '空间已删除', prompt: '检查当前空间。', workspaceId: 'workspace-stale',
      everySeconds: 300, cadenceLabel: '每 5 分钟', enabled: false,
    }
    const task = await service.createTask(definition)
    const before = await readFile(join(root, 'registry.json'), 'utf8')
    workspaces.splice(0)
    await expect(service.createTask(definition)).rejects.toThrow('企业空间不存在')
    await expect(service.updateTask({ ...definition, id: task.id })).rejects.toThrow('企业空间不存在')
    expect(await readFile(join(root, 'registry.json'), 'utf8')).toBe(before)
    await dispose()
  })

  it.each(['2030-02-30T09:00:00+08:00', '2030-02-28T09:00:00', '2030-02-28'])(
    'rejects an invalid or timezone-free first run: %s', async (firstRunAt) => {
      const { service, root, dispose } = await boot(undefined, [workspace('workspace-time', [])])
      await expect(service.createTask({
        name: '时间校验', prompt: '检查当前空间。', workspaceId: 'workspace-time', everySeconds: 300,
        cadenceLabel: '每 5 分钟', firstRunAt, enabled: true,
      })).rejects.toThrow('带时区的有效日期时间')
      expect(await readdir(root)).toEqual([])
      await dispose()
    },
  )

  it('shows the actual interval in the user approval presentation', async () => {
    const { ctx, dispose } = await boot()
    const presentation = ctx.tools.get('gongchuang_create_automation')?.presentCall?.({
      name: '周期确认', every_seconds: 300, cadence_label: '每天',
      first_run_at: '2030-09-03T09:00:00+08:00', enabled: true, prompt: '检查当前空间。',
    })
    if (presentation === undefined || !('rawInput' in presentation)) throw new Error('missing approval text')
    expect(presentation.rawInput).toContain('每 5 分钟')
    await dispose()
  })

  it('claims an overdue fixed-rate task once and advances its next run', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'))
    const { service, dispose } = await boot(undefined, [workspace('workspace-check', [])])
    const task = await service.createTask({
      name: '定时检查', prompt: '执行材料一致性检查。', workspaceId: 'workspace-check',
      everySeconds: 300, cadenceLabel: '每 5 分钟', enabled: true,
    })
    expect(await service.claimDue()).toBeNull()
    vi.setSystemTime(new Date('2026-08-14T12:05:00.000Z'))
    const claim = await service.claimDue()
    if (claim === null) throw new Error('expected the task to be due')
    expect(claim).toMatchObject({ taskId: task.id, manual: false, scheduledAt: '2026-08-14T12:05:00.000Z' })
    await expect(service.claimDue()).resolves.toBeNull()
    await service.completeRun({
      runId: claim.runId, runToken: claim.runToken, status: 'failed', message: '企业空间不可用',
    })
    await expect(service.snapshot()).resolves.toMatchObject({
      tasks: [{ nextRunAt: '2026-08-14T12:10:00.000Z', lastRun: { status: 'failed' } }],
    })
    await dispose()
  })

  it('skips a task still running across its next cadence and claims another due task', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'))
    const { service, dispose } = await boot(undefined, [workspace('workspace-a', []), workspace('workspace-b', [])])
    const long = await service.createTask({
      name: '长任务 A', prompt: '持续执行跨周期任务。', workspaceId: 'workspace-a',
      everySeconds: 300, cadenceLabel: '每 5 分钟', enabled: true,
      firstRunAt: '2026-08-14T12:05:00.000Z',
    })
    const independent = await service.createTask({
      name: '独立任务 B', prompt: '执行另一项到期任务。', workspaceId: 'workspace-b',
      everySeconds: 300, cadenceLabel: '每 5 分钟', enabled: true,
      firstRunAt: '2026-08-14T12:11:00.000Z',
    })

    vi.setSystemTime(new Date('2026-08-14T12:05:00.000Z'))
    const first = await service.claimDue()
    expect(first).toMatchObject({ taskId: long.id })
    vi.setSystemTime(new Date('2026-08-14T12:11:00.000Z'))
    const second = await service.claimDue()
    expect(second).toMatchObject({ taskId: independent.id })
    await expect(service.snapshot()).resolves.toMatchObject({ running: 2 })

    if (first === null || second === null) throw new Error('expected both tasks to be claimed')
    await service.completeRun({
      runId: first.runId, runToken: first.runToken, status: 'failed', message: '测试结束',
    })
    await service.completeRun({
      runId: second.runId, runToken: second.runToken, status: 'failed', message: '测试结束',
    })
    await dispose()
  })

  it('does not write or rotate the registry when a due-task poll changes nothing', async () => {
    const { service, root, dispose } = await boot()
    await expect(service.claimDue()).resolves.toBeNull()
    await expect(service.claimDue()).resolves.toBeNull()
    expect(await readdir(root)).toEqual([])
    await dispose()
  })

  it('recovers a damaged current registry from the single fixed rollback slot', async () => {
    const first = await boot(undefined, [workspace('workspace-recovery', [])])
    const created = await first.service.createTask({
      name: '恢复测试', prompt: '验证固定回滚槽恢复逻辑。', workspaceId: 'workspace-recovery',
      everySeconds: 300, cadenceLabel: '每 5 分钟', enabled: true,
    })
    expect(JSON.parse(await readFile(join(first.root, 'registry.json'), 'utf8'))).toMatchObject({
      tasks: [{ id: created.id, name: '恢复测试' }],
    })
    await expect(first.service.snapshot()).resolves.toMatchObject({ tasks: [{ id: created.id }] })
    await first.service.setTaskEnabled({ id: created.id, enabled: false })
    await first.dispose()
    await writeFile(join(first.root, 'registry.json'), '{broken-json', 'utf8')

    const second = await boot(first.root)
    await expect(second.service.snapshot()).resolves.toMatchObject({ tasks: [{ name: '恢复测试' }] })
    expect(await readdir(first.root)).toEqual(['registry.json', 'registry.json.previous'])
    const recovered = await readFile(join(first.root, 'registry.json'), 'utf8')
    expect(() => { JSON.parse(recovered) as unknown }).not.toThrow()
    await second.dispose()
  })
})
