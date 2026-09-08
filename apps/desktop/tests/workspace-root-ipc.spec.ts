import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerWorkspaceRootIpc } from '../src/workspace-root-ipc.ts'
import {
  ENTERPRISE_WORKSPACE_CREATE_CHANNEL,
  ENTERPRISE_WORKSPACE_IMPORT_CHANNEL,
  WORKSPACE_ROOT_CHOOSE_CHANNEL,
  WORKSPACE_ROOT_STATE_CHANNEL,
  WORKSPACE_ROOT_USE_DEFAULT_CHANNEL,
  type DesktopWorkspaceRootStore,
} from '../src/workspace-root.ts'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function fixture() {
  const handlers = new Map<string, Handler>()
  const webContents = Object.freeze({ id: 7 })
  const window = { webContents } as unknown as BrowserWindow
  const store = {
    state: vi.fn(async () => ({ rootPath: '/Documents/洞见企业空间', isDefault: true, needsInitialSetup: true })),
    selectRoot: vi.fn(async (path: string) => ({ rootPath: path, isDefault: false, needsInitialSetup: false })),
    useDefaultRoot: vi.fn(async () => ({ rootPath: '/Documents/洞见企业空间', isDefault: true, needsInitialSetup: false })),
    createEnterprise: vi.fn(async (name: unknown) => ({ name, path: `/Documents/洞见企业空间/${String(name)}`, created: true, imported: false })),
    importEnterprise: vi.fn(async (path: string) => ({ name: '既有企业', path, created: false, imported: true })),
  } as unknown as DesktopWorkspaceRootStore
  const showOpenDialog = vi.fn()
  registerWorkspaceRootIpc({
    ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) } },
    window,
    store,
    showOpenDialog,
  })
  const event = { sender: webContents } as unknown as IpcMainInvokeEvent
  return { event, handlers, showOpenDialog, store, window }
}

describe('desktop enterprise workspace root IPC', () => {
  it('registers the full root and enterprise directory surface for the active window', async () => {
    const state = fixture()
    expect([...state.handlers.keys()]).toEqual([
      WORKSPACE_ROOT_STATE_CHANNEL,
      WORKSPACE_ROOT_CHOOSE_CHANNEL,
      WORKSPACE_ROOT_USE_DEFAULT_CHANNEL,
      ENTERPRISE_WORKSPACE_CREATE_CHANNEL,
      ENTERPRISE_WORKSPACE_IMPORT_CHANNEL,
    ])
    await expect(state.handlers.get(WORKSPACE_ROOT_STATE_CHANNEL)?.(state.event)).resolves.toMatchObject({
      rootPath: '/Documents/洞见企业空间', needsInitialSetup: true,
    })
    await expect(state.handlers.get(ENTERPRISE_WORKSPACE_CREATE_CHANNEL)?.(state.event, '杭州示例企业')).resolves.toMatchObject({
      name: '杭州示例企业', created: true,
    })
  })

  it('uses native directory dialogs for root switching and in-place imports', async () => {
    const state = fixture()
    state.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/企业资料根目录'] })
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/历史资料/既有企业'] })
    await expect(state.handlers.get(WORKSPACE_ROOT_CHOOSE_CHANNEL)?.(state.event)).resolves.toMatchObject({
      rootPath: '/企业资料根目录', isDefault: false,
    })
    await expect(state.handlers.get(ENTERPRISE_WORKSPACE_IMPORT_CHANNEL)?.(state.event)).resolves.toMatchObject({
      path: '/历史资料/既有企业', imported: true,
    })
    expect(state.showOpenDialog).toHaveBeenNthCalledWith(1, state.window, expect.objectContaining({
      properties: ['openDirectory', 'createDirectory'],
    }))
    expect(state.showOpenDialog).toHaveBeenNthCalledWith(2, state.window, expect.objectContaining({
      properties: ['openDirectory'],
    }))
  })

  it('returns null on cancellation and rejects requests from another renderer', async () => {
    const state = fixture()
    state.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(state.handlers.get(WORKSPACE_ROOT_CHOOSE_CHANNEL)?.(state.event)).resolves.toBeNull()
    const foreign = { sender: Object.freeze({ id: 9 }) } as unknown as IpcMainInvokeEvent
    expect(() => state.handlers.get(WORKSPACE_ROOT_STATE_CHANNEL)?.(foreign)).toThrow('当前主窗口')
  })
})
