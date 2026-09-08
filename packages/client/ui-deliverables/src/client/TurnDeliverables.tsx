import { MarkdownText, IconCopyOutline16, useCopyFeedback } from '@deepseek-ai/dsh-client-ui-primitives'
import { ProducedFiles, type ProducedFilesProps } from './ProducedFiles.tsx'
import type { TurnDeliverablesMatch } from './turn-deliverables.ts'
import css from './ProducedFiles.module.css'

/** File cards and any retained, explicitly unverified text share the existing turn tail. */
export type TurnDeliverablesProps = Omit<ProducedFilesProps, 'matched'> & { matched: TurnDeliverablesMatch }

/** A rejected candidate stays readable and copyable without being presented as checked. */
export function TurnDeliverables({ matched, ...props }: TurnDeliverablesProps) {
  const { t } = props
  const { copied, onCopy } = useCopyFeedback(matched.draftText ?? '')
  return <>
    {matched.draftText && <section className={css.draft} aria-label={t('draft.title')} data-unverified-draft>
      <div className={css.draftHeader}>
        <strong>{t('draft.title')}</strong>
        <button type="button" className={css.copyDraft} onClick={onCopy}
          aria-label={copied ? t('draft.copied') : t('draft.copy')}
          title={copied ? t('draft.copied') : t('draft.copy')}>
          <IconCopyOutline16 />
        </button>
      </div>
      <p className={css.draftWarning}>{t('draft.warning')}</p>
      {matched.issues.length > 0 && <details className={css.diagnostics} open>
        <summary>{t('produced.diagnostics')}</summary>
        <ul>{matched.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
      </details>}
      <MarkdownText text={matched.draftText} labels={{
        code: { copyLabel: t('draft.copy'), copiedLabel: t('draft.copied') },
        footnotes: t('draft.footnotes'),
      }} />
    </section>}
    {matched.files.length > 0 && <ProducedFiles {...props} matched={matched.files} />}
  </>
}
