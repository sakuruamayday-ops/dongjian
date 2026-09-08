// @vitest-environment jsdom
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ConversationDraftText, ConversationDraftImages, DraftAttachmentId, SubmitImageAttachment,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationAnnotationDrafts } from '../src/client/annotation-drafts.ts'
import {
  ComposerDraftPersistenceController, type ComposerDraftDesktopBridge, type NativeComposerDraft,
} from '../src/client/composer-draft-persistence.ts'
import { ConversationDocumentDrafts } from '../src/client/document-drafts.ts'

const SESSION = 'session-native-draft' as SessionId

class TextDrafts implements ConversationDraftText {
  private readonly stores = new Map<SessionId, SnapshotStore<string>>()

  source(sessionId: SessionId): SnapshotStore<string> {
    let store = this.stores.get(sessionId)
    if (store === undefined) {
      store = createSnapshotStore('')
      this.stores.set(sessionId, store)
    }
    return store
  }

  restoreIfEmpty(sessionId: SessionId, text: string): void {
    const store = this.source(sessionId)
    if (store.getSnapshot() === '') store.set(text)
  }

  clear(sessionId: SessionId): void {
    this.source(sessionId).set('')
  }
}

const PNG: SubmitImageAttachment = { name: 'image.png', mediaType: 'image/png', data: 'aGVsbG8=' }

class ImageDrafts implements ConversationDraftImages {
  readonly ids = createSnapshotStore<readonly DraftAttachmentId[]>([])
  readonly serialize = vi.fn(async (ids: readonly DraftAttachmentId[]): Promise<readonly SubmitImageAttachment[]> => ids.map(() => PNG))

  source(): SnapshotStore<readonly DraftAttachmentId[]> { return this.ids }

  restoreIfEmpty(_sessionId: SessionId, images: readonly SubmitImageAttachment[]): void {
    if (this.ids.getSnapshot().length === 0) {
      this.ids.set(images.map((_image, index) => `restored-${index}` as DraftAttachmentId))
    }
  }
}

function nativeDraft(text = '未发送文字'): NativeComposerDraft {
  return {
    text,
    documents: [{ name: '附件.xlsx', relativePath: '导入资料/附件.xlsx', bytes: 42 }],
    annotations: [{
      index: 1, text: '引用段落', comment: '请调整', source: { nodeKey: 'message-1', kind: 'assistant' },
    }],
    nextAnnotationIndex: 2,
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('desktop composer draft continuity', () => {
  it('hydrates text, documents, and annotations, then mirrors one coherent snapshot', async () => {
    const writes: NativeComposerDraft[] = []
    const bridge: ComposerDraftDesktopBridge = {
      readComposerDraft: async () => nativeDraft(),
      writeComposerDraft: async (_id, value) => { writes.push(value) },
      clearComposerDraft: async () => undefined,
    }
    const text = new TextDrafts()
    const documents = new ConversationDocumentDrafts()
    const annotations = new ConversationAnnotationDrafts()
    const controller = new ComposerDraftPersistenceController(bridge, text, documents, annotations, new ImageDrafts())

    await controller.bind(SESSION)
    expect(text.source(SESSION).getSnapshot()).toBe('未发送文字')
    expect(documents.snapshot(SESSION)).toHaveLength(1)
    expect(annotations.storeFor(SESSION).getSnapshot().annotations).toHaveLength(1)

    text.source(SESSION).set('更新后的文字')
    await vi.advanceTimersByTimeAsync(121)
    expect(writes.at(-1)).toMatchObject({
      text: '更新后的文字',
      documents: [{ name: '附件.xlsx' }],
      annotations: [{ index: 1, comment: '请调整' }],
      nextAnnotationIndex: 2,
    })
    controller.dispose()
  })

  it('normalizes legacy annotation numbers and persists deletion followed by a fresh first item', async () => {
    const writes: NativeComposerDraft[] = []
    const legacy = nativeDraft()
    const annotations = new ConversationAnnotationDrafts()
    const controller = new ComposerDraftPersistenceController({
      readComposerDraft: async () => ({ ...legacy,
        annotations: legacy.annotations.map(item => ({ ...item, index: 7 })), nextAnnotationIndex: 12 }),
      writeComposerDraft: async (_id, value) => { writes.push(value) },
      clearComposerDraft: async () => undefined,
    }, new TextDrafts(), new ConversationDocumentDrafts(), annotations, new ImageDrafts())
    await controller.bind(SESSION)
    expect(annotations.storeFor(SESSION).getSnapshot()).toMatchObject({
      annotations: [{ index: 1, comment: '请调整' }], nextIndex: 2,
    })
    annotations.remove(SESSION, 1)
    await vi.advanceTimersByTimeAsync(121)
    expect(writes.at(-1)).toMatchObject({ annotations: [], nextAnnotationIndex: 1 })
    annotations.add(SESSION, { text: '新引文', source: { nodeKey: 'message-2', kind: 'assistant' } })
    await vi.advanceTimersByTimeAsync(121)
    expect(writes.at(-1)).toMatchObject({ annotations: [{ index: 1, text: '新引文' }], nextAnnotationIndex: 2 })
    controller.dispose()
  })

  it('does not overwrite user input entered while native hydration is pending', async () => {
    let resolveRead: ((value: unknown) => void) | undefined
    const read = new Promise<unknown>((resolve) => { resolveRead = resolve })
    const bridge: ComposerDraftDesktopBridge = {
      readComposerDraft: async () => read,
      writeComposerDraft: async () => undefined,
      clearComposerDraft: async () => undefined,
    }
    const text = new TextDrafts()
    const documents = new ConversationDocumentDrafts()
    const annotations = new ConversationAnnotationDrafts()
    const controller = new ComposerDraftPersistenceController(bridge, text, documents, annotations, new ImageDrafts())

    const ready = controller.bind(SESSION)
    text.source(SESSION).set('用户正在输入')
    documents.add(SESSION, [{ name: '新.docx', relativePath: '导入资料/新.docx', bytes: 9 }])
    resolveRead?.(nativeDraft('旧文字'))
    await ready

    expect(text.source(SESSION).getSnapshot()).toBe('用户正在输入')
    expect(documents.snapshot(SESSION).map(item => item.name)).toEqual(['新.docx'])
    controller.dispose()
  })

  it('clears the native record after a conversation deletion', async () => {
    const cleared: string[] = []
    const bridge: ComposerDraftDesktopBridge = {
      readComposerDraft: async () => null,
      writeComposerDraft: async () => undefined,
      clearComposerDraft: async (id) => { cleared.push(id) },
    }
    const controller = new ComposerDraftPersistenceController(
      bridge, new TextDrafts(), new ConversationDocumentDrafts(), new ConversationAnnotationDrafts(),
      new ImageDrafts(),
    )
    await controller.bind(SESSION)
    await controller.clear(SESSION)
    expect(cleared).toEqual([SESSION])
  })

  it('does not resurrect a cleared conversation when a late native read resolves', async () => {
    let resolveRead: ((value: unknown) => void) | undefined
    const read = new Promise<unknown>((resolve) => { resolveRead = resolve })
    const text = new TextDrafts()
    const documents = new ConversationDocumentDrafts()
    const controller = new ComposerDraftPersistenceController({
      readComposerDraft: async () => read,
      writeComposerDraft: async () => undefined,
      clearComposerDraft: async () => undefined,
    }, text, documents, new ConversationAnnotationDrafts(), new ImageDrafts())
    const ready = controller.bind(SESSION)
    await controller.clear(SESSION)
    resolveRead?.(nativeDraft())
    await ready
    expect(text.source(SESSION).getSnapshot()).toBe('')
    expect(documents.snapshot(SESSION)).toEqual([])
  })

  it('hydrates pasted images, caches bytes while typing, and persists image removal', async () => {
    const writes: NativeComposerDraft[] = []
    const text = new TextDrafts()
    const images = new ImageDrafts()
    const controller = new ComposerDraftPersistenceController({
      readComposerDraft: async () => ({ ...nativeDraft(), images: [PNG] }),
      writeComposerDraft: async (_id, value) => { writes.push(value) },
      clearComposerDraft: async () => undefined,
    }, text, new ConversationDocumentDrafts(), new ConversationAnnotationDrafts(), images)
    await controller.bind(SESSION)
    await vi.advanceTimersByTimeAsync(1)
    expect(images.ids.getSnapshot()).toHaveLength(1)
    expect(writes.at(-1)?.images).toEqual([PNG])
    text.source(SESSION).set('继续编辑')
    await vi.advanceTimersByTimeAsync(1)
    expect(images.serialize).toHaveBeenCalledTimes(1)
    images.ids.set([])
    await vi.advanceTimersByTimeAsync(1)
    expect(writes.at(-1)?.images).toEqual([])
    controller.dispose()
  })

  it('drains the latest captured text on disposal while image encoding is pending', async () => {
    let finish: (images: readonly SubmitImageAttachment[]) => void = () => {}
    const encoding = new Promise<readonly SubmitImageAttachment[]>((resolve) => { finish = resolve })
    const writes: NativeComposerDraft[] = []
    const text = new TextDrafts()
    const images = new ImageDrafts()
    images.ids.set(['pasted' as DraftAttachmentId])
    images.serialize.mockImplementation(async () => encoding)
    const controller = new ComposerDraftPersistenceController({
      readComposerDraft: async () => null,
      writeComposerDraft: async (_id, value) => { writes.push(value) },
      clearComposerDraft: async () => undefined,
    }, text, new ConversationDocumentDrafts(), new ConversationAnnotationDrafts(), images)
    await controller.bind(SESSION)
    text.source(SESSION).set('退出前最后修改')
    controller.dispose()
    finish([PNG])
    await vi.advanceTimersByTimeAsync(1)
    expect(writes.at(-1)).toMatchObject({ text: '退出前最后修改', images: [PNG] })
  })

  it('does not recreate a deleted draft after a late image encoding or late hydration', async () => {
    let finish: (images: readonly SubmitImageAttachment[]) => void = () => {}
    const encoding = new Promise<readonly SubmitImageAttachment[]>((resolve) => { finish = resolve })
    const images = new ImageDrafts()
    images.ids.set(['pasted' as DraftAttachmentId])
    images.serialize.mockImplementation(async () => encoding)
    const write = vi.fn(async () => undefined)
    const controller = new ComposerDraftPersistenceController({
      readComposerDraft: async () => null, writeComposerDraft: write, clearComposerDraft: async () => undefined,
    }, new TextDrafts(), new ConversationDocumentDrafts(), new ConversationAnnotationDrafts(), images)
    await controller.bind(SESSION)
    await controller.clear(SESSION)
    finish([PNG])
    await vi.advanceTimersByTimeAsync(1)
    expect(write).not.toHaveBeenCalled()
  })

  it('does not retry a failed save when only the composer notice changes', async () => {
    const text = new TextDrafts()
    let notify: () => void = () => {}
    vi.spyOn(text.source(SESSION), 'subscribe').mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    const write = vi.fn(async () => { throw new Error('draft storage is full') })
    const report = vi.fn(() => { if (report.mock.calls.length < 5) notify() })
    const controller = new ComposerDraftPersistenceController({
      readComposerDraft: async () => null, writeComposerDraft: write, clearComposerDraft: async () => undefined,
    }, text, new ConversationDocumentDrafts(), new ConversationAnnotationDrafts(), new ImageDrafts(), report)
    await controller.bind(SESSION)
    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledTimes(1)
    await controller.clear(SESSION)
  })

  it('does not overwrite a stored draft with empty state after a failed native read', async () => {
    const write = vi.fn(async () => undefined)
    const text = new TextDrafts()
    const controller = new ComposerDraftPersistenceController({
      readComposerDraft: async () => { throw new Error('temporary IPC failure') },
      writeComposerDraft: write, clearComposerDraft: async () => undefined,
    }, text, new ConversationDocumentDrafts(), new ConversationAnnotationDrafts(), new ImageDrafts())
    await controller.bind(SESSION)
    text.source(SESSION).set('保留尚未读取的旧草稿')
    controller.dispose()
    await vi.advanceTimersByTimeAsync(1)
    expect(write).not.toHaveBeenCalled()
  })
})
