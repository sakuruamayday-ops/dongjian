import type {
  ConversationPromptAdmission, ConversationPromptAdmissionOutcome,
  ConversationPromptAdmissionRequest,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { GongchuangModelProvider } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { GONGCHUANG_MODEL_PROVIDERS } from '@gongchuang/model-connections/registry'

/** Product model provider that may receive a user image. */
export type ImageTransferProvider = GongchuangModelProvider

/** Native persistence that survives changes to the renderer's loopback port. */
export interface ImageTransferConsentStorage {
  /** @returns provider IDs explicitly approved on this device. */
  read(): Promise<readonly ImageTransferProvider[]>
  /**
   * @param provider - provider explicitly approved in the displayed dialog.
   * @returns completion after durable storage commits the approval.
   */
  remember(provider: ImageTransferProvider): Promise<void>
  /** Localized rejection shown when durable consent cannot be read or saved. */
  readonly failureMessage: string
}

/** Observable state for the first-image transfer confirmation dialog. */
export interface ImageTransferConsentState {
  phase: 'idle' | 'pending'
  provider: ImageTransferProvider | null
  imageCount: number
  revision: number
}

const CONSENT_STORAGE_KEY = 'gongchuang.image-transfer-consent.v1'
const PROVIDERS = new Set<ImageTransferProvider>(GONGCHUANG_MODEL_PROVIDERS.map(provider => provider.id))

function readConsents(): Set<ImageTransferProvider> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const value = JSON.parse(localStorage.getItem(CONSENT_STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(value)) return new Set()
    return new Set(value.filter((entry): entry is ImageTransferProvider => (
      typeof entry === 'string' && PROVIDERS.has(entry as ImageTransferProvider)
    )))
  } catch {
    return new Set()
  }
}

function writeConsents(consents: ReadonlySet<ImageTransferProvider>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify([...consents]))
  } catch {
    // The in-memory consent remains valid for this renderer session.
  }
}

interface PendingConsent {
  readonly provider: ImageTransferProvider
  readonly signal: AbortSignal
  readonly onAbort: () => void
  readonly resolve: (outcome: ConversationPromptAdmissionOutcome) => void
  saving: boolean
}

/** Serializes first-image consent before the conversation can serialize or upload an attachment. */
export class ImageTransferConsentController implements ConversationPromptAdmission {
  /** Current consent-dialog state for renderer subscribers. */
  readonly store: SnapshotStore<ImageTransferConsentState> = createSnapshotStore({
    phase: 'idle', provider: null, imageCount: 0, revision: 0,
  })

  private consents: Set<ImageTransferProvider>
  private pending: PendingConsent | null = null
  private disposed = false

  constructor(
    private readonly currentProvider: () => ImageTransferProvider,
    private readonly storage?: ImageTransferConsentStorage,
  ) {
    // Native launches have a new origin. Never infer native consent from that origin's localStorage.
    this.consents = storage === undefined ? readConsents() : new Set()
  }

  /** Admit image sends immediately after one explicit consent for the current provider. */
  admit(
    request: ConversationPromptAdmissionRequest,
    signal: AbortSignal,
  ): Promise<ConversationPromptAdmissionOutcome> {
    if (request.imageCount <= 0) return Promise.resolve({ kind: 'allow' })
    if (signal.aborted || this.disposed) return Promise.resolve({ kind: 'reject' })
    const storage = this.storage
    if (storage === undefined) return this.admitReady(request, signal)
    return storage.read().then((providers) => {
      this.consents = new Set(providers)
      return this.admitReady(request, signal)
    }, () => ({ kind: 'reject', text: storage.failureMessage }))
  }

  private admitReady(
    request: ConversationPromptAdmissionRequest,
    signal: AbortSignal,
  ): Promise<ConversationPromptAdmissionOutcome> {
    if (signal.aborted || this.disposed) return Promise.resolve({ kind: 'reject' })
    const provider = this.currentProvider()
    if (this.consents.has(provider)) return Promise.resolve({ kind: 'allow' })
    if (this.pending !== null) {
      return Promise.resolve({
        kind: 'reject',
        text: '已有一项图片传输授权等待处理；本次草稿和附件已保留。',
      })
    }

    return new Promise((resolve) => {
      const onAbort = (): void => { this.finish({ kind: 'reject' }) }
      this.pending = { provider, signal, onAbort, resolve, saving: false }
      signal.addEventListener('abort', onAbort, { once: true })
      this.store.update((draft) => {
        draft.phase = 'pending'
        draft.provider = provider
        draft.imageCount = request.imageCount
        draft.revision += 1
      })
    })
  }

  /** Remember the displayed provider and continue only if it is still the active route. */
  approve(): void {
    const pending = this.pending
    if (pending === null || pending.saving) return
    if (this.currentProvider() !== pending.provider) {
      this.finish({
        kind: 'reject',
        text: '图片发送期间模型服务发生变化；本次草稿和附件已保留，请重新发送。',
      })
      return
    }
    const commit = (): void => {
      if (this.pending !== pending) return
      if (this.currentProvider() !== pending.provider) {
        this.finish({ kind: 'reject', text: '图片发送期间模型服务发生变化；本次草稿和附件已保留，请重新发送。' })
        return
      }
      this.consents.add(pending.provider)
      if (this.storage === undefined) writeConsents(this.consents)
      this.finish({ kind: 'allow' })
    }
    const storage = this.storage
    if (storage === undefined) commit()
    else {
      pending.saving = true
      void storage.remember(pending.provider).then(commit, () => {
        if (this.pending === pending) this.finish({ kind: 'reject', text: storage.failureMessage })
      })
    }
  }

  /** Cancel the current image send without consuming the composer draft or attachments. */
  reject(): void {
    if (this.pending === null) return
    this.finish({
      kind: 'reject',
      text: '已取消图片传输；本次草稿和附件已保留。',
    })
  }

  /** Settle a pending UI request when the product plugin is disposed. */
  dispose(): void {
    this.disposed = true
    this.finish({ kind: 'reject' })
  }

  private finish(outcome: ConversationPromptAdmissionOutcome): void {
    const pending = this.pending
    if (pending === null) return
    this.pending = null
    pending.signal.removeEventListener('abort', pending.onAbort)
    this.store.update((draft) => {
      draft.phase = 'idle'
      draft.provider = null
      draft.imageCount = 0
    })
    pending.resolve(outcome)
  }
}
