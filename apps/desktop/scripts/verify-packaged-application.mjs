import { extractFile, getRawHeader } from '@electron/asar'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_PACKAGED_ASAR_BYTES = 512 * 1024 * 1024
const PRODUCT_WORKSPACE_SCOPES = new Set(['@deepseek-ai', '@gongchuang'])

/** Return the platform-specific application archive emitted by Electron Builder. */
export function packagedApplicationArchivePath(context) {
  if (context.electronPlatformName === 'darwin') {
    const appName = context.packager.appInfo.productFilename
    return join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'app.asar')
  }
  return join(context.appOutDir, 'resources', 'app.asar')
}

/** Return the Electron executable inside a packaged macOS application. */
export function packagedMacApplicationExecutablePath(context) {
  const appName = context.packager.appInfo.productFilename
  return join(context.appOutDir, `${appName}.app`, 'Contents', 'MacOS', appName)
}

/**
 * Load the ABI-sensitive session lock addon with the packaged Electron binary.
 * DSH alpha.1 introduced fs-ext; compiling it with the workspace Node ABI lets
 * every unit test pass but makes the signed desktop app fail on first launch.
 * Keep this as a verification-only afterPack check so no bundle bytes change
 * after Electron Builder performs its native dependency rebuild.
 */
export function verifyPackagedMacNativeModuleAbi(context, run = spawnSync) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const executable = packagedMacApplicationExecutablePath(context)
  const modulePath = join(
    context.appOutDir,
    `${appName}.app`,
    'Contents',
    'Resources',
    'app.asar',
    'node_modules',
    'fs-ext',
  )
  const result = run(executable, [
    '-e',
    'require(process.argv[1])',
    modulePath,
  ], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    throw new Error(`Packaged macOS native module ABI check failed: ${detail}`)
  }
}

/** Verify the copied frozen Keychain broker without modifying the App bundle. */
export function verifyPackagedMacCredentialBroker(context, run = spawnSync) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const verifier = join(import.meta.dirname, 'verify-final-macos-application.ts')
  const expectedArch = context.arch === 3 ? 'arm64' : context.arch === 1 ? 'x64' : undefined
  if (expectedArch === undefined) {
    throw new Error(`unsupported packaged macOS architecture: ${String(context.arch)}`)
  }
  const result = run(process.execPath, [
    '--import',
    'tsx/esm',
    verifier,
    '--app',
    join(context.appOutDir, `${appName}.app`),
    '--arch',
    expectedArch,
    '--broker-only',
  ], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    throw new Error(`Packaged macOS credential broker check failed: ${detail}`)
  }
}

/**
 * Reject unexpected application roots or an oversized packaged payload before
 * distributable targets exist.
 */
export function verifyPackagedApplicationArchive(asarPath, maxBytes = MAX_PACKAGED_ASAR_BYTES) {
  if (!existsSync(asarPath)) throw new Error(`Packaged application archive is missing: ${asarPath}`)

  const physicalByteSize = statSync(asarPath).size
  if (physicalByteSize > maxBytes) {
    throw new Error(
      `Packaged application archive is unexpectedly large: ${physicalByteSize} bytes exceeds ${maxBytes}`,
    )
  }

  const header = getRawHeader(asarPath).header
  let logicalByteSize = 0
  const forbiddenDevelopmentPayloads = []
  const countBytes = (node, parent = '') => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = parent === '' ? name : `${parent}/${name}`
      if (entry.files) countBytes(entry, path)
      else {
        logicalByteSize += Number(entry.size ?? 0)
        const segments = path.split('/')
        if (path.endsWith('.map') || path.endsWith('.tsbuildinfo')
          || segments.includes('output') || segments.includes('coverage')) {
          forbiddenDevelopmentPayloads.push(path)
        }
      }
    }
  }
  countBytes(header)
  if (logicalByteSize > maxBytes) {
    throw new Error(
      `Packaged application payload is unexpectedly large: ${logicalByteSize} bytes exceeds ${maxBytes}`,
    )
  }

  const allowedTopLevelEntries = new Set(['dist', 'node_modules', 'package.json'])
  const unexpectedEntries = Object.keys(header.files ?? {})
    .filter(name => !allowedTopLevelEntries.has(name))
  if (unexpectedEntries.length > 0) {
    throw new Error(
      `Packaged application archive contains unexpected top-level entries: ${unexpectedEntries.join(', ')}`,
    )
  }
  if (forbiddenDevelopmentPayloads.length > 0) {
    throw new Error(
      `Packaged application archive contains development payloads: ${forbiddenDevelopmentPayloads.slice(0, 5).join(', ')}`,
    )
  }

  verifyPackagedWorkspacePeerClosure(asarPath, header)
}

/**
 * Check required workspace peers against the archive Electron Builder actually
 * produced. pnpm satisfies peers in the development workspace, but Electron
 * Builder only copies peers named by the desktop deployment root.
 */
export function verifyPackagedWorkspacePeerClosure(asarPath, header = getRawHeader(asarPath).header) {
  const nodeModules = header.files?.node_modules?.files ?? {}
  const packageNames = new Set()
  for (const [name, entry] of Object.entries(nodeModules)) {
    if (name.startsWith('@')) {
      for (const child of Object.keys(entry.files ?? {})) packageNames.add(`${name}/${child}`)
    } else {
      packageNames.add(name)
    }
  }

  const missing = []
  const rootManifest = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'))
  const rootName = rootManifest.name ?? 'desktop'
  for (const dependency of Object.keys(rootManifest.dependencies ?? {}).sort()) {
    // 旧版 Word 读取器由 Electron 子进程从应用根 node_modules 解析。
    // 因此所有直接运行时依赖都必须进入最终 ASAR，不能只检查 workspace 包。
    if (!packageNames.has(dependency)) missing.push(`${rootName} -> ${dependency}`)
  }

  for (const owner of [...packageNames].sort()) {
    if (!PRODUCT_WORKSPACE_SCOPES.has(owner.split('/')[0])) continue
    const manifest = JSON.parse(
      extractFile(asarPath, packagedNodeModuleManifestPath(owner)).toString('utf8'),
    )
    for (const peer of Object.keys(manifest.peerDependencies ?? {}).sort()) {
      if (!PRODUCT_WORKSPACE_SCOPES.has(peer.split('/')[0])) continue
      if (manifest.peerDependenciesMeta?.[peer]?.optional === true) continue
      if (!packageNames.has(peer)) missing.push(`${owner} -> ${peer}`)
    }
  }
  if (missing.length > 0) {
    throw new Error(`Packaged application archive is missing required workspace peers: ${missing.join(', ')}`)
  }
}

/** Build the host-native path separator expected by @electron/asar. */
export function packagedNodeModuleManifestPath(packageName, pathJoin = join) {
  return pathJoin('node_modules', ...packageName.split('/'), 'package.json')
}

/**
 * Keep Electron Builder's native-module smart unpacking from shipping the
 * unused ARM64 ConPTY helper in the Windows x64 application. The generated
 * copy is moved beside the package output for auditability instead of being
 * permanently deleted.
 */
export function quarantineUnusedWindowsConpty(context) {
  if (context.electronPlatformName !== 'win32') return []

  const conptyRoot = join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'third_party',
    'conpty',
  )
  if (!existsSync(conptyRoot)) return []

  const quarantineRoot = join(
    context.outDir,
    'packaging-quarantine',
    `${Date.now()}-${process.pid}`,
  )
  const quarantined = []
  for (const versionEntry of readdirSync(conptyRoot, { withFileTypes: true })) {
    if (!versionEntry.isDirectory()) continue
    const source = join(conptyRoot, versionEntry.name, 'win10-arm64')
    if (!existsSync(source)) continue
    const destination = join(quarantineRoot, versionEntry.name, 'win10-arm64')
    mkdirSync(join(quarantineRoot, versionEntry.name), { recursive: true })
    renameSync(source, destination)
    quarantined.push(destination)
  }
  if (quarantined.length > 0) {
    console.log(`Quarantined unused Windows ARM64 ConPTY payload: ${quarantined.join(', ')}`)
  }
  return quarantined
}

/**
 * Verify packaged content before Electron Builder flips fuses and performs its
 * final native signing step. Never modify a macOS bundle here: DMG and ZIP must
 * be created from the exact app sealed by `mac.identity: "-"`.
 */
export default async function verifyPackagedApplication(context) {
  verifyPackagedApplicationArchive(packagedApplicationArchivePath(context))
  verifyPackagedMacNativeModuleAbi(context)
  verifyPackagedMacCredentialBroker(context)
  quarantineUnusedWindowsConpty(context)
}
