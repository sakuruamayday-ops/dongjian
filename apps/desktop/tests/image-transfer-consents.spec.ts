import { mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ImageTransferConsentStore } from '../src/image-transfer-consents.ts'

const roots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gongchuang-image-consent-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  if (process.platform !== 'darwin') return
  for (const root of roots.splice(0)) {
    const trash = await mkdtemp(join(homedir(), '.Trash', 'GC-QA-image-consent-'))
    await rename(root, join(trash, 'fixture'))
  }
})

describe('native image-transfer consent storage', () => {
  it('remembers only approved provider IDs in a private file across fresh stores', async () => {
    const filename = join(await fixture(), 'privacy', 'consents.json')
    const store = new ImageTransferConsentStore(filename)
    await expect(store.read()).resolves.toEqual([])
    await store.remember('opencode-go')
    await expect(new ImageTransferConsentStore(filename).read()).resolves.toEqual(['opencode-go'])
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({ schemaVersion: 1, providers: ['opencode-go'] })
    if (process.platform !== 'win32') expect((await stat(filename)).mode & 0o777).toBe(0o600)
  })

  it('serializes simultaneous approvals without losing or duplicating providers', async () => {
    const store = new ImageTransferConsentStore(join(await fixture(), 'consents.json'))
    const first = store.remember('opencode-go')
    const second = store.remember('deepseek')
    const duplicate = store.remember('opencode-go')
    await expect(store.read()).resolves.toEqual(['deepseek', 'opencode-go'])
    await first
    await second
    await duplicate
  })

  it.each(['null', '{', '{"schemaVersion":2,"providers":[]}', '{"schemaVersion":1,"providers":["unknown"]}'])(
    'rejects malformed persisted consent without overwriting it: %s', async (contents) => {
      const filename = join(await fixture(), 'consents.json')
      await writeFile(filename, contents)
      const store = new ImageTransferConsentStore(filename)
      await expect(store.read()).rejects.toThrow()
      await expect(store.remember('deepseek')).rejects.toThrow()
      expect(await readFile(filename, 'utf8')).toBe(contents)
    },
  )

  it('rejects invalid IPC input without changing the previous approval', async () => {
    const filename = join(await fixture(), 'consents.json')
    const store = new ImageTransferConsentStore(filename)
    await store.remember('deepseek')
    for (const value of [undefined, '', '../deepseek', { provider: 'deepseek' }]) {
      expect(() => store.remember(value)).toThrow('Unknown image-transfer provider')
    }
    await expect(store.read()).resolves.toEqual(['deepseek'])
  })

  it('reports a storage failure and accepts an explicit retry after recovery', async () => {
    const root = await fixture()
    const parent = join(root, 'privacy')
    await writeFile(parent, 'occupied path')
    const store = new ImageTransferConsentStore(join(parent, 'consents.json'))
    await expect(store.remember('deepseek')).rejects.toThrow()
    await rename(parent, join(root, 'saved-blocker'))
    await store.remember('opencode-go')
    await expect(store.read()).resolves.toEqual(['opencode-go'])
  })
})
