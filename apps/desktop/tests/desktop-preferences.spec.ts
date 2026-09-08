import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DesktopPreferencesStore, WindowsCloseRequestCoordinator } from '../src/desktop-preferences.ts'

describe('desktop preferences', () => {
  it('asks on first close, migrates the old silent default, and persists an explicit choice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-desktop-preferences-'))
    const filename = join(root, 'nested', 'desktop-preferences.json')
    const store = new DesktopPreferencesStore(filename)

    await expect(store.read()).resolves.toEqual({ schemaVersion: 2, windowsCloseBehavior: 'ask' })
    await store.writeWindowsCloseBehavior('tray')
    await writeFile(filename, '{"schemaVersion":1,"windowsCloseBehavior":"tray"}\n', 'utf8')
    await expect(store.read()).resolves.toEqual({ schemaVersion: 2, windowsCloseBehavior: 'ask' })
    await expect(store.writeWindowsCloseBehavior('quit')).resolves.toEqual({
      schemaVersion: 2,
      windowsCloseBehavior: 'quit',
    })
    await expect(new DesktopPreferencesStore(filename).read()).resolves.toEqual({
      schemaVersion: 2,
      windowsCloseBehavior: 'quit',
    })
    expect(await readFile(filename, 'utf8')).toBe('{"schemaVersion":2,"windowsCloseBehavior":"quit"}\n')
  })

  it('rejects renderer values outside the supported close behaviors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-desktop-preferences-invalid-'))
    const store = new DesktopPreferencesStore(join(root, 'desktop-preferences.json'))
    await expect(store.writeWindowsCloseBehavior('hide')).rejects.toThrow('关闭主窗口行为无效')
  })

  it('keeps the active request reserved until a delayed preference write settles', async () => {
    const coordinator = new WindowsCloseRequestCoordinator()
    let releaseWrite: (() => void) | undefined
    const delayedWrite = new Promise<void>((resolve) => { releaseWrite = resolve })
    const committed: Array<'tray' | 'quit' | null> = []

    expect(coordinator.start('request-a')).toBe(true)
    const response = coordinator.respond(
      'request-a',
      'tray',
      true,
      () => delayedWrite,
      (decision) => { committed.push(decision) },
    )
    expect(coordinator.start('request-b')).toBe(false)
    expect(committed).toEqual([])

    releaseWrite?.()
    await response
    expect(committed).toEqual(['tray'])
    expect(coordinator.start('request-b')).toBe(true)
  })

  it('releases an unanswered request after its renderer is gone', () => {
    const coordinator = new WindowsCloseRequestCoordinator()

    expect(coordinator.start('request-a')).toBe(true)
    coordinator.cancelPending()
    expect(coordinator.start('request-b')).toBe(true)
  })

  it('does not release a response while its preference write is settling', async () => {
    const coordinator = new WindowsCloseRequestCoordinator()
    let releaseWrite: (() => void) | undefined
    const delayedWrite = new Promise<void>((resolve) => { releaseWrite = resolve })

    expect(coordinator.start('request-a')).toBe(true)
    const response = coordinator.respond('request-a', 'tray', true, () => delayedWrite, () => undefined)
    coordinator.cancelPending()
    expect(coordinator.start('request-b')).toBe(false)

    releaseWrite?.()
    await response
    expect(coordinator.start('request-b')).toBe(true)
  })
})
