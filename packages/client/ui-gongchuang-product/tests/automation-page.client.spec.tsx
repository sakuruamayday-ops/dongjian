// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRunId, AutomationTaskId } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AutomationState } from '../src/client/automations.ts'
import { ProductOverlay, type ProductOverlayProps, type ProductUiState } from '../src/client/ProductShell.tsx'

afterEach(cleanup)

function hook<TState>(state: TState) {
  return <TSelected,>(selector: (value: TState) => TSelected): TSelected => selector(state)
}

const TASK_ID = 'automation-00000000-0000-4000-8000-000000000001' as AutomationTaskId
const WORKSPACE_ID = 'workspace-1' as WorkspaceId
const workspace = {
  workspaceId: WORKSPACE_ID, title: '杭州测试企业', path: '/projects/company', sessionIds: [], pinnedSessionIds: [],
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
}
const workspaces = {
  items: [workspace], archivedItems: [], deletedItems: [], archivedWorkspaceIds: [], deletedWorkspaceIds: [],
  archivedSessionIds: [], deletedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  baselinesReady: true, recentWorkspaceId: WORKSPACE_ID,
}
const automation: AutomationState = {
  status: 'ready', executing: [], notice: null, error: null,
  snapshot: {
    revision: 3, running: 0, dispatched: 1, failed: 0,
    tasks: [{
      id: TASK_ID, templateId: 'policy-watch', name: '政策通知监测',
      prompt: '检索政府官网原文，核对时点并输出来源清单。', workspaceId: WORKSPACE_ID,
      conversationSessionId: 'session-result-1',
      everySeconds: 86_400, cadenceLabel: '每 24 小时', enabled: true,
      scheduleAnchorAt: '2026-08-16T01:30:00.000Z', nextRunAt: '2026-08-16T01:30:00.000Z',
      createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
      lastRun: {
        runId: 'run-00000000-0000-4000-8000-000000000002' as AutomationRunId,
        status: 'dispatched', startedAt: '2026-08-15T00:00:00.000Z', finishedAt: '2026-08-15T00:01:00.000Z',
        scheduledAt: '2026-08-15T00:00:00.000Z', manual: false, message: '已完成，结果已保存到企业空间',
        sessionId: 'session-result-1',
      },
      recentRuns: [{
        runId: 'run-00000000-0000-4000-8000-000000000002' as AutomationRunId,
        status: 'dispatched', startedAt: '2026-08-15T00:00:00.000Z', finishedAt: '2026-08-15T00:01:00.000Z',
        scheduledAt: '2026-08-15T00:00:00.000Z', manual: false, message: '已完成，结果已保存到企业空间',
        sessionId: 'session-result-1',
      }],
    }],
  },
}

function renderAutomation(automationState: AutomationState = automation) {
  const product: ProductUiState = { page: 'automation', provider: 'deepseek', accountDialogRevision: 0 }
  const actions = {
    useProduct: hook(product),
    useWindowsClosePrompt: hook({ requestId: null }),
    useConnectivity: hook({ deepseekFiles: { retentionSeconds: 3_600 } }),
    useAutomations: hook(automationState), useWorkspaces: hook(workspaces),
    useSessions: hook({ byId: {} }),
    createAutomation: vi.fn(() => Promise.resolve()), updateAutomation: vi.fn(() => Promise.resolve()),
    setAutomationEnabled: vi.fn(() => Promise.resolve()), runAutomationNow: vi.fn(() => Promise.resolve()),
    openAutomationResult: vi.fn(() => Promise.resolve()),
    removeAutomation: vi.fn(() => Promise.resolve()),
  }
  render(<ProductOverlay {...actions as unknown as ProductOverlayProps} />)
  return actions
}

describe('自动化任务可操作界面', () => {
  it('摘要只展示本机任务状态，不展示内部门禁标签', () => {
    renderAutomation()
    expect(screen.queryByText('门禁')).toBeNull()
    expect(screen.getByText('运行环境').closest('div')?.textContent).toBe('运行环境本机')
  })

  it('可查看完整指令、时间设置和运行回执', () => {
    const actions = renderAutomation()
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    const dialog = screen.getByRole('dialog', { name: '政策通知监测' })
    expect(dialog.textContent).toContain('计划锚点')
    expect(dialog.textContent).toContain('每 24 小时')
    expect(dialog.textContent).toContain('检索政府官网原文')
    expect(dialog.textContent).toContain('已完成')
    expect(dialog.textContent).toContain('结果已保存到企业空间')
    fireEvent.click(screen.getByRole('button', { name: '打开结果会话' }))
    expect(actions.openAutomationResult).toHaveBeenCalledWith('session-result-1')
  })

  it('失败运行已绑定结果会话时仍可打开检查', () => {
    const failedRun = {
      ...automation.snapshot.tasks[0]!.lastRun!,
      status: 'failed' as const,
      message: '模型运行失败',
    }
    const actions = renderAutomation({
      ...automation,
      snapshot: {
        ...automation.snapshot,
        tasks: [{
          ...automation.snapshot.tasks[0]!,
          lastRun: failedRun,
          recentRuns: [failedRun],
        }],
      },
    })
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    fireEvent.click(screen.getByRole('button', { name: '打开结果会话' }))
    expect(actions.openAutomationResult).toHaveBeenCalledWith('session-result-1')
  })

  it('本机执行队列即时计入执行中数量', () => {
    renderAutomation({ ...automation, executing: [TASK_ID] })
    expect(screen.getByText('执行中').closest('div')?.textContent).toBe('执行中1')
    expect(screen.getByRole('button', { name: '删除' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: '停用' }).hasAttribute('disabled')).toBe(false)
  })

  it('运行中的任务可以确认停止并删除，停止失败后按钮可重试', async () => {
    const actions = renderAutomation({ ...automation, executing: [TASK_ID] })
    actions.removeAutomation.mockRejectedValueOnce(new Error('停止执行尚未完成；任务已停用，请稍后重试删除'))
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(screen.getByText('停止本次执行并删除任务。对话和文件保留。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '停止并删除' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '停止并删除' }).hasAttribute('disabled')).toBe(false) })
    expect(screen.getAllByText('停止执行尚未完成；任务已停用，请稍后重试删除').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '停止并删除' }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '删除自动化任务' })).toBeNull() })
    expect(actions.removeAutomation).toHaveBeenCalledTimes(2)
  })

  it('立即运行未结束时仍可停用后续调度', async () => {
    const actions = renderAutomation()
    const finish = Promise.withResolvers<undefined>()
    actions.runAutomationNow.mockImplementationOnce(() => finish.promise)
    fireEvent.click(screen.getByRole('button', { name: '立即运行' }))
    expect(screen.getByRole('button', { name: '停用' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '停用' }))
    await waitFor(() => { expect(actions.setAutomationEnabled).toHaveBeenCalledWith(TASK_ID, false) })
    finish.resolve(undefined)
  })

  it('旧版仅提交回执不冒充已完成', () => {
    const legacyRun = {
      ...automation.snapshot.tasks[0]!.lastRun!,
      message: '已提交到企业空间，等待模型处理',
    }
    const legacyAutomation: AutomationState = {
      ...automation,
      snapshot: {
        ...automation.snapshot,
        tasks: [{
          ...automation.snapshot.tasks[0]!,
          lastRun: legacyRun,
          recentRuns: [legacyRun],
        }],
      },
    }
    renderAutomation(legacyAutomation)
    expect(screen.getByText(/已提交 · 已提交到企业空间/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    const dialog = screen.getByRole('dialog', { name: '政策通知监测' })
    expect(dialog.textContent).toContain('已提交')
    expect(dialog.textContent).not.toContain('已完成')
  })

  it('可编辑名称、周期、首次执行时间和指令并保存', async () => {
    const actions = renderAutomation()
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' }).at(-1)!)
    const dialog = screen.getByRole('dialog', { name: '编辑自动化任务' })
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '省级政策每周监测' } })
    fireEvent.change(screen.getByLabelText('执行周期'), { target: { value: '604800' } })
    fireEvent.change(screen.getByLabelText('首次执行时间'), { target: { value: '2026-08-20T09:00' } })
    fireEvent.change(screen.getByLabelText('执行指令'), { target: { value: '每周检索省级部门官网并生成证据链。' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改并启用' }))
    await waitFor(() => {
      expect(actions.updateAutomation).toHaveBeenCalledWith(expect.objectContaining({
        id: TASK_ID, name: '省级政策每周监测', everySeconds: 604_800,
        cadenceLabel: '每 7 天', firstRunAt: new Date('2026-08-20T09:00').toISOString(),
      }))
    })
    expect(dialog).toBeTruthy()
  })

  it('支持一句话识别执行时间并在保存前复核', () => {
    renderAutomation()
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' }).at(-1)!)
    fireEvent.click(screen.getByRole('button', { name: '一句话设置' }))
    fireEvent.change(screen.getByLabelText('用一句话描述执行时间'), { target: { value: '每隔 90 分钟检查一次' } })
    fireEvent.click(screen.getByRole('button', { name: '识别并填入' }))
    expect(screen.getByText(/已识别：每 90 分钟执行/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '手动选择' }))
    expect(screen.getByLabelText<HTMLInputElement>('执行周期').value).toBe('custom')
    expect(screen.getByLabelText<HTMLInputElement>('间隔数值').value).toBe('90')
    expect(screen.getByLabelText<HTMLInputElement>('间隔单位').value).toBe('minutes')
  })

  it('支持手动选择自定义间隔并保存启用', async () => {
    const actions = renderAutomation()
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' }).at(-1)!)
    fireEvent.change(screen.getByLabelText('执行周期'), { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText('间隔数值'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('间隔单位'), { target: { value: 'days' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改并启用' }))
    await waitFor(() => {
      expect(actions.updateAutomation).toHaveBeenCalledWith(expect.objectContaining({
        everySeconds: 172_800,
        cadenceLabel: '每 2 天',
        enabled: true,
      }))
    })
  })

  it('停用和立即运行均调用真实宿主动作', async () => {
    const actions = renderAutomation()
    fireEvent.click(screen.getByRole('button', { name: '停用' }))
    expect(actions.setAutomationEnabled).toHaveBeenCalledWith(TASK_ID, false)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '立即运行' }).hasAttribute('disabled')).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: '立即运行' }))
    await waitFor(() => { expect(actions.runAutomationNow).toHaveBeenCalledWith(TASK_ID) })
  })
})
