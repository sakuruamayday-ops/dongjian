import type { Cookie, Cookies } from 'electron'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { clearBrowserTransportCookies } from '../src/browser-transport-cookie-cleanup.ts'

function cookie(name: string, domain: string, path = '/', secure = false): Cookie {
  return {
    domain,
    hostOnly: !domain.startsWith('.'),
    httpOnly: true,
    name,
    path,
    sameSite: 'strict',
    secure,
    session: false,
    value: 'value',
  }
}

describe('desktop browser transport cookie cleanup', () => {
  test('removes accumulated loopback transport cookies without touching account or other-site cookies', async () => {
    const legacy = Array.from({ length: 70 }, (_, index) =>
      cookie(`dsh-auth-legacy-${String(index)}`, index % 2 === 0 ? '127.0.0.1' : '.127.0.0.1'))
    const processLocal = cookie('dsh-auth-process-local', '127.0.0.1')
    const retained = [
      cookie('account-session', '127.0.0.1'),
      cookie('provider-login', '.127.0.0.1'),
      cookie('dsh-auth-other-host', '.localhost'),
      cookie('dsh-auth-lookalike-host', '127.0.0.10'),
    ]
    const stored = [...legacy, processLocal, ...retained]
    const get = vi.fn(async () => [...stored])
    const remove = vi.fn(async (url: string, name: string) => {
      const index = stored.findIndex(item => item.name === name
        && (url.startsWith('http://127.0.0.1/') || url.startsWith('https://127.0.0.1/')))
      if (index !== -1) stored.splice(index, 1)
    })
    const cookies: Pick<Cookies, 'get' | 'remove'> = { get, remove }

    await expect(clearBrowserTransportCookies(cookies)).resolves.toBe(71)

    expect(get).toHaveBeenCalledWith({})
    expect(remove).toHaveBeenCalledTimes(71)
    expect(remove).toHaveBeenCalledWith('http://127.0.0.1/', 'dsh-auth-legacy-0')
    expect(remove).toHaveBeenCalledWith('http://127.0.0.1/', 'dsh-auth-process-local')
    expect(stored).toEqual(retained)
    expect(stored.filter(item => item.domain?.replace(/^\./u, '') === '127.0.0.1')
      .map(item => item.name)).toEqual(['account-session', 'provider-login'])
  })

  test('awaits cleanup before the product window can navigate', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/main.ts'), 'utf8')
    const start = source.indexOf('async function createMainWindow(')
    const end = source.indexOf('\nasync function configureUpdater(', start)
    const createMainWindow = source.slice(start, end)

    expect(createMainWindow.indexOf('await clearBrowserTransportCookies(desktopSession.cookies)'))
      .toBeLessThan(createMainWindow.indexOf('new BrowserWindow('))
    expect(createMainWindow.indexOf('await clearBrowserTransportCookies(desktopSession.cookies)'))
      .toBeLessThan(createMainWindow.indexOf('await window.loadURL(url)'))
  })
})
