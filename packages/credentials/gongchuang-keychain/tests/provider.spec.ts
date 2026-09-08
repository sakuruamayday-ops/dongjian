import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { BrowserAuth } from '../../../client/connection/src/browser-auth.ts'

const backend = vi.hoisted(() => ({
  read: vi.fn<(ref: string) => Promise<string | undefined>>(),
  write: vi.fn<(ref: string, value: string) => Promise<void>>(),
  remove: vi.fn<(ref: string) => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
}))

vi.mock('../src/backend.ts', () => ({
  createPlatformBackend: () => backend,
}))

import { GongchuangKeychainCredentialProvider } from '../src/index.ts'

const REF = credentialRef('GONGCHUANG_TEST_SECRET')
const BROWSER_SESSION = credentialKey('client-connection', 'browser-session')

afterEach(() => {
  vi.clearAllMocks()
  backend.read.mockResolvedValue(undefined)
  backend.write.mockResolvedValue(undefined)
  backend.remove.mockResolvedValue(undefined)
  backend.close.mockResolvedValue(undefined)
})

async function boot(processValues: Record<string, string> = {}): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: processValues },
    { source: 'project-env', path: '/untrusted/.env', values: { GONGCHUANG_TEST_SECRET: 'ignored' } },
  ]))
  const fiber = ctx.plugin(GongchuangKeychainCredentialProvider, {})
  await fiber
  return { ctx, dispose: () => fiber.dispose() }
}

describe('GongchuangKeychainCredentialProvider', () => {
  it('reads and describes only the OS keychain below the process environment', async () => {
    backend.read.mockResolvedValue('stored')
    const { ctx, dispose } = await boot()
    await expect(ctx.credentials.resolve(REF)).resolves.toEqual({ value: 'stored', source: 'os-keychain' })
    await expect(ctx.credentials.describe(REF)).resolves.toEqual({ configured: true, source: 'os-keychain', writable: true })
    await dispose()
    expect(backend.close).toHaveBeenCalledOnce()
  })

  it('ignores project dotenv values when the keychain is empty', async () => {
    const { ctx, dispose } = await boot()
    await expect(ctx.credentials.resolve(REF)).resolves.toBeUndefined()
    await expect(ctx.credentials.describe(REF)).resolves.toEqual({ configured: false, writable: true })
    await dispose()
  })

  it('reports temporary Keychain denial without treating saved credentials as absent', async () => {
    backend.read.mockRejectedValue(new Error(
      'gongchuang-credentials-keychain: macOS Keychain is temporarily unavailable',
    ))
    const { ctx, dispose } = await boot()
    await expect(ctx.credentials.resolve(REF)).rejects.toThrow(/Keychain is temporarily unavailable/)
    await expect(ctx.credentials.describe(REF)).rejects.toThrow(/Keychain is temporarily unavailable/)
    expect(backend.read).toHaveBeenCalledOnce()
    expect(backend.write).not.toHaveBeenCalled()
    expect(backend.remove).not.toHaveBeenCalled()
    backend.read.mockResolvedValue('retained-credential')
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    await expect(ctx.credentials.resolve(REF)).resolves.toEqual({ value: 'retained-credential', source: 'os-keychain' })
    await expect(ctx.credentials.describe(REF)).resolves.toEqual({ configured: true, source: 'os-keychain', writable: true })
    await dispose()
  })

  it('does not hide encrypted-store or permanent Keychain failures', async () => {
    backend.read.mockRejectedValue(new Error('gongchuang-credentials-keychain: encrypted store is invalid'))
    const { ctx, dispose } = await boot()
    await expect(ctx.credentials.resolve(REF)).rejects.toThrow(/encrypted store is invalid/)
    await expect(ctx.credentials.describe(REF)).rejects.toThrow(/encrypted store is invalid/)
    await dispose()
  })

  it('stores, removes, and publishes committed credential updates', async () => {
    const { ctx, dispose } = await boot()
    const updates: string[] = []
    ctx.on('credentials/reference-updated', (ref) => { updates.push(ref) })
    await ctx.credentials.set(REF, 'new-secret')
    await ctx.credentials.unset(REF)
    expect(backend.write).toHaveBeenCalledWith(REF, 'new-secret')
    expect(backend.remove).toHaveBeenCalledWith(REF)
    expect(updates).toEqual([REF, REF])
    await dispose()
  })

  it('keeps process credentials read-only and rejects unsafe values', async () => {
    const { ctx, dispose } = await boot({ GONGCHUANG_TEST_SECRET: 'from-env' })
    await expect(ctx.credentials.resolve(REF)).resolves.toEqual({ value: 'from-env', source: 'env' })
    await expect(ctx.credentials.describe(REF)).resolves.toEqual({ configured: true, source: 'env', writable: false })
    await expect(ctx.credentials.set(REF, 'next')).rejects.toThrow(/would be shadowed/)
    await expect(ctx.credentials.unset(REF)).rejects.toThrow(/would be shadowed/)
    await expect(ctx.credentials.set(REF, '')).rejects.toThrow(/empty value/)
    await expect(ctx.credentials.set(REF, 'line\nbreak')).rejects.toThrow(/control characters/)
    await dispose()
  })

  it('persists only the internal browser-session grant and publishes committed changes', async () => {
    const { ctx, dispose } = await boot()
    const updates: string[] = []
    ctx.on('credentials/record-updated', (key) => { updates.push(key) })
    const record = { kind: 'grant' as const, payload: { version: 1, secret: 'opaque' } }
    backend.read.mockResolvedValueOnce(undefined)
    await expect(ctx.credentials.describeRecord(BROWSER_SESSION)).resolves.toEqual({ configured: false, writable: true })
    backend.read.mockResolvedValueOnce(undefined)
    await expect(ctx.credentials.modifyRecord(BROWSER_SESSION, () => Promise.resolve(record))).resolves.toEqual(record)
    expect(backend.write).toHaveBeenCalledWith('GONGCHUANG_INTERNAL_BROWSER_SESSION', JSON.stringify(record))

    backend.read.mockResolvedValue(JSON.stringify(record))
    await expect(ctx.credentials.readRecord(BROWSER_SESSION)).resolves.toEqual(record)
    await expect(ctx.credentials.describeRecord(BROWSER_SESSION)).resolves.toEqual({
      configured: true,
      kind: 'grant',
      writable: true,
    })
    await expect(ctx.credentials.listRecords()).resolves.toEqual([{ key: BROWSER_SESSION, kind: 'grant' }])
    await expect(ctx.credentials.modifyRecord(BROWSER_SESSION, () => Promise.resolve(undefined))).resolves.toEqual(record)
    expect(backend.write).toHaveBeenCalledTimes(1)
    await ctx.credentials.deleteRecord(BROWSER_SESSION)
    expect(backend.remove).toHaveBeenCalledWith('GONGCHUANG_INTERNAL_BROWSER_SESSION')
    expect(updates).toEqual([BROWSER_SESSION, BROWSER_SESSION])
    await dispose()
  })

  it('initializes the Alpha browser authentication consumer and reuses its persisted secret', async () => {
    const { ctx, dispose } = await boot()
    const first = await BrowserAuth.create({}, ctx.credentials, 30)
    expect(new URL(first.authenticatedUrl('http://127.0.0.1:3000/')).searchParams.get('token')).not.toBeNull()
    const stored = backend.write.mock.calls[0]?.[1]
    expect(stored).toBeTypeOf('string')
    backend.read.mockResolvedValue(stored)
    await expect(BrowserAuth.create({}, ctx.credentials, 30)).resolves.toBeInstanceOf(BrowserAuth)
    expect(backend.write).toHaveBeenCalledOnce()
    await dispose()
  })

  it('rotates only the recoverable browser-session secret after a temporary Keychain denial', async () => {
    backend.read.mockRejectedValueOnce(new Error(
      'gongchuang-credentials-keychain: macOS Keychain is temporarily unavailable',
    ))
    const { ctx, dispose } = await boot()
    await expect(BrowserAuth.create({}, ctx.credentials, 30)).resolves.toBeInstanceOf(BrowserAuth)
    expect(backend.write).toHaveBeenCalledOnce()
    expect(backend.remove).not.toHaveBeenCalled()
    await dispose()
  })

  it('keeps every non-browser credential record disabled', async () => {
    const { ctx, dispose } = await boot()
    const key = credentialKey('gongchuang-account', 'primary')
    const mutate = vi.fn(() => Promise.resolve({ kind: 'grant' as const, payload: { token: 'secret' } }))
    await expect(ctx.credentials.readRecord(key)).resolves.toBeUndefined()
    await expect(ctx.credentials.describeRecord(key)).resolves.toEqual({ configured: false, writable: false })
    await expect(ctx.credentials.listRecords()).resolves.toEqual([])
    await expect(ctx.credentials.modifyRecord(key, mutate)).rejects.toThrow(/only the internal browser-session record/)
    await expect(ctx.credentials.deleteRecord(key)).rejects.toThrow(/only the internal browser-session record/)
    expect(mutate).not.toHaveBeenCalled()
    await dispose()
  })

  it('fails closed for corrupt browser-session records and non-grant replacements', async () => {
    const { ctx, dispose } = await boot()
    backend.read.mockResolvedValue('{broken')
    await expect(ctx.credentials.readRecord(BROWSER_SESSION)).rejects.toThrow(/invalid JSON/)
    backend.read.mockResolvedValue(undefined)
    await expect(ctx.credentials.modifyRecord(BROWSER_SESSION, () => Promise.resolve({ kind: 'api-key', key: 'no' })))
      .rejects.toThrow(/must be a grant/)
    expect(backend.write).not.toHaveBeenCalled()
    await dispose()
  })
})
