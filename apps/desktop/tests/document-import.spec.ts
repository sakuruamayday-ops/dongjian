import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DocumentImportDirectoryStore, importedDocumentPath, importSelectedDocuments, workspaceDocumentPath } from '../src/document-import.ts'

const unexpectedTrash = (path: string): Promise<void> =>
  Promise.reject(new Error(`unexpected Trash rollback for ${path}`))

async function fixture(): Promise<{ root: string; workspace: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), 'gongchuang-document-import-'))
  const workspace = join(root, '共创黄金样例制造有限公司')
  const source = join(root, '项目申报资料.txt')
  await mkdir(workspace)
  await writeFile(source, '经营收入 100 万元\n', 'utf8')
  return { root, workspace, source }
}

describe('desktop document import', () => {
  it('scopes native file actions to real documents inside the enterprise workspace', async () => {
    const { workspace, source } = await fixture()
    const path = join(workspace, '交付文件.docx')
    await writeFile(path, 'synthetic document')
    expect(await workspaceDocumentPath(workspace, '交付文件.docx')).toBe(await realpath(path))
    expect(await workspaceDocumentPath(workspace, path)).toBe(await realpath(path))
    await expect(workspaceDocumentPath(workspace, source)).rejects.toThrow('越出')
    await expect(workspaceDocumentPath(workspace, '.')).rejects.toThrow()
    await expect(workspaceDocumentPath(workspace, 'bad\0.docx')).rejects.toThrow('引用无效')
    await symlink(source, join(workspace, '外部文件.docx'))
    await expect(workspaceDocumentPath(workspace, '外部文件.docx')).rejects.toThrow('不可用')
  })

  it('copies selected files into a workspace-owned directory without returning the source path', async () => {
    const { workspace, source } = await fixture()
    const [receipt] = await importSelectedDocuments(workspace, [source], unexpectedTrash)
    expect(receipt).toEqual({
      name: '项目申报资料.txt',
      relativePath: '导入资料/项目申报资料.txt',
      bytes: Buffer.byteLength('经营收入 100 万元\n'),
    })
    expect(JSON.stringify(receipt)).not.toContain(source)
    expect(await readFile(join(workspace, receipt.relativePath), 'utf8')).toBe('经营收入 100 万元\n')
  })

  it('preserves an existing file and assigns a non-conflicting name', async () => {
    const { workspace, source } = await fixture()
    await mkdir(join(workspace, '导入资料'))
    await writeFile(join(workspace, '导入资料', '项目申报资料.txt'), '旧文件', 'utf8')
    const [receipt] = await importSelectedDocuments(workspace, [source], unexpectedTrash)
    expect(receipt?.name).toBe('项目申报资料 (2).txt')
    expect(await readFile(join(workspace, '导入资料', '项目申报资料.txt'), 'utf8')).toBe('旧文件')
  })

  it('publishes concurrent same-name imports without replacing either copy', async () => {
    const { root, workspace } = await fixture()
    const leftDirectory = join(root, 'left')
    const rightDirectory = join(root, 'right')
    await Promise.all([mkdir(leftDirectory), mkdir(rightDirectory)])
    const left = join(leftDirectory, '同名资料.txt')
    const right = join(rightDirectory, '同名资料.txt')
    await Promise.all([
      writeFile(left, 'left import', 'utf8'),
      writeFile(right, 'right import', 'utf8'),
    ])

    const [[leftReceipt], [rightReceipt]] = await Promise.all([
      importSelectedDocuments(workspace, [left], unexpectedTrash),
      importSelectedDocuments(workspace, [right], unexpectedTrash),
    ])

    expect(new Set([leftReceipt?.name, rightReceipt?.name])).toEqual(
      new Set(['同名资料.txt', '同名资料 (2).txt']),
    )
    const contents = await Promise.all([
      readFile(join(workspace, leftReceipt?.relativePath ?? ''), 'utf8'),
      readFile(join(workspace, rightReceipt?.relativePath ?? ''), 'utf8'),
    ])
    expect(new Set(contents)).toEqual(new Set(['left import', 'right import']))
  })

  it('falls back to exclusive copy when the workspace filesystem rejects hard links', async () => {
    const { workspace, source } = await fixture()
    const unsupported = Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' })

    const [receipt] = await importSelectedDocuments(workspace, [source], unexpectedTrash, {
      link: async () => { throw unsupported },
      copyFile,
    })

    expect(receipt?.name).toBe('项目申报资料.txt')
    expect(await readFile(join(workspace, receipt?.relativePath ?? ''), 'utf8')).toBe('经营收入 100 万元\n')
  })

  it('retries an exclusive-copy collision after hard-link fallback', async () => {
    const { workspace, source } = await fixture()
    const unsupported = Object.assign(new Error('hard links unsupported'), { code: 'EPERM' })
    let copies = 0

    const [receipt] = await importSelectedDocuments(workspace, [source], unexpectedTrash, {
      link: async () => { throw unsupported },
      copyFile: async (from, to, mode) => {
        copies += 1
        if (copies === 1) {
          const collision = Object.assign(new Error('already exists'), { code: 'EEXIST' })
          throw collision
        }
        await copyFile(from, to, mode)
      },
    })

    expect(receipt?.name).toBe('项目申报资料 (2).txt')
    expect(copies).toBe(2)
    expect(await readFile(join(workspace, receipt?.relativePath ?? ''), 'utf8')).toBe('经营收入 100 万元\n')
  })

  it('imports a user-selected PPTX into the current enterprise workspace', async () => {
    const { root, workspace } = await fixture()
    const presentation = join(root, '申报汇报.PPTX')
    await writeFile(presentation, 'pptx-fixture')
    const [receipt] = await importSelectedDocuments(workspace, [presentation], unexpectedTrash)
    expect(receipt).toEqual({
      name: '申报汇报.PPTX',
      relativePath: '导入资料/申报汇报.PPTX',
      bytes: Buffer.byteLength('pptx-fixture'),
    })
    expect(await readFile(join(workspace, receipt.relativePath), 'utf8')).toBe('pptx-fixture')
  })

  it('accepts arbitrary regular files while rejecting broad roots and symbolic-link sources', async () => {
    const { root, workspace, source } = await fixture()
    const arbitrary = join(root, 'evidence.custom-format')
    await writeFile(arbitrary, 'x')
    const [receipt] = await importSelectedDocuments(workspace, [arbitrary], unexpectedTrash)
    expect(receipt?.relativePath).toBe('导入资料/evidence.custom-format')

    const broad = join(root, 'Documents')
    await mkdir(broad)
    await expect(importSelectedDocuments(broad, [source], unexpectedTrash)).rejects.toThrow('具体企业或项目')

    const linked = join(root, 'linked.txt')
    await symlink(source, linked)
    await expect(importSelectedDocuments(workspace, [linked], unexpectedTrash)).rejects.toThrow('不支持链接')
  })

  it('keeps the extension when a long arbitrary file name is shortened', async () => {
    const { root, workspace } = await fixture()
    const source = join(root, `${'a'.repeat(170)}.custom-format`)
    await writeFile(source, 'x')

    const [receipt] = await importSelectedDocuments(workspace, [source], unexpectedTrash)

    expect(receipt?.name).toHaveLength(160)
    expect(receipt?.name).toMatch(/\.custom-format$/u)
  })

  it('persists and restores the most recently used real directory', async () => {
    const { root, source } = await fixture()
    const store = new DocumentImportDirectoryStore(join(root, 'state', 'last-directory.json'))
    expect(await store.read()).toBeUndefined()
    await store.remember(source)
    expect(await store.read()).toBe(await realpath(root))
  })

  it('keeps colliding long names within the persisted draft name limit', async () => {
    const { root, workspace } = await fixture()
    const source = join(root, `${'a'.repeat(170)}.docx`)
    await writeFile(source, 'long-name-document')
    const receipts = await importSelectedDocuments(workspace, [source, source, source], unexpectedTrash)
    expect(new Set(receipts.map(receipt => receipt.name)).size).toBe(3)
    for (const receipt of receipts) {
      expect(receipt.name.length).toBeLessThanOrEqual(160)
      expect(receipt.name).toMatch(/\.docx$/u)
      expect(await importedDocumentPath(workspace, receipt.relativePath)).toBe(await realpath(join(workspace, receipt.relativePath)))
    }
  })

  it('opens a valid dot-prefixed file without confusing it with parent traversal', async () => {
    const { root, workspace } = await fixture()
    const source = join(root, '..evidence.docx')
    await writeFile(source, 'valid-dot-prefix')
    const [receipt] = await importSelectedDocuments(workspace, [source], unexpectedTrash)
    expect(await importedDocumentPath(workspace, receipt.relativePath)).toBe(await realpath(join(workspace, receipt.relativePath)))
    await expect(importedDocumentPath(workspace, '导入资料/../..evidence.docx')).rejects.toThrow('越出受控目录')
  })

  it('opens only regular files inside the controlled import directory', async () => {
    const { root, workspace, source } = await fixture()
    const [receipt] = await importSelectedDocuments(workspace, [source], unexpectedTrash)
    expect(await importedDocumentPath(workspace, receipt.relativePath)).toBe(
      await realpath(join(workspace, receipt.relativePath)),
    )
    await expect(importedDocumentPath(workspace, '../项目申报资料.txt')).rejects.toThrow('引用无效')
    await expect(importedDocumentPath(workspace, '导入资料/../外部.txt')).rejects.toThrow('越出受控目录')

    const external = join(root, 'external.txt')
    const linked = join(workspace, '导入资料', 'linked.txt')
    await writeFile(external, 'external')
    await symlink(external, linked)
    await expect(importedDocumentPath(workspace, '导入资料/linked.txt')).rejects.toThrow('不可用')
  })

  it('moves a copied batch prefix to Trash when a later source fails, then imports cleanly on retry', async () => {
    const { root, workspace, source } = await fixture()
    const linked = join(root, 'linked-second.txt')
    const trash = join(root, '.Trash')
    await symlink(source, linked)
    await mkdir(trash)
    const trashed: string[] = []
    const trashItem = async (path: string): Promise<void> => {
      const destination = join(trash, `${String(trashed.length + 1)}-${basename(path)}`)
      await rename(path, destination)
      trashed.push(destination)
    }

    await expect(importSelectedDocuments(workspace, [source, linked], trashItem)).rejects.toThrow('不支持链接')
    expect(await readFile(source, 'utf8')).toBe('经营收入 100 万元\n')
    expect(trashed).toHaveLength(1)
    expect(await readFile(trashed[0], 'utf8')).toBe('经营收入 100 万元\n')

    const [receipt] = await importSelectedDocuments(workspace, [source], unexpectedTrash)
    expect(receipt?.name).toBe('项目申报资料.txt')
    expect(await readFile(join(workspace, receipt.relativePath), 'utf8')).toBe('经营收入 100 万元\n')
  })

  it('reports both the import and recoverable-cleanup failure without touching the source', async () => {
    const { root, workspace, source } = await fixture()
    const linked = join(root, 'linked-second.txt')
    await symlink(source, linked)

    const failure = importSelectedDocuments(workspace, [source, linked], () => Promise.reject(new Error('Trash unavailable')))
    await expect(failure).rejects.toBeInstanceOf(AggregateError)
    await expect(failure).rejects.toThrow('无法移入系统废纸篓')
    expect(await readFile(source, 'utf8')).toBe('经营收入 100 万元\n')
    expect(await readFile(join(workspace, '导入资料', '项目申报资料.txt'), 'utf8'))
      .toBe('经营收入 100 万元\n')
  })
})
