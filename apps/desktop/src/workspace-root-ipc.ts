/** Electron IPC registration for device-local enterprise workspace roots. */

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, OpenDialogReturnValue } from 'electron'
import {
  ENTERPRISE_WORKSPACE_CREATE_CHANNEL,
  ENTERPRISE_WORKSPACE_IMPORT_CHANNEL,
  WORKSPACE_ROOT_CHOOSE_CHANNEL,
  WORKSPACE_ROOT_STATE_CHANNEL,
  WORKSPACE_ROOT_USE_DEFAULT_CHANNEL,
  type DesktopWorkspaceRootStore,
} from './workspace-root.ts'

/** Electron services and active window required by the workspace-root handlers. */
export interface WorkspaceRootIpcOptions {
  readonly ipcMain: Pick<IpcMain, 'handle'>
  readonly window: BrowserWindow
  readonly store: DesktopWorkspaceRootStore
  readonly showOpenDialog: (
    window: BrowserWindow,
    options: Electron.OpenDialogOptions,
  ) => Promise<OpenDialogReturnValue>
}

function assertCurrentWindow(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (event.sender !== window.webContents) throw new Error('企业空间请求不属于当前主窗口')
}

/** Register the renderer-safe enterprise workspace root operations. */
export function registerWorkspaceRootIpc(options: WorkspaceRootIpcOptions): void {
  const { ipcMain, store, window } = options
  ipcMain.handle(WORKSPACE_ROOT_STATE_CHANNEL, (event) => {
    assertCurrentWindow(event, window)
    return store.state()
  })
  ipcMain.handle(WORKSPACE_ROOT_CHOOSE_CHANNEL, async (event) => {
    assertCurrentWindow(event, window)
    const selected = await options.showOpenDialog(window, {
      title: '选择企业空间根目录',
      buttonLabel: '使用此目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (selected.canceled || selected.filePaths[0] === undefined) return null
    return store.selectRoot(selected.filePaths[0])
  })
  ipcMain.handle(WORKSPACE_ROOT_USE_DEFAULT_CHANNEL, (event) => {
    assertCurrentWindow(event, window)
    return store.useDefaultRoot()
  })
  ipcMain.handle(ENTERPRISE_WORKSPACE_CREATE_CHANNEL, (event, name: unknown) => {
    assertCurrentWindow(event, window)
    return store.createEnterprise(name)
  })
  ipcMain.handle(ENTERPRISE_WORKSPACE_IMPORT_CHANNEL, async (event) => {
    assertCurrentWindow(event, window)
    const selected = await options.showOpenDialog(window, {
      title: '导入已有企业目录',
      buttonLabel: '导入企业空间',
      properties: ['openDirectory'],
    })
    if (selected.canceled || selected.filePaths[0] === undefined) return null
    return store.importEnterprise(selected.filePaths[0])
  })
}
