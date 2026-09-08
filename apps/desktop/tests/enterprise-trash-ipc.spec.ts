import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerEnterpriseTrashIpc } from '../src/enterprise-trash-ipc.ts'
import {
  ENTERPRISE_CONVERSATION_TRASH_CHANNEL,
  ENTERPRISE_WORKSPACE_TRASH_CHANNEL,
  type EnterpriseTrashService,
} from '../src/enterprise-trash.ts'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function fixture() {
  const handlers = new Map<string, Handler>()
  const webContents = Object.freeze({ id: 7 })
  const window = { webContents } as unknown as BrowserWindow
  const trashWorkspace = vi.fn(async (_workspaceId: unknown): Promise<void> => undefined)
  const trashConversation = vi.fn(async (_sessionId: unknown): Promise<void> => undefined)
  const service = {
    trashWorkspace,
    trashConversation,
  } as unknown as EnterpriseTrashService
  const reportFailure = vi.fn()
  registerEnterpriseTrashIpc({
    ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) } },
    window,
    service,
    reportFailure,
  })
  const event = { sender: webContents } as unknown as IpcMainInvokeEvent
  return { event, handlers, reportFailure, trashConversation, trashWorkspace }
}

describe('enterprise Trash IPC', () => {
  it('registers id-only workspace and conversation operations for the active window', async () => {
    const state = fixture()
    await expect(state.handlers.get(ENTERPRISE_WORKSPACE_TRASH_CHANNEL)?.(state.event, 'workspace-one')).resolves.toBeUndefined()
    await expect(state.handlers.get(ENTERPRISE_CONVERSATION_TRASH_CHANNEL)?.(state.event, 'session-one')).resolves.toBeUndefined()
    expect(state.trashWorkspace).toHaveBeenCalledWith('workspace-one')
    expect(state.trashConversation).toHaveBeenCalledWith('session-one')
  })

  it('rejects calls from another renderer before invoking the service', () => {
    const state = fixture()
    const foreign = { sender: Object.freeze({ id: 9 }) } as unknown as IpcMainInvokeEvent
    expect(() => state.handlers.get(ENTERPRISE_WORKSPACE_TRASH_CHANNEL)?.(foreign, 'workspace-one'))
      .toThrow('当前主窗口')
    expect(state.trashWorkspace).not.toHaveBeenCalled()
  })

  it.each([
    ['workspace', ENTERPRISE_WORKSPACE_TRASH_CHANNEL, 'trashWorkspace'],
    ['conversation', ENTERPRISE_CONVERSATION_TRASH_CHANNEL, 'trashConversation'],
  ] as const)('reports the original %s failure to Host diagnostics and preserves rejection', async (operation, channel, method) => {
    const state = fixture()
    const failure = new Error('fixture persistence retirement failure')
    state[method].mockRejectedValueOnce(failure)
    await expect(state.handlers.get(channel)?.(state.event, 'fixture-id')).rejects.toBe(failure)
    expect(state.reportFailure).toHaveBeenCalledExactlyOnceWith(operation, failure)
  })
})
