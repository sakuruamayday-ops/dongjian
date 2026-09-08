import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import {
  armDesktopHardExit,
  DESKTOP_HOST_EXIT_TIMEOUT_MS,
  DESKTOP_RUNTIME_SHUTDOWN_TIMEOUT_MS,
  disposeDesktopRuntime,
  finishDesktopHostQuit,
  forceDesktopProcessExit,
} from '../src/runtime-shutdown.ts'

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('desktop runtime shutdown', () => {
  it('arms one absolute deadline around both runtime disposal and native exit', () => {
    let callback: (() => void) | undefined
    const forceExit = vi.fn()
    const schedule = vi.fn((scheduled: () => void) => { callback = scheduled })

    armDesktopHardExit(130, forceExit, schedule)

    expect(schedule).toHaveBeenCalledOnce()
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), DESKTOP_HOST_EXIT_TIMEOUT_MS)
    callback?.()
    expect(forceExit).toHaveBeenCalledOnce()
    expect(forceExit).toHaveBeenCalledWith(130)
  })

  it.runIf(process.platform === 'darwin')('terminates a blocked native shutdown without the JavaScript event loop', async () => {
    const source = new URL('../src/runtime-shutdown.ts', import.meta.url).href
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { armDesktopHardExit } from ${JSON.stringify(source)};
      armDesktopHardExit(0, () => process.exit(41));
      console.log('native-deadline-armed');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
      process.exit(42);
    `], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let errors = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { errors += String(chunk) })
    const fallback = setTimeout(() => { child.kill('SIGKILL') }, DESKTOP_HOST_EXIT_TIMEOUT_MS + 5_000)
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => { resolve({ code, signal }) })
      })
      expect(errors).toBe('')
      expect(output).toContain('native-deadline-armed')
      expect(result).toEqual({ code: null, signal: 'SIGALRM' })
    } finally {
      clearTimeout(fallback)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, DESKTOP_HOST_EXIT_TIMEOUT_MS + 8_000)

  it('resolves when disposal completes within the desktop deadline', async () => {
    await expect(disposeDesktopRuntime(async () => undefined)).resolves.toBeUndefined()
  })

  it('rejects at the bound while continuing to observe late disposal', async () => {
    vi.useFakeTimers()
    const disposal = deferred()
    const pending = disposeDesktopRuntime(() => disposal.promise)
    const timedOut = expect(pending).rejects.toThrow('desktop runtime shutdown exceeded 10000ms')

    await vi.advanceTimersByTimeAsync(DESKTOP_RUNTIME_SHUTDOWN_TIMEOUT_MS)
    await timedOut

    disposal.reject(new Error('late disposal failure'))
    await vi.runAllTimersAsync()
  })

  it('finishes a prevented host quit directly after runtime disposal succeeds', async () => {
    const hooks = {
      complete: vi.fn(),
      fail: vi.fn(),
      exit: vi.fn(),
      forceExit: vi.fn(),
    }

    await finishDesktopHostQuit(async () => undefined, hooks)

    expect(hooks.complete).toHaveBeenCalledOnce()
    expect(hooks.exit).toHaveBeenCalledOnce()
    expect(hooks.exit).toHaveBeenCalledWith(0)
    expect(hooks.fail).not.toHaveBeenCalled()
    expect(hooks.forceExit).not.toHaveBeenCalled()
  })

  it('uses the process-level fallback once when runtime disposal fails or times out', async () => {
    const failure = new Error('native teardown exceeded the desktop bound')
    const hooks = {
      complete: vi.fn(),
      fail: vi.fn(),
      exit: vi.fn(),
      forceExit: vi.fn(),
    }

    await finishDesktopHostQuit(async () => { throw failure }, hooks)

    expect(hooks.fail).toHaveBeenCalledOnce()
    expect(hooks.fail).toHaveBeenCalledWith(failure)
    expect(hooks.forceExit).toHaveBeenCalledOnce()
    expect(hooks.forceExit).toHaveBeenCalledWith(0)
    expect(hooks.complete).not.toHaveBeenCalled()
    expect(hooks.exit).not.toHaveBeenCalled()
  })

  it('hard-stops the native host with an operating-system signal after the graceful deadline', () => {
    const target = { pid: 42, kill: vi.fn(() => true), exit: vi.fn() }

    forceDesktopProcessExit(130, target)

    expect(target.kill).toHaveBeenCalledOnce()
    expect(target.kill).toHaveBeenCalledWith(42, 'SIGKILL')
    expect(target.exit).not.toHaveBeenCalled()
  })

  it('falls back to process exit when the operating system rejects self-signalling', () => {
    const target = {
      pid: 42,
      kill: vi.fn(() => { throw new Error('signal unavailable') }),
      exit: vi.fn(),
    }

    forceDesktopProcessExit(7, target)

    expect(target.kill).toHaveBeenCalledWith(42, 'SIGKILL')
    expect(target.exit).toHaveBeenCalledOnce()
    expect(target.exit).toHaveBeenCalledWith(7)
  })
})
