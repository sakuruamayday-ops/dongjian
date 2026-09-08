// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageTransferConsentController, type ImageTransferProvider } from '../src/client/image-transfer-consent.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { localStorage.clear() })

function request() {
  return { sessionId: 'session-image' as never, text: '分析图片', imageCount: 2 }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('ImageTransferConsentController', () => {
  it('does not fall back to browser consent when the native store is unreadable', async () => {
    localStorage.setItem('gongchuang.image-transfer-consent.v1', '["opencode-go"]')
    const storage = {
      read: async (): Promise<readonly ImageTransferProvider[]> => { throw new Error('unreadable') },
      remember: vi.fn(async () => {}), failureMessage: zh['images.consentSaveFailed'],
    }
    const controller = new ImageTransferConsentController(() => 'opencode-go', storage)
    await expect(controller.admit(request(), new AbortController().signal))
      .resolves.toEqual({ kind: 'reject', text: storage.failureMessage })
    expect(storage.remember).not.toHaveBeenCalled()
  })

  it.each(['abort', 'dispose'] as const)('does not open a dialog after %s during a storage read', async (action) => {
    const reading = deferred<readonly ImageTransferProvider[]>()
    const storage = { read: () => reading.promise, remember: vi.fn(async () => {}), failureMessage: '' }
    const controller = new ImageTransferConsentController(() => 'opencode-go', storage)
    const abort = new AbortController()
    const outcome = controller.admit(request(), abort.signal)
    if (action === 'abort') abort.abort()
    else controller.dispose()
    reading.resolve([])
    await expect(outcome).resolves.toEqual({ kind: 'reject' })
    expect(controller.store.getSnapshot().phase).toBe('idle')
  })

  it.each(['provider-change', 'cancel', 'abort', 'dispose'] as const)(
    'does not send on %s while the explicit approval is being saved', async (action) => {
      let provider: ImageTransferProvider = 'opencode-go'
      const saving = deferred<undefined>()
      const storage = { read: async () => [], remember: vi.fn(() => saving.promise), failureMessage: '' }
      const controller = new ImageTransferConsentController(() => provider, storage)
      const abort = new AbortController()
      const outcome = controller.admit(request(), abort.signal)
      await expect.poll(() => controller.store.getSnapshot().phase).toBe('pending')
      controller.approve()
      controller.approve()
      expect(storage.remember).toHaveBeenCalledExactlyOnceWith('opencode-go')
      if (action === 'provider-change') provider = 'deepseek'
      else if (action === 'cancel') controller.reject()
      else if (action === 'abort') abort.abort()
      else controller.dispose()
      saving.resolve(undefined)
      await expect(outcome).resolves.toMatchObject({ kind: 'reject' })
      expect(controller.store.getSnapshot().phase).toBe('idle')
    },
  )

  it('asks again for a different provider even when a native approval exists', async () => {
    const storage = { read: async () => ['opencode-go' as const], remember: vi.fn(async () => {}), failureMessage: '' }
    const controller = new ImageTransferConsentController(() => 'deepseek', storage)
    const outcome = controller.admit(request(), new AbortController().signal)
    await expect.poll(() => controller.store.getSnapshot().provider).toBe('deepseek')
    controller.reject()
    await expect(outcome).resolves.toMatchObject({ kind: 'reject' })
    expect(storage.remember).not.toHaveBeenCalled()
  })

  it('restores desktop consent independently of the browser origin', async () => {
    const storage = { read: vi.fn(async () => ['opencode-go' as const]), remember: vi.fn(async () => {}), failureMessage: zh['images.consentSaveFailed'] }
    const controller = new ImageTransferConsentController(() => 'opencode-go', storage)
    const pending = controller.admit(request(), new AbortController().signal)
    await expect.poll(() => storage.read.mock.calls.length).toBe(1)
    await expect(pending).resolves.toEqual({ kind: 'allow' })
    expect(localStorage.length).toBe(0)
  })

  it('does not release images when desktop consent cannot be saved', async () => {
    const storage = { read: async () => [], remember: vi.fn(async () => { throw new Error('disk full') }), failureMessage: zh['images.consentSaveFailed'] }
    const controller = new ImageTransferConsentController(() => 'opencode-go', storage)
    const pending = controller.admit(request(), new AbortController().signal)
    await expect.poll(() => controller.store.getSnapshot().phase).toBe('pending')
    controller.approve()
    await expect(pending).resolves.toEqual({ kind: 'reject', text: zh['images.consentSaveFailed'] })
    expect(localStorage.length).toBe(0)
  })

  it('requires one explicit decision per provider and restores that consent without persisting file identity', async () => {
    let provider: ImageTransferProvider = 'opencode-go'
    const controller = new ImageTransferConsentController(() => provider)
    const pending = controller.admit(request(), new AbortController().signal)
    expect(controller.store.getSnapshot()).toMatchObject({
      phase: 'pending', provider: 'opencode-go', imageCount: 2,
    })
    controller.approve()
    await expect(pending).resolves.toEqual({ kind: 'allow' })

    const persisted = localStorage.getItem('gongchuang.image-transfer-consent.v1') ?? ''
    expect(persisted).toContain('opencode-go')
    expect(persisted).not.toContain('session-image')
    expect(persisted).not.toContain('file_id')

    const restored = new ImageTransferConsentController(() => provider)
    await expect(restored.admit(request(), new AbortController().signal)).resolves.toEqual({ kind: 'allow' })
    provider = 'deepseek'
    const deepseek = restored.admit(request(), new AbortController().signal)
    expect(restored.store.getSnapshot().provider).toBe('deepseek')
    restored.reject()
    await expect(deepseek).resolves.toMatchObject({ kind: 'reject' })
  })

  it('rejects an approval if the active provider changed while the dialog was open', async () => {
    let provider: ImageTransferProvider = 'deepseek'
    const controller = new ImageTransferConsentController(() => provider)
    const pending = controller.admit(request(), new AbortController().signal)
    provider = 'openrouter'
    controller.approve()
    await expect(pending).resolves.toEqual({
      kind: 'reject',
      text: '图片发送期间模型服务发生变化；本次草稿和附件已保留，请重新发送。',
    })
    expect(localStorage.getItem('gongchuang.image-transfer-consent.v1')).toBeNull()
  })
})
