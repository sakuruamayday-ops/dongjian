import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ProductUiState } from '../src/client/ProductShell.tsx'
import {
  configureAndRememberProvider,
  loadDesktopAvatar, persistDesktopAvatar, preferredModel, preferredReasoningEffort,
  providerConnectivityRefreshDecision, selectAndRememberProvider,
} from '../src/client/index.ts'

function productState() {
  return createSnapshotStore<ProductUiState>({
    page: 'assistant', provider: 'deepseek', accountDialogRevision: 0, avatarDataUrl: null,
  })
}

describe('provider selection commit', () => {
  it('uses DeepSeek V4 Flash as the first-use fallback on every product route', () => {
    expect(preferredModel('deepseek', ['deepseek-v4-pro', 'deepseek-v4-flash']))
      .toBe('deepseek-v4-flash')
    expect(preferredModel('opencode-go', [
      'deepseek-v4-flash-free', 'deepseek-v4-pro', 'deepseek-v4-flash',
    ])).toBe('deepseek-v4-flash')
    expect(preferredModel('opencode-go', ['deepseek-v4-flash-free', 'deepseek-v4-pro']))
      .toBe('deepseek-v4-flash-free')
    expect(preferredModel('openrouter', ['deepseek-v4-pro', 'deepseek-v4-flash']))
      .toBe('deepseek-v4-flash')
    expect(preferredModel('fireworks', ['deepseek-v4-pro', 'other-model']))
      .toBe('deepseek-v4-pro')
    expect(preferredModel('custom', ['other-model'])).toBe('other-model')
  })

  it('recognizes namespaced OpenAI-compatible DeepSeek V4 Flash IDs', () => {
    expect(preferredModel('openrouter', ['Qwen/Qwen3-32B', 'deepseek-ai/DeepSeek-V4-Flash', 'deepseek-v4-pro']))
      .toBe('deepseek-ai/DeepSeek-V4-Flash')
  })

  it('restores Max when switching back to either OpenCode Go Flash route', () => {
    expect(preferredReasoningEffort('opencode-go', 'deepseek-v4-flash')).toBe('max')
    expect(preferredReasoningEffort('opencode-go', 'deepseek-v4-flash-free')).toBe('max')
    expect(preferredReasoningEffort('opencode-go', 'deepseek-ai/DeepSeek-V4-Flash')).toBe('max')
    expect(preferredReasoningEffort('opencode-go', 'deepseek-ai/DeepSeek-V4-Flash-Free')).toBe('max')
    expect(preferredReasoningEffort('opencode-go', 'deepseek-v4-pro')).toBeUndefined()
    expect(preferredReasoningEffort('deepseek', 'deepseek-v4-flash')).toBeUndefined()
    expect(preferredReasoningEffort('custom', 'deepseek-v4-flash')).toBeUndefined()
  })

  it('keeps the last usable provider when Host model selection fails', async () => {
    const store = productState()
    await expect(selectAndRememberProvider(
      store,
      'custom',
      () => Promise.reject(new Error('尚未添加自定义 API')),
    )).rejects.toThrow('尚未添加自定义 API')
    expect(store.getSnapshot().provider).toBe('deepseek')
  })

  it('publishes the new provider only after Host model selection succeeds', async () => {
    const store = productState()
    let observedDuringSelection = ''
    await selectAndRememberProvider(store, 'opencode-go', async () => {
      observedDuringSelection = store.getSnapshot().provider
    })
    expect(observedDuringSelection).toBe('deepseek')
    expect(store.getSnapshot().provider).toBe('opencode-go')
  })

  it('projects the durable provider without authorizing a background model write', () => {
    expect(providerConnectivityRefreshDecision('custom', 'opencode-go', 'deepseek', 'ready'))
      .toEqual({ provider: 'custom' })
    expect(providerConnectivityRefreshDecision(null, 'opencode-go', 'deepseek', 'missing'))
      .toEqual({ provider: 'opencode-go' })
    expect('select' in providerConnectivityRefreshDecision('custom', 'opencode-go', 'deepseek', 'ready'))
      .toBe(false)
  })

  it('does not overwrite a ready provider chosen while startup refresh is settling', () => {
    expect(providerConnectivityRefreshDecision(
      null, 'deepseek', 'opencode-go', 'ready',
    )).toEqual({ provider: 'opencode-go' })
    expect(providerConnectivityRefreshDecision(
      null, 'deepseek', 'opencode-go', 'error',
    )).toEqual({ provider: 'deepseek' })
  })

  it('reports a saved connection separately when its automatic selection fails', async () => {
    const store = productState()
    const configure = vi.fn(() => Promise.resolve())
    const select = vi.fn(() => Promise.reject(new Error('selection unavailable')))
    const partial = vi.fn(() => '连接已保存，自动切换失败：请手动重试')

    await expect(configureAndRememberProvider(
      store, 'custom', configure, select, partial,
    )).resolves.toEqual({
      connectionSaved: true,
      autoSelected: false,
      message: '连接已保存，自动切换失败：请手动重试',
    })
    expect(configure).toHaveBeenCalledOnce()
    expect(select).toHaveBeenCalledOnce()
    expect(partial).toHaveBeenCalledOnce()
    expect(store.getSnapshot().provider).toBe('deepseek')
  })

  it('loads and writes the device-local avatar through the desktop bridge', async () => {
    const store = productState()
    const readAvatar = vi.fn(async () => 'data:image/webp;base64,YQ==')
    const writeAvatar = vi.fn(async (value: string | null) => value)
    await loadDesktopAvatar(store, { readAvatar })
    expect(store.getSnapshot().avatarDataUrl).toBe('data:image/webp;base64,YQ==')
    await persistDesktopAvatar(store, null, { writeAvatar })
    expect(writeAvatar).toHaveBeenCalledWith(null)
    expect(store.getSnapshot().avatarDataUrl).toBeNull()
  })
})
