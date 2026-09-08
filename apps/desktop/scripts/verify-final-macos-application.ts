/** Verify immutable product payloads after Electron Builder's final macOS signing pass. */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyMacRuntimeCodeSignatures } from '../../../product/gongchuang-client/scripts/macos-runtime-code-signing.ts'
import { verifyProductRuntime } from '../../../product/gongchuang-client/src/product-runtime-verifier.ts'
import { verifyStagedSkillSuite } from '../../../product/gongchuang-client/src/skill-suite-verifier.ts'
import { PRODUCT_TRUST_ANCHORS } from '../../../product/gongchuang-client/src/trust-anchors.ts'
import {
  GONGCHUANG_CLIENT_VERSION,
  GONGCHUANG_SKILL_BUNDLE_VERSION,
} from '../../../product/gongchuang-client/src/product-version.ts'

type MacArchitecture = 'arm64' | 'x64'

interface CredentialBrokerManifest {
  readonly schemaVersion: 1
  readonly sourceSha256: string
  readonly artifacts: Record<MacArchitecture, {
    readonly sha256: string
    readonly cdhash: string
  }>
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const CDHASH_PATTERN = /^[a-f0-9]{40}$/u

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function exactRegularFile(path: string, label: string): void {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symbolic-link regular file`)
  }
}

function parseCredentialBrokerManifest(path: string): CredentialBrokerManifest {
  exactRegularFile(path, 'macOS credential broker manifest')
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CredentialBrokerManifest>
  if (parsed.schemaVersion !== 1 || !SHA256_PATTERN.test(parsed.sourceSha256 ?? '')) {
    throw new Error('macOS credential broker manifest has an invalid schema or source digest')
  }
  for (const architecture of ['arm64', 'x64'] as const) {
    const artifact = parsed.artifacts?.[architecture]
    if (!SHA256_PATTERN.test(artifact?.sha256 ?? '') || !CDHASH_PATTERN.test(artifact?.cdhash ?? '')) {
      throw new Error(`macOS credential broker manifest has an invalid ${architecture} artifact`)
    }
  }
  return parsed as CredentialBrokerManifest
}

function executableArchitecture(path: string, expectedArch: MacArchitecture): void {
  const expectedNativeArch = expectedArch === 'x64' ? 'x86_64' : 'arm64'
  const actualArchitectures = execFileSync('/usr/bin/lipo', ['-archs', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().split(/\s+/u).filter(Boolean)
  if (actualArchitectures.length !== 1 || actualArchitectures[0] !== expectedNativeArch) {
    throw new Error(`final macOS executable architecture is ${actualArchitectures.join(',') || 'unknown'}, expected ${expectedNativeArch}`)
  }
}

function executableCdHash(path: string): string {
  const result = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`macOS credential broker signature details could not be read: ${String(result.stderr).trim()}`)
  }
  const match = /^CDHash=([a-f0-9]{40})$/mu.exec(String(result.stderr))
  if (match?.[1] === undefined) throw new Error('macOS credential broker signature has no SHA-256 CDHash')
  return match[1]
}

/** Verify the frozen broker copied into a macOS App before or after final signing. */
export function verifyMacCredentialBroker(appPath: string, expectedArch: MacArchitecture): {
  readonly sha256: string
  readonly cdhash: string
} {
  const credentialsRoot = join(resolve(appPath), 'Contents', 'Resources', 'product', 'credentials')
  const brokerPath = join(credentialsRoot, 'gongchuang-credential-broker')
  const manifest = parseCredentialBrokerManifest(join(credentialsRoot, 'manifest.json'))
  exactRegularFile(brokerPath, 'macOS credential broker')
  if ((lstatSync(brokerPath).mode & 0o111) === 0) {
    throw new Error('macOS credential broker is not executable')
  }
  executableArchitecture(brokerPath, expectedArch)
  const expected = manifest.artifacts[expectedArch]
  const sha256 = sha256File(brokerPath)
  if (sha256 !== expected.sha256) {
    throw new Error(`macOS credential broker SHA-256 mismatch: ${sha256}`)
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', brokerPath], { stdio: 'pipe' })
  const cdhash = executableCdHash(brokerPath)
  if (cdhash !== expected.cdhash) {
    throw new Error(`macOS credential broker CDHash mismatch: ${cdhash}`)
  }
  return { sha256, cdhash }
}

/** Verify checked-in source, both prebuilt architectures, and their signed identities. */
export function verifyMacCredentialBrokerInputs(desktopRoot: string): CredentialBrokerManifest {
  const nativeRoot = join(resolve(desktopRoot), 'native-credentials')
  const manifest = parseCredentialBrokerManifest(join(nativeRoot, 'manifest.json'))
  const sourcePath = join(resolve(desktopRoot), 'native-src', 'credential-broker.swift')
  exactRegularFile(sourcePath, 'macOS credential broker source')
  if (sha256File(sourcePath) !== manifest.sourceSha256) {
    throw new Error('macOS credential broker source SHA-256 does not match its manifest')
  }
  for (const architecture of ['arm64', 'x64'] as const) {
    const brokerPath = join(nativeRoot, `mac-${architecture}`, 'gongchuang-credential-broker')
    exactRegularFile(brokerPath, `macOS ${architecture} credential broker`)
    if ((lstatSync(brokerPath).mode & 0o111) === 0) {
      throw new Error(`macOS ${architecture} credential broker is not executable`)
    }
    executableArchitecture(brokerPath, architecture)
    if (sha256File(brokerPath) !== manifest.artifacts[architecture].sha256) {
      throw new Error(`macOS ${architecture} credential broker SHA-256 does not match its manifest`)
    }
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', brokerPath], { stdio: 'pipe' })
    if (executableCdHash(brokerPath) !== manifest.artifacts[architecture].cdhash) {
      throw new Error(`macOS ${architecture} credential broker CDHash does not match its manifest`)
    }
  }
  return manifest
}

/**
 * Verify the final App signature and both embedded signed product trees.
 *
 * Electron Builder must not rewrite files authenticated by the runtime index.
 * This check runs after native signing but before DMG or ZIP targets are made,
 * so a signing-order regression cannot become a distributable.
 *
 * @param appPath - Final macOS application bundle emitted by Electron Builder.
 * @param expectedArch - Architecture selected by this Electron Builder target.
 * @returns Verified runtime and skill identities for the build log.
 */
export function verifyFinalMacApplication(appPath: string, expectedArch: MacArchitecture): {
  readonly runtimeIndexSha256: string
  readonly skillIndexSha256: string
} {
  const resolvedApp = resolve(appPath)
  const appInfo = lstatSync(resolvedApp)
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) {
    throw new Error('final macOS application must be a non-symbolic-link directory')
  }

  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', resolvedApp], {
    stdio: 'pipe',
  })

  const executableName = execFileSync('/usr/bin/plutil', [
    '-extract',
    'CFBundleExecutable',
    'raw',
    '-o',
    '-',
    join(resolvedApp, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8' }).trim()
  if (executableName === '' || executableName.includes('/') || executableName.includes('\\')) {
    throw new Error('final macOS application contains an invalid executable name')
  }
  executableArchitecture(join(resolvedApp, 'Contents', 'MacOS', executableName), expectedArch)

  const productRoot = join(resolvedApp, 'Contents', 'Resources', 'product')
  const runtimeRoot = join(productRoot, 'runtime')

  verifyMacCredentialBroker(resolvedApp, expectedArch)

  const runtime = verifyProductRuntime(runtimeRoot, {
    expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.runtimePublicKeySha256,
    expectedSigningTier: PRODUCT_TRUST_ANCHORS.runtimeSigningTier,
    expectedPlatform: 'darwin',
    expectedArch,
    expectedClientVersion: GONGCHUANG_CLIENT_VERSION,
  })
  const skills = verifyStagedSkillSuite(join(productRoot, 'skill-suite'), {
    expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.skillBundlePublicKeySha256,
    expectedSigningTier: PRODUCT_TRUST_ANCHORS.skillBundleSigningTier,
  })
  if (skills.version !== GONGCHUANG_SKILL_BUNDLE_VERSION) {
    throw new Error('final macOS application contains an unexpected skill suite identity')
  }
  executableArchitecture(runtime.pythonExecutable, expectedArch)
  verifyMacRuntimeCodeSignatures(runtime.filesRoot, Object.keys(runtime.fileHashes))

  return {
    runtimeIndexSha256: runtime.indexSha256,
    skillIndexSha256: skills.indexSha256,
  }
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const appOffset = process.argv.indexOf('--app')
  const appPath = appOffset === -1 ? undefined : process.argv[appOffset + 1]
  const archOffset = process.argv.indexOf('--arch')
  const expectedArch = archOffset === -1 ? undefined : process.argv[archOffset + 1]
  if (appPath === undefined || appPath.trim() === ''
    || (expectedArch !== 'arm64' && expectedArch !== 'x64')) {
    throw new Error('usage: verify-final-macos-application.ts --app <application.app> --arch <arm64|x64>')
  }
  const brokerOnly = process.argv.includes('--broker-only')
  process.stdout.write(`${JSON.stringify(brokerOnly
    ? verifyMacCredentialBroker(appPath, expectedArch)
    : verifyFinalMacApplication(appPath, expectedArch))}\n`)
}
