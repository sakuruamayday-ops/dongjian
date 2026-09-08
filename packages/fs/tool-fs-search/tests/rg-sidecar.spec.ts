import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { dependency, existsSync } = vi.hoisted(() => ({
  dependency: { rgPath: '/node_modules/@vscode/ripgrep/bin/rg' },
  existsSync: vi.fn(),
}))
const originalPlatform = process.platform
const originalExecPath = process.execPath
const originalElectron = Object.getOwnPropertyDescriptor(process.versions, 'electron')

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync }
})

vi.mock('@vscode/ripgrep', () => dependency)

beforeEach(() => {
  vi.resetModules()
  existsSync.mockReset()
  dependency.rgPath = '/node_modules/@vscode/ripgrep/bin/rg'
  Reflect.deleteProperty(process.versions, 'electron')
  Reflect.deleteProperty(process, 'pkg')
  Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: originalPlatform })
  process.execPath = originalExecPath
})

afterEach(() => {
  if (originalElectron === undefined) Reflect.deleteProperty(process.versions, 'electron')
  else Object.defineProperty(process.versions, 'electron', originalElectron)
  Reflect.deleteProperty(process, 'pkg')
  Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: originalPlatform })
  process.execPath = originalExecPath
})

describe('ripgrep resolution', () => {
  it('uses the native sidecar beside the current executable', async () => {
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: 'linux' })
    process.execPath = '/runtime/dsh'
    existsSync.mockReturnValue(true)
    const sidecar = '/runtime/dsh-rg'
    const { resolveRgPath } = await import('@deepseek-ai/dsh-tool-fs-search')

    await expect(resolveRgPath()).resolves.toBe(sidecar)
    expect(existsSync).toHaveBeenCalledWith(sidecar)
  })

  it('uses a conventional executable name for the Windows ripgrep sidecar', async () => {
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: 'win32' })
    process.execPath = 'C:\\runtime\\deepseek-harness-sdk-runtime-win-x64.exe'
    existsSync.mockReturnValue(true)
    const sidecar = 'C:\\runtime\\deepseek-harness-sdk-runtime-win-x64-rg.exe'
    const { resolveRgPath } = await import('@deepseek-ai/dsh-tool-fs-search')

    await expect(resolveRgPath()).resolves.toBe(sidecar)
    expect(existsSync).toHaveBeenCalledWith(sidecar)
  })

  it('uses the dependency binary in an ordinary Node process', async () => {
    existsSync.mockReturnValue(true)
    const { resolveRgPath } = await import('@deepseek-ai/dsh-tool-fs-search')

    await expect(resolveRgPath()).resolves.toBe(dependency.rgPath)
    expect(existsSync).not.toHaveBeenCalled()
  })

  it('uses the dependency binary when a packaged runtime has no sidecar', async () => {
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    existsSync.mockReturnValue(false)
    const { resolveRgPath } = await import('@deepseek-ai/dsh-tool-fs-search')

    await expect(resolveRgPath()).resolves.toBe(dependency.rgPath)
    const executable = parse(process.execPath)
    const sidecar = process.platform === 'win32'
      ? join(executable.dir, `${executable.name}-rg.exe`)
      : `${process.execPath}-rg`
    expect(existsSync).toHaveBeenCalledWith(sidecar)
  })

  it.each([
    ['/Applications/Example.app/Contents/Resources/app.asar/node_modules/rg/bin/rg', '/Applications/Example.app/Contents/Resources/app.asar.unpacked/node_modules/rg/bin/rg'],
    [String.raw`C:\Program Files\Example\resources\app.asar\node_modules\rg\bin\rg.exe`, String.raw`C:\Program Files\Example\resources\app.asar.unpacked\node_modules\rg\bin\rg.exe`],
    ['/Applications/Example.app/Contents/Resources/app.asar.unpacked/node_modules/rg/bin/rg', '/Applications/Example.app/Contents/Resources/app.asar.unpacked/node_modules/rg/bin/rg'],
    ['/node_modules/@vscode/ripgrep/bin/rg', '/node_modules/@vscode/ripgrep/bin/rg'],
  ])('resolves an Electron helper to an OS-spawnable path: %s', async (input, expected) => {
    Reflect.defineProperty(process.versions, 'electron', { configurable: true, value: '40.0.0' })
    dependency.rgPath = input
    const { resolveRgPath } = await import('@deepseek-ai/dsh-tool-fs-search')

    await expect(resolveRgPath()).resolves.toBe(expected)
  })

  it('does not rewrite a real directory with an ASAR suffix outside Electron', async () => {
    dependency.rgPath = '/real/project.asar/node_modules/rg/bin/rg'
    const { resolveRgPath } = await import('@deepseek-ai/dsh-tool-fs-search')

    await expect(resolveRgPath()).resolves.toBe(dependency.rgPath)
  })
})
