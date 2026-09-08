import type { Context } from '@deepseek-ai/cordis'
import type { AutomationClaim, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { AutomationDispatchError, type AutomationMessageDispatcher, type AutomationSessionBinder } from './automations.ts'
import { buildAutomationDispatchMessage } from './automation-message.ts'
import { waitForAutomationTurn } from './automation-session.ts'
import {
  CONCRETE_ENTERPRISE_WORKSPACE_REQUIRED, isConcreteEnterpriseWorkspacePath,
} from './enterprise-workspace.ts'

interface AutomationConversation {
  readonly sessionId: SessionId
  readonly previousSessionId?: string
}

/**
 * Resolve the durable conversation owned by one automation task.
 * @param ctx - Product context containing current Session and Workspace projections.
 * @param claim - Host claim whose binding may need unarchive or atomic replacement.
 * @returns The usable Session and, when replaced, the binding that must win the CAS.
 */
export async function automationConversation(ctx: Context, claim: AutomationClaim): Promise<AutomationConversation> {
  const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === claim.workspaceId)
  if (workspace === undefined) throw new Error('任务绑定的企业空间已不可用，请重新创建任务。')
  if (!isConcreteEnterpriseWorkspacePath(workspace.path)) {
    throw new Error(`自动化任务未执行：${CONCRETE_ENTERPRISE_WORKSPACE_REQUIRED}`)
  }
  if (claim.conversationSessionId === null) {
    // A dedicated Session prevents concurrent first runs from racing into the
    // same generic blank workspace draft before either prompt marks it active.
    return { sessionId: await ctx.sessions.create({ workspaceId: workspace.workspaceId }) }
  }
  const sessionId = claim.conversationSessionId as SessionId
  const management = ctx.workspaces.list.getSnapshot()
  if (management.deletedSessionIds.includes(sessionId)) {
    return {
      sessionId: await ctx.sessions.create({ workspaceId: workspace.workspaceId }),
      previousSessionId: sessionId,
    }
  }
  if (ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) {
    // A missing persisted Session is also filtered out of Workspace.sessionIds.
    // Resolve absence before checking workspace membership so deletion/recovery
    // can create and CAS-rebind a replacement instead of reporting a false move.
    return {
      sessionId: await ctx.sessions.create({ workspaceId: workspace.workspaceId }),
      previousSessionId: sessionId,
    }
  }
  if (!workspace.sessionIds.includes(sessionId)) {
    // Legacy registries could retain the last run's Session after a task was
    // edited to another Workspace. Rebind instead of making that valid upgrade
    // state permanently un-runnable or moving the old Workspace's history.
    return {
      sessionId: await ctx.sessions.create({ workspaceId: workspace.workspaceId }),
      previousSessionId: sessionId,
    }
  }
  if (management.archivedSessionIds.includes(sessionId)) {
    await ctx.workspaces.unarchiveSession(sessionId)
  }
  return { sessionId }
}

/**
 * Append one claimed automation run to its dedicated conversation and reveal it.
 * @param ctx - Product client context with Session and Workspace runtimes.
 * @param claim - Authenticated Host claim carrying any existing conversation binding.
 * @param bindSession - Persists the selected conversation before prompt admission.
 * @param reveal - Opens the conversation and returns the shell to the assistant page.
 * @param admitMessage - Host-serialized prompt admission that cannot run after task deletion.
 * @returns Terminal success receipt for the Host run registry.
 */
export async function dispatchAutomation(
  ctx: Context,
  claim: AutomationClaim,
  bindSession: AutomationSessionBinder,
  reveal: (sessionId: SessionId) => void,
  admitMessage: AutomationMessageDispatcher,
): Promise<{ message: string; sessionId: string }> {
  const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === claim.workspaceId)
  if (workspace === undefined) throw new Error('任务绑定的企业空间已不可用，请重新创建任务。')
  const { sessionId, previousSessionId } = await automationConversation(ctx, claim)
  let bound = false
  try {
    await bindSession(sessionId, previousSessionId)
    bound = true
    const session = ctx.sessions.binding(sessionId)?.session
    if (session === undefined) throw new Error('企业空间结果会话尚未就绪。')
    const requestId = await admitMessage(buildAutomationDispatchMessage(claim))
    reveal(sessionId)
    const chat = ctx.uiConversation.binding(sessionId).target('chat')
    const outcome = await waitForAutomationTurn(session, chat, requestId)
    if (!outcome.ok) throw new Error(`自动化任务执行失败：${outcome.message}`)
  } catch (error) {
    if (bound) throw new AutomationDispatchError(error, sessionId)
    throw error
  }
  return { message: `已完成，结果已保存到企业空间 ${workspace.title}`, sessionId }
}
