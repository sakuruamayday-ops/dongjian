import { describe, expect, it, vi } from 'vitest'
import type { GongchuangModelConnectionsSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { GONGCHUANG_MODEL_PROVIDERS } from '@gongchuang/model-connections/registry'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { ConnectivityController } from '../src/client/connectivity.ts'

function remoteOk<T>(value: T) {
  return Promise.resolve({ ok: true as const, value })
}

function deepseekFiles() {
  return remoteOk({
    retentionSeconds: 3_600,
    retentionOptions: [3_600, 604_800, 2_592_000] as const,
  })
}

function snapshot(
  opencodeGo: GongchuangModelConnectionsSnapshot['providers']['opencode-go'],
): GongchuangModelConnectionsSnapshot {
  const providers = Object.fromEntries(GONGCHUANG_MODEL_PROVIDERS.map(provider => [provider.id, {
    provider: provider.id,
    route: provider.route,
    phase: 'missing',
    configured: false,
    verifiedAt: null,
    modelCount: 0,
    selectedModel: null,
    message: '尚未配置 API Key',
  }])) as unknown as GongchuangModelConnectionsSnapshot['providers']
  return {
    revision: 1,
    providers: {
      ...providers,
      'opencode-go': opencodeGo,
    },
  }
}

function llm() {
  const providers = [
    {
      provider: 'deepseek-official', displayName: 'DeepSeek', active: true, declared: true,
      settingsNs: 'llm-deepseek', settingsPath: [],
    },
    {
      provider: 'opencode-go', displayName: 'OpenCode Go', active: true, declared: true,
      settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'],
    },
    {
      provider: 'openrouter', displayName: 'OpenRouter', active: true, declared: true,
      settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'],
    },
    {
      provider: 'fireworks', displayName: 'Fireworks AI', active: true, declared: true,
      settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'fireworks'],
    },
    {
      provider: 'custom-api', displayName: '自定义 API', active: true, declared: true,
      settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'custom-api'],
    },
  ]
  return {
    listProviders: vi.fn(() => remoteOk(providers
      .filter(entry => entry.active)
      .map(entry => ({ id: entry.provider, name: entry.displayName })))),
    listConfigurableProviders: vi.fn(() => remoteOk(providers.map(({ active: _active, ...entry }) => entry))),
  }
}

const deepseekRoute = () => 'deepseek-official'

describe('ConnectivityController', () => {
  it('rechecks only the responding route after Keychain access recovers', async () => {
    let current = snapshot({
      provider: 'opencode-go', route: 'opencode-go', phase: 'error', configured: false,
      verifiedAt: null, modelCount: 0, selectedModel: null,
      message: '系统凭据暂不可用（诊断码：GC-MODEL-KEYCHAIN）', failureKind: 'transient',
    })
    const remote = {
      snapshot: vi.fn(() => remoteOk(current)), deepseekFiles: vi.fn(deepseekFiles),
      configure: vi.fn(), clearDeepSeekFiles: vi.fn(), setDeepSeekFileRetention: vi.fn(),
      refresh: vi.fn(async () => {
        current = snapshot({
          ...current.providers['opencode-go'], phase: 'ready', configured: true,
          verifiedAt: '2026-09-04T07:00:00Z', modelCount: 1, selectedModel: 'qa-model', message: '已连接',
        })
        return { ok: true as const, value: current }
      }),
    }
    const controller = new ConnectivityController(llm(), remote, deepseekRoute)
    await controller.load()
    await controller.recoverAfterResponse('unknown')
    await controller.recoverAfterResponse('deepseek-official')
    expect(remote.refresh).not.toHaveBeenCalled()
    const recovery = controller.recoverAfterResponse('opencode-go')
    await controller.recoverAfterResponse('opencode-go')
    await recovery
    expect(remote.refresh).toHaveBeenCalledExactlyOnceWith({ provider: 'opencode-go' })
    expect(controller.store.getSnapshot().providers['opencode-go']).toMatchObject({ status: 'ready', configured: true })
    await controller.recoverAfterResponse('opencode-go')
    expect(remote.refresh).toHaveBeenCalledTimes(1)
  })

  it('does not treat a model response as a successful catalog probe', async () => {
    let current = snapshot({
      provider: 'opencode-go', route: 'opencode-go', phase: 'error', configured: true,
      verifiedAt: null, modelCount: 0, selectedModel: null,
      message: '系统凭据暂不可用（诊断码：GC-MODEL-KEYCHAIN）', failureKind: 'transient',
    })
    const remote = {
      snapshot: vi.fn(() => remoteOk(current)), deepseekFiles: vi.fn(deepseekFiles),
      configure: vi.fn(), clearDeepSeekFiles: vi.fn(), setDeepSeekFileRetention: vi.fn(),
      refresh: vi.fn(() => remoteOk(current)),
    }
    const controller = new ConnectivityController(llm(), remote, deepseekRoute)
    await controller.load()
    await expect(controller.recoverAfterResponse('opencode-go')).rejects.toThrow('GC-MODEL-KEYCHAIN')
    expect(controller.store.getSnapshot().providers['opencode-go'].status).toBe('error')
    current = snapshot({ ...current.providers['opencode-go'], message: '网络暂不可用' })
    await controller.load()
    await controller.recoverAfterResponse('opencode-go')
    expect(remote.refresh).toHaveBeenCalledTimes(1)
  })

  it.each(['inactive', 'absent'] as const)('keeps credential errors actionable when the adapter is %s', async (mode) => {
    const error = snapshot({
      provider: 'opencode-go', route: 'opencode-go', phase: 'error', configured: false,
      verifiedAt: null, modelCount: 0, selectedModel: null,
      message: '系统凭据暂不可用，请允许系统访问后重试（诊断码：GC-MODEL-KEYCHAIN）',
      failureKind: 'transient',
    })
    const directory = llm()
    directory.listProviders.mockImplementation(() => remoteOk([]))
    if (mode === 'absent') directory.listConfigurableProviders.mockImplementation(() => remoteOk([]))
    const remote = {
      snapshot: vi.fn(() => remoteOk(error)), deepseekFiles: vi.fn(deepseekFiles),
      configure: vi.fn(), refresh: vi.fn(), clearDeepSeekFiles: vi.fn(), setDeepSeekFileRetention: vi.fn(),
    }
    const controller = new ConnectivityController(directory, remote, deepseekRoute)
    await controller.load()
    expect(controller.store.getSnapshot().providers['opencode-go']).toMatchObject({
      status: 'error', configured: false, route: 'opencode-go', failureKind: 'transient',
      message: error.providers['opencode-go'].message,
    })
  })

  it('binds OpenCode to opencode-go but refuses to call a declared route ready without a Host probe', async () => {
    const missing = snapshot({
      provider: 'opencode-go', route: 'opencode-go', phase: 'missing', configured: false,
      verifiedAt: null, modelCount: 0, selectedModel: null, message: '尚未配置 API Key',
    })
    const remote = {
      snapshot: vi.fn(() => remoteOk(missing)),
      deepseekFiles: vi.fn(deepseekFiles),
      configure: vi.fn(),
      refresh: vi.fn(),
      clearDeepSeekFiles: vi.fn(), setDeepSeekFileRetention: vi.fn(),
    }
    const controller = new ConnectivityController(llm(), remote, deepseekRoute)
    await controller.load()
    expect(remote.refresh).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().providers['opencode-go']).toEqual({
      status: 'missing', configured: false, route: 'opencode-go', message: '尚未配置 API Key',
    })
    expect(controller.store.getSnapshot().activeProvider).toBe('deepseek')
  })

  it('projects the persisted Host route back to the custom product selector after restart', async () => {
    const base = snapshot({
      provider: 'opencode-go', route: 'opencode-go', phase: 'missing', configured: false,
      verifiedAt: null, modelCount: 0, selectedModel: null, message: '尚未配置 API Key',
    })
    const customReady: GongchuangModelConnectionsSnapshot = {
      ...base,
      providers: {
        ...base.providers,
        openrouter: {
          provider: 'openrouter', route: 'openrouter', phase: 'missing', configured: false,
          verifiedAt: null, modelCount: 0, selectedModel: null, message: '尚未配置 API Key',
        },
        fireworks: {
          provider: 'fireworks', route: 'fireworks', phase: 'missing', configured: false,
          verifiedAt: null, modelCount: 0, selectedModel: null, message: '尚未配置 API Key',
        },
        custom: {
          provider: 'custom', route: 'custom-api', phase: 'ready', configured: true,
          verifiedAt: '2026-08-16T09:30:00.000Z', modelCount: 2,
          selectedModel: 'deepseek-v4-flash', message: '连接已验证，可用模型 2 个',
          configuration: {
            displayName: 'Test endpoint', baseURL: 'https://custom.example/v1',
            protocol: 'openai-completions', modelId: 'deepseek-v4-flash',
          },
        },
      },
    }
    const remote = {
      snapshot: vi.fn(() => remoteOk(customReady)),
      deepseekFiles: vi.fn(deepseekFiles),
      configure: vi.fn(),
      refresh: vi.fn(),
      clearDeepSeekFiles: vi.fn(), setDeepSeekFileRetention: vi.fn(),
    }
    const controller = new ConnectivityController(llm(), remote, () => 'custom-api')
    await controller.load()
    expect(controller.store.getSnapshot().activeProvider).toBe('custom')
    expect(controller.store.getSnapshot().providers.custom).toMatchObject({
      status: 'ready', route: 'custom-api', selectedModel: 'deepseek-v4-flash',
      configuration: customReady.providers.custom.configuration,
    })
  })

  it('publishes ready only from a timestamped Host verification receipt', async () => {
    const ready = snapshot({
      provider: 'opencode-go', route: 'opencode-go', phase: 'ready', configured: true,
      verifiedAt: '2026-08-15T02:30:00.000Z', modelCount: 4,
      selectedModel: 'deepseek-v4-flash-free', message: '连接已验证，可用模型 4 个',
    })
    const remote = {
      snapshot: vi.fn(() => remoteOk(ready)),
      deepseekFiles: vi.fn(deepseekFiles),
      configure: vi.fn(),
      refresh: vi.fn(),
      clearDeepSeekFiles: vi.fn(), setDeepSeekFileRetention: vi.fn(),
    }
    const controller = new ConnectivityController(llm(), remote, deepseekRoute)
    await controller.load()
    expect(controller.store.getSnapshot().providers['opencode-go']).toEqual({
      status: 'ready', configured: true, route: 'opencode-go', message: '连接已验证，可用模型 4 个',
      verifiedAt: '2026-08-15T02:30:00.000Z', modelCount: 4,
      selectedModel: 'deepseek-v4-flash-free',
    })
  })

  it('revalidates a stored credential only after an explicit provider refresh', async () => {
    const ready = snapshot({
      provider: 'opencode-go', route: 'opencode-go', phase: 'ready', configured: true,
      verifiedAt: '2026-08-15T02:30:00.000Z', modelCount: 4,
      selectedModel: 'deepseek-v4-flash-free', message: '连接已验证，可用模型 4 个',
    })
    const remote = {
      snapshot: vi.fn(() => remoteOk(ready)),
      deepseekFiles: vi.fn(deepseekFiles),
      configure: vi.fn(),
      refresh: vi.fn(() => remoteOk(ready)),
      clearDeepSeekFiles: vi.fn(), setDeepSeekFileRetention: vi.fn(),
    }
    const controller = new ConnectivityController(llm(), remote, deepseekRoute)

    await controller.load()
    expect(remote.refresh).not.toHaveBeenCalled()
    await controller.refreshProvider('opencode-go')
    expect(remote.refresh).toHaveBeenCalledTimes(1)
    expect(remote.refresh).toHaveBeenCalledWith({ provider: 'opencode-go' })
  })

  it('allows a hand-entered custom model without sending a validation request', async () => {
    const base = snapshot({
      provider: 'opencode-go', route: 'opencode-go', phase: 'missing', configured: false,
      verifiedAt: null, modelCount: 0, selectedModel: null, message: '尚未配置 API Key',
    })
    const candidate: GongchuangModelConnectionsSnapshot = {
      ...base,
      providers: {
        ...base.providers,
        custom: {
          provider: 'custom', route: 'custom-api', phase: 'candidate', configured: true,
          verifiedAt: null, modelCount: 1, selectedModel: 'manual-text-model',
          message: '端点不提供模型目录；manual-text-model 已登记为文本模型',
        },
      },
    }
    const remote = {
      snapshot: vi.fn(() => remoteOk(candidate)),
      deepseekFiles: vi.fn(deepseekFiles),
      configure: vi.fn(() => remoteOk(candidate)),
      refresh: vi.fn(),
    }
    const controller = new ConnectivityController(llm(), remote as never, deepseekRoute)

    await expect(controller.configure({
      provider: 'custom', displayName: '无目录兼容端点', baseURL: 'https://custom.example/v1',
      protocol: 'openai-completions', modelId: 'manual-text-model', apiKey: 'candidate-key',
    })).resolves.toBeUndefined()
    expect(controller.store.getSnapshot().providers.custom).toMatchObject({
      status: 'ready', configured: true, route: 'custom-api', selectedModel: 'manual-text-model',
    })
  })

  it('keeps a failed configuration visibly failed instead of inventing completion', async () => {
    const missing = snapshot({
      provider: 'opencode-go', route: 'opencode-go', phase: 'missing', configured: false,
      verifiedAt: null, modelCount: 0, selectedModel: null, message: '尚未配置 API Key',
    })
    const remote = {
      snapshot: vi.fn(() => remoteOk(missing)),
      deepseekFiles: vi.fn(deepseekFiles),
      configure: vi.fn(() => Promise.resolve({
        ok: false as const,
        error: { code: 'REMOTE_ERROR', message: '模型服务连接检查失败，HTTP 401，请检查 API Key' },
      })),
      refresh: vi.fn(),
    }
    const controller = new ConnectivityController(llm(), remote as never, deepseekRoute)
    await expect(controller.configure({ provider: 'opencode-go', apiKey: 'invalid-key' }))
      .rejects.toThrow('GC-MODEL-AUTH')
    const projected = controller.store.getSnapshot().providers['opencode-go']
    expect(projected).toMatchObject({ status: 'error', configured: false })
    expect(projected.message).toBe('API Key 无效或无权访问，请检查后重试（诊断码：GC-MODEL-AUTH）')
    expect(projected.message).not.toContain('HTTP 401')
  })

  it('sanitizes runtime provider failures before they enter the model connection UI', () => {
    const missing = snapshot({
      provider: 'opencode-go', route: 'opencode-go', phase: 'missing', configured: false,
      verifiedAt: null, modelCount: 0, selectedModel: null, message: '尚未配置 API Key',
    })
    const remote = {
      snapshot: vi.fn(() => remoteOk(missing)), deepseekFiles: vi.fn(deepseekFiles),
      configure: vi.fn(), refresh: vi.fn(),
      clearDeepSeekFiles: vi.fn(), setDeepSeekFileRetention: vi.fn(),
    }
    const controller = new ConnectivityController(llm(), remote, deepseekRoute)
    controller.recordRuntimeFailure('opencode-go', 'upstream stack /Users/alice/app.ts sk-secret-1234567890')
    const message = controller.store.getSnapshot().providers['opencode-go'].message
    expect(message).toBe('模型连接未能完成，请检查配置后重试（诊断码：GC-MODEL-UNKNOWN）')
    expect(message).not.toContain('/Users/')
    expect(message).not.toContain('sk-secret')
  })

  it.each(['deepseek', 'opencode-go', 'openrouter', 'fireworks', 'custom'] as const)(
    'keeps the saved-key recovery action for %s after a rejected replacement', async (provider) => {
      const ready = snapshot({
        provider: 'opencode-go', route: 'opencode-go', phase: 'ready', configured: true,
        verifiedAt: '2026-09-03T10:00:00.000Z', modelCount: 1, selectedModel: 'retained-model', message: '连接已验证',
      })
      const configured = { ...ready, providers: { ...ready.providers, [provider]: {
        ...ready.providers[provider], phase: 'ready' as const, configured: true,
        verifiedAt: '2026-09-03T10:00:00.000Z', modelCount: 1, selectedModel: 'retained-model',
      } } }
      const remote = {
        snapshot: vi.fn(() => remoteOk(configured)), deepseekFiles: vi.fn(deepseekFiles),
        configure: vi.fn(() => Promise.resolve({ ok: false as const, error: new RemoteError('gateway/internal', 'HTTP 401', {}) })),
        refresh: vi.fn(() => remoteOk(configured)), clearDeepSeekFiles: vi.fn(), setDeepSeekFileRetention: vi.fn(),
      }
      const controller = new ConnectivityController(llm(), remote, deepseekRoute)
      await controller.load()
      const replacement = controller.configure(provider === 'custom'
        ? { provider, apiKey: 'invalid-key', displayName: 'QA', baseURL: 'https://example.com/v1', protocol: 'openai-completions' }
        : { provider, apiKey: 'invalid-key' })
      expect(controller.store.getSnapshot().providers[provider]).toMatchObject({ status: 'loading', configured: true })
      await expect(replacement).rejects.toThrow('GC-MODEL-AUTH')
      expect(controller.store.getSnapshot().providers[provider]).toMatchObject({ status: 'error', configured: true })
      await controller.refreshProvider(provider)
      expect(controller.store.getSnapshot().providers[provider]).toMatchObject({ status: 'ready', configured: true })
    },
  )

  it('preserves known credential presence when reloading the Host snapshot fails', async () => {
    const ready = snapshot({
      provider: 'opencode-go', route: 'opencode-go', phase: 'ready', configured: true,
      verifiedAt: '2026-09-03T10:00:00.000Z', modelCount: 1, selectedModel: 'retained-model', message: '连接已验证',
    })
    const remote = {
      snapshot: vi.fn(() => remoteOk(ready)), deepseekFiles: vi.fn(deepseekFiles),
      configure: vi.fn(), refresh: vi.fn(), clearDeepSeekFiles: vi.fn(), setDeepSeekFileRetention: vi.fn(),
    }
    const controller = new ConnectivityController(llm(), remote, deepseekRoute)
    await controller.load()
    remote.snapshot.mockRejectedValueOnce(new Error('Host connection closed'))
    await controller.load()
    expect(controller.store.getSnapshot().providers['opencode-go']).toMatchObject({ status: 'error', configured: true })
    expect(controller.store.getSnapshot().providers.deepseek).toMatchObject({ status: 'error', configured: false })
  })

  it.each(['configure', 'refresh'] as const)('settles a rejected %s transport instead of keeping a loading state', async (operation) => {
    const ready = snapshot({
      provider: 'opencode-go', route: 'opencode-go', phase: 'ready', configured: true,
      verifiedAt: '2026-09-03T10:00:00.000Z', modelCount: 1, selectedModel: 'retained-model', message: '连接已验证',
    })
    const remote = {
      snapshot: vi.fn(() => remoteOk(ready)), deepseekFiles: vi.fn(deepseekFiles),
      configure: vi.fn().mockRejectedValue(new Error('Host connection closed')),
      refresh: vi.fn().mockRejectedValue(new Error('Host connection closed')),
      clearDeepSeekFiles: vi.fn(), setDeepSeekFileRetention: vi.fn(),
    }
    const controller = new ConnectivityController(llm(), remote, deepseekRoute)
    await controller.load()
    await expect(operation === 'configure'
      ? controller.configure({ provider: 'opencode-go', apiKey: 'test-key' })
      : controller.refreshProvider('opencode-go')).rejects.toThrow('GC-MODEL-')
    expect(controller.store.getSnapshot().providers['opencode-go']).toMatchObject({ status: 'error', configured: true })
  })

  it('updates DeepSeek retention and reports actual remote cleanup receipts', async () => {
    const missing = snapshot({
      provider: 'opencode-go', route: 'opencode-go', phase: 'missing', configured: false,
      verifiedAt: null, modelCount: 0, selectedModel: null, message: '尚未配置 API Key',
    })
    const remote = {
      snapshot: vi.fn(() => remoteOk(missing)),
      deepseekFiles: vi.fn(deepseekFiles),
      configure: vi.fn(), refresh: vi.fn(),
      setDeepSeekFileRetention: vi.fn(() => remoteOk({
        retentionSeconds: 604_800,
        retentionOptions: [3_600, 604_800, 2_592_000] as const,
      })),
      clearDeepSeekFiles: vi.fn(() => remoteOk({
        deletedRemoteFiles: 2,
        completedAt: '2026-08-22T04:30:00.000Z',
      })),
    }
    const controller = new ConnectivityController(llm(), remote as never, deepseekRoute)
    await controller.load()
    await controller.setDeepSeekFileRetention(604_800)
    expect(remote.setDeepSeekFileRetention).toHaveBeenCalledWith({ retentionSeconds: 604_800 })
    expect(controller.store.getSnapshot().deepseekFiles.retentionSeconds).toBe(604_800)

    await expect(controller.clearDeepSeekFiles()).resolves.toBe(2)
    expect(controller.store.getSnapshot().deepseekFiles.status).toBe('ready')
  })
})
