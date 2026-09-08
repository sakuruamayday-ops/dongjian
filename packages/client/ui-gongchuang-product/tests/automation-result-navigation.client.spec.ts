import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { openAutomationResultConversation } from '../src/client/index.ts'

const SESSION_ID = 'session-automation-result' as SessionId

function context(input: { archived?: boolean; deleted?: boolean; missing?: boolean } = {}) {
  const open = vi.fn()
  let restored = false
  const unarchiveSession = vi.fn(async () => { restored = true })
  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ byId: input.missing && !restored ? {} : { [SESSION_ID]: {} } }) },
      open,
    },
    workspaces: {
      list: { getSnapshot: () => ({
        archivedItems: [],
        archivedSessionIds: input.archived ? [SESSION_ID] : [],
        deletedSessionIds: input.deleted ? [SESSION_ID] : [],
      }) },
      unarchiveSession,
    },
  } as unknown as Context
  return { ctx, open, unarchiveSession }
}

describe('automation result conversation navigation', () => {
  it('restores the archived workspace before selecting its retained result', async () => {
    const fixture = context()
    const unarchiveWorkspace = vi.fn(async () => {})
    Object.assign(fixture.ctx.workspaces, { unarchiveWorkspace })
    vi.spyOn(fixture.ctx.workspaces.list, 'getSnapshot').mockReturnValue({
      archivedItems: [{ workspaceId: 'archived-workspace', sessionIds: [SESSION_ID] }],
      archivedSessionIds: [], deletedSessionIds: [],
    } as never)
    await openAutomationResultConversation(fixture.ctx, SESSION_ID, vi.fn())
    expect(unarchiveWorkspace).toHaveBeenCalledWith('archived-workspace')
    expect(unarchiveWorkspace.mock.invocationCallOrder[0]).toBeLessThan(fixture.open.mock.invocationCallOrder[0]!)
  })
  it('restores an archived result before opening it', async () => {
    const fixture = context({ archived: true, missing: true })
    const navigate = vi.fn()

    await openAutomationResultConversation(fixture.ctx, SESSION_ID, navigate)

    expect(fixture.unarchiveSession).toHaveBeenCalledWith(SESSION_ID)
    expect(fixture.unarchiveSession.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.open.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY)
    expect(fixture.open.mock.invocationCallOrder[0])
      .toBeLessThan(navigate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY)
    expect(navigate).toHaveBeenCalledWith('assistant')
  })

  it('rejects a deleted result without selecting or navigating to it', async () => {
    const fixture = context({ deleted: true })
    const navigate = vi.fn()

    await expect(openAutomationResultConversation(fixture.ctx, SESSION_ID, navigate))
      .rejects.toThrow('已删除')
    expect(fixture.unarchiveSession).not.toHaveBeenCalled()
    expect(fixture.open).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('reports a genuinely missing result after archive recovery is ruled out', async () => {
    const fixture = context({ missing: true })
    const navigate = vi.fn()

    await expect(openAutomationResultConversation(fixture.ctx, SESSION_ID, navigate))
      .rejects.toThrow('已不在本机会话列表')
    expect(fixture.unarchiveSession).not.toHaveBeenCalled()
    expect(fixture.open).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})
