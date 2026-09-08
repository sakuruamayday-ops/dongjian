import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ConversationPromptPreparation, PreparedConversationPrompt,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconThinkOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './DeepClarificationControl.module.css'

const FORMAL_DELIVERABLE = /(?:报告|申报书|申请书|方案|规划|产品文档|施工清单|评估|审计|可行性分析|技术路线|架构设计|验收标准|发布计划|正式交付)/u
const COMPLEX_ACTION = /(?:设计|开发|实现|改造|迁移|发布|部署|评估|分析|调研|检索|核验|测试|验收|生成|撰写|整理|规划|排查|修复)/gu
const COMPLEX_LINK = /(?:并且|同时|然后|之后|以及|还要|还需要|一并|全量|端到端|从.+到|先.+再)/u
const AMBIGUOUS_SCOPE = /(?:做一个|做套|开发一个|设计一个|弄一个|优化一下|完善一下|整体改|全部处理|都做完|按之前|参考.+实现)/u
const DELIVERABLE_ACTION = /(?:编写|撰写|起草|生成|出具|制作|形成|完成|提交|发布|交付|做一|写一|出一)/u
const SIMPLE_TASK = /^(?:你好|您好|谢谢|在吗|继续|重试|翻译|润色|改写|总结|解释|是什么|为什么|怎么做|怎么用|查一下|搜一下|打开|关闭|复制|粘贴|删除|移动|重命名|修复)(?:[\s\S]{0,18})$/u
const INFORMATIONAL_QUESTION = /^(?:(?:请问|想问(?:一下)?|麻烦问下|劳驾问下).*[？?]|(?:如果|万一|是否|会不会|有没有可能).*(?:删除|发布|提交|发送|覆盖|泄露|丢失|损坏).*[？?])$/u
const SUGGESTION_STORAGE_KEY = 'gongchuang.deep-clarification.suggested.v1'
const SUGGESTION_PROMPT_THRESHOLD = 5

function readHandledSuggestions(): Set<SessionId> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const value = JSON.parse(localStorage.getItem(SUGGESTION_STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(value)) return new Set()
    return new Set(value.filter((entry): entry is SessionId => typeof entry === 'string'))
  } catch {
    return new Set()
  }
}

function writeHandledSuggestions(sessionIds: ReadonlySet<SessionId>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SUGGESTION_STORAGE_KEY, JSON.stringify([...sessionIds]))
  } catch {
    // A disabled or full browser store must not block ordinary conversation.
  }
}

/** Concise explicit activation wrapped around the next real user task. */
export function deepClarificationPrompt(task: string): string {
  const currentTask = task.trim()
  if (currentTask === '') throw new Error('深度澄清需要随下一条真实任务启动')
  return `请明确启动“深度澄清”，在当前会话中澄清这项任务，并在我确认共同理解后再继续：\n${currentTask}`
}

/** Decide whether a draft merits the conversation's sole optional clarification suggestion. */
export function shouldSuggestDeepClarification(text: string): boolean {
  const draft = text.trim()
  if (draft.length < 6 || SIMPLE_TASK.test(draft) || INFORMATIONAL_QUESTION.test(draft)) return false
  const actionCount = new Set(draft.match(COMPLEX_ACTION) ?? []).size
  if (FORMAL_DELIVERABLE.test(draft) && DELIVERABLE_ACTION.test(draft)) return true
  if (draft.length >= 48 && actionCount >= 2 && COMPLEX_LINK.test(draft)) return true
  return draft.length >= 24 && AMBIGUOUS_SCOPE.test(draft) && (actionCount >= 1 || COMPLEX_LINK.test(draft))
}

export interface DeepClarificationInjected {
  /** Read whether the next ordinary send is armed for deep clarification. */
  isDeepClarificationArmed: () => boolean
  /** Subscribe to one-shot arming changes for the addressed conversation. */
  subscribeDeepClarification: (listener: () => void) => () => void
  /** Arm or cancel deep clarification for the next ordinary send. */
  setDeepClarificationArmed: (armed: boolean) => void
  /** Whether this conversation has already received its one suggestion. */
  hasHandledDeepClarificationSuggestion: () => boolean
  /** Permanently consume this conversation's sole automatic suggestion. */
  markDeepClarificationSuggestionHandled: () => void
}

export type DeepClarificationControlProps =
  PropsRuntime<'conversation.input.left'> & DeepClarificationInjected

/** In-memory, per-session one-shot state consumed only after a successful real send. */
export class DeepClarificationMode implements ConversationPromptPreparation {
  private readonly armed = new Set<SessionId>()
  private readonly listeners = new Map<SessionId, Set<() => void>>()
  private readonly handledSuggestions = readHandledSuggestions()

  /**
   * Read one session's pending mode.
   * @param sessionId - Session whose next ordinary message may be prepared.
   * @returns Whether deep clarification is armed for that session.
   */
  isArmed(sessionId: SessionId): boolean {
    return this.armed.has(sessionId)
  }

  /**
   * Arm or cancel the next real message without creating a conversation turn.
   * @param sessionId - Session whose one-shot mode changes.
   * @param armed - Whether the next real message should start deep clarification.
   */
  setArmed(sessionId: SessionId, armed: boolean): void {
    if (armed === this.armed.has(sessionId)) return
    if (armed) this.armed.add(sessionId)
    else this.armed.delete(sessionId)
    for (const listener of this.listeners.get(sessionId) ?? []) listener()
  }

  /**
   * Subscribe one mounted composer control to its own session state.
   * @param sessionId - Session observed by the mounted control.
   * @param listener - Callback invoked when that session's armed state changes.
   * @returns A disposer that removes the callback.
   */
  subscribe(sessionId: SessionId, listener: () => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sessionId)
    }
  }

  /** Return whether the session has already consumed its sole automatic suggestion. */
  hasHandledSuggestion(sessionId: SessionId): boolean {
    return this.handledSuggestions.has(sessionId)
  }

  /** Persist the fact that this session has already been shown an automatic suggestion. */
  markSuggestionHandled(sessionId: SessionId): void {
    if (this.handledSuggestions.has(sessionId)) return
    this.handledSuggestions.add(sessionId)
    writeHandledSuggestions(this.handledSuggestions)
  }

  /**
   * Prepare the next non-empty draft and consume the mode only on success.
   * @param sessionId - Session submitting the ordinary message.
   * @param text - User-authored non-empty task.
   * @returns The wrapped task while armed, otherwise undefined.
   */
  prepare(sessionId: SessionId, text: string): PreparedConversationPrompt | undefined {
    if (!this.armed.has(sessionId) || text.trim() === '') return undefined
    return {
      text: deepClarificationPrompt(text),
      settle: (outcome) => {
        if (outcome === 'success') this.setArmed(sessionId, false)
      },
    }
  }
}

/** Explicit entry plus one optional suggestion after five prior prompts in the session. */
export function DeepClarificationControl({
  useSession, useInput, useChat, isDeepClarificationArmed, subscribeDeepClarification,
  setDeepClarificationArmed, hasHandledDeepClarificationSuggestion,
  markDeepClarificationSuggestionHandled,
}: DeepClarificationControlProps) {
  // DSH alpha.4 keeps composer children subscribed through selectors so only
  // the fields they read can trigger a render; do not restore snapshot props.
  const removed = useSession(state => state.removed)
  const input = useInput(state => state)
  const [suggestionOpen, setSuggestionOpen] = useState(false)
  const armed = useSyncExternalStore(
    subscribeDeepClarification,
    isDeepClarificationArmed,
    isDeepClarificationArmed,
  )
  const locked = removed || input.phase !== 'plain'
  const userPromptCount = useChat(snapshot => [...snapshot.nodes.values()]
    .filter(node => node.kind === 'user').length)

  useEffect(() => {
    const draft = input.draft.trim()
    if (draft === '') {
      setSuggestionOpen(false)
      return
    }
    if (armed || locked || hasHandledDeepClarificationSuggestion()) return
    if (userPromptCount < SUGGESTION_PROMPT_THRESHOLD) return
    if (!shouldSuggestDeepClarification(draft)) return
    markDeepClarificationSuggestionHandled()
    setSuggestionOpen(true)
  }, [
    armed, hasHandledDeepClarificationSuggestion, input.draft, locked,
    markDeepClarificationSuggestionHandled, userPromptCount,
  ])

  const toggle = (): void => {
    if (locked) return
    setSuggestionOpen(false)
    setDeepClarificationArmed(!armed)
  }

  return (
    <span className={css.control}>
      <Tooltip
        label={armed ? '下一条消息将先进入深度澄清；再次点击可取消' : '为下一条任务启用深度澄清'}
        side="top"
        delayMs={400}
      >
        <button
          type="button"
          className={css.trigger}
          data-armed={armed ? '' : undefined}
          aria-label={armed ? '取消深度澄清' : '为下一条消息启用深度澄清'}
          aria-pressed={armed}
          disabled={locked}
          onClick={toggle}
        >
          <IconThinkOutline16 size={16} />
          <span>{armed ? '深度澄清已开启' : '深度澄清'}</span>
        </button>
      </Tooltip>
      {suggestionOpen && (
        <span className={css.suggestion} role="region" aria-label="深度澄清建议">
          <strong>这项任务可能需要先厘清关键决策</strong>
          <span>先确认目标、范围与验收标准，可以减少返工。</span>
          <span className={css.actions}>
            <button type="button" className={css.secondary} onClick={() => { setSuggestionOpen(false) }}>
              直接继续
            </button>
            <button type="button" className={css.primary} onClick={() => {
              setSuggestionOpen(false)
              setDeepClarificationArmed(true)
            }}>
              为下一条消息启用
            </button>
          </span>
        </span>
      )}
    </span>
  )
}
