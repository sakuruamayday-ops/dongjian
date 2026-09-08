import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconBrowseOutline16, IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ProductShell.module.css'
import draftCss from './ComposerDraftRail.module.css'

const IMAGE_ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
import type { ConversationDocumentDraftState } from './document-drafts.ts'

export interface DocumentImportInjected {
  importDocuments: (files?: readonly File[]) => Promise<number>
}

export type DocumentImportControlProps =
  PropsRuntime<'conversation.input.left'> & DocumentImportInjected & PropsLocale<'gongchuangProduct'>

export interface DocumentImportRailInjected {
  hooks: {
    /** Pending files bound by the renderer as useDocumentDrafts. */
    documentDrafts: SnapshotStore<ConversationDocumentDraftState>
  }
  /** Migrate product-generated attachment prose left in drafts by older clients. */
  migrateLegacyDraft: (draft: string) => void
  /** Stop referencing one imported file in the current pending message. */
  removeDocument: (relativePath: string) => void
  /** Open one imported file through the desktop Host's controlled path resolver. */
  openDocument: (relativePath: string) => Promise<void>
}

/** Composer payload state plus the product document-removal operation. */
export type DocumentImportRailProps =
  PropsRuntime<'conversation.input.payload'> & InjectFace<DocumentImportRailInjected> & PropsLocale<'gongchuangProduct'>

function importedDocumentName(relativePath: string): string {
  return relativePath.split('/').at(-1) ?? relativePath
}

function importedDocumentType(relativePath: string, fallback: string): string {
  const name = importedDocumentName(relativePath)
  const extension = name.includes('.') ? name.split('.').at(-1) : undefined
  return extension === undefined || extension === '' ? fallback : extension.toUpperCase()
}

/**
 * Render removable document references inside the composer card.
 * @param props - Current input snapshot and document-removal operation.
 * @returns The attachment rail, or nothing when the draft has no imported documents.
 */
export function DocumentImportRail({
  input, inputActions, useDocumentDrafts, migrateLegacyDraft, removeDocument, openDocument, t,
}: DocumentImportRailProps) {
  const documents = useDocumentDrafts(state => state.documents)
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { migrateLegacyDraft(input.draft) }, [input.draft, migrateLegacyDraft])
  useEffect(() => { inputActions.refreshExternalPayload?.() }, [documents, inputActions])
  if (documents.length === 0) return null
  const locked = input.phase !== 'plain'
  return (
    <div className={draftCss.rail} role="list" aria-label={t('documents.added')}>
      {documents.map((document, index) => {
        const name = document.name || importedDocumentName(document.relativePath)
        return (
          <span className={css.documentImportChip} role="listitem" key={`${document.relativePath}:${String(index)}`}>
            <button
              type="button"
              className={css.documentImportOpen}
              disabled={opening === document.relativePath}
              aria-label={t('documents.open', { name })}
              title={t('documents.open', { name })}
              onClick={() => {
                setOpening(document.relativePath)
                setError(null)
                void openDocument(document.relativePath)
                  .catch((failure: unknown) => {
                    setError(failure instanceof Error ? failure.message : t('documents.openFailed'))
                  })
                  .finally(() => { setOpening(null) })
              }}
            >
              <span className={css.documentImportIcon} aria-hidden="true">
                <IconBrowseOutline16 size={18} />
              </span>
              <span className={css.documentImportDetails}>
                <span className={css.documentImportName}>{name}</span>
                <span className={css.documentImportType}>
                  {importedDocumentType(document.relativePath, t('documents.file'))}
                </span>
              </span>
            </button>
            <button
              type="button"
              className={css.documentImportRemove}
              disabled={locked}
              aria-label={t('documents.remove', { name })}
              title={t('documents.removeTitle')}
              onClick={() => { removeDocument(document.relativePath) }}
            >
              <IconCloseFill14 size={14} />
            </button>
          </span>
        )
      })}
      {error !== null && <span className={css.documentImportRailError} role="alert">{error}</span>}
    </div>
  )
}

/** Desktop-only document picker in the resident conversation composer. */
export function DocumentImportControl({
  useSession, useInput, importDocuments, locked: composerLocked, onAddFiles, t,
}: DocumentImportControlProps) {
  // alpha.4 intentionally exposes selector hooks here instead of passing whole
  // Session/Input snapshots through every composer child. Keep this control on
  // that boundary so long conversations do not make unrelated controls rerender.
  const removed = useSession(state => state.removed)
  const input = useInput(state => state)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const locked = composerLocked || removed || input.phase !== 'plain'
  const select = useCallback(async (files?: readonly File[]): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await importDocuments(files)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }, [importDocuments])

  useEffect(() => {
    const documentTransfer = (event: globalThis.DragEvent): DataTransfer | null => {
      const transfer = event.dataTransfer
      if (transfer === null || !transfer.types.includes('Files')) return null
      const files = [...transfer.files]
      if (files.length > 0) return files.some(file => !IMAGE_ATTACHMENT_TYPES.has(file.type)) ? transfer : null
      const items = [...transfer.items].filter(item => item.kind === 'file')
      return items.some(item => !IMAGE_ATTACHMENT_TYPES.has(item.type)) ? transfer : null
    }
    const consume = (event: globalThis.DragEvent): DataTransfer | null => {
      const transfer = documentTransfer(event)
      if (transfer === null) return null
      event.preventDefault()
      event.stopImmediatePropagation()
      return transfer
    }
    const reset = (): void => {
      dragDepth.current = 0
      setDragActive(false)
    }
    const onDragEnter = (event: globalThis.DragEvent): void => {
      if (consume(event) === null) return
      dragDepth.current += 1
      setDragActive(true)
    }
    const onDragOver = (event: globalThis.DragEvent): void => {
      const transfer = consume(event)
      if (transfer !== null) transfer.dropEffect = locked || busy ? 'none' : 'copy'
    }
    const onDragLeave = (event: globalThis.DragEvent): void => {
      if (consume(event) === null) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragActive(false)
    }
    const onDrop = (event: globalThis.DragEvent): void => {
      const transfer = consume(event)
      if (transfer === null) return
      reset()
      if (locked || busy) return
      const files = [...transfer.files]
      const images = files.filter(file => IMAGE_ATTACHMENT_TYPES.has(file.type))
      const documents = files.filter(file => !IMAGE_ATTACHMENT_TYPES.has(file.type))
      // Images remain on DSH attachment intake; documents enter the Workspace so the OS can open them later.
      if (images.length > 0) onAddFiles(images)
      if (documents.length > 0) void select(documents)
    }
    document.addEventListener('dragenter', onDragEnter, true)
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('dragleave', onDragLeave, true)
    document.addEventListener('drop', onDrop, true)
    window.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', onDragEnter, true)
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('dragleave', onDragLeave, true)
      document.removeEventListener('drop', onDrop, true)
      window.removeEventListener('dragend', reset)
    }
  }, [busy, locked, onAddFiles, select])

  return (
    <span className={css.documentImportControl}>
      {dragActive && createPortal(
        <div className={css.documentDropMask} role="status">
          <div className={css.documentDropPanel}>
            <span aria-hidden="true"><IconBrowseOutline16 size={22} /></span>
            <div className={css.documentDropTitle}>
              {locked || busy ? t('documents.dropUnavailable') : t('documents.dropReady')}
            </div>
          </div>
        </div>,
        document.body,
      )}
      <button
        type="button"
        className={css.documentImportButton}
        disabled={locked || busy}
        aria-label={t('documents.add')}
        title={t('documents.add')}
        onClick={() => { void select() }}
      >
        <span aria-hidden="true">＋</span>{busy ? t('documents.adding') : t('documents.file')}
      </button>
      {error !== null && <span className={css.documentImportError} role="alert">{error}</span>}
    </span>
  )
}
