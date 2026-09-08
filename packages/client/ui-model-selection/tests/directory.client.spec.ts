import type { ModelCatalog, ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'
import { ModelDirectory } from '../src/client/directory.ts'

const sessionId = 'session-model-directory' as SessionId

function catalog(models: readonly string[], routableProviders: readonly string[] = ['opencode-go']): ModelCatalog {
  return {
    default: { provider: 'opencode-go', model: models[0] ?? 'relay-default' },
    routableProviders,
    groups: [{
      id: 'opencode-go',
      name: 'OpenCode Go',
      models: models.map(id => ({ id, name: id })),
    }],
    failures: [],
  }
}

function fixture(value: ModelCatalog, projected: ModelSelectionProjection) {
  const projection = createSnapshotStore<unknown>(projected)
  const modelCatalog = vi.fn(() => Promise.resolve({ ok: true as const, value }))
  const selectModel = vi.fn(async (selection: {
    provider: string
    model: string
    reasoningEffort?: string
  }) => {
    projection.set({ lastUsed: projected.lastUsed, next: selection })
    return { ok: true as const, value: undefined }
  })
  const directory = new ModelDirectory(
    { selectModel } as never,
    sessionId,
    () => true,
    new ModelCatalogDirectory({ remote: { session: { modelCatalog } } } as never),
    projection,
    () => 'No models are available after refresh.',
  )
  return { directory, modelCatalog, selectModel }
}

describe('ModelDirectory alpha catalog and Session projection', () => {
  it('uses the Host default until the Session projects a model selection', async () => {
    const subject = fixture(catalog(['relay-default', 'relay-new']), { lastUsed: null, next: null })

    await subject.directory.load()

    expect(subject.modelCatalog).toHaveBeenCalledTimes(1)
    expect(subject.directory.store.getSnapshot()).toMatchObject({
      current: { provider: 'opencode-go', model: 'relay-default' },
      routable: true,
      status: 'ready',
    })
  })

  it('keeps catalog membership advisory and derives sendability from routable providers', async () => {
    const selected = { provider: 'opencode-go', model: 'private-relay' }
    const subject = fixture(catalog(['relay-public']), { lastUsed: selected, next: selected })

    await subject.directory.load()

    expect(subject.directory.store.getSnapshot()).toMatchObject({
      current: selected,
      routable: true,
      groups: [{ id: 'opencode-go' }],
    })
  })

  it('submits selection directly and reflects the durable Session projection', async () => {
    const current = { provider: 'opencode-go', model: 'relay-current' }
    const subject = fixture(catalog(['relay-current', 'relay-new']), { lastUsed: current, next: current })
    await subject.directory.load()

    await subject.directory.select({ provider: 'opencode-go', model: 'relay-new', reasoningEffort: 'high' })

    expect(subject.selectModel).toHaveBeenCalledWith({
      sessionId,
      provider: 'opencode-go',
      model: 'relay-new',
      reasoningEffort: 'high',
    })
    expect(subject.directory.store.getSnapshot()).toMatchObject({
      current: { provider: 'opencode-go', model: 'relay-new', reasoningEffort: 'high' },
      status: 'ready',
    })
  })

  it('forces a second global catalog read only through explicit refresh', async () => {
    const subject = fixture(catalog(['relay-default', 'relay-new']), { lastUsed: null, next: null })

    await subject.directory.load()
    await subject.directory.load()
    expect(subject.modelCatalog).toHaveBeenCalledTimes(1)

    await subject.directory.refresh()
    expect(subject.modelCatalog).toHaveBeenCalledTimes(2)
    expect(subject.directory.store.getSnapshot()).toMatchObject({
      current: { provider: 'opencode-go', model: 'relay-default' },
      status: 'ready',
    })
  })
})
