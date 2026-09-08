import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutline16, IconListPenOutline16 } from './icons/index.tsx'
import { Tooltip } from './Tooltip.tsx'
import { useAnchoredPosition } from './useAnchoredPosition.ts'
import { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer.ts'
import css from './AnnotationSummary.module.css'

/** Presentation-only numbered quote, shared by draft and sent-message summaries. */
export interface NumberedAnnotation {
  readonly index: number
  readonly text: string
  readonly comment: string
}

/** All chrome is localized by the owning feature; quoted content stays verbatim. */
export interface AnnotationSummaryProps {
  annotations: readonly NumberedAnnotation[]
  countLabel: string
  itemLabel: (index: number) => string
  closeLabel: string
  side?: 'top' | 'bottom'
  /** A source-message marker shows only the associated number. */
  variant?: 'summary' | 'marker'
  editing?: {
    disabled: boolean
    commentLabel: (index: number) => string
    removeLabel: (index: number) => string
    onComment: (index: number, comment: string) => void
    onRemove: (index: number) => void
  }
}

/**
 * Render a compact count that opens an accessible list of numbered annotations.
 * @param props - Quoted data, localized labels, and optional draft-edit callbacks.
 * @returns A count pill and its viewport-constrained nonmodal panel.
 */
export function AnnotationSummary({
  annotations, countLabel, itemLabel, closeLabel, editing, side = 'bottom', variant = 'summary',
}: AnnotationSummaryProps) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const visible = open && annotations.length > 0
  const position = useAnchoredPosition({ open: visible, anchorRef: trigger, panelRef: panel, side, gap: 8, margin: 12 })
  useDismissOnOutsidePointer(trigger, visible, setOpen, panel)
  useEffect(() => { if (visible) panel.current?.focus() }, [visible])
  useEffect(() => { if (annotations.length === 0) setOpen(false) }, [annotations.length])
  const close = (): void => {
    setOpen(false)
    trigger.current?.focus()
  }
  const firstAnnotation = annotations[0]
  if (firstAnnotation === undefined) return null
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={css.trigger}
        data-variant={variant}
        aria-label={variant === 'marker' ? itemLabel(firstAnnotation.index) : undefined}
        aria-haspopup="dialog"
        aria-expanded={visible}
        aria-controls={visible ? id : undefined}
        onClick={() => { setOpen(value => !value) }}
      >
        {variant !== 'marker' && <IconListPenOutline16 size={14} />}
        <span>{countLabel}</span>
      </button>
      {visible && createPortal(
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={countLabel}
          tabIndex={-1}
          className={css.panel}
          style={position ?? { visibility: 'hidden' }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.stopPropagation()
            if (event.key !== 'Escape') return
            event.stopPropagation()
            event.preventDefault()
            close()
          }}
          onBlur={(event) => {
            const next = event.relatedTarget
            if (next instanceof Node && !panel.current?.contains(next) && !trigger.current?.contains(next)) setOpen(false)
          }}
        >
          <header className={css.header}>
            <strong>{countLabel}</strong>
            <Tooltip label={closeLabel} side="bottom">
              <button type="button" className={css.iconButton} aria-label={closeLabel} onClick={close}>
                <IconCloseOutline16 size={16} />
              </button>
            </Tooltip>
          </header>
          <ol className={css.list}>
            {annotations.map(annotation => (
              <li key={annotation.index} value={annotation.index} className={css.item}>
                <div className={css.itemHeader}>
                  <strong>{itemLabel(annotation.index)}</strong>
                  {editing !== undefined && (
                    <Tooltip label={editing.removeLabel(annotation.index)} side="bottom">
                      <button
                        type="button"
                        className={css.iconButton}
                        disabled={editing.disabled}
                        aria-label={editing.removeLabel(annotation.index)}
                        onClick={() => {
                          panel.current?.focus()
                          editing.onRemove(annotation.index)
                        }}
                      >
                        <IconCloseOutline16 size={14} />
                      </button>
                    </Tooltip>
                  )}
                </div>
                <blockquote className={css.quote}>{annotation.text}</blockquote>
                {editing === undefined
                  ? annotation.comment !== '' && <p className={css.comment}>{annotation.comment}</p>
                  : (
                    <textarea
                      className={css.editor}
                      rows={2}
                      disabled={editing.disabled}
                      aria-label={editing.commentLabel(annotation.index)}
                      placeholder={editing.commentLabel(annotation.index)}
                      value={annotation.comment}
                      onChange={(event) => { editing.onComment(annotation.index, event.target.value) }}
                    />
                  )}
              </li>
            ))}
          </ol>
        </div>,
        document.body,
      )}
    </>
  )
}
