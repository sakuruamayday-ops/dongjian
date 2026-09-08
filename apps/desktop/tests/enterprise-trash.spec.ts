import { describe, expect, it, vi } from 'vitest'
import {
  EnterpriseTrashService,
  type EnterpriseTrashHost,
  type EnterpriseTrashWorkspace,
} from '../src/enterprise-trash.ts'
import type { PendingWorkspaceTrash } from '../src/enterprise-trash-journal.ts'

const workspace: EnterpriseTrashWorkspace = {
  id: 'workspace-one',
  path: '/enterprise/one',
  sessionIds: ['session-one', 'session-two'],
}

function sessionHeaderId(header: unknown): string {
  if (typeof header !== 'object' || header === null || !('id' in header) || typeof header.id !== 'string') {
    throw new TypeError('测试会话头缺少字符串标识')
  }
  return header.id
}

function fixture(options: {
  readonly quiesceErrorAt?: string
  readonly missing?: readonly string[]
  readonly failTrashAt?: string
  readonly deleteResult?: boolean
  readonly markError?: Error
  readonly restoreError?: Error
  readonly completeError?: Error
  readonly completeWorkspaceError?: Error
  readonly unsafeWorkspace?: boolean
  readonly nestedWorkspace?: boolean
  readonly pending?: readonly { readonly sessionId: string; readonly artifactDirectory: string }[]
  readonly pendingWorkspaces?: readonly PendingWorkspaceTrash[]
  readonly missingHeaders?: readonly string[]
  readonly workspaceMissing?: boolean
} = {}) {
  const existing = new Set(['/runtime/session-one', '/runtime/session-two', '/enterprise/one'])
  for (const path of options.missing ?? []) existing.delete(path)
  const trashed: string[] = []
  const operations: string[] = []
  const pending = new Map((options.pending ?? []).map(item => [item.sessionId, item.artifactDirectory]))
  const pendingWorkspaces = new Map((options.pendingWorkspaces ?? []).map(item => [item.workspaceId, item]))
  const hardDeleteWorkspace = vi.fn(async (_workspaceId: string): Promise<boolean> => {
    operations.push('hard-delete:workspace-one')
    return options.deleteResult ?? true
  })
  const host: EnterpriseTrashHost = {
    workspace: id => id === workspace.id && options.workspaceMissing !== true ? workspace : undefined,
    workspaces: async () => options.nestedWorkspace === true
      ? [workspace, { id: 'workspace-child', path: '/enterprise/one/child' }]
      : [workspace],
    assertWorkspaceDeletionSafe: vi.fn(async () => {
      if (options.unsafeWorkspace === true) throw new Error('客户端拒绝删除系统宽目录')
    }),
    sessionHeaders: async () => new Map([
      ['session-one', { id: 'session-one', cwd: '/enterprise/one' }],
      ['session-two', { id: 'session-two', cwd: '/enterprise/one' }],
    ].filter(([id]) => !(options.missingHeaders ?? []).includes(id))),
    sessionArtifactDirectory: header => `/runtime/${sessionHeaderId(header)}`,
    quiesceSession: vi.fn(async (id) => {
      operations.push(`quiesce:${id}`)
      if (id === options.quiesceErrorAt) throw new Error('lifecycle owner unavailable')
    }),
    releaseSessionDisposal: vi.fn(async (id) => {
      operations.push(`release:${id}`)
    }),
    hardDeleteWorkspace,
    markDeletedSession: vi.fn(async (id) => {
      operations.push(`mark:${id}`)
      if (options.markError !== undefined) throw options.markError
    }),
    restoreDeletedSession: vi.fn(async (id) => {
      operations.push(`restore:${id}`)
      if (options.restoreError !== undefined) throw options.restoreError
    }),
  }
  const begin = vi.fn(async (sessionId: string, artifactDirectory: string): Promise<void> => {
    operations.push(`begin:${sessionId}`)
    pending.set(sessionId, artifactDirectory)
  })
  const complete = vi.fn(async (sessionId: string): Promise<void> => {
    operations.push(`complete:${sessionId}`)
    if (options.completeError !== undefined) throw options.completeError
    pending.delete(sessionId)
  })
  const beginWorkspace = vi.fn(async (intent: PendingWorkspaceTrash): Promise<void> => {
    operations.push(`begin-workspace:${intent.workspaceId}`)
    pendingWorkspaces.set(intent.workspaceId, intent)
  })
  const completeWorkspace = vi.fn(async (workspaceId: string): Promise<void> => {
    operations.push(`complete-workspace:${workspaceId}`)
    if (options.completeWorkspaceError !== undefined) throw options.completeWorkspaceError
    pendingWorkspaces.delete(workspaceId)
  })
  const service = new EnterpriseTrashService({
    host,
    journal: {
      list: async () => [...pending].map(([sessionId, artifactDirectory]) => ({ sessionId, artifactDirectory })),
      listWorkspaces: async () => [...pendingWorkspaces.values()],
      begin,
      complete,
      beginWorkspace,
      completeWorkspace,
    },
    pathExists: async path => existing.has(path),
    trashItem: async (path) => {
      if (path === options.failTrashAt) throw new Error('Trash unavailable')
      operations.push(`trash:${path}`)
      trashed.push(path)
      existing.delete(path)
    },
  })
  return { hardDeleteWorkspace, host, operations, pending, pendingWorkspaces, service, trashed }
}

describe('enterprise Trash service', () => {
  it('moves Host-resolved session directories and the workspace to Trash before hard removal', async () => {
    const state = fixture()
    await state.service.trashWorkspace('workspace-one')
    expect(state.trashed).toEqual(['/runtime/session-one', '/runtime/session-two', '/enterprise/one'])
    expect(state.operations).toEqual([
      'begin-workspace:workspace-one',
      'quiesce:session-one',
      'quiesce:session-two',
      'trash:/runtime/session-one',
      'trash:/runtime/session-two',
      'trash:/enterprise/one',
      'hard-delete:workspace-one',
      'complete-workspace:workspace-one',
    ])
    expect(state.hardDeleteWorkspace).toHaveBeenCalledWith('workspace-one')
  })

  it('rejects a lifecycle the Host cannot safely quiesce before moving any path', async () => {
    const state = fixture({ quiesceErrorAt: 'session-two' })
    await expect(state.service.trashWorkspace('workspace-one')).rejects.toThrow('lifecycle owner unavailable')
    expect(state.trashed).toEqual([])
    expect(state.hardDeleteWorkspace).not.toHaveBeenCalled()
  })

  it('rejects a parent directory that contains another registered workspace', async () => {
    const state = fixture({ nestedWorkspace: true })
    await expect(state.service.trashWorkspace('workspace-one')).rejects.toThrow('子企业空间')
    expect(state.operations).toEqual([])
    expect(state.trashed).toEqual([])
  })

  it('fails closed when the Host rejects a legacy broad workspace path', async () => {
    const state = fixture({ unsafeWorkspace: true })
    await expect(state.service.trashWorkspace('workspace-one')).rejects.toThrow('系统宽目录')
    expect(state.operations).toEqual([])
    expect(state.trashed).toEqual([])
    expect(state.hardDeleteWorkspace).not.toHaveBeenCalled()
  })

  it('keeps the registry retriable after a partial Trash failure and skips already-missing paths on retry', async () => {
    const failed = fixture({ failTrashAt: '/runtime/session-two' })
    await expect(failed.service.trashWorkspace('workspace-one')).rejects.toThrow('1 项已移入系统废纸篓')
    expect(failed.hardDeleteWorkspace).not.toHaveBeenCalled()

    const retry = fixture({
      missing: ['/runtime/session-one'],
      missingHeaders: ['session-one'],
      pendingWorkspaces: [{
        workspaceId: 'workspace-one',
        workspaceDirectory: '/enterprise/one',
        sessionIds: ['session-one', 'session-two'],
        sessionDirectories: ['/runtime/session-one', '/runtime/session-two'],
      }],
    })
    await retry.service.trashWorkspace('workspace-one')
    expect(retry.trashed).toEqual(['/runtime/session-two', '/enterprise/one'])
  })

  it('retries registry cleanup from a durable intent after every path was already moved', async () => {
    const intent: PendingWorkspaceTrash = {
      workspaceId: 'workspace-one',
      workspaceDirectory: '/enterprise/one',
      sessionIds: ['session-one', 'session-two'],
      sessionDirectories: ['/runtime/session-one', '/runtime/session-two'],
    }
    const failed = fixture({ deleteResult: false })
    await expect(failed.service.trashWorkspace('workspace-one')).rejects.toThrow('再次删除')
    expect(failed.pendingWorkspaces.get('workspace-one')).toEqual(intent)

    const retry = fixture({
      missing: ['/runtime/session-one', '/runtime/session-two', '/enterprise/one'],
      missingHeaders: ['session-one', 'session-two'],
      pendingWorkspaces: [intent],
    })
    await retry.service.trashWorkspace('workspace-one')
    expect(retry.trashed).toEqual([])
    expect(retry.operations).toContain('hard-delete:workspace-one')
    expect(retry.pendingWorkspaces.size).toBe(0)
  })

  it('finishes an interrupted workspace intent during startup without resolving moved headers again', async () => {
    const state = fixture({
      missing: ['/runtime/session-one', '/enterprise/one'],
      missingHeaders: ['session-one'],
      pendingWorkspaces: [{
        workspaceId: 'workspace-one',
        workspaceDirectory: '/enterprise/one',
        sessionIds: ['session-one', 'session-two'],
        sessionDirectories: ['/runtime/session-one', '/runtime/session-two'],
      }],
    })
    await state.service.reconcilePending()
    expect(state.trashed).toEqual(['/runtime/session-two'])
    expect(state.operations).toEqual([
      'quiesce:session-one',
      'quiesce:session-two',
      'trash:/runtime/session-two',
      'hard-delete:workspace-one',
      'complete-workspace:workspace-one',
    ])
  })

  it('clears a workspace intent after a crash that followed successful registry removal', async () => {
    const state = fixture({
      workspaceMissing: true,
      pendingWorkspaces: [{
        workspaceId: 'workspace-one',
        workspaceDirectory: '/enterprise/one',
        sessionIds: ['session-one'],
        sessionDirectories: ['/runtime/session-one'],
      }],
    })
    await state.service.reconcilePending()
    expect(state.operations).toEqual(['complete-workspace:workspace-one'])
    expect(state.pendingWorkspaces.size).toBe(0)
    expect(state.trashed).toEqual([])
  })

  it('quiesces and durably hides a conversation before moving its Host-resolved artifact', async () => {
    const state = fixture()
    await state.service.trashConversation('session-one')
    expect(state.trashed).toEqual(['/runtime/session-one'])
    expect(state.operations).toEqual([
      'begin:session-one',
      'quiesce:session-one',
      'mark:session-one',
      'trash:/runtime/session-one',
      'complete:session-one',
    ])
  })

  it('restores the durable conversation tombstone when Trash fails so the visible action is retriable', async () => {
    const state = fixture({ failTrashAt: '/runtime/session-one' })
    await expect(state.service.trashConversation('session-one')).rejects.toThrow('尚未删除，可直接重试')
    expect(state.trashed).toEqual([])
    expect(state.operations).toEqual([
      'begin:session-one',
      'quiesce:session-one',
      'mark:session-one',
      'restore:session-one',
      'complete:session-one',
      'release:session-one',
    ])
  })

  it('does not move an artifact when the durable tombstone cannot be committed', async () => {
    const state = fixture({ markError: new Error('index unavailable') })
    await expect(state.service.trashConversation('session-one')).rejects.toThrow('index unavailable')
    expect(state.trashed).toEqual([])
    expect(state.operations).toEqual([
      'begin:session-one',
      'quiesce:session-one',
      'mark:session-one',
      'restore:session-one',
      'complete:session-one',
      'release:session-one',
    ])
  })

  it('releases the deletion barrier when conversation quiescence fails before Trash', async () => {
    const state = fixture({ quiesceErrorAt: 'session-one' })
    await expect(state.service.trashConversation('session-one')).rejects.toThrow('lifecycle owner unavailable')
    expect(state.operations).toEqual([
      'begin:session-one',
      'quiesce:session-one',
      'restore:session-one',
      'complete:session-one',
      'release:session-one',
    ])
    expect(state.trashed).toEqual([])
  })

  it('finishes an interrupted durable conversation intent on startup', async () => {
    const state = fixture({
      pending: [{ sessionId: 'session-one', artifactDirectory: '/runtime/session-one' }],
    })

    await state.service.reconcilePendingConversations()

    expect(state.operations).toEqual([
      'quiesce:session-one',
      'mark:session-one',
      'trash:/runtime/session-one',
      'complete:session-one',
    ])
    expect(state.pending.size).toBe(0)
  })

  it('keeps a completed Trash intent for startup reconciliation when journal cleanup fails', async () => {
    const state = fixture({ completeError: new Error('journal unavailable') })
    await expect(state.service.trashConversation('session-one')).rejects.toThrow('重启客户端自动完成')
    expect(state.trashed).toEqual(['/runtime/session-one'])
    expect(state.pending.get('session-one')).toBe('/runtime/session-one')
    expect(state.operations).not.toContain('restore:session-one')
  })

  it('retains the recovery intent when restoring a failed tombstone also fails', async () => {
    const state = fixture({
      failTrashAt: '/runtime/session-one',
      restoreError: new Error('registry unavailable'),
    })
    await expect(state.service.trashConversation('session-one')).rejects.toThrow('恢复操作未能全部提交')
    expect(state.pending.get('session-one')).toBe('/runtime/session-one')
    expect(state.operations).not.toContain('complete:session-one')
  })

  it('rejects malformed renderer ids and unsupported per-session persistence', async () => {
    const state = fixture()
    await expect(state.service.trashConversation('../session-one')).rejects.toThrow('对话记录不存在')
    const unsupported = fixture()
    unsupported.host.sessionArtifactDirectory = () => undefined
    await expect(unsupported.service.trashConversation('session-one')).rejects.toThrow('不支持安全删除')
  })
})
