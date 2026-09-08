import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { localCostDayKey } from '@deepseek-ai/dsh-token-meter/client'
import type { ModelCostProjection } from '@deepseek-ai/dsh-token-meter/client'

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return { ctx, session: ctx.sessions.create() }
}

function usageAttempt(session: Session, turn: number, step: number, usage: TokenUsage): void {
  session.append('assistant/attempt', {
    turn,
    step,
    stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
  })
}

function finalUsage(
  session: Session,
  turn: number,
  step: number,
  usage: TokenUsage,
): void {
  session.append('assistant/message', {
    stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
    usage,
  }, { surfaceOp: 'append' })
}

function projected(ctx: Context, session: Session): ModelCostProjection {
  const value = ctx.sessionProjections.snapshot(session).values.modelCost
  if (value === undefined) throw new Error('modelCost projection is not registered')
  return value
}

describe('modelCost session projection', () => {
  it('serves an empty durable estimate before any provider usage', async () => {
    const { ctx, session } = await harness()
    expect(projected(ctx, session)).toEqual({
      estimatedCostUsd: 0,
      pricedRequests: 0,
      unpricedRequests: 0,
      byDay: {},
    })
  })

  it('replaces one step sample and separates priced, free, and unpriced requests', async () => {
    const { ctx, session } = await harness()
    session.append('step/start', { turn: 1, step: 1 })
    usageAttempt(session, 1, 1, {
      inputTokens: 100,
      outputTokens: 20,
      estimatedCostUsd: 0.01,
    })
    finalUsage(session, 1, 1, {
      inputTokens: 120,
      outputTokens: 30,
      estimatedCostUsd: 0.0125,
    })
    session.append('step/end', { turn: 1, step: 1 })

    session.append('step/start', { turn: 1, step: 2 })
    usageAttempt(session, 1, 2, { inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0 })
    session.append('step/end', { turn: 1, step: 2 })

    session.append('step/start', { turn: 1, step: 3 })
    usageAttempt(session, 1, 3, { inputTokens: 10, outputTokens: 2 })
    session.append('step/end', { turn: 1, step: 3 })

    const value = projected(ctx, session)
    const day = localCostDayKey(Date.now())
    expect(value).toEqual({
      estimatedCostUsd: 0.0125,
      pricedRequests: 2,
      unpricedRequests: 1,
      byDay: {
        [day]: {
          estimatedCostUsd: 0.0125,
          pricedRequests: 2,
          unpricedRequests: 1,
        },
      },
    })
  })
})
