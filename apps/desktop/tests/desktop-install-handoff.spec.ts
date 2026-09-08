import { describe, expect, it, vi } from 'vitest'
import { runDesktopInstallHandoff } from '../src/desktop-install-handoff.ts'

const errorSnapshot = Object.freeze({
  status: 'error' as const,
  currentVersion: '0.3.3',
  latestVersion: '0.4.0',
  message: '安装助手未启动',
})

describe('desktop install handoff recovery', () => {
  it('relaunches the current app when a controller reports failure after runtime shutdown', async () => {
    const shutdown = vi.fn(async () => undefined)
    const relaunch = vi.fn()

    await expect(runDesktopInstallHandoff(async (beforeInstall) => {
      await beforeInstall()
      return errorSnapshot
    }, shutdown, relaunch)).resolves.toBe(errorSnapshot)

    expect(shutdown).toHaveBeenCalledOnce()
    expect(relaunch).toHaveBeenCalledOnce()
  })

  it('relaunches before propagating a native handoff rejection', async () => {
    const events: string[] = []
    const failure = new Error('quitAndInstall failed')

    await expect(runDesktopInstallHandoff(async (beforeInstall) => {
      await beforeInstall()
      throw failure
    }, async () => { events.push('shutdown') }, () => { events.push('relaunch') })).rejects.toBe(failure)

    expect(events).toEqual(['shutdown', 'relaunch'])
  })

  it('relaunches after a shutdown attempt fails but not after installation starts', async () => {
    const relaunch = vi.fn()
    const shutdownFailure = new Error('runtime still stopping')
    await expect(runDesktopInstallHandoff(
      async (beforeInstall) => { await beforeInstall(); return errorSnapshot },
      async () => { throw shutdownFailure },
      relaunch,
    )).rejects.toBe(shutdownFailure)
    expect(relaunch).toHaveBeenCalledOnce()

    const success = Object.freeze({ ...errorSnapshot, status: 'downloaded' as const })
    await expect(runDesktopInstallHandoff(
      async (beforeInstall) => { await beforeInstall(); return success },
      async () => undefined,
      relaunch,
    )).resolves.toBe(success)
    expect(relaunch).toHaveBeenCalledOnce()
  })
})
