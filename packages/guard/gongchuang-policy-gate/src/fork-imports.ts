/** Preserve product-imported documents when their conversation changes workspace. */
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const DIRECTORY = '导入资料'

function contained(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

async function regularFile(root: string, path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || !contained(root, await realpath(path))) {
    throw new Error('会话附件不是企业空间内的普通文件，未移动会话。')
  }
}

/**
 * Copy only imported files named by inherited user messages. No existing file is overwritten.
 * @param input - Trusted fork events and registered workspace paths.
 */
export async function preserveForkImports(input: {
  readonly events: readonly SessionEvent[]
  readonly sourceCwd: string
  readonly targetCwd: string
}): Promise<void> {
  const names = new Set<string>()
  for (const event of input.events) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const source = event.data.source as { displayText?: string }
    const text = source.displayText ?? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    for (const line of text.split('\n')) {
      const match = /^@"导入资料\/([^/\\"\u0000-\u001f]+)"$|^- `导入资料\/([^/\\`\u0000-\u001f]+)`$/u.exec(line)
      const name = match?.[1] ?? match?.[2]
      if (name !== undefined && name !== '.' && name !== '..') names.add(name)
    }
  }
  if (names.size === 0) return
  const sourceRoot = await realpath(input.sourceCwd)
  const targetRoot = await realpath(input.targetCwd)
  if (sourceRoot === targetRoot) return
  const targetDirectory = join(targetRoot, DIRECTORY)
  await mkdir(targetDirectory, { recursive: true })
  if (!contained(targetRoot, await realpath(targetDirectory))) throw new Error('目标附件目录越出企业空间，未移动会话。')
  const copies: { source: string; target: string }[] = []
  for (const name of names) {
    const source = join(sourceRoot, DIRECTORY, name)
    const target = join(targetDirectory, name)
    await regularFile(sourceRoot, source)
    try {
      await lstat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      copies.push({ source, target })
      continue
    }
    await regularFile(targetRoot, target)
    if (!(await readFile(source)).equals(await readFile(target))) {
      throw new Error(`目标空间已有不同内容的同名附件“${name}”，请处理重名后再移动会话。`)
    }
  }
  // Preflight all conflicts before copying; an I/O failure retains completed copies
  // for an idempotent retry, while the caller leaves the source conversation active.
  for (const { source, target } of copies) {
    if (!contained(targetRoot, await realpath(dirname(target)))) throw new Error('目标附件目录已变更')
    await copyFile(source, target, constants.COPYFILE_EXCL)
  }
}
