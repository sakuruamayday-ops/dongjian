// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ConnectivityState } from '../src/client/connectivity.ts'
import { ProductOverlay, type ProductOverlayProps, type ProductUiState } from '../src/client/ProductShell.tsx'
import { providerConnections } from './provider-connections.client.ts'

afterEach(cleanup)

function hook<TState>(state: TState) {
  return <TSelected,>(selector: (value: TState) => TSelected): TSelected => selector(state)
}

const WORKSPACE_ID = 'workspace-enterprise' as WorkspaceId
const SESSION_ID = 'session-enterprise' as SessionId
const BLANK_SESSION_ID = 'session-enterprise-blank' as SessionId
const workspace = {
  workspaceId: WORKSPACE_ID,
  title: '杭州示例企业',
  path: '/projects/example',
  sessionIds: [BLANK_SESSION_ID, SESSION_ID],
  pinnedSessionIds: [],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-15T00:00:00.000Z',
}
const workspaces = {
  items: [workspace], archivedItems: [], deletedItems: [],
  archivedWorkspaceIds: [], deletedWorkspaceIds: [],
  archivedSessionIds: [], deletedSessionIds: [],
  state: 'idle', phase: 'ready', error: null,
  baselinesReady: true, recentWorkspaceId: WORKSPACE_ID,
}
const sessions: SessionListState = {
  ids: [BLANK_SESSION_ID, SESSION_ID],
  byId: {
    [BLANK_SESSION_ID]: {
      id: BLANK_SESSION_ID, title: 'New Session', displayTitle: 'New Session', cwd: workspace.path,
      running: false, blank: true, updatedAt: Date.parse('2026-08-16T08:00:00.000Z'),
    },
    [SESSION_ID]: {
      id: SESSION_ID, title: '高企申报体检', displayTitle: '高企申报体检', cwd: workspace.path,
      running: false, blank: false, updatedAt: Date.parse('2026-08-15T08:00:00.000Z'),
    },
  },
  current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
}

function renderEnterprise(
  desktop = false,
  enterpriseCreateRequested = false,
  page: ProductUiState['page'] = 'enterprise',
) {
  const product: ProductUiState = { page, provider: 'deepseek', accountDialogRevision: 0, enterpriseCreateRequested }
  const connectivity: ConnectivityState = {
    status: 'ready', activeProvider: 'deepseek', selection: 'ready', selectionError: null,
    deepseekFiles: { status: 'ready', retentionSeconds: 3_600, retentionOptions: [3_600, 604_800, 2_592_000], message: null },
    providers: providerConnections({
      deepseek: { status: 'ready', configured: true, message: '已连接' },
      'opencode-go': { status: 'missing', configured: false, message: '未配置' },
      openrouter: { status: 'missing', configured: false, message: '未配置' },
      fireworks: { status: 'missing', configured: false, message: '未配置' },
      custom: { status: 'missing', configured: false, message: '未配置' },
    }),
  }
  const actions = {
    useProduct: hook(product), useWindowsClosePrompt: hook({ requestId: null }),
    useConnectivity: hook(connectivity), useWorkspaces: hook(workspaces), useSessions: hook(sessions),
    selectProvider: vi.fn(() => Promise.resolve()), configureProvider: vi.fn(() => Promise.resolve()),
    refreshProviderConnection: vi.fn(() => Promise.resolve()),
    setDeepSeekFileRetention: vi.fn(() => Promise.resolve()), clearDeepSeekFiles: vi.fn(() => Promise.resolve(0)),
    listWorkspaceDirectory: vi.fn(() => Promise.resolve({
      path: '/projects', home: '/projects',
      crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'projects', path: '/projects', hidden: false }],
      entries: [{ name: 'new-enterprise', path: '/projects/new-enterprise', hidden: false }], truncated: false,
    })),
    createWorkspaceDirectory: vi.fn(() => Promise.resolve('/projects/new-enterprise')),
    pickAndCreateWorkspace: vi.fn(() => Promise.resolve()), openWorkspace: vi.fn(() => Promise.resolve()),
    openWorkspaceSession: vi.fn(() => Promise.resolve()), renameWorkspace: vi.fn(() => Promise.resolve()),
    renameWorkspaceSession: vi.fn(() => Promise.resolve()),
    archiveWorkspace: vi.fn(() => Promise.resolve()), deleteWorkspace: vi.fn(() => Promise.resolve()),
    archiveWorkspaceSession: vi.fn(() => Promise.resolve()), deleteWorkspaceSession: vi.fn(() => Promise.resolve()),
    consumeEnterpriseCreationRequest: vi.fn(),
  }
  const desktopActions = {
    createEnterpriseWorkspace: vi.fn(async (name: string) => ({
      name, path: `/projects/${name}`, created: true, imported: false,
    })),
    importEnterpriseWorkspace: vi.fn(async () => ({
      name: '既有企业', path: '/archive/既有企业', created: false, imported: true,
    })),
  }
  render(<ProductOverlay {...({ ...actions, ...(desktop ? desktopActions : {}) } as unknown as ProductOverlayProps)} />)
  return { ...actions, ...desktopActions }
}

describe('企业空间可操作界面', () => {
  it('概览只展示业务指标，不展示内部门禁状态', () => {
    renderEnterprise()
    expect(screen.queryByText('安全状态')).toBeNull()
    expect(screen.queryByText('操作经过策略门禁')).toBeNull()
    expect(screen.getByText('输入缓存复用')).toBeTruthy()
  })

  it('在客户端内打开可操作的目录浏览器，不依赖失焦的系统子进程窗口', async () => {
    const actions = renderEnterprise()
    fireEvent.click(screen.getByRole('button', { name: '新建企业' }))
    expect(await screen.findByRole('dialog', { name: '选择企业资料目录' })).toBeTruthy()
    await waitFor(() => { expect(actions.listWorkspaceDirectory).toHaveBeenCalledWith(undefined, expect.any(AbortSignal)) })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '选择企业资料目录' })).toBeNull()
  })

  it('目录失败只显示受控诊断码，不泄露密钥、本机路径或异常原文', async () => {
    const actions = renderEnterprise()
    actions.listWorkspaceDirectory.mockRejectedValueOnce(new Error(
      'permission denied /Users/alice/private sk-secret-1234567890',
    ))
    fireEvent.click(screen.getByRole('button', { name: '新建企业' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('客户端无法读写所选目录，请在系统设置中允许文件访问后重试（诊断码：GC-UI-WORKSPACE-PERMISSION）')
    expect(alert.textContent).not.toContain('/Users/')
    expect(alert.textContent).not.toContain('sk-secret')
    expect(alert.textContent).not.toContain('permission denied')
  })

  it('桌面端只输入企业名称就在根目录创建直属子目录', async () => {
    const actions = renderEnterprise(true)
    fireEvent.click(screen.getByRole('button', { name: '新建企业' }))
    expect(screen.getByRole('dialog', { name: '新建企业' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '企业名称' }), { target: { value: '杭州共创示例企业' } })
    fireEvent.click(screen.getByRole('button', { name: '创建并进入' }))
    await waitFor(() => { expect(actions.createEnterpriseWorkspace).toHaveBeenCalledWith('杭州共创示例企业') })
    await waitFor(() => { expect(actions.pickAndCreateWorkspace).toHaveBeenCalledWith('/projects/杭州共创示例企业') })
  })

  it('从新对话选择新建企业时原地打开创建窗口，不跳转企业空间页', async () => {
    const actions = renderEnterprise(true, true, 'assistant')
    expect(await screen.findByRole('dialog', { name: '新建企业' })).toBeTruthy()
    expect(actions.consumeEnterpriseCreationRequest).toHaveBeenCalledOnce()
    expect(screen.queryByRole('heading', { name: '企业空间' })).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: '企业名称' }), { target: { value: '杭州新建企业' } })
    fireEvent.click(screen.getByRole('button', { name: '创建并开始对话' }))
    await waitFor(() => { expect(actions.createEnterpriseWorkspace).toHaveBeenCalledWith('杭州新建企业') })
    await waitFor(() => { expect(actions.pickAndCreateWorkspace).toHaveBeenCalledWith('/projects/杭州新建企业') })
  })

  it('桌面端可通过系统目录选择器导入已有企业目录', async () => {
    const actions = renderEnterprise(true)
    fireEvent.click(screen.getByRole('button', { name: '导入已有目录' }))
    await waitFor(() => { expect(actions.importEnterpriseWorkspace).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(actions.pickAndCreateWorkspace).toHaveBeenCalledWith('/archive/既有企业') })
  })

  it('可查看并打开准确的历史任务，不再只进入空白会话', async () => {
    const actions = renderEnterprise()
    fireEvent.click(screen.getByRole('button', { name: '查看任务' }))
    expect(screen.getByText('高企申报体检')).toBeTruthy()
    expect(screen.queryByText('新任务（未开始）')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    await waitFor(() => { expect(actions.openWorkspaceSession).toHaveBeenCalledWith(WORKSPACE_ID, SESSION_ID) })
  })

  it('可在企业空间内重命名历史任务', async () => {
    const actions = renderEnterprise()
    fireEvent.click(screen.getByRole('button', { name: '查看任务' }))
    fireEvent.click(screen.getByRole('button', { name: '重命名任务' }))
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '高企申报正式体检' } })
    fireEvent.click(screen.getByRole('button', { name: '保存任务名称' }))
    await waitFor(() => {
      expect(actions.renameWorkspaceSession).toHaveBeenCalledWith(WORKSPACE_ID, SESSION_ID, '高企申报正式体检')
    })
  })

  it('可重命名并在不删除本机目录的前提下归档空间', async () => {
    const actions = renderEnterprise()
    fireEvent.click(screen.getByRole('button', { name: '查看任务' }))
    fireEvent.click(screen.getByRole('button', { name: '重命名空间' }))
    fireEvent.change(screen.getByLabelText('企业空间名称'), { target: { value: '杭州示例企业股份有限公司' } })
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }))
    await waitFor(() => { expect(actions.renameWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, '杭州示例企业股份有限公司') })

    fireEvent.click(screen.getByRole('button', { name: '归档空间' }))
    expect(screen.getByRole('dialog', { name: '归档企业空间' }).textContent).toContain('不会删除本机企业目录和历史会话')
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
    await waitFor(() => { expect(actions.archiveWorkspace).toHaveBeenCalledWith(WORKSPACE_ID) })
  })

  it('删除对话和企业空间均明确使用系统废纸篓且不进入归档', async () => {
    const actions = renderEnterprise()
    fireEvent.click(screen.getByRole('button', { name: '查看任务' }))
    fireEvent.click(screen.getByRole('button', { name: '删除任务' }))
    expect(screen.getByRole('dialog', { name: '删除企业对话' }).textContent).toContain('不进入已归档列表，也不能从客户端恢复')
    expect(screen.getByRole('dialog', { name: '删除企业对话' }).textContent).toContain('移入系统废纸篓或回收站')
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => { expect(actions.deleteWorkspaceSession).toHaveBeenCalledWith(SESSION_ID) })

    fireEvent.click(screen.getByRole('button', { name: '删除企业空间' }))
    const deleteWorkspaceDialog = screen.getByRole('dialog', { name: '删除企业空间' })
    expect(deleteWorkspaceDialog.textContent).toContain('从客户端全部列表中删除')
    expect(deleteWorkspaceDialog.textContent).toContain('客户端不提供恢复入口')
    expect(deleteWorkspaceDialog.textContent).toContain('移入系统废纸篓或回收站')
    expect(deleteWorkspaceDialog.textContent).not.toContain('已删除区域')
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => { expect(actions.deleteWorkspace).toHaveBeenCalledWith(WORKSPACE_ID) })
  })
})
