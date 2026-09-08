import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  closeWindowToBackground,
  restoreWindowFromBackground,
  type DesktopBackgroundWindow,
} from '../src/window-background-lifecycle.ts'

const mainPath = resolve(import.meta.dirname, '../src/main.ts')
const main = readFileSync(mainPath, 'utf8')
const anySource = String.raw`[\s\S]*?`

interface WindowCalls {
  focus: number
  hide: number
  restore: number
  show: number
}

function backgroundWindow(minimized: boolean): { calls: WindowCalls; window: DesktopBackgroundWindow } {
  const calls: WindowCalls = { focus: 0, hide: 0, restore: 0, show: 0 }
  return {
    calls,
    window: {
      focus: () => { calls.focus += 1 },
      hide: () => { calls.hide += 1 },
      isMinimized: () => minimized,
      restore: () => { calls.restore += 1 },
      show: () => { calls.show += 1 },
    },
  }
}

function orderedPattern(parts: string[]): RegExp {
  return new RegExp(parts.join(anySource), 'u')
}

describe('desktop window lifecycle contract', () => {
  test('macOS content extends into the native title bar without covering traffic lights', () => {
    expect(main).toContain("process.platform === 'darwin'")
    expect(main).toContain("titleBarStyle: 'hiddenInset' as const")
    expect(main).toContain('trafficLightPosition: { x: 16, y: 16 }')
  })

  test('Windows title-bar close asks first, then honors saved quit or tray behavior', () => {
    expect(main).toMatch(
      orderedPattern([
        String.raw`window\.on\('close', \(event\) => \{`,
        String.raw`closeWindowToBackground\(event, window, quitting\)`,
        String.raw`\}\)`,
      ]),
    )
    const closeHandler = main.match(/window\.on\('close',[\s\S]*?\n  \}\)/u)?.[0]
    expect(closeHandler).toBeDefined()
    expect(closeHandler).toContain("process.platform === 'win32'")
    expect(closeHandler).toContain("windowsCloseBehavior === 'ask'")
    expect(closeHandler).toContain('requestWindowsCloseBehavior(window)')
    expect(closeHandler).toContain("windowsCloseBehavior === 'quit'")
    expect(closeHandler).toContain('app.quit()')
    expect(main).toContain('window.webContents.send(DESKTOP_CLOSE_REQUEST_CHANNEL, requestId)')
    expect(main).toContain("window.webContents.on('did-start-loading', () => { windowsCloseRequests.cancelPending() })")
    expect(main).toContain("window.webContents.on('render-process-gone', () => { windowsCloseRequests.cancelPending() })")
    expect(main).toContain('ipcMain.handle(DESKTOP_CLOSE_RESPONSE_CHANNEL')
    expect(main).toMatch(
      /windowsCloseRequests\.respond\([\s\S]*?writeWindowsCloseBehavior\(selected\)/u,
    )
  })

  test('the platform background surface restores a hidden window and offers the only explicit exit path', () => {
    expect(main).toMatch(
      orderedPattern([
        String.raw`label: '打开窗口'`,
        String.raw`restoreWindowFromBackground\(mainWindow\)`,
      ]),
    )
    expect(main).toMatch(
      orderedPattern([
        String.raw`appTray\.on\('click', \(\) => \{`,
        String.raw`restoreWindowFromBackground\(mainWindow\)`,
      ]),
    )
    expect(main).toMatch(
      orderedPattern([
        String.raw`label: '退出应用'`,
        String.raw`app\.quit\(\)`,
      ]),
    )
  })

  test('explicit quit marks the app as quitting before shutting down the runtime', () => {
    expect(main).toContain('processSignalHandlers: false')
    expect(main).not.toContain('profileRuntime.shutdown.shutdown(0)')
    expect(main).toMatch(
      orderedPattern([
        String.raw`app\.on\('before-quit', \(event\) => \{`,
        String.raw`if \(quitting\) return`,
        String.raw`event\.preventDefault\(\)`,
        String.raw`beginDesktopHostShutdown\(0\)`,
      ]),
    )
    expect(main).not.toContain("app.on('window-all-closed'")
  })

  test('runtime shutdown exits directly and has one bounded process fallback', () => {
    expect(main).toMatch(/finishDesktopHostQuit\(disposeProfileRuntime,[\s\S]*?app\.exit\(exitCode\)/u)
    expect(main).toContain('forceDesktopProcessExit(exitCode)')
    expect(main).toMatch(
      /desktopHostShutdownStarted = true[\s\S]*?armDesktopHardExit\(code,[\s\S]*?finishDesktopHostQuit\(disposeProfileRuntime/u,
    )
    const beforeQuit = main.match(/app\.on\('before-quit',[\s\S]*?\n\}\)/u)?.[0]
    expect(beforeQuit).toBeDefined()
    expect(beforeQuit).not.toContain('.finally(')
    expect(beforeQuit).not.toContain('app.quit()')
    expect(main).toContain('absolute deadline')
  })

  test('operating-system signals share the bounded desktop host shutdown owner', () => {
    expect(main).toMatch(
      /function beginDesktopHostShutdown\(code: number\): void \{[\s\S]*?finishDesktopHostQuit\(disposeProfileRuntime/u,
    )
    expect(main).toContain("process.on('SIGTERM', () => { beginDesktopHostShutdown(0) })")
    expect(main).toContain("process.on('SIGINT', () => { beginDesktopHostShutdown(130) })")
  })

  test.each([
    { platform: 'darwin', surface: 'menu bar', minimized: false },
    { platform: 'win32', surface: 'system tray', minimized: true },
  ])('$platform title-bar close hides to the $surface and restores through the same lifecycle', ({ minimized }) => {
    const { calls, window } = backgroundWindow(minimized)
    let prevented = 0

    closeWindowToBackground({ preventDefault: () => { prevented += 1 } }, window, false)
    expect(prevented).toBe(1)
    expect(calls).toEqual({ focus: 0, hide: 1, restore: 0, show: 0 })

    restoreWindowFromBackground(window)
    expect(calls).toEqual({
      focus: 1,
      hide: 1,
      restore: minimized ? 1 : 0,
      show: 1,
    })
  })

  test.each(['darwin', 'win32'])('%s explicit quit bypasses background hiding', () => {
    const { calls, window } = backgroundWindow(false)
    let prevented = 0

    closeWindowToBackground({ preventDefault: () => { prevented += 1 } }, window, true)

    expect(prevented).toBe(0)
    expect(calls).toEqual({ focus: 0, hide: 0, restore: 0, show: 0 })
  })
})
