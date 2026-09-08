import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESKTOP_LOOPBACK_URLS, desktopAuthenticatedLoopbackUrl } from '../src/loopback.ts'

const main = readFileSync(resolve(import.meta.dirname, '../src/main.ts'), 'utf8')

describe('desktop loopback request admission', () => {
  it('applies the Electron response policy to loopback HTTP and event streams', () => {
    expect(DESKTOP_LOOPBACK_URLS).toEqual([
      'http://127.0.0.1:*/*',
      'ws://127.0.0.1:*/*',
    ])
  })

  it('opens the alpha Connection launch URL on the bound loopback origin', () => {
    expect(desktopAuthenticatedLoopbackUrl(
      { host: '127.0.0.1', port: 43_821 },
      { authenticatedUrl: baseUrl => `${baseUrl}?token=alpha-process-token` },
    )).toBe('http://127.0.0.1:43821/?token=alpha-process-token')
  })

  it('refuses a non-loopback server or an off-origin authentication result', () => {
    expect(() => desktopAuthenticatedLoopbackUrl(
      { host: '0.0.0.0', port: 43_821 },
      { authenticatedUrl: baseUrl => `${baseUrl}?token=alpha-process-token` },
    )).toThrow(/valid loopback server/u)
    expect(() => desktopAuthenticatedLoopbackUrl(
      { host: '127.0.0.1', port: 43_821 },
      { authenticatedUrl: () => 'https://example.com/?token=leaked' },
    )).toThrow(/invalid authenticated loopback URL/u)
    expect(() => desktopAuthenticatedLoopbackUrl(
      { host: '127.0.0.1', port: 43_821 },
      { authenticatedUrl: baseUrl => baseUrl },
    )).toThrow(/invalid authenticated loopback URL/u)
  })

  it('uses Connection cookies instead of the removed custom request-header guard', () => {
    expect(main).toContain('desktopAuthenticatedLoopbackUrl(webServer, connection)')
    expect(main).toContain("session.fromPartition('persist:dongjian-v0.1')")
    expect(main).not.toContain('WebRequestGuard')
    expect(main).not.toContain('WEB_REQUEST_GUARD_SERVICE')
    expect(main).not.toContain('x-gongchuang-desktop-token')
    expect(main).not.toContain('onBeforeSendHeaders')
  })
})
