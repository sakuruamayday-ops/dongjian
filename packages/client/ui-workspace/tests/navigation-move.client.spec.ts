import { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UiWorkspaceService } from '../src/client/navigation.ts'

const sid = (value: string): SessionId => SessionId(value)
const wid = (value: string): WorkspaceId => value as WorkspaceId

const directoryPicker = {
  pick: vi.fn(),
  list: vi.fn(),
  createDirectory: vi.fn(),
} as unknown as ClientRemote['directoryPicker']

function workspace(id: string, sessionIds: readonly SessionId[]): WorkspaceView {
  return {
    workspaceId: wid(id),
    title: id,
    path: `/workspaces/${id}`,
    sessionIds,
    pinnedSessionIds: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
}

function workspaceSnapshot(
  items: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[] = [],
): WorkspaceSnapshot {
  return {
    items,
    archivedItems: [],
    archivedWorkspaceIds: [],
    deletedWorkspaceIds: [],
    archivedSessionIds,
    deletedSessionIds: [],
    phase: 'ready',
    state: 'idle',
    error: null,
  }
}

function summary(id: SessionId, cwd: string, updatedAt: number): SessionSummary {
  return {
    id,
    displayTitle: id,
    cwd,
    running: false,
    blank: false,
    updatedAt,
  }
}

function sessionSnapshot(items: readonly SessionSummary[], current: SessionId): SessionListState {
  return {
    ids: items.map(item => item.id),
    byId: Object.fromEntries(items.map(item => [item.id, item])),
    current,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function serviceFixture(options: {
  workspaceState: WorkspaceSnapshot
  sessionState: SessionListState
  forkToWorkspace: ISessions['forkToWorkspace']
  archiveSession: IWorkspaces['archiveSession']
}) {
  const ctx = new Context()
  const workspaces = {
    list: createSnapshotStore(options.workspaceState),
    archiveSession: options.archiveSession,
  } as unknown as IWorkspaces
  const sessions = {
    list: createSnapshotStore(options.sessionState),
    forkToWorkspace: options.forkToWorkspace,
    open: vi.fn(),
    clear: vi.fn(),
  } as unknown as ISessions
  return {
    ctx,
    service: new UiWorkspaceService(ctx, directoryPicker, workspaces, sessions),
    workspaces,
    sessions,
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('cross-workspace Session move', () => {
  it('forks into the target before archiving the source', async () => {
    const sourceId = sid('source')
    const childId = sid('child')
    const targetId = wid('target')
    const calls: string[] = []
    const forkToWorkspace = vi.fn<ISessions['forkToWorkspace']>(async () => {
      calls.push('fork')
      return childId
    })
    const archiveSession = vi.fn<IWorkspaces['archiveSession']>(async () => { calls.push('archive') })
    const fixture = serviceFixture({
      workspaceState: workspaceSnapshot([
        workspace('source-workspace', [sourceId]),
        workspace('target', []),
      ]),
      sessionState: sessionSnapshot([summary(sourceId, '/workspaces/source-workspace', 10)], sourceId),
      forkToWorkspace,
      archiveSession,
    })

    await expect(fixture.service.moveSessionToWorkspace(sourceId, targetId)).resolves.toBe(childId)
    expect(calls).toEqual(['fork', 'archive'])
    expect(forkToWorkspace).toHaveBeenCalledWith({
      sessionId: sourceId,
      workspaceId: targetId,
      cwd: '/workspaces/target',
    })
    expect(archiveSession).toHaveBeenCalledWith(sourceId)
    await fixture.ctx.fiber.dispose()
  })

  it('keeps the source visible when target creation or attachment fails', async () => {
    const sourceId = sid('source')
    const archiveSession = vi.fn<IWorkspaces['archiveSession']>()
    const fixture = serviceFixture({
      workspaceState: workspaceSnapshot([
        workspace('source-workspace', [sourceId]),
        workspace('target', []),
      ]),
      sessionState: sessionSnapshot([summary(sourceId, '/workspaces/source-workspace', 10)], sourceId),
      forkToWorkspace: vi.fn(() => Promise.reject(new Error('target attachment failed'))),
      archiveSession,
    })

    await expect(fixture.service.moveSessionToWorkspace(sourceId, wid('target')))
      .rejects.toThrow('target attachment failed')
    expect(archiveSession).not.toHaveBeenCalled()
    expect(fixture.sessions.list.getSnapshot().byId[sourceId]).toBeDefined()
    expect(fixture.workspaces.list.getSnapshot().archivedSessionIds).not.toContain(sourceId)
    await fixture.ctx.fiber.dispose()
  })

  it('keeps the source visible when its post-fork archive fails', async () => {
    const sourceId = sid('source')
    const childId = sid('child')
    const fixture = serviceFixture({
      workspaceState: workspaceSnapshot([
        workspace('source-workspace', [sourceId]),
        workspace('target', []),
      ]),
      sessionState: sessionSnapshot([summary(sourceId, '/workspaces/source-workspace', 10)], sourceId),
      forkToWorkspace: vi.fn(() => Promise.resolve(childId)),
      archiveSession: vi.fn(() => Promise.reject(new Error('archive unavailable'))),
    })

    await expect(fixture.service.moveSessionToWorkspace(sourceId, wid('target')))
      .rejects.toThrow('archive unavailable')
    expect(fixture.sessions.list.getSnapshot().byId[sourceId]).toBeDefined()
    expect(fixture.workspaces.list.getSnapshot().archivedSessionIds).not.toContain(sourceId)
    await fixture.ctx.fiber.dispose()
  })

  it('recognizes the target membership reconstructed after reload', async () => {
    const sourceId = sid('source')
    const childId = sid('child')
    const targetId = wid('target')
    const forkToWorkspace = vi.fn<ISessions['forkToWorkspace']>()
    const archiveSession = vi.fn<IWorkspaces['archiveSession']>()
    const fixture = serviceFixture({
      workspaceState: workspaceSnapshot([
        workspace('source-workspace', [sourceId]),
        workspace('target', [childId]),
      ], [sourceId]),
      sessionState: sessionSnapshot([
        summary(sourceId, '/workspaces/source-workspace', 10),
        summary(childId, '/workspaces/target', 20),
      ], childId),
      forkToWorkspace,
      archiveSession,
    })

    await expect(fixture.service.moveSessionToWorkspace(childId, targetId)).resolves.toBe(childId)
    expect(forkToWorkspace).not.toHaveBeenCalled()
    expect(archiveSession).not.toHaveBeenCalled()
    await fixture.ctx.fiber.dispose()
  })
})
