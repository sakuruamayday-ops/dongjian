import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { Arch } from 'electron-builder'

/** Return the final macOS App path from Electron Builder's afterSign context. */
export function signedMacApplicationPath(context) {
  return join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )
}

/** Bind Electron Builder's closed architecture enum to the product runtime identity. */
export function signedMacArchitecture(context) {
  if (context.arch === Arch.arm64) return 'arm64'
  if (context.arch === Arch.x64) return 'x64'
  throw new Error(`unsupported signed macOS architecture: ${String(context.arch)}`)
}

/**
 * Reuse the product verifiers against the signed App before any target archive
 * is created. The hook is verification-only and must never mutate the bundle.
 */
export function verifySignedMacApplication(context, run = execFileSync) {
  if (context.electronPlatformName !== 'darwin') return
  const verifier = resolve(import.meta.dirname, 'verify-final-macos-application.ts')
  run(process.execPath, [
    '--import',
    'tsx/esm',
    verifier,
    '--app',
    signedMacApplicationPath(context),
    '--arch',
    signedMacArchitecture(context),
  ], { stdio: 'inherit' })
}

export default async function afterSign(context) {
  verifySignedMacApplication(context)
}
