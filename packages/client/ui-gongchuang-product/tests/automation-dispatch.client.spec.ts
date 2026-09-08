import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AutomationClaim, AutomationRunId, AutomationTaskId, SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import { automationConversation, dispatchAutomation } from '../src/client/automation-dispatch.ts'

const WORKSPACE_ID = 'workspace-automation' as WorkspaceId
const SESSION_ID = 'session-automation' as SessionId
const CLAIM = Object.freeze({
  runId: 'run-00000000-0000-4000-8000-000000000002' as AutomationRunId,
  runToken: 'token',
  taskId: 'automation-00000000-0000-4000-8000-000000000001' as AutomationTaskId,
  taskName: '政策更新监测',
  prompt: '检索政策变化。',
  workspaceId: WORKSPACE_ID,
  conversationSessionId: SESSION_ID,
  scheduledAt: '2026-08-29T01:00:00.000Z',
  manual: false,
}) satisfies AutomationClaim

function context(input: {
  archived?: boolean
  deleted?: boolean
  missing?: boolean
  moved?: boolean
} = {}) {
  const create = vi.fn(async () => 'session-replacement' as SessionId)
  const unarchiveSession = vi.fn(async () => undefined)
  const snapshot = {
    items: [{
      workspaceId: WORKSPACE_ID,
      title: '测试企业',
      path: '/tmp/测试企业',
      // Real Workspace snapshots omit a Session whose persisted header is gone.
      sessionIds: input.moved || input.missing ? [] : [SESSION_ID],
    }],
    archivedSessionIds: input.archived ? [SESSION_ID] : [],
    deletedSessionIds: input.deleted ? [SESSION_ID] : [],
  }
  const ctx = {
    workspaces: { list: { getSnapshot: () => snapshot }, unarchiveSession },
    sessions: {
      create,
      list: { getSnapshot: () => ({ byId: input.missing ? {} : { [SESSION_ID]: {} } }) },
    },
  } as unknown as Context
  return { ctx, create, unarchiveSession }
}

describe('automation dedicated conversation resolution', () => {
  it('does not bypass the Host when the task is deleted between binding and prompt admission', async () => {
    const fixture = context()
    fixture.ctx.sessions.binding = vi.fn(() => ({ session: {} })) as never
    const bind = vi.fn(async () => undefined)
    const admit = vi.fn(async () => { throw new Error('任务正在停止并删除，未发送新消息') })
    const reveal = vi.fn()
    await expect(dispatchAutomation(fixture.ctx, CLAIM, bind, reveal, admit)).rejects.toThrow('未发送新消息')
    expect(bind).toHaveBeenCalledWith(SESSION_ID, undefined)
    expect(admit).toHaveBeenCalledWith(expect.stringContaining(CLAIM.prompt))
    expect(reveal).not.toHaveBeenCalled()
  })

  it('reuses and restores the archived task conversation', async () => {
    const fixture = context({ archived: true })
    await expect(automationConversation(fixture.ctx, CLAIM)).resolves.toEqual({ sessionId: SESSION_ID })
    expect(fixture.unarchiveSession).toHaveBeenCalledWith(SESSION_ID)
    expect(fixture.create).not.toHaveBeenCalled()
  })

  it.each([{ deleted: true }, { missing: true }])(
    'creates a replacement with a compare-and-rebind guard for $deleted$missing',
    async (input) => {
      const fixture = context(input)
      await expect(automationConversation(fixture.ctx, CLAIM)).resolves.toEqual({
        sessionId: 'session-replacement', previousSessionId: SESSION_ID,
      })
      expect(fixture.create).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID })
    },
  )

  it('rebinds without moving history when a legacy conversation belongs to another workspace', async () => {
    const fixture = context({ moved: true })
    await expect(automationConversation(fixture.ctx, CLAIM)).resolves.toEqual({
      sessionId: 'session-replacement', previousSessionId: SESSION_ID,
    })
    expect(fixture.create).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID })
  })
})
