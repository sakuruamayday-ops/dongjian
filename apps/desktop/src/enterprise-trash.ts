/** Recoverable deletion of product-owned enterprise workspaces and conversations. */

import { isAbsolute, relative } from 'node:path'
import type {
  EnterpriseTrashJournal, PendingConversationTrash, PendingWorkspaceTrash,
} from './enterprise-trash-journal.ts'

export const ENTERPRISE_WORKSPACE_TRASH_CHANNEL = 'gongchuang:enterprise-workspace:trash'
export const ENTERPRISE_CONVERSATION_TRASH_CHANNEL = 'gongchuang:enterprise-conversation:trash'

const MAX_ID_LENGTH = 512

/** Workspace facts resolved by the authoritative Host registry. */
export interface EnterpriseTrashWorkspace {
  readonly id: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

/** Session header fields needed to bind one artifact to its enterprise. */
interface EnterpriseTrashSessionHeader {
  readonly id: string
  readonly cwd?: string
}

/** Host services required for recoverable product deletion. */
export interface EnterpriseTrashHost {
  workspace(workspaceId: string): EnterpriseTrashWorkspace | undefined
  workspaces(): Promise<readonly Pick<EnterpriseTrashWorkspace, 'id' | 'path'>[]>
  assertWorkspaceDeletionSafe(workspace: EnterpriseTrashWorkspace): Promise<void>
  sessionHeaders(): Promise<ReadonlyMap<string, EnterpriseTrashSessionHeader>>
  sessionArtifactDirectory(header: unknown): string | undefined
  quiesceSession(sessionId: string): Promise<void>
  releaseSessionDisposal(sessionId: string): Promise<void>
  hardDeleteWorkspace(workspaceId: string): Promise<boolean>
  markDeletedSession(sessionId: string): Promise<void>
  restoreDeletedSession(sessionId: string): Promise<void>
}

/** Device operations kept injectable so partial Trash failures are testable. */
export interface EnterpriseTrashOptions {
  readonly host: EnterpriseTrashHost
  readonly journal: Pick<EnterpriseTrashJournal,
  'begin' | 'beginWorkspace' | 'complete' | 'completeWorkspace' | 'list' | 'listWorkspaces'>
  readonly trashItem: (path: string) => Promise<void>
  readonly pathExists: (path: string) => Promise<boolean>
}

function productId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH || value.includes('\0')) {
    throw new Error(`${label}标识无效`)
  }
  return value
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}

function isDescendantPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child !== '' && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(child)
}

/** Product deletion transaction that uses only Host-resolved paths and the operating-system Trash. */
export class EnterpriseTrashService {
  constructor(private readonly options: EnterpriseTrashOptions) {}

  /**
   * Move every cold session artifact and the enterprise directory to Trash, then remove the registry record.
   * @param workspaceIdValue - Opaque workspace id received from the renderer.
   */
  async trashWorkspace(workspaceIdValue: unknown): Promise<void> {
    const workspaceId = productId(workspaceIdValue, '企业空间')
    const pending = (await this.options.journal.listWorkspaces())
      .find(candidate => candidate.workspaceId === workspaceId)
    if (pending !== undefined) {
      await this.reconcilePendingWorkspace(pending)
      return
    }
    const workspace = this.options.host.workspace(workspaceId)
    if (workspace === undefined) throw new Error('企业空间不存在，请刷新后重试。')
    await this.assertWorkspaceRegistrySafety(workspace)
    const headers = await this.options.host.sessionHeaders()
    // The persisted header index closes the retry window where a partially
    // moved workspace directory makes the registry filter out a former member.
    const sessionIds = unique([
      ...workspace.sessionIds,
      ...[...headers.values()]
        .filter(header => header.cwd === workspace.path)
        .map(header => header.id),
    ])
    const sessionDirectories = sessionIds.map((sessionId) => {
      const header = headers.get(sessionId)
      if (header === undefined) throw new Error('企业空间包含无法定位的会话记录，删除未执行。请重启客户端后重试。')
      const directory = this.options.host.sessionArtifactDirectory(header)
      if (directory === undefined) {
        throw new Error('当前会话存储不支持安全删除单个会话，企业空间删除未执行。')
      }
      return directory
    })

    const intent: PendingWorkspaceTrash = Object.freeze({
      workspaceId,
      workspaceDirectory: workspace.path,
      sessionIds,
      sessionDirectories,
    })
    await this.options.journal.beginWorkspace(intent)
    await this.reconcilePendingWorkspace(intent)
  }

  /**
   * Move one cold conversation artifact to Trash, then hide it from every client list.
   * @param sessionIdValue - Opaque session id received from the renderer.
   */
  async trashConversation(sessionIdValue: unknown): Promise<void> {
    const sessionId = productId(sessionIdValue, '对话')
    const header = (await this.options.host.sessionHeaders()).get(sessionId)
    if (header === undefined) throw new Error('对话记录不存在，请刷新后重试。')
    const directory = this.options.host.sessionArtifactDirectory(header)
    if (directory === undefined) throw new Error('当前会话存储不支持安全删除单个对话。')
    await this.options.journal.begin(sessionId, directory)
    let artifactMoved = false
    try {
      await this.options.host.quiesceSession(sessionId)
      // Hide durably before moving the log. The main-process journal completes
      // the operation after a crash between these two irreversible boundaries.
      await this.options.host.markDeletedSession(sessionId)
      await this.trashPaths([directory], '对话')
      artifactMoved = true
      await this.options.journal.complete(sessionId)
    } catch (error) {
      if (artifactMoved) {
        throw new Error('对话记录已移入系统废纸篓，但删除事务尚未收尾。请重启客户端自动完成。', { cause: error })
      }
      await this.rollbackConversation(sessionId, error)
    }
  }

  /** Complete main-process deletion intents left by an interrupted application lifetime. */
  async reconcilePendingConversations(): Promise<void> {
    for (const pending of await this.options.journal.list()) {
      await this.reconcilePendingConversation(pending)
    }
  }

  /** Complete all main-process deletion intents left by an interrupted application lifetime. */
  async reconcilePending(): Promise<void> {
    for (const pending of await this.options.journal.listWorkspaces()) {
      await this.reconcilePendingWorkspace(pending)
    }
    await this.reconcilePendingConversations()
  }

  private async trashPaths(paths: readonly string[], label: string): Promise<void> {
    let moved = 0
    for (const path of paths) {
      if (!(await this.options.pathExists(path))) continue
      try {
        await this.options.trashItem(path)
        moved += 1
      } catch (error) {
        const detail = moved === 0
          ? `${label}尚未删除，可直接重试。`
          : `${String(moved)} 项已移入系统废纸篓；${label}仍保留在客户端，可再次删除或从系统废纸篓恢复。`
        throw new Error(`${label}删除未完成：${detail}`, { cause: error })
      }
    }
  }

  private async reconcilePendingConversation(pending: PendingConversationTrash): Promise<void> {
    let artifactMoved = false
    try {
      await this.options.host.quiesceSession(pending.sessionId)
      await this.options.host.markDeletedSession(pending.sessionId)
      await this.trashPaths([pending.artifactDirectory], '对话')
      artifactMoved = true
      await this.options.journal.complete(pending.sessionId)
    } catch (error) {
      if (artifactMoved) throw error
      await this.rollbackConversation(pending.sessionId, error)
    }
  }

  private async reconcilePendingWorkspace(pending: PendingWorkspaceTrash): Promise<void> {
    const current = this.options.host.workspace(pending.workspaceId)
    if (current === undefined) {
      await this.options.journal.completeWorkspace(pending.workspaceId)
      return
    }
    if (current.path !== pending.workspaceDirectory) {
      throw new Error('企业空间记录已变更，客户端拒绝继续旧删除事务。')
    }
    if (await this.options.pathExists(pending.workspaceDirectory)) {
      await this.assertWorkspaceRegistrySafety(current)
    }
    // The durable intent owns the first resolution of session artifacts. A retry
    // must not depend on persistence.list(), because moved JSONL logs disappear there.
    for (const sessionId of pending.sessionIds) await this.options.host.quiesceSession(sessionId)
    await this.trashPaths(unique([...pending.sessionDirectories, pending.workspaceDirectory]), '企业空间')
    if (!(await this.options.host.hardDeleteWorkspace(pending.workspaceId))) {
      throw new Error('企业目录已移入系统废纸篓，但客户端索引未能更新。请再次删除以完成收尾。')
    }
    await this.options.journal.completeWorkspace(pending.workspaceId)
  }

  private async assertWorkspaceRegistrySafety(workspace: EnterpriseTrashWorkspace): Promise<void> {
    await this.options.host.assertWorkspaceDeletionSafe(workspace)
    const nested = (await this.options.host.workspaces()).find(candidate =>
      candidate.id !== workspace.id && isDescendantPath(workspace.path, candidate.path))
    if (nested !== undefined) {
      throw new Error('该企业目录包含另一个已连接的企业空间。请先移动或删除子企业空间后重试。')
    }
  }

  private async rollbackConversation(sessionId: string, cause: unknown): Promise<never> {
    const failures: unknown[] = [cause]
    let restored = false
    try {
      await this.options.host.restoreDeletedSession(sessionId)
      restored = true
    } catch (error) {
      failures.push(error)
    }
    if (restored) {
      try {
        await this.options.journal.complete(sessionId)
      } catch (error) {
        failures.push(error)
      }
    }
    if (restored && failures.length === 1) {
      try {
        await this.options.host.releaseSessionDisposal(sessionId)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 1) {
      throw new Error('对话删除未完成，且恢复操作未能全部提交。请重启客户端后重试。', {
        cause: new AggregateError(failures),
      })
    }
    throw cause
  }
}
