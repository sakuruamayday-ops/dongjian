import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { openDeepLinkedConversation } from '../src/client/index.ts'
import { sessionDeepLink } from '../src/client/session-deep-link.ts'

const SESSION_ID = 'session-8047334b-7c23-4880-9e5a-add88992de30'

function context(options: { archived?: boolean; deleted?: boolean; present?: boolean } = {}): {
  ctx: Pick<Context, 'sessions' | 'workspaces'>
  open: ReturnType<typeof vi.fn>
  unarchive: ReturnType<typeof vi.fn>
} {
  const open = vi.fn()
  const unarchive = vi.fn(async () => undefined)
  const byId = options.present === false ? {} : { [SESSION_ID]: { id: SESSION_ID } }
  return {
    ctx: {
      sessions: { list: { getSnapshot: () => ({ byId }) }, open } as never,
      workspaces: {
        list: { getSnapshot: () => ({
          archivedItems: [],
          archivedSessionIds: options.archived ? [SESSION_ID] : [],
          deletedSessionIds: options.deleted ? [SESSION_ID] : [],
        }) },
        unarchiveSession: unarchive,
      } as never,
    },
    open,
    unarchive,
  }
}

describe('product Session deep links', () => {
  it('restores the owning archived workspace before opening the conversation', async () => {
    const fixture = context()
    const unarchiveWorkspace = vi.fn(async () => {})
    Object.assign(fixture.ctx.workspaces, { unarchiveWorkspace })
    vi.spyOn(fixture.ctx.workspaces.list, 'getSnapshot').mockReturnValue({
      archivedItems: [{ workspaceId: 'archived-workspace', sessionIds: [SESSION_ID] }],
      archivedSessionIds: [], deletedSessionIds: [],
    } as never)
    await openDeepLinkedConversation(fixture.ctx, SESSION_ID, vi.fn())
    expect(unarchiveWorkspace).toHaveBeenCalledWith('archived-workspace')
    expect(unarchiveWorkspace.mock.invocationCallOrder[0]).toBeLessThan(fixture.open.mock.invocationCallOrder[0]!)
  })
  it('formats the product-owned protocol and restores an archived Session before opening it', async () => {
    expect(sessionDeepLink(SESSION_ID)).toBe(`dongjian://threads/${SESSION_ID}`)
    const fixture = context({ archived: true })
    const navigate = vi.fn()
    await openDeepLinkedConversation(fixture.ctx, SESSION_ID, navigate)
    expect(fixture.unarchive).toHaveBeenCalledWith(SESSION_ID)
    expect(fixture.open).toHaveBeenCalledWith(SESSION_ID)
    expect(navigate).toHaveBeenCalledWith('assistant')
  })

  it('does not reopen deleted or unknown local Sessions', async () => {
    await expect(openDeepLinkedConversation(context({ deleted: true }).ctx, SESSION_ID, vi.fn()))
      .rejects.toThrow('已删除')
    await expect(openDeepLinkedConversation(context({ present: false }).ctx, SESSION_ID, vi.fn()))
      .rejects.toThrow('不在本机')
  })
})
