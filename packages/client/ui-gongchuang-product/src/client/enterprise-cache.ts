/** Provider-reported prompt-side token buckets retained on a session summary. */
export interface ProviderTokenUsage {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Minimal session projection shape consumed by the enterprise overview. */
export interface EnterpriseSessionUsage {
  projectionValues?: Readonly<{
    tokenUsage?: Readonly<ProviderTokenUsage>
  }>
}

/** Aggregated prompt-side usage for one or more enterprise sessions. */
export interface EnterpriseCacheUsage {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  billedInputTokens: number
  /** Provider cache-read share of prompt-side input, not a universal cost-saving rate. */
  cacheReusePercent: number | null
}

const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) && value >= 0 ? value : 0

/**
 * Sum durable provider usage for the sessions attached to an enterprise.
 * Missing sessions and sessions without a provider usage receipt contribute
 * nothing; a null percentage therefore means "no input receipt yet".
 * @param sessionIds - sessions currently attached to the enterprise space.
 * @param sessionsById - global session summaries keyed by session identity.
 * @returns aggregated prompt-side input and provider cache-read share.
 */
export function enterpriseCacheUsage<Key extends PropertyKey>(
  sessionIds: readonly Key[],
  sessionsById: Readonly<Record<Key, unknown>>,
): EnterpriseCacheUsage {
  let uncachedInputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0

  for (const sessionId of sessionIds) {
    const session = sessionsById[sessionId] as EnterpriseSessionUsage | undefined
    const usage = session?.projectionValues?.tokenUsage
    if (usage === undefined) continue
    uncachedInputTokens += finiteNonNegative(usage.uncachedInputTokens)
    cacheReadTokens += finiteNonNegative(usage.cacheReadTokens)
    cacheWriteTokens += finiteNonNegative(usage.cacheWriteTokens)
  }

  const billedInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
  return {
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    billedInputTokens,
    cacheReusePercent: billedInputTokens === 0
      ? null
      : Math.round(cacheReadTokens / billedInputTokens * 100),
  }
}

/**
 * Compact token count for overview metrics.
 * @param value - non-negative token count to format.
 * @returns a compact decimal K/M label.
 */
export function formatEnterpriseTokens(value: number): string {
  if (value < 1_000) return String(value)
  const scaled = value < 1_000_000 ? value / 1_000 : value / 1_000_000
  const suffix = value < 1_000_000 ? 'K' : 'M'
  const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10
  return `${rounded}${suffix}`
}
