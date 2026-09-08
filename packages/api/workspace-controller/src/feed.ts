/** Reconnect-safe Workspace baseline and increment producer. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace, WorkspaceRecord } from '@deepseek-ai/dsh-workspace'
import {
  workspaceDomainState,
  workspaceRecord,
  WorkspaceId,
} from '@deepseek-ai/dsh-workspace'
import type {
  WorkspaceBaseline,
  WorkspaceFollowFrame,
  WorkspaceManagementValue,
  WorkspaceView,
} from './types.ts'

/**
 * Project one authoritative Workspace entity into its Remote value.
 * @param workspace - authoritative registry entity.
 * @returns detached Workspace projection for Remote consumers.
 */
export function workspaceView(workspace: Workspace): WorkspaceView {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    pinnedSessionIds: [...workspace.pinnedSessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

function changedWorkspaceView(workspaceId: string, value: unknown): WorkspaceView {
  const record: WorkspaceRecord = workspaceRecord.parse(value)
  return {
    workspaceId: WorkspaceId(workspaceId),
    path: record.path,
    title: record.title,
    sessionIds: [...record.sessionIds],
    pinnedSessionIds: [...record.pinnedSessionIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** Owns Workspace domain observation and all active follow generations. */
export class WorkspaceFeed {
  private readonly followers = new Set<WorkspaceFollower>()
  private knownIds: Set<string>
  private order: readonly string[]
  private management: WorkspaceManagementValue

  /** @param ctx - Host context containing the authoritative Workspace registry. */
  constructor(private readonly ctx: Context) {
    const baseline = ctx.workspaceRegistry.list()
    this.knownIds = new Set(baseline.map(workspace => String(workspace.id)))
    this.order = baseline.map(workspace => String(workspace.id))
    this.management = managementValue(ctx)
    ctx.on('domain/changed', (change: DomainChanged) => { this.changed(change) })
    ctx.effect(() => () => {
      for (const follower of this.followers) follower.close()
      this.followers.clear()
    }, 'workspace-controller.feed')
  }

  /**
   * Read the complete current projection synchronously.
   * @returns all active Workspaces and archived Session identities.
   */
  baseline(): WorkspaceBaseline {
    return {
      items: this.ctx.workspaceRegistry.list().map(workspaceView),
      management: managementValue(this.ctx),
    }
  }

  /**
   * Open one generation beginning with a complete baseline.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  async *follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    signal.throwIfAborted()
    const follower = new WorkspaceFollower()
    this.followers.add(follower)
    try {
      yield { type: 'baseline', value: this.baseline() }
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  private changed(change: DomainChanged): void {
    if (change.domain !== 'workspace') return
    if (change.table === '') {
      if (change.operation !== 'put') return
      const state = workspaceDomainState.parse(change.value)
      const nextOrder = state.workspaceIds.map(String)
      const orderChanged = !sameStrings(this.order, nextOrder)
      for (const id of state.workspaceIds) {
        if (this.knownIds.has(id)) continue
        const workspace = this.ctx.workspaceRegistry.get(id)
        if (workspace === undefined) {
          throw new Error(`committed Workspace registry references missing Workspace "${id}"`)
        }
        this.knownIds.add(id)
        this.publish({ type: 'upsert', workspace: workspaceView(workspace) })
      }
      this.order = nextOrder
      if (orderChanged) this.publish({ type: 'order', workspaceIds: [...state.workspaceIds] })
      const nextManagement: WorkspaceManagementValue = {
        archivedWorkspaceIds: [...state.archivedWorkspaceIds],
        deletedWorkspaceIds: [...state.deletedWorkspaceIds],
        archivedSessionIds: [...state.archivedSessionIds],
        deletedSessionIds: [...state.deletedSessionIds],
      }
      if (!sameManagement(this.management, nextManagement)) {
        this.management = nextManagement
        this.publish({ type: 'management', value: nextManagement })
      }
      return
    }
    if (change.table !== 'workspaces') return
    if (change.operation === 'deleted') {
      if (!this.knownIds.delete(change.key)) return
      this.publish({ type: 'remove', workspaceId: WorkspaceId(change.key) })
      return
    }
    if (!this.knownIds.has(change.key)) return
    this.publish({
      type: 'upsert',
      workspace: changedWorkspaceView(change.key, change.value),
    })
  }

  private publish(frame: Exclude<WorkspaceFollowFrame, { readonly type: 'baseline' }>): void {
    for (const follower of this.followers) follower.push(frame)
  }
}

function managementValue(ctx: Context): WorkspaceManagementValue {
  return {
    archivedWorkspaceIds: [...ctx.workspaceRegistry.archivedWorkspaceIds],
    deletedWorkspaceIds: [...ctx.workspaceRegistry.deletedWorkspaceIds],
    archivedSessionIds: [...ctx.workspaceRegistry.archivedSessionIds],
    deletedSessionIds: [...ctx.workspaceRegistry.deletedSessionIds],
  }
}

function sameManagement(left: WorkspaceManagementValue, right: WorkspaceManagementValue): boolean {
  return sameStrings(left.archivedWorkspaceIds, right.archivedWorkspaceIds)
    && sameStrings(left.deletedWorkspaceIds, right.deletedWorkspaceIds)
    && sameStrings(left.archivedSessionIds, right.archivedSessionIds)
    && sameStrings(left.deletedSessionIds, right.deletedSessionIds)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

class WorkspaceFollower {
  private readonly frames = new Deque<WorkspaceFollowFrame>()
  private waiting: (() => void) | undefined
  private closed = false

  push(frame: WorkspaceFollowFrame): void {
    /* v8 ignore next -- closed followers are removed before later publication can reach them. */
    if (this.closed) return
    this.frames.pushBack(frame)
    this.waiting?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    while (!this.closed && !signal.aborted) {
      const frame = this.frames.popFront()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await this.wait(signal)
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one read owns the sole installed wait callback. */
        if (this.waiting === finish) this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
      /* v8 ignore next -- native signals and the private queue cannot change during this synchronous setup. */
      if (signal.aborted || this.closed || this.frames.size > 0) finish()
    })
  }
}
