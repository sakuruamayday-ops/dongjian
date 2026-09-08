/** Durable model list-price projection over provider usage receipts. */

import { z } from 'zod'
import { expandAssistantStream, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { localCostDayKey } from './projection.ts'
import type { ModelCostDayProjection, ModelCostProjection } from './projection.ts'

interface CostSample {
  turn: number
  step: number
  day: string
  estimatedCostUsd?: number
}

interface ModelCostState {
  totals: ModelCostDayProjection
  byDay: Record<string, ModelCostDayProjection>
  last: CostSample | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    modelCost: ModelCostState
  }
}

const zero = (): ModelCostDayProjection => ({
  estimatedCostUsd: 0,
  pricedRequests: 0,
  unpricedRequests: 0,
})

const daySchema = z.object({
  estimatedCostUsd: z.number().nonnegative(),
  pricedRequests: z.number().int().nonnegative(),
  unpricedRequests: z.number().int().nonnegative(),
}).strict()

const projectionSchema = z.object({
  estimatedCostUsd: z.number().nonnegative(),
  pricedRequests: z.number().int().nonnegative(),
  unpricedRequests: z.number().int().nonnegative(),
  byDay: z.record(z.string(), daySchema),
}).strict() as z.ZodType<ModelCostProjection>

const stateSchema = z.object({
  totals: daySchema,
  byDay: z.record(z.string(), daySchema),
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    day: z.string(),
    estimatedCostUsd: z.number().nonnegative().optional(),
  }).strict().nullable(),
}).strict() as z.ZodType<ModelCostState>

function usageOf(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  for (const member of expandAssistantStream(event.data.stream).toReversed()) {
    if (member.chunk.type === 'usage') return member.chunk.usage
  }
  return undefined
}

function delta(sample: CostSample, sign: 1 | -1): ModelCostDayProjection {
  return sample.estimatedCostUsd === undefined
    ? { estimatedCostUsd: 0, pricedRequests: 0, unpricedRequests: sign }
    : { estimatedCostUsd: sign * sample.estimatedCostUsd, pricedRequests: sign, unpricedRequests: 0 }
}

function add(
  value: ModelCostDayProjection,
  change: ModelCostDayProjection,
): ModelCostDayProjection {
  return {
    estimatedCostUsd: value.estimatedCostUsd + change.estimatedCostUsd,
    pricedRequests: value.pricedRequests + change.pricedRequests,
    unpricedRequests: value.unpricedRequests + change.unpricedRequests,
  }
}

/** Session projection for request and local-day model-cost estimates. */
export const modelCostProjectionDefinition = {
  key: 'modelCost',
  stateVersion: 2,
  stateSchema,
  init: () => ({ totals: zero(), byDay: {}, last: null }),
  apply: (state, event) => {
    // Released session v2 embeds usage in one settlement event per attempt.
    // A retry starts a distinct billed request, so it must not replace the
    // preceding attempt's cost slot even when turn and step stay unchanged.
    if (event.type === 'llm/retry-started') {
      return state.last?.turn === event.data.turn && state.last.step === event.data.step
        ? { ...state, last: null }
        : state
    }
    const usage = usageOf(event)
    if (usage === undefined) return state
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
    const { turn, step } = event.data

    const current: CostSample = {
      turn,
      step,
      day: localCostDayKey(event.time),
      ...usage.estimatedCostUsd === undefined
        ? {}
        : { estimatedCostUsd: usage.estimatedCostUsd },
    }
    const previous = state.last !== null
      && state.last.turn === turn
      && state.last.step === step
      ? state.last
      : undefined
    if (previous !== undefined
      && previous.day === current.day
      && previous.estimatedCostUsd === current.estimatedCostUsd) return state

    const byDay = { ...state.byDay }
    let totals = state.totals
    if (previous !== undefined) {
      const removal = delta(previous, -1)
      totals = add(totals, removal)
      byDay[previous.day] = add(byDay[previous.day] ?? zero(), removal)
    }
    const addition = delta(current, 1)
    totals = add(totals, addition)
    byDay[current.day] = add(byDay[current.day] ?? zero(), addition)
    return { totals, byDay, last: current }
  },
  wire: {
    viewSchema: projectionSchema,
    view: state => ({ ...state.totals, byDay: state.byDay }),
  },
} satisfies ProjectionDefinition<'modelCost', ModelCostState>
