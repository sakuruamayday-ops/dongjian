import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'

/** 应用桌面浏览器响应策略的回环网络范围。 */
export const DESKTOP_LOOPBACK_URLS = [
  'http://127.0.0.1:*/*',
  'ws://127.0.0.1:*/*',
] as const

interface DesktopLoopbackServer {
  host: string
  port: number
}

/**
 * 通过 Connection 的一次性启动令牌解析 Electron 入口 URL。
 * 令牌交换和持久签名 Cookie 归 Connection 管理；桌面宿主只确认返回值仍在
 * 已绑定的回环源内。
 */
export function desktopAuthenticatedLoopbackUrl(
  webServer: DesktopLoopbackServer,
  connection: Pick<HostConnectionHandle, 'authenticatedUrl'>,
): string {
  if (webServer.host !== '127.0.0.1'
    || !Number.isInteger(webServer.port)
    || webServer.port < 1
    || webServer.port > 65_535) {
    throw new Error('desktop runtime did not publish a valid loopback server')
  }
  const baseUrl = new URL(`http://127.0.0.1:${String(webServer.port)}/`)
  const authenticatedUrl = new URL(connection.authenticatedUrl(baseUrl.href))
  if (authenticatedUrl.origin !== baseUrl.origin
    || authenticatedUrl.pathname !== '/'
    || authenticatedUrl.username !== ''
    || authenticatedUrl.password !== ''
    || authenticatedUrl.hash !== ''
    || authenticatedUrl.search === '') {
    throw new Error('desktop runtime returned an invalid authenticated loopback URL')
  }
  return authenticatedUrl.href
}
