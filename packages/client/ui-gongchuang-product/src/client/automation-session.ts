import type { SessionFace, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client'
import type {
  AssistantMessageNode, ChatSnapshot, TurnErrorNode, TurnMaxTokensNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'

/** Keep the browser-side completion wait below the Host's 15-minute stale-claim recovery window. */
export const AUTOMATION_COMPLETION_TIMEOUT_MS = 14 * 60 * 1_000
/** Allow the final interrupted/error projection to arrive before accepting a success edge. */
export const AUTOMATION_SUCCESS_SETTLE_MS = 250

/** Terminal result of the ordinary Session turn created for one local automation run. */
export type AutomationTurnOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

/**
 * Resolve a terminal result only from the turn that durably claimed this automation message.
 * A queued message has no turn until the active turn releases it, so unrelated earlier and later
 * turns cannot settle the run.
 * @param session - Session lifecycle and queue snapshot.
 * @param chat - Current Chat target snapshot.
 * @param requestId - Prompt request identity echoed by the durable user source.
 * @returns The automation turn outcome result.
 */
export function automationTurnOutcome(
  session: SessionSnapshot,
  chat: ChatSnapshot | undefined,
  requestId: SessionRequestId,
): AutomationTurnOutcome | null {
  const prompt = chat?.nodes.values().find((node) => {
    if (node.kind !== 'user') return false
    const data = node.data as { readonly source?: { readonly kind?: unknown; readonly rpcId?: unknown } | null }
    const source = data.source
    return source?.kind === 'user' && source.rpcId === requestId
  })
  const turn = prompt?.location.kind === 'turn' || prompt?.location.kind === 'step'
    ? prompt.location.turn.turn
    : null
  if (turn === null) {
    const stillQueued = session.queue.some(message => message.rpcId === requestId)
    // A pre-step policy rejection can remove an admitted queue item before it
    // obtains a turn or durable user node. Session.prompt clears the previous
    // agent error before admission, so this idle, no-longer-queued error edge
    // belongs to the message being awaited rather than an earlier busy turn.
    if (!stillQueued && !session.running && session.lastAgentError !== null) {
      return { ok: false, message: '模型运行在进入会话前被阻止，请检查模型连接或产品策略后重试。' }
    }
    return null
  }
  if (chat === undefined || !chat.legacy.turnEnds.has(turn)) return null
  // Model settlement and business completion are distinct. A stopped draft or
  // pending choice returns control without granting a successful task receipt.
  const location = prompt?.location
  const classification = location?.kind === 'turn' || location?.kind === 'step'
    ? location.turn.data.get('deliverables')?.classification
    : undefined
  if (classification !== undefined && classification.phase !== 'formal') {
    const message = classification.phase === 'waiting-user'
      ? '自动化任务需要补充资料或选择后才能继续，请打开结果会话处理。'
      : classification.phase === 'draft'
        ? '自动化任务已保留待完善结果，尚未完成，请打开结果会话查看缺口。'
        : '自动化任务尚未完成，请打开结果会话查看执行状态。'
    return { ok: false, message: [message, ...classification.issues].join('\n') }
  }
  const turnNodes = chat.legacy.nodes.filter((node): node is AssistantMessageNode | TurnErrorNode | TurnMaxTokensNode => (
    (node.kind === 'assistant' || node.kind === 'turn-error' || node.kind === 'turn-max-tokens')
      && node.turn === turn
  ))

  // Interrupted assistant nodes use a synthetic fractional sequence just before the
  // durable turn boundary. A prior settled assistant step can therefore have a larger
  // sequence even though the turn ultimately stopped. Decide from the whole target
  // turn, not from whichever node happens to sort last by sequence.
  for (const node of turnNodes) {
    if (node.kind === 'turn-error') {
      return { ok: false, message: node.message || '模型运行失败，请检查连接后重试。' }
    }
    if (node.kind === 'turn-max-tokens') {
      return { ok: false, message: '模型回复达到输出上限，请缩小自动化任务范围后重试。' }
    }
    if (node.interrupted) {
      return { ok: false, message: '自动化结果会话在完成前被中断。' }
    }
  }
  if (turnNodes.some(node => node.kind === 'assistant')) return { ok: true }
  return null
}

/** Wait for the result Session to finish, rather than treating prompt admission as task success.
 * @param session - The session value.
 * @param chat - Observable Chat target for the Session.
 * @param requestId - Prompt request identity returned by admission.
 * @param timeoutMs - The timeout ms value.
 * @param successSettleMs - The success settle ms value.
 * @returns The wait for automation turn result.
 */
export function waitForAutomationTurn(
  session: SessionFace,
  chat: ObservableSnapshot<ChatSnapshot | undefined>,
  requestId: SessionRequestId,
  timeoutMs = AUTOMATION_COMPLETION_TIMEOUT_MS,
  successSettleMs = AUTOMATION_SUCCESS_SETTLE_MS,
): Promise<AutomationTurnOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribeSession = (): void => {}
    let unsubscribeChat = (): void => {}
    let successTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (outcome: AutomationTurnOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(successTimer)
      unsubscribeSession()
      unsubscribeChat()
      resolve(outcome)
    }
    const inspect = (): void => {
      const outcome = automationTurnOutcome(session.getSnapshot(), chat.getSnapshot(), requestId)
      if (outcome === null) return
      if (!outcome.ok) {
        finish(outcome)
        return
      }
      if (successTimer !== undefined) return
      successTimer = setTimeout(() => {
        successTimer = undefined
        const stable = automationTurnOutcome(session.getSnapshot(), chat.getSnapshot(), requestId)
        if (stable !== null) finish(stable)
      }, successSettleMs)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, message: '自动化任务在 14 分钟内未完成，已按超时失败记录；结果会话仍保留供检查。' })
    }, timeoutMs)
    unsubscribeSession = session.subscribe(inspect)
    unsubscribeChat = chat.subscribe(inspect)
    inspect()
  })
}
