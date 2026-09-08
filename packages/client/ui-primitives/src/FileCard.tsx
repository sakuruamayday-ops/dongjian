import { useState } from 'react'
import { Menu, type MenuEntry } from './Menu.tsx'
import { ReferenceIcon } from './ReferenceIcon.tsx'
import { IconChevronDownOutline14, IconDownloadOutline16, IconFolderOpenOutline16 } from './icons/index.tsx'
import css from './FileCard.module.css'

/** One application returned by the desktop operating system. */
export interface FileApplication {
  readonly id: string
  readonly name: string
  readonly isDefault: boolean
  readonly iconUrl?: string
}

/** Narrow native file operations, scoped by the caller to one workspace file. */
export interface FileCardActions {
  listApplications(this: void): Promise<readonly FileApplication[]>
  openWith(this: void, applicationId: string | null): Promise<void>
  reveal(this: void): Promise<void>
  saveCopy(this: void): Promise<void>
}

/** Caller-owned, localized card and native menu copy. */
export interface FileCardLabels {
  readonly open: string
  readonly openWith: string
  readonly defaultApplication: string
  readonly chooseOther: string
  readonly reveal: string
  readonly saveCopy: string
  readonly loading: string
  readonly failed: string
  readonly file: string
}

/**
 * Render a readable file card with a separate native-application menu.
 * @param props - File identity, explicit opener, native operations and localized labels.
 * @returns The file control; failures stay visible beside the original file.
 */
export function FileCard({ name, path, onOpen, actions, labels, status, phase }: {
  readonly name: string
  readonly path: string
  readonly onOpen: () => void | Promise<void>
  readonly actions?: FileCardActions | undefined
  readonly labels: FileCardLabels
  readonly status?: string | undefined
  readonly phase?: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const [applications, setApplications] = useState<readonly FileApplication[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase().slice(0, 12) : ''
  const perform = async (action: () => void | Promise<void>): Promise<void> => {
    setOpen(false)
    setBusy(true)
    setError(false)
    try { await action() } catch { setError(true) } finally { setBusy(false) }
  }
  const toggleMenu = async (): Promise<void> => {
    if (open) { setOpen(false); return }
    if (actions === undefined) return
    setOpen(true)
    setLoading(true)
    setError(false)
    setApplications([])
    try { setApplications(await actions.listApplications()) }
    catch { setError(true) }
    finally { setLoading(false) }
  }
  const items: MenuEntry[] = loading ? [{ id: 'loading', label: labels.loading, disabled: true }] : [
    { id: 'default', label: labels.defaultApplication, icon: <ReferenceIcon kind="file" /> },
    ...applications.map(application => ({
      id: `app:${application.id}`,
      label: `${application.name}${application.isDefault ? ` (${labels.defaultApplication})` : ''}`,
      icon: application.iconUrl === undefined ? <ReferenceIcon kind="file" /> : <img className={css.appIcon} src={application.iconUrl} alt="" />,
    })),
    { id: 'other', label: labels.chooseOther },
    { id: 'file-actions', type: 'separator' },
    { id: 'reveal', label: labels.reveal, icon: <IconFolderOpenOutline16 /> },
    { id: 'save', label: labels.saveCopy, icon: <IconDownloadOutline16 /> },
  ]
  return <div className={css.wrapper} data-file-card>
    <div className={css.card} aria-busy={busy || undefined}>
      <button type="button" className={css.open} title={path} aria-label={labels.open} disabled={busy}
        onClick={() => { void perform(onOpen) }}>
        <span className={css.icon}><ReferenceIcon kind="file" /></span>
        <span className={css.text}>
          <span className={css.name}>{name}</span>
          <span className={css.meta}>{labels.file}{extension !== '' && ` · ${extension}`}
            {status !== undefined && <span className={css.status} data-phase={phase}>{status}</span>}
          </span>
        </span>
      </button>
      {actions !== undefined && <Menu open={open} align="end" portal compact items={items}
        onClose={() => { setOpen(false) }}
        anchor={<button type="button" className={css.menu} disabled={busy} aria-haspopup="menu" aria-expanded={open}
          onClick={() => { void toggleMenu() }}>{labels.openWith}<IconChevronDownOutline14 /></button>}
        onSelect={(id) => {
          void perform(() => id === 'default' ? onOpen()
            : id === 'reveal' ? actions.reveal()
              : id === 'save' ? actions.saveCopy()
                : actions.openWith(id === 'other' ? null : id.slice(4)))
        }} />}
    </div>
    {error && <span role="alert" className={css.error}>{labels.failed}</span>}
  </div>
}
