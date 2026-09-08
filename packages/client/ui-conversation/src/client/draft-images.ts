import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { DraftAttachmentId, SubmitAttachment } from './contract/input.ts'
import type { InputHub } from './input/hub.ts'
import type { ConversationController } from './service.ts'

/** Persistable image arm of the unified composer attachment payload. */
export type SubmitImageAttachment = Omit<Extract<SubmitAttachment, { readonly type: 'image' }>, 'type'>

/** Product persistence access to browser-owned images, without exposing the editor. */
export interface ConversationDraftImages {
  /**
   * Observe the ordered image identities owned by one composer.
   * @param sessionId - Materialized session.
   * @returns Stable ordered image-id source.
   */
  source(sessionId: SessionId): ObservableSnapshot<readonly DraftAttachmentId[]>
  /**
   * Serialize browser-owned images through the ordinary send owner.
   * @param ids - Current image ids.
   * @returns Image bytes suitable for native draft storage.
   */
  serialize(ids: readonly DraftAttachmentId[]): Promise<readonly SubmitImageAttachment[]>
  /**
   * Restore native-validated images when the composer has no newer image choice.
   * @param sessionId - Owning session.
   * @param images - Native-validated image payloads.
   */
  restoreIfEmpty(sessionId: SessionId, images: readonly SubmitImageAttachment[]): void
}

/** Keeps restored images in the same registry and lifecycle as freshly pasted images. */
export class ConversationDraftImagesController implements ConversationDraftImages {
  private readonly sources = new Map<SessionId, ObservableSnapshot<readonly DraftAttachmentId[]>>()

  constructor(private readonly input: InputHub, private readonly conversation: () => ConversationController) {}

  source(sessionId: SessionId): ObservableSnapshot<readonly DraftAttachmentId[]> {
    const existing = this.sources.get(sessionId)
    if (existing !== undefined) return existing
    const state = this.input.shell(sessionId).state
    let observedIds: readonly DraftAttachmentId[] | undefined
    let imageIds: readonly DraftAttachmentId[] = []
    const source: ObservableSnapshot<readonly DraftAttachmentId[]> = {
      getSnapshot: () => {
        const nextIds = state.getSnapshot().attachmentIds
        if (observedIds === nextIds) return imageIds
        observedIds = nextIds
        const images = new Set(this.conversation().resolveDraftAttachments(nextIds)
          .filter(attachment => attachment.kind === 'image')
          .map(attachment => attachment.id))
        imageIds = nextIds.filter(id => images.has(id))
        return imageIds
      },
      subscribe: listener => state.subscribe(listener),
    }
    this.sources.set(sessionId, source)
    return source
  }

  serialize(ids: readonly DraftAttachmentId[]): Promise<readonly SubmitImageAttachment[]> {
    return this.conversation().serializeDraftAttachments(ids).then(result => result.attachments.map((attachment) => {
      if (attachment.type !== 'image') {
        throw new Error('conversation draft image persistence received a non-image attachment')
      }
      return {
        mediaType: attachment.mediaType,
        data: attachment.data,
        ...(attachment.name === undefined ? {} : { name: attachment.name }),
      }
    }))
  }

  restoreIfEmpty(sessionId: SessionId, images: readonly SubmitImageAttachment[]): void {
    const shell = this.input.shell(sessionId)
    if (images.length === 0 || this.source(sessionId).getSnapshot().length !== 0) return
    const files = images.map(image => new File(
      [Uint8Array.from(atob(image.data), char => char.charCodeAt(0))],
      image.name ?? '', { type: image.mediaType },
    ))
    const owner = this.conversation()
    const restored = owner.createDrafts(sessionId, files)
    if (!shell.addAttachments(restored.map(image => image.id))) owner.releaseDraftAttachments(restored)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional product persistence adapter for browser-owned image drafts. */
    conversationDraftImages: ConversationDraftImages
  }
}
