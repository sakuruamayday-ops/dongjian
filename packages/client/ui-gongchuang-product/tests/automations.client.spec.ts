import { describe, expect, it, vi } from 'vitest'
import type {
  AutomationClaim, AutomationRunId, AutomationSnapshot, AutomationTaskId, AutomationTaskView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  AutomationController,
  AutomationDispatchError,
  type AutomationDispatcher,
} from '../src/client/automations.ts'

const TASK_ID = 'automation-00000000-0000-4000-8000-000000000001' as AutomationTaskId
const RUN_ID = 'run-00000000-0000-4000-8000-000000000002' as AutomationRunId
const TASK = Object.freeze({
  id: TASK_ID,
  templateId: null,
  name: '重点项目通知监测',
  prompt: '检索最新项目通知并形成来源清单。',
  workspaceId: 'workspace-1',
  conversationSessionId: null,
  everySeconds: 86_400,
  cadenceLabel: '每 24 小时',
  enabled: true,
  scheduleAnchorAt: '2026-08-15T00:00:00.000Z',
  nextRunAt: '2026-08-15T00:00:00.000Z',
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
  lastRun: null,
  recentRuns: Object.freeze([]),
})
const SNAPSHOT: AutomationSnapshot = Object.freeze({
  revision: 1, tasks: Object.freeze([TASK]), running: 0, dispatched: 0, failed: 0,
})
const CLAIM: AutomationClaim = Object.freeze({
  runId: RUN_ID,
  runToken: 'one-time-token',
  taskId: TASK_ID,
  taskName: TASK.name,
  prompt: TASK.prompt,
  workspaceId: TASK.workspaceId,
  conversationSessionId: null,
  scheduledAt: '2026-08-14T01:00:00.000Z',
  manual: true,
})

function successfulRemote() {
  return {
    snapshot: vi.fn(async () => ({ ok: true as const, value: SNAPSHOT })),
    createTask: vi.fn(async () => ({ ok: true as const, value: TASK })),
    updateTask: vi.fn(async () => ({ ok: true as const, value: TASK })),
    setTaskEnabled: vi.fn(async () => ({ ok: true as const, value: TASK })),
    deleteTask: vi.fn(async () => ({ ok: true as const, value: { id: TASK_ID } })),
    bindRunSession: vi.fn(async () => ({ ok: true as const, value: TASK })),
    dispatchRun: vi.fn(async () => ({ ok: true as const, value: { requestId: `automation-run:${RUN_ID}` as SessionRequestId } })),
    claimDue: vi.fn(async (): Promise<{ ok: true; value: AutomationClaim | null }> => ({
      ok: true,
      value: null,
    })),
    runTaskNow: vi.fn(async () => ({ ok: true as const, value: CLAIM })),
    completeRun: vi.fn(async (): Promise<{ ok: true; value: AutomationTaskView | null }> => ({ ok: true, value: TASK })),
  }
}

describe('AutomationController', () => {
  it('publishes only the Host-owned task snapshot', async () => {
    const remote = successfulRemote()
    const controller = new AutomationController(remote, vi.fn())
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', snapshot: SNAPSHOT, error: null })
    expect(remote.snapshot).toHaveBeenCalledOnce()
  })

  it('replaces a stale page snapshot with an externally committed registry revision', async () => {
    const remote = successfulRemote()
    remote.snapshot
      .mockResolvedValueOnce({ ok: true as const, value: { ...SNAPSHOT, revision: 0, tasks: Object.freeze([]) } })
      .mockResolvedValueOnce({ ok: true as const, value: SNAPSHOT })
    const controller = new AutomationController(remote, vi.fn())
    await controller.load()
    expect(controller.store.getSnapshot().snapshot).toMatchObject({ revision: 0, tasks: [] })
    await controller.load()
    expect(controller.store.getSnapshot().snapshot).toMatchObject({
      revision: 1, tasks: [{ id: TASK_ID, name: TASK.name }],
    })
  })

  it('persists edits through the Host while preserving the task id', async () => {
    const remote = successfulRemote()
    const controller = new AutomationController(remote, vi.fn())
    await controller.update({
      id: TASK_ID, name: '修改后的任务', prompt: TASK.prompt, workspaceId: TASK.workspaceId,
      everySeconds: 604_800, cadenceLabel: '每 7 天', enabled: true,
      firstRunAt: '2026-08-20T09:00:00.000Z',
    })
    expect(remote.updateTask).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID, name: '修改后的任务' }))
    expect(controller.store.getSnapshot().notice).toContain('下次运行时间已重新计算')
  })

  it('persists creation through the Host and never marks success before a Host receipt', async () => {
    const remote = successfulRemote()
    const controller = new AutomationController(remote, vi.fn())
    await controller.create({
      name: TASK.name, prompt: TASK.prompt, workspaceId: TASK.workspaceId,
      everySeconds: TASK.everySeconds, cadenceLabel: TASK.cadenceLabel, enabled: true,
    })
    expect(remote.createTask).toHaveBeenCalledOnce()
    expect(remote.snapshot).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', snapshot: SNAPSHOT, notice: `${TASK.name} 已保存到本机任务注册表`, error: null,
    })
  })

  it('removes a task through the Host and refreshes the durable snapshot', async () => {
    const remote = successfulRemote()
    const controller = new AutomationController(remote, vi.fn())
    await controller.remove(TASK_ID)
    expect(remote.deleteTask).toHaveBeenCalledWith({ id: TASK_ID })
    expect(remote.snapshot).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', snapshot: SNAPSHOT, notice: '任务已删除', error: null,
    })
  })

  it('settles the one-time run claim as failed when workspace dispatch fails', async () => {
    const remote = successfulRemote()
    const dispatch = vi.fn(async () => { throw new Error('企业空间不可用') })
    const controller = new AutomationController(remote, dispatch)
    await expect(controller.runNow(TASK_ID)).rejects.toThrow('GC-UI-UNKNOWN')
    expect(remote.snapshot).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledWith(CLAIM, expect.any(Function), expect.any(Function))
    expect(remote.completeRun).toHaveBeenCalledWith({
      runId: RUN_ID, runToken: 'one-time-token', status: 'failed',
      message: '操作未完成，请稍后重试（诊断码：GC-UI-UNKNOWN）',
    })
    expect(controller.store.getSnapshot()).toMatchObject({
      executing: [], error: '操作未完成，请稍后重试（诊断码：GC-UI-UNKNOWN）',
    })
  })

  it('persists the actual result session in a successful run receipt', async () => {
    const remote = successfulRemote()
    const dispatch: AutomationDispatcher = async (_claim, bindSession, admitMessage) => {
      await bindSession('session-result-1')
      expect(await admitMessage('自动任务消息')).toBe(`automation-run:${RUN_ID}`)
      return {
        message: '已完成，结果已保存到企业空间 测试企业', sessionId: 'session-result-1',
      }
    }
    const controller = new AutomationController(remote, vi.fn(dispatch))
    await controller.runNow(TASK_ID)
    expect(remote.bindRunSession).toHaveBeenCalledWith({
      runId: RUN_ID, runToken: 'one-time-token', sessionId: 'session-result-1',
    })
    expect(remote.completeRun).toHaveBeenCalledWith({
      runId: RUN_ID,
      runToken: 'one-time-token',
      status: 'dispatched',
      message: '已完成，结果已保存到企业空间 测试企业',
      sessionId: 'session-result-1',
    })
    expect(controller.store.getSnapshot().notice).toBe(`${TASK.name} 已完成，结果已保存到企业空间`)
  })

  it('does not show a spurious receipt error when deletion finishes before the stopped run reports back', async () => {
    const remote = successfulRemote()
    const finish = Promise.withResolvers<{ message: string; sessionId: string }>()
    const dispatch = vi.fn(() => finish.promise)
    const controller = new AutomationController(remote, dispatch)
    const running = controller.runNow(TASK_ID)
    await vi.waitFor(() => { expect(dispatch).toHaveBeenCalledOnce() })
    remote.snapshot.mockResolvedValue({ ok: true, value: { ...SNAPSHOT, revision: 2, tasks: [] } })
    await controller.remove(TASK_ID)
    remote.completeRun.mockResolvedValueOnce({ ok: true, value: null })
    finish.reject(new AutomationDispatchError(new Error('已取消'), 'session-result'))
    await running
    expect(controller.store.getSnapshot()).toMatchObject({ executing: [], error: null, notice: '任务已删除' })
  })

  it('keeps registry edits and scheduled polling available during a manual model run', async () => {
    const remote = successfulRemote()
    const finish = Promise.withResolvers<{ message: string; sessionId: string }>()
    const dispatch = vi.fn(() => finish.promise)
    const controller = new AutomationController(remote, dispatch)
    const running = controller.runNow(TASK_ID)
    expect(controller.store.getSnapshot().executing).toEqual([TASK_ID])
    await vi.waitFor(() => { expect(dispatch).toHaveBeenCalledOnce() })
    try {
      await controller.setEnabled(TASK_ID, false)
      await controller.poll()
      expect(remote.setTaskEnabled).toHaveBeenCalledWith({ id: TASK_ID, enabled: false })
      expect(remote.claimDue).toHaveBeenCalledOnce()
      expect(remote.completeRun).not.toHaveBeenCalled()
      await expect(controller.runNow(TASK_ID)).rejects.toThrow('已有一次运行')
    } finally {
      finish.resolve({ message: '执行完成', sessionId: 'session-result' })
      await running
    }
    expect(controller.store.getSnapshot().executing).toEqual([])
  })

  it('retains the bound conversation when the model turn fails after prompt admission', async () => {
    const remote = successfulRemote()
    const dispatch: AutomationDispatcher = async (_claim, bindSession) => {
      await bindSession('session-failed-result')
      throw new AutomationDispatchError(new Error('模型运行失败'), 'session-failed-result')
    }
    const controller = new AutomationController(remote, vi.fn(dispatch))
    await expect(controller.runNow(TASK_ID)).rejects.toThrow('GC-UI-UNKNOWN')
    expect(remote.completeRun).toHaveBeenCalledWith({
      runId: RUN_ID,
      runToken: 'one-time-token',
      status: 'failed',
      message: '操作未完成，请稍后重试（诊断码：GC-UI-UNKNOWN）',
      sessionId: 'session-failed-result',
    })
  })

  it('clears executing and projects a controlled error when a manual receipt RPC rejects', async () => {
    const remote = successfulRemote()
    remote.completeRun.mockRejectedValueOnce(new Error('transport unavailable'))
    const controller = new AutomationController(remote, vi.fn(async () => ({
      message: '执行完成', sessionId: 'session-result',
    })))

    await expect(controller.runNow(TASK_ID)).rejects.toThrow('回执未提交')
    const state = controller.store.getSnapshot()
    expect(state.executing).toEqual([])
    expect(state.error).toContain('回执未提交')
  })

  it('settles polling without an unhandled rejection when receipt submission rejects', async () => {
    const remote = successfulRemote()
    remote.claimDue.mockResolvedValueOnce({ ok: true as const, value: CLAIM })
    remote.completeRun.mockRejectedValueOnce(new Error('transport unavailable'))
    const controller = new AutomationController(remote, vi.fn(async () => ({
      message: '执行完成', sessionId: 'session-result',
    })))

    await expect(controller.poll()).resolves.toBeUndefined()
    const state = controller.store.getSnapshot()
    expect(state.executing).toEqual([])
    expect(state.error).toContain('回执未提交')
  })

  it('recovers from a rejected due-task poll without clearing an unrelated action error', async () => {
    const remote = successfulRemote()
    remote.claimDue.mockRejectedValueOnce(new Error('network unavailable'))
    const controller = new AutomationController(remote, vi.fn())
    await expect(controller.poll()).resolves.toBeUndefined()
    expect(controller.store.getSnapshot().error).not.toBeNull()
    await controller.poll()
    expect(controller.store.getSnapshot().error).toBeNull()
    controller.store.update((state) => { state.error = '运行回执未提交' })
    await controller.poll()
    expect(controller.store.getSnapshot().error).toBe('运行回执未提交')
  })
})
