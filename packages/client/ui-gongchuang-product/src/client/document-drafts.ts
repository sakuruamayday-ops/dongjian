import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ConversationPromptPreparation, PreparedConversationPrompt,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { UserMessageDisplay } from '@deepseek-ai/dsh-client-ui-chat/client'

/** One file copied into the active workspace for the pending conversation turn. */
export interface ImportedDocument {
  readonly name: string
  readonly relativePath: string
  readonly bytes: number
}

const EMPTY_DOCUMENTS: readonly ImportedDocument[] = Object.freeze([])
const DOCUMENT_DRAFT_PERSIST_PREFIX = 'gongchuang.document-drafts.v1'
const IMPORT_DIRECTORY_PREFIX = '导入资料/'
const LEGACY_HEADINGS = new Set(['本次对话已添加的文件：', '已添加到当前企业空间的文件：'])
const LEGACY_DOCUMENT_ROW = /^- `([^`\n]+)`$/u
const IMPORTED_DOCUMENT_LINE_RE = /^@"(导入资料\/([^"\\/\u0000-\u001f\u007f<>:|?*]+))"$/u

/**
 * Decide whether a path is one exact product-controlled imported-document reference.
 * @param path - Workspace-relative path proposed by a Chat file control.
 * @returns true only for one direct child of the controlled import directory.
 */
export function isImportedDocumentReference(path: string): boolean {
  const match = IMPORTED_DOCUMENT_LINE_RE.exec(`@"${path}"`)
  return match !== null && match[2] !== '.' && match[2] !== '..'
}

/**
 * Decide whether a path occupies the product's controlled import namespace.
 * @param path - Workspace-relative path proposed for opening.
 * @returns true when the desktop validator must own the request.
 */
export function isImportedDocumentNamespace(path: string): boolean {
  return path.startsWith(IMPORT_DIRECTORY_PREFIX)
}

/** Result of moving pre-V0.2.9 visible attachment blocks into product state. */
export interface MigratedDocumentDraft {
  readonly draft: string
  readonly documents: readonly ImportedDocument[]
}

/** Hook-facing attachment view for one conversation composer. */
export interface ConversationDocumentDraftState {
  readonly documents: readonly ImportedDocument[]
}

/**
 * Extract exact leading document-import rows from one persisted display projection.
 * @param text - Persisted user-facing message text.
 * @returns Original body and ordered controlled document references.
 */
export function projectImportedDocumentMessage(text: string): UserMessageDisplay {
  const lines = text.split('\n')
  const files: UserMessageDisplay['files'][number][] = []
  let bodyStart = 0
  for (const line of lines) {
    const match = IMPORTED_DOCUMENT_LINE_RE.exec(line)
    if (match === null || !isImportedDocumentReference(match[1] as string)) break
    files.push(Object.freeze({ path: match[1] as string, name: match[2] as string }))
    bodyStart += 1
  }
  return Object.freeze({
    text: lines.slice(bodyStart).join('\n'),
    files: files.length === 0 ? Object.freeze([]) : Object.freeze(files),
  })
}

function persistedDocuments(value: unknown): readonly ImportedDocument[] {
  if (typeof value !== 'object' || value === null || !('documents' in value)) return EMPTY_DOCUMENTS
  const documents = (value as { readonly documents?: unknown }).documents
  if (!Array.isArray(documents)) return EMPTY_DOCUMENTS
  const restored: ImportedDocument[] = []
  for (const candidate of documents) {
    if (typeof candidate !== 'object' || candidate === null) return EMPTY_DOCUMENTS
    const { name, relativePath, bytes } = candidate as Partial<ImportedDocument>
    const importedName = typeof relativePath === 'string'
      ? relativePath.slice(IMPORT_DIRECTORY_PREFIX.length)
      : ''
    if (
      typeof name !== 'string'
      || name.length === 0
      || name.length > 160
      || typeof relativePath !== 'string'
      || relativePath.length <= IMPORT_DIRECTORY_PREFIX.length
      || relativePath.length > 4_096
      || !relativePath.startsWith(IMPORT_DIRECTORY_PREFIX)
      || relativePath.includes('\\')
      || relativePath.includes('\0')
      || relativePath.split('/').includes('..')
      || importedName.includes('/')
      || /[\u0000-\u001f\u007f<>:"\\|?*]/u.test(importedName)
      || importedName !== name
      || typeof bytes !== 'number'
      || !Number.isSafeInteger(bytes)
      || bytes < 0
    ) return EMPTY_DOCUMENTS
    restored.push(Object.freeze({ name, relativePath, bytes }))
  }
  return restored.length === 0 ? EMPTY_DOCUMENTS : Object.freeze(restored)
}

/**
 * Remove old product-generated attachment prose while preserving its file references.
 * @param draft - Editable text saved by an older client.
 * @returns Clean user text and the recovered pending file references.
 */
export function migrateLegacyDocumentDraft(draft: string): MigratedDocumentDraft {
  const lines = draft.split('\n')
  const kept: string[] = []
  const documents: ImportedDocument[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!LEGACY_HEADINGS.has(line)) {
      kept.push(line)
      continue
    }
    while (index + 1 < lines.length) {
      const match = LEGACY_DOCUMENT_ROW.exec(lines[index + 1] ?? '')
      if (match === null) break
      const relativePath = match[1] as string
      documents.push(Object.freeze({
        name: relativePath.split('/').at(-1) ?? relativePath,
        relativePath,
        bytes: 0,
      }))
      index += 1
    }
    if (kept.at(-1) === '') kept.pop()
  }
  return Object.freeze({ draft: kept.join('\n'), documents: Object.freeze(documents) })
}

/**
 * Add pending document references to the model request without changing the visible draft.
 * @param text - User-authored task text.
 * @param documents - Pending workspace files for the next turn.
 * @returns Model-facing text with the controlled workspace references appended.
 */
export function documentPrompt(text: string, documents: readonly ImportedDocument[]): string {
  const rows = documents.map(document => `- \`${document.relativePath}\``).join('\n')
  const prefix = text.trim() === '' ? '' : `${text}\n\n`
  // Office/PDF attachments should reach the installed reader, not a newly
  // improvised parser. This is model context only; the visible draft stays intact.
  const readerExtensions = new Set([
    'doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'wps', 'wpt',
    'xls', 'xlsx', 'xlsm', 'xlt', 'xltx', 'xltm', 'et', 'ett',
    'ppt', 'pptx', 'pptm', 'pot', 'potx', 'ppsx', 'dps', 'dpt',
    'odt', 'ods', 'odp', 'rtf', 'pdf',
  ])
  const needsDocumentReader = documents.some((document) => {
    const extension = document.name.split('.').at(-1)?.toLocaleLowerCase('en-US')
    return extension !== undefined && readerExtensions.has(extension)
  })
  const reader = needsDocumentReader
    ? '\n\n文档读取：需要读取 Office、PDF 或 WPS 附件时，先加载 project-application-assistant 技能，只执行其中“企业资料导入与读取”，再调用现成的 gongchuang_skill_operation，operation 为 project-application-assistant.extract-workspace-document，parameters.document 为上面的实际相对路径字符串。按当前工具目录通过 tools 调用；不要重新编写解析脚本或探测安装目录。保留已提取正文，仅对返回的 ocr_pages 补充 OCR。此读取指引不启动首次配置、企业分析或报告任务。'
    : ''
  return `${prefix}本次任务可读取以下企业工作区文件：\n${rows}${reader}`
}

function documentDisplayText(documents: readonly ImportedDocument[]): string {
  return documents.map(document => `@"${document.relativePath.replaceAll('"', '\\"')}"`).join('\n')
}

/** Per-session attachment state consumed only after a successful real send. */
export class ConversationDocumentDrafts implements ConversationPromptPreparation {
  private readonly stores = new Map<SessionId, SnapshotStore<ConversationDocumentDraftState>>()

  /**
   * Return the stable observable bound to one session's framework hook.
   * @param sessionId - Owning conversation session.
   * @returns Stable attachment store for that session.
   */
  storeFor(sessionId: SessionId): SnapshotStore<ConversationDocumentDraftState> {
    const current = this.stores.get(sessionId)
    if (current !== undefined) return current
    const store = createSnapshotStore<ConversationDocumentDraftState>(
      { documents: EMPTY_DOCUMENTS },
      { persist: { name: `${DOCUMENT_DRAFT_PERSIST_PREFIX}.${sessionId}` } },
    )
    const restored = persistedDocuments(store.getSnapshot())
    if (restored !== store.getSnapshot().documents) store.set({ documents: restored })
    this.stores.set(sessionId, store)
    return store
  }

  /**
   * Read the stable attachment snapshot for one composer.
   * @param sessionId - Owning conversation session.
   * @returns Current pending document references.
   */
  snapshot(sessionId: SessionId): readonly ImportedDocument[] {
    return this.storeFor(sessionId).getSnapshot().documents
  }

  /**
   * Restore a native draft only when this origin has no newer attachment choices.
   * @param sessionId - Owning conversation session.
   * @param documents - Native draft value to validate before restoration.
   */
  restoreIfEmpty(sessionId: SessionId, documents: unknown): void {
    if (this.snapshot(sessionId).length > 0) return
    const restored = persistedDocuments({ documents })
    if (restored.length > 0) this.storeFor(sessionId).set({ documents: restored })
  }

  /** Imported documents are sufficient to form an attachment-only prompt. */
  hasPayload(sessionId: SessionId): boolean {
    return this.snapshot(sessionId).length > 0
  }

  /**
   * Add imported files while preserving the first-seen order and latest metadata.
   * @param sessionId - Owning conversation session.
   * @param added - Newly imported document references.
   */
  add(sessionId: SessionId, added: readonly ImportedDocument[]): void {
    if (added.length === 0) return
    const next = new Map(this.snapshot(sessionId).map(document => [document.relativePath, document]))
    for (const document of added) next.set(document.relativePath, Object.freeze({ ...document }))
    this.commit(sessionId, Object.freeze([...next.values()]))
  }

  /**
   * Stop referencing one file in the pending turn without touching its workspace copy.
   * @param sessionId - Owning conversation session.
   * @param relativePath - Workspace-relative reference to remove.
   */
  remove(sessionId: SessionId, relativePath: string): void {
    const next = this.snapshot(sessionId).filter(document => document.relativePath !== relativePath)
    if (next.length === this.snapshot(sessionId).length) return
    this.commit(sessionId, Object.freeze(next))
  }

  /**
   * Forget every pending reference for a conversation removed from the desktop client.
   * @param sessionId - Deleted conversation session.
   */
  clear(sessionId: SessionId): void {
    this.stores.get(sessionId)?.set({ documents: EMPTY_DOCUMENTS })
    this.stores.delete(sessionId)
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.removeItem(`${DOCUMENT_DRAFT_PERSIST_PREFIX}.${sessionId}`)
    } catch {
      // Browser storage failures do not weaken Host-side deletion; an invalid
      // stale draft remains scoped to the deleted opaque session id.
    }
  }

  /** Append attachments to a submitted prompt and clear them only after send succeeds. */
  prepare(sessionId: SessionId, text: string): PreparedConversationPrompt | undefined {
    const documents = this.snapshot(sessionId)
    if (documents.length === 0) return undefined
    return {
      text: documentPrompt(text, documents),
      displayPrefix: documentDisplayText(documents),
      settle: (outcome) => {
        if (outcome !== 'success') return
        const store = this.stores.get(sessionId)
        if (store === undefined) return
        // 发送只消费本次快照；等待期间新导入或重新添加的附件属于下一条消息。
        const remaining = store.getSnapshot().documents.filter(document => !documents.includes(document))
        store.set({ documents: remaining.length === 0 ? EMPTY_DOCUMENTS : Object.freeze(remaining) })
      },
    }
  }

  private commit(sessionId: SessionId, documents: readonly ImportedDocument[]): void {
    this.storeFor(sessionId).set({ documents })
  }
}

/** Apply product prompt preparations in order while settling every participating mode once. */
export class ProductPromptPreparation implements ConversationPromptPreparation {
  constructor(
    private readonly preparations: readonly ConversationPromptPreparation[],
    private readonly summarizeDisplayText?: (displayText: string) => string | undefined,
  ) {}

  summarize(displayText: string): string | undefined {
    return this.summarizeDisplayText?.(displayText)
  }

  hasPayload(sessionId: SessionId): boolean {
    return this.preparations.some(preparation => preparation.hasPayload?.(sessionId) === true)
  }

  prepare(sessionId: SessionId, text: string): PreparedConversationPrompt | undefined {
    const prepared: PreparedConversationPrompt[] = []
    let current = text
    for (const preparation of this.preparations) {
      const next = preparation.prepare(sessionId, current)
      if (next === undefined) continue
      prepared.push(next)
      current = next.text
    }
    if (prepared.length === 0) return undefined
    const displayPrefix = prepared
      .map(result => result.displayPrefix)
      .filter((value): value is string => value !== undefined && value !== '')
      .join('\n')
    const displayBody = text === ''
      ? prepared.findLast(result => result.displayText !== undefined)?.displayText
      : text
    const displayText = [displayPrefix, displayBody]
      .filter((value): value is string => value !== undefined && value !== '')
      .join('\n')
    return {
      text: current,
      ...(displayText === '' ? {} : { displayText }),
      settle: (outcome) => {
        for (const result of prepared) result.settle(outcome)
      },
    }
  }
}
