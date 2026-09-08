/** Recoverable disposal for generated Python overlay residue. */

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const TRASH_ROOT_ENV = 'GONGCHUANG_OVERLAY_TRASH_ROOT'

function uniqueDestination(root: string, name: string): string {
  let destination = join(root, name)
  let suffix = 0
  while (existsSync(destination)) {
    suffix += 1
    destination = join(root, `${name}-${String(suffix)}`)
  }
  return destination
}

/**
 * Moves one generated path into a recoverable Trash location.
 *
 * @param path Generated path that must not remain in the overlay.
 * @param configuredRoot Optional Trash root used by isolated tests and non-macOS hosts.
 * @returns The destination path, or undefined when the generated path is absent.
 */
export function moveGeneratedPathToTrash(
  path: string,
  configuredRoot = process.env[TRASH_ROOT_ENV],
): string | undefined {
  if (!existsSync(path)) return undefined
  const trashRoot = configuredRoot === undefined
    ? process.platform === 'darwin'
      ? join(homedir(), '.Trash')
      : undefined
    : resolve(configuredRoot)
  if (trashRoot === undefined) {
    throw new Error(`${TRASH_ROOT_ENV} is required outside macOS`)
  }
  mkdirSync(trashRoot, { recursive: true })
  const bucket = join(
    trashRoot,
    `gongchuang-python-overlay-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${String(process.pid)}`,
  )
  mkdirSync(bucket, { recursive: true })
  const destination = uniqueDestination(bucket, basename(path))
  renameSync(path, destination)
  return destination
}
