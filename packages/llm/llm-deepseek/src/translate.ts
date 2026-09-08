/**
 * Translate DeepSeek SSE payloads with one stateful harness block per content, reasoning, or tool
 * call index. An empty initial reasoning delta does not open a block. Finish reason and the latest
 * usage are deferred until `[DONE]`, covering both finish-attached and trailing usage-only shapes
 * while ensuring no chunk follows `finish`.
 *
 * Translate DeepSeek wire chunks into the harness `StreamChunk` protocol.
 * @module dsh-llm-deepseek/translate
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { DONE } from './sse.ts'
import type { WireChunk, WireUsage } from './types.ts'

interface DeepSeekPrice {
  /** USD per one million uncached or newly cached input tokens. */
  input: number
  /** USD per one million cache-hit input tokens. */
  cacheRead: number
  /** USD per one million output tokens. */
  output: number
}

interface DeepSeekPriceSchedule {
  /** USD-per-million rates outside the provider's peak windows. */
  offPeak: DeepSeekPrice
  /** USD-per-million rates during the provider's peak windows. */
  peak: DeepSeekPrice
}

const FLASH_PRICE_SCHEDULE: DeepSeekPriceSchedule = Object.freeze({
  offPeak: { input: 0.22, cacheRead: 0.007, output: 0.66 },
  peak: { input: 0.44, cacheRead: 0.014, output: 1.32 },
})
const PRO_PRICE_SCHEDULE: DeepSeekPriceSchedule = Object.freeze({
  offPeak: { input: 0.66, cacheRead: 0.022, output: 1.98 },
  peak: { input: 1.32, cacheRead: 0.044, output: 3.96 },
})

// Current official rates, effective 2026-08-16 16:00 UTC:
// https://api-docs.deepseek.com/quick_start/pricing/
// Keep model ids exact so custom pass-through routes remain unpriced.
const DEEPSEEK_PRICE_SCHEDULES: Readonly<Record<string, DeepSeekPriceSchedule>> = Object.freeze({
  'deepseek-v4-flash': FLASH_PRICE_SCHEDULE,
  'deepseek-v4-pro': PRO_PRICE_SCHEDULE,
  'deepseek-v4-flash-vision-exp': FLASH_PRICE_SCHEDULE,
})

/**
 * Select the official rate in force at one fixed request-pricing instant.
 * Peak windows are Monday through Friday, 01:00-04:00 and 06:00-10:00 UTC;
 * the upper boundaries are off-peak.
 * @param model - Exact DeepSeek model id.
 * @param pricedAtEpochMs - UTC epoch milliseconds captured once for the request.
 * @returns The applicable USD-per-million rates, or `undefined` for an unpriced route.
 */
function deepSeekPriceAt(model: string, pricedAtEpochMs: number): DeepSeekPrice | undefined {
  const schedule = DEEPSEEK_PRICE_SCHEDULES[model]
  if (schedule === undefined) return undefined
  const pricedAt = new Date(pricedAtEpochMs)
  const weekday = pricedAt.getUTCDay()
  const hour = pricedAt.getUTCHours()
  const peak = weekday >= 1
    && weekday <= 5
    && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
  return peak ? schedule.peak : schedule.offPeak
}

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only, absent until a delta carries a non-empty value. */
  callId?: string | undefined
  name?: string | undefined
}

/**
 * Map the wire finish_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values (content_filter, …) become `{kind: 'error'}` with the uppercased value as `code`.
 */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      // content_filter, insufficient_system_resource, future additions.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map wire usage fields. DeepSeek's `prompt_tokens` INCLUDES cache hits
 * (`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`,
 * api/create-chat-completion); the harness TokenUsage convention is
 * DISJOINT counts, so cache reads are subtracted out of `inputTokens`.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @param model - exact requested model id; known models with valid token counts receive an API list-price estimate.
 * @param pricedAtEpochMs - UTC epoch milliseconds fixed for the request; defaults to the mapping instant.
 * @returns disjoint harness counts; an exact total is present only when the
 *   aggregate prompt/completion counters are valid and agree with any wire total.
 */
export function mapUsage(usage: WireUsage, model?: string, pricedAtEpochMs = Date.now()): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const price = model === undefined ? undefined : deepSeekPriceAt(model, pricedAtEpochMs)
  const pricedCacheRead = cacheRead ?? 0
  const hasPricableCounts = Number.isSafeInteger(usage.prompt_tokens)
    && usage.prompt_tokens >= 0
    && Number.isSafeInteger(usage.completion_tokens)
    && usage.completion_tokens >= 0
    && Number.isSafeInteger(pricedCacheRead)
    && pricedCacheRead >= 0
    && pricedCacheRead <= usage.prompt_tokens
  const estimatedCostUsd = price === undefined || !hasPricableCounts
    ? undefined
    : (
      (usage.prompt_tokens - pricedCacheRead) * price.input
        + pricedCacheRead * price.cacheRead
        + usage.completion_tokens * price.output
    ) / 1_000_000
  const combined = usage.prompt_tokens + usage.completion_tokens
  const hasExactTotal = Number.isSafeInteger(usage.prompt_tokens)
    && usage.prompt_tokens >= 0
    && Number.isSafeInteger(usage.completion_tokens)
    && usage.completion_tokens >= 0
    && Number.isSafeInteger(combined)
    && (usage.total_tokens === undefined || usage.total_tokens === combined)
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...hasExactTotal ? { totalTokens: combined } : {},
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
    ...estimatedCostUsd === undefined ? {} : { estimatedCostUsd },
  }
}

/**
 * Accept one streamed identity field for a tool call. `id` and `name` are
 * identity, not accumulation: the wire sends each once, on the call's first
 * delta. A continuation delta that re-sends the field empty — or `null`, which
 * some OpenAI-compatible gateways fill in — means "no update", never "clear".
 * @param current - the identity established by an earlier delta of this call.
 * @param incoming - the field as parsed from this delta. The wire type is a
 *   claim about a remote encoder, so anything but a non-empty string leaves the
 *   established value alone rather than overwriting it.
 * @returns the identity in force after this delta.
 */
function acceptIdentity(current: string | undefined, incoming: unknown): string | undefined {
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : current
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: brandString<ToolCallId>(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
 * @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
 * @param model - exact requested model id used for optional list-price estimation.
 * @param pricedAtEpochMs - UTC epoch milliseconds captured once when the request is sent.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
 *   A `stop` (or absent) finish with no opened blocks is a degenerate provider completion and maps to an
 *   `EMPTY_RESPONSE` error finish instead of a successful empty message.
 */
export async function* translate(
  payloads: AsyncIterable<string>,
  model?: string,
  pricedAtEpochMs = Date.now(),
): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // Reasoning first: thinking mode interleaves it before text. The
      // empty-string first chunk must not open a block.
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        block.callId = acceptIdentity(block.callId, call.id)
        block.name = acceptIdentity(block.name, call.function?.name)
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: brandString<ToolCallId>(block.callId ?? ''),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    // Usage may arrive attached to the finish chunk or as a trailing
    // usage-only chunk — keep the latest.
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage, model, pricedAtEpochMs)
  }

  // parseSse guarantees the [DONE] sentinel (or throws); reaching here means
  // the payload source violated that contract.
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}
