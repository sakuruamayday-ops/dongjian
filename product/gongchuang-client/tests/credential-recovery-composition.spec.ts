import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import GongchuangModelConnectionsService from '@gongchuang/model-connections'
import GongchuangAccountService from '@gongchuang/account'

const backend = vi.hoisted(() => ({
  unavailable: true,
  values: new Map<string, string>([
    ['OPENCODE_GO_API_KEY', 'fixture-key'],
    ['GONGCHUANG_ACCOUNT_TOKEN', `jtk_${'a'.repeat(48)}`],
    ['GONGCHUANG_ACCOUNT_USERNAME', 'fixture-owner'],
    ['GONGCHUANG_ACCOUNT_PASSWORD', 'fixture-password'],
    ['GONGCHUANG_ACCOUNT_DEVICE_ID', `gcd_${'a'.repeat(48)}`],
  ]),
  read: vi.fn<(ref: string) => Promise<string | undefined>>(),
  write: vi.fn<(ref: string, value: string) => Promise<void>>(),
  remove: vi.fn<(ref: string) => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
}))

vi.mock('../../../packages/credentials/gongchuang-keychain/src/backend.ts', () => ({
  createPlatformBackend: () => backend,
}))

import GongchuangKeychainCredentialProvider from '@gongchuang/credentials-keychain'

class FixtureSettings extends SettingsProvider {
  readonly writable = true
  private readonly doc: Record<string, unknown> = {}
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  backend.unavailable = true
  backend.read.mockReset()
  backend.write.mockReset()
  backend.remove.mockReset()
  backend.close.mockReset()
  vi.unstubAllGlobals()
})

describe('共创凭据恢复真实 Loader 组合', () => {
  it('mounts with an unavailable Keychain and reuses the retained key after access recovers', async () => {
    root = await mkdtemp(join(tmpdir(), 'gongchuang-credential-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: fixture-settings',
      '- name: gongchuang-keychain',
      '- name: system-prompt',
      '- name: tools',
      '- name: gongchuang-account',
      '  config:',
      '    portalUrl: https://account.example.test',
      '    clientVersion: 0.4.7',
      '    platform: macos',
      '- name: llm',
      '- name: llm-deepseek',
      '- name: llm-pi-ai',
      '  config:',
      '    providers:',
      '      opencode-go:',
      '        apiKeyEnv: OPENCODE_GO_API_KEY',
      '- name: gongchuang-model-connections',
      '',
    ].join('\n'))

    backend.read.mockImplementation((ref) => backend.unavailable
      ? Promise.reject(new Error('gongchuang-credentials-keychain: macOS Keychain is temporarily unavailable'))
      : Promise.resolve(backend.values.get(ref)))
    backend.write.mockResolvedValue(undefined)
    backend.remove.mockResolvedValue(undefined)
    backend.close.mockResolvedValue(undefined)
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => String(input).endsWith('/v1/me')
      ? Response.json({
        username: 'fixture-owner', client_compatibility: 'supported', minimum_supported_version: '0.1.4',
      })
      : Response.json({ object: 'list', data: [{ id: 'deepseek-v4-flash-vision-exp', object: 'model' }] }))
    vi.stubGlobal('fetch', fetch)

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    context.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules: Readonly<Record<string, unknown>> = {
      'fixture-settings': { default: FixtureSettings },
      'gongchuang-keychain': { default: GongchuangKeychainCredentialProvider },
      'system-prompt': { default: SystemPrompt },
      tools: { default: ToolRuntime },
      'gongchuang-account': { default: GongchuangAccountService },
      llm: { default: LlmRuntime },
      'llm-deepseek': LlmDeepSeek,
      'llm-pi-ai': LlmPiAi,
      'gongchuang-model-connections': { default: GongchuangModelConnectionsService },
    }
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules[specifier]
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const service = context.get('gongchuangModelConnections') as GongchuangModelConnectionsService | undefined
    expect(service).toBeInstanceOf(GongchuangModelConnectionsService)
    const unavailable = await service!.snapshot()
    expect(backend.read).toHaveBeenCalled()
    expect(unavailable.providers['opencode-go']).toMatchObject({
      phase: 'error', configured: false, failureKind: 'transient',
    })
    expect(unavailable.providers['opencode-go'].message).toContain('GC-MODEL-KEYCHAIN')
    const account = context.get('gongchuangAccount') as GongchuangAccountService | undefined
    expect(account).toBeInstanceOf(GongchuangAccountService)
    await expect(account!.refresh()).resolves.toMatchObject({ phase: 'local', username: null })
    expect(account!.snapshot().message).toBe('')
    expect(backend.write).not.toHaveBeenCalled()
    expect(backend.remove).not.toHaveBeenCalled()

    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    backend.unavailable = false
    const recovered = await service!.refresh({ provider: 'opencode-go' })
    expect(recovered.providers['opencode-go']).toMatchObject({
      phase: 'ready', configured: true, selectedModel: 'deepseek-v4-flash-vision-exp', modelCount: 1,
    })
    await expect(account!.refresh()).resolves.toMatchObject({ phase: 'local', username: null })
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/v1/me'))).toBe(false)
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/v1/client-login'))).toBe(false)
    expect(backend.write).not.toHaveBeenCalled()
    expect(backend.remove).not.toHaveBeenCalled()
  })
})
