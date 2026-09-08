import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ConversationDraftText, ConversationDraftImages, DraftAttachmentId, SubmitImageAttachment,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationAnnotationDraftState } from './annotation-drafts.ts'
import type { ConversationAnnotationDrafts } from './annotation-drafts.ts'
import type { ConversationDocumentDrafts, ImportedDocument } from './document-drafts.ts'

/** Renderer/native contract for one unsent mixed composer draft. */
export interface NativeComposerDraft {
  readonly text: string
  readonly documents: readonly ImportedDocument[]
  readonly annotations: ConversationAnnotationDraftState['annotations']
  readonly nextAnnotationIndex: number
  readonly images?: readonly SubmitImageAttachment[]
}

/** Native persistence operations exposed to the renderer for unsent composer state. */
export interface ComposerDraftDesktopBridge {
  readComposerDraft(sessionId: string): Promise<unknown>
  writeComposerDraft(sessionId: string, value: NativeComposerDraft): Promise<void>
  clearComposerDraft(sessionId: string): Promise<void>
}

interface DraftBinding {
  hydrated: boolean
  scheduled: boolean
  writing: Promise<void> | undefined
  cleared: boolean
  pending?: { value: NativeComposerDraft; images: Promise<readonly SubmitImageAttachment[]> } | undefined
  saved: string | undefined
  readonly off: Array<() => void>
  readonly ready: Promise<void>
  imageIds?: readonly DraftAttachmentId[]
  imagePayload?: Promise<readonly SubmitImageAttachment[]>
}

function nativeText(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  const text = (value as { readonly text?: unknown }).text
  return typeof text === 'string' && text.length <= 500_000 ? text : ''
}

function rawField(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined
}

/**
 * Mirror text, files, pasted images, and annotations into native storage. The loopback
 * port intentionally changes on restart, so browser localStorage alone cannot
 * provide desktop draft continuity.
 */
export class ComposerDraftPersistenceController {
  private readonly bindings = new Map<SessionId, DraftBinding>()

  constructor(
    private readonly bridge: ComposerDraftDesktopBridge,
    private readonly text: ConversationDraftText,
    private readonly documents: ConversationDocumentDrafts,
    private readonly annotations: ConversationAnnotationDrafts,
    private readonly images: ConversationDraftImages,
    private readonly report: (error: unknown, sessionId: SessionId) => void = () => {},
  ) {}

  /**
   * Hydrate one conversation and then mirror later edits into native storage.
   * @param sessionId - Conversation to hydrate and mirror.
   * @returns Settlement of its shared native read.
   */
  bind(sessionId: SessionId): Promise<void> {
    const current = this.bindings.get(sessionId)
    if (current !== undefined) return current.ready

    const textSource = this.text.source(sessionId)
    const documentStore = this.documents.storeFor(sessionId)
    const annotationStore = this.annotations.storeFor(sessionId)
    const initialText = textSource.getSnapshot()
    const initialDocuments = documentStore.getSnapshot()
    const initialAnnotations = annotationStore.getSnapshot()
    const imageSource = this.images.source(sessionId)
    const initialImages = imageSource.getSnapshot()
    let observedText = initialText
    let observedDocuments = initialDocuments
    let observedAnnotations = initialAnnotations
    let observedImages = initialImages
    let readSucceeded = false
    let resolveReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => { resolveReady = resolve })
    const binding: DraftBinding = {
      hydrated: false, scheduled: false, writing: undefined, cleared: false,
      saved: undefined, off: [], ready,
    }
    const changed = (): void => {
      const nextText = textSource.getSnapshot()
      const nextDocuments = documentStore.getSnapshot()
      const nextAnnotations = annotationStore.getSnapshot()
      const nextImages = imageSource.getSnapshot()
      if (nextText === observedText && nextDocuments === observedDocuments
        && nextAnnotations === observedAnnotations && nextImages === observedImages) return
      observedText = nextText
      observedDocuments = nextDocuments
      observedAnnotations = nextAnnotations
      observedImages = nextImages
      if (binding.hydrated) this.schedule(sessionId, binding)
    }
    binding.off.push(
      textSource.subscribe(changed), documentStore.subscribe(changed),
      annotationStore.subscribe(changed), imageSource.subscribe(changed),
    )
    this.bindings.set(sessionId, binding)

    void this.bridge.readComposerDraft(sessionId).then((raw) => {
      if (this.bindings.get(sessionId) !== binding) return
      readSucceeded = true
      // A user edit made while the native read was in flight always wins.
      if (textSource.getSnapshot() === initialText) this.text.restoreIfEmpty(sessionId, nativeText(raw))
      if (documentStore.getSnapshot() === initialDocuments) {
        this.documents.restoreIfEmpty(sessionId, rawField(raw, 'documents'))
      }
      if (annotationStore.getSnapshot() === initialAnnotations) {
        this.annotations.restoreIfEmpty(sessionId, {
          annotations: rawField(raw, 'annotations'),
          nextIndex: rawField(raw, 'nextAnnotationIndex'),
        })
      }
      const savedImages = rawField(raw, 'images')
      if (imageSource.getSnapshot() === initialImages && Array.isArray(savedImages)) {
        // The Electron store validates MIME, canonical base64, and total size before returning these bytes.
        this.images.restoreIfEmpty(sessionId, savedImages as readonly SubmitImageAttachment[])
      }
    }).catch((error: unknown) => { this.report(error, sessionId) }).finally(() => {
      // An unread native record must survive later edits and shutdown untouched.
      binding.hydrated = readSucceeded
      resolveReady()
      // Reconcile origin-local migrations and any edit made during hydration.
      if (readSucceeded) this.schedule(sessionId, binding)
    })
    return ready
  }

  /**
   * Remove native draft state after its conversation was deleted successfully.
   * @param sessionId - Successfully deleted conversation.
   * @returns Settlement of native draft cleanup.
   */
  async clear(sessionId: SessionId): Promise<void> {
    const binding = this.bindings.get(sessionId)
    if (binding !== undefined) {
      binding.cleared = true
      binding.pending = undefined
      for (const off of binding.off) off()
      this.bindings.delete(sessionId)
    }
    // Conversation deletion has already succeeded; a draft cleanup failure
    // must not turn that successful operation into a misleading delete error.
    await this.bridge.clearComposerDraft(sessionId).catch((error: unknown) => { this.report(error, sessionId) })
  }

  /** Dispatch the latest state before a renderer navigation or desktop shutdown. */
  flushAll(): void {
    for (const [sessionId, binding] of this.bindings) this.flush(sessionId, binding)
  }

  /** Flush pending state, unsubscribe all sources, and release every binding. */
  dispose(): void {
    this.flushAll()
    for (const binding of this.bindings.values()) {
      for (const off of binding.off) off()
    }
    this.bindings.clear()
  }

  private schedule(sessionId: SessionId, binding: DraftBinding): void {
    if (!binding.hydrated || this.bindings.get(sessionId) !== binding) return
    if (binding.scheduled) return
    binding.scheduled = true
    queueMicrotask(() => {
      binding.scheduled = false
      this.flush(sessionId, binding)
    })
  }

  private flush(sessionId: SessionId, binding: DraftBinding): void {
    if (!binding.hydrated || this.bindings.get(sessionId) !== binding) return
    const annotationState = this.annotations.storeFor(sessionId).getSnapshot()
    const value: NativeComposerDraft = Object.freeze({
      text: this.text.source(sessionId).getSnapshot(),
      documents: this.documents.snapshot(sessionId),
      annotations: annotationState.annotations,
      nextAnnotationIndex: annotationState.nextIndex,
    })
    const ids = this.images.source(sessionId).getSnapshot()
    // Typing does not reread image files; new paste/remove/send ids replace this one cached encoding.
    if (binding.imageIds !== ids) {
      binding.imageIds = ids
      binding.imagePayload = this.images.serialize(ids)
    }
    binding.pending = { value, images: binding.imagePayload ?? Promise.resolve([]) }
    this.drain(sessionId, binding)
  }

  private drain(sessionId: SessionId, binding: DraftBinding): void {
    if (binding.writing !== undefined || binding.cleared || binding.pending === undefined) return
    const pending = binding.pending
    binding.pending = undefined
    binding.writing = pending.images.then(async (images) => {
      if (binding.cleared) return
      const mixed = { ...pending.value, images }
      const serialized = JSON.stringify(mixed)
      if (serialized === binding.saved) return
      await this.bridge.writeComposerDraft(sessionId, mixed)
      binding.saved = serialized
    }).catch((error: unknown) => { this.report(error, sessionId) }).finally(() => {
      binding.writing = undefined
      // Shutdown can dispose browser scopes while a file read is pending.
      // Drain captured values only; never reread a disposed input shell.
      this.drain(sessionId, binding)
    })
  }
}
