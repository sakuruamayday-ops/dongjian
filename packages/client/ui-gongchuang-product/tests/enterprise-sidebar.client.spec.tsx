// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AccountState } from '../src/client/account.ts'
import type { ConnectivityState } from '../src/client/connectivity.ts'
import { providerConnections } from './provider-connections.client.ts'
import type { ConnectorState } from '../src/client/connectors.ts'
import { zh, type ProductKey } from '../src/client/locales.ts'
import {
  EnterpriseCreationMenuItem, ProductSidebar, WindowsClosePromptDialog, sidebarInsertBeforeAnchor,
  type ProductSidebarProps, type ProductUiState,
} from '../src/client/ProductShell.tsx'

it('Windows 关闭确认使用竖向选择并可记住决定', async () => {
  const respond = vi.fn(() => Promise.resolve())
  render(<WindowsClosePromptDialog requestId="close-request" respond={respond} />)

  const group = screen.getByRole('radiogroup', { name: '关闭窗口后' })
  const defaultChoice = within(group).getByRole<HTMLInputElement>('radio', { name: '最小化到托盘' })
  expect(defaultChoice.checked).toBe(true)
  fireEvent.click(within(group).getByRole('radio', { name: '退出主程序' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '记住此选择' }))
  fireEvent.click(screen.getByRole('button', { name: '确定' }))

  await waitFor(() => { expect(respond).toHaveBeenCalledWith('close-request', 'quit', true) })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'elementFromPoint')
})

function hook<TState>(state: TState) {
  return <TSelected,>(selector: (value: TState) => TSelected): TSelected => selector(state)
}

const WORKSPACE_ID = 'workspace-enterprise-sidebar' as WorkspaceId
const OTHER_WORKSPACE_ID = 'workspace-enterprise-other' as WorkspaceId
const SESSION_ID = 'session-enterprise-sidebar' as SessionId
const OTHER_SESSION_ID = 'session-enterprise-other' as SessionId
const BLANK_SESSION_ID = 'session-enterprise-blank' as SessionId
const SECOND_SESSION_ID = 'session-enterprise-second' as SessionId
const THIRD_SESSION_ID = 'session-enterprise-third' as SessionId

async function holdToDrag(element: HTMLElement) {
  fireEvent.pointerDown(element, { button: 0, isPrimary: true, pointerId: 1 })
  await waitFor(() => { expect(element.parentElement?.hasAttribute('data-dragging')).toBe(true) })
}

function movePointerDrag(source: HTMLElement, target: HTMLElement, clientY = 2) {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => target),
  })
  fireEvent.pointerMove(source, { button: 0, isPrimary: true, pointerId: 1, clientX: 20, clientY })
  fireEvent.pointerUp(source, { button: 0, isPrimary: true, pointerId: 1, clientX: 20, clientY })
}

function verticalRect(top = 0, height = 40): DOMRect {
  return {
    x: 0, y: top, top, left: 0, right: 200, bottom: top + height,
    width: 200, height, toJSON: () => ({}),
  }
}

const workspace = (workspaceId: WorkspaceId, title: string, path: string, sessionIds: SessionId[]) => ({
  workspaceId, title, path, sessionIds, pinnedSessionIds: [],
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
})

function renderSidebar(
  regionConfirmed = true,
  rootNeedsInitialSetup = !regionConfirmed,
  options: {
    accountPhase?: AccountState['snapshot']['phase']
    accountStatus?: AccountState['status']
    accountCompatibility?: AccountState['snapshot']['clientCompatibility']
    accountError?: string
    accountPortalUrl?: string
    avatarDataUrl?: string | null
    archivedWorkspace?: boolean
    deletedWorkspace?: boolean
    archivedSession?: boolean
    deletedSession?: boolean
    emptyWorkspaces?: boolean
    emptySessions?: boolean
    otherWorkspaceTitle?: string
    singleWorkspace?: boolean
    multipleSessions?: boolean
    pinnedSession?: SessionId
    runningSession?: SessionId
    windowsDesktop?: boolean
    checkForUpdates?: ProductSidebarProps['checkForUpdates']
    downloadUpdate?: ProductSidebarProps['downloadUpdate']
    onUpdateProgress?: ProductSidebarProps['onUpdateProgress']
    readSkillUpdateState?: ProductSidebarProps['readSkillUpdateState']
    checkSkillUpdates?: ProductSidebarProps['checkSkillUpdates']
    workspaceRootState?: ProductSidebarProps['workspaceRootState']
  } = {},
) {
  const accountPhase = options.accountPhase ?? 'disconnected'
  const workspaces = {
    items: options.emptyWorkspaces ? [] : [
      {
        ...workspace(
          WORKSPACE_ID,
          '杭州示例企业',
          '/projects/example',
          options.emptySessions
            ? []
            : options.multipleSessions
              ? [SESSION_ID, SECOND_SESSION_ID, THIRD_SESSION_ID, BLANK_SESSION_ID]
              : [BLANK_SESSION_ID, SESSION_ID],
        ),
        pinnedSessionIds: options.pinnedSession === undefined ? [] : [options.pinnedSession],
      },
      ...(options.singleWorkspace
        ? []
        : [workspace(OTHER_WORKSPACE_ID, options.otherWorkspaceTitle ?? '宁波另一企业', '/projects/other', options.emptySessions ? [] : [OTHER_SESSION_ID])]),
    ],
    archivedItems: options.archivedWorkspace
      ? [workspace('workspace-archived' as WorkspaceId, '已归档示例企业', '/projects/archived', [])]
      : [],
    deletedItems: options.deletedWorkspace
      ? [workspace('workspace-deleted' as WorkspaceId, '已删除示例企业', '/projects/deleted', [])]
      : [],
    archivedWorkspaceIds: options.archivedWorkspace ? ['workspace-archived' as WorkspaceId] : [],
    deletedWorkspaceIds: options.deletedWorkspace ? ['workspace-deleted' as WorkspaceId] : [],
    archivedSessionIds: options.archivedSession ? [OTHER_SESSION_ID] : [],
    deletedSessionIds: options.deletedSession ? [SESSION_ID] : [],
    state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: options.emptyWorkspaces ? undefined : WORKSPACE_ID,
  }
  const sessions: SessionListState = {
    ids: [BLANK_SESSION_ID, SESSION_ID, SECOND_SESSION_ID, THIRD_SESSION_ID, OTHER_SESSION_ID],
    byId: {
      [BLANK_SESSION_ID]: {
        id: BLANK_SESSION_ID, title: 'New Session', displayTitle: 'New Session', cwd: '/projects/example',
        running: false, blank: true, updatedAt: Date.parse('2026-08-16T08:00:00.000Z'),
      },
      [SESSION_ID]: {
        id: SESSION_ID, title: '高企申报体检', displayTitle: '高企申报体检', cwd: '/projects/example',
        running: options.runningSession === SESSION_ID, blank: false, updatedAt: Date.parse('2026-08-15T08:00:00.000Z'),
      },
      [SECOND_SESSION_ID]: {
        id: SECOND_SESSION_ID, title: '第二项申报', displayTitle: '第二项申报', cwd: '/projects/example',
        running: options.runningSession === SECOND_SESSION_ID, blank: false, updatedAt: Date.parse('2026-08-20T08:00:00.000Z'),
      },
      [THIRD_SESSION_ID]: {
        id: THIRD_SESSION_ID, title: '第三项复核', displayTitle: '第三项复核', cwd: '/projects/example',
        running: options.runningSession === THIRD_SESSION_ID, blank: false, updatedAt: Date.parse('2026-08-10T08:00:00.000Z'),
      },
      [OTHER_SESSION_ID]: {
        id: OTHER_SESSION_ID, title: '知识产权规划', displayTitle: '知识产权规划', cwd: '/projects/other',
        running: false, blank: false, updatedAt: Date.parse('2026-08-14T08:00:00.000Z'),
      },
    },
    current: options.emptySessions ? undefined : SESSION_ID,
    phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
  const product: ProductUiState = {
    page: 'assistant', provider: 'deepseek', accountDialogRevision: 0,
    avatarDataUrl: options.avatarDataUrl ?? null,
  }
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
  const account: AccountState = {
    status: options.accountStatus ?? 'ready', error: options.accountError ?? null,
    snapshot: {
      revision: 1, phase: accountPhase, portalUrl: options.accountPortalUrl ?? '',
      username: accountPhase === 'connected' || accountPhase === 'superseded' ? 'shichen' : null,
      message: accountPhase === 'connected' ? '已连接' : accountPhase === 'superseded' ? '已在其他设备登录' : '未登录',
      hasSavedPassword: false, autoLoginBlocked: false, singleDevice: true,
      clientCompatibility: accountPhase === 'connected' ? options.accountCompatibility ?? 'supported' : null,
      minimumSupportedVersion: accountPhase === 'connected' ? '0.1.4' : null,
    },
  }
  const connectors: ConnectorState = {
    status: 'ready', error: null,
    snapshot: { revision: 1, region: 'all', regionConfirmed, connectors: [] },
  }
  const actions = {
    useProduct: hook(product), useConnectivity: hook(connectivity), useWorkspaces: hook(workspaces),
    useSessions: hook(sessions), useSessionPendingInteraction: hook(new Map()),
    useAccount: hook(account), useConnectors: hook(connectors), navigate: vi.fn(), startSession: vi.fn(),
    requestEnterpriseCreation: vi.fn(), consumeEnterpriseCreationRequest: vi.fn(),
    openWorkspaceSession: vi.fn(() => Promise.resolve()), loginAccount: vi.fn(() => Promise.resolve()),
    renameWorkspaceSession: vi.fn(() => Promise.resolve()),
    copyWorkspaceSession: vi.fn(() => Promise.resolve()),
    moveWorkspaceSession: vi.fn(() => Promise.resolve()),
    reorderWorkspace: vi.fn(() => Promise.resolve()),
    reorderWorkspaceSession: vi.fn(() => Promise.resolve()),
    renameWorkspace: vi.fn(() => Promise.resolve()),
    archiveWorkspace: vi.fn(() => Promise.resolve()),
    deleteWorkspace: vi.fn(() => Promise.resolve()),
    setWorkspaceSessionPinned: vi.fn(() => Promise.resolve()),
    refreshAccount: vi.fn(() => Promise.resolve()), disconnectAccount: vi.fn(() => Promise.resolve()),
    archiveWorkspaceSession: vi.fn(() => Promise.resolve()),
    restoreWorkspace: vi.fn(() => Promise.resolve()),
    restoreWorkspaceSession: vi.fn(() => Promise.resolve()),
    deleteWorkspaceSession: vi.fn(() => Promise.resolve()),
    loadPersonalization: vi.fn(async () => ({ instructions: '', updatedAt: null, maxCharacters: 6_000 })),
    savePersonalization: vi.fn(async (instructions: string) => ({
      instructions, updatedAt: '2026-08-15T08:00:00.000Z', maxCharacters: 6_000,
    })),
    loadMemory: vi.fn(async () => ({
      enabled: true, includeToolResults: false, personalNodes: 3, enterpriseStores: 2,
      totalNodes: 8, totalEdges: 5, updatedAt: '2026-08-16T08:00:00.000Z',
    })),
    configureMemory: vi.fn(async (request: { enabled: boolean; includeToolResults: boolean }) => ({
      ...request, personalNodes: 3, enterpriseStores: 2, totalNodes: 8, totalEdges: 5,
      updatedAt: '2026-08-16T08:30:00.000Z',
    })),
    clearMemory: vi.fn(async () => ({
      enabled: true, includeToolResults: false, personalNodes: 0, enterpriseStores: 0,
      totalNodes: 0, totalEdges: 0, updatedAt: '2026-08-16T09:00:00.000Z',
    })),
    setAvatar: vi.fn(),
    setRegion: vi.fn(() => Promise.resolve()),
    checkForUpdates: options.checkForUpdates ?? vi.fn(async () => ({
      status: 'current' as const, currentVersion: '0.1.0', latestVersion: '0.1.0', message: '当前已是最新版本',
    })),
    downloadUpdate: options.downloadUpdate ?? vi.fn(async () => ({
      status: 'downloaded' as const, currentVersion: '0.1.0', latestVersion: '0.2.0', message: '已下载',
    })),
    ...(options.onUpdateProgress === undefined ? {} : { onUpdateProgress: options.onUpdateProgress }),
    installUpdate: vi.fn(async () => ({
      status: 'downloaded' as const, currentVersion: '0.1.0', latestVersion: '0.2.0', message: '正在安装',
    })),
    readSkillUpdateState: options.readSkillUpdateState,
    checkSkillUpdates: vi.fn(options.checkSkillUpdates ?? (async () => ({
      status: 'current' as const, currentVersion: '1.6.6', latestVersion: '1.6.6',
      message: '当前技能包已是最新版本', releaseNotes: '这段较长的技能包更新说明不应显示在设置页',
    }))),
    downloadSkillUpdate: vi.fn(async () => ({
      status: 'downloaded' as const, currentVersion: '1.6.6', latestVersion: '1.6.7',
      message: '已下载', releaseNotes: null,
    })),
    installSkillUpdate: vi.fn(async () => ({
      status: 'downloaded' as const, currentVersion: '1.6.6', latestVersion: '1.6.7',
      message: '正在启用', releaseNotes: null,
    })),
    workspaceRootState: vi.fn(options.workspaceRootState ?? (async () => ({
      rootPath: '/Users/example/Documents/洞见企业空间', isDefault: true, needsInitialSetup: rootNeedsInitialSetup,
    }))),
    chooseWorkspaceRoot: vi.fn(async () => ({
      rootPath: '/Users/example/企业资料', isDefault: false, needsInitialSetup: false,
    })),
    useDefaultWorkspaceRoot: vi.fn(async () => ({
      rootPath: '/Users/example/Documents/洞见企业空间', isDefault: true, needsInitialSetup: false,
    })),
    ...(options.windowsDesktop ? {
      readWindowsCloseBehavior: vi.fn(async () => 'tray' as const),
      writeWindowsCloseBehavior: vi.fn(async (value: 'ask' | 'tray' | 'quit') => value),
    } : {}),
  }
  const t = (key: ProductKey, params: Record<string, string | number> = {}) =>
    Object.entries(params).reduce<string>((text, [name, value]) => text.replace(`{${name}}`, String(value)), zh[key])
  render(<ProductSidebar {...({ collapsed: false, width: 300, ...actions, t } as unknown as ProductSidebarProps)} />)
  return actions
}

describe('企业空间左侧最近会话导航', () => {
  it('把首位、中间和末尾拖放位置转换成真实 insert-before 锚点', () => {
    const ids = ['first', 'middle', 'last'] as const
    expect(sidebarInsertBeforeAnchor(ids, 'last', 'first', 'before')).toBe('first')
    expect(sidebarInsertBeforeAnchor(ids, 'last', 'first', 'after')).toBe('middle')
    expect(sidebarInsertBeforeAnchor(ids, 'first', 'last', 'after')).toBeUndefined()
  })

  it('完整显示产品名称，并把空的最近项目状态标成无', () => {
    renderSidebar(true, false, { emptyWorkspaces: true })

    expect(screen.getByText('洞见')).toBeTruthy()
    const recent = screen.getByRole('region', { name: '最近对话' })
    expect(recent.textContent).toContain('最近对话无')
    expect(screen.getAllByText('无').length).toBeGreaterThanOrEqual(2)
    expect(recent.textContent).not.toContain('0')
  })

  it('企业空间没有最近对话时用无替代数字零', () => {
    renderSidebar(true, false, { emptySessions: true })
    const emptyEntries = screen.getAllByRole('button', { name: /无对话/u })
    expect(emptyEntries).toHaveLength(2)
    for (const entry of emptyEntries) expect(entry.textContent).toContain('无')
    expect(screen.getByRole('region', { name: '最近对话' }).textContent).not.toContain('0')
  })

  it('首次进入同时选择地区并确认默认企业空间根目录', async () => {
    const actions = renderSidebar(false)
    const dialog = screen.getByRole('dialog', { name: '设置所属地与企业空间' })
    expect(dialog).toBeTruthy()
    expect(screen.getByText(/浙江省级、国家级项目与通知始终共享/u)).toBeTruthy()
    expect(screen.getByRole('radio', { name: /全部/u }).getAttribute('aria-checked')).toBe('true')
    expect(await screen.findByText('/Users/example/Documents/洞见企业空间')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /^杭州/u }))
    fireEvent.click(screen.getByRole('button', { name: '保存并进入洞见' }))
    await waitFor(() => { expect(actions.useDefaultWorkspaceRoot).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(actions.setRegion).toHaveBeenCalledWith('hangzhou') })
  })

  it('首次城市弹窗自动接管焦点并把 Tab 循环限制在弹窗内', async () => {
    renderSidebar(false)
    const dialog = screen.getByRole('dialog', { name: '设置所属地与企业空间' })
    const first = screen.getByRole('radio', { name: /全部/u })
    const last = screen.getByRole('button', { name: '保存并进入洞见' })
    await waitFor(() => { expect(document.activeElement).toBe(first) })

    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: '新对话' }))
  })

  it('首次引导可改用自定义根目录，再与地区选择一起完成', async () => {
    const actions = renderSidebar(false)
    expect(await screen.findByText('/Users/example/Documents/洞见企业空间')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '更改' }))
    await waitFor(() => { expect(actions.chooseWorkspaceRoot).toHaveBeenCalledOnce() })
    expect(await screen.findByText('/Users/example/企业资料')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /^宁波/u }))
    fireEvent.click(screen.getByRole('button', { name: '保存并进入洞见' }))
    await waitFor(() => { expect(actions.setRegion).toHaveBeenCalledWith('ningbo') })
    expect(actions.useDefaultWorkspaceRoot).not.toHaveBeenCalled()
  })

  it('地区与根目录均已配置后不再显示首次引导', async () => {
    renderSidebar(true, false)
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '设置所属地与企业空间' })).toBeNull() })
    expect(screen.queryByRole('dialog', { name: '选择所属地' })).toBeNull()
  })

  it.each([false, true])('目录读取完成后按真实首次配置状态展示引导：%s', async (needsInitialSetup) => {
    const root = Promise.withResolvers<Awaited<ReturnType<NonNullable<ProductSidebarProps['workspaceRootState']>>>>()
    const actions = renderSidebar(true, false, { workspaceRootState: () => root.promise })
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: '设置所属地与企业空间' })).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存并进入洞见' }).disabled).toBe(true)

    await act(async () => {
      root.resolve({ rootPath: '/Users/example/企业资料', isDefault: false, needsInitialSetup })
      await root.promise
    })
    if (needsInitialSetup) {
      expect(screen.getByRole('dialog', { name: '设置所属地与企业空间' })).toBeTruthy()
    } else {
      expect(screen.queryByRole('dialog', { name: '设置所属地与企业空间' })).toBeNull()
    }
    expect(actions.setRegion).not.toHaveBeenCalled()
    expect(actions.useDefaultWorkspaceRoot).not.toHaveBeenCalled()
  })

  it.each([
    ['Windows', 'Win32'],
    ['macOS', 'MacIntel'],
  ])('%s 上根目录已配置但地区未确认时仍显示地区选择', async (_label, platform) => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(platform)
    renderSidebar(false, false)
    expect(await screen.findByRole('dialog', { name: '设置所属地与企业空间' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /^杭州/u })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /^绍兴/u })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /^金华/u })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /^宁波/u })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /全部/u })).toBeTruthy()
  })

  it('只保留新对话入口并隐藏独立联网检索与常驻门禁状态', () => {
    const actions = renderSidebar()
    expect(screen.queryByText('新建探路任务')).toBeNull()
    expect(screen.queryByText('探路助手')).toBeNull()
    expect(screen.queryByText('联网检索')).toBeNull()
    expect(screen.queryByText('共创门禁已启用')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '新对话' }))
    expect(actions.navigate).toHaveBeenCalledWith('assistant')
    expect(actions.startSession).toHaveBeenCalledOnce()
  })

  it('尚未创建企业空间时，新对话仍原地创建未绑定企业空间的会话', () => {
    const actions = renderSidebar(true, false, { emptyWorkspaces: true })
    fireEvent.click(screen.getByRole('button', { name: '新对话' }))
    expect(actions.navigate).toHaveBeenCalledWith('assistant')
    expect(actions.startSession).toHaveBeenCalledOnce()
    expect(actions.requestEnterpriseCreation).not.toHaveBeenCalled()
  })

  it('保留企业空间总览入口，并可在左侧展开最近会话直接打开', async () => {
    const actions = renderSidebar()
    expect(screen.getByRole('button', { name: '打开企业空间总览' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '筛选企业空间和会话' })).toBeTruthy()
    expect((await screen.findByRole('button', { name: /^高企申报体检/u })).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByText('新任务（未开始）')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^高企申报体检/u }))
    await waitFor(() => { expect(actions.openWorkspaceSession).toHaveBeenCalledWith(WORKSPACE_ID, SESSION_ID) })
    fireEvent.click(screen.getByRole('button', { name: '打开企业空间总览' }))
    expect(actions.navigate).toHaveBeenCalledWith('enterprise')
  })

  it('同时按企业名称和会话标题筛选，不产生第二套会话数据', async () => {
    renderSidebar()
    const filter = screen.getByRole('textbox', { name: '筛选企业空间和会话' })
    fireEvent.change(filter, { target: { value: '宁波' } })
    expect(screen.getByRole('button', { name: '知识产权规划' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^高企申报体检/u })).toBeNull()
    fireEvent.change(filter, { target: { value: '申报' } })
    expect(screen.getByRole('button', { name: /^高企申报体检/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '知识产权规划' })).toBeNull()
  })

  it('固定对话在前，其余严格保留 Host sessionIds 顺序而不按更新时间重排', async () => {
    renderSidebar(true, false, { multipleSessions: true, pinnedSession: THIRD_SESSION_ID })
    const pinned = await screen.findByRole('button', { name: '第三项复核' })
    const first = screen.getByRole('button', { name: '高企申报体检' })
    const newer = screen.getByRole('button', { name: '第二项申报' })
    expect(pinned.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(first.compareDocumentPosition(newer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('企业空间拖动按落点调用 Host 排序，不在客户端预改列表', async () => {
    const actions = renderSidebar()
    const source = screen.getByRole('button', { name: /^(?:收起|展开) 杭州示例企业/u })
    const target = screen.getByRole('button', { name: /^(?:收起|展开) 宁波另一企业/u })
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(verticalRect())
    await holdToDrag(source)
    expect(source.parentElement?.hasAttribute('data-dragging')).toBe(true)
    movePointerDrag(source, target, 38)
    await waitFor(() => {
      expect(actions.reorderWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, undefined)
    })
    const workspaceButtons = screen.getAllByRole('button', { name: /企业，/u })
    expect(workspaceButtons[0]?.textContent).toContain('杭州示例企业')
  })

  it('同企业空间会话拖动使用真实会话锚点，跨企业空间只调用移动动作', async () => {
    const actions = renderSidebar(true, false, { multipleSessions: true })
    const source = await screen.findByRole('button', { name: '第三项复核' })
    const target = screen.getByRole('button', { name: '第二项申报' })
    vi.spyOn(target.parentElement!, 'getBoundingClientRect').mockReturnValue(verticalRect())
    await holdToDrag(source)
    expect(document.querySelector('[data-sidebar-drag-preview]')?.textContent).toContain('第三项复核')
    movePointerDrag(source, target, 2)
    await waitFor(() => {
      expect(actions.reorderWorkspaceSession).toHaveBeenCalledWith(
        WORKSPACE_ID,
        THIRD_SESSION_ID,
        SECOND_SESSION_ID,
      )
    })

    const crossSource = screen.getByRole('button', { name: '高企申报体检' })
    const otherWorkspace = screen.getByRole('button', { name: /^(?:收起|展开) 宁波另一企业/u })
    await holdToDrag(crossSource)
    movePointerDrag(crossSource, otherWorkspace, 20)
    await waitFor(() => {
      expect(actions.moveWorkspaceSession).toHaveBeenCalledWith(SESSION_ID, OTHER_WORKSPACE_ID)
    })
  })

  it('运行中与搜索状态禁止拖动，并保留可访问的拖动状态', async () => {
    renderSidebar(true, false, { runningSession: SESSION_ID })
    const running = await screen.findByRole('button', { name: '高企申报体检' })
    expect(running.getAttribute('draggable')).toBe('false')
    const filter = screen.getByRole('textbox', { name: '筛选企业空间和会话' })
    fireEvent.change(filter, { target: { value: '申报' } })
    expect(screen.getByRole('button', { name: /杭州示例企业 搜索结果/u }).getAttribute('draggable')).toBe('false')
    expect(screen.getByRole('button', { name: '高企申报体检' }).getAttribute('draggable')).toBe('false')
  })

  it('短按不进入拖动，只有主鼠标键长按后才启用直接拖动', async () => {
    renderSidebar()
    const source = screen.getByRole('button', { name: /^(?:收起|展开) 杭州示例企业/u })
    expect(source.getAttribute('draggable')).toBe('false')

    fireEvent.pointerDown(source, { button: 0, isPrimary: true, pointerId: 1 })
    fireEvent.pointerUp(source, { button: 0, isPrimary: true, pointerId: 1 })
    expect(source.parentElement?.hasAttribute('data-dragging')).toBe(false)

    fireEvent.pointerDown(source, { button: 2, isPrimary: true, pointerId: 2 })
    await new Promise(resolve => setTimeout(resolve, 220))
    expect(source.getAttribute('draggable')).toBe('false')

    await holdToDrag(source)
    expect(source.parentElement?.hasAttribute('data-drag-ready')).toBe(true)
    expect(source.parentElement?.hasAttribute('data-dragging')).toBe(true)
    expect(source.getAttribute('draggable')).toBe('false')
    const preview = document.querySelector<HTMLElement>('[data-sidebar-drag-preview]')
    expect(preview?.textContent).toContain('杭州示例企业')
    expect(preview?.getAttribute('aria-hidden')).toBe('true')
    fireEvent.pointerUp(source, { button: 0, isPrimary: true, pointerId: 1 })
    await waitFor(() => { expect(source.parentElement?.hasAttribute('data-dragging')).toBe(false) })
    expect(document.querySelector('[data-sidebar-drag-preview]')).toBeNull()
  })

  it('拖动失败只显示受控错误，并保持服务端投影顺序', async () => {
    const actions = renderSidebar()
    actions.reorderWorkspace.mockRejectedValueOnce(new Error('/Users/alice/token=secret reorder failed'))
    const source = screen.getByRole('button', { name: /^(?:收起|展开) 宁波另一企业/u })
    const target = screen.getByRole('button', { name: /^(?:收起|展开) 杭州示例企业/u })
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(verticalRect())
    await holdToDrag(source)
    movePointerDrag(source, target, 2)
    expect((await screen.findByRole('alert')).textContent).toContain('GC-UI-NAVIGATION')
    expect(document.body.textContent).not.toContain('/Users/alice')
    expect(document.body.textContent).not.toContain('secret')
    const workspaceButtons = screen.getAllByRole('button', { name: /企业，/u })
    expect(workspaceButtons[0]?.textContent).toContain('杭州示例企业')
  })

  it('悬停按钮和右键菜单都执行真实固定与取消固定动作', async () => {
    const actions = renderSidebar()
    const pin = await screen.findByRole('button', { name: '固定对话：高企申报体检' })
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    expect(pin.querySelector('svg')).not.toBeNull()
    fireEvent.focus(pin)
    expect(screen.getByRole('tooltip').textContent).toBe('固定')
    fireEvent.click(pin)
    await waitFor(() => {
      expect(actions.setWorkspaceSessionPinned).toHaveBeenCalledWith(WORKSPACE_ID, SESSION_ID, true)
    })

    cleanup()
    const pinnedActions = renderSidebar(true, false, { pinnedSession: SESSION_ID })
    const pinnedSession = await screen.findByRole('button', { name: '高企申报体检' })
    fireEvent.contextMenu(pinnedSession, { clientX: 80, clientY: 120 })
    const unpin = screen.getByRole('menuitem', { name: '取消固定' })
    expect(unpin.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(unpin)
    await waitFor(() => {
      expect(pinnedActions.setWorkspaceSessionPinned).toHaveBeenCalledWith(WORKSPACE_ID, SESSION_ID, false)
    })
  })

  it('最近对话右键菜单可归档，并在确认后直接删除', async () => {
    const actions = renderSidebar()
    const sessionButton = screen.getByRole('button', { name: /^高企申报体检/u })
    fireEvent.contextMenu(sessionButton, { clientX: 80, clientY: 120 })
    expect(screen.getByRole('menu', { name: '对话操作' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '归档对话' }))
    await waitFor(() => { expect(actions.archiveWorkspaceSession).toHaveBeenCalledWith(WORKSPACE_ID, SESSION_ID) })

    fireEvent.contextMenu(sessionButton, { clientX: 80, clientY: 120 })
    fireEvent.click(screen.getByRole('menuitem', { name: '删除对话' }))
    expect(screen.getByRole('dialog', { name: '删除对话' }).textContent).toContain('不进入已归档列表，也不能从客户端恢复')
    expect(actions.deleteWorkspaceSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => { expect(actions.deleteWorkspaceSession).toHaveBeenCalledWith(SESSION_ID) })
  })

  it('企业空间右键菜单可编辑名称、归档并删除到系统废纸篓', async () => {
    const actions = renderSidebar()
    const workspaceButton = screen.getByRole('button', { name: /^(?:收起|展开) 杭州示例企业/u })

    fireEvent.contextMenu(workspaceButton, { clientX: 70, clientY: 100 })
    expect(screen.getByRole('menu', { name: '企业空间操作' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑企业名称' }))
    const name = screen.getByRole('textbox', { name: '企业名称' })
    fireEvent.change(name, { target: { value: '杭州新企业名称' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(actions.renameWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, '杭州新企业名称')
    })

    fireEvent.contextMenu(workspaceButton, { clientX: 70, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: '归档企业空间' }))
    await waitFor(() => { expect(actions.archiveWorkspace).toHaveBeenCalledWith(WORKSPACE_ID) })

    fireEvent.contextMenu(workspaceButton, { clientX: 70, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: '删除企业空间' }))
    const removeDialog = screen.getByRole('dialog', { name: '删除企业空间' })
    expect(removeDialog.textContent).toContain('从客户端全部列表中删除')
    expect(removeDialog.textContent).toContain('客户端不提供恢复入口')
    expect(removeDialog.textContent).toContain('移入系统废纸篓或回收站')
    expect(removeDialog.textContent).not.toContain('已归档')
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => { expect(actions.deleteWorkspace).toHaveBeenCalledWith(WORKSPACE_ID) })
  })

  it('悬停动作区使用现有图标按钮，并支持键盘提示和直接归档', async () => {
    const actions = renderSidebar()
    const more = screen.getByRole('button', { name: '更多操作：高企申报体检' })
    const archive = screen.getByRole('button', { name: '归档对话：高企申报体检' })
    expect(more.querySelector('svg')).not.toBeNull()
    expect(archive.querySelector('svg')).not.toBeNull()
    fireEvent.focus(more)
    expect(screen.getByRole('tooltip').textContent).toBe('更多')
    fireEvent.blur(more)
    fireEvent.focus(archive)
    expect(screen.getByRole('tooltip').textContent).toBe('归档')
    fireEvent.click(archive)
    await waitFor(() => {
      expect(actions.archiveWorkspaceSession).toHaveBeenCalledWith(WORKSPACE_ID, SESSION_ID)
    })
  })

  it('企业创建菜单项复用企业空间页的一次性真实创建请求', () => {
    const onClose = vi.fn()
    const requestEnterpriseCreation = vi.fn()
    render(<EnterpriseCreationMenuItem
      onClose={onClose}
      requestEnterpriseCreation={requestEnterpriseCreation}
    />)
    fireEvent.click(screen.getByRole('menuitem', { name: '新建企业' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(requestEnterpriseCreation).toHaveBeenCalledOnce()
  })

  it('最近对话按 Codex 风格提供可见菜单，并可重命名和复制', async () => {
    const actions = renderSidebar()
    const sessionButton = screen.getByRole('button', { name: /^高企申报体检/u })
    const moreButton = screen.getByRole('button', { name: '更多操作：高企申报体检' })
    expect(moreButton.getAttribute('aria-haspopup')).toBe('menu')

    fireEvent.click(moreButton)
    fireEvent.click(screen.getByRole('menuitem', { name: '复制对话' }))
    await waitFor(() => { expect(actions.copyWorkspaceSession).toHaveBeenCalledWith(WORKSPACE_ID, SESSION_ID) })

    fireEvent.contextMenu(sessionButton, { clientX: 80, clientY: 120 })
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const rename = screen.getByRole('textbox', { name: '对话名称' })
    fireEvent.change(rename, { target: { value: '高企申报复核' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(actions.renameWorkspaceSession).toHaveBeenCalledWith(WORKSPACE_ID, SESSION_ID, '高企申报复核')
    })

    expect(screen.queryByRole('menuitem', { name: '移动到项目' })).toBeNull()
  })

  it('最近对话菜单可复制工作目录和深链接，并按企业空间子菜单直接移动', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const actions = renderSidebar(true, false, { otherWorkspaceTitle: '工作' })
    const sessionButton = screen.getByRole('button', { name: /^高企申报体检/u })

    fireEvent.contextMenu(sessionButton, { clientX: 80, clientY: 120 })
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '复制' }))
    expect(screen.getByRole('menu', { name: '复制' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '复制工作目录' }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith('/projects/example') })

    fireEvent.contextMenu(sessionButton, { clientX: 80, clientY: 120 })
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '复制' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '复制深链接' }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(`dongjian://threads/${SESSION_ID}`) })

    fireEvent.contextMenu(sessionButton, { clientX: 80, clientY: 120 })
    const moveTrigger = screen.getByRole('menuitem', { name: '移动到企业空间' })
    fireEvent.mouseEnter(moveTrigger)
    expect(screen.getByRole('menu', { name: '移动到企业空间' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '工作' }))
    await waitFor(() => { expect(actions.moveWorkspaceSession).toHaveBeenCalledWith(SESSION_ID, OTHER_WORKSPACE_ID) })
    expect(screen.queryByRole('menuitem', { name: '移动到项目' })).toBeNull()
  })

  it('复制与移动子菜单均在鼠标移入时直接展开', () => {
    renderSidebar(true, false, { otherWorkspaceTitle: '工作' })
    const sessionButton = screen.getByRole('button', { name: /^高企申报体检/u })
    fireEvent.contextMenu(sessionButton, { clientX: 80, clientY: 120 })

    const copyTrigger = screen.getByRole('menuitem', { name: '复制' })
    fireEvent.mouseEnter(copyTrigger)
    expect(screen.getByRole('menu', { name: '复制' })).toBeTruthy()

    const moveTrigger = screen.getByRole('menuitem', { name: '移动到企业空间' })
    fireEvent.mouseEnter(moveTrigger)
    expect(screen.queryByRole('menu', { name: '复制' })).toBeNull()
    expect(screen.getByRole('menu', { name: '移动到企业空间' })).toBeTruthy()
  })

  it('移动到企业空间子菜单支持方向键进入和返回', async () => {
    renderSidebar(true, false, { otherWorkspaceTitle: '工作' })
    const sessionButton = screen.getByRole('button', { name: /^高企申报体检/u })
    fireEvent.contextMenu(sessionButton, { clientX: 80, clientY: 120 })
    const moveTrigger = screen.getByRole('menuitem', { name: '移动到企业空间' })
    moveTrigger.focus()
    fireEvent.keyDown(moveTrigger, { key: 'ArrowRight' })
    const target = await screen.findByRole('menuitem', { name: '工作' })
    await waitFor(() => { expect(document.activeElement).toBe(target) })
    fireEvent.keyDown(target, { key: 'ArrowLeft' })
    expect(screen.queryByRole('menu', { name: '移动到企业空间' })).toBeNull()
    expect(document.activeElement).toBe(moveTrigger)
  })

  it('没有可移动目标时，企业空间子菜单以可访问的非按钮空态显示无', () => {
    const actions = renderSidebar(true, false, { singleWorkspace: true })
    const sessionButton = screen.getByRole('button', { name: /^高企申报体检/u })
    fireEvent.contextMenu(sessionButton, { clientX: 80, clientY: 120 })
    const moveTrigger = screen.getByRole('menuitem', { name: '移动到企业空间' })
    expect(moveTrigger.hasAttribute('disabled')).toBe(false)
    moveTrigger.focus()
    fireEvent.keyDown(moveTrigger, { key: 'ArrowRight' })
    const submenu = screen.getByRole('menu', { name: '移动到企业空间' })
    expect(within(submenu).getByRole('status', { name: '无可移动的企业空间' }).textContent).toBe('无')
    expect(within(submenu).queryByRole('menuitem')).toBeNull()
    expect(actions.moveWorkspaceSession).not.toHaveBeenCalled()
  })

  it('最近对话菜单支持方向键导航，并在 Escape 后把焦点还给触发按钮', async () => {
    renderSidebar()
    const moreButton = screen.getByRole('button', { name: '更多操作：高企申报体检' })
    fireEvent.click(moreButton)
    const open = screen.getByRole('menuitem', { name: '打开对话' })
    const copy = screen.getByRole('menuitem', { name: '复制对话' })
    await waitFor(() => { expect(document.activeElement).toBe(open) })
    fireEvent.keyDown(open, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(copy)
    fireEvent.keyDown(copy, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '删除对话' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(document.activeElement).toBe(moreButton) })
  })

  it('在账号下提供可见的个人资料与真实更新入口', async () => {
    const actions = renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: '个人资料' }))
    expect(screen.getByRole('dialog', { name: '本机资料' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '个性化' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '模型与连接' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '更新与版本' }))
    expect(screen.queryByRole('button', { name: '当前已是最新版' })).toBeNull()
    expect(screen.getByRole('button', { name: '检查更新' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: '检查技能包更新' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
    await waitFor(() => { expect(actions.checkForUpdates).toHaveBeenCalledTimes(2) })
    expect(screen.getByRole('button', { name: '当前已是最新版' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText('这段较长的技能包更新说明不应显示在设置页')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '检查技能包更新' }))
    await waitFor(() => { expect(actions.checkSkillUpdates).toHaveBeenCalledTimes(2) })
    const currentButtons = screen.getAllByRole('button', { name: '当前已是最新版' })
    expect(currentButtons).toHaveLength(2)
    expect(currentButtons.every(button => button.hasAttribute('disabled'))).toBe(true)
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '当前已是最新版' })).toBeNull()
    }, { timeout: 6_000 })
    expect(screen.getByRole('button', { name: '检查更新' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: '检查技能包更新' }).hasAttribute('disabled')).toBe(false)
  }, 7_000)

  it('uses the local active skill version while checking and after an automatic IPC failure', async () => {
    const intervals = vi.spyOn(window, 'setInterval')
    const active = {
      status: 'current' as const, currentVersion: '1.6.16', latestVersion: null,
      message: '当前技能包 V1.6.16', releaseNotes: null,
    }
    const actions = renderSidebar(true, false, {
      readSkillUpdateState: async () => active,
      checkSkillUpdates: () => new Promise(() => {}),
    })
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '更新与版本' }))
    await waitFor(() => { expect(screen.getByText('技能包版本').parentElement?.textContent).toBe('技能包版本V1.6.16') })
    expect(screen.queryByText('V1.6.15')).toBeNull()
    actions.checkSkillUpdates.mockRejectedValueOnce(new Error('IPC check interrupted'))
    const periodicCheck = intervals.mock.calls.find(([, timeout]) => timeout === 6 * 60 * 60 * 1_000)?.[0]
    expect(periodicCheck).toBeDefined()
    await act(async () => { if (typeof periodicCheck === 'function') periodicCheck() })
    expect(screen.getByText('技能包版本').parentElement?.textContent).toBe('技能包版本V1.6.16')
    expect(screen.getByText('自动检查技能包更新失败，可稍后手动重试')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '当前已是最新版' })).toBeNull()
  })

  it('does not substitute a bundled skill version when both local and remote reads fail', async () => {
    renderSidebar(true, false, {
      readSkillUpdateState: async () => { throw new Error('IPC unavailable') },
      checkSkillUpdates: async () => { throw new Error('IPC unavailable') },
    })
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '更新与版本' }))
    await waitFor(() => { expect(screen.getByText('自动检查技能包更新失败，可稍后手动重试')).toBeTruthy() })
    expect(screen.getByText('技能包版本').parentElement?.textContent).toBe('技能包版本未知')
  })

  it('显示可继续更新的断点、实时百分比和预计剩余时间', async () => {
    let progressListener: Parameters<NonNullable<ProductSidebarProps['onUpdateProgress']>>[0] | undefined
    let finishDownload: (() => void) | undefined
    const checkForUpdates = vi.fn(async () => ({
      status: 'available' as const,
      currentVersion: '0.3.3',
      latestVersion: '0.3.4',
      message: '客户端 V0.3.4 已保留 25% 下载进度',
      resumableBytes: 64 * 1024,
    }))
    const downloadUpdate = vi.fn(() => new Promise<Awaited<ReturnType<ProductSidebarProps['downloadUpdate']>>>((resolvePromise) => {
      finishDownload = () => {
        resolvePromise({
          status: 'downloaded', currentVersion: '0.3.3', latestVersion: '0.3.4', message: '正在安装',
        })
      }
    }))
    renderSidebar(true, false, {
      checkForUpdates,
      downloadUpdate,
      onUpdateProgress: (listener) => {
        progressListener = listener
        return () => { progressListener = undefined }
      },
    })
    await waitFor(() => { expect(checkForUpdates).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '更新与版本' }))
    fireEvent.click(await screen.findByRole('button', { name: '继续更新' }))
    await act(async () => {
      progressListener?.({
        phase: 'downloading', latestVersion: '0.3.4', receivedBytes: 128 * 1024,
        totalBytes: 256 * 1024, percent: 50, remainingSeconds: 120, resumedFromBytes: 64 * 1024,
      })
    })
    const progressStatus = within(screen.getByRole('dialog', { name: '设置' })).getByRole('status')
    expect(progressStatus.textContent).toBe('已下载 50%，预计还需 2 分钟，已从上次进度继续')
    expect(progressStatus.getAttribute('aria-live')).toBe('polite')
    expect(progressStatus.getAttribute('aria-atomic')).toBe('true')
    expect(screen.getByRole('button', { name: '下载 50%' })).toBeTruthy()
    await act(async () => {
      progressListener?.({
        phase: 'verifying', latestVersion: '0.3.4', receivedBytes: 256 * 1024,
        totalBytes: 256 * 1024, percent: 100, remainingSeconds: 0, resumedFromBytes: 64 * 1024,
      })
    })
    expect(progressStatus.textContent).toBe('下载完成，正在验证更新')
    expect(screen.getByRole('button', { name: '正在验证更新' })).toBeTruthy()
    await act(async () => { finishDownload?.() })
  })

  it('可在设置中切换企业空间根目录，且不承诺移动既有资料', async () => {
    const actions = renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(await screen.findByText('/Users/example/Documents/洞见企业空间')).toBeTruthy()
    expect(screen.getByText(/已连接空间及其原文件不会移动/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '更改目录' }))
    await waitFor(() => { expect(actions.chooseWorkspaceRoot).toHaveBeenCalledOnce() })
    expect(await screen.findByText('/Users/example/企业资料')).toBeTruthy()
  })

  it('常规页只展示企业空间设置，不再展示专业默认和运行时开关', async () => {
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.queryByRole('button', { name: '专业默认' })).toBeNull()
    expect(screen.queryByText('首次安装默认模型')).toBeNull()
    expect(screen.queryByRole('switch', { name: '运行时保持客户端活跃' })).toBeNull()
    expect(screen.queryByText('关闭窗口时最小化到菜单栏')).toBeNull()
  })

  it.each(['local', 'disconnected', 'offline', 'superseded'] as const)('本机资料不受旧账号状态影响：%s', (accountPhase) => {
    const actions = renderSidebar(true, false, { accountPhase, avatarDataUrl: 'data:image/webp;base64,YXZhdGFy' })
    expect(screen.queryByRole('button', { name: '共创账号' })).toBeNull()
    expect(screen.queryByText('登录共创账号')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '个人资料' }))
    expect(screen.getByRole('dialog', { name: '本机资料' })).toBeTruthy()
    expect(screen.getByRole('img', { name: '当前头像' })).toBeTruthy()
    expect(screen.getByText('头像和偏好保存在本机。')).toBeTruthy()
    expect(screen.queryByLabelText('密码')).toBeNull()
    expect(screen.queryByRole('link', { name: '忘记密码？' })).toBeNull()
    expect(actions.loginAccount).not.toHaveBeenCalled()
    expect(actions.refreshAccount).not.toHaveBeenCalled()
    expect(actions.disconnectAccount).not.toHaveBeenCalled()
  })

  it('侧栏本机资料卡不展示服务器账号或升级限制', () => {
    renderSidebar(true, false, { accountPhase: 'connected', accountCompatibility: 'upgrade-advised' })
    const card = screen.getByRole('button', { name: '本机资料' })
    expect(within(card).getByText('本机用户')).toBeTruthy()
    expect(within(card).queryByText('shichen')).toBeNull()
    expect(within(card).queryByText('服务器建议升级')).toBeNull()
    fireEvent.click(card)
    expect(screen.getByRole('dialog', { name: '本机资料' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '退出本机账号' })).toBeNull()
  })

  it('Windows 常规设置可在托盘驻留和直接退出之间选择', async () => {
    const actions = renderSidebar(true, false, { windowsDesktop: true })
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    const select = await screen.findByRole('combobox', { name: '关闭主窗口时' })
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe('tray')
    })

    fireEvent.change(select, { target: { value: 'quit' } })

    await waitFor(() => {
      expect(actions.writeWindowsCloseBehavior).toHaveBeenCalledWith('quit')
      expect((select as HTMLSelectElement).value).toBe('quit')
    })
  })

  it('在已归档设置中只展示可恢复的归档项，不展示任何已删除项', async () => {
    const actions = renderSidebar(true, false, {
      archivedWorkspace: true,
      deletedWorkspace: true,
      archivedSession: true,
      deletedSession: true,
    })
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '已归档' }))
    expect(screen.getByText('已归档示例企业')).toBeTruthy()
    const restoreButtons = screen.getAllByRole('button', { name: '恢复' })
    fireEvent.click(restoreButtons[0]!)
    await waitFor(() => { expect(actions.restoreWorkspace).toHaveBeenCalledWith('workspace-archived') })
    fireEvent.click(restoreButtons[1]!)
    await waitFor(() => { expect(actions.restoreWorkspaceSession).toHaveBeenCalledWith(OTHER_SESSION_ID) })
    expect(restoreButtons).toHaveLength(2)
    expect(screen.queryByText('已删除企业空间')).toBeNull()
    expect(screen.queryByText('已删除示例企业')).toBeNull()
    expect(screen.queryByText('已从列表移除')).toBeNull()
  })

  it('已归档企业空间和对话点击删除后直接执行既有删除动作', async () => {
    const actions = renderSidebar(true, false, { archivedWorkspace: true, archivedSession: true })
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '已归档' }))
    fireEvent.click(screen.getByRole('button', { name: '删除已归档企业空间：已归档示例企业' }))
    expect(screen.queryByRole('dialog', { name: '删除企业空间' })).toBeNull()
    await waitFor(() => { expect(actions.deleteWorkspace).toHaveBeenCalledWith('workspace-archived') })
    const deleteSession = screen.getByRole<HTMLButtonElement>('button', { name: '删除已归档对话：知识产权规划' })
    await waitFor(() => { expect(deleteSession.disabled).toBe(false) })
    fireEvent.click(deleteSession)
    expect(screen.queryByRole('dialog', { name: '删除对话' })).toBeNull()
    await waitFor(() => { expect(actions.deleteWorkspaceSession).toHaveBeenCalledWith(OTHER_SESSION_ID) })
  })

  it('从最近对话中过滤后端返回的已删除标记', () => {
    renderSidebar(true, false, { deletedSession: true })
    expect(screen.queryByRole('button', { name: /^高企申报体检/u })).toBeNull()
  })

  it('可在设置中关闭本地记忆并清空图数据，不影响原会话', async () => {
    const actions = renderSidebar()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    await waitFor(() => { expect(actions.loadMemory).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: '记忆' }))
    expect(await screen.findByText('3 项')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /启用本地长期记忆/u }))
    await waitFor(() => {
      expect(actions.configureMemory).toHaveBeenCalledWith({ enabled: false, includeToolResults: false })
    })
    fireEvent.click(screen.getByRole('button', { name: '清除全部本地记忆' }))
    await waitFor(() => { expect(actions.clearMemory).toHaveBeenCalledOnce() })
    expect(await screen.findByText('本机长期记忆已清除')).toBeTruthy()
  })

  it('把个性化指令写入同一 Host 文件并说明从下一次回复生效', async () => {
    const actions = renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    await waitFor(() => { expect(actions.loadPersonalization).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: '个性化' }))
    const editor = screen.getByRole('textbox', { name: '自定义指令' })
    fireEvent.change(editor, { target: { value: '报告先给结论，再给依据。' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(actions.savePersonalization).toHaveBeenCalledWith('报告先给结论，再给依据。') })
    expect(await screen.findByText('已保存，将从下一次回复开始生效')).toBeTruthy()
  })
})
