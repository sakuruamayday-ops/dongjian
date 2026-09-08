/** Product-owned desktop deep links for opening one local conversation. */

export const GONGCHUANG_PROTOCOL = 'dongjian'
export const OPEN_SESSION_DEEP_LINK_CHANNEL = 'gongchuang:deep-link:open-session'

const SESSION_ID_PATTERN = /^session-[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/u

/** Parse one exact `dongjian://threads/<session-id>` URL. */
export function parseSessionDeepLink(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== `${GONGCHUANG_PROTOCOL}:`
    || url.hostname !== 'threads'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || url.search !== ''
    || url.hash !== '') return undefined
  const encoded = url.pathname.slice(1)
  if (encoded === '' || encoded.includes('/')) return undefined
  let sessionId: string
  try {
    sessionId = decodeURIComponent(encoded)
  } catch {
    return undefined
  }
  return SESSION_ID_PATTERN.test(sessionId) ? sessionId : undefined
}

/** Find the first valid product deep link supplied by an OS launch. */
export function sessionDeepLinkFromArgv(argv: readonly string[]): string | undefined {
  for (const value of argv) {
    const sessionId = parseSessionDeepLink(value)
    if (sessionId !== undefined) return sessionId
  }
  return undefined
}
