/** Client-side Workspace state model shared by Remote transport and UI projection. */

import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/remote'
import { isRemoteFailure } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteFailure, RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceBaseline,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteValue,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceManagementValue,
  WorkspaceOrderValue,
  WorkspaceValue,
  WorkspaceId,
  WorkspaceView,
} from '../types.ts'

/** Complete generated `ctx.remote.workspace` namespace. */
export type WorkspaceRemote = TypertClientRemote['workspace']

/** Monotone Workspace-list arrival lifecycle. */
export type WorkspaceListPhase = 'pending' | 'ready'

/** Immutable Client Workspace state. */
export interface WorkspaceSnapshot {
  /** Active Workspace rows in durable registry order. */
  readonly items: readonly WorkspaceView[]
  /** Archived Workspace rows retained for explicit recovery. */
  readonly archivedItems: readonly WorkspaceView[]
  readonly archivedWorkspaceIds: WorkspaceManagementValue['archivedWorkspaceIds']
  readonly deletedWorkspaceIds: WorkspaceManagementValue['deletedWorkspaceIds']
  readonly archivedSessionIds: WorkspaceManagementValue['archivedSessionIds']
  readonly deletedSessionIds: WorkspaceManagementValue['deletedSessionIds']
  readonly state: 'idle' | 'loading' | 'error'
  readonly phase: WorkspaceListPhase
  readonly error: RemoteFailure | null
}

/** State operations emitted by a decoded Workspace follow generation. */
export interface WorkspaceFollowSink {
  /** Replace all state from the generation baseline. */
  replaceBaseline(value: WorkspaceBaseline): void
  /** Merge one Workspace row. */
  upsertView(workspace: WorkspaceView): void
  /** Remove one Workspace row. */
  removeView(workspaceId: WorkspaceId): void
  /** Replace the Host-confirmed Workspace order. */
  replaceOrder(workspaceIds: readonly WorkspaceId[]): void
  /** Replace the complete archive and recoverable-delete state. */
  replaceManagement(value: WorkspaceManagementValue): void
}

/**
 * Owns the Client Workspace projection, mutation echoes, and stream/unary race resolution.
 */
export class ClientWorkspaceModel implements WorkspaceFollowSink {
  private allItems: readonly WorkspaceView[] = []
  private management: WorkspaceManagementValue = {
    archivedWorkspaceIds: [],
    deletedWorkspaceIds: [],
    archivedSessionIds: [],
    deletedSessionIds: [],
  }
  private state: WorkspaceSnapshot['state'] = 'loading'
  private phase: WorkspaceListPhase = 'pending'
  private error: RemoteFailure | null = null
  /** Latest local reorder request; only its unary echo may install order. */
  private orderRequestGeneration = 0
  /** Increments on stream orders so a later remote commit outranks an older unary echo. */
  private orderFrameGeneration = 0
  /** Last complete order accepted from a baseline, increment, or current unary echo. */
  private committedOrder: WorkspaceId[] = []
  /** Host Workspace ids are never reused, so delayed data cannot resurrect a removed row. */
  private readonly removedIds = new Set<WorkspaceId>()
  private readonly listeners = new Set<() => void>()
  private snapshotCache: WorkspaceSnapshot
  private snapshotDirty = false
  private notificationPending = false
  private notificationScheduled = false
  private notificationGeneration = 0

  /** @param remote - generated Workspace Remote namespace. */
  constructor(private readonly remote: WorkspaceRemote) {
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * Create or resolve a Workspace and merge the unary result immediately.
   * @param input - existing absolute path to adopt.
   * @returns generated Remote result.
   */
  async create(input: WorkspaceCreateRequest): Promise<RemoteResult<WorkspaceCreateValue>> {
    const result = await this.remote.create(input)
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * Rename a Workspace and merge the unary result immediately.
   * @param workspaceId - target Workspace.
   * @param title - new display title.
   * @returns generated Remote result.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<RemoteResult<WorkspaceValue>> {
    const result = await this.remote.rename({ workspaceId, title })
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * Delete a Workspace and remove it from the local projection immediately.
   * @param workspaceId - target Workspace.
   * @returns generated Remote result.
   */
  async delete(workspaceId: WorkspaceId): Promise<RemoteResult<WorkspaceDeleteValue>> {
    const result = await this.remote.delete({ workspaceId })
    if (result.ok) this.remove(workspaceId, true)
    return result
  }

  /**
   * Optimistically move a Workspace and reconcile the returned complete order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - anchor Workspace; omitted appends.
   * @returns generated Remote result.
   */
  async insertBefore(
    workspaceId: WorkspaceId,
    beforeWorkspaceId?: WorkspaceId,
  ): Promise<RemoteResult<WorkspaceOrderValue>> {
    const requestGeneration = ++this.orderRequestGeneration
    const frameGeneration = this.orderFrameGeneration
    const localOrder = this.allItems.map(workspace => workspace.workspaceId)
    this.installOrder(insertIdBefore(localOrder, workspaceId, beforeWorkspaceId))
    const result = await this.remote.insertBefore({
      workspaceId,
      ...beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId },
    })
    if (requestGeneration === this.orderRequestGeneration
      && frameGeneration === this.orderFrameGeneration) {
      this.installOrder(result.ok ? result.value.workspaceIds : this.committedOrder, result.ok)
    }
    return result
  }

  /**
   * Move a Session within its Workspace and merge the returned row.
   * @param workspaceId - owning Workspace.
   * @param sessionId - accounted Session to move.
   * @param beforeSessionId - accounted anchor; omitted appends.
   * @returns generated Remote result.
   */
  async insertSessionBefore(
    workspaceId: WorkspaceInsertSessionBeforeRequest['workspaceId'],
    sessionId: WorkspaceInsertSessionBeforeRequest['sessionId'],
    beforeSessionId?: WorkspaceInsertSessionBeforeRequest['beforeSessionId'],
  ): Promise<RemoteResult<WorkspaceValue>> {
    const result = await this.remote.insertSessionBefore({
      workspaceId,
      sessionId,
      ...beforeSessionId === undefined ? {} : { beforeSessionId },
    })
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * Archive one Session and install the returned complete archive set.
   * @param sessionId - Session to archive.
   * @returns generated Remote result.
   */
  async archiveSession(
    sessionId: WorkspaceArchiveSessionRequest['sessionId'],
  ): Promise<RemoteResult<WorkspaceManagementValue>> {
    const result = await this.remote.archiveSession({ sessionId })
    if (result.ok) this.installManagement(result.value)
    return result
  }

  /**
   * Pin or unpin one accounted Session and merge the changed row.
   * @param workspaceId - owning Workspace.
   * @param sessionId - Session to update.
   * @param pinned - desired pin state.
   * @returns generated Remote result containing the changed Workspace.
   */
  async setSessionPinned(
    workspaceId: WorkspaceId,
    sessionId: WorkspaceInsertSessionBeforeRequest['sessionId'],
    pinned: boolean,
  ): Promise<RemoteResult<WorkspaceValue>> {
    const result = await this.remote.setSessionPinned({ workspaceId, sessionId, pinned })
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * Archive one Workspace and install the complete management state.
   * @param workspaceId - Workspace to archive.
   * @returns generated Remote result containing the complete management state.
   */
  archiveWorkspace(workspaceId: WorkspaceId): Promise<RemoteResult<WorkspaceManagementValue>> {
    return this.mutateManagement(() => this.remote.archiveWorkspace({ workspaceId }))
  }

  /**
   * Restore one archived Workspace and install the complete management state.
   * @param workspaceId - Workspace to restore.
   * @returns generated Remote result containing the complete management state.
   */
  unarchiveWorkspace(workspaceId: WorkspaceId): Promise<RemoteResult<WorkspaceManagementValue>> {
    return this.mutateManagement(() => this.remote.unarchiveWorkspace({ workspaceId }))
  }

  /**
   * Soft-delete one Workspace and install the complete management state.
   * @param workspaceId - Workspace to hide.
   * @returns generated Remote result containing the complete management state.
   */
  deleteWorkspace(workspaceId: WorkspaceId): Promise<RemoteResult<WorkspaceManagementValue>> {
    return this.mutateManagement(() => this.remote.deleteWorkspace({ workspaceId }))
  }

  /**
   * Restore one archived Session and install the complete management state.
   * @param sessionId - Session to restore.
   * @returns generated Remote result containing the complete management state.
   */
  unarchiveSession(sessionId: WorkspaceArchiveSessionRequest['sessionId']): Promise<RemoteResult<WorkspaceManagementValue>> {
    return this.mutateManagement(() => this.remote.unarchiveSession({ sessionId }))
  }

  /**
   * Soft-delete one Session and install the complete management state.
   * @param sessionId - Session to hide.
   * @returns generated Remote result containing the complete management state.
   */
  deleteSession(sessionId: WorkspaceArchiveSessionRequest['sessionId']): Promise<RemoteResult<WorkspaceManagementValue>> {
    return this.mutateManagement(() => this.remote.deleteSession({ sessionId }))
  }

  /**
   * Replace the projection from one complete stream-generation baseline.
   * @param baseline - complete Workspace and archive projection.
   */
  replaceBaseline(baseline: WorkspaceBaseline): void {
    this.orderFrameGeneration++
    this.installViews(baseline.items)
    this.installManagement(baseline.management)
    this.state = 'idle'
    this.phase = 'ready'
    this.error = null
    this.invalidate()
  }

  /** Merge one decoded Workspace upsert from the current follow generation. */
  upsertView(workspace: WorkspaceView): void {
    this.upsert(workspace)
  }

  /** Apply one decoded Workspace removal from the current follow generation. */
  removeView(workspaceId: WorkspaceId): void {
    this.remove(workspaceId)
  }

  /** Replace Host-confirmed order from the current follow generation. */
  replaceOrder(workspaceIds: readonly WorkspaceId[]): void {
    this.orderFrameGeneration++
    this.installOrder(workspaceIds, true)
  }

  /** Replace archive and recoverable-delete state from the current follow generation. */
  replaceManagement(value: WorkspaceManagementValue): void {
    this.installManagement(value)
  }

  /** Keep the last complete projection visible while a lost carrier reconnects. */
  handleCarrierFailure(): void {
    this.state = 'loading'
    this.error = null
    this.invalidate()
  }

  /**
   * Publish a non-retryable stream or protocol failure.
   * @param error - terminal stream failure.
   */
  handleStreamFailure(error: unknown): void {
    if (!isRemoteFailure(error)) throw error
    this.state = 'error'
    this.error = error
    this.invalidate()
  }

  /**
   * Subscribe to Workspace state invalidation.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Read the cached state, rebuilding it first when necessary.
   * @returns the current stable Workspace list snapshot.
   */
  getSnapshot(): WorkspaceSnapshot {
    this.refreshSnapshot()
    return this.snapshotCache
  }

  private buildSnapshot(): WorkspaceSnapshot {
    const archived = new Set(this.management.archivedWorkspaceIds)
    const deleted = new Set(this.management.deletedWorkspaceIds)
    return {
      items: this.allItems.filter(item => !archived.has(item.workspaceId) && !deleted.has(item.workspaceId)),
      archivedItems: this.allItems.filter(item => archived.has(item.workspaceId) && !deleted.has(item.workspaceId)),
      ...this.management,
      state: this.state,
      phase: this.phase,
      error: this.error,
    }
  }

  private installManagement(value: WorkspaceManagementValue): void {
    if (sameManagement(this.management, value)) return
    this.management = {
      archivedWorkspaceIds: [...value.archivedWorkspaceIds],
      deletedWorkspaceIds: [...value.deletedWorkspaceIds],
      archivedSessionIds: [...value.archivedSessionIds],
      deletedSessionIds: [...value.deletedSessionIds],
    }
    this.invalidate()
  }

  private installOrder(workspaceIds: readonly WorkspaceId[], committed = false): void {
    if (committed) this.committedOrder = [...workspaceIds]
    const rank = new Map(workspaceIds.map((id, index) => [id, index]))
    const items = [...this.allItems].sort((left, right) =>
      (rank.get(left.workspaceId) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(right.workspaceId) ?? Number.MAX_SAFE_INTEGER))
    if (items.every((item, index) => item === this.allItems[index])) return
    this.allItems = items
    this.invalidate()
  }

  private upsert(view: WorkspaceView): void {
    if (this.removedIds.has(view.workspaceId)) return
    const index = this.allItems.findIndex(item => item.workspaceId === view.workspaceId)
    const installed = this.allItems[index]
    // Unary responses and stream increments race on separate requests. Keep
    // the newest Host projection regardless of their arrival order.
    if (installed !== undefined && Date.parse(view.updatedAt) < Date.parse(installed.updatedAt)) return
    if (!this.committedOrder.includes(view.workspaceId)) {
      this.committedOrder = [view.workspaceId, ...this.committedOrder]
    }
    this.allItems = index === -1
      ? [view, ...this.allItems]
      : this.allItems.map((item, position) => position === index ? view : item)
    this.invalidate()
  }

  private remove(workspaceId: WorkspaceId, immediate = false): void {
    this.removedIds.add(workspaceId)
    this.committedOrder = this.committedOrder.filter(id => id !== workspaceId)
    const items = this.allItems.filter(item => item.workspaceId !== workspaceId)
    if (items.length === this.allItems.length) {
      // A successful unary echo still publishes an earlier increment's
      // pending removal before the user operation resolves.
      if (immediate) this.invalidate(true)
      return
    }
    this.allItems = items
    this.invalidate(immediate)
  }

  private installViews(views: readonly WorkspaceView[]): void {
    const installed = new Map<WorkspaceId, WorkspaceView>()
    for (const view of views) {
      if (!this.removedIds.has(view.workspaceId)) installed.set(view.workspaceId, view)
    }
    this.allItems = [...installed.values()]
    this.committedOrder = views.map(view => view.workspaceId)
  }

  private invalidate(immediate = false): void {
    this.snapshotDirty = true
    this.notificationPending = true
    if (immediate) {
      this.notificationGeneration++
      this.notificationScheduled = false
      this.flush()
      return
    }
    if (this.notificationScheduled) return
    this.notificationScheduled = true
    const generation = ++this.notificationGeneration
    queueMicrotask(() => {
      if (generation !== this.notificationGeneration) return
      this.notificationScheduled = false
      this.flush()
    })
  }

  private flush(): void {
    if (!this.notificationPending || this.listeners.size === 0) return
    this.notificationPending = false
    this.refreshSnapshot()
    notifySubscribers(this.listeners, '[workspace-controller]')
  }

  private refreshSnapshot(): void {
    if (!this.snapshotDirty) return
    this.snapshotDirty = false
    this.snapshotCache = this.buildSnapshot()
  }

  private async mutateManagement(
    mutate: () => Promise<RemoteResult<WorkspaceManagementValue>>,
  ): Promise<RemoteResult<WorkspaceManagementValue>> {
    const result = await mutate()
    if (result.ok) this.installManagement(result.value)
    return result
  }
}

function sameManagement(left: WorkspaceManagementValue, right: WorkspaceManagementValue): boolean {
  return sameIds(left.archivedWorkspaceIds, right.archivedWorkspaceIds)
    && sameIds(left.deletedWorkspaceIds, right.deletedWorkspaceIds)
    && sameIds(left.archivedSessionIds, right.archivedSessionIds)
    && sameIds(left.deletedSessionIds, right.deletedSessionIds)
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function insertIdBefore(
  ids: readonly WorkspaceId[],
  id: WorkspaceId,
  beforeId?: WorkspaceId,
): WorkspaceId[] {
  if (!ids.includes(id) || (beforeId !== undefined && !ids.includes(beforeId)) || beforeId === id) {
    return [...ids]
  }
  const without = ids.filter(candidate => candidate !== id)
  const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
  return [...without.slice(0, at), id, ...without.slice(at)]
}
