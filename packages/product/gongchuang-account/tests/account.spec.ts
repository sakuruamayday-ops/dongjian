import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import GongchuangAccountService from '../src/index.ts'
import { DEFAULT_PERSONALIZATION } from '../src/personalization.ts'

let directory: string
const fibers: Fiber[] = []
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dongjian-local-preferences-'))
  vi.stubEnv('DSH_HOME', directory)
})
afterEach(async () => {
  for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function boot() {
  const ctx = new Context()
  const register = vi.fn(() => () => {})
  ctx.provide('tools', { register } as never)
  const fiber = ctx.plugin(GongchuangAccountService, {})
  await fiber
  fibers.push(fiber)
  const service = ctx.get('gongchuangAccount')
  if (service === undefined) throw new Error('local preferences service did not mount')
  return { ctx, service, register, fiber }
}

describe('independent local preferences', () => {
  it('starts without a credentials or account network dependency', async () => {
    const fetch = vi.fn(() => { throw new Error('account networking is forbidden') })
    vi.stubGlobal('fetch', fetch)
    const { service, register } = await boot()
    expect(service.snapshot()).toMatchObject({
      phase: 'local', portalUrl: '', username: null,
      hasSavedPassword: false, singleDevice: false,
    })
    expect(await service.refresh()).toBe(service.snapshot())
    expect(await service.disconnect({ forgetSavedLogin: true })).toBe(service.snapshot())
    expect(register).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects obsolete login requests without contacting a server', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { service } = await boot()
    await expect(service.login({ username: 'old-account', password: 'not-a-real-password', rememberPassword: true, useSavedPassword: false }))
      .rejects.toThrow('无需登录')
    expect(service.snapshot().phase).toBe('local')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('initializes local defaults and persists explicit preferences across restart', async () => {
    const first = await boot()
    expect((await first.service.personalization()).instructions).toBe(DEFAULT_PERSONALIZATION)
    await first.service.savePersonalization({ instructions: '优先使用表格对比。' })
    await first.fiber.dispose()
    const second = await boot()
    expect((await second.service.personalization()).instructions).toBe('优先使用表格对比。')
    const content = await readFile(join(directory, 'AGENTS.md'), 'utf8')
    expect(content).toContain('洞见个性化偏好')
    expect(content).not.toContain('共创')
  })

  it('preserves an explicitly empty preference document', async () => {
    const { service } = await boot()
    await service.savePersonalization({ instructions: '' })
    expect((await service.personalization()).instructions).toBe('')
    expect(await readFile(join(directory, 'AGENTS.md'), 'utf8')).toBe('')
  })

  it('keeps the generated preferences API available', () => {
    const methods = remoteMethods(GongchuangAccountService)
    expect(methods).toBeDefined()
  })
})
