// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ComponentProps } from 'react'
import type { ChatSnapshot, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import {
  DeepClarificationControl, DeepClarificationMode, deepClarificationPrompt,
  shouldSuggestDeepClarification,
} from '../src/client/DeepClarificationControl.tsx'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function modeFixture(initial = false) {
  let armed = initial
  let suggestionHandled = false
  const listeners = new Set<() => void>()
  return {
    isDeepClarificationArmed: () => armed,
    subscribeDeepClarification: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setDeepClarificationArmed: vi.fn((next: boolean) => {
      armed = next
      for (const listener of listeners) listener()
    }),
    hasHandledDeepClarificationSuggestion: () => suggestionHandled,
    markDeepClarificationSuggestionHandled: vi.fn(() => { suggestionHandled = true }),
  }
}

function props(
  draft: string,
  mode = modeFixture(),
  locked = false,
  setDraft = vi.fn(),
  submit = vi.fn(),
  promptCount = 0,
): ComponentProps<typeof DeepClarificationControl> {
  const nodes = Array.from({ length: promptCount }, (_, index) => ({
    key: `user:${String(index)}`,
    kind: 'user',
  }))
  const chat = {
    nodes: {
      get: (key: string) => nodes.find(node => node.key === key),
      values: () => nodes,
    },
  } as unknown as ChatSnapshot
  const useChat: UseChat = selector => selector(chat)
  const session = { removed: locked }
  const input = { draft, phase: locked ? 'submitting' : 'plain' }
  return {
    // Keep the fixture on the alpha.4 selector contract so a regression back
    // to whole-snapshot owner props fails here instead of in a packaged app.
    useSession: (selector: (state: typeof session) => unknown) => selector(session),
    useInput: (selector: (state: typeof input) => unknown) => selector(input),
    useChat,
    inputActions: {
      setDraft, addAttachments: vi.fn(), removeAttachment: vi.fn(), pruneAttachments: vi.fn(), submit,
    },
    ...mode,
  } as unknown as ComponentProps<typeof DeepClarificationControl>
}

describe('deep clarification composer control', () => {
  it('arms the next real message without submitting an empty clarification task', async () => {
    const mode = modeFixture()
    const setDraft = vi.fn()
    const submit = vi.fn()
    const value = props('', mode, false, setDraft, submit)
    render(<DeepClarificationControl {...value} />)
    const trigger = screen.getByRole('button', { name: '为下一条消息启用深度澄清' })
    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    expect((await screen.findByRole('tooltip')).textContent).toBe('为下一条任务启用深度澄清')
    fireEvent.click(trigger)

    expect(mode.setDeepClarificationArmed).toHaveBeenCalledWith(true)
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '取消深度澄清' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('深度澄清已开启')).toBeTruthy()
  })

  it('suggests clarification once and lets the user continue normally', async () => {
    const mode = modeFixture()
    const view = render(<DeepClarificationControl {...props('请为这个企业编写一份正式可行性分析报告', mode, false, vi.fn(), vi.fn(), 5)} />)
    const suggestion = await screen.findByRole('region', { name: '深度澄清建议' })
    fireEvent.click(within(suggestion).getByRole('button', { name: '直接继续' }))
    expect(screen.queryByRole('region', { name: '深度澄清建议' })).toBeNull()
    expect(mode.setDeepClarificationArmed).not.toHaveBeenCalled()

    view.rerender(<DeepClarificationControl {...props('请为这个企业编写一份正式可行性分析报告，并增加风险章节', mode, false, vi.fn(), vi.fn(), 6)} />)
    await waitFor(() => { expect(screen.queryByRole('region', { name: '深度澄清建议' })).toBeNull() })
  })

  it('arms an existing draft from the suggestion but waits for the ordinary send action', async () => {
    const task = '设计一个企业申报系统，同时完成开发、测试和正式发布'
    const mode = modeFixture()
    const setDraft = vi.fn()
    const submit = vi.fn()
    const value = props(task, mode, false, setDraft, submit, 5)
    render(<DeepClarificationControl {...value} />)
    const suggestion = await screen.findByRole('region', { name: '深度澄清建议' })
    fireEvent.click(within(suggestion).getByRole('button', { name: '为下一条消息启用' }))

    expect(mode.setDeepClarificationArmed).toHaveBeenCalledWith(true)
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByText('深度澄清已开启')).toBeTruthy()
  })

  it('does not interrupt ordinary questions, chat, rewriting, or a local reversible fix', () => {
    const ordinary = [
      '你好',
      '为什么天空是蓝色的',
      '改写这句话，让它更通顺',
      '修复这个按钮',
      '查一下杭州天气',
      '为什么这份方案不可用',
      '解释这份评估报告',
      '请问这份评估报告什么时候完成？',
      '如果误操作，会不会删除正式报告？',
      '是否会把申请书发送给外部人员？',
      '麻烦问下这个发布计划在哪里看呢？',
    ]
    for (const draft of ordinary) expect(shouldSuggestDeepClarification(draft)).toBe(false)
  })

  it('waits for five prior prompts and consumes the one suggestion when it first appears', async () => {
    const task = '请为这个企业编写一份正式可行性分析报告'
    const mode = modeFixture()
    const view = render(<DeepClarificationControl {...props(task, mode, false, vi.fn(), vi.fn(), 4)} />)
    expect(screen.queryByRole('region', { name: '深度澄清建议' })).toBeNull()

    view.rerender(<DeepClarificationControl {...props(task, mode, false, vi.fn(), vi.fn(), 5)} />)
    expect(await screen.findByRole('region', { name: '深度澄清建议' })).toBeTruthy()
    expect(mode.markDeepClarificationSuggestionHandled).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '直接继续' }))
    view.rerender(<DeepClarificationControl {...props(`${task}，并增加风险章节`, mode, false, vi.fn(), vi.fn(), 6)} />)
    await waitFor(() => { expect(screen.queryByRole('region', { name: '深度澄清建议' })).toBeNull() })
  })

  it('recognizes formal deliverables, multi-step work, and materially ambiguous scope', () => {
    expect(shouldSuggestDeepClarification('请为这家企业编写申报前评估报告')).toBe(true)
    expect(shouldSuggestDeepClarification(
      '先调研现有流程，然后设计改造方案，同时开发、测试并完成验收，最后整理正式发布材料',
    )).toBe(true)
    expect(shouldSuggestDeepClarification('参考现有客户端做一个企业项目管理功能，并完成开发')).toBe(true)
  })

  it('wraps one real task transactionally and keeps the mode armed after a failed send', () => {
    const sessionId = 'session-deep' as SessionId
    const mode = new DeepClarificationMode()
    const listener = vi.fn()
    const unsubscribe = mode.subscribe(sessionId, listener)
    mode.setArmed(sessionId, true)

    expect(mode.prepare(sessionId, '')).toBeUndefined()
    expect(mode.isArmed(sessionId)).toBe(true)
    const first = mode.prepare(sessionId, '开发企业项目评估功能')
    expect(first?.text).toContain('明确启动“深度澄清”')
    expect(first?.text).toContain('开发企业项目评估功能')
    first?.settle('failure')
    expect(mode.isArmed(sessionId)).toBe(true)

    const retry = mode.prepare(sessionId, '开发企业项目评估功能')
    retry?.settle('success')
    expect(mode.isArmed(sessionId)).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('persists the one automatic suggestion across a reconstructed mode', () => {
    const sessionId = 'session-seen' as SessionId
    const first = new DeepClarificationMode()
    first.markSuggestionHandled(sessionId)
    expect(first.hasHandledSuggestion(sessionId)).toBe(true)

    const restored = new DeepClarificationMode()
    expect(restored.hasHandledSuggestion(sessionId)).toBe(true)
  })

  it('writes only a concise explicit activation and refuses a placeholder-only task', () => {
    const prompt = deepClarificationPrompt('开发企业项目评估功能')
    expect(prompt).toContain('明确启动“深度澄清”')
    expect(prompt).toContain('开发企业项目评估功能')
    expect(prompt).toContain('确认共同理解后再继续')
    expect(prompt).not.toContain('按依赖分轮提问')
    expect(prompt).not.toContain('每个问题都给出一个明确的推荐答案')
    expect(prompt).not.toContain('请自行核验')
    expect(prompt).not.toContain('不得修改文件')
    expect(prompt).not.toMatch(/Grill Me|grilling|Skill tool|domain-modeling/u)
    expect(() => deepClarificationPrompt('   ')).toThrow(/下一条真实任务/u)
  })
})
