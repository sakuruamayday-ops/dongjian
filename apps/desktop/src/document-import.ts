/** User-approved document import for one concrete conversation workspace. */

import { randomBytes } from 'node:crypto'
import {
  constants as fsConstants,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export const DOCUMENT_IMPORT_CHANNEL = 'gongchuang:documents:import'
export const DOCUMENT_DROP_IMPORT_CHANNEL = 'gongchuang:documents:import-dropped'
export const DOCUMENT_OPEN_CHANNEL = 'gongchuang:documents:open-imported'
export const SESSION_ATTACHMENT_OPEN_CHANNEL = 'gongchuang:documents:open-session-attachment'

const DESTINATION_DIRECTORY = '导入资料'
const MAX_DOCUMENTS = 20
const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024
const BROAD_DIRECTORY_NAMES = new Set(['desktop', 'documents', 'downloads', '桌面', '文稿', '下载'])

interface DocumentImportDirectoryDocument {
  readonly schemaVersion: 1
  readonly directory: string
}

/** Redacted import result safe to return to the renderer. */
export interface ImportedDocument {
  readonly name: string
  readonly relativePath: string
  readonly bytes: number
}

/** Host operation that moves one client-created import copy to the system Trash or Recycle Bin. */
export type DocumentTrashItem = (path: string) => Promise<void>

interface DocumentPublicationOperations {
  readonly link: typeof link
  readonly copyFile: typeof copyFile
}

const DEFAULT_PUBLICATION_OPERATIONS: DocumentPublicationOperations = { link, copyFile }

function hardLinkUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EPERM'
}

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  // 只拒绝真正的父目录段，不能把合法的 "..evidence.docx" 当成目录穿越。
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

async function concreteWorkspace(value: string): Promise<string> {
  if (!isAbsolute(value) || value.includes('\0')) throw new Error('当前企业空间路径无效')
  const lexical = resolve(value)
  const lexicalInfo = await lstat(lexical)
  if (lexicalInfo.isSymbolicLink() || !lexicalInfo.isDirectory()) {
    throw new Error('当前企业空间必须是真实目录')
  }
  const canonical = await realpath(lexical)
  const home = await realpath(homedir())
  if (canonical === dirname(canonical) || canonical === home) {
    throw new Error('不能向系统根目录或用户主目录导入企业资料')
  }
  if (BROAD_DIRECTORY_NAMES.has(basename(canonical).toLowerCase())) {
    throw new Error('请先选择具体企业或项目目录')
  }
  return canonical
}

function safeName(value: string): string {
  const name = basename(value)
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[<>:"/\\|?*]/gu, '-')
    .trim()
    .replace(/[. ]+$/u, '')
  if (name === '' || name === '.' || name === '..') throw new Error('文件名无效')
  if (name.length <= 160) return name
  const extension = extname(name).slice(0, 64)
  const stem = basename(name, extname(name)).slice(0, Math.max(1, 160 - extension.length))
  return `${stem}${extension}`
}

/** Persist the directory most recently selected or dropped without exposing source paths to web content. */
export class DocumentImportDirectoryStore {
  constructor(private readonly filename: string) {}

  /** Return the saved real directory while it still exists. */
  async read(): Promise<string | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.filename, 'utf8')) as Partial<DocumentImportDirectoryDocument>
      if (parsed.schemaVersion !== 1 || typeof parsed.directory !== 'string' || !isAbsolute(parsed.directory)) return undefined
      const info = await lstat(parsed.directory)
      if (info.isSymbolicLink() || !info.isDirectory()) return undefined
      return await realpath(parsed.directory)
    } catch {
      return undefined
    }
  }

  /** Remember the real parent directory of one native file selection. */
  async remember(selectedPath: string): Promise<void> {
    if (!isAbsolute(selectedPath) || selectedPath.includes('\0')) throw new Error('所选文件路径无效')
    const directory = await realpath(dirname(selectedPath))
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('所选文件目录无效')
    await writeFileAtomic(this.filename, `${JSON.stringify({ schemaVersion: 1, directory })}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }
}

async function publishTemporaryAtAvailableDestination(
  directory: string,
  name: string,
  temporary: string,
  operations: DocumentPublicationOperations,
): Promise<string> {
  const extension = extname(name)
  const stem = basename(name, extension)
  for (let index = 1; index <= 999; index += 1) {
    const suffix = index === 1 ? '' : ` (${String(index)})`
    // 同名后缀也计入草稿持久化的 160 字符上限，否则重启会丢失附件引用。
    const candidate = join(directory, `${stem.slice(0, 160 - suffix.length - extension.length)}${suffix}${extension}`)
    try {
      // Linking within the destination directory atomically publishes the
      // verified copy and fails instead of replacing a concurrent import.
      await operations.link(temporary, candidate)
      return candidate
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      if (!hardLinkUnsupported(error)) throw error
      try {
        // Some user-selected external and network filesystems reject hard
        // links. COPYFILE_EXCL keeps the same no-replacement guarantee there.
        await operations.copyFile(temporary, candidate, fsConstants.COPYFILE_EXCL)
        return candidate
      } catch (copyError: unknown) {
        if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw copyError
      }
    }
  }
  throw new Error(`无法为 ${name} 分配不重复的导入文件名`)
}

async function trashIfPresent(path: string, trashItem: DocumentTrashItem): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await trashItem(path)
}

async function rollbackImportCopies(
  paths: readonly string[],
  trashItem: DocumentTrashItem,
): Promise<readonly unknown[]> {
  const failures: unknown[] = []
  for (const path of paths.toReversed()) {
    try {
      await trashIfPresent(path, trashItem)
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

/**
 * Copy user-selected regular files into a private subdirectory of the current conversation workspace.
 * @param workspacePath - Current Host-reported conversation workspace path.
 * @param selectedPaths - Paths returned directly by Electron's native open dialog.
 * @param trashItem - Electron Host operation for recoverable rollback of this batch's copies.
 * @returns Redacted workspace-relative receipts; source paths never leave the main process.
 */
export async function importSelectedDocuments(
  workspacePath: string,
  selectedPaths: readonly string[],
  trashItem: DocumentTrashItem,
  publicationOperations: DocumentPublicationOperations = DEFAULT_PUBLICATION_OPERATIONS,
): Promise<readonly ImportedDocument[]> {
  if (selectedPaths.length > MAX_DOCUMENTS) throw new Error(`一次最多添加 ${String(MAX_DOCUMENTS)} 个文件`)
  if (selectedPaths.length === 0) return []
  const workspace = await concreteWorkspace(workspacePath)
  const destinationDirectory = join(workspace, DESTINATION_DIRECTORY)
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 })
  const canonicalDestination = await realpath(destinationDirectory)
  if (!contained(workspace, canonicalDestination)) throw new Error('导入目录越出当前企业空间')

  const receipts: ImportedDocument[] = []
  const createdPaths: string[] = []
  let temporary: string | undefined
  try {
    for (const sourcePath of selectedPaths) {
      const sourceInfo = await lstat(sourcePath)
      if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new Error('只能添加普通文件，不支持链接或目录')
      if (sourceInfo.size <= 0 || sourceInfo.size > MAX_DOCUMENT_BYTES) {
        throw new Error(`单个文件必须大于 0 且不超过 ${String(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB`)
      }
      const name = safeName(sourcePath)
      temporary = join(canonicalDestination, `.import-${randomBytes(16).toString('hex')}.tmp`)
      await copyFile(sourcePath, temporary, fsConstants.COPYFILE_EXCL)
      const copied = await stat(temporary)
      if (!copied.isFile() || copied.size !== sourceInfo.size) throw new Error(`文件 ${name} 复制不完整`)
      const destination = await publishTemporaryAtAvailableDestination(
        canonicalDestination,
        name,
        temporary,
        publicationOperations,
      )
      createdPaths.push(destination)
      await unlink(temporary)
      temporary = undefined
      receipts.push(Object.freeze({
        name: basename(destination),
        relativePath: relative(workspace, destination).split('\\').join('/'),
        bytes: sourceInfo.size,
      }))
    }
  } catch (error) {
    const rollbackFailures = await rollbackImportCopies(
      temporary === undefined ? createdPaths : [...createdPaths, temporary],
      trashItem,
    )
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        '文件导入失败，且部分本次导入副本无法移入系统废纸篓',
      )
    }
    throw error
  }
  return Object.freeze(receipts)
}

/** Resolve one previously imported document without allowing arbitrary workspace paths. */
export async function importedDocumentPath(workspacePath: string, relativePath: string): Promise<string> {
  if (
    relativePath.length === 0
    || relativePath.length > 4_096
    || relativePath.includes('\\')
    || relativePath.includes('\0')
    || !relativePath.startsWith(`${DESTINATION_DIRECTORY}/`)
  ) {
    throw new Error('导入文件引用无效')
  }
  const workspace = await concreteWorkspace(workspacePath)
  const importDirectory = await realpath(join(workspace, DESTINATION_DIRECTORY))
  if (!contained(workspace, importDirectory)) throw new Error('导入目录越出当前企业空间')
  const lexical = resolve(workspace, ...relativePath.split('/'))
  if (!contained(importDirectory, lexical)) throw new Error('导入文件越出受控目录')
  const info = await lstat(lexical)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('导入文件已不可用')
  const canonical = await realpath(lexical)
  if (!contained(importDirectory, canonical)) throw new Error('导入文件越出受控目录')
  return canonical
}

/** Resolve a regular workspace file for explicit native open, reveal and copy actions. */
export async function workspaceDocumentPath(workspacePath: string, path: string): Promise<string> {
  if (path.length === 0 || path.length > 4_096 || path.includes('\0')) throw new Error('文件引用无效')
  const workspace = await concreteWorkspace(workspacePath)
  const lexical = resolve(workspacePath, path)
  // macOS may expose the same workspace through /tmp and /private/tmp.
  // Accept either lexical root, then require the final real path to stay inside.
  if (!contained(resolve(workspacePath), lexical) && !contained(workspace, lexical)) throw new Error('文件越出当前企业空间')
  const info = await lstat(lexical)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('文件已不可用')
  const canonical = await realpath(lexical)
  if (!contained(workspace, canonical)) throw new Error('文件越出当前企业空间')
  return canonical
}
