/** Bounded runtime disposal for the Electron host lifecycle. */

import { createRequire } from 'node:module'

/** Maximum time the desktop waits for durable runtime disposal. */
export const DESKTOP_RUNTIME_SHUTDOWN_TIMEOUT_MS = 10_000

/** Absolute deadline covering runtime disposal and Electron's native exit. */
export const DESKTOP_HOST_EXIT_TIMEOUT_MS = 12_000

/** Host-exit operations kept injectable so success and deadline paths are independently testable. */
export interface DesktopHostQuitHooks {
  /** Record that the embedded runtime reached quiescence. */
  complete(): void
  /** Record the bounded shutdown failure before the host is forced down. */
  fail(error: unknown): void
  /** Finish a successful Electron quit transaction. */
  exit(code: number): void
  /** Terminate a host whose native/runtime cleanup did not settle by the deadline. */
  forceExit(code: number): void
}

/** Minimum process surface needed by the desktop's last-resort self-termination. */
export interface DesktopHardExitProcess {
  readonly pid: number
  kill(pid: number, signal: 'SIGKILL'): boolean
  exit(code: number): void
}

/** Injectable timer seam for the absolute desktop exit deadline. */
export type DesktopHardExitScheduler = (callback: () => void, delayMs: number) => void

function scheduleDesktopHardExit(callback: () => void, delayMs: number): void {
  if (process.platform === 'darwin') {
    // app.exit() 等待原生钥匙串线程时，Node 定时器已无法运行。
    // 系统闹钟只在退出开始后启动，不依赖已停止的 JavaScript 事件循环。
    const koffi = createRequire(import.meta.url)('koffi') as {
      load(path: string): { func(declaration: string): (seconds: number) => number }
    }
    const alarm = koffi.load('/usr/lib/libSystem.B.dylib').func('unsigned int alarm(unsigned int seconds)')
    alarm(Math.ceil(delayMs / 1_000))
  }
  setTimeout(callback, delayMs)
}

/**
 * Arm one process-level deadline before any graceful desktop shutdown work starts.
 *
 * Runtime disposal has its own shorter deadline, but `app.exit()` can still remain
 * alive behind a native Keychain authorization dialog after Node stops dispatching
 * timers. macOS also arms a kernel alarm so the deadline covers native teardown.
 */
export function armDesktopHardExit(
  code: number,
  forceExit: (code: number) => void,
  schedule: DesktopHardExitScheduler = scheduleDesktopHardExit,
): void {
  schedule(() => { forceExit(code) }, DESKTOP_HOST_EXIT_TIMEOUT_MS)
}

/**
 * Terminate an Electron host after its bounded graceful shutdown has already failed.
 *
 * Electron can translate `process.exit()` into native application teardown. Under
 * Rosetta that teardown was observed leaving only the main process alive after every
 * helper had exited. SIGKILL is intentionally restricted to this post-deadline path;
 * `process.exit()` remains a fallback for platforms that cannot signal themselves.
 */
export function forceDesktopProcessExit(
  code: number,
  target: DesktopHardExitProcess = process,
): void {
  try {
    target.kill(target.pid, 'SIGKILL')
  } catch {
    target.exit(code)
  }
}

/**
 * Dispose the embedded runtime without letting its CLI process controller exit Electron.
 *
 * Electron owns native process exit. Keeping this deadline in the host prevents a
 * retained session from leaving quit or update handoff stuck after the web server
 * has already stopped, while the still-observed disposal promise contains any late
 * rejection instead of creating an unhandled rejection.
 */
export async function disposeDesktopRuntime(
  dispose: () => Promise<void>,
  timeoutMs = DESKTOP_RUNTIME_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const disposal = Promise.resolve().then(dispose)
  const deadline = new Promise<never>((_resolvePromise, rejectPromise) => {
    timer = setTimeout(() => {
      rejectPromise(new Error(`desktop runtime shutdown exceeded ${String(timeoutMs)}ms`))
    }, timeoutMs)
  })
  try {
    await Promise.race([disposal, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Complete a prevented Electron quit after bounded runtime disposal.
 *
 * A second `app.quit()` cannot recover a quit transaction that is already
 * waiting on native teardown. The normal path therefore performs the final
 * Electron exit directly; only a rejected or timed-out disposal uses the
 * process-level fallback. Node's synchronous `exit` listeners still run in
 * that fallback, so the subprocess runtime can terminate any tree it owns.
 */
export async function finishDesktopHostQuit(
  shutdown: () => Promise<void>,
  hooks: DesktopHostQuitHooks,
  code = 0,
): Promise<void> {
  try {
    await shutdown()
    hooks.complete()
    hooks.exit(code)
  } catch (error) {
    hooks.fail(error)
    hooks.forceExit(code)
  }
}
