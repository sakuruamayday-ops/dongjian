/** Device-local enterprise workspace root selection and directory preparation. */

import { constants, realpathSync } from 'node:fs'
import { access, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export const WORKSPACE_ROOT_STATE_CHANNEL = 'gongchuang:workspace-root:state'
export const WORKSPACE_ROOT_CHOOSE_CHANNEL = 'gongchuang:workspace-root:choose'
export const WORKSPACE_ROOT_USE_DEFAULT_CHANNEL = 'gongchuang:workspace-root:use-default'
export const ENTERPRISE_WORKSPACE_CREATE_CHANNEL = 'gongchuang:enterprise-workspace:create'
export const ENTERPRISE_WORKSPACE_IMPORT_CHANNEL = 'gongchuang:enterprise-workspace:import'

const DEFAULT_WORKSPACE_ROOT_NAME = '洞见企业空间'

const SETTINGS_SCHEMA_VERSION = 1
const MAX_ENTERPRISE_NAME_LENGTH = 120
const PORTABLE_INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f\u007f]/u
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

interface WorkspaceRootDocument {
  readonly schemaVersion: 1
  readonly rootPath: string
  readonly selection: 'default' | 'custom'
}

/** Renderer-safe root state used by the first-use guide and settings page. */
export interface WorkspaceRootState {
  readonly rootPath: string
  readonly isDefault: boolean
  readonly needsInitialSetup: boolean
}

/** One enterprise directory prepared for the workspace registry. */
export interface EnterpriseWorkspaceDirectory {
  readonly name: string
  readonly path: string
  readonly created: boolean
  readonly imported: boolean
}

/** Future preload surface; native directory dialogs remain owned by the main process. */
export interface WorkspaceRootDesktopBridge {
  workspaceRootState: () => Promise<WorkspaceRootState>
  chooseWorkspaceRoot: () => Promise<WorkspaceRootState | null>
  useDefaultWorkspaceRoot: () => Promise<WorkspaceRootState>
  createEnterpriseWorkspace: (name: string) => Promise<EnterpriseWorkspaceDirectory>
  importEnterpriseWorkspace: () => Promise<EnterpriseWorkspaceDirectory | null>
}

export interface DesktopWorkspaceRootStoreOptions {
  /** Private JSON document below Electron's userData directory. */
  readonly settingsFile: string
  /** Electron `app.getPath('documents')`. */
  readonly documentsDirectory: string
  /** Electron app and executable directories that must never hold customer data. */
  readonly installationDirectories: readonly string[]
  /** User-wide directories that can contain unrelated data and must never be trashed as one enterprise. */
  readonly protectedDirectories?: readonly string[]
  /** Deterministic path rules for tests; production uses `process.platform`. */
  readonly platform?: NodeJS.Platform
}

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

function fullyQualified(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/u.test(path)
    : posix.isAbsolute(path)
}

function comparable(path: string, platform: NodeJS.Platform): string {
  const normalized = pathApi(platform).normalize(path)
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function isSameOrDescendant(parent: string, candidate: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform)
  const base = comparable(parent, platform)
  const target = comparable(candidate, platform)
  const child = api.relative(base, target)
  return child === '' || (child !== '..' && !child.startsWith(`..${api.sep}`) && !api.isAbsolute(child))
}

/**
 * Resolve the first-run enterprise workspace root from Electron's Documents directory.
 * @param documentsDirectory - Electron `app.getPath('documents')` value.
 * @param platform - Path dialect to apply.
 * @returns The platform-native default root path.
 */
export function defaultWorkspaceRoot(
  documentsDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (documentsDirectory.includes('\0') || !fullyQualified(documentsDirectory, platform)) {
    throw new Error('系统文稿目录不是有效的绝对路径')
  }
  return pathApi(platform).join(documentsDirectory, DEFAULT_WORKSPACE_ROOT_NAME)
}

/**
 * Normalize one enterprise directory name using a portable Windows/macOS subset.
 * @param value - Untrusted name received from the renderer.
 * @param platform - Target platform, used for native reserved-name rules.
 * @returns A normalized safe directory component.
 */
export function enterpriseDirectoryName(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  if (typeof value !== 'string') throw new Error('企业名称无效')
  const name = value.normalize('NFKC').trim()
  if (name === '' || name === '.' || name === '..' || name.length > MAX_ENTERPRISE_NAME_LENGTH) {
    throw new Error('企业名称无效')
  }
  if (PORTABLE_INVALID_NAME.test(name) || /[. ]$/u.test(name)) {
    throw new Error('企业名称包含系统不支持的字符')
  }
  if (platform === 'win32' && WINDOWS_RESERVED_NAME.test(name)) {
    throw new Error('企业名称与 Windows 系统保留名称冲突')
  }
  return name
}

/**
 * Reject a data root that is an installation directory, contains one, or sits below one.
 * @param candidate - Proposed data root.
 * @param installationDirectories - App/executable directories supplied by Electron Host.
 * @param platform - Path dialect to apply.
 */
export function assertSeparateFromInstallation(
  candidate: string,
  installationDirectories: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  for (const installation of installationDirectories) {
    if (!fullyQualified(installation, platform)) continue
    if (isSameOrDescendant(installation, candidate, platform)
      || isSameOrDescendant(candidate, installation, platform)) {
      throw new Error('企业空间不能使用客户端安装目录')
    }
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function existingDirectory(path: string, label: string, platform: NodeJS.Platform): Promise<string> {
  if (path.includes('\0') || !fullyQualified(path, platform)) throw new Error(`${label}必须是绝对路径`)
  // macOS file-provider and user-selected aliases may be symbolic links. Apply
  // installation and read/write checks to their canonical directory instead.
  const canonical = await realpath(path)
  const info = await stat(canonical)
  if (!info.isDirectory()) throw new Error(`${label}必须是目录`)
  return canonical
}

/** Persistence and directory operations for the desktop workspace-root surface. */
export class DesktopWorkspaceRootStore {
  private readonly platform: NodeJS.Platform
  private readonly documentsDirectory: string
  private readonly installationDirectories: readonly string[]
  private readonly protectedDirectories: readonly string[]

  constructor(private readonly options: DesktopWorkspaceRootStoreOptions) {
    this.platform = options.platform ?? process.platform
    if (!fullyQualified(options.settingsFile, this.platform)) throw new Error('企业空间配置文件路径无效')
    this.documentsDirectory = this.canonicalInput(options.documentsDirectory)
    this.installationDirectories = options.installationDirectories.map(path => this.canonicalInput(path))
    this.protectedDirectories = (options.protectedDirectories ?? [options.documentsDirectory])
      .map(path => this.canonicalInput(path))
  }

  /** Read the saved root, or prepare the Documents-based default for first use. */
  async state(): Promise<WorkspaceRootState> {
    const saved = await this.readDocument()
    if (saved === undefined) {
      const rootPath = await this.prepareDefault()
      return Object.freeze({ rootPath, isDefault: true, needsInitialSetup: true })
    }
    const rootPath = await existingDirectory(saved.rootPath, '已保存的企业空间根目录', this.platform)
    this.assertUsableDataDirectory(rootPath)
    await this.assertAccessibleDataDirectory(rootPath)
    return Object.freeze({
      rootPath,
      isDefault: saved.selection === 'default',
      needsInitialSetup: false,
    })
  }

  /** Persist an existing directory selected by Electron's native directory dialog. */
  async selectRoot(selectedPath: string): Promise<WorkspaceRootState> {
    const rootPath = await existingDirectory(selectedPath, '企业空间根目录', this.platform)
    this.assertUsableDataDirectory(rootPath)
    await this.assertAccessibleDataDirectory(rootPath)
    const defaultRoot = comparable(defaultWorkspaceRoot(this.documentsDirectory, this.platform), this.platform)
    const selection = comparable(rootPath, this.platform) === defaultRoot ? 'default' : 'custom'
    await this.writeDocument({ schemaVersion: SETTINGS_SCHEMA_VERSION, rootPath, selection })
    return Object.freeze({ rootPath, isDefault: selection === 'default', needsInitialSetup: false })
  }

  /** Create and persist the Documents-based default root. */
  async useDefaultRoot(): Promise<WorkspaceRootState> {
    const rootPath = await this.prepareDefault()
    await this.writeDocument({ schemaVersion: SETTINGS_SCHEMA_VERSION, rootPath, selection: 'default' })
    return Object.freeze({ rootPath, isDefault: true, needsInitialSetup: false })
  }

  /** Create or reuse an immediate enterprise-name child below the active root. */
  async createEnterprise(nameValue: unknown): Promise<EnterpriseWorkspaceDirectory> {
    const current = await this.state()
    const name = enterpriseDirectoryName(nameValue, this.platform)
    const destination = pathApi(this.platform).join(current.rootPath, name)
    let created = true
    try {
      await mkdir(destination, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error
      created = false
    }
    const path = await existingDirectory(destination, '企业空间目录', this.platform)
    if (!isSameOrDescendant(current.rootPath, path, this.platform)) {
      throw new Error('企业空间目录越出当前根目录')
    }
    if (current.needsInitialSetup) {
      await this.writeDocument({ schemaVersion: SETTINGS_SCHEMA_VERSION, rootPath: current.rootPath, selection: 'default' })
    }
    return Object.freeze({ name, path, created, imported: false })
  }

  /**
   * Connect an existing concrete enterprise directory without copying, moving, or modifying its files.
   * The workspace registry remains the durable owner of the imported workspace record.
   */
  async importEnterprise(selectedPath: string): Promise<EnterpriseWorkspaceDirectory> {
    const path = await existingDirectory(selectedPath, '待导入企业目录', this.platform)
    this.assertUsableDataDirectory(path)
    await this.assertAccessibleDataDirectory(path)
    const current = await this.state()
    if (comparable(path, this.platform) === comparable(current.rootPath, this.platform)
      || comparable(path, this.platform) === comparable(this.documentsDirectory, this.platform)
      || comparable(path, this.platform) === comparable(pathApi(this.platform).parse(path).root, this.platform)) {
      throw new Error('请选择具体企业目录，不能导入企业空间根目录或系统宽目录')
    }
    const name = enterpriseDirectoryName(pathApi(this.platform).basename(path), this.platform)
    return Object.freeze({ name, path, created: false, imported: true })
  }

  /**
   * Revalidate a registry path immediately before moving an enterprise directory to Trash.
   * Legacy records predate current import checks, and a recorded directory may have been
   * replaced by a symlink, so creation-time validation is not an authorization to delete.
   * @param candidate - Authoritative path from the Host workspace registry.
   */
  async assertDeletableEnterpriseDirectory(candidate: string): Promise<void> {
    const canonical = await existingDirectory(candidate, '待删除企业目录', this.platform)
    if (comparable(canonical, this.platform) !== comparable(candidate, this.platform)) {
      throw new Error('企业目录位置已经变化，请重新导入后再删除')
    }
    assertSeparateFromInstallation(canonical, this.installationDirectories, this.platform)
    const currentRoot = (await this.state()).rootPath
    for (const protectedPath of [...this.protectedDirectories, currentRoot]) {
      if (isSameOrDescendant(canonical, protectedPath, this.platform)) {
        throw new Error('该记录指向系统宽目录或企业空间根目录，客户端拒绝删除')
      }
    }
    const filesystemRoot = pathApi(this.platform).parse(canonical).root
    if (comparable(canonical, this.platform) === comparable(filesystemRoot, this.platform)) {
      throw new Error('客户端拒绝删除文件系统根目录')
    }
  }

  /** Resolve one Host-registry directory for overlap checks without trusting its spelling. */
  async canonicalRegisteredEnterpriseDirectory(candidate: string): Promise<string> {
    const api = pathApi(this.platform)
    let ancestor = candidate
    const missing: string[] = []
    for (;;) {
      try {
        return api.join(await existingDirectory(ancestor, '已注册企业目录', this.platform), ...missing)
      } catch (error) {
        // Old registrations can outlive their directories. Keep them in overlap
        // checks, resolving the nearest existing ancestor so aliases cannot hide
        // a nested workspace. Only absence is tolerated; permission errors are not.
        if (!isEnoent(error)) throw error
        const parent = api.dirname(ancestor)
        if (parent === ancestor) throw error
        missing.unshift(api.basename(ancestor))
        ancestor = parent
      }
    }
  }

  private async prepareDefault(): Promise<string> {
    const requested = defaultWorkspaceRoot(this.documentsDirectory, this.platform)
    this.assertUsableDataDirectory(requested)
    await mkdir(requested, { recursive: true, mode: 0o700 })
    const rootPath = await existingDirectory(requested, '默认企业空间根目录', this.platform)
    await this.assertAccessibleDataDirectory(rootPath)
    return rootPath
  }

  private assertUsableDataDirectory(path: string): void {
    assertSeparateFromInstallation(path, this.installationDirectories, this.platform)
  }

  private async assertAccessibleDataDirectory(path: string): Promise<void> {
    try {
      await access(path, constants.R_OK | constants.W_OK)
    } catch (error) {
      throw new Error('企业空间根目录不可读写', { cause: error })
    }
  }

  private canonicalInput(path: string): string {
    if (!fullyQualified(path, this.platform)) return path
    try {
      return realpathSync(path)
    } catch {
      return pathApi(this.platform).normalize(path)
    }
  }

  private async readDocument(): Promise<WorkspaceRootDocument | undefined> {
    try {
      const info = await lstat(this.options.settingsFile)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('企业空间根目录配置必须是普通文件')
      const parsed = JSON.parse(await readFile(this.options.settingsFile, 'utf8')) as Partial<WorkspaceRootDocument>
      if (parsed.schemaVersion !== SETTINGS_SCHEMA_VERSION
        || typeof parsed.rootPath !== 'string'
        || (parsed.selection !== 'default' && parsed.selection !== 'custom')) {
        throw new Error('企业空间根目录配置内容无效')
      }
      return { schemaVersion: SETTINGS_SCHEMA_VERSION, rootPath: parsed.rootPath, selection: parsed.selection }
    } catch (error) {
      if (isEnoent(error)) return undefined
      if (error instanceof SyntaxError) throw new Error('企业空间根目录配置内容无效', { cause: error })
      throw error
    }
  }

  private async writeDocument(document: WorkspaceRootDocument): Promise<void> {
    try {
      await writeFileAtomic(this.options.settingsFile, `${JSON.stringify(document)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    } catch (error) {
      throw new Error('企业空间根目录配置无法写入', { cause: error })
    }
  }
}
