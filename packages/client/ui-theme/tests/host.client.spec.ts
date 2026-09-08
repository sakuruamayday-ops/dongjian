import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { IndexInjection, WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_PREFERENCE, THEME_SETTINGS_NAMESPACE, apply,
} from '@deepseek-ai/dsh-client-ui-theme'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

/** Collect the injection table the way an index render or boot payload does. */
function collect(ctx: Context): IndexInjection[] {
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table)
  return table
}

/** Narrow the theme row and return its external script URL. */
function scriptSource(row: IndexInjection | undefined): string {
  if (row?.kind !== 'script-src') throw new Error('expected an external script row')
  return row.src
}

describe('ui-theme host', () => {
  it('registers, validates, and disposes the durable theme namespace with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const ns = THEME_SETTINGS_NAMESPACE
    expect(ctx.settings.get(ns)).toEqual({ preference: DEFAULT_PREFERENCE, fontSize: 14 })
    await ctx.settings.update(ns, { preference: 'dark', fontSize: 16 })
    expect(ctx.settings.get(ns)).toEqual({ preference: 'dark', fontSize: 16 })
    await expect(ctx.settings.update(ns, { preference: 'sepia' })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { fontSize: 11 })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { fontSize: 18 })).rejects.toThrow()
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })

  it('answers each collection with the current durable preference until disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const rows = collect(ctx)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'script-src', placement: 'body' })
    expect(scriptSource(rows[0])).toBe('/theme-bootstrap.js?preference=system&fontSize=14')
    await ctx.settings.update(THEME_SETTINGS_NAMESPACE, { preference: 'dark', fontSize: 17 })
    expect(scriptSource(collect(ctx)[0])).toBe('/theme-bootstrap.js?preference=dark&fontSize=17')
    await fiber.dispose()
    expect(collect(ctx)).toEqual([])
  })

  it('uses the system preference without a settings provider', async () => {
    const ctx = new Context()
    await ctx.plugin({ apply }).await()
    expect(scriptSource(collect(ctx)[0])).toBe('/theme-bootstrap.js?preference=system&fontSize=14')
  })

  it('falls back to the schema default while the theme namespace holds no section', async () => {
    // A settings provider whose namespace read comes back empty (registration
    // still pending or a provider without schema defaults).
    const ctx = new Context()
    ctx.provide('settings', { register: () => () => {}, get: () => undefined } as never)
    await ctx.plugin({ apply }).await()
    expect(scriptSource(collect(ctx)[0])).toBe('/theme-bootstrap.js?preference=system&fontSize=14')
  })

  it('serves the external bootstrap through a named route for HTTP and worker transports', async () => {
    const ctx = new Context()
    let route: WebRoute | undefined
    ctx.provide('webServer', {
      register(candidate: WebRoute) {
        route = candidate
        return () => {}
      },
    } as WebServer)
    await ctx.plugin({ apply }).await()
    if (route === undefined) throw new Error('theme bootstrap route was not registered')

    let status = 0
    let headers: Record<string, string> | undefined
    let body = ''
    const response = {
      writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
        status = nextStatus
        headers = nextHeaders
        return response
      },
      end(chunk?: Uint8Array | string) {
        body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8')
        return response
      },
    } as unknown as ServerResponse
    await route.handler({ method: 'GET', url: '/theme-bootstrap.js?preference=dark&fontSize=17' } as IncomingMessage, response)
    expect(status).toBe(200)
    expect(headers).toEqual({
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    })
    expect(body).toContain("searchParams.get('fontSize')")
    expect(body).not.toContain('<script')
  })
})
