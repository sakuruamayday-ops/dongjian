/** Sign and verify native files before the product runtime index fixes their bytes. */

import { execFileSync } from 'node:child_process'
import { closeSync, lstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const MACH_O_MAGICS = new Set([
  'feedface',
  'feedfacf',
  'cefaedfe',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca',
])

/** Injectable subprocess boundary used by focused signing tests. */
export type MacRuntimeCodeSigningRunner = (
  executable: string,
  args: string[],
  options: { stdio: 'pipe' },
) => unknown

function runtimeFile(filesRoot: string, portablePath: string): string {
  if (portablePath === '' || isAbsolute(portablePath) || portablePath.includes('\\')
    || portablePath.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`runtime code-signing path is invalid: ${portablePath}`)
  }
  const absolute = resolve(filesRoot, portablePath)
  if (absolute === resolve(filesRoot) || !absolute.startsWith(`${resolve(filesRoot)}/`)) {
    throw new Error(`runtime code-signing path escapes its files tree: ${portablePath}`)
  }
  const info = lstatSync(absolute)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`runtime code-signing entry is not a regular file: ${portablePath}`)
  }
  return absolute
}

/**
 * Detect a thin or universal Mach-O from its fixed four-byte magic.
 * @param path - Regular file to inspect without invoking the host `file` utility.
 * @returns Whether the file is native macOS code.
 */
export function isMachOFile(path: string): boolean {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile() || info.size < 4) return false
  const descriptor = openSync(path, 'r')
  try {
    const magic = Buffer.allocUnsafe(4)
    return readSync(descriptor, magic, 0, magic.length, 0) === magic.length
      && MACH_O_MAGICS.has(magic.toString('hex'))
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Select native files from the exact regular-file inventory used by the runtime index.
 * @param filesRoot - Root containing staged runtime files.
 * @param paths - Portable regular-file paths from the staging walk or verified index.
 * @returns Sorted portable paths for every Mach-O file.
 */
export function macRuntimeCodePaths(filesRoot: string, paths: readonly string[]): string[] {
  return [...paths]
    .sort()
    .filter(path => isMachOFile(runtimeFile(filesRoot, path)))
}

/**
 * Verify every native runtime file has a valid signature for all of its slices.
 * @param filesRoot - Root containing staged or packaged runtime files.
 * @param paths - Exact regular-file inventory authenticated by the runtime index.
 * @param run - Subprocess runner, injectable only for focused tests.
 * @returns Portable paths of the verified Mach-O files.
 */
export function verifyMacRuntimeCodeSignatures(
  filesRoot: string,
  paths: readonly string[],
  run: MacRuntimeCodeSigningRunner = execFileSync,
): string[] {
  const nativePaths = macRuntimeCodePaths(filesRoot, paths)
  for (const path of nativePaths) {
    run('/usr/bin/codesign', [
      '--verify',
      '--strict',
      '--all-architectures',
      runtimeFile(filesRoot, path),
    ], { stdio: 'pipe' })
  }
  return nativePaths
}

/**
 * Apply final ad-hoc signatures before hashes and the Ed25519 index are generated.
 * @param filesRoot - Root containing the completely pruned runtime files.
 * @param paths - Exact regular-file inventory produced after all runtime mutations.
 * @param entitlementsPath - Hardened-runtime entitlements shared with Electron Builder.
 * @param run - Subprocess runner, injectable only for focused tests.
 * @returns Portable paths of the signed and verified Mach-O files.
 */
export function signMacRuntimeCode(
  filesRoot: string,
  paths: readonly string[],
  entitlementsPath: string,
  run: MacRuntimeCodeSigningRunner = execFileSync,
): string[] {
  const entitlements = lstatSync(entitlementsPath)
  if (entitlements.isSymbolicLink() || !entitlements.isFile()) {
    throw new Error('macOS runtime entitlements must be a regular file')
  }
  const nativePaths = macRuntimeCodePaths(filesRoot, paths)
  for (const path of nativePaths) {
    run('/usr/bin/codesign', [
      '--force',
      '--sign',
      '-',
      '--timestamp=none',
      '--options',
      'runtime',
      '--entitlements',
      entitlementsPath,
      runtimeFile(filesRoot, path),
    ], { stdio: 'pipe' })
  }
  verifyMacRuntimeCodeSignatures(filesRoot, nativePaths, run)
  return nativePaths
}
