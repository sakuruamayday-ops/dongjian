/** Cleanup for Connection transport cookies retained by the desktop partition. */

import { isBrowserAuthCookieName } from '@deepseek-ai/dsh-client-connection'
import type { Cookie, Cookies } from 'electron'

const LOOPBACK_COOKIE_DOMAIN = '127.0.0.1'

function normalizedCookieDomain(cookie: Cookie): string | undefined {
  return cookie.domain?.replace(/^\./u, '').toLowerCase()
}

function cookieRemovalUrl(cookie: Cookie): string {
  const url = new URL(`${cookie.secure === true ? 'https' : 'http'}://${LOOPBACK_COOKIE_DOMAIN}/`)
  url.pathname = cookie.path?.startsWith('/') === true ? cookie.path : '/'
  return url.href
}

/**
 * Remove only Connection-owned loopback cookies before the first desktop navigation.
 * @param cookies - persistent Electron cookie store used by the main product window.
 * @returns number of browser-transport cookies removed from the active store.
 */
export async function clearBrowserTransportCookies(
  cookies: Pick<Cookies, 'get' | 'remove'>,
): Promise<number> {
  const targets = (await cookies.get({})).filter(cookie =>
    normalizedCookieDomain(cookie) === LOOPBACK_COOKIE_DOMAIN
      && isBrowserAuthCookieName(cookie.name))
  await Promise.all(targets.map(cookie => cookies.remove(cookieRemovalUrl(cookie), cookie.name)))
  return targets.length
}
