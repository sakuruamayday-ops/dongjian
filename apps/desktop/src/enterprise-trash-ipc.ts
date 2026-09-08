/** Electron IPC registration for recoverable enterprise and conversation deletion. */

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  ENTERPRISE_CONVERSATION_TRASH_CHANNEL,
  ENTERPRISE_WORKSPACE_TRASH_CHANNEL,
  type EnterpriseTrashService,
} from './enterprise-trash.ts'

/** Electron services and active window required by product deletion handlers. */
export interface EnterpriseTrashIpcOptions {
  readonly ipcMain: Pick<IpcMain, 'handle'>
  readonly window: BrowserWindow
  readonly service: EnterpriseTrashService
  readonly reportFailure: (operation: 'workspace' | 'conversation', error: unknown) => void
}

function assertCurrentWindow(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (event.sender !== window.webContents) throw new Error('删除请求不属于当前主窗口')
}

/** Register id-only renderer operations; the main process resolves every filesystem path. */
export function registerEnterpriseTrashIpc(options: EnterpriseTrashIpcOptions): void {
  const { ipcMain, reportFailure, service, window } = options
  ipcMain.handle(ENTERPRISE_WORKSPACE_TRASH_CHANNEL, (event, workspaceId: unknown) => {
    assertCurrentWindow(event, window)
    return service.trashWorkspace(workspaceId).catch((error: unknown) => {
      reportFailure('workspace', error)
      throw error
    })
  })
  ipcMain.handle(ENTERPRISE_CONVERSATION_TRASH_CHANNEL, (event, sessionId: unknown) => {
    assertCurrentWindow(event, window)
    return service.trashConversation(sessionId).catch((error: unknown) => {
      reportFailure('conversation', error)
      throw error
    })
  })
}
