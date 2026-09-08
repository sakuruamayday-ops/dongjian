import { useEffect } from 'react'
import { AnnotationSummary } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationAnnotationDraftState } from './annotation-drafts.ts'
import css from './ComposerDraftRail.module.css'

/** Renderer-bound draft state and session-bound annotation operations. */
export interface AnnotationDraftRailInjected {
  hooks: { annotationDrafts: SnapshotStore<ConversationAnnotationDraftState> }
  removeAnnotation: (index: number) => void
  commentAnnotation: (index: number, comment: string) => void
}

type AnnotationDraftRailProps = PropsRuntime<'conversation.input.payload'>
  & InjectFace<AnnotationDraftRailInjected> & PropsLocale<'gongchuangProduct'>

/**
 * Keep quoted selections inside the composer card but outside the editable message.
 * @param props - Composer owner state, bound annotation state, and localized copy.
 * @returns A compact draft annotation summary, or nothing when empty.
 */
export function AnnotationDraftRail({
  input, inputActions, useAnnotationDrafts, removeAnnotation, commentAnnotation, t,
}: AnnotationDraftRailProps) {
  const annotations = useAnnotationDrafts(state => state.annotations)
  useEffect(() => { inputActions.refreshExternalPayload?.() }, [annotations, inputActions])
  if (annotations.length === 0) return null
  return (
    <div className={css.rail} data-annotation-draft>
      <AnnotationSummary
        annotations={annotations}
        side="top"
        countLabel={t('annotations.count', { count: annotations.length })}
        itemLabel={index => t('annotations.item', { index })}
        closeLabel={t('annotations.close')}
        editing={{
          disabled: input.phase !== 'plain',
          commentLabel: index => t('annotations.comment', { index }),
          removeLabel: index => t('annotations.remove', { index }),
          onComment: commentAnnotation,
          onRemove: removeAnnotation,
        }}
      />
    </div>
  )
}
