/** Test-owned workspaces face: the renderer standard-kit observable plus recorded actions. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { workspaceSnapshot, workspaceView } from './fixtures.ts'
import type { FixtureSnapshot, Stabilizer } from './fixtures.ts'

/** Writable test representation of the immutable Workspace Controller snapshot. */
type WorkspaceFixtureSnapshot = FixtureSnapshot<WorkspaceSnapshot>

/** Callable command names on the production Workspace Controller face. */
type WorkspaceAction = {
  [Key in keyof IWorkspaces]: IWorkspaces[Key] extends (...args: never[]) => unknown ? Key : never
}[keyof IWorkspaces]

/** Test replacement retaining one Controller command's parameters and result. */
type WorkspaceStub<Key extends WorkspaceAction> = (
  ...args: Parameters<IWorkspaces[Key]>
) => ReturnType<IWorkspaces[Key]>

/**
 * Workspaces test double. Implements the same IWorkspaces face features
 * receive as `ctx.workspaces`, so a production face change breaks this
 * double at compile time. Every action records into {@link
 * TestWorkspaces.calls}; defaults are inert echoes — feature tests needing
 * richer behavior replace them via {@link TestWorkspaces.stub}.
 */
export class TestWorkspaces implements IWorkspaces {
  /** The useWorkspaces standard feed. */
  readonly list: SnapshotStore<WorkspaceFixtureSnapshot>

  /** Calls observed on the action face, newest last. */
  readonly calls: { method: string; args: unknown[] }[] = []

  /** Replaceable action seat: feature tests may stub richer behavior. */
  private readonly stubs = new Map<WorkspaceAction, (...args: unknown[]) => unknown>()

  /**
   * @param stabilize - the owning runtime's act wrapper.
   */
  constructor(private readonly stabilize: Stabilizer) {
    this.list = createSnapshotStore<WorkspaceFixtureSnapshot>({ ...workspaceSnapshot() })
  }

  /**
   * Update the workspace list state through an immer draft.
   * @param mutate - draft mutator.
   */
  async update(mutate: (draft: WorkspaceFixtureSnapshot) => void): Promise<void> {
    await this.stabilize(() => { this.list.update(mutate) })
  }

  /**
   * Replace an action's behavior (the recorded call is still appended first).
   * @param method - Controller action name (e.g. 'create').
   * @param impl - replacement behavior.
   */
  stub<Key extends WorkspaceAction>(method: Key, impl: WorkspaceStub<Key>): void {
    this.stubs.set(method, impl as (...args: unknown[]) => unknown)
  }

  /**
   * Create a Workspace (recorded). The default echoes a view derived from
   * the input; stub for failure or list-coupled flows.
   * @param input - the Host create payload.
   * @returns the created Workspace view.
   */
  async create(input: { path: string }): Promise<WorkspaceView> {
    this.calls.push({ method: 'create', args: [input] })
    const stub = this.stubs.get('create')
    if (stub !== undefined) return await (stub(input) as Promise<WorkspaceView>)
    return workspaceView({
      workspaceId: `ws-${input.path}` as WorkspaceId,
      title: input.path,
      path: input.path,
    })
  }

  /**
   * Rename a Workspace (recorded). The default echoes a minimal view.
   * @param workspaceId - target workspace.
   * @param title - new title.
   * @returns the updated view.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    this.calls.push({ method: 'rename', args: [workspaceId, title] })
    const stub = this.stubs.get('rename')
    if (stub !== undefined) return await (stub(workspaceId, title) as Promise<WorkspaceView>)
    return workspaceView({ workspaceId, title, path: `/${title}` })
  }

  /**
   * Delete a Workspace (recorded; default no-op).
   * @param workspaceId - target workspace.
   */
  async delete(workspaceId: WorkspaceId): Promise<void> {
    this.calls.push({ method: 'delete', args: [workspaceId] })
    await (this.stubs.get('delete')?.(workspaceId) as Promise<void> | undefined)
  }

  /**
   * Move a Workspace in display order (recorded; default no-op).
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor; omitted appends.
   */
  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    this.calls.push({ method: 'insertBefore', args: [workspaceId, beforeWorkspaceId] })
    await (this.stubs.get('insertBefore')?.(workspaceId, beforeWorkspaceId) as Promise<void> | undefined)
  }

  /**
   * Move an accounted session (recorded). The default echoes a minimal view.
   * @param workspaceId - target workspace.
   * @param sessionId - session to move.
   * @param beforeSessionId - anchor; omitted appends.
   * @returns the updated view.
   */
  async insertSessionBefore(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<WorkspaceView> {
    this.calls.push({ method: 'insertSessionBefore', args: [workspaceId, sessionId, beforeSessionId] })
    const stub = this.stubs.get('insertSessionBefore')
    if (stub !== undefined) return await (stub(workspaceId, sessionId, beforeSessionId) as Promise<WorkspaceView>)
    return workspaceView({ workspaceId, title: '', path: '', sessionIds: [sessionId] })
  }

  /**
   * Archive a session (recorded). The default mirrors the production face's
   * observable effect: the id joins the list state's archive set.
   * @param sessionId - session to archive.
   */
  async archiveSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'archiveSession', args: [sessionId] })
    const stub = this.stubs.get('archiveSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.archivedSessionIds = addUnique(draft.archivedSessionIds, sessionId)
      draft.deletedSessionIds = without(draft.deletedSessionIds, sessionId)
    })
  }

  /** Restore an archived session. */
  async unarchiveSession(sessionId: SessionId): Promise<void> {
    await this.recordManagement('unarchiveSession', [sessionId], (draft) => {
      draft.archivedSessionIds = without(draft.archivedSessionIds, sessionId)
    })
  }

  /** Move a session into the recoverable deleted set. */
  async deleteSession(sessionId: SessionId): Promise<void> {
    await this.recordManagement('deleteSession', [sessionId], (draft) => {
      draft.archivedSessionIds = without(draft.archivedSessionIds, sessionId)
      draft.deletedSessionIds = addUnique(draft.deletedSessionIds, sessionId)
    })
  }

  /** Pin or unpin an accounted session. */
  async setSessionPinned(workspaceId: WorkspaceId, sessionId: SessionId, pinned: boolean): Promise<void> {
    this.calls.push({ method: 'setSessionPinned', args: [workspaceId, sessionId, pinned] })
    const stub = this.stubs.get('setSessionPinned')
    if (stub !== undefined) {
      await (stub(workspaceId, sessionId, pinned) as Promise<void>)
      return
    }
    await this.update((draft) => {
      const updateRows = (rows: readonly WorkspaceView[]): WorkspaceView[] => rows.map(row =>
        row.workspaceId === workspaceId ? {
          ...row,
          sessionIds: pinned
            ? [sessionId, ...row.sessionIds.filter(id => id !== sessionId)]
            : row.sessionIds,
          pinnedSessionIds: pinned
            ? [sessionId, ...row.pinnedSessionIds.filter(id => id !== sessionId)]
            : row.pinnedSessionIds.filter(id => id !== sessionId),
        } : row)
      draft.items = updateRows(draft.items)
      draft.archivedItems = updateRows(draft.archivedItems)
    })
  }

  /** Move an active Workspace into the archive projection. */
  async archiveWorkspace(workspaceId: WorkspaceId): Promise<void> {
    await this.recordManagement('archiveWorkspace', [workspaceId], (draft) => {
      const row = draft.items.find(item => item.workspaceId === workspaceId)
      draft.items = draft.items.filter(item => item.workspaceId !== workspaceId)
      if (row !== undefined) draft.archivedItems = [...draft.archivedItems, row]
      draft.archivedWorkspaceIds = addUnique(draft.archivedWorkspaceIds, workspaceId)
      draft.deletedWorkspaceIds = without(draft.deletedWorkspaceIds, workspaceId)
    })
  }

  /** Restore an archived Workspace into the active projection. */
  async unarchiveWorkspace(workspaceId: WorkspaceId): Promise<void> {
    await this.recordManagement('unarchiveWorkspace', [workspaceId], (draft) => {
      const row = draft.archivedItems.find(item => item.workspaceId === workspaceId)
      draft.archivedItems = draft.archivedItems.filter(item => item.workspaceId !== workspaceId)
      if (row !== undefined) draft.items = [...draft.items, row]
      draft.archivedWorkspaceIds = without(draft.archivedWorkspaceIds, workspaceId)
    })
  }

  /** Move a Workspace into the recoverable deleted set. */
  async deleteWorkspace(workspaceId: WorkspaceId): Promise<void> {
    await this.recordManagement('deleteWorkspace', [workspaceId], (draft) => {
      draft.items = draft.items.filter(item => item.workspaceId !== workspaceId)
      draft.archivedItems = draft.archivedItems.filter(item => item.workspaceId !== workspaceId)
      draft.archivedWorkspaceIds = without(draft.archivedWorkspaceIds, workspaceId)
      draft.deletedWorkspaceIds = addUnique(draft.deletedWorkspaceIds, workspaceId)
    })
  }

  private async recordManagement(
    method: Extract<WorkspaceAction, string>,
    args: unknown[],
    mutate: (draft: WorkspaceFixtureSnapshot) => void,
  ): Promise<void> {
    this.calls.push({ method, args })
    const stub = this.stubs.get(method)
    if (stub !== undefined) {
      await (stub(...args) as Promise<void>)
      return
    }
    await this.update(mutate)
  }
}

function addUnique<Value>(values: readonly Value[], value: Value): Value[] {
  return values.includes(value) ? [...values] : [...values, value]
}

function without<Value>(values: readonly Value[], value: Value): Value[] {
  return values.filter(candidate => candidate !== value)
}
