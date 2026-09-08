import { describe, expect, it } from 'vitest'
import type { SessionFace, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { automationTurnOutcome, waitForAutomationTurn } from '../src/client/automation-session.ts'

const AUTOMATION_REQUEST_ID = 'request-automation' as SessionRequestId

interface AutomationFixture {
  readonly session: SessionSnapshot
  readonly chat: ChatSnapshot
}

function snapshot(input: {
  lastAgentError?: string | null
  queuedRequestIds?: readonly SessionRequestId[]
  running?: boolean
  nodes?: readonly Record<string, unknown>[]
  endedTurns?: readonly number[]
  delivery?: { turn: number; phase: string; issues: string[] }
} = {}): AutomationFixture {
  const legacyNodes = input.nodes ?? []
  const chatNodes = legacyNodes.flatMap((node, index) => {
    if (node.kind !== 'user' || typeof node.turn !== 'number') return []
    return [{
      key: `user:${String(index)}`,
      kind: 'user',
      data: node,
      location: { kind: 'turn', turn: { turn: node.turn, data: {
        get: () => input.delivery === undefined ? undefined : { classification: input.delivery },
      } } },
    }]
  })
  const session = {
    sessionId: 'automation-session',
    running: input.running ?? false,
    queue: (input.queuedRequestIds ?? []).map((requestId, index) => ({
      id: `queued-${String(index)}`,
      messageId: `queued-${String(index)}`,
      placement: 'queued',
      rpcId: requestId,
      content: [],
      preview: '',
      text: null,
    })),
    lastAgentError: input.lastAgentError ?? null,
  } as unknown as SessionSnapshot
  const chat = {
    nodes: {
      get: (key: string) => chatNodes.find(node => node.key === key),
      values: () => chatNodes,
    },
    legacy: {
      nodes: legacyNodes,
      turnEnds: new Map((input.endedTurns ?? []).map(turn => [turn, turn * 100])),
    },
  } as unknown as ChatSnapshot
  return { session, chat }
}

function user(requestId: SessionRequestId, turn: number, seq: number) {
  return {
    kind: 'user', turn, seq, time: seq, content: [],
    source: { kind: 'user', rpcId: requestId },
  }
}

function assistant(turn: number, seq: number, interrupted = false) {
  return { kind: 'assistant', turn, step: 1, seq, time: seq, blocks: [], ...(interrupted ? { interrupted: true } : {}) }
}

function observable(initial: AutomationFixture) {
  let current = initial
  const sessionListeners = new Set<() => void>()
  const chatListeners = new Set<() => void>()
  const session = {
    getSnapshot: () => current.session,
    subscribe: (listener: () => void) => {
      sessionListeners.add(listener)
      return () => { sessionListeners.delete(listener) }
    },
  } as unknown as SessionFace
  const chat = {
    getSnapshot: () => current.chat,
    subscribe: (listener: () => void) => {
      chatListeners.add(listener)
      return () => { chatListeners.delete(listener) }
    },
  } as ObservableSnapshot<ChatSnapshot | undefined>
  return {
    session, chat,
    publish(next: AutomationFixture) {
      current = next
      for (const listener of [...sessionListeners]) listener()
      for (const listener of [...chatListeners]) listener()
    },
  }
}

function outcome(input: Parameters<typeof snapshot>[0]) {
  const current = snapshot(input)
  return automationTurnOutcome(current.session, current.chat, AUTOMATION_REQUEST_ID)
}

describe('automation result Session settlement', () => {
  it.each(['waiting-user', 'draft', 'failed', 'paused'])('does not report %s delivery as completed', (phase) => {
    expect(outcome({ nodes: [user(AUTOMATION_REQUEST_ID, 1, 1), assistant(1, 2)], endedTurns: [1],
      delivery: { turn: 1, phase, issues: ['请补充材料'] },
    })).toMatchObject({ ok: false, message: expect.stringContaining('请补充材料') })
  })

  it('accepts a formally completed business result', () => {
    expect(outcome({ nodes: [user(AUTOMATION_REQUEST_ID, 1, 1), assistant(1, 2)], endedTurns: [1],
      delivery: { turn: 1, phase: 'formal', issues: [] },
    })).toEqual({ ok: true })
  })
  it('does not settle before the admitted message is claimed into a turn', () => {
    expect(outcome({
      nodes: [{ kind: 'turn-error', seq: 9, turn: 1, step: 1, message: '先前轮次失败' }],
      endedTurns: [1],
    })).toBeNull()
  })

  it('settles a pre-step policy rejection after the admitted message leaves the queue without a turn', () => {
    expect(outcome({
      lastAgentError: 'provider is not allowed by signed policy',
    })).toEqual({
      ok: false,
      message: '模型运行在进入会话前被阻止，请检查模型连接或产品策略后重试。',
    })
    expect(outcome({
      lastAgentError: '先前活动轮次失败',
      queuedRequestIds: [AUTOMATION_REQUEST_ID],
    })).toBeNull()
  })

  it('ignores a busy conversation previous-turn failure and follows the automation message turn', async () => {
    const source = observable(snapshot({ running: true }))
    const pending = waitForAutomationTurn(source.session, source.chat, AUTOMATION_REQUEST_ID, 1_000, 0)
    source.publish(snapshot({
      nodes: [{ kind: 'turn-error', seq: 9, turn: 1, step: 1, message: '先前用户轮次失败' }],
      endedTurns: [1],
    }))
    source.publish(snapshot({
      running: true,
      nodes: [
        { kind: 'turn-error', seq: 9, turn: 1, step: 1, message: '先前用户轮次失败' },
        user(AUTOMATION_REQUEST_ID, 2, 11),
        assistant(2, 15),
      ],
      endedTurns: [1, 2],
    }))
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it('does not attribute a later user turn to the automation run', () => {
    expect(outcome({
      nodes: [
        user(AUTOMATION_REQUEST_ID, 2, 11),
        assistant(2, 15),
        user('request-later' as SessionRequestId, 3, 20),
        { kind: 'turn-error', seq: 25, turn: 3, step: 1, message: '后续用户轮次失败' },
      ],
      endedTurns: [2, 3],
    })).toEqual({ ok: true })
  })

  it('returns the target turn model error instead of a successful dispatch receipt', () => {
    expect(outcome({
      nodes: [
        user(AUTOMATION_REQUEST_ID, 4, 7),
        { kind: 'turn-error', seq: 9, turn: 4, step: 1, message: '模型连接失败' },
      ],
      endedTurns: [4],
    })).toEqual({ ok: false, message: '模型连接失败' })
  })

  it('fails when the target turn contains an interrupted assistant projection', () => {
    expect(outcome({
      nodes: [
        user(AUTOMATION_REQUEST_ID, 2, 4),
        assistant(2, 12),
        assistant(2, 11.1, true),
      ],
      endedTurns: [2],
    })).toEqual({ ok: false, message: '自动化结果会话在完成前被中断。' })
  })

  it('fails closed when the admitted message never reaches a terminal turn', async () => {
    const source = observable(snapshot({ running: true }))
    await expect(waitForAutomationTurn(source.session, source.chat, AUTOMATION_REQUEST_ID, 5))
      .resolves.toMatchObject({ ok: false })
  })
})
