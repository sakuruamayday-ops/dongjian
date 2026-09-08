/** Chat-owned Slot declarations and composed component props. */
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {
  CommandNode, CompactionSummaryNode, ConversationLocationDataStore, ConversationTurnDataMap,
  MessageImageLoader, MessageImagesOwnerProps, RenderMessageImages, ToolCallBlock, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  InjectFace, KeyedSnapshotSelectorHook, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
  SlotHookFactory, SnapshotSelectorHook, HostObservable,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { FileCardActions, MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createChatStore } from '../stores.ts'
import type { ToolCallId, SelectionTarget } from './store.ts'
import type { ChatConversationViewNode, ChatNode, ChatNodeKind } from './chat-nodes.ts'
import type {
  ChatNodeProcessSource, ChatNodeSource, ChatSnapshot, ChatTurnProcessPresentation,
} from './snapshot.ts'
import type { TurnProcessSpec } from './turn-process.ts'
import type { TranscriptViewMode } from '../../chat-settings.ts'

/** Selector hook over the current Conversation binding's Chat target. */
export type UseChat = SnapshotSelectorHook<ChatSnapshot>

/** Per-key selector hook over one Chat Node. */
export type UseChatNode = KeyedSnapshotSelectorHook<ChatConversationViewNode | undefined>

/** Per-key selector hook over one Chat Node's Turn-process presentation. */
export type UseChatNodeProcess = KeyedSnapshotSelectorHook<ChatTurnProcessPresentation | undefined>

/** Owner currency of the completed-Turn extension chain. */
export interface TurnTailOwnerProps {
  turn: TurnLocation
  seq: number
  /** Actual session directory used to resolve relative tool paths. */
  cwd?: string | undefined
  openFile: (path: string) => void
  fileActions?: ((path: string) => FileCardActions | undefined) | undefined
}

/** Owner currency of finalized-assistant actions. */
export interface AssistantActionOwnerProps {
  messageId: MessageId
}

/** Optional prose file-mention provider consumed by Chat. */
export interface ChatFileMentions {
  /**
   * Resolve prose links for one closing Turn.
   * @param owner - closing-Turn identity and file opener.
   * @returns link resolver when available.
   */
  forClosing(owner: TurnTailOwnerProps): MarkdownFileMentions | undefined
}

/** One product-owned file control projected from a sent user message. */
export interface UserMessageDisplayFile {
  /** Opaque path returned to the owning product when the control is activated. */
  readonly path: string
  /** User-facing file name. */
  readonly name: string
}

/** Selected history text and its stable Chat origin, not a new user instruction. */
export interface ChatTextSelection {
  readonly text: string
  readonly source: {
    readonly nodeKey: string
    readonly kind: 'user' | 'assistant'
  }
}

/** One numbered selection and optional user-authored comment in a sent message. */
export interface UserMessageAnnotation extends ChatTextSelection {
  readonly index: number
  readonly comment: string
}

/** One source-message marker; identity includes its owning submitted message or draft. */
export interface ChatAnnotationMarker extends UserMessageAnnotation {
  readonly id: string
  /** Submission ordinal, shown only when separate submissions reuse this number. */
  readonly round?: number
}

/** Optional product owner of numbered selection drafts. */
export interface ChatSelectionAnnotations {
  /**
   * Add a selection to its own conversation without modifying the text draft.
   * @param sessionId - Conversation that owns the selection and annotation draft.
   * @param selection - Historical text and its stable Chat origin.
   */
  add(sessionId: string, selection: ChatTextSelection): void
  /**
   * Observe annotations attached to one source message.
   * @param sessionId - Owning conversation.
   * @param nodeKey - Quoted message.
   * @returns Its live numbered references.
   */
  source(sessionId: string, nodeKey: string): HostObservable<readonly ChatAnnotationMarker[]>
}

/** Product-owned presentation of one persisted user-facing message string. */
export interface UserMessageDisplay {
  /** User-authored body after product file rows are removed. */
  readonly text: string
  /** Ordered file controls shown above the body. */
  readonly files: readonly UserMessageDisplayFile[]
  /** Numbered historical selections kept separate from the user-authored body. */
  readonly annotations?: readonly UserMessageAnnotation[]
}

/** Optional product provider for user-message file presentation and opening. */
export interface ChatUserMessageFiles {
  /**
   * Resolve native file actions within a conversation's workspace.
   * @param sessionId - Owning conversation.
   * @param path - Workspace file.
   * @returns Available native operations.
   */
  actions?(sessionId: string, path: string): FileCardActions | undefined
  /**
   * Project product-owned file rows out of a user-facing message.
   * @param text - Persisted user-facing text.
   * @returns Body text and ordered file controls.
   */
  project(text: string): UserMessageDisplay
  /**
   * Handle one projected file activation.
   * @param sessionId - Session owning the user message.
   * @param path - Opaque path emitted by {@link project}.
   * @returns true when handled; false delegates to the ordinary workspace opener.
   */
  open(sessionId: string, path: string): Promise<boolean>
  /**
   * Open one durable generic attachment after the desktop Host authorizes it against the Session log.
   * @param sessionId - Session owning the durable attachment.
   * @param attachment - Exact reference rendered by Chat.
   */
  openAttachment?(sessionId: string, attachment: FileAttachmentRef): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional prose file-mention provider. */
    chatFileMentions: ChatFileMentions
    /** Optional product-owned user-message file projection. */
    chatUserMessageFiles: ChatUserMessageFiles
    /** Optional owner of per-session quoted selections. */
    chatSelectionAnnotations: ChatSelectionAnnotations
  }
}

/** Hook constrained to business data published on the current Chat Node's Turn. */
export type UseChatNodeTurnData = <Key extends Extract<keyof ConversationTurnDataMap, string>>(
  key: Key,
) => Readonly<ConversationTurnDataMap[Key]> | undefined

/** Slot-level Hook factory for keyed Chat renderers. */
export interface ChatNodeTurnDataInjected {
  hooks: { turnData: SlotHookFactory<'conversation.chat.node', UseChatNodeTurnData> }
}

/** Stable owner currency delivered to a keyed Chat renderer. */
export interface ChatNodeOwnerProps {
  selectedCallId?: ToolCallId | undefined
  cwd?: string | undefined
  openFile: (path: string) => void
  openAttachment?: ((attachment: FileAttachmentRef) => void) | undefined
  fileActions?: ((path: string) => FileCardActions | undefined) | undefined
  projectUserMessage: (text: string) => UserMessageDisplay
  inspectCall: (callId: ToolCallId) => void
  forkAt: (seq: number) => void
  /**
   * Session-authorized image loader, down-threaded from the Chat view so a
   * chat-node renderer can render the attachment presentation slot directly
   * with only the durable references plus this loader, instead of receiving a
   * rendering closure.
   */
  loadImage: MessageImageLoader
  renderMessageImages: RenderMessageImages
  fileMentions: (owner: TurnTailOwnerProps) => MarkdownFileMentions | undefined
  /** Turn-process state when this Node belongs to a projected Turn. */
  turnProcess?: TurnProcessOwnerProps | undefined
}

/** Shared presentation state for one Turn-process answer generation. */
export interface TurnProcessOwnerProps {
  readonly spec: TurnProcessSpec
  readonly foldable: boolean
  readonly open: boolean
  setOpen(open: boolean): void
}

/** Full props of one keyed Chat renderer. */
export type ChatNodeViewProps<Kind extends ChatNodeKind = ChatNodeKind> =
  PropsRuntime<'conversation.chat.node', Kind> & PropsLocale<'chat'>

/** Tool block rendered in the details panel. */
export interface DetailsToolOwnerProps {
  block: ToolCallBlock
  cwd?: string | undefined
}

/** Command-row owner share. */
export interface CommandRowOwnerProps {
  node: CommandNode
  compaction?: CompactionSummaryNode
}

/** Full props of a registered command row. */
export type CommandRowProps = PropsRuntime<'conversation.chat.commandview'>

/** Shared Chat store handle. */
export type ChatStore = ReturnType<typeof createChatStore>

/** In-memory reader position resilient to transcript reflow. */
export interface ChatScrollPosition {
  readonly anchorKey: string
  readonly anchorTop: number
  readonly scrollTop: number
}

/** Business callbacks injected into the Chat view. */
export interface ChatViewInjected {
  hooks: {
    /** Persisted completed-Turn transcript presentation. */
    transcriptView: SnapshotStore<TranscriptViewMode>
  }
  keyedHooks: {
    /** Resolve the stable source for one Chat Node key. */
    chatNode: (key: string) => ChatNodeSource
    /** Resolve the stable Turn-process source for one Chat Node key. */
    chatNodeProcess: (key: string) => ChatNodeProcessSource
    /** Numbered references to one quoted source message. */
    chatAnnotationMarkers: (key: string) => HostObservable<readonly ChatAnnotationMarker[]>
  }
  openDetails: (target: SelectionTarget) => void
  openFile: (path: string) => Promise<void>
  openAttachment?: ((attachment: FileAttachmentRef) => Promise<void>) | undefined
  fileActions?: ((path: string) => FileCardActions | undefined) | undefined
  projectUserMessage: (text: string) => UserMessageDisplay
  loadOlder: () => void
  /** True when a product consumes the selection; otherwise keep the ordinary quote action. */
  addSelectionAnnotation?: (selection: ChatTextSelection) => boolean
  /** Jump loader: page history back through seq; resolves when the window covers it. */
  loadThrough: (seq: SessionSeq) => Promise<void>
  loadImage: MessageImageLoader
  chatScroll: {
    save: (position: ChatScrollPosition | null) => void
    read: () => ChatScrollPosition | null
  }
  forkAt: (seq: number) => void
  fileMentions: (owner: TurnTailOwnerProps) => MarkdownFileMentions | undefined
}

/** Full Chat view props. */
export type ChatViewSlotProps =
  PropsRuntime<'conversation.view'>
  & PropsRenderSlots<'conversation.chat.node' | 'conversation.message.images'>
  & PropsStore<ChatStore>
  & InjectFace<ChatViewInjected>
  & PropsLocale<'chat'>

/** Full props of the durable-message image renderer. */
export type MessageImagesProps = PropsRuntime<'conversation.message.images'> & PropsLocale<'conversation'>

/** Details-panel callbacks. */
export interface DetailsInjected {
  closeDetails: () => void
}

/** Full details-panel props. */
export type DetailsSlotProps =
  PropsRuntime<'details'>
  & PropsRenderSlots<'conversation.details.tool'>
  & PropsStore<ChatStore>
  & InjectFace<DetailsInjected>
  & PropsLocale<'chat'>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** Selector hook over the current Conversation binding's Chat target. */
    useChat: UseChat
  }

  interface LocaleNamespaceMap {
    /** Chat target, transcript node, statistics, and details copy. */
    chat: import('../locale.ts').ChatKey
  }

  interface SlotMap {
    /**
     * Final Chat node renderer, keyed by `ChatNodeKind`. The component receives
     * the typed node, shared Chat actions, and Turn-data hook. Reusing a key
     * replaces that node renderer; a kind with no occupant renders no row.
     */
    'conversation.chat.node': {
      kind: 'keyed'
      scope: 'session'
      owner: ChatNodeOwnerProps
      keyProps: { [Kind in ChatNodeKind]: { node: ChatNode<Kind> } }
      hookContext: ConversationLocationDataStore<ConversationTurnDataMap> | undefined
      inject: ChatNodeTurnDataInjected
    }
    /**
     * Renderer for one consecutive group of durable message images. The owner
     * supplies image references, an authorized loader, and alignment. A
     * registration replaces the shipped gallery; without one, images are omitted.
     */
    'conversation.message.images': { kind: 'single'; scope: 'session'; owner: MessageImagesOwnerProps }
    /**
     * Command row keyed by the command name. The component receives the folded
     * command lifecycle and linked compaction when present. Reusing a key
     * replaces that command renderer; an unoccupied key uses the generic card.
     */
    'conversation.chat.commandview': { kind: 'keyed'; scope: 'session'; owner: CommandRowOwnerProps }
    /**
     * Selector-routed extension before a completed Turn's action row. The
     * component receives the Turn, closing sequence, and file opener. The first
     * selector that accepts the owner renders; an all-declined chain is empty.
     */
    'conversation.chat.turnTail': { kind: 'chain'; scope: 'session'; owner: TurnTailOwnerProps }
    /**
     * Ordered actions for one finalized assistant message. Each entry receives
     * the durable message id; a fresh `id` adds an action and reusing one replaces
     * that entry. With no entries, the standard action row remains unchanged.
     */
    'conversation.chat.assistant-actions': { kind: 'list'; scope: 'session'; owner: AssistantActionOwnerProps }
    /**
     * Whole details-panel body for the selected Tool call. The component receives
     * the running or settled block and optional workspace root. A registration
     * replaces the shipped Tool details renderer; absence uses the raw fallback.
     */
    'conversation.details.tool': { kind: 'single'; scope: 'session'; owner: DetailsToolOwnerProps }
  }
}
