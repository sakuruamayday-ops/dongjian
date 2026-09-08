import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId , createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type { SurfaceEvent } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner, {
  codePointLength,
  DEFAULTS,
  PRUNE_MARKER,
  resolveConfig,
} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type { ToolResultPruneConfig } from '@deepseek-ai/dsh-compaction-tool-result-pruner'

const MODEL = 'test-model'
const SMALL: ToolResultPruneConfig = {
  thresholdChars: 50,
  headChars: 4,
  tailChars: 3,
}

function service(config: ToolResultPruneConfig = SMALL): ToolResultPruner {
  const ctx = new Context()
  // Service constructors self-register, so `ctx.tokenMeter` resolves for the
  // shadow-price pricing without a full plugin boot.
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return new ToolResultPruner(ctx, config)
}

/** Pricing oracle mirroring the service's estimator for expectations. */
const METER_CTX = new Context()
new SessionProjectionRegistry(METER_CTX)
const METER = new TokenMeter(METER_CTX)

function appendToolStep(
  session: Session,
  turn: number,
  call: string,
  content: ContentBlock[],
  extra: Record<string, unknown> = {},
  toolName = 'bash',
  toolArguments = '{}',
): number {
  const callId = ToolCallId(call)
  session.append('turn/start', {
    turn,
  })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: toolName, arguments: toolArguments }],
      source: {
        kind: 'model',
        ...{ provider: MODEL, model: MODEL },
      },
    }),
  }, { surfaceOp: 'append' })
  const callEvent = session.append('tool/call', {
    turn, step: 1, callId, name: toolName, arguments: toolArguments,
  })
  const result = session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content, isError: false }),
    ...extra,
  }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result.seq
}

describe('tool-result pruning configuration', () => {
  it('resolves detached immutable defaults and partial overrides', () => {
    const raw = { thresholdChars: 100, headChars: 20, tailChars: 10 }
    const resolved = resolveConfig(raw)
    raw.headChars = 1
    expect(resolved).toEqual({ thresholdChars: 100, headChars: 20, tailChars: 10 })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(DEFAULTS).toEqual({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
    expect(Object.isFrozen(DEFAULTS)).toBe(true)
  })

  it('rejects stale keys, invalid scalars, and an output budget above threshold', () => {
    const bad = [
      [{ thresholdChars: 0 }, /thresholdChars .* positive integer/],
      [{ headChars: -1 }, /headChars .* non-negative integer/],
      [{ tailChars: 1.5 }, /tailChars .* non-negative integer/],
      [{ thresholdChars: 50, headChars: 20, tailChars: 20 }, /headChars \+ marker \+ tailChars/],
      [{ threshold: 10 }, /unknown key "threshold"/],
    ] as Array<[unknown, RegExp]>
    for (const [config, pattern] of bad) {
      expect(() => resolveConfig(config as ToolResultPruneConfig)).toThrow(pattern)
    }
  })
})

describe('ToolResultPruner content transform', () => {
  it('measures text code points only and skips content within threshold', () => {
    const prune = service()
    const blocks = [
      { type: 'text', text: 'a😀b' },
      { type: 'reasoning', text: 'not measured' },
    ] satisfies ContentBlock[]
    expect(prune.measureContent(blocks)).toBe(3)
    expect(prune.pruneContent(blocks)).toBeNull()
    expect(codePointLength('a😀b')).toBe(3)
  })

  it('keeps configured head and tail without splitting surrogate pairs', () => {
    const prune = service()
    const result = prune.pruneContent([{ type: 'text', text: '😀'.repeat(60) }])
    expect(result).toEqual([{
      type: 'text',
      text: `${'😀'.repeat(4)}${PRUNE_MARKER}${'😀'.repeat(3)}`,
    }])
    expect(prune.measureContent(result!)).toBeLessThanOrEqual(50)
    expect(result![0]).toMatchObject({ type: 'text' })
    expect((result![0] as { text: string }).text).not.toContain('\uFFFD')
  })

  it('preserves non-text blocks and their relative ordering across removed text', () => {
    const prune = service()
    const reasoning: ContentBlock = { type: 'reasoning', text: 'private-rich-block' }
    const call: ContentBlock = {
      type: 'tool-call',
      id: ToolCallId('nested'),
      name: 'nested',
      arguments: '{}',
    }
    const result = prune.pruneContent([
      { type: 'text', text: 'A'.repeat(40) },
      reasoning,
      { type: 'text', text: 'B'.repeat(30) },
      call,
      { type: 'text', text: 'C'.repeat(30) },
    ])
    expect(result).toEqual([
      { type: 'text', text: `AAAA${PRUNE_MARKER}` },
      reasoning,
      call,
      { type: 'text', text: 'CCC' },
    ])
    expect(prune.measureContent(result!)).toBeLessThanOrEqual(50)
  })

  it('supports zero-sized head and tail while still shrinking', () => {
    const prune = service({
      thresholdChars: codePointLength(PRUNE_MARKER),
      headChars: 0,
      tailChars: 0,
    })
    const result = prune.pruneContent([{ type: 'text', text: 'x'.repeat(100) }])
    expect(result).toEqual([{ type: 'text', text: PRUNE_MARKER }])
    expect(prune.measureContent(result!)).toBe(prune.config.thresholdChars)
  })
})

describe('ToolResultPruner session transaction', () => {
  it('marks a skill result that crosses the default 8192-character threshold', () => {
    const session = Session.create(SessionId('default-skill-threshold'))
    appendToolStep(
      session,
      1,
      'default-long-skill',
      [{ type: 'text', text: `<skill_content name="formal-skill">${'x'.repeat(9_000)}</skill_content>` }],
      {},
      'skill',
      JSON.stringify({ name: 'formal-skill' }),
    )
    session.append('turn/start', { turn: 2 })
    const prune = service(DEFAULTS)

    const outcome = prune.pruneSession(session)
    const message = session.deriveMessages().find(candidate => candidate.role === 'user'
      && candidate.content.some(block => block.type === 'tool-result'
        && block.toolCallId === ToolCallId('default-long-skill')))
    const text = message?.content[0]?.type === 'tool-result'
      ? message.content[0].content.find(block => block.type === 'text')?.text
      : undefined

    expect(outcome.pruned).toHaveLength(1)
    expect(text).toContain('<skill-result-pruned reload="available">')
    expect(codePointLength(text ?? '')).toBeLessThanOrEqual(DEFAULTS.thresholdChars)
  })

  it('offers one exact skill reload and stops repeated recovery in the same human turn', () => {
    const session = Session.create(SessionId('skill-recovery'))
    const skillArgs = JSON.stringify({ name: 'long-skill' })
    appendToolStep(
      session,
      1,
      'skill-first',
      [{ type: 'text', text: `<skill_content name="long-skill">${'A'.repeat(900)}</skill_content>` }],
      {},
      'skill',
      skillArgs,
    )
    session.append('turn/start', { turn: 2 })
    const prune = service({ thresholdChars: 500, headChars: 100, tailChars: 50 })

    prune.pruneSession(session)
    const first = session.deriveMessages().find(message => message.role === 'user'
      && message.content.some(block => block.type === 'tool-result'
        && block.toolCallId === ToolCallId('skill-first')))
    const firstText = first?.content[0]?.type === 'tool-result'
      ? first.content[0].content.find(block => block.type === 'text')?.text
      : undefined
    expect(firstText).toContain('<skill-result-pruned reload="available">')
    expect(firstText).toContain('call the `skill` tool once more with {"name":"long-skill"}')
    expect(firstText).toContain('Do not reload automatically or more than once')

    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    appendToolStep(
      session,
      3,
      'skill-reload',
      [{ type: 'text', text: `<skill_content name="long-skill">${'B'.repeat(900)}</skill_content>` }],
      {},
      'skill',
      skillArgs,
    )
    session.append('turn/start', { turn: 4 })

    prune.pruneSession(session)
    const second = session.deriveMessages().find(message => message.role === 'user'
      && message.content.some(block => block.type === 'tool-result'
        && block.toolCallId === ToolCallId('skill-reload')))
    const secondText = second?.content[0]?.type === 'tool-result'
      ? second.content[0].content.find(block => block.type === 'text')?.text
      : undefined
    expect(secondText).toContain('<skill-result-pruned reload="used">')
    expect(secondText).toContain('do not call the `skill` tool again solely because of this marker')
    const availableNotices = session.deriveMessages().flatMap(message => message.content)
      .flatMap(block => block.type === 'tool-result' ? block.content : [])
      .filter(block => block.type === 'text' && block.text.includes('reload="available"'))
    expect(availableNotices).toHaveLength(1)

    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Start a new task with the same skill.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    appendToolStep(
      session,
      5,
      'skill-next-task',
      [{ type: 'text', text: `<skill_content name="long-skill">${'C'.repeat(900)}</skill_content>` }],
      {},
      'skill',
      skillArgs,
    )
    session.append('turn/start', { turn: 6 })

    prune.pruneSession(session)
    const third = session.deriveMessages().find(message => message.role === 'user'
      && message.content.some(block => block.type === 'tool-result'
        && block.toolCallId === ToolCallId('skill-next-task')))
    const thirdText = third?.content[0]?.type === 'tool-result'
      ? third.content[0].content.find(block => block.type === 'text')?.text
      : undefined
    expect(thirdText).toContain('<skill-result-pruned reload="available">')
  })

  it('keeps ordinary tool output on the generic marker even when its text resembles a skill', () => {
    const session = Session.create(SessionId('ordinary-marker'))
    appendToolStep(session, 1, 'ordinary', [{
      type: 'text',
      text: `<skill_content name="lookalike">${'x'.repeat(900)}</skill_content>`,
    }])
    session.append('turn/start', { turn: 2 })

    service({ thresholdChars: 200, headChars: 40, tailChars: 20 }).pruneSession(session)

    const message = session.deriveMessages().find(candidate => candidate.role === 'user'
      && candidate.content.some(block => block.type === 'tool-result'
        && block.toolCallId === ToolCallId('ordinary')))
    const text = message?.content[0]?.type === 'tool-result'
      ? message.content[0].content.find(block => block.type === 'text')?.text
      : undefined
    expect(text).toContain(PRUNE_MARKER)
    expect(text).not.toContain('<skill-result-pruned')
    expect(text).not.toContain('call the `skill` tool')
  })

  it('prunes a stable snapshot, preserves all data, and cites the replaced result', () => {
    const session = Session.create(SessionId('preserve'))
    const originalSeq = appendToolStep(session, 1, 'one', [{
      type: 'text',
      text: 'x'.repeat(100),
    }], {
      isError: true,
      error: { name: 'ExitError', code: 'EXIT_1' },
      meta: { diff: ['a', 'b'] },
      futureField: { nested: true },
    })
    session.append('turn/start', {
      turn: 2,
    })

    const result = service().pruneSession(session)
    expect(result.pruned).toHaveLength(1)
    expect(result.charsRemoved).toBeGreaterThan(0)
    const entry = result.pruned[0]!
    expect(entry).toMatchObject({ originalSeq, callId: ToolCallId('one'), charsBefore: 100 })
    expect(entry.charsAfter).toBeLessThanOrEqual(50)

    const original = session.snapshotEvents()[originalSeq]!
    const replacement = session.snapshotEvents()[entry.replacementSeq]! as SurfaceEvent
    expect(original).toMatchObject({
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            content: [{ type: 'text', text: 'x'.repeat(100) }],
          }],
        },
      },
    })
    expect(replacement).toMatchObject({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        isError: true,
        message: {
          source: { kind: 'tool', callId: ToolCallId('one') },
        },
        error: { name: 'ExitError', code: 'EXIT_1' },
        meta: { diff: ['a', 'b'] },
        futureField: { nested: true },
      },
      surfaceOp: { op: 'replace', start: originalSeq, end: originalSeq },
      sourceEventSeqs: [originalSeq],
    })
    expect(session.surface.nodes).not.toContain(originalSeq)

    // Shadow-price protocol: the metering event sits directly before the
    // replacement and prices the shadowed node with the shared estimator.
    if (original.type !== 'tool/result') throw new Error('original is not a tool/result')
    expect(session.snapshotEvents()[entry.replacementSeq - 1]).toMatchObject({
      type: 'compaction/prune',
      data: {
        shadowedRange: { start: originalSeq, end: originalSeq },
        shadowedSeqs: [originalSeq],
        shadowedTokenCount: METER.estimateMessage(original.data.message),
      },
    })
  })

  it('prunes multiple results, skips short ones, and converges in one pass', () => {
    const session = Session.create(SessionId('multiple'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(100) }])
    appendToolStep(session, 2, 'b', [{ type: 'text', text: 'short' }])
    appendToolStep(session, 3, 'c', [{ type: 'text', text: 'C'.repeat(80) }])
    session.append('turn/start', {
      turn: 4,
    })
    const prune = service()
    const first = prune.pruneSession(session)
    const second = prune.pruneSession(session)
    expect(first.pruned.map(entry => entry.callId)).toEqual([ToolCallId('a'), ToolCallId('c')])
    expect(first.charsRemoved).toBe(
      first.pruned.reduce((sum, entry) => sum + entry.charsBefore - entry.charsAfter, 0),
    )
    expect(second).toEqual({ pruned: [], charsRemoved: 0 })
  })

  it('replays to the identical pruned model messages', () => {
    const session = Session.create(SessionId('replay'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(100) }])
    session.append('turn/start', {
      turn: 2,
    })
    service().pruneSession(session)
    const replay = Session.create(session.id, session.snapshotEvents())
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
    expect(replay.surface.replaceGeneration).toBe(session.surface.replaceGeneration)
  })

  it('runs under real invariants between closed steps but not outside a turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SessionInvariant)
    await ctx.plugin(TokenMeter)
    const prune = new ToolResultPruner(ctx, SMALL)
    const session = ctx.sessions.create(SessionId('invariants'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(100) }])
    expect(() => prune.pruneSession(session)).toThrow(/outside any open turn/)
    session.append('turn/start', {
      turn: 2,
    })
    expect(() => prune.pruneSession(session)).not.toThrow()
  })
})
