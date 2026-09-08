import { describe, expect, it } from 'vitest'
import { enterpriseCacheUsage, formatEnterpriseTokens } from '../src/client/enterprise-cache.ts'

describe('enterprise cache usage', () => {
  it('aggregates only sessions attached to the enterprise', () => {
    const sessions: Readonly<Record<string, unknown>> = {
      'session-a': { projectionValues: { tokenUsage: {
        uncachedInputTokens: 11_583, cacheReadTokens: 12_928, cacheWriteTokens: 0,
      } } },
      'session-b': { projectionValues: { tokenUsage: {
        uncachedInputTokens: 417, cacheReadTokens: 72, cacheWriteTokens: 0,
      } } },
      unrelated: { projectionValues: { tokenUsage: {
        uncachedInputTokens: 1, cacheReadTokens: 9_999, cacheWriteTokens: 0,
      } } },
    }
    const result = enterpriseCacheUsage(['session-a', 'session-b', 'missing'], sessions)

    expect(result).toEqual({
      uncachedInputTokens: 12_000,
      cacheReadTokens: 13_000,
      cacheWriteTokens: 0,
      billedInputTokens: 25_000,
      cacheReusePercent: 52,
    })
  })

  it('does not claim a percentage before a provider usage receipt exists', () => {
    expect(enterpriseCacheUsage(['blank'], { blank: {} }).cacheReusePercent).toBeNull()
  })

  it('formats overview token values compactly', () => {
    expect(formatEnterpriseTokens(999)).toBe('999')
    expect(formatEnterpriseTokens(12_928)).toBe('12.9K')
    expect(formatEnterpriseTokens(1_250_000)).toBe('1.3M')
  })
})
