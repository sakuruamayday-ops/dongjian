/** Persistent desktop-window preferences owned by the Electron main process. */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export const DESKTOP_PREFERENCES_READ_CHANNEL = 'gongchuang:desktop-preferences:read'
export const DESKTOP_CLOSE_BEHAVIOR_WRITE_CHANNEL = 'gongchuang:desktop-preferences:close-behavior'
export const DESKTOP_CLOSE_REQUEST_CHANNEL = 'gongchuang:desktop-close:request'
export const DESKTOP_CLOSE_RESPONSE_CHANNEL = 'gongchuang:desktop-close:response'

export type WindowsCloseBehavior = 'ask' | 'tray' | 'quit'
export type WindowsCloseDecision = Exclude<WindowsCloseBehavior, 'ask'> | null

interface DesktopPreferencesDocument {
  readonly schemaVersion: 2
  readonly windowsCloseBehavior: WindowsCloseBehavior
}

const DEFAULT_PREFERENCES: DesktopPreferencesDocument = Object.freeze({
  schemaVersion: 2,
  windowsCloseBehavior: 'ask',
})

function closeBehavior(value: unknown): WindowsCloseBehavior {
  if (value !== 'ask' && value !== 'tray' && value !== 'quit') throw new Error('关闭主窗口行为无效')
  return value
}

/** Keeps one Windows close prompt active until its response has fully settled. */
export class WindowsCloseRequestCoordinator {
  private request: { readonly id: string; phase: 'awaiting-renderer' | 'settling' } | null = null

  /** Start a prompt unless another response is still being processed. */
  start(requestId: string): boolean {
    if (this.request !== null) return false
    this.request = { id: requestId, phase: 'awaiting-renderer' }
    return true
  }

  /** Release a prompt whose renderer can no longer answer it. */
  cancelPending(): void {
    if (this.request?.phase === 'awaiting-renderer') this.request = null
  }

  /**
   * Validate and settle the active prompt before allowing a new close request.
   * @param requestId - Opaque identifier echoed by the renderer.
   * @param decision - User-selected tray, quit, or cancel action.
   * @param remember - Whether the selected non-cancel action should be persisted.
   * @param persist - Validated preference writer owned by the Electron main process.
   * @param commit - Native window action performed only after persistence settles.
   */
  async respond(
    requestId: unknown,
    decision: unknown,
    remember: unknown,
    persist: (decision: Exclude<WindowsCloseBehavior, 'ask'>) => Promise<void>,
    commit: (decision: WindowsCloseDecision) => void,
  ): Promise<void> {
    if (typeof requestId !== 'string' || requestId !== this.request?.id) {
      throw new Error('关闭主窗口请求已失效')
    }
    if (decision !== null && decision !== 'tray' && decision !== 'quit') {
      throw new Error('关闭主窗口选择无效')
    }
    if (typeof remember !== 'boolean') throw new Error('关闭主窗口记忆选项无效')
    this.request.phase = 'settling'
    try {
      if (remember && decision !== null) await persist(decision)
    } catch (error) {
      this.request = null
      throw error
    }
    this.request = null
    commit(decision)
  }
}

/** Stores the Windows title-bar close behavior without accepting arbitrary settings keys. */
export class DesktopPreferencesStore {
  constructor(private readonly filename: string) {}

  /** Read the last saved close behavior; older silent-close preferences migrate to an explicit choice. */
  async read(): Promise<DesktopPreferencesDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.filename, 'utf8')) as Partial<DesktopPreferencesDocument>
      if (parsed.schemaVersion !== 2) return DEFAULT_PREFERENCES
      return Object.freeze({ schemaVersion: 2, windowsCloseBehavior: closeBehavior(parsed.windowsCloseBehavior) })
    } catch {
      return DEFAULT_PREFERENCES
    }
  }

  /** Atomically persist one validated Windows close behavior. */
  async writeWindowsCloseBehavior(value: unknown): Promise<DesktopPreferencesDocument> {
    const document = Object.freeze({ schemaVersion: 2, windowsCloseBehavior: closeBehavior(value) })
    await writeFileAtomic(this.filename, `${JSON.stringify(document)}\n`, { mode: 0o600, dirMode: 0o700 })
    return document
  }
}
