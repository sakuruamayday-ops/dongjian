/// <reference types="node" />
import { mkdtemp, mkdir, readFile, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertSeparateFromInstallation,
  defaultWorkspaceRoot,
  DesktopWorkspaceRootStore,
  enterpriseDirectoryName,
} from '../src/workspace-root.ts'
import { EnterpriseTrashService } from '../src/enterprise-trash.ts'
import { EnterpriseTrashJournal } from '../src/enterprise-trash-journal.ts'

async function fixture(): Promise<{
  readonly root: string
  readonly documents: string
  readonly settingsFile: string
  readonly installation: string
  readonly store: DesktopWorkspaceRootStore
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gongchuang-workspace-root-')))
  const documents = join(root, 'Documents')
  const installation = join(root, 'Applications', '洞见.app')
  const settingsFile = join(root, 'UserData', 'workspace-root.json')
  await mkdir(documents)
  await mkdir(installation, { recursive: true })
  return {
    root,
    documents,
    settingsFile,
    installation,
    store: new DesktopWorkspaceRootStore({
      settingsFile,
      documentsDirectory: documents,
      installationDirectories: [installation],
    }),
  }
}

describe('desktop enterprise workspace root', () => {
  it('prepares Documents/洞见企业空间 as the first-run default without using the install directory', async () => {
    const state = await (await fixture()).store.state()
    expect(state).toMatchObject({ isDefault: true, needsInitialSetup: true })
    expect(state.rootPath).toMatch(/Documents[/\\]洞见企业空间$/u)
    expect((await stat(state.rootPath)).isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect((await stat(state.rootPath)).mode & 0o777).toBe(0o700)
  })

  it('atomically persists a user-selected existing root and reloads it', async () => {
    const state = await fixture()
    const selected = join(state.root, '企业资料库')
    await mkdir(selected)
    await expect(state.store.selectRoot(selected)).resolves.toMatchObject({
      rootPath: selected, isDefault: false, needsInitialSetup: false,
    })
    expect(await new DesktopWorkspaceRootStore({
      settingsFile: state.settingsFile,
      documentsDirectory: state.documents,
      installationDirectories: [state.installation],
    }).state()).toMatchObject({ rootPath: selected, isDefault: false, needsInitialSetup: false })
    expect(JSON.parse(await readFile(state.settingsFile, 'utf8'))).toEqual({
      schemaVersion: 1, rootPath: selected, selection: 'custom',
    })
    if (process.platform !== 'win32') expect((await stat(state.settingsFile)).mode & 0o777).toBe(0o600)
  })

  it('persists explicit acceptance of the default root', async () => {
    const state = await fixture()
    const accepted = await state.store.useDefaultRoot()
    expect(accepted).toMatchObject({ isDefault: true, needsInitialSetup: false })
    await expect(state.store.state()).resolves.toEqual(accepted)
  })

  it('creates enterprise-name children and reuses an existing directory', async () => {
    const state = await fixture()
    const created = await state.store.createEnterprise('  共创测试企业有限公司  ')
    expect(created).toMatchObject({ name: '共创测试企业有限公司', created: true, imported: false })
    expect(created.path).toMatch(/洞见企业空间[/\\]共创测试企业有限公司$/u)
    await expect(state.store.createEnterprise('共创测试企业有限公司')).resolves.toMatchObject({
      path: created.path, created: false, imported: false,
    })
    await expect(state.store.state()).resolves.toMatchObject({ needsInitialSetup: false })
  })

  it('imports an existing concrete directory in place without modifying its files', async () => {
    const state = await fixture()
    const existing = join(state.root, '历史企业资料')
    await mkdir(existing)
    await writeFile(join(existing, '原始资料.txt'), '保持原位\n', 'utf8')
    await expect(state.store.importEnterprise(existing)).resolves.toMatchObject({
      name: '历史企业资料', path: existing, created: false, imported: true,
    })
    expect(await readFile(join(existing, '原始资料.txt'), 'utf8')).toBe('保持原位\n')
  })

  it('rejects install directories, install parents, broad roots, and malformed settings', async () => {
    const state = await fixture()
    await expect(state.store.selectRoot(state.installation)).rejects.toThrow('安装目录')
    await expect(state.store.selectRoot(join(state.root, 'Applications'))).rejects.toThrow('安装目录')
    await expect(state.store.importEnterprise(state.documents)).rejects.toThrow('具体企业目录')

    const target = join(state.root, '真实目录')
    const link = join(state.root, '目录链接')
    await mkdir(target)
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(state.store.selectRoot(link)).resolves.toMatchObject({ rootPath: target, isDefault: false })

    await mkdir(join(state.root, 'UserData'), { recursive: true })
    await writeFile(state.settingsFile, '{broken', 'utf8')
    await expect(state.store.state()).rejects.toThrow('配置内容无效')
  })

  it('revalidates historical registry paths before an enterprise directory can be trashed', async () => {
    const state = await fixture()
    const home = join(state.root, 'Home')
    const desktop = join(home, 'Desktop')
    const downloads = join(home, 'Downloads')
    await mkdir(desktop, { recursive: true })
    await mkdir(downloads)
    const store = new DesktopWorkspaceRootStore({
      settingsFile: state.settingsFile,
      documentsDirectory: state.documents,
      installationDirectories: [state.installation],
      protectedDirectories: [home, state.documents, desktop, downloads],
    })
    const currentRoot = (await store.state()).rootPath
    const ordinaryEnterprise = join(state.root, '导入企业')
    await mkdir(ordinaryEnterprise)

    for (const protectedPath of [home, state.documents, desktop, downloads, currentRoot, state.installation]) {
      await expect(store.assertDeletableEnterpriseDirectory(protectedPath), protectedPath)
        .rejects.toThrow()
    }
    await expect(store.assertDeletableEnterpriseDirectory(ordinaryEnterprise)).resolves.toBeUndefined()

    const replacement = join(state.root, '替换后的目录')
    const registryPath = join(state.root, '历史注册目录')
    await mkdir(replacement)
    await symlink(replacement, registryPath, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(store.assertDeletableEnterpriseDirectory(registryPath)).rejects.toThrow('位置已经变化')
  })

  it('resolves missing historical workspace paths without requiring unrelated directories to exist', async () => {
    const state = await fixture()
    const missing = join(state.documents, 'removed-enterprise', 'removed-child')
    await expect(state.store.canonicalRegisteredEnterpriseDirectory(missing)).resolves.toBe(missing)
    // Tolerating an absent overlap candidate must not authorize deleting an absent target.
    await expect(state.store.assertDeletableEnterpriseDirectory(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('resolves existing ancestor aliases for absent overlap candidates and rejects invalid paths', async () => {
    const state = await fixture()
    const target = join(state.documents, 'enterprise')
    const alias = join(state.root, 'enterprise-alias')
    await mkdir(target)
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(state.store.canonicalRegisteredEnterpriseDirectory(join(alias, 'missing-child')))
      .resolves.toBe(join(target, 'missing-child'))
    await expect(state.store.canonicalRegisteredEnterpriseDirectory('relative-path')).rejects.toThrow('绝对路径')
    const notDirectory = join(state.root, 'not-directory.txt')
    await writeFile(notDirectory, 'synthetic')
    await expect(state.store.canonicalRegisteredEnterpriseDirectory(notDirectory)).rejects.toThrow('必须是目录')
    await expect(state.store.canonicalRegisteredEnterpriseDirectory(join(notDirectory, 'child')))
      .rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('composes deletion with missing historical registrations without losing nested-workspace protection', async () => {
    const state = await fixture()
    const target = await state.store.createEnterprise('synthetic-enterprise')
    const contentPath = join(target.path, 'keep.txt')
    await writeFile(contentPath, 'synthetic attachment')
    const alias = join(state.root, 'alias')
    await symlink(target.path, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const workspace = { id: 'current', path: target.path, sessionIds: [] }
    let other = { id: 'historical', path: join(alias, 'missing-child') }
    let removed = false
    const journal = new EnterpriseTrashJournal(join(state.root, 'trash-journal.json'))
    const simulatedTrash = join(state.root, 'simulated-trash')
    const service = new EnterpriseTrashService({
      host: {
        workspace: () => removed ? undefined : workspace,
        workspaces: async () => Promise.all([workspace, other].map(async item => ({
          ...item, path: await state.store.canonicalRegisteredEnterpriseDirectory(item.path),
        }))),
        assertWorkspaceDeletionSafe: item => state.store.assertDeletableEnterpriseDirectory(item.path),
        sessionHeaders: async () => new Map(),
        sessionArtifactDirectory: () => undefined,
        quiesceSession: async () => {},
        releaseSessionDisposal: async () => {},
        hardDeleteWorkspace: async () => { removed = true; return true },
        markDeletedSession: async () => {},
        restoreDeletedSession: async () => {},
      },
      journal,
      pathExists: async (path) => {
        try { await stat(path); return true } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
      },
      trashItem: path => rename(path, simulatedTrash),
    })
    await expect(service.trashWorkspace(workspace.id)).rejects.toThrow('子企业空间')
    expect(await readFile(contentPath, 'utf8')).toBe('synthetic attachment')
    expect(await journal.listWorkspaces()).toEqual([])

    other = { id: 'historical', path: join(state.documents, 'removed-unrelated-enterprise') }
    await service.trashWorkspace(workspace.id)
    expect(removed).toBe(true)
    expect(await readFile(join(simulatedTrash, 'keep.txt'), 'utf8')).toBe('synthetic attachment')
    await expect(stat(target.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await journal.listWorkspaces()).toEqual([])
  })
})

describe('portable Windows and macOS path rules', () => {
  it('uses each platform native Documents path syntax', () => {
    expect(defaultWorkspaceRoot('/Users/example/Documents', 'darwin'))
      .toBe('/Users/example/Documents/洞见企业空间')
    expect(defaultWorkspaceRoot('C:\\Users\\example\\Documents', 'win32'))
      .toBe('C:\\Users\\example\\Documents\\洞见企业空间')
    expect(() => defaultWorkspaceRoot('Documents', 'darwin')).toThrow('绝对路径')
    expect(() => defaultWorkspaceRoot('Documents', 'win32')).toThrow('绝对路径')
  })

  it('rejects names that are unsafe on macOS or Windows', () => {
    for (const name of ['', '.', '..', '企业/项目', '企业\\项目', '企业:项目', '企业.']) {
      expect(() => enterpriseDirectoryName(name, 'darwin'), name).toThrow()
      expect(() => enterpriseDirectoryName(name, 'win32'), name).toThrow()
    }
    expect(enterpriseDirectoryName('共创测试企业有限公司', 'darwin')).toBe('共创测试企业有限公司')
    expect(enterpriseDirectoryName('共创测试企业有限公司', 'win32')).toBe('共创测试企业有限公司')
    expect(enterpriseDirectoryName('  共创测试企业  ', 'darwin')).toBe('共创测试企业')
    for (const reserved of ['CON', 'nul.txt', 'COM1', 'LPT9.log']) {
      expect(() => enterpriseDirectoryName(reserved, 'win32'), reserved).toThrow('Windows 系统保留名称')
    }
  })

  it('rejects roots that overlap installation directories in both path dialects', () => {
    expect(() => {
      assertSeparateFromInstallation(
        '/Applications/洞见.app/Contents/Resources/data',
        ['/Applications/洞见.app'],
        'darwin',
      )
    }).toThrow('安装目录')
    expect(() => {
      assertSeparateFromInstallation(
        'C:\\Program Files\\洞见\\data',
        ['C:\\Program Files\\洞见'],
        'win32',
      )
    }).toThrow('安装目录')
    expect(() => {
      assertSeparateFromInstallation(
        'C:\\Program Files',
        ['C:\\Program Files\\洞见'],
        'win32',
      )
    }).toThrow('安装目录')
    expect(() => {
      assertSeparateFromInstallation(
        'C:\\Users\\example\\Documents\\洞见企业空间',
        ['C:\\Program Files\\洞见'],
        'win32',
      )
    }).not.toThrow()
  })
})
