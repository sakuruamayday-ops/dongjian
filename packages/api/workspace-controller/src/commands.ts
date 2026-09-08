/** Workspace command implementation and stable Remote failure mapping. */

import type { Context } from '@deepseek-ai/cordis'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  WorkspaceId,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceUnknownSessionError,
} from '@deepseek-ai/dsh-workspace'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { workspaceView } from './feed.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceManagementRequest,
  WorkspaceManagementValue,
  WorkspaceOrderValue,
  WorkspaceRenameRequest,
  WorkspaceSessionManagementRequest,
  WorkspaceSetSessionPinnedRequest,
  WorkspaceValue,
} from './types.ts'

/** Implements Workspace mutations against the authoritative registry. */
export class WorkspaceCommands {
  private operationTail = Promise.resolve()

  /** @param ctx - Host context containing the Workspace registry. */
  constructor(private readonly ctx: Context) {}

  /**
   * Create or resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.enqueue(async () => {
      try {
        const existing = await this.ctx.workspaceRegistry.resolveByPath(request.path)
        if (existing !== undefined) {
          if (this.ctx.workspaceRegistry.deletedWorkspaceIds.includes(existing.id)) {
            await this.ctx.workspaceRegistry.restoreDeletedWorkspace(existing.id)
          }
          return { workspace: workspaceView(existing), created: false }
        }
        const workspace = await this.ctx.workspaceRegistry.create(request.path)
        return { workspace: workspaceView(workspace), created: true }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'workspace/invalid-path',
          `cannot create a Workspace at "${request.path}": ${errorMessage(error)}`,
          { path: request.path },
          { cause: error },
        )
      }
    })
  }

  /**
   * Rename one Workspace after serializing title ownership checks.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(new RemoteError('gateway/bad-request', 'Workspace rename requires a non-blank title', {}))
    }
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      if (title !== workspace.title) {
        if (this.ctx.workspaceRegistry.list().some(candidate =>
          candidate.id !== workspace.id && candidate.title === title)) {
          throw new RemoteError(
            'workspace/name-conflict',
            `Workspace name '${title}' is already in use`,
            { name: title },
          )
        }
        await workspace.setTitle(title)
      }
      return { workspace: workspaceView(workspace) }
    })
  }

  /**
   * Delete one Workspace registration without deleting its directory or Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.enqueue(async () => {
      if (!await this.ctx.workspaceRegistry.delete(WorkspaceId(request.workspaceId))) {
        throw workspaceNotFound(request.workspaceId)
      }
      return { deleted: true }
    })
  }

  /**
   * Move one Workspace within the durable registry order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  async insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    try {
      const workspaceIds = await this.ctx.workspaceRegistry.insertBefore(
        WorkspaceId(request.workspaceId),
        request.beforeWorkspaceId === undefined
          ? undefined
          : WorkspaceId(request.beforeWorkspaceId),
      )
      return { workspaceIds: [...workspaceIds] }
    } catch (error) {
      if (!(error instanceof WorkspaceOrderInvalidError)) throw error
      throw workspaceNotFound(error.workspaceId)
    }
  }

  /**
   * Move one accounted Session within a Workspace's manual order.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  async insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    try {
      await workspace.insertSessionBefore(request.sessionId, request.beforeSessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceMoveInvalidError)) throw error
      throw new RemoteError(
        'workspace/move-invalid',
        error.message,
        {
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          ...request.beforeSessionId === undefined
            ? {}
            : { beforeSessionId: request.beforeSessionId },
        },
        { cause: error },
      )
    }
    return { workspace: workspaceView(workspace) }
  }

  /**
   * Add one known Session to the registry-global archive set.
   * @param request - Session identity to archive.
   * @returns the complete resulting archive set.
   */
  async archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceManagementValue> {
    try {
      await this.ctx.workspaceRegistry.archiveSession(request.sessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceUnknownSessionError)) throw error
      throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
    }
    return this.management()
  }

  /**
   * Pin or unpin one accounted Session and return the changed Workspace row.
   * @param request - Workspace, Session, and desired pin state.
   * @returns the changed Workspace row.
   */
  async setSessionPinned(request: WorkspaceSetSessionPinnedRequest): Promise<WorkspaceValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    try {
      await workspace.setSessionPinned(request.sessionId, request.pinned)
    } catch (error) {
      if (!(error instanceof WorkspaceMoveInvalidError)) throw error
      throw new RemoteError(
        'workspace/move-invalid',
        error.message,
        { workspaceId: request.workspaceId, sessionId: request.sessionId },
        { cause: error },
      )
    }
    return { workspace: workspaceView(workspace) }
  }

  /**
   * Hide a Workspace registration while retaining its record and directory.
   * @param request - Workspace identity to archive.
   * @returns the complete resulting management state.
   */
  async archiveWorkspace(request: WorkspaceManagementRequest): Promise<WorkspaceManagementValue> {
    await this.workspaceMutation(request.workspaceId, 'archive', () =>
      this.ctx.workspaceRegistry.archiveWorkspace(request.workspaceId))
    return this.management()
  }

  /**
   * Restore one archived Workspace registration.
   * @param request - Workspace identity to restore.
   * @returns the complete resulting management state.
   */
  async unarchiveWorkspace(request: WorkspaceManagementRequest): Promise<WorkspaceManagementValue> {
    await this.workspaceMutation(request.workspaceId, 'unarchive', () =>
      this.ctx.workspaceRegistry.unarchiveWorkspace(request.workspaceId))
    return this.management()
  }

  /**
   * Hide a Workspace registration behind a recoverable tombstone.
   * @param request - Workspace identity to hide.
   * @returns the complete resulting management state.
   */
  async deleteWorkspace(request: WorkspaceManagementRequest): Promise<WorkspaceManagementValue> {
    await this.workspaceMutation(request.workspaceId, 'delete', () =>
      this.ctx.workspaceRegistry.deleteWorkspace(request.workspaceId))
    return this.management()
  }

  /**
   * Restore one archived Session to active grouping surfaces.
   * @param request - Session identity to restore.
   * @returns the complete resulting management state.
   */
  async unarchiveSession(request: WorkspaceSessionManagementRequest): Promise<WorkspaceManagementValue> {
    await this.sessionMutation(request.sessionId, () =>
      this.ctx.workspaceRegistry.unarchiveSession(request.sessionId))
    return this.management()
  }

  /**
   * Hide one Session behind a recoverable client-history tombstone.
   * @param request - Session identity to hide.
   * @returns the complete resulting management state.
   */
  async deleteSession(request: WorkspaceSessionManagementRequest): Promise<WorkspaceManagementValue> {
    await this.sessionMutation(request.sessionId, () =>
      this.ctx.workspaceRegistry.deleteSession(request.sessionId))
    return this.management()
  }

  private requireWorkspace(workspaceId: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (workspace === undefined) throw workspaceNotFound(workspaceId)
    return workspace
  }

  private async workspaceMutation(
    workspaceId: WorkspaceId,
    operation: string,
    mutate: () => Promise<void>,
  ): Promise<void> {
    try {
      await mutate()
    } catch (error) {
      if (!(error instanceof WorkspaceOrderInvalidError)) throw error
      throw new RemoteError(
        'workspace/not-found',
        `cannot ${operation} Workspace "${workspaceId}": it is unavailable`,
        { workspaceId },
        { cause: error },
      )
    }
  }

  private async sessionMutation(sessionId: WorkspaceSessionManagementRequest['sessionId'], mutate: () => Promise<void>): Promise<void> {
    try {
      await mutate()
    } catch (error) {
      if (!(error instanceof WorkspaceUnknownSessionError)) throw error
      throw new RemoteError('session/not-found', error.message, { sessionId }, { cause: error })
    }
  }

  private management(): WorkspaceManagementValue {
    return {
      archivedWorkspaceIds: [...this.ctx.workspaceRegistry.archivedWorkspaceIds],
      deletedWorkspaceIds: [...this.ctx.workspaceRegistry.deletedWorkspaceIds],
      archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds],
      deletedSessionIds: [...this.ctx.workspaceRegistry.deletedSessionIds],
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function workspaceNotFound(workspaceId: WorkspaceId): RemoteError<'workspace/not-found'> {
  return new RemoteError(
    'workspace/not-found',
    `Workspace "${workspaceId}" not found`,
    { workspaceId },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
