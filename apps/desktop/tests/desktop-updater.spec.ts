import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DESKTOP_UPDATE_FEED_URL,
  DesktopUpdaterController,
  desktopUpdateFeedUrl,
  type DesktopAutoUpdater,
} from '../src/desktop-updater.ts'

function fakeUpdater(available = true) {
  return {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    setFeedURL: vi.fn<DesktopAutoUpdater['setFeedURL']>(),
    checkForUpdates: vi.fn<DesktopAutoUpdater['checkForUpdates']>(async () => ({
      isUpdateAvailable: available, updateInfo: { version: available ? '0.1.1' : '0.1.0' },
    })),
    downloadUpdate: vi.fn<DesktopAutoUpdater['downloadUpdate']>(async () => ['/tmp/update']),
    quitAndInstall: vi.fn<DesktopAutoUpdater['quitAndInstall']>(),
  } satisfies DesktopAutoUpdater
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('desktop updater controller', () => {
  it('uses the official update feed unless an isolated environment overrides it', () => {
    expect(desktopUpdateFeedUrl(undefined)).toBe(DEFAULT_DESKTOP_UPDATE_FEED_URL)
    expect(desktopUpdateFeedUrl('')).toBe(DEFAULT_DESKTOP_UPDATE_FEED_URL)
    expect(desktopUpdateFeedUrl('https://staging.example.cn/client/')).toBe('https://staging.example.cn/client/')
  })

  it('reports an honest internal-build state when no update feed is configured', async () => {
    const updater = fakeUpdater()
    const controller = new DesktopUpdaterController(updater, '0.1.0')
    await expect(controller.check()).resolves.toMatchObject({ status: 'unconfigured', currentVersion: '0.1.0' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('keeps a checked and downloaded update ready until an explicit restart action', async () => {
    const updater = fakeUpdater()
    const controller = new DesktopUpdaterController(updater, '0.1.0', 'https://updates.example.cn/client/')
    expect(updater.autoInstallOnAppQuit).toBe(false)
    await expect(controller.install()).resolves.toMatchObject({ status: 'error' })
    await expect(controller.check()).resolves.toMatchObject({ status: 'available', latestVersion: '0.1.1' })
    const beforeInstall = vi.fn(async () => undefined)
    const downloaded = await controller.download()
    expect(downloaded.message).toContain('可重启升级')
    expect(beforeInstall).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    await expect(controller.check()).resolves.toMatchObject({ status: 'downloaded' })
    await controller.download()
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    const installed = await controller.install(beforeInstall)
    expect(installed.message).toContain('安装更新')
    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true)
  })

  it('admits a direct V0.2.0 to V0.2.3 update without an intermediate release', async () => {
    const updater = fakeUpdater()
    updater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '0.2.3' },
    })
    const controller = new DesktopUpdaterController(updater, '0.2.0', 'https://updates.example.cn/client/')

    await expect(controller.check()).resolves.toMatchObject({
      status: 'available', currentVersion: '0.2.0', latestVersion: '0.2.3',
    })
  })

  it('admits the direct V0.3.3 to V0.4.0 migration without an intermediate release', async () => {
    const updater = fakeUpdater()
    updater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '0.4.0' },
    })
    const controller = new DesktopUpdaterController(updater, '0.3.3', 'https://updates.example.cn/client/')

    await expect(controller.check()).resolves.toMatchObject({
      status: 'available', currentVersion: '0.3.3', latestVersion: '0.4.0',
    })
  })

  it('keeps a downloaded update pending when pre-install shutdown fails', async () => {
    const updater = fakeUpdater()
    const controller = new DesktopUpdaterController(updater, '0.1.0', 'https://updates.example.cn/client/')
    await controller.check()

    await controller.download()
    await expect(controller.install(async () => { throw new Error('close failed') })).resolves.toMatchObject({
      status: 'error', message: '安装前关闭未完成，请重试安装',
    })
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(updater.autoInstallOnAppQuit).toBe(false)

    await expect(controller.install()).resolves.toMatchObject({ status: 'downloaded' })
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('coalesces concurrent restart requests and preserves ready state while closing', async () => {
    const updater = fakeUpdater()
    const controller = new DesktopUpdaterController(updater, '0.1.0', 'https://updates.example.cn/client/')
    await controller.check()
    await controller.download()
    let release!: () => void
    const beforeInstall = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const first = controller.install(beforeInstall)
    expect(controller.install(beforeInstall)).toBe(first)
    await expect(controller.check()).resolves.toMatchObject({ status: 'downloaded', latestVersion: '0.1.1' })
    release()
    await first
    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
  })

  it.each([false, true])('keeps an in-flight download when an earlier check settles (failure=%s)', async (fails) => {
    const updater = fakeUpdater()
    const controller = new DesktopUpdaterController(updater, '0.1.0', 'https://updates.example.cn/client/')
    await controller.check()
    const checking = deferred<Awaited<ReturnType<DesktopAutoUpdater['checkForUpdates']>>>()
    const downloading = deferred<readonly string[]>()
    updater.checkForUpdates.mockReturnValueOnce(checking.promise)
    updater.downloadUpdate.mockReturnValueOnce(downloading.promise)
    const checked = controller.check()
    const downloaded = controller.download()
    if (fails) checking.reject(Object.assign(new Error('missing'), { statusCode: 404 }))
    else checking.resolve({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } })
    await expect(checked).resolves.toMatchObject({ status: 'available', latestVersion: '0.1.1' })
    downloading.resolve(['/tmp/update'])
    await expect(downloaded).resolves.toMatchObject({ status: 'downloaded', latestVersion: '0.1.1' })
  })

  it('exposes release notes and clears ready state for a newer version', async () => {
    const updater = fakeUpdater()
    const controller = new DesktopUpdaterController(updater, '0.1.0', 'https://updates.example.cn/client/')
    await controller.check()
    await controller.download()
    updater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true, updateInfo: { version: '0.1.2', releaseNotes: [{ version: '0.1.2', note: '修复附件和注释' }] },
    })
    await expect(controller.check()).resolves.toMatchObject({ status: 'available', latestVersion: '0.1.2', releaseNotes: '修复附件和注释' })
    await expect(controller.install()).resolves.toMatchObject({ status: 'error' })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('does not misreport a missing release manifest as the latest version', async () => {
    const updater = fakeUpdater()
    updater.checkForUpdates.mockRejectedValueOnce(Object.assign(new Error('HttpError: 404'), { statusCode: 404 }))
    const controller = new DesktopUpdaterController(updater, '0.1.0', 'https://updates.example.cn/client/')
    await expect(controller.check()).resolves.toMatchObject({
      status: 'error', latestVersion: null, message: '更新清单暂不可用，请稍后重试',
    })
  })

  it('fails closed on a non-HTTPS update feed', () => {
    expect(() => new DesktopUpdaterController(fakeUpdater(), '0.1.0', 'http://updates.example.cn'))
      .toThrow('必须使用无凭据 HTTPS')
  })
})
