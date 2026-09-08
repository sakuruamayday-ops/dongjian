import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCloseOutline16, IconDownloadOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NS } from './locales.ts'
import type { ProductUpdateProgress, ProductUpdateSnapshot } from './ProductShell.tsx'
import css from './UpdateNotification.module.css'

/**
 * Announce an actual update without downloading or quitting on the user's behalf.
 * @param props - Host state, shared settings actions and product translator.
 * @returns A dismissible red notice and public changelog dialog.
 */
export function UpdateNotification({ snapshot, progress, busy, download, install, compact = false, t }: PropsLocale<typeof NS> & {
  readonly snapshot: ProductUpdateSnapshot | null
  readonly progress: ProductUpdateProgress | null
  readonly busy: 'check' | 'download' | 'install' | null
  readonly download: () => void
  readonly install: () => void
  readonly compact?: boolean
}) {
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  if (snapshot === null || (snapshot.status !== 'available' && snapshot.status !== 'downloaded')) return null
  const ready = snapshot.status === 'downloaded'
  const key = `${snapshot.latestVersion ?? ''}:${snapshot.status}`
  const title = t(ready ? 'update.ready' : 'update.available', { version: snapshot.latestVersion ?? '' })
  const status = busy === 'install' ? t('update.installing')
    : busy !== 'download' ? title
      : progress === null ? t('update.connecting')
        : progress.phase === 'verifying' ? t('update.verifying')
          : t('update.progress', { percent: Math.floor(progress.percent) })
  const upgradeButton = <button type="button" className={css.primary} disabled={busy !== null} onClick={ready ? install : download}>
    {t(ready ? 'update.restart' : (snapshot.resumableBytes ?? 0) > 0 ? 'update.resume' : 'update.download')}
  </button>
  return <>
    {dismissed !== key && (compact ? <button type="button" className={css.compact} aria-label={title} title={title}
      data-update-notification onClick={() => { setNotesOpen(true) }}><IconDownloadOutline16 /><span /></button>
      : <section className={css.notice} aria-label={t('update.notice')} data-update-notification>
        <IconDownloadOutline16 />
        <div className={css.status} role="status" aria-live="polite">
          <strong>{status}</strong>
          {busy === 'download' && progress?.phase === 'downloading' && <>
            <progress value={progress.percent} max={100} aria-label={t('update.download')} />
            {progress.remainingSeconds !== null && <span>{t('update.remaining', { seconds: Math.ceil(progress.remainingSeconds) })}</span>}
          </>}
        </div>
        <div className={css.actions}>
          <button type="button" onClick={() => { setNotesOpen(true) }}>{t('update.notes')}</button>
          {upgradeButton}
          <button type="button" className={css.close} aria-label={t('update.dismiss')} onClick={() => { setDismissed(key) }}><IconCloseOutline16 /></button>
        </div>
      </section>)}
    <Modal open={notesOpen} onClose={() => { setNotesOpen(false) }} title={t('update.notes')} closeLabel={t('update.dismiss')}>
      <div className={css.notes}>{snapshot.releaseNotes?.trim() || t('update.noNotes')}</div>
      {compact && <div className={css.actions}><span role="status">{status}</span>{upgradeButton}</div>}
    </Modal>
  </>
}
