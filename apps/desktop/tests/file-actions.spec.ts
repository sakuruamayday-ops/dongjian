import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  showSaveDialog: vi.fn(), showOpenDialog: vi.fn(), showItemInFolder: vi.fn(),
  getFileIcon: vi.fn(async () => ({ toDataURL: () => 'data:image/png;base64,aGVsbG8=' })),
  fileApplications: vi.fn(async () => [{ id: '/Applications/WPS.app', name: 'WPS Office', isDefault: true }]),
  execFile: vi.fn((...args: unknown[]) => { (args.at(-1) as (error: null, stdout: string, stderr: string) => void)(null, '', '') }),
}))
vi.mock('electron', () => ({
  app: { getFileIcon: mocks.getFileIcon },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => { mocks.handlers.set(channel, handler) } },
  dialog: { showSaveDialog: mocks.showSaveDialog, showOpenDialog: mocks.showOpenDialog },
  shell: { showItemInFolder: mocks.showItemInFolder },
}))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }))
vi.mock('../src/file-applications.ts', () => ({ fileApplications: mocks.fileApplications }))
import { configureFileActions } from '../src/file-actions.ts'

beforeEach(() => { vi.clearAllMocks(); mocks.handlers.clear() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gc-file-actions-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const path = join(workspace, '测试文件.docx')
  await writeFile(path, 'synthetic file')
  const sender = {}
  configureFileActions(() => ({ webContents: sender } as never))
  const invoke = (action: string, applicationId: string | null = null) =>
    mocks.handlers.get('gongchuang:documents:action')!({ sender }, workspace, path, action, applicationId)
  return { root, workspace, path, sender, invoke }
}

describe('native file actions', () => {
  it('rejects an unrelated renderer before revealing or reading a file', async () => {
    const { workspace, path } = await fixture()
    await expect(mocks.handlers.get('gongchuang:documents:action')!({ sender: {} }, workspace, path, 'reveal', null)).rejects.toThrow('来源无效')
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
  })

  it('copies to a new destination, leaves existing files intact and treats cancellation as a no-op', async () => {
    const { root, path, invoke } = await fixture()
    const copy = join(root, '副本.docx')
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    await invoke('save-copy')
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: copy })
    await invoke('save-copy')
    expect(await readFile(copy, 'utf8')).toBe('synthetic file')
    await writeFile(copy, 'preserve this document')
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: copy })
    await expect(invoke('save-copy')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(copy, 'utf8')).toBe('preserve this document')
    expect(await readFile(path, 'utf8')).toBe('synthetic file')
  })

  it.runIf(process.platform === 'darwin')('opens only a registered native application and passes literal file arguments', async () => {
    const { invoke } = await fixture()
    await expect(invoke('open-with', '/Applications/Unknown.app')).rejects.toThrow('已不可用')
    expect(mocks.execFile).not.toHaveBeenCalled()
    await invoke('open-with', '/Applications/WPS.app')
    expect(mocks.execFile.mock.calls[0]?.[0]).toBe('/usr/bin/open')
    expect(mocks.execFile.mock.calls[0]?.[1]).toEqual(['-a', '/Applications/WPS.app', expect.stringContaining('测试文件.docx')])
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await invoke('open-with')
    expect(mocks.execFile).toHaveBeenCalledOnce()
  })
})
