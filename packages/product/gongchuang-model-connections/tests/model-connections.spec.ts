import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo,
  CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import GongchuangModelConnectionsService from '../src/index.ts'
import { GONGCHUANG_MODEL_PROVIDERS } from '../src/provider-registry.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private readonly doc: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

abstract class ReferenceOnlyCredentials extends CredentialProvider {
  readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> { return Promise.resolve(undefined) }
  describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: false })
  }
  listRecords(): Promise<readonly CredentialRecordEntry[]> { return Promise.resolve([]) }
  modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> { return Promise.reject(new Error('credential records are disabled')) }
  deleteRecord(_key: CredentialKey): Promise<void> { return Promise.reject(new Error('credential records are disabled')) }
}

class MemoryCredentials extends ReferenceOnlyCredentials {
  readonly values = new Map<string, string>()

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = this.values.has(ref)
    return Promise.resolve({ configured, writable: true, ...(configured ? { source: 'memory' } : {}) })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    if (this.values.delete(ref)) this.notifyUpdated(ref)
    return Promise.resolve()
  }
}

class DeferredCredentials extends ReferenceOnlyCredentials {
  private release!: () => void
  private readonly readable = new Promise<void>((resolve) => { this.release = resolve })

  allowReads(): void { this.release() }
  resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return this.readable.then(() => undefined)
  }
  describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return this.readable.then(() => ({ configured: false, writable: true }))
  }
  set(_ref: CredentialRef, _value: string): Promise<void> { return Promise.resolve() }
  unset(_ref: CredentialRef): Promise<void> { return Promise.resolve() }
}

async function boot(config: {
  deepseek?: LlmDeepSeek.Config
  piAi?: LlmPiAi.Config
  credentials?: ReadonlyMap<string, string>
} = {}): Promise<{
  ctx: Context
  service: GongchuangModelConnectionsService
  credentials: MemoryCredentials
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  fibers.push(await ctx.plugin(MemorySettings))
  fibers.push(await ctx.plugin(MemoryCredentials))
  const credentials = ctx.credentials as MemoryCredentials
  for (const [ref, value] of config.credentials ?? []) credentials.values.set(ref, value)
  fibers.push(await ctx.plugin(LlmRuntime))
  fibers.push(await ctx.plugin(LlmDeepSeek, structuredClone(config.deepseek ?? {})))
  fibers.push(await ctx.plugin(LlmPiAi, structuredClone(config.piAi ?? {
    providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } },
  })))
  fibers.push(await ctx.plugin(GongchuangModelConnectionsService))
  const service = ctx.get('gongchuangModelConnections')
  if (service === undefined) throw new Error('model-connections service did not mount')
  return {
    ctx,
    service,
    credentials: ctx.credentials as MemoryCredentials,
    dispose: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() },
  }
}

function models(...ids: string[]): Response {
  return Response.json({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) })
}

const DEEPSEEK_TEXT_EVENTS = [
  '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
  '{"choices":[{"delta":{"content":"三路连接真实可用"}}]}',
  '{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":6}}',
  '[DONE]',
]

const OPENAI_TEXT_EVENTS = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"三路连接真实可用"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":6}}',
  '[DONE]',
]

function sse(events: readonly string[]): Response {
  return new Response(events.map(event => `data: ${event}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function inputUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input)
}

function requestMethod(input: string | URL | Request, init?: RequestInit): string {
  return init?.method ?? (input instanceof Request ? input.method : 'GET')
}

async function streamText(ctx: Context, provider: string, model: string): Promise<{
  text: string
  finish: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined
}> {
  let text = ''
  let finish: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined
  for await (const chunk of ctx.llm.stream({
    provider,
    model,
    messages: [createUserMessage({
      content: [{ type: 'text', text: '请回复连接状态' }],
      source: { kind: 'plugin', plugin: 'gongchuang-model-connections-test' },
    })],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason
  }
  return { text, finish }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GongchuangModelConnectionsService', () => {
  it.each(GONGCHUANG_MODEL_PROVIDERS.filter(row => row.id !== 'custom'))(
    'routes $label model discovery and inference through its declared protocol', async (definition) => {
      const baseURL = definition.baseURL || 'https://qa-resource.openai.azure.com/openai/v1'
      const modelId = ['deepseek', 'opencode-zen', 'opencode-go'].includes(definition.id) ? 'deepseek-v4-flash' : 'qa-provider-model'
      const apiRoot = definition.api === 'anthropic-messages' ? baseURL.replace(/\/v1\/?$/, '') : baseURL
      const directory = `${apiRoot}${definition.api === 'anthropic-messages' ? '/v1/models' : '/models'}`
      const inference = `${apiRoot}${definition.api === 'anthropic-messages'
        ? '/v1/messages' : definition.api === 'openai-responses' ? '/responses' : '/chat/completions'}`
      const captures: Array<{ url: string; method: string; headers: Headers }> = []
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const method = requestMethod(input, init)
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        captures.push({ url: inputUrl(input), method, headers })
        return method === 'GET' ? models(modelId)
          : Response.json({ error: { message: 'synthetic wire capture' } }, { status: 400 })
      }))
      const { ctx, service, dispose } = await boot()
      try {
        await service.configure({ provider: definition.id, baseURL, apiKey: 'synthetic-provider-key' })
        const result = await streamText(ctx, definition.route, modelId)
        expect(result.finish?.kind).toBe('error')
        expect(captures.map(row => row.url)).toEqual([directory, inference])
        const header = definition.api === 'anthropic-messages' ? 'x-api-key' : 'authorization'
        const value = definition.api === 'anthropic-messages' ? 'synthetic-provider-key' : 'Bearer synthetic-provider-key'
        for (const capture of captures) expect(capture.headers.get(header)).toBe(value)
      } finally { await dispose() }
    },
  )

  it.each([
    { provider: 'opencode-zen', catalogProvider: 'opencode', ids: ['claude-sonnet-4-6', 'gpt-5.4', 'gemini-3.1-pro', 'deepseek-v4-flash'],
      paths: ['/zen/v1/messages', '/zen/v1/responses', '/zen/v1/models/gemini-3.1-pro:streamGenerateContent', '/zen/v1/chat/completions'] },
    { provider: 'opencode-go', catalogProvider: 'opencode-go', ids: ['minimax-m3', 'gpt-5.6-luna', 'deepseek-v4-flash'],
      paths: ['/zen/go/v1/messages', '/zen/go/v1/responses', '/zen/go/v1/chat/completions'] },
  ] as const)('keeps $provider native protocols after replacing legacy settings, refreshing and restarting', async ({ provider, catalogProvider, ids, paths }) => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = inputUrl(input)
      if (requestMethod(input, init) === 'GET') return models(...ids, 'unpublished-new-model')
      urls.push(url)
      return Response.json({ error: { message: 'synthetic wire capture' } }, { status: 400 })
    }))
    const first = await boot({ piAi: { providers: { [provider]: {
      api: 'openai-completions', baseURL: 'https://old.example/v1', models: [{ id: 'deepseek-v4-flash' }],
    } } } })
    let persisted: LlmPiAi.Config
    let savedKeys: Map<string, string>
    try {
      const configured = await first.service.configure({ provider, apiKey: 'synthetic-opencode-key' })
      expect(configured.providers[provider].modelCount).toBe(ids.length)
      for (const id of ids) await streamText(first.ctx, provider, id)
      expect(urls.map(url => new URL(url).pathname)).toEqual(paths)
      urls.length = 0
      await first.service.refresh({ provider })
      persisted = first.ctx.settings.get('llm-pi-ai') as LlmPiAi.Config
      expect(persisted.providers?.[provider]).toMatchObject({ catalogProvider, api: null, baseURL: null })
      savedKeys = new Map(first.credentials.values)
    } finally { await first.dispose() }
    const restarted = await boot({ piAi: persisted!, credentials: savedKeys! })
    try {
      expect((await restarted.service.snapshot()).providers[provider].modelCount).toBe(ids.length)
      for (const id of ids) await streamText(restarted.ctx, provider, id)
      expect(urls.map(url => new URL(url).pathname)).toEqual(paths)
    } finally { await restarted.dispose() }
  })

  it('rejects a Zen directory with no installed native protocol definitions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => models('unpublished-new-model')))
    const fixture = await boot()
    try {
      await expect(fixture.service.configure({ provider: 'opencode-zen', apiKey: 'synthetic-zen-key' }))
        .rejects.toThrow('GC-MODEL-UNAVAILABLE')
      expect(fixture.credentials.values.has('OPENCODE_ZEN_API_KEY')).toBe(false)
    } finally { await fixture.dispose() }
  })

  it.each([
    ['sk-kimi-synthetic', 'https://api.kimi.com/coding/v1'],
    ['sk-moonshot-synthetic', 'https://api.moonshot.ai/v1'],
  ] as const)('routes Kimi key %s consistently through configuration, refresh and restart', async (apiKey, baseURL) => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = inputUrl(input)
      requests.push(url)
      if (url === `${baseURL}/models`) return models('kimi-test-model')
      if (url === `${baseURL}/chat/completions`) return sse(OPENAI_TEXT_EVENTS)
      throw new Error(`unexpected endpoint ${url}`)
    }))
    const first = await boot()
    let persisted: LlmPiAi.Config
    let savedKeys: Map<string, string>
    try {
      await first.service.configure({ provider: 'kimi-coding', apiKey })
      await first.service.refresh({ provider: 'kimi-coding' })
      expect((await streamText(first.ctx, 'kimi-coding', 'kimi-test-model')).finish).toEqual({ kind: 'stop' })
      persisted = first.ctx.settings.get('llm-pi-ai') as LlmPiAi.Config
      savedKeys = new Map(first.credentials.values)
    } finally { await first.dispose() }
    const restarted = await boot({ piAi: persisted!, credentials: savedKeys! })
    try {
      expect((await restarted.service.snapshot()).providers['kimi-coding'].phase).toBe('ready')
      expect((await streamText(restarted.ctx, 'kimi-coding', 'kimi-test-model')).finish).toEqual({ kind: 'stop' })
      expect(requests).toEqual([
        `${baseURL}/models`, `${baseURL}/models`, `${baseURL}/chat/completions`,
        `${baseURL}/models`, `${baseURL}/chat/completions`,
      ])
    } finally { await restarted.dispose() }
  })

  it('settles a failed credential read even when its diagnostic read also fails', async () => {
    const fixture = await boot()
    try {
      await fixture.service.snapshot()
      const unavailable = new Error('Keychain is temporarily unavailable')
      vi.spyOn(fixture.credentials, 'resolve').mockRejectedValue(unavailable)
      vi.spyOn(fixture.credentials, 'describe').mockRejectedValue(unavailable)
      await expect(fixture.service.configure({ provider: 'deepseek', apiKey: 'sk-synthetic-only' })).rejects.toThrow()
      expect((await fixture.service.snapshot()).providers.deepseek).toMatchObject({ phase: 'error', failureKind: 'transient' })
    } finally { await fixture.dispose() }
  })
  it('mounts before a saved credential read finishes', async () => {
    const ctx = new Context()
    const fibers: Fiber[] = []
    fibers.push(await ctx.plugin(MemorySettings))
    fibers.push(await ctx.plugin(DeferredCredentials))
    fibers.push(await ctx.plugin(LlmRuntime))
    fibers.push(await ctx.plugin(LlmDeepSeek, {}))
    fibers.push(await ctx.plugin(LlmPiAi, {
      providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } },
    }))
    const credentials = ctx.credentials as DeferredCredentials
    const pendingFiber = ctx.plugin(GongchuangModelConnectionsService)
    const mountedBeforeCredential = await Promise.race([
      pendingFiber.then(() => true),
      new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false) }, 100) }),
    ])
    fibers.push(await pendingFiber)
    try {
      expect(mountedBeforeCredential).toBe(true)
      const snapshot = ctx.gongchuangModelConnections.snapshot()
      const settledBeforeCredential = await Promise.race([
        snapshot.then(() => true),
        new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false) }, 20) }),
      ])
      expect(settledBeforeCredential).toBe(false)
      credentials.allowReads()
      expect((await snapshot).providers.deepseek.phase).toBe('missing')
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  })

  it('publishes only the redacted model and DeepSeek Files operations', async () => {
    const { service, dispose } = await boot()
    expect(remoteMethods(service).map(method => method.method).sort()).toEqual([
      'clearDeepSeekFiles', 'configure', 'deepseekFiles', 'refresh', 'setDeepSeekFileRetention', 'snapshot',
    ])
    expect(JSON.stringify(await service.snapshot())).not.toContain('API_KEY')
    await dispose()
  })

  it('changes only the supported DeepSeek image lifetimes and reports explicit cleanup', async () => {
    const { ctx, service, dispose } = await boot()
    try {
      expect(service.deepseekFiles()).toEqual({
        retentionSeconds: 604_800,
        retentionOptions: [3_600, 604_800, 2_592_000],
      })
      await expect(service.setDeepSeekFileRetention({ retentionSeconds: 3_600 })).resolves.toEqual({
        retentionSeconds: 3_600,
        retentionOptions: [3_600, 604_800, 2_592_000],
      })
      const section = ctx.settings.get('llm-deepseek') as {
        fileExpiresAfterSeconds: number
        fileRefreshMarginSeconds: number
      }
      expect(section).toMatchObject({ fileExpiresAfterSeconds: 3_600 })
      expect(section.fileRefreshMarginSeconds).toBeLessThan(section.fileExpiresAfterSeconds)

      await expect(service.setDeepSeekFileRetention({ retentionSeconds: 86_400 as 3_600 }))
        .rejects.toThrow('只支持 1 小时、7 天或 30 天')

      vi.spyOn(ctx.deepseekFilesControl, 'releaseAll').mockResolvedValue(4)
      const receipt = await service.clearDeepSeekFiles()
      expect(receipt).toMatchObject({ deletedRemoteFiles: 4 })
      expect(Number.isNaN(Date.parse(receipt.clearedAt))).toBe(false)
      expect(JSON.stringify(receipt)).not.toMatch(/API_KEY|file_id/u)
    } finally {
      await dispose()
    }
  })

  it('commits a DeepSeek key only after an authenticated model-directory probe', async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.deepseek.com/models')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-deepseek-key')
      return models('deepseek-v4-flash', 'deepseek-v4-pro')
    })
    vi.stubGlobal('fetch', fetch)
    const { service, credentials, dispose } = await boot()
    const result = await service.configure({ provider: 'deepseek', apiKey: 'test-deepseek-key' })
    expect(result.providers.deepseek).toMatchObject({
      phase: 'ready', configured: true, modelCount: 2, selectedModel: 'deepseek-v4-flash',
    })
    expect(credentials.values.get('DEEPSEEK_API_KEY')).toBe('test-deepseek-key')
    expect(JSON.stringify(result)).not.toContain('test-deepseek-key')
    await dispose()
  })

  it('keeps a verified DeepSeek Pro-only account usable across a stored-key refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => models('deepseek-v4-pro')))
    const { service, dispose } = await boot()
    try {
      const configured = await service.configure({ provider: 'deepseek', apiKey: 'test-deepseek-key' })
      expect(configured.providers.deepseek).toMatchObject({ phase: 'ready', selectedModel: 'deepseek-v4-pro' })
      const refreshed = await service.refresh({ provider: 'deepseek' })
      expect(refreshed.providers.deepseek).toMatchObject({ phase: 'ready', selectedModel: 'deepseek-v4-pro' })
    } finally {
      await dispose()
    }
  })

  it('restores the complete DeepSeek connection when adapter adoption fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => models('deepseek-v4-flash')))
    const { ctx, service, credentials, dispose } = await boot({
      deepseek: { apiKeyEnv: 'OLD_DEEPSEEK_KEY', baseURL: 'https://old.example/v1' },
    })
    try {
      await service.snapshot()
      const previous = structuredClone(ctx.settings.get('llm-deepseek' as SettingsNamespace))
      vi.spyOn(ctx.llm, 'listProviders').mockReturnValue([])
      await expect(service.configure({ provider: 'deepseek', apiKey: 'replacement-key' })).rejects.toThrow('GC-MODEL-UNKNOWN')
      expect(ctx.settings.get('llm-deepseek' as SettingsNamespace)).toEqual(previous)
      expect(credentials.values.has('DEEPSEEK_API_KEY')).toBe(false)
      expect((await service.snapshot()).providers.deepseek.phase).toBe('error')
    } finally {
      await dispose()
    }
  })

  it('adopts a newly advertised DeepSeek model as text-only without a client release', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => models(
      'deepseek-v4-flash-vision-exp', 'deepseek-future-text',
    )))
    const { ctx, service, dispose } = await boot()
    try {
      const configured = await service.configure({ provider: 'deepseek', apiKey: 'test-deepseek-key' })
      expect(configured.providers.deepseek).toMatchObject({ phase: 'ready', modelCount: 2 })
      await expect(ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-flash-vision-exp'))
        .resolves.toMatchObject({ inputModalities: ['text', 'image'] })
      await expect(ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-future-text'))
        .resolves.toMatchObject({ inputModalities: ['text'] })
    } finally {
      await dispose()
    }
  })

  it('refreshes same-id DeepSeek metadata in the real adapter without dropping trusted capabilities', async () => {
    let metadata: Record<string, unknown> = {
      name: 'Updated Vision', context_window: 65_536, max_output_tokens: 4096,
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      data: [{ id: 'deepseek-v4-flash-vision-exp', ...metadata }],
    })))
    const { ctx, service, dispose } = await boot()
    try {
      await service.configure({ provider: 'deepseek', apiKey: 'metadata-key' })
      await expect(ctx.llm.listModels('deepseek-official')).resolves.toMatchObject([
        { id: 'deepseek-v4-flash-vision-exp', name: 'Updated Vision' },
      ])
      await expect(ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-flash-vision-exp'))
        .resolves.toMatchObject({
          context: { contextWindow: 65_536 }, defaultMaxTokens: 4096, inputModalities: ['text', 'image'],
        })

      metadata = { display_name: 'Refreshed Vision', context_length: 131_072, max_tokens: 8192 }
      await service.refresh({ provider: 'deepseek' })
      await expect(ctx.llm.listModels('deepseek-official')).resolves.toMatchObject([{ name: 'Refreshed Vision' }])
      await expect(ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-flash-vision-exp'))
        .resolves.toMatchObject({ context: { contextWindow: 131_072 }, defaultMaxTokens: 8192 })

      metadata = {}
      await service.refresh({ provider: 'deepseek' })
      await expect(ctx.llm.listModels('deepseek-official')).resolves.toMatchObject([{ name: 'Refreshed Vision' }])
      await expect(ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-flash-vision-exp'))
        .resolves.toMatchObject({
          context: { contextWindow: 131_072 }, defaultMaxTokens: 8192, inputModalities: ['text', 'image'],
        })
    } finally {
      await dispose()
    }
  })

  it('does not persist an invalid official key or publish a false ready state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    const { service, credentials, dispose } = await boot()
    await expect(service.configure({ provider: 'opencode-go', apiKey: 'invalid-opencode-key' }))
      .rejects.toThrow('GC-MODEL-AUTH')
    expect(credentials.values.has('OPENCODE_GO_API_KEY')).toBe(false)
    expect((await service.snapshot()).providers['opencode-go']).toMatchObject({ phase: 'error', configured: false })
    await dispose()
  })

  it('preserves an existing OpenCode credential when a replacement key is rejected', async () => {
    let advertised = ''
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://opencode.ai/zen/go/v1/models')
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization === 'Bearer rejected-opencode-key') return new Response('{}', { status: 401 })
      expect(authorization).toBe('Bearer retained-opencode-key')
      return models(advertised)
    }))
    const { ctx, service, credentials, dispose } = await boot()
    try {
      advertised = (await ctx.llm.listModels('opencode-go'))[0]?.id ?? ''
      expect(advertised).not.toBe('')
      await service.configure({ provider: 'opencode-go', apiKey: 'retained-opencode-key' })

      await expect(service.configure({ provider: 'opencode-go', apiKey: 'rejected-opencode-key' }))
        .rejects.toThrow('GC-MODEL-AUTH')
      expect(credentials.values.get('OPENCODE_GO_API_KEY')).toBe('retained-opencode-key')
      expect((await service.snapshot()).providers['opencode-go']).toMatchObject({ phase: 'error', configured: true })

      advertised = 'glm-5.3'
      const recovered = await service.refresh({ provider: 'opencode-go' })
      expect(recovered.providers['opencode-go']).toMatchObject({
        phase: 'ready', configured: true, selectedModel: 'glm-5.3', modelCount: 1,
      })
      await expect(ctx.llm.listModels('opencode-go')).resolves.toEqual([
        expect.objectContaining({ id: 'glm-5.3' }),
      ])
    } finally {
      await dispose()
    }
  })

  it('accepts any endpoint model the OpenCode Go adapter can actually dispatch', async () => {
    let advertised = ''
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      expect(String(input)).toBe('https://opencode.ai/zen/go/v1/models')
      return models(advertised)
    }))
    const { ctx, service, dispose } = await boot()
    try {
      advertised = (await ctx.llm.listModels('opencode-go'))[0]?.id ?? ''
      expect(advertised).not.toBe('')
      const result = await service.configure({ provider: 'opencode-go', apiKey: 'test-opencode-key' })
      expect(result.providers['opencode-go']).toMatchObject({
        phase: 'ready', selectedModel: advertised, modelCount: 1,
      })
    } finally {
      await dispose()
    }
  })

  it('prefers DeepSeek V4 Flash over the free alias when both OpenCode routes are available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => models(
      'deepseek-v4-flash-free', 'deepseek-v4-pro', 'deepseek-v4-flash',
    )))
    const { ctx, service, dispose } = await boot()
    try {
      const result = await service.configure({ provider: 'opencode-go', apiKey: 'test-opencode-key' })
      expect(result.providers['opencode-go']).toMatchObject({
        phase: 'ready', selectedModel: 'deepseek-v4-flash',
      })
      const info = await ctx.llm.resolveModelInfo('opencode-go', 'deepseek-v4-pro')
      expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'high', 'max'])
    } finally {
      await dispose()
    }
  })

  it('inherits OpenCode Go reasoning efforts for DeepSeek V4 Flash Vision Exp', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => models('deepseek-v4-flash-vision-exp')))
    const { ctx, service, dispose } = await boot()
    try {
      await service.configure({ provider: 'opencode-go', apiKey: 'test-opencode-key' })
      const info = await ctx.llm.resolveModelInfo('opencode-go', 'deepseek-v4-flash-vision-exp')
      expect(info.inputModalities).toEqual(['text', 'image'])
      expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'high', 'max'])
    } finally {
      await dispose()
    }
  })

  it('does not guess the protocol of an unknown OpenCode Go model or replace the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => models('future-model-not-in-this-client')))
    const { ctx, service, credentials, dispose } = await boot()
    try {
      await expect(service.configure({ provider: 'opencode-go', apiKey: 'valid-future-model-key' }))
        .rejects.toThrow('GC-MODEL-UNAVAILABLE')
      expect(credentials.values.has('OPENCODE_GO_API_KEY')).toBe(false)
      expect(ctx.settings.get('llm-pi-ai')).toMatchObject({ providers: {} })
    } finally {
      await dispose()
    }
  })

  it('probes and atomically registers one custom API route without exposing its key', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      expect(String(input)).toBe('https://custom.example/v1/models')
      return models('custom-chat')
    }))
    const { ctx, service, credentials, dispose } = await boot()
    const result = await service.configure({
      provider: 'custom', displayName: '企业自建模型', baseURL: 'https://custom.example/v1',
      protocol: 'openai-completions', modelId: 'custom-chat', apiKey: 'test-custom-key',
    })
    expect(result.providers.custom).toMatchObject({
      phase: 'ready', configured: true, selectedModel: 'custom-chat', modelCount: 1,
      configuration: {
        displayName: '企业自建模型', baseURL: 'https://custom.example/v1',
        protocol: 'openai-completions', modelId: 'custom-chat',
      },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('custom-api')
    const customRef = [...credentials.values.keys()].find(key => key.startsWith('GONGCHUANG_CUSTOM_API_'))
    expect(customRef).toBeDefined()
    expect(credentials.values.get(customRef!)).toBe('test-custom-key')
    const descriptor = ctx.settings.describe().find(row => row.ns === 'llm-pi-ai')
    expect(JSON.stringify(descriptor)).toContain(customRef!)
    expect(JSON.stringify(descriptor)).not.toContain('test-custom-key')
    expect(JSON.stringify(result)).not.toContain(customRef!)
    await dispose()
  })

  it('registers an explicit text candidate when a custom endpoint has no model directory', async () => {
    const requests: Array<{ method: string; url: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = { method: requestMethod(input, init), url: inputUrl(input) }
      requests.push(request)
      if (request.method === 'GET') return new Response('{}', { status: 404 })
      return sse(OPENAI_TEXT_EVENTS)
    }))
    const { ctx, service, credentials, dispose } = await boot()
    try {
      const configured = await service.configure({
        provider: 'custom', displayName: '无目录兼容端点', baseURL: 'https://custom.example/v1',
        protocol: 'openai-completions', modelId: 'manual-text-model', apiKey: 'manual-model-key',
      })
      expect(configured.providers.custom).toMatchObject({
        phase: 'candidate', configured: true, verifiedAt: null,
        selectedModel: 'manual-text-model', modelCount: 1,
      })
      await expect(ctx.llm.listModels('custom-api')).resolves.toEqual([
        expect.objectContaining({
          id: 'manual-text-model', inputModalities: ['text'],
        }),
      ])
      expect(JSON.stringify(ctx.settings.get('llm-pi-ai')))
        .toContain('"reasoningEfforts":false')
      expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
      expect((await service.snapshot()).providers.custom).toMatchObject({
        phase: 'candidate', configured: true, selectedModel: 'manual-text-model',
      })
      expect([...credentials.values.values()]).toContain('manual-model-key')
    } finally {
      await dispose()
    }
  })

  it('rejects a custom endpoint without a model directory when no exact model id is supplied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 405 })))
    const { ctx, service, credentials, dispose } = await boot()
    try {
      await expect(service.configure({
        provider: 'custom', displayName: '缺少模型身份', baseURL: 'https://custom.example/v1',
        protocol: 'openai-responses', apiKey: 'candidate-key',
      })).rejects.toThrow('GC-MODEL-UNKNOWN')
      expect((await service.snapshot()).providers.custom).toMatchObject({ phase: 'error', configured: false })
      expect([...credentials.values.keys()].some(key => key.startsWith('GONGCHUANG_CUSTOM_API_'))).toBe(false)
      expect(JSON.stringify(ctx.settings.get('llm-pi-ai' as never))).not.toContain('custom-api')
    } finally {
      await dispose()
    }
  })

  it('keeps relay presets independent without inferring capabilities from model names', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const authorization = new Headers(init?.headers).get('authorization')
      if (url === 'https://openrouter.ai/api/v1/models') {
        expect(authorization).toBe('Bearer siliconflow-key')
        return models('deepseek-v4-pro', 'deepseek-v4-flash')
      }
      if (url === 'https://api.fireworks.ai/inference/v1/models') {
        expect(authorization).toBe('Bearer orgarid-key')
        return models('deepseek-ai/DeepSeek-V4-Flash', 'deepseek-v4-pro', 'orgarid-other')
      }
      throw new Error(`unexpected probe ${url}`)
    }))
    const { ctx, service, credentials, dispose } = await boot()
    try {
      const siliconflow = await service.configure({ provider: 'openrouter', apiKey: 'siliconflow-key' })
      const orgarid = await service.configure({ provider: 'fireworks', apiKey: 'orgarid-key' })
      expect(siliconflow.providers.openrouter).toMatchObject({
        phase: 'ready', configured: true, selectedModel: 'deepseek-v4-flash', modelCount: 2,
      })
      expect(orgarid.providers.fireworks).toMatchObject({
        phase: 'ready', configured: true, selectedModel: 'deepseek-ai/DeepSeek-V4-Flash', modelCount: 3,
      })
      expect(credentials.values.get('OPENROUTER_API_KEY')).toBe('siliconflow-key')
      expect(credentials.values.get('FIREWORKS_API_KEY')).toBe('orgarid-key')
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(expect.arrayContaining([
        'openrouter', 'fireworks',
      ]))
      const descriptor = ctx.settings.describe().find(row => row.ns === 'llm-pi-ai')
      expect(JSON.stringify(descriptor)).toContain('https://openrouter.ai/api/v1')
      expect(JSON.stringify(descriptor)).toContain('https://api.fireworks.ai/inference/v1')
      expect(JSON.stringify(descriptor)).not.toContain('siliconflow-key')
      expect(JSON.stringify(descriptor)).not.toContain('orgarid-key')
      const section = ctx.settings.get('llm-pi-ai') as {
        providers: Record<string, { models: Array<Record<string, unknown>> }>
      }
      const orgaridModels = section.providers.fireworks!.models
      expect(orgaridModels).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'deepseek-ai/DeepSeek-V4-Flash', input: ['text'], reasoningEfforts: false }),
        expect.objectContaining({ id: 'deepseek-v4-pro', input: ['text'], reasoningEfforts: false }),
        expect.objectContaining({ id: 'orgarid-other', input: ['text'], reasoningEfforts: false }),
      ]))
      await expect(ctx.llm.resolveModelInfo('fireworks', 'deepseek-ai/DeepSeek-V4-Flash'))
        .resolves.not.toHaveProperty('reasoning')
      await expect(ctx.llm.resolveModelInfo('fireworks', 'deepseek-v4-pro')).resolves.not.toHaveProperty('reasoning')
    } finally {
      await dispose()
    }
  })

  it('refreshes a managed relay catalog in place and adopts a replacement selection', async () => {
    let current = ['deepseek-v4-flash', 'relay-old']
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      expect(String(input)).toBe('https://api.fireworks.ai/inference/v1/models')
      return models(...current)
    }))
    const { ctx, service, credentials, dispose } = await boot()
    try {
      await service.configure({ provider: 'fireworks', apiKey: 'orgarid-key' })
      expect((await service.snapshot()).providers.fireworks).toMatchObject({
        phase: 'ready', selectedModel: 'deepseek-v4-flash', modelCount: 2,
      })

      current = ['relay-new', 'relay-second']
      const refreshed = await service.refresh({ provider: 'fireworks' })
      expect(refreshed.providers.fireworks).toMatchObject({
        phase: 'ready', selectedModel: 'relay-new', modelCount: 2,
        message: 'Fireworks AI 模型列表已刷新，可用模型 2 个',
      })
      expect(credentials.values.get('FIREWORKS_API_KEY')).toBe('orgarid-key')
      const section = ctx.settings.get('llm-pi-ai') as {
        providers: Record<string, { models: Array<{ id: string }> }>
      }
      expect(section.providers.fireworks?.models.map(model => model.id)).toEqual(current)
      await expect(ctx.llm.listModels('fireworks')).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'relay-new' }),
        expect.objectContaining({ id: 'relay-second' }),
      ]))
    } finally {
      await dispose()
    }
  })

  it('refreshes every shared relay without racing llm-pi-ai revisions', async () => {
    const refreshedModels = new Map([
      ['https://opencode.ai/zen/go/v1/models', 'glm-5.3'],
      ['https://openrouter.ai/api/v1/models', 'siliconflow-refreshed'],
      ['https://api.fireworks.ai/inference/v1/models', 'orgarid-refreshed'],
    ])
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const model = refreshedModels.get(String(input))
      if (model === undefined) throw new Error(`unexpected probe ${String(input)}`)
      return models(model)
    }))
    const { service, dispose } = await boot()
    try {
      await service.configure({ provider: 'opencode-go', apiKey: 'opencode-key' })
      await service.configure({ provider: 'openrouter', apiKey: 'siliconflow-key' })
      await service.configure({ provider: 'fireworks', apiKey: 'orgarid-key' })

      const refreshed = await service.refresh({})
      expect(refreshed.providers['opencode-go']).toMatchObject({
        phase: 'ready', selectedModel: 'glm-5.3', modelCount: 1,
      })
      expect(refreshed.providers.openrouter).toMatchObject({
        phase: 'ready', selectedModel: 'siliconflow-refreshed', modelCount: 1,
      })
      expect(refreshed.providers.fireworks).toMatchObject({
        phase: 'ready', selectedModel: 'orgarid-refreshed', modelCount: 1,
      })
    } finally {
      await dispose()
    }
  })

  it('isolates a relay credential read failure and continues refreshing later providers', async () => {
    const current = new Map([
      ['https://opencode.ai/zen/go/v1/models', 'glm-5.3'],
      ['https://openrouter.ai/api/v1/models', 'siliconflow-current'],
    ])
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const model = current.get(String(input))
      if (model === undefined) throw new Error(`unexpected probe ${String(input)}`)
      return models(model)
    }))
    const { service, credentials, dispose } = await boot()
    try {
      await service.configure({ provider: 'opencode-go', apiKey: 'opencode-key' })
      await service.configure({ provider: 'openrouter', apiKey: 'siliconflow-key' })
      current.set('https://openrouter.ai/api/v1/models', 'siliconflow-refreshed')
      const resolveCredential = credentials.resolve.bind(credentials)
      vi.spyOn(credentials, 'resolve').mockImplementation(async (ref) => {
        if (String(ref) === 'OPENCODE_GO_API_KEY') throw new Error('credential store unavailable')
        return resolveCredential(ref)
      })

      const refreshed = await service.refresh({})

      expect(refreshed.providers['opencode-go']).toMatchObject({
        phase: 'error', configured: true, selectedModel: 'glm-5.3', modelCount: 1,
      })
      expect(refreshed.providers.openrouter).toMatchObject({
        phase: 'ready', configured: true, selectedModel: 'siliconflow-refreshed', modelCount: 1,
      })
    } finally {
      await dispose()
    }
  })

  it('classifies relay refresh failures without publishing the retained catalog as current', async () => {
    let status = 200
    vi.stubGlobal('fetch', vi.fn(async () => status === 200
      ? models('glm-5.3')
      : new Response('{}', { status })))
    const { service, dispose } = await boot()
    try {
      await service.configure({ provider: 'opencode-go', apiKey: 'opencode-key' })

      status = 503
      const transient = await service.refresh({ provider: 'opencode-go' })
      expect(transient.providers['opencode-go']).toMatchObject({
        phase: 'error', failureKind: 'transient', modelCount: 1,
      })

      status = 401
      const auth = await service.refresh({ provider: 'opencode-go' })
      expect(auth.providers['opencode-go']).toMatchObject({
        phase: 'error', failureKind: 'auth', modelCount: 1,
      })
    } finally {
      await dispose()
    }
  })

  it('keeps an unsupported managed directory as an unverified candidate after refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    const { service, dispose } = await boot()
    try {
      await service.configure({ provider: 'opencode-go', apiKey: 'manual-key', modelId: 'glm-5.3' })
      const refreshed = await service.refresh({ provider: 'opencode-go' })
      expect(refreshed.providers['opencode-go']).toMatchObject({
        phase: 'candidate', configured: true, verifiedAt: null, modelCount: 1, selectedModel: 'glm-5.3',
      })
    } finally {
      await dispose()
    }
  })

  it.each([
    { provider: 'lmstudio', baseURL: 'http://127.0.0.1:2345/v1' },
    { provider: 'azure-foundry', baseURL: 'https://azure.example/v1' },
  ] as const)('retains the approved $provider address on refresh', async ({ provider, baseURL }) => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      expect(inputUrl(input)).toBe(`${baseURL}/models`)
      return models('endpoint-owned-model')
    })
    vi.stubGlobal('fetch', fetch)
    const { service, dispose } = await boot()
    try {
      await service.configure({ provider, baseURL, apiKey: 'endpoint-key' })
      const refreshed = await service.refresh({ provider })
      expect(refreshed.providers[provider]).toMatchObject({ phase: 'ready', selectedModel: 'endpoint-owned-model' })
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      await dispose()
    }
  })

  it.each(['configure', 'refresh'] as const)('exits checking and reports incomplete profile rollback during %s', async (operation) => {
    vi.stubGlobal('fetch', vi.fn(async () => models('glm-5.3')))
    const { ctx, service, credentials, dispose } = await boot()
    try {
      await service.configure({ provider: 'opencode-go', apiKey: 'original-key' })
      const mutate = ctx.settings.mutate.bind(ctx.settings)
      let writes = 0
      vi.spyOn(ctx.settings, 'mutate').mockImplementation(async (...args) => {
        writes += 1
        if (writes === 2) throw new Error('simulated rollback disk failure')
        return mutate(...args)
      })
      vi.spyOn(ctx.llm, 'listProviders').mockReturnValue([])
      if (operation === 'configure') {
        await expect(service.configure({ provider: 'opencode-go', apiKey: 'replacement-key' })).rejects.toThrow('GC-MODEL-UNKNOWN')
      } else {
        await service.refresh({ provider: 'opencode-go' })
      }
      expect(writes).toBe(2)
      expect(credentials.values.get('OPENCODE_GO_API_KEY')).toBe('original-key')
      const status = (await service.snapshot()).providers['opencode-go']
      expect(status).toMatchObject({ phase: 'error', verifiedAt: null })
      expect(status.message).toContain('请重新配置')
    } finally {
      await dispose()
    }
  })

  it('reports incomplete credential recovery after independently restoring the prior profile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => models('glm-5.3')))
    const { ctx, service, credentials, dispose } = await boot()
    try {
      await service.configure({ provider: 'opencode-go', apiKey: 'original-key' })
      const previous = structuredClone(ctx.settings.get('llm-pi-ai' as SettingsNamespace))
      const set = credentials.set.bind(credentials)
      vi.spyOn(credentials, 'set').mockImplementation(async (ref, value) => {
        if (value === 'original-key') throw new Error('simulated keychain restore failure')
        return set(ref, value)
      })
      vi.spyOn(ctx.llm, 'listProviders').mockReturnValue([])
      await expect(service.configure({ provider: 'opencode-go', apiKey: 'replacement-key' }))
        .rejects.toThrow('请重新配置')
      expect(ctx.settings.get('llm-pi-ai' as SettingsNamespace)).toEqual(previous)
      expect(credentials.values.get('OPENCODE_GO_API_KEY')).toBe('replacement-key')
      const status = (await service.snapshot()).providers['opencode-go']
      expect(status).toMatchObject({ phase: 'error', verifiedAt: null })
      expect(status.message).toContain('旧配置未完整恢复')
      expect(status.message).not.toContain('replacement-key')
    } finally {
      await dispose()
    }
  })

  it('registers and refreshes the complete custom endpoint catalog', async () => {
    let current = ['custom-a', 'custom-b']
    vi.stubGlobal('fetch', vi.fn(async () => models(...current)))
    const { ctx, service, dispose } = await boot()
    try {
      const configured = await service.configure({
        provider: 'custom', displayName: '企业自建模型', baseURL: 'https://custom.example/v1',
        protocol: 'openai-completions', modelId: 'custom-a', apiKey: 'test-custom-key',
      })
      expect(configured.providers.custom).toMatchObject({ modelCount: 2, selectedModel: 'custom-a' })
      await expect(ctx.llm.listModels('custom-api')).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'custom-a', inputModalities: ['text'] }),
        expect.objectContaining({ id: 'custom-b', inputModalities: ['text'] }),
      ]))

      current = ['custom-b', 'custom-c']
      const refreshed = await service.refresh({ provider: 'custom' })
      expect(refreshed.providers.custom).toMatchObject({ modelCount: 2, selectedModel: 'custom-b' })
      await expect(ctx.llm.listModels('custom-api')).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'custom-b', inputModalities: ['text'] }),
        expect.objectContaining({ id: 'custom-c', inputModalities: ['text'] }),
      ]))
    } finally {
      await dispose()
    }
  })

  it('refreshes a stored custom connection once at startup and ignores later topology notifications', async () => {
    const fetch = vi.fn(async (input: string | URL) => {
      expect(String(input)).toBe('https://custom.example/v1/models')
      return models('custom-chat')
    })
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    const fibers: Fiber[] = []
    fibers.push(await ctx.plugin(MemorySettings))
    fibers.push(await ctx.plugin(MemoryCredentials))
    fibers.push(await ctx.plugin(LlmRuntime))
    fibers.push(await ctx.plugin(LlmDeepSeek, {}))
    const credentials = ctx.credentials as MemoryCredentials
    credentials.values.set('GONGCHUANG_CUSTOM_API_RESTART', 'stored-custom-key')
    fibers.push(await ctx.plugin(LlmPiAi, {
      providers: {
        'custom-api': {
          apiKeyEnv: 'GONGCHUANG_CUSTOM_API_RESTART',
          displayName: '重启恢复接口',
          api: 'openai-completions',
          baseURL: 'https://custom.example/v1',
          models: [{
            id: 'custom-chat', name: '企业模型', contextWindow: 131_072,
            maxTokens: 8_192, input: ['text'], reasoningEfforts: false,
          }],
        },
      },
    }))
    fibers.push(await ctx.plugin(GongchuangModelConnectionsService))
    const service = ctx.gongchuangModelConnections

    try {
      await vi.waitFor(async () => {
        expect((await service.snapshot()).providers.custom).toMatchObject({
          phase: 'ready', configured: true, selectedModel: 'custom-chat', modelCount: 1,
          configuration: {
            displayName: '重启恢复接口', baseURL: 'https://custom.example/v1',
            protocol: 'openai-completions', modelId: 'custom-chat',
          },
        })
      })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(ctx.settings.get('llm-pi-ai' as SettingsNamespace)).toMatchObject({
        providers: {
          'custom-api': {
            models: [{
              id: 'custom-chat', name: '企业模型', contextWindow: 131_072,
              maxTokens: 8_192, input: ['text'], reasoningEfforts: false,
            }],
          },
        },
      })
      const namespace = 'llm-pi-ai' as SettingsNamespace
      ctx.emit('settings/updated', namespace, ctx.settings.get(namespace), {}, 'provider')
      ctx.emit('credentials/reference-updated', 'GONGCHUANG_CUSTOM_API_RESTART' as CredentialRef)
      ctx.emit('llm/adapters-updated')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  })

  it('does not echo credential-bearing legacy URLs into editable settings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => models('custom-chat')))
    const { service, dispose } = await boot({
      credentials: new Map([['GONGCHUANG_CUSTOM_API_LEGACY', 'stored-test-key']]),
      piAi: { providers: { 'custom-api': {
        apiKeyEnv: 'GONGCHUANG_CUSTOM_API_LEGACY', displayName: 'Legacy endpoint',
        api: 'openai-completions', baseURL: 'https://custom.example/v1?key=legacy-secret',
        models: [{ id: 'custom-chat', name: 'Test', contextWindow: 8192, maxTokens: 1024, input: ['text'], reasoningEfforts: false }],
      } } },
    })
    try {
      await service.refresh({ provider: 'custom' })
      const snapshot = await service.snapshot()
      expect(snapshot.providers.custom.phase).toBe('error')
      expect(snapshot.providers.custom.configuration).toBeUndefined()
      expect(JSON.stringify(snapshot)).not.toContain('legacy-secret')
      expect(JSON.stringify(snapshot)).not.toContain('stored-test-key')
    } finally {
      await dispose()
    }
  })

  it('rolls settings and credentials back when the configured custom route is not registered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => models('custom-chat')))
    const { ctx, service, credentials, dispose } = await boot()
    vi.spyOn(ctx.llm, 'listProviders').mockReturnValue([])
    await expect(service.configure({
      provider: 'custom', displayName: '故障候选', baseURL: 'https://custom.example/v1',
      protocol: 'openai-completions', apiKey: 'candidate-key',
    })).rejects.toThrow('GC-MODEL-UNKNOWN')
    const descriptor = ctx.settings.describe().find(row => row.ns === 'llm-pi-ai')
    expect(JSON.stringify(descriptor)).not.toContain('custom-api')
    expect([...credentials.values.keys()].some(key => key.startsWith('GONGCHUANG_CUSTOM_API_'))).toBe(false)
    expect((await service.snapshot()).providers.custom).toMatchObject({ phase: 'error', configured: false })
    await dispose()
  })

  it('carries DeepSeek, OpenCode Go, and a custom API through their real adapters to streamed replies', async () => {
    const calls: { method: string; url: string; authorization: string | null }[] = []
    let openCodeModel = ''
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = inputUrl(input)
      const method = requestMethod(input, init)
      const inputHeaders = input instanceof Request ? input.headers : undefined
      const headers = new Headers(init?.headers ?? inputHeaders)
      calls.push({ method, url, authorization: headers.get('authorization') })
      if (method === 'GET' && url === 'https://api.deepseek.com/models') {
        return models('deepseek-v4-flash', 'deepseek-v4-pro')
      }
      if (method === 'GET' && url === 'https://opencode.ai/zen/go/v1/models') {
        return models(openCodeModel)
      }
      if (method === 'GET' && url === 'https://custom.example/v1/models') {
        return models('custom-chat')
      }
      if (method === 'POST' && url === 'https://api.deepseek.com/chat/completions') {
        return sse(DEEPSEEK_TEXT_EVENTS)
      }
      if (method === 'POST' && (url === 'https://opencode.ai/zen/go/v1/chat/completions'
        || url === 'https://custom.example/v1/chat/completions')) {
        return sse(OPENAI_TEXT_EVENTS)
      }
      throw new Error(`unexpected model request ${method} ${url}`)
    }))

    const { ctx, service, dispose } = await boot()
    try {
      const openCodeModels = await ctx.llm.listModels('opencode-go')
      openCodeModel = openCodeModels.find(model => model.id === 'deepseek-v4-flash')?.id ?? ''
      expect(openCodeModel).not.toBe('')
      const deepseek = await service.configure({ provider: 'deepseek', apiKey: 'deepseek-test-key' })
      const opencode = await service.configure({ provider: 'opencode-go', apiKey: 'opencode-test-key' })
      const custom = await service.configure({
        provider: 'custom', displayName: '企业自建模型', baseURL: 'https://custom.example/v1',
        protocol: 'openai-completions', modelId: 'custom-chat', apiKey: 'custom-test-key',
      })

      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(expect.arrayContaining([
        'deepseek-official', 'opencode-go', 'custom-api',
      ]))
      const replies = await Promise.all([
        streamText(ctx, 'deepseek-official', deepseek.providers.deepseek.selectedModel!),
        streamText(ctx, 'opencode-go', opencode.providers['opencode-go'].selectedModel!),
        streamText(ctx, 'custom-api', custom.providers.custom.selectedModel!),
      ])
      expect(replies).toEqual([
        { text: '三路连接真实可用', finish: { kind: 'stop' } },
        { text: '三路连接真实可用', finish: { kind: 'stop' } },
        { text: '三路连接真实可用', finish: { kind: 'stop' } },
      ])
      expect(calls.filter(call => call.method === 'POST')).toEqual(expect.arrayContaining([
        expect.objectContaining({ url: 'https://api.deepseek.com/chat/completions', authorization: 'Bearer deepseek-test-key' }),
        expect.objectContaining({ url: 'https://opencode.ai/zen/go/v1/chat/completions', authorization: 'Bearer opencode-test-key' }),
        expect.objectContaining({ url: 'https://custom.example/v1/chat/completions', authorization: 'Bearer custom-test-key' }),
      ]))
    } finally {
      await dispose()
    }
  })

  it('commits the verified DeepSeek endpoint and credential reference for dispatch and restart', async () => {
    const requests: { url: string; authorization: string | null }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = inputUrl(input)
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      requests.push({ url, authorization: headers.get('authorization') })
      if (url === 'https://api.deepseek.com/models') return models('deepseek-v4-flash')
      if (url === 'https://api.deepseek.com/chat/completions') return sse(DEEPSEEK_TEXT_EVENTS)
      throw new Error(`unexpected endpoint ${url}`)
    }))
    const first = await boot({ deepseek: { apiKeyEnv: 'OLD_DEEPSEEK_KEY', baseURL: 'https://old.example/v1' } })
    let persisted: LlmDeepSeek.Config
    let savedKeys: Map<string, string>
    try {
      await first.service.snapshot()
      first.credentials.values.set('OLD_DEEPSEEK_KEY', 'old-key')
      await first.service.configure({ provider: 'deepseek', apiKey: 'replacement-key' })
      persisted = first.ctx.settings.get('llm-deepseek') as LlmDeepSeek.Config
      expect(persisted).toMatchObject({ apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' })
      expect((await streamText(first.ctx, 'deepseek-official', 'deepseek-v4-flash')).finish).toEqual({ kind: 'stop' })
      savedKeys = new Map(first.credentials.values)
    } finally {
      await first.dispose()
    }
    const restarted = await boot({ deepseek: persisted!, credentials: savedKeys! })
    try {
      expect((await restarted.service.snapshot()).providers.deepseek.phase).toBe('ready')
      expect((await streamText(restarted.ctx, 'deepseek-official', 'deepseek-v4-flash')).finish).toEqual({ kind: 'stop' })
      expect(requests.filter(request => request.url.endsWith('/chat/completions'))).toEqual([
        { url: 'https://api.deepseek.com/chat/completions', authorization: 'Bearer replacement-key' },
        { url: 'https://api.deepseek.com/chat/completions', authorization: 'Bearer replacement-key' },
      ])
    } finally {
      await restarted.dispose()
    }
  })

  it('refreshes legacy managed profiles onto the same connection that was probed', async () => {
    const requests: { url: string; authorization: string | null }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = inputUrl(input)
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      requests.push({ url, authorization: headers.get('authorization') })
      if (url === 'https://opencode.ai/zen/go/v1/models') return models('deepseek-v4-flash')
      if (url === 'https://opencode.ai/zen/go/v1/chat/completions') return sse(OPENAI_TEXT_EVENTS)
      throw new Error(`unexpected endpoint ${url}`)
    }))
    const first = await boot({
      piAi: { providers: { 'opencode-go': {
        apiKeyEnv: 'OPENCODE_API_KEY', displayName: 'Old route', api: 'openai-responses',
        baseURL: 'https://old.example/v1', models: [{ id: 'deepseek-v4-flash' }],
      } } },
      credentials: new Map([['OPENCODE_GO_API_KEY', 'replacement-key'], ['OPENCODE_API_KEY', 'old-key']]),
    })
    let persisted: LlmPiAi.Config
    let savedKeys: Map<string, string>
    try {
      expect((await first.service.snapshot()).providers['opencode-go'].phase).toBe('ready')
      persisted = first.ctx.settings.get('llm-pi-ai') as LlmPiAi.Config
      expect(persisted).toMatchObject({ providers: { 'opencode-go': {
        apiKeyEnv: 'OPENCODE_GO_API_KEY', catalogProvider: 'opencode-go', api: null, baseURL: null,
      } } })
      expect((await streamText(first.ctx, 'opencode-go', 'deepseek-v4-flash')).finish).toEqual({ kind: 'stop' })
      savedKeys = new Map(first.credentials.values)
    } finally {
      await first.dispose()
    }
    const restarted = await boot({ piAi: persisted!, credentials: savedKeys! })
    try {
      expect((await restarted.service.snapshot()).providers['opencode-go'].phase).toBe('ready')
      expect((await streamText(restarted.ctx, 'opencode-go', 'deepseek-v4-flash')).finish).toEqual({ kind: 'stop' })
      expect(requests.every(request => request.authorization === 'Bearer replacement-key')).toBe(true)
      expect(requests.filter(request => request.url.endsWith('/chat/completions'))).toHaveLength(2)
    } finally {
      await restarted.dispose()
    }
  })
})
