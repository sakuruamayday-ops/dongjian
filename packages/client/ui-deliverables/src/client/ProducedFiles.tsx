import { useEffect, useState } from 'react'
import { FileCard, LinkIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { basename, type ProducedFileEntry } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import css from './ProducedFiles.module.css'

/** Maximum number of full file cards before the expandable remainder. */
const SHOWN_LIMIT = 6

/** Registration-side Host capability facts. */
export interface ProducedFilesInjected {
  /** Whether the browser itself is connected over loopback. */
  isLoopback: boolean
  /** Load the opener capability when this row first reaches the page. */
  ensureWorkspacePathOpen(): void
  hooks: {
    /** Current generation's Session workspace opener capability. */
    workspacePathOpen: HostObservable<boolean | undefined>
  }
}

/** Matched paths plus the opener, locale, and injected Host capability. */
export type ProducedFilesProps = Pick<TurnTailOwnerProps, 'openFile' | 'fileActions'> & {
  matched: readonly (string | ProducedFileEntry)[]
} & PropsLocale<typeof NS> & InjectFace<ProducedFilesInjected>

function moreLabel(t: ProducedFilesProps['t'], count: number): string {
  return count === 1 ? t('produced.moreOne') : t('produced.more', { count: String(count) })
}

/**
 * Render one turn's produced files as full cards with native open actions.
 * @param props - selector-matched paths, the chat view's file opener, and the locale seat.
 * @returns The produced-files row.
 */
export function ProducedFiles({
  matched, openFile, fileActions, isLoopback, ensureWorkspacePathOpen, useWorkspacePathOpen, t,
}: ProducedFilesProps) {
  const [expanded, setExpanded] = useState(false)
  const entries = matched.map(value => typeof value === 'string' ? { path: value } : value)
  const paths = entries.map(entry => entry.path)
  const issues = [...new Set(entries.flatMap(entry => entry.issues ?? []))]
  useEffect(() => { ensureWorkspacePathOpen() }, [ensureWorkspacePathOpen])
  const hostCanOpenPath = useWorkspacePathOpen(available => available === true)
  const canOpenPath = isLoopback && hostCanOpenPath
  const shown = expanded ? entries : entries.slice(0, SHOWN_LIMIT)
  return (
    <div className={css.root}>
      <span className={css.label}>{t('produced.label')}</span>
      <div className={css.lane}>
        <div className={css.row} data-produced-files-row>
          {shown.map(({ path, phase }) => (
            <FileCard key={path} name={basename(path)} path={path} onOpen={() => { openFile(path) }}
              actions={fileActions?.(path)} phase={phase} status={phase === undefined ? undefined : t(`produced.${phase}`)}
              labels={{
                open: t('produced.open', { name: path }), openWith: t('produced.openWith'),
                defaultApplication: t('produced.defaultApp'), chooseOther: t('produced.chooseOther'),
                reveal: t('produced.showInFolder'), saveCopy: t('produced.saveCopy'),
                loading: t('produced.loading'), failed: t('produced.actionFailed'), file: t('produced.file'),
              }} />
          ))}
          {!expanded && entries.length > SHOWN_LIMIT && <button type="button" className={css.more}
            onClick={() => { setExpanded(true) }}>{moreLabel(t, entries.length - SHOWN_LIMIT)}</button>}
        </div>
        {paths.length > 1 && canOpenPath && (
          <button
            type="button"
            className={css.showFolder}
            onClick={() => { openFile('.') }}
          >
            <LinkIcon kind="folder" className={css.fileIcon} />
            {t('produced.showInFolder')}
          </button>
        )}
        {issues.length > 0 && <details className={css.diagnostics}>
          <summary>{t('produced.diagnostics')}</summary>
          <ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
        </details>}
      </div>
    </div>
  )
}
