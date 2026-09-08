/** Manual desktop update state exposed to the sandboxed product renderer. */

export const UPDATE_CHECK_CHANNEL = 'gongchuang:update:check'
export const UPDATE_DOWNLOAD_CHANNEL = 'gongchuang:update:download'
export const UPDATE_INSTALL_CHANNEL = 'gongchuang:update:install'
export const UPDATE_PROGRESS_CHANNEL = 'gongchuang:update:progress'

/** Official generic feed embedded in normal desktop builds. */
export const DEFAULT_DESKTOP_UPDATE_FEED_URL = 'https://zshjiaotang.cn/client-updates/v0.2/'

export type DesktopUpdateStatus = 'unconfigured' | 'current' | 'available' | 'downloaded' | 'error'

/** Redacted updater result safe to cross Electron IPC. */
export interface DesktopUpdateSnapshot {
  readonly status: DesktopUpdateStatus
  readonly currentVersion: string
  readonly latestVersion: string | null
  readonly message: string
  readonly resumableBytes?: number
  readonly releaseNotes?: string
}

/** Live progress for a signed desktop archive download. */
export interface DesktopUpdateProgress {
  readonly phase: 'downloading' | 'verifying'
  readonly latestVersion: string
  readonly receivedBytes: number
  readonly totalBytes: number
  readonly percent: number
  readonly remainingSeconds: number | null
  readonly resumedFromBytes: number
}

interface UpdateCheckResultLike {
  readonly isUpdateAvailable: boolean
  readonly updateInfo: {
    readonly version: string
    readonly releaseNotes?: string | readonly { readonly version: string; readonly note: string | null }[] | null
  }
}

/** Minimum electron-updater face used by the product controller. */
export interface DesktopAutoUpdater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  setFeedURL(options: { readonly provider: 'generic'; readonly url: string }): void
  checkForUpdates(): Promise<UpdateCheckResultLike | null>
  downloadUpdate(): Promise<readonly string[]>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

const noBeforeInstall = (): Promise<void> => Promise.resolve()

function normalizedFeedUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('客户端更新源必须使用无凭据 HTTPS 地址')
  }
  url.hash = ''
  return url.href
}

function isMissingUpdateManifest(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { readonly statusCode?: unknown; readonly message?: unknown }
  return candidate.statusCode === 404
    || (typeof candidate.message === 'string' && /\b404\b/u.test(candidate.message))
}

/** Keep an explicit override for isolated tests while making production usable out of the box. */
export function desktopUpdateFeedUrl(override: string | undefined): string {
  return override?.trim() || DEFAULT_DESKTOP_UPDATE_FEED_URL
}

/** Own explicit check and install transitions without installing on an unrelated app quit. */
export class DesktopUpdaterController {
  private readonly feedUrl: string | undefined
  private latestVersion: string | null = null
  private downloaded = false
  private releaseNotes = ''
  private downloading: Promise<DesktopUpdateSnapshot> | null = null
  private installing: Promise<DesktopUpdateSnapshot> | null = null

  constructor(
    private readonly updater: DesktopAutoUpdater,
    private readonly currentVersion: string,
    feedUrl?: string,
  ) {
    this.feedUrl = normalizedFeedUrl(feedUrl)
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    if (this.feedUrl !== undefined) updater.setFeedURL({ provider: 'generic', url: this.feedUrl })
  }

  /** Check the configured signed release feed without downloading. */
  async check(): Promise<DesktopUpdateSnapshot> {
    const active = this.activeOperationSnapshot()
    if (active !== null) return active
    if (this.feedUrl === undefined) {
      return this.snapshot('unconfigured', '当前为内部测试版本，正式更新通道尚未配置')
    }
    try {
      const result = await this.updater.checkForUpdates()
      const afterCheck = this.activeOperationSnapshot()
      if (afterCheck !== null) return afterCheck
      if (result === null) return this.snapshot('error', '当前系统未启用自动更新')
      if (this.latestVersion !== result.updateInfo.version || !result.isUpdateAvailable) this.downloaded = false
      this.latestVersion = result.updateInfo.version
      const notes = result.updateInfo.releaseNotes
      this.releaseNotes = (typeof notes === 'string' ? notes : notes?.map(row => row.note ?? '').join('\n\n') ?? '').slice(0, 8_000)
      return result.isUpdateAvailable
        ? this.snapshot(this.downloaded ? 'downloaded' : 'available', this.downloaded ? '更新已下载，可重启升级' : `发现客户端 V${result.updateInfo.version}`)
        : this.snapshot('current', '当前已是最新版本')
    } catch (error) {
      const afterCheck = this.activeOperationSnapshot()
      if (afterCheck !== null) return afterCheck
      if (isMissingUpdateManifest(error)) {
        this.latestVersion = null
        this.downloaded = false
        return this.snapshot('error', '更新清单暂不可用，请稍后重试')
      }
      return this.snapshot('error', '检查更新失败，请确认网络后重试')
    }
  }

  private activeOperationSnapshot(): DesktopUpdateSnapshot | null {
    if (this.installing !== null) return this.snapshot('downloaded', '正在退出并安装更新')
    if (this.downloading !== null) return this.snapshot('available', '更新正在下载')
    return null
  }

  /** Download without quitting; installation requires a separate user action. */
  download(): Promise<DesktopUpdateSnapshot> {
    if (this.downloading !== null) return this.downloading
    if (this.downloaded) return Promise.resolve(this.snapshot('downloaded', '更新已下载，可重启升级'))
    const pending = this.performDownload().finally(() => { this.downloading = null })
    this.downloading = pending
    return pending
  }

  private async performDownload(): Promise<DesktopUpdateSnapshot> {
    if (this.feedUrl === undefined || this.latestVersion === null) {
      return this.snapshot('error', '请先检查更新')
    }
    try {
      await this.updater.downloadUpdate()
      this.downloaded = true
    } catch {
      this.downloaded = false
      return this.snapshot('error', '更新下载失败，请确认网络后重试')
    }
    return this.snapshot('downloaded', `客户端 V${this.latestVersion} 已下载，可重启升级`)
  }

  /** User-confirmed native installation of the completed download. */
  install(beforeInstall: () => Promise<void> = noBeforeInstall): Promise<DesktopUpdateSnapshot> {
    // Settings and the update notice share one installation even if both are clicked.
    if (this.installing !== null) return this.installing
    const pending = this.performInstall(beforeInstall).finally(() => { this.installing = null })
    this.installing = pending
    return pending
  }

  private async performInstall(beforeInstall: () => Promise<void>): Promise<DesktopUpdateSnapshot> {
    if (!this.downloaded) return this.snapshot('error', '尚未完成更新下载')
    try {
      await beforeInstall()
      this.updater.quitAndInstall(false, true)
      return this.snapshot('downloaded', '正在退出并安装更新')
    } catch {
      return this.snapshot('error', '安装前关闭未完成，请重试安装')
    }
  }

  private snapshot(status: DesktopUpdateStatus, message: string): DesktopUpdateSnapshot {
    return Object.freeze({
      status, currentVersion: this.currentVersion, latestVersion: this.latestVersion,
      message, releaseNotes: this.releaseNotes,
    })
  }
}
