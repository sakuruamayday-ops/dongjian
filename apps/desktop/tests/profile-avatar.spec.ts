import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DesktopAvatarStore } from '../src/profile-avatar.ts'

const AVATAR = `data:image/webp;base64,${Buffer.from('cropped-avatar').toString('base64')}`

async function testStore(): Promise<{ filename: string; store: DesktopAvatarStore }> {
  const root = await mkdtemp(join(tmpdir(), 'gongchuang-avatar-'))
  const filename = join(root, 'profile', 'avatar.json')
  return { filename, store: new DesktopAvatarStore(filename) }
}

describe('desktop profile avatar store', () => {
  it('atomically persists and reloads a bounded device-local avatar', async () => {
    const { filename, store } = await testStore()
    await expect(store.write(AVATAR)).resolves.toBe(AVATAR)
    expect(new DesktopAvatarStore(filename).read()).toBe(AVATAR)
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({ schemaVersion: 1, avatarDataUrl: AVATAR })
    if (process.platform !== 'win32') expect((await stat(filename)).mode & 0o777).toBe(0o600)
  })

  it('persists restore-default as an explicit null value', async () => {
    const { filename, store } = await testStore()
    await store.write(AVATAR)
    await store.write(null)
    expect(new DesktopAvatarStore(filename).read()).toBeNull()
  })

  it('fails closed for malformed or oversized renderer data', async () => {
    const { store } = await testStore()
    await expect(store.write('data:text/html;base64,SGVsbG8=')).rejects.toThrow('头像数据无效')
    const oversized = `data:image/webp;base64,${Buffer.alloc(512 * 1024 + 1).toString('base64')}`
    await expect(store.write(oversized)).rejects.toThrow('头像数据无效')
  })
})
