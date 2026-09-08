import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { copyWorkspaceSession } from '../src/client/index.ts'

const WORKSPACE_ID = 'enterprise-a' as WorkspaceId
const SESSION_ID = 'source-session' as SessionId
const CHILD_ID = 'copied-session' as SessionId

function context(options: { listed?: boolean; attached?: boolean } = {}) {
  const listed = options.listed ?? true
  const attached = options.attached ?? true
  const fork = vi.fn(async () => CHILD_ID)
  const open = vi.fn()
  const ctx = {
    workspaces: {
      list: {
        getSnapshot: () => ({
          items: [{
            workspaceId: WORKSPACE_ID,
            sessionIds: attached ? [SESSION_ID] : [],
          }],
        }),
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ byId: listed ? { [SESSION_ID]: {} } : {} }) },
      fork,
      open,
    },
  } as unknown as Pick<Context, 'sessions' | 'workspaces'>
  return { ctx, fork, open }
}

describe('企业空间复制对话', () => {
  it('forks with an increased title and opens the copy in the assistant', async () => {
    const b = context()
    const navigate = vi.fn()

    await copyWorkspaceSession(b.ctx, WORKSPACE_ID, SESSION_ID, navigate)

    expect(b.fork).toHaveBeenCalledWith({ sessionId: SESSION_ID, increaseTitle: true })
    expect(b.open).toHaveBeenCalledWith(CHILD_ID)
    expect(navigate).toHaveBeenCalledWith('assistant')
  })

  it('does not copy a task outside the selected enterprise workspace', async () => {
    const b = context({ attached: false })

    await expect(copyWorkspaceSession(b.ctx, WORKSPACE_ID, SESSION_ID, vi.fn()))
      .rejects.toThrow('该任务已不属于当前企业空间，请刷新后重试。')
    expect(b.fork).not.toHaveBeenCalled()
  })

  it('does not copy a task missing from the local session list', async () => {
    const b = context({ listed: false })

    await expect(copyWorkspaceSession(b.ctx, WORKSPACE_ID, SESSION_ID, vi.fn()))
      .rejects.toThrow('该任务会话已不在本机会话列表中。')
    expect(b.fork).not.toHaveBeenCalled()
  })
})
