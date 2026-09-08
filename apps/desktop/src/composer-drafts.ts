/** Durable unsent composer state that must survive changing loopback origins. */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export const COMPOSER_DRAFT_READ_CHANNEL = 'gongchuang:composer-draft:read'
export const COMPOSER_DRAFT_WRITE_CHANNEL = 'gongchuang:composer-draft:write'
export const COMPOSER_DRAFT_CLEAR_CHANNEL = 'gongchuang:composer-draft:clear'

const MAX_SESSIONS = 500
const MAX_TEXT_LENGTH = 500_000
const MAX_DOCUMENTS = 64
const MAX_ANNOTATIONS = 100
const MAX_SERIALIZED_BYTES = 4 * 1024 * 1024
const IMPORT_DIRECTORY_PREFIX = '导入资料/'

export interface ComposerDraftDocument {
  readonly name: string
  readonly relativePath: string
  readonly bytes: number
}

export interface ComposerDraftAnnotation {
  readonly index: number
  readonly text: string
  readonly comment: string
  readonly source: { readonly nodeKey: string; readonly kind: 'user' | 'assistant' }
}

export interface ComposerDraftValue {
  readonly text: string
  readonly documents: readonly ComposerDraftDocument[]
  readonly annotations: readonly ComposerDraftAnnotation[]
  readonly nextAnnotationIndex: number
  readonly images?: readonly ComposerDraftImage[]
}

export interface ComposerDraftImage {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly data: string
  readonly name?: string
}

interface ComposerDraftDocumentFile {
  readonly schemaVersion: 1
  readonly sessions: Readonly<Record<string, ComposerDraftValue>>
}

const EMPTY_FILE: ComposerDraftDocumentFile = Object.freeze({ schemaVersion: 1, sessions: Object.freeze({}) })

function sessionKey(value: unknown): string {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error('待发送草稿会话标识无效')
  return value
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) {
    throw new Error(`${label}超出可保存范围`)
  }
  return value
}

function documentValue(value: unknown): ComposerDraftDocument {
  if (typeof value !== 'object' || value === null) throw new Error('待发送附件记录无效')
  const { name, relativePath, bytes } = value as Partial<ComposerDraftDocument>
  const importedName = typeof relativePath === 'string' ? relativePath.slice(IMPORT_DIRECTORY_PREFIX.length) : ''
  if (
    typeof name !== 'string' || name.length === 0 || name.length > 160
    || typeof relativePath !== 'string' || relativePath.length <= IMPORT_DIRECTORY_PREFIX.length
    || relativePath.length > 4_096 || !relativePath.startsWith(IMPORT_DIRECTORY_PREFIX)
    || relativePath.includes('\\') || relativePath.includes('\0') || relativePath.split('/').includes('..')
    || importedName.includes('/') || /[\u0000-\u001f\u007f<>:"\\|?*]/u.test(importedName)
    || importedName !== name || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0
  ) throw new Error('待发送附件记录无效')
  return Object.freeze({ name, relativePath, bytes })
}

function annotationValue(value: unknown, previousIndex: number): ComposerDraftAnnotation {
  if (typeof value !== 'object' || value === null) throw new Error('待发送注释记录无效')
  const { index, text, comment, source } = value as Record<string, unknown>
  const origin = typeof source === 'object' && source !== null ? source as Record<string, unknown> : undefined
  if (
    typeof index !== 'number' || !Number.isSafeInteger(index) || index <= previousIndex
    || typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT_LENGTH
    || typeof comment !== 'string' || comment.length > MAX_TEXT_LENGTH
    || origin === undefined
    || typeof origin.nodeKey !== 'string' || origin.nodeKey.length === 0 || origin.nodeKey.length > 1_024
    || (origin.kind !== 'user' && origin.kind !== 'assistant')
  ) throw new Error('待发送注释记录无效')
  return Object.freeze({ index, text, comment, source: Object.freeze({ nodeKey: origin.nodeKey, kind: origin.kind }) })
}

function imageValue(value: unknown): ComposerDraftImage {
  if (typeof value !== 'object' || value === null) throw new Error('待发送图片记录无效')
  const { mediaType, data, name } = value as Partial<ComposerDraftImage>
  if (
    (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp' && mediaType !== 'image/gif')
    || typeof data !== 'string' || data.length === 0 || data.length > MAX_SERIALIZED_BYTES
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data) || Buffer.from(data, 'base64').toString('base64') !== data
    || (name !== undefined && (typeof name !== 'string' || name.length > 160 || /[\u0000-\u001f\u007f]/u.test(name)))
  ) throw new Error('待发送图片记录无效或超出可保存范围')
  return Object.freeze({ mediaType, data, ...(name === undefined ? {} : { name }) })
}

/** Validate every renderer-supplied field before it reaches native storage. */
export function composerDraftValue(value: unknown): ComposerDraftValue {
  if (typeof value !== 'object' || value === null) throw new Error('待发送草稿无效')
  const { text, documents, annotations, nextAnnotationIndex, images } = value as Partial<ComposerDraftValue>
  if (!Array.isArray(documents) || documents.length > MAX_DOCUMENTS) throw new Error('待发送附件数量无效')
  if (!Array.isArray(annotations) || annotations.length > MAX_ANNOTATIONS) throw new Error('待发送注释数量无效')
  if (images !== undefined && (!Array.isArray(images) || images.length > MAX_DOCUMENTS)) {
    throw new Error('待发送图片数量无效')
  }
  const restoredDocuments = documents.map(documentValue)
  const restoredAnnotations: ComposerDraftAnnotation[] = []
  for (const annotation of annotations) {
    restoredAnnotations.push(annotationValue(annotation, restoredAnnotations.at(-1)?.index ?? 0))
  }
  if (
    typeof nextAnnotationIndex !== 'number' || !Number.isSafeInteger(nextAnnotationIndex)
    || nextAnnotationIndex <= (restoredAnnotations.at(-1)?.index ?? 0)
  ) throw new Error('待发送注释序号无效')
  const restored = Object.freeze({
    text: textValue(text, '待发送文字'),
    documents: Object.freeze(restoredDocuments),
    annotations: Object.freeze(restoredAnnotations),
    nextAnnotationIndex,
    ...(images === undefined ? {} : { images: Object.freeze(images.map(imageValue)) }),
  })
  if (Buffer.byteLength(JSON.stringify(restored), 'utf8') > MAX_SERIALIZED_BYTES) {
    throw new Error('待发送草稿超出可保存大小')
  }
  return restored
}

function isEmpty(value: ComposerDraftValue): boolean {
  return value.text === '' && value.documents.length === 0 && value.annotations.length === 0
    && (value.images?.length ?? 0) === 0
}

/** Atomic private draft storage; file references and pasted image bytes never include credentials. */
export class ComposerDraftStore {
  private file: ComposerDraftDocumentFile | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filename: string) {}

  read(sessionId: unknown): Promise<ComposerDraftValue | null> {
    const id = sessionKey(sessionId)
    return this.serial(async () => {
      const file = await this.load()
      return file.sessions[id] ?? null
    })
  }

  write(sessionId: unknown, raw: unknown): Promise<void> {
    const id = sessionKey(sessionId)
    const value = composerDraftValue(raw)
    return this.serial(async () => {
      const file = await this.load()
      const sessions = new Map(Object.entries(file.sessions))
      if (isEmpty(value)) sessions.delete(id)
      else sessions.set(id, value)
      if (sessions.size > MAX_SESSIONS) throw new Error('待发送草稿会话数超出上限')
      await this.persist(Object.fromEntries(sessions))
    })
  }

  clear(sessionId: unknown): Promise<void> {
    const id = sessionKey(sessionId)
    return this.serial(async () => {
      const file = await this.load()
      if (file.sessions[id] === undefined) return
      const sessions = new Map(Object.entries(file.sessions))
      sessions.delete(id)
      await this.persist(Object.fromEntries(sessions))
    })
  }

  /** Wait for already admitted draft writes before the desktop process exits. */
  flush(): Promise<void> {
    return this.queue
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async load(): Promise<ComposerDraftDocumentFile> {
    if (this.file !== undefined) return this.file
    try {
      const raw: unknown = JSON.parse(await readFile(this.filename, 'utf8'))
      if (typeof raw !== 'object' || raw === null || (raw as { schemaVersion?: unknown }).schemaVersion !== 1) {
        this.file = EMPTY_FILE
        return this.file
      }
      const source = (raw as { sessions?: unknown }).sessions
      if (typeof source !== 'object' || source === null || Array.isArray(source)) {
        this.file = EMPTY_FILE
        return this.file
      }
      const sessions: Record<string, ComposerDraftValue> = {}
      for (const [id, candidate] of Object.entries(source)) {
        try { sessions[sessionKey(id)] = composerDraftValue(candidate) } catch { /* Ignore only the invalid entry. */ }
      }
      this.file = Object.freeze({ schemaVersion: 1, sessions: Object.freeze(sessions) })
    } catch {
      this.file = EMPTY_FILE
    }
    return this.file
  }

  private async persist(sessions: Record<string, ComposerDraftValue>): Promise<void> {
    const file = Object.freeze({ schemaVersion: 1 as const, sessions: Object.freeze(sessions) })
    const serialized = `${JSON.stringify(file)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES) {
      throw new Error('待发送草稿文件超出可保存大小')
    }
    await writeFileAtomic(this.filename, serialized, { mode: 0o600, dirMode: 0o700 })
    this.file = file
  }
}
