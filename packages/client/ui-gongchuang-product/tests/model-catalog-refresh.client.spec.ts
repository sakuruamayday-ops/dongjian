import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { installModelCatalogRefresh } from '../src/client/model-catalog-refresh.ts'

describe('product model catalog refresh wiring', () => {
  it('stays idle until explicitly invoked and refreshes every provider once', async () => {
    const ctx = new Context()
    const refresh = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        providers: {
          deepseek: { configured: true, phase: 'ready', modelCount: 1 },
        },
      },
    })

    installModelCatalogRefresh(ctx, { refresh })

    expect(refresh).not.toHaveBeenCalled()
    await expect(ctx.get('modelCatalogRefresh')?.refresh()).resolves.toBeUndefined()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith({})
  })

  it('keeps healthy provider groups available when another configured provider fails', async () => {
    const ctx = new Context()
    installModelCatalogRefresh(ctx, {
      refresh: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          providers: {
            openrouter: {
              configured: true,
              phase: 'ready',
              modelCount: 2,
              message: 'SiliconFlow 模型目录已刷新',
            },
            'opencode-go': {
              configured: true,
              phase: 'error',
              modelCount: 4,
              message: 'OpenCode Go 模型目录暂时不可用',
            },
          },
        },
      }),
    })

    await expect(ctx.get('modelCatalogRefresh')?.refresh()).resolves.toBeUndefined()
  })

  it('rejects a settled refresh when no configured provider has a usable directory', async () => {
    const ctx = new Context()
    installModelCatalogRefresh(ctx, {
      refresh: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          providers: {
            'opencode-go': {
              configured: true,
              phase: 'error',
              modelCount: 4,
              message: 'OpenCode Go 模型目录暂时不可用',
            },
          },
        },
      }),
    })

    await expect(ctx.get('modelCatalogRefresh')?.refresh())
      .rejects.toThrow('OpenCode Go 模型目录暂时不可用')
  })

  it('surfaces a rejected Host refresh to the selector', async () => {
    const ctx = new Context()
    installModelCatalogRefresh(ctx, {
      refresh: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'provider-offline', message: 'catalog unavailable', details: {} },
      }),
    })

    await expect(ctx.get('modelCatalogRefresh')?.refresh())
      .rejects.toThrow('provider-offline: catalog unavailable')
  })

  it('preserves a transport rejection for the selector recovery surface', async () => {
    const ctx = new Context()
    installModelCatalogRefresh(ctx, {
      refresh: vi.fn().mockRejectedValue(new Error('connection reset')),
    })

    await expect(ctx.get('modelCatalogRefresh')?.refresh())
      .rejects.toThrow('connection reset')
  })
})
