import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ComposerDraftStore, composerDraftValue } from '../src/composer-drafts.ts'

const draft = {
  text: '请继续核对',
  documents: [{
    name: '测试.xlsx', relativePath: '导入资料/测试.xlsx', bytes: 321,
  }],
  annotations: [{
    index: 1, text: '原文', comment: '这里要修改', source: { nodeKey: 'message-1', kind: 'assistant' as const },
  }],
  nextAnnotationIndex: 2,
}

describe('native composer draft storage', () => {
  it('retains pasted image bytes through a fresh store and removes only the cleared image draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-composer-images-'))
    const filename = join(root, 'drafts.v1.json')
    const images = [{ name: 'image.png', mediaType: 'image/png', data: 'aGVsbG8=' }]
    const store = new ComposerDraftStore(filename)
    await store.write('image-session', { text: '', documents: [], annotations: [], nextAnnotationIndex: 1, images })
    await expect(new ComposerDraftStore(filename).read('image-session')).resolves.toMatchObject({ images })
    await store.write('text-session', draft)
    await store.write('image-session', { text: '', documents: [], annotations: [], nextAnnotationIndex: 1, images: [] })
    await expect(new ComposerDraftStore(filename).read('image-session')).resolves.toBeNull()
    await expect(new ComposerDraftStore(filename).read('text-session')).resolves.toMatchObject(draft)
  })

  it('restores one mixed draft through a fresh store instance and writes it privately', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-composer-drafts-'))
    const filename = join(root, 'nested', 'drafts.v1.json')
    const store = new ComposerDraftStore(filename)
    const saving = store.write('session-1', draft)
    await store.flush()
    await saving

    await expect(new ComposerDraftStore(filename).read('session-1')).resolves.toEqual(draft)
    expect((await stat(filename)).mode & 0o777).toBe(0o600)
  })

  it('removes empty and explicitly cleared drafts without touching other sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-composer-clear-'))
    const filename = join(root, 'drafts.v1.json')
    const store = new ComposerDraftStore(filename)
    await store.write('session-1', draft)
    await store.write('session-2', { ...draft, text: '保留' })
    await store.write('session-1', {
      text: '', documents: [], annotations: [], nextAnnotationIndex: 1,
    })

    await expect(new ComposerDraftStore(filename).read('session-1')).resolves.toBeNull()
    await expect(new ComposerDraftStore(filename).read('session-2')).resolves.toMatchObject({ text: '保留' })
    await store.clear('session-2')
    await expect(new ComposerDraftStore(filename).read('session-2')).resolves.toBeNull()
  })

  it('rejects traversal, malformed annotation order, and oversized renderer values', () => {
    expect(() => composerDraftValue({
      ...draft, documents: [{ ...draft.documents[0], relativePath: '导入资料/../测试.xlsx' }],
    })).toThrow('待发送附件记录无效')
    expect(() => composerDraftValue({
      ...draft, annotations: [draft.annotations[0], draft.annotations[0]],
    })).toThrow('待发送注释记录无效')
    expect(() => composerDraftValue({ ...draft, text: 'x'.repeat(500_001) }))
      .toThrow('待发送文字超出可保存范围')
    for (const images of [
      [{ mediaType: 'image/svg+xml', data: 'aGVsbG8=' }],
      [{ mediaType: 'image/png', data: 'not-base64' }],
      [{ mediaType: 'image/png', data: 'Zg=' }],
    ]) expect(() => composerDraftValue({ ...draft, images })).toThrow('待发送图片记录无效')
  })

  it('salvages valid sessions while ignoring a corrupt sibling entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-composer-salvage-'))
    const filename = join(root, 'drafts.v1.json')
    await writeFile(filename, JSON.stringify({
      schemaVersion: 1,
      sessions: { valid: draft, invalid: { ...draft, nextAnnotationIndex: 1 } },
    }), 'utf8')
    const store = new ComposerDraftStore(filename)

    await expect(store.read('valid')).resolves.toEqual(draft)
    await expect(store.read('invalid')).resolves.toBeNull()
    const persisted: unknown = JSON.parse(await readFile(filename, 'utf8'))
    expect(persisted).toMatchObject({ sessions: { valid: { text: draft.text } } })
  })

  it('rejects aggregate image overflow without replacing a previously saved draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-composer-image-size-'))
    const filename = join(root, 'drafts.v1.json')
    const store = new ComposerDraftStore(filename)
    await store.write('valid', draft)
    const images = [0, 1].map(() => ({ mediaType: 'image/png', data: Buffer.alloc(1_600_000).toString('base64') }))
    expect(() => store.write('valid', { ...draft, images })).toThrow('待发送草稿超出可保存大小')
    await expect(new ComposerDraftStore(filename).read('valid')).resolves.toEqual(draft)
  })
})
