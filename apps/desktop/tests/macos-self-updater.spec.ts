import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, type WriteStream,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  macApplicationPath, MacSelfUpdaterController, verifyMacDesktopUpdateManifest,
  verifyMacTransitionSource, type MacDesktopUpdateArtifact,
} from '../src/macos-self-updater.ts'
import {
  applyMacUpdate, beginMacUpdateLaunch, beginMacUpdateRecovery, commitMacUpdateLaunch,
  macUpdateLaunchEnvironment, macUpdateProcessIdentity, macUpdateTerminalCleanupPaths, waitForMacUpdateHelperHandoff,
  waitForMacUpdateHelperReady, type MacUpdateLaunchHandle,
} from '../src/macos-update-helper.ts'

const TRANSACTION_ID = '123e4567-e89b-42d3-a456-426614174000'
const RETRY_TRANSACTION_ID = '223e4567-e89b-42d3-a456-426614174001'

async function waitForPersistedUpdatePrefix(
  updateRoot: string,
  fileName: string,
  minimumBytes: number,
): Promise<void> {
  const downloadsRoot = join(updateRoot, 'downloads')
  for (let elapsed = 0; elapsed < 5_000; elapsed += 5) {
    if (existsSync(downloadsRoot)) {
      const persisted = readdirSync(downloadsRoot).some((name) => {
        const partial = join(downloadsRoot, name, `${fileName}.partial`)
        return existsSync(partial) && statSync(partial).size >= minimumBytes
      })
      if (persisted) return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
  }
  throw new Error(`test fixture did not persist the ${String(minimumBytes)}-byte update prefix`)
}

async function simulateSafeApplicationReplacement(
  current: string,
  replacement: string,
  backup: string,
): Promise<void> {
  renameSync(current, backup)
  renameSync(replacement, current)
}

function simulatedCurrentProcessIdentity() {
  return Object.freeze({
    pid: process.pid,
    executablePath: '/Applications/洞见.app/Contents/MacOS/洞见',
    startedAt: 'Sun Aug 30 10:00:00 2026',
  })
}

function signedManifest(
  version = '0.1.4',
  archive = Buffer.from('authenticated-mac-update'),
  signingPair?: { readonly privateKey: KeyObject; readonly publicKey: KeyObject },
) {
  const pair = signingPair ?? generateKeyPairSync('ed25519')
  const publicKey = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' }))
  const artifact = {
    architecture: 'arm64',
    archiveUrl: `./Dongjian-${version}-mac-arm64.zip`,
    bundleId: 'cn.dongjian.desktop',
    fileName: `Dongjian-${version}-mac-arm64.zip`,
    runtimeIndexSha256: '1'.repeat(64),
    sha256: createHash('sha256').update(archive).digest('hex'),
    sizeBytes: archive.length,
    skillBundleIndexSha256: '2'.repeat(64),
  } as const
  const bytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    productId: 'cn.dongjian.desktop',
    clientVersion: version,
    publishedAt: '2026-08-20T12:00:00.000Z',
    signingTier: 'development-candidate',
    sourceCommit: 'a'.repeat(40),
    artifacts: [artifact],
  }, null, 2)}\n`)
  return {
    archive,
    artifact,
    bytes,
    publicKey,
    publicKeySha256: createHash('sha256').update(publicKey).digest('hex'),
    signature: sign(null, bytes, pair.privateKey).toString('base64'),
    signingPair: pair,
  }
}

function signedManifestFetch(
  fixture: ReturnType<typeof signedManifest>,
  manifestUrl: string,
): typeof fetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === manifestUrl) return new Response(fixture.bytes, { status: 200 })
    if (url.endsWith('.sig')) return new Response(fixture.signature, { status: 200 })
    return new Response(fixture.archive, {
      status: 200,
      headers: { 'content-length': String(fixture.archive.length) },
    })
  }
}

describe('self-managed macOS updater', () => {
  it('does not leak detached-helper mode into the relaunched GUI application', () => {
    expect(macUpdateLaunchEnvironment({
      ELECTRON_RUN_AS_NODE: '1',
      GONGCHUANG_UPDATE_HELPER: '1',
      GONGCHUANG_ACCEPTANCE_MODE: '1',
      PATH: '/usr/bin',
    })).toEqual({
      GONGCHUANG_ACCEPTANCE_MODE: '1',
      PATH: '/usr/bin',
    })
    expect(macUpdateLaunchEnvironment({}, TRANSACTION_ID)).toEqual({
      GONGCHUANG_UPDATE_TRANSACTION_ID: TRANSACTION_ID,
    })
  })

  it('derives the app bundle rather than its Applications parent from the packaged executable', () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-app-path-'))
    const appPath = join(root, '洞见.app')
    const executable = join(appPath, 'Contents', 'MacOS', '洞见')
    mkdirSync(dirname(executable), { recursive: true })
    expect(macApplicationPath(executable)).toBe(appPath)
  })

  it('admits only an exact single-architecture V0.1.4 source application for transition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-transition-source-'))
    const appPath = join(root, '洞见.app')
    mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true })
    const runProgram = vi.fn(async () => undefined)
    const runProgramOutput = vi.fn(async (_executable: string, argumentsValue: readonly string[]) => {
      const field = argumentsValue[1]
      if (field === 'CFBundleIdentifier') return 'cn.dongjian.desktop\n'
      if (field === 'CFBundleShortVersionString') return '0.1.4\n'
      if (field === 'CFBundleExecutable') return '洞见\n'
      return 'arm64\n'
    })
    await expect(verifyMacTransitionSource(appPath, '0.1.4', runProgram, runProgramOutput))
      .resolves.toBe('arm64')
    expect(runProgram).toHaveBeenCalledWith('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
    await expect(verifyMacTransitionSource(appPath, '0.2.0', runProgram, runProgramOutput))
      .rejects.toThrow('不是可过渡')
  })

  it('accepts only an exact Ed25519-signed release manifest from the pinned publisher', () => {
    const fixture = signedManifest()
    const verified = verifyMacDesktopUpdateManifest(
      fixture.bytes,
      fixture.signature,
      fixture.publicKey,
      new URL('https://zshjiaotang.cn/client-updates/desktop-release-index.json'),
      fixture.publicKeySha256,
      'development-candidate',
    )
    expect(verified).toMatchObject({ clientVersion: '0.1.4', sourceCommit: 'a'.repeat(40) })
    expect(() => verifyMacDesktopUpdateManifest(
      Buffer.concat([fixture.bytes, Buffer.from(' ')]),
      fixture.signature,
      fixture.publicKey,
      new URL('https://zshjiaotang.cn/client-updates/desktop-release-index.json'),
      fixture.publicKeySha256,
      'development-candidate',
    )).toThrow(/Ed25519/u)
  })

  it('streams the signed archive, verifies the staged app, then starts the helper only after shutdown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-self-update-'))
    const currentApp = join(root, '洞见.app')
    const userData = join(root, 'user-data')
    const updateRoot = join(userData, 'desktop-updates')
    mkdirSync(currentApp)
    mkdirSync(userData)
    const credentialStore = join(userData, 'credentials.secure.v1.json')
    const workspaceSettings = join(userData, 'enterprise-workspace-root.json')
    const partitionState = join(userData, 'Partitions', 'gongchuang-v0.1', 'acceptance-state')
    const workspaceState = join(userData, 'runtime', 'storages', 'workspace.json')
    const sessionState = join(userData, 'runtime', 'sessions', 'acceptance-session.jsonl')
    for (const path of [partitionState, workspaceState, sessionState]) mkdirSync(dirname(path), { recursive: true })
    writeFileSync(credentialStore, JSON.stringify({
      version: 1,
      entries: {
        GONGCHUANG_ACCOUNT_TOKEN: 'Y2lwaGVydGV4dA==',
        GONGCHUANG_ACCOUNT_USERNAME: 'Y2lwaGVydGV4dA==',
        GONGCHUANG_ACCOUNT_PASSWORD: 'Y2lwaGVydGV4dA==',
        GONGCHUANG_ACCOUNT_DEVICE_ID: 'Y2lwaGVydGV4dA==',
      },
    }))
    writeFileSync(workspaceSettings, '{"schemaVersion":1,"rootPath":"/tmp/enterprise","selection":"custom"}\n')
    writeFileSync(partitionState, 'persist:gongchuang-v0.1\n')
    writeFileSync(workspaceState, '{"workspaceCount":7,"archivedWorkspaceCount":1}\n')
    writeFileSync(sessionState, '{"sessionId":"retained-across-update"}\n')
    const retainedState = new Map([
      [credentialStore, readFileSync(credentialStore, 'utf8')],
      [workspaceSettings, readFileSync(workspaceSettings, 'utf8')],
      [partitionState, readFileSync(partitionState, 'utf8')],
      [workspaceState, readFileSync(workspaceState, 'utf8')],
      [sessionState, readFileSync(sessionState, 'utf8')],
    ])
    const fixture = signedManifest()
    const publicKeyPath = join(root, 'runtime-index.pub.pem')
    writeFileSync(publicKeyPath, fixture.publicKey)
    const manifestUrl = 'https://zshjiaotang.cn/client-updates/desktop-release-index.json'
    const events: string[] = []
    let jobPath = ''
    const fetchImpl = signedManifestFetch(fixture, manifestUrl)
    const runProgram = vi.fn(async (executable: string, argumentsValue: readonly string[]) => {
      if (executable === '/usr/bin/osascript') {
        expect(argumentsValue).toEqual(expect.arrayContaining(['-l', 'JavaScript', currentApp]))
        events.push('safe-replacement-preflight')
        return
      }
      expect(executable).toBe('/usr/bin/ditto')
      if (argumentsValue[0] === '-x') {
        mkdirSync(join(argumentsValue[3] ?? '', '洞见.app'), { recursive: true })
      } else {
        mkdirSync(argumentsValue[1] ?? '', { recursive: true })
      }
    })
    const verifyApplication = vi.fn(async (
      _path: string,
      expected: MacDesktopUpdateArtifact,
      version: string,
    ) => ({
      architecture: expected.architecture,
      bundleId: expected.bundleId,
      runtimeIndexSha256: expected.runtimeIndexSha256,
      skillBundleIndexSha256: expected.skillBundleIndexSha256,
      version,
    }))
    const controller = new MacSelfUpdaterController({
      architecture: 'arm64',
      currentAppPath: currentApp,
      currentVersion: '0.1.3',
      requiredTargetVersion: '0.1.4',
      expectedManifestPublicKeySha256: fixture.publicKeySha256,
      expectedSigningTier: 'development-candidate',
      manifestPublicKeyPath: publicKeyPath,
      runtimeTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256,
        expectedSigningTier: 'development-candidate',
        expectedPlatform: 'darwin',
        expectedArch: 'arm64',
        expectedClientVersion: '0.1.3',
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256,
        expectedSigningTier: 'development-candidate',
      },
      updateRoot,
      feedUrl: manifestUrl,
      fetchImpl,
      runProgram,
      verifyApplication,
      startInstallHelper: async (value) => {
        events.push('helper')
        jobPath = value
      },
    })
    await expect(controller.check()).resolves.toMatchObject({ status: 'available', latestVersion: '0.1.4' })
    await expect(controller.download()).resolves.toMatchObject({
      status: 'downloaded', latestVersion: '0.1.4',
    })
    expect(events).toEqual(['safe-replacement-preflight'])
    await expect(controller.check()).resolves.toMatchObject({ status: 'downloaded', latestVersion: '0.1.4' })
    await controller.install(async () => { events.push('shutdown') })
    expect(events).toEqual(['safe-replacement-preflight', 'shutdown', 'helper'])
    const installJob = JSON.parse(readFileSync(jobPath, 'utf8')) as Record<string, unknown>
    expect(installJob).toMatchObject({
      schemaVersion: 2, expectedVersion: '0.1.4', currentAppPath: currentApp,
      parentPid: process.pid,
    })
    expect(typeof installJob.parentExecutablePath).toBe('string')
    expect(typeof installJob.parentProcessStartedAt).toBe('string')
    for (const [path, content] of retainedState) expect(readFileSync(path, 'utf8')).toBe(content)
    expect(verifyApplication).toHaveBeenCalledTimes(2)

    events.length = 0
    await expect(controller.install(async () => {
      events.push('shutdown')
      throw new Error('runtime shutdown failed')
    })).rejects.toThrow('runtime shutdown failed')
    expect(events).toEqual(['shutdown'])
    for (const [path, content] of retainedState) expect(readFileSync(path, 'utf8')).toBe(content)
    events.length = 0
    verifyApplication.mockRejectedValueOnce(new Error('staged bundle was modified'))
    await expect(controller.install(async () => { events.push('shutdown') })).resolves.toMatchObject({ status: 'error' })
    expect(events).toEqual([])
    for (const [path, content] of retainedState) expect(readFileSync(path, 'utf8')).toBe(content)
  })

  it('coalesces concurrent download requests into one archive and helper transaction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-single-download-'))
    const currentApp = join(root, '洞见.app')
    const updateRoot = join(root, 'desktop-updates')
    mkdirSync(currentApp)
    const fixture = signedManifest('0.3.4')
    const publicKeyPath = join(root, 'runtime-index.pub.pem')
    writeFileSync(publicKeyPath, fixture.publicKey)
    const manifestUrl = 'https://zshjiaotang.cn/client-updates/desktop-release-index.json'
    let archiveRequests = 0
    const baseFetch = signedManifestFetch(fixture, manifestUrl)
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('.zip')) archiveRequests += 1
      return baseFetch(input, init)
    }
    const startInstallHelper = vi.fn(async () => undefined)
    const beforeInstall = vi.fn(async () => undefined)
    const controller = new MacSelfUpdaterController({
      architecture: 'arm64', currentAppPath: currentApp, currentVersion: '0.3.3',
      expectedManifestPublicKeySha256: fixture.publicKeySha256,
      expectedSigningTier: 'development-candidate', manifestPublicKeyPath: publicKeyPath,
      runtimeTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256, expectedSigningTier: 'development-candidate',
        expectedPlatform: 'darwin', expectedArch: 'arm64', expectedClientVersion: '0.3.3',
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256, expectedSigningTier: 'development-candidate',
      },
      updateRoot, feedUrl: manifestUrl, fetchImpl,
      runProgram: async (_executable, argumentsValue) => {
        if (argumentsValue[0] === '-x') mkdirSync(join(argumentsValue[3] ?? '', '洞见.app'), { recursive: true })
        else mkdirSync(argumentsValue[1] ?? '', { recursive: true })
      },
      verifyApplication: async (_path, expected, version) => ({
        architecture: expected.architecture, bundleId: expected.bundleId,
        runtimeIndexSha256: expected.runtimeIndexSha256,
        skillBundleIndexSha256: expected.skillBundleIndexSha256, version,
      }),
      startInstallHelper,
    })
    await controller.check()
    const first = controller.download()
    const second = controller.download()
    expect(second).toBe(first)
    await expect(first).resolves.toMatchObject({ status: 'downloaded' })
    expect(archiveRequests).toBe(1)
    expect(startInstallHelper).not.toHaveBeenCalled()
    expect(beforeInstall).not.toHaveBeenCalled()
    const install = controller.install(beforeInstall)
    expect(controller.install(beforeInstall)).toBe(install)
    await install
    expect(startInstallHelper).toHaveBeenCalledOnce()
    expect(beforeInstall).toHaveBeenCalledOnce()
  })

  it('keeps the selected artifact stable when a newer signed check resolves during its download', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-check-download-race-'))
    const currentApp = join(root, '洞见.app')
    const updateRoot = join(root, 'desktop-updates')
    mkdirSync(currentApp)
    const selected = signedManifest('0.3.4', Buffer.alloc(64 * 1024, 0x34))
    const newer = signedManifest('0.3.5', Buffer.alloc(64 * 1024, 0x35), selected.signingPair)
    const publicKeyPath = join(root, 'runtime-index.pub.pem')
    writeFileSync(publicKeyPath, selected.publicKey)
    const manifestUrl = 'https://zshjiaotang.cn/client-updates/desktop-release-index.json'
    let manifestRequests = 0
    let releaseRecheck: (() => void) | undefined
    const recheckGate = new Promise<void>((resolvePromise) => { releaseRecheck = resolvePromise })
    let releaseArchive: (() => void) | undefined
    const archiveGate = new Promise<void>((resolvePromise) => { releaseArchive = resolvePromise })
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === manifestUrl) {
        manifestRequests += 1
        if (manifestRequests === 1) return new Response(selected.bytes, { status: 200 })
        await recheckGate
        return new Response(newer.bytes, { status: 200 })
      }
      if (url.endsWith('.sig')) {
        return new Response(manifestRequests === 1 ? selected.signature : newer.signature, { status: 200 })
      }
      expect(url).toBe(new URL(selected.artifact.archiveUrl, manifestUrl).href)
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await archiveGate
          controller.enqueue(selected.archive)
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-length': String(selected.archive.length), etag: `"${selected.artifact.sha256}"` },
      })
    }
    const verifiedVersions: string[] = []
    const controller = new MacSelfUpdaterController({
      architecture: 'arm64', currentAppPath: currentApp, currentVersion: '0.3.3',
      expectedManifestPublicKeySha256: selected.publicKeySha256,
      expectedSigningTier: 'development-candidate', manifestPublicKeyPath: publicKeyPath,
      runtimeTrustAnchor: {
        expectedPublicKeySha256: selected.publicKeySha256, expectedSigningTier: 'development-candidate',
        expectedPlatform: 'darwin', expectedArch: 'arm64', expectedClientVersion: '0.3.3',
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: selected.publicKeySha256, expectedSigningTier: 'development-candidate',
      },
      updateRoot, feedUrl: manifestUrl, fetchImpl,
      runProgram: async (_executable, argumentsValue) => {
        if (argumentsValue[0] === '-x') {
          expect(existsSync(argumentsValue[2] ?? '')).toBe(true)
          mkdirSync(join(argumentsValue[3] ?? '', '洞见.app'), { recursive: true })
        } else {
          mkdirSync(argumentsValue[1] ?? '', { recursive: true })
        }
      },
      verifyApplication: async (_path, expected, version) => {
        verifiedVersions.push(version)
        return {
          architecture: expected.architecture, bundleId: expected.bundleId,
          runtimeIndexSha256: expected.runtimeIndexSha256,
          skillBundleIndexSha256: expected.skillBundleIndexSha256, version,
        }
      },
      trashItem: async () => undefined,
      startInstallHelper: async () => undefined,
    })

    await expect(controller.check()).resolves.toMatchObject({ status: 'available', latestVersion: '0.3.4' })
    const recheck = controller.check()
    const download = controller.download()
    releaseRecheck?.()
    await expect(recheck).resolves.toMatchObject({ status: 'available', latestVersion: '0.3.4' })
    releaseArchive?.()
    await expect(download).resolves.toMatchObject({ status: 'downloaded', latestVersion: '0.3.4' })
    expect(verifiedVersions).toEqual(['0.3.4'])
  })

  it('keeps the selected artifact when an in-flight recheck fails after its download starts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-failed-check-download-race-'))
    const currentApp = join(root, '洞见.app')
    const updateRoot = join(root, 'desktop-updates')
    mkdirSync(currentApp)
    const selected = signedManifest('0.3.4', Buffer.alloc(64 * 1024, 0x44))
    const publicKeyPath = join(root, 'runtime-index.pub.pem')
    writeFileSync(publicKeyPath, selected.publicKey)
    const manifestUrl = 'https://zshjiaotang.cn/client-updates/desktop-release-index.json'
    let manifestRequests = 0
    let rejectRecheck: ((reason?: unknown) => void) | undefined
    const recheckGate = new Promise<Response>((_resolvePromise, rejectPromise) => {
      rejectRecheck = rejectPromise
    })
    let releaseArchive: (() => void) | undefined
    const archiveGate = new Promise<void>((resolvePromise) => { releaseArchive = resolvePromise })
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === manifestUrl) {
        manifestRequests += 1
        return manifestRequests === 1 ? new Response(selected.bytes, { status: 200 }) : recheckGate
      }
      if (url.endsWith('.sig')) return new Response(selected.signature, { status: 200 })
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await archiveGate
          controller.enqueue(selected.archive)
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-length': String(selected.archive.length), etag: `"${selected.artifact.sha256}"` },
      })
    }
    const errors: unknown[] = []
    const controller = new MacSelfUpdaterController({
      architecture: 'arm64', currentAppPath: currentApp, currentVersion: '0.3.3',
      expectedManifestPublicKeySha256: selected.publicKeySha256,
      expectedSigningTier: 'development-candidate', manifestPublicKeyPath: publicKeyPath,
      runtimeTrustAnchor: {
        expectedPublicKeySha256: selected.publicKeySha256, expectedSigningTier: 'development-candidate',
        expectedPlatform: 'darwin', expectedArch: 'arm64', expectedClientVersion: '0.3.3',
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: selected.publicKeySha256, expectedSigningTier: 'development-candidate',
      },
      updateRoot, feedUrl: manifestUrl, fetchImpl,
      runProgram: async (_executable, argumentsValue) => {
        if (argumentsValue[0] === '-x') mkdirSync(join(argumentsValue[3] ?? '', '洞见.app'), { recursive: true })
        else mkdirSync(argumentsValue[1] ?? '', { recursive: true })
      },
      verifyApplication: async (_path, expected, version) => ({
        architecture: expected.architecture, bundleId: expected.bundleId,
        runtimeIndexSha256: expected.runtimeIndexSha256,
        skillBundleIndexSha256: expected.skillBundleIndexSha256, version,
      }),
      reportError: (error) => { errors.push(error) },
      startInstallHelper: async () => undefined,
    })

    await expect(controller.check()).resolves.toMatchObject({ status: 'available', latestVersion: '0.3.4' })
    const recheck = controller.check()
    const download = controller.download()
    rejectRecheck?.(new Error('simulated recheck network failure'))
    await expect(recheck).resolves.toMatchObject({ status: 'available', latestVersion: '0.3.4' })
    releaseArchive?.()
    await expect(download).resolves.toMatchObject({ status: 'downloaded', latestVersion: '0.3.4' })
    expect(errors).toHaveLength(1)
  })

  it('trashes only obsolete controlled download and interrupted staging directories after a signed check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-update-residue-'))
    const currentApp = join(root, '洞见.app')
    const updateRoot = join(root, 'desktop-updates')
    const downloads = join(updateRoot, 'downloads')
    const staging = join(updateRoot, 'staging')
    const transactions = join(updateRoot, 'transactions')
    const activeTransactionId = '223e4567-e89b-42d3-a456-426614174000'
    mkdirSync(currentApp)
    mkdirSync(join(downloads, 'a'.repeat(64)), { recursive: true })
    mkdirSync(join(downloads, 'unknown-owner'), { recursive: true })
    mkdirSync(join(staging, `0.3.2-${TRANSACTION_ID}`), { recursive: true })
    mkdirSync(join(staging, 'manual-notes'), { recursive: true })
    const orphanNext = join(root, `.洞见.next-${TRANSACTION_ID}.app`)
    const activeNext = join(root, `.洞见.next-${activeTransactionId}.app`)
    mkdirSync(orphanNext)
    mkdirSync(activeNext)
    mkdirSync(transactions, { recursive: true })
    writeFileSync(join(transactions, `${activeTransactionId}.state.json`), `${JSON.stringify({
      schemaVersion: 1,
      transactionId: activeTransactionId,
      status: 'waiting',
      expectedVersion: '0.3.4',
    })}\n`)
    const fixture = signedManifest('0.3.4')
    const publicKeyPath = join(root, 'runtime-index.pub.pem')
    writeFileSync(publicKeyPath, fixture.publicKey)
    const manifestUrl = 'https://zshjiaotang.cn/client-updates/desktop-release-index.json'
    const trashed: string[] = []
    const controller = new MacSelfUpdaterController({
      architecture: 'arm64', currentAppPath: currentApp, currentVersion: '0.3.3',
      expectedManifestPublicKeySha256: fixture.publicKeySha256,
      expectedSigningTier: 'development-candidate', manifestPublicKeyPath: publicKeyPath,
      runtimeTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256, expectedSigningTier: 'development-candidate',
        expectedPlatform: 'darwin', expectedArch: 'arm64', expectedClientVersion: '0.3.3',
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256, expectedSigningTier: 'development-candidate',
      },
      updateRoot, feedUrl: manifestUrl, fetchImpl: signedManifestFetch(fixture, manifestUrl),
      trashItem: async (path) => { trashed.push(path) }, startInstallHelper: async () => undefined,
    })
    await expect(controller.check()).resolves.toMatchObject({ status: 'available' })
    expect(trashed).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/downloads\/a{64}\.retired-[0-9a-f-]{36}$/u),
      join(staging, `0.3.2-${TRANSACTION_ID}`),
      orphanNext,
    ]))
    expect(trashed).not.toContain(join(downloads, 'unknown-owner'))
    expect(trashed).not.toContain(join(staging, 'manual-notes'))
    expect(trashed).not.toContain(activeNext)
    expect(readdirSync(downloads)).toContain('unknown-owner')
  })

  it('cleans every controlled download identity when the signed manifest is already current', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-current-residue-'))
    const currentApp = join(root, '洞见.app')
    const updateRoot = join(root, 'desktop-updates')
    const downloads = join(updateRoot, 'downloads')
    const staging = join(updateRoot, 'staging')
    const transactions = join(updateRoot, 'transactions')
    const activeTransactionId = '323e4567-e89b-42d3-a456-426614174000'
    mkdirSync(currentApp)
    mkdirSync(join(downloads, 'b'.repeat(64)), { recursive: true })
    mkdirSync(join(downloads, 'unknown-owner'), { recursive: true })
    mkdirSync(join(staging, `0.3.4-${TRANSACTION_ID}`), { recursive: true })
    mkdirSync(join(staging, 'manual-notes'), { recursive: true })
    const orphanNext = join(root, `.洞见.next-${TRANSACTION_ID}.app`)
    const activeNext = join(root, `.洞见.next-${activeTransactionId}.app`)
    mkdirSync(orphanNext)
    mkdirSync(activeNext)
    mkdirSync(transactions, { recursive: true })
    writeFileSync(join(transactions, `${activeTransactionId}.state.json`), `${JSON.stringify({
      schemaVersion: 1,
      transactionId: activeTransactionId,
      status: 'waiting',
      expectedVersion: '0.3.4',
    })}\n`)
    const fixture = signedManifest('0.3.4')
    const publicKeyPath = join(root, 'runtime-index.pub.pem')
    writeFileSync(publicKeyPath, fixture.publicKey)
    const manifestUrl = 'https://zshjiaotang.cn/client-updates/desktop-release-index.json'
    const trashed: string[] = []
    const controller = new MacSelfUpdaterController({
      architecture: 'arm64', currentAppPath: currentApp, currentVersion: '0.3.4',
      expectedManifestPublicKeySha256: fixture.publicKeySha256,
      expectedSigningTier: 'development-candidate', manifestPublicKeyPath: publicKeyPath,
      runtimeTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256, expectedSigningTier: 'development-candidate',
        expectedPlatform: 'darwin', expectedArch: 'arm64', expectedClientVersion: '0.3.4',
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256, expectedSigningTier: 'development-candidate',
      },
      updateRoot, feedUrl: manifestUrl, fetchImpl: signedManifestFetch(fixture, manifestUrl),
      trashItem: async (path) => { trashed.push(path) }, startInstallHelper: async () => undefined,
    })

    await expect(controller.check()).resolves.toMatchObject({ status: 'current', latestVersion: '0.3.4' })
    expect(trashed).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/downloads\/b{64}\.retired-[0-9a-f-]{36}$/u),
      join(staging, `0.3.4-${TRANSACTION_ID}`),
      orphanNext,
    ]))
    expect(trashed).not.toContain(join(downloads, 'unknown-owner'))
    expect(trashed).not.toContain(join(staging, 'manual-notes'))
    expect(trashed).not.toContain(activeNext)
  })

  it('resumes a throttled interrupted archive after a controller restart with exact Range identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-resume-update-'))
    const currentApp = join(root, '洞见.app')
    const updateRoot = join(root, 'user-data', 'desktop-updates')
    mkdirSync(currentApp, { recursive: true })
    const archive = Buffer.alloc(256 * 1024, 0x5a)
    const fixture = signedManifest('0.3.4', archive)
    const publicKeyPath = join(root, 'runtime-index.pub.pem')
    writeFileSync(publicKeyPath, fixture.publicKey)
    const manifestUrl = 'https://zshjiaotang.cn/client-updates/v0.2/macos/desktop-release-index.json'
    const etag = `"${fixture.artifact.sha256}"`
    let archiveRequest = 0
    let resumedOffset = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === manifestUrl) return new Response(fixture.bytes, { status: 200 })
      if (url.endsWith('.sig')) return new Response(fixture.signature, { status: 200 })
      archiveRequest += 1
      if (archiveRequest === 1) {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(archive.subarray(0, 64 * 1024))
            // 只有前缀真实落盘后再制造断流，才能稳定覆盖断点续传而不是碰运气测调度时序。
            await waitForPersistedUpdatePrefix(updateRoot, fixture.artifact.fileName, 64 * 1024)
            controller.error(new Error('simulated slow-link interruption'))
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-length': String(archive.length), etag },
        })
      }
      const headers = new Headers(init?.headers)
      expect(headers.get('if-range')).toBe(etag)
      const range = headers.get('range')
      expect(range).toMatch(/^bytes=\d+-$/u)
      resumedOffset = Number(range?.slice('bytes='.length, -1))
      return new Response(archive.subarray(resumedOffset), {
        status: 206,
        headers: {
          'content-length': String(archive.length - resumedOffset),
          'content-range': `bytes ${String(resumedOffset)}-${String(archive.length - 1)}/${String(archive.length)}`,
          etag,
        },
      })
    }
    const events: string[] = []
    const progress: Array<{ resumedFromBytes: number; percent: number }> = []
    const createController = () => new MacSelfUpdaterController({
      architecture: 'arm64',
      currentAppPath: currentApp,
      currentVersion: '0.3.3',
      expectedManifestPublicKeySha256: fixture.publicKeySha256,
      expectedSigningTier: 'development-candidate',
      manifestPublicKeyPath: publicKeyPath,
      runtimeTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256,
        expectedSigningTier: 'development-candidate',
        expectedPlatform: 'darwin',
        expectedArch: 'arm64',
        expectedClientVersion: '0.3.3',
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256,
        expectedSigningTier: 'development-candidate',
      },
      updateRoot,
      feedUrl: manifestUrl,
      fetchImpl,
      runProgram: async (_executable, argumentsValue) => {
        if (argumentsValue[0] === '-x') mkdirSync(join(argumentsValue[3] ?? '', '洞见.app'), { recursive: true })
        else mkdirSync(argumentsValue[1] ?? '', { recursive: true })
      },
      verifyApplication: async (_path, expected, version) => ({
        architecture: expected.architecture,
        bundleId: expected.bundleId,
        runtimeIndexSha256: expected.runtimeIndexSha256,
        skillBundleIndexSha256: expected.skillBundleIndexSha256,
        version,
      }),
      startInstallHelper: async () => { events.push('helper') },
      reportProgress: (value) => { progress.push(value) },
    })

    const interrupted = createController()
    await interrupted.check()
    await expect(interrupted.download()).resolves.toMatchObject({
      status: 'available', latestVersion: '0.3.4', resumableBytes: 64 * 1024,
    })

    const resumed = createController()
    await expect(resumed.check()).resolves.toMatchObject({
      status: 'available', resumableBytes: 64 * 1024,
    })
    await expect(resumed.download()).resolves.toMatchObject({ status: 'downloaded', latestVersion: '0.3.4' })
    expect(archiveRequest).toBe(2)
    expect(resumedOffset).toBeGreaterThan(0)
    expect(resumedOffset).toBeLessThan(archive.length)
    expect(progress.some(value => value.resumedFromBytes === resumedOffset && value.percent > 0)).toBe(true)
    expect(events).toEqual([])
    await resumed.install()
    expect(events).toEqual(['helper'])
  })

  it('contains an asynchronous archive disk write error instead of crashing the updater process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-write-failure-'))
    const currentApp = join(root, '洞见.app')
    const updateRoot = join(root, 'desktop-updates')
    mkdirSync(currentApp)
    const fixture = signedManifest('0.3.4', Buffer.alloc(64 * 1024, 0x4e))
    const publicKeyPath = join(root, 'runtime-index.pub.pem')
    writeFileSync(publicKeyPath, fixture.publicKey)
    const manifestUrl = 'https://zshjiaotang.cn/client-updates/desktop-release-index.json'
    const startInstallHelper = vi.fn(async () => undefined)
    const reported: unknown[] = []
    const controller = new MacSelfUpdaterController({
      architecture: 'arm64', currentAppPath: currentApp, currentVersion: '0.3.3',
      expectedManifestPublicKeySha256: fixture.publicKeySha256,
      expectedSigningTier: 'development-candidate', manifestPublicKeyPath: publicKeyPath,
      runtimeTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256, expectedSigningTier: 'development-candidate',
        expectedPlatform: 'darwin', expectedArch: 'arm64', expectedClientVersion: '0.3.3',
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256, expectedSigningTier: 'development-candidate',
      },
      updateRoot, feedUrl: manifestUrl, fetchImpl: signedManifestFetch(fixture, manifestUrl),
      createArchiveWriteStream: () => {
        const output = new Writable({
          write: (_chunk, _encoding, callback) => {
            const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
            queueMicrotask(() => { callback(error) })
          },
        })
        queueMicrotask(() => { output.emit('open', 1) })
        return output as unknown as WriteStream
      },
      runProgram: async () => undefined,
      startInstallHelper,
      reportError: (error) => { reported.push(error) },
    })
    await expect(controller.check()).resolves.toMatchObject({ status: 'available' })
    await expect(controller.download()).resolves.toMatchObject({ status: 'error', latestVersion: '0.3.4' })
    expect(reported.some(error => (
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOSPC'
    ))).toBe(true)
    expect(startInstallHelper).not.toHaveBeenCalled()
  })

  it('retires a validator-bound zero-byte partial before the next full retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-zero-prefix-'))
    const currentApp = join(root, '洞见.app')
    const updateRoot = join(root, 'user-data', 'desktop-updates')
    mkdirSync(currentApp, { recursive: true })
    const archive = Buffer.alloc(64 * 1024, 0x4d)
    const fixture = signedManifest('0.3.4', archive)
    const publicKeyPath = join(root, 'runtime-index.pub.pem')
    writeFileSync(publicKeyPath, fixture.publicKey)
    const manifestUrl = 'https://zshjiaotang.cn/client-updates/v0.2/macos/desktop-release-index.json'
    const etag = `"${fixture.artifact.sha256}"`
    let archiveRequest = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === manifestUrl) return new Response(fixture.bytes, { status: 200 })
      if (url.endsWith('.sig')) return new Response(fixture.signature, { status: 200 })
      archiveRequest += 1
      const headers = new Headers(init?.headers)
      expect(headers.get('range')).toBeNull()
      if (archiveRequest === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.error(new Error('simulated failure before first byte')) },
        }), {
          status: 200,
          headers: { 'content-length': String(archive.length), etag },
        })
      }
      return new Response(archive, {
        status: 200,
        headers: { 'content-length': String(archive.length), etag },
      })
    }
    const createController = () => new MacSelfUpdaterController({
      architecture: 'arm64', currentAppPath: currentApp, currentVersion: '0.3.3',
      expectedManifestPublicKeySha256: fixture.publicKeySha256,
      expectedSigningTier: 'development-candidate', manifestPublicKeyPath: publicKeyPath,
      runtimeTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256, expectedSigningTier: 'development-candidate',
        expectedPlatform: 'darwin', expectedArch: 'arm64', expectedClientVersion: '0.3.3',
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256, expectedSigningTier: 'development-candidate',
      },
      updateRoot, feedUrl: manifestUrl, fetchImpl,
      runProgram: async (_executable, argumentsValue) => {
        if (argumentsValue[0] === '-x') mkdirSync(join(argumentsValue[3] ?? '', '洞见.app'), { recursive: true })
        else mkdirSync(argumentsValue[1] ?? '', { recursive: true })
      },
      verifyApplication: async (_path, expected, version) => ({
        architecture: expected.architecture, bundleId: expected.bundleId,
        runtimeIndexSha256: expected.runtimeIndexSha256,
        skillBundleIndexSha256: expected.skillBundleIndexSha256, version,
      }),
      startInstallHelper: async () => undefined,
    })

    const interrupted = createController()
    await interrupted.check()
    await expect(interrupted.download()).resolves.toMatchObject({ status: 'error' })
    const retry = createController()
    await expect(retry.check()).resolves.toMatchObject({ status: 'available' })
    await expect(retry.download()).resolves.toMatchObject({ status: 'downloaded' })
    expect(archiveRequest).toBe(2)
  })

  it('retires a stale prefix when a resumed 206 contradicts its signed byte range', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-stale-range-'))
    const currentApp = join(root, '洞见.app')
    const updateRoot = join(root, 'user-data', 'desktop-updates')
    mkdirSync(currentApp, { recursive: true })
    const archive = Buffer.alloc(128 * 1024, 0x2d)
    const fixture = signedManifest('0.3.4', archive)
    const publicKeyPath = join(root, 'runtime-index.pub.pem')
    writeFileSync(publicKeyPath, fixture.publicKey)
    const manifestUrl = 'https://zshjiaotang.cn/client-updates/v0.2/macos/desktop-release-index.json'
    const etag = `"${fixture.artifact.sha256}"`
    const trashed: string[] = []
    let archiveRequest = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === manifestUrl) return new Response(fixture.bytes, { status: 200 })
      if (url.endsWith('.sig')) return new Response(fixture.signature, { status: 200 })
      archiveRequest += 1
      if (archiveRequest === 1) {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(archive.subarray(0, 32 * 1024))
            await waitForPersistedUpdatePrefix(updateRoot, fixture.artifact.fileName, 32 * 1024)
            controller.error(new Error('simulated interrupted prefix'))
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-length': String(archive.length), etag },
        })
      }
      const headers = new Headers(init?.headers)
      const range = headers.get('range')
      expect(headers.get('if-range')).toBe(etag)
      expect(range).toMatch(/^bytes=\d+-$/u)
      const offset = Number(range?.slice('bytes='.length, -1))
      return new Response(archive.subarray(offset), {
        status: 206,
        headers: {
          'content-length': String(archive.length - offset),
          'content-range': `bytes ${String(offset + 1)}-${String(archive.length - 1)}/${String(archive.length)}`,
          etag,
        },
      })
    }
    const createController = () => new MacSelfUpdaterController({
      architecture: 'arm64', currentAppPath: currentApp, currentVersion: '0.3.3',
      expectedManifestPublicKeySha256: fixture.publicKeySha256,
      expectedSigningTier: 'development-candidate', manifestPublicKeyPath: publicKeyPath,
      runtimeTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256, expectedSigningTier: 'development-candidate',
        expectedPlatform: 'darwin', expectedArch: 'arm64', expectedClientVersion: '0.3.3',
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256, expectedSigningTier: 'development-candidate',
      },
      updateRoot, feedUrl: manifestUrl, fetchImpl,
      trashItem: async (path) => { trashed.push(path) },
      startInstallHelper: async () => undefined,
    })
    const interrupted = createController()
    await interrupted.check()
    await expect(interrupted.download()).resolves.toMatchObject({ status: 'available', resumableBytes: 32 * 1024 })
    const rejected = createController()
    await rejected.check()
    await expect(rejected.download()).resolves.toMatchObject({ status: 'error' })
    const clean = createController()
    const cleanSnapshot = await clean.check()
    expect(cleanSnapshot).toMatchObject({ status: 'available' })
    expect(cleanSnapshot).not.toHaveProperty('resumableBytes')
    expect(trashed.some(path => /\/downloads\/[a-f0-9]{64}\.retired-/u.test(path))).toBe(true)
  })

  it('retires an interrupted archive immediately when the server provides no resume validator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-no-validator-'))
    const currentApp = join(root, '洞见.app')
    const updateRoot = join(root, 'user-data', 'desktop-updates')
    mkdirSync(currentApp, { recursive: true })
    const archive = Buffer.alloc(128 * 1024, 0x3c)
    const fixture = signedManifest('0.3.4', archive)
    const publicKeyPath = join(root, 'runtime-index.pub.pem')
    writeFileSync(publicKeyPath, fixture.publicKey)
    const manifestUrl = 'https://zshjiaotang.cn/client-updates/v0.2/macos/desktop-release-index.json'
    const trashed: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === manifestUrl) return new Response(fixture.bytes, { status: 200 })
      if (url.endsWith('.sig')) return new Response(fixture.signature, { status: 200 })
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(archive.subarray(0, 32 * 1024))
          controller.error(new Error('simulated no-validator interruption'))
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-length': String(archive.length) },
      })
    }
    const controller = new MacSelfUpdaterController({
      architecture: 'arm64',
      currentAppPath: currentApp,
      currentVersion: '0.3.3',
      expectedManifestPublicKeySha256: fixture.publicKeySha256,
      expectedSigningTier: 'development-candidate',
      manifestPublicKeyPath: publicKeyPath,
      runtimeTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256,
        expectedSigningTier: 'development-candidate',
        expectedPlatform: 'darwin',
        expectedArch: 'arm64',
        expectedClientVersion: '0.3.3',
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256,
        expectedSigningTier: 'development-candidate',
      },
      updateRoot,
      feedUrl: manifestUrl,
      fetchImpl,
      trashItem: async (path) => { trashed.push(path) },
      startInstallHelper: async () => undefined,
    })

    await controller.check()
    await expect(controller.download()).resolves.toMatchObject({
      status: 'error', latestVersion: '0.3.4',
    })
    expect(trashed.some(path => /\/downloads\/[a-f0-9]{64}\.retired-/u.test(path))).toBe(true)
  })

  it('reports verification failures and trashes both failed staging copies before helper handoff', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-self-update-failure-'))
    const currentApp = join(root, '洞见.app')
    const updateRoot = join(root, 'private-updates')
    mkdirSync(currentApp)
    const fixture = signedManifest('0.2.6')
    const publicKeyPath = join(root, 'runtime-index.pub.pem')
    writeFileSync(publicKeyPath, fixture.publicKey)
    const manifestUrl = 'https://zshjiaotang.cn/client-updates/v0.2/macos/desktop-release-index.json'
    const fetchImpl = signedManifestFetch(fixture, manifestUrl)
    const runProgram = vi.fn(async (_executable: string, argumentsValue: readonly string[]) => {
      if (argumentsValue[0] === '-x') {
        mkdirSync(join(argumentsValue[3] ?? '', '洞见.app'), { recursive: true })
      } else {
        mkdirSync(argumentsValue[1] ?? '', { recursive: true })
      }
    })
    const errors: unknown[] = []
    const trashed: string[] = []
    const controller = new MacSelfUpdaterController({
      architecture: 'arm64',
      currentAppPath: currentApp,
      currentVersion: '0.2.5',
      expectedManifestPublicKeySha256: fixture.publicKeySha256,
      expectedSigningTier: 'development-candidate',
      manifestPublicKeyPath: publicKeyPath,
      runtimeTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256,
        expectedSigningTier: 'development-candidate',
        expectedPlatform: 'darwin',
        expectedArch: 'arm64',
        expectedClientVersion: '0.2.5',
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256,
        expectedSigningTier: 'development-candidate',
      },
      updateRoot,
      feedUrl: manifestUrl,
      fetchImpl,
      runProgram,
      verifyApplication: async () => { throw new Error('target runtime identity mismatch') },
      startInstallHelper: async () => { throw new Error('helper must not start') },
      reportError: (error) => { errors.push(error) },
      trashItem: async (path) => { trashed.push(path) },
    })

    await expect(controller.check()).resolves.toMatchObject({ status: 'available', latestVersion: '0.2.6' })
    await expect(controller.download()).resolves.toMatchObject({ status: 'error', latestVersion: '0.2.6' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toBe('target runtime identity mismatch')
    expect(trashed).toHaveLength(3)
    expect(trashed.some(path => /\/downloads\/[a-f0-9]{64}\.retired-/u.test(path))).toBe(true)
    expect(trashed.some(path => path.includes('/staging/0.2.6-'))).toBe(true)
    expect(trashed.some(path => path.includes('/.洞见.next-'))).toBe(true)
  })

  it('admits a direct signed V0.2.0 to V0.2.3 update without intermediate releases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-skip-update-'))
    const currentApp = join(root, '洞见.app')
    mkdirSync(currentApp)
    const fixture = signedManifest('0.2.3')
    const publicKeyPath = join(root, 'runtime-index.pub.pem')
    writeFileSync(publicKeyPath, fixture.publicKey)
    const manifestUrl = 'https://zshjiaotang.cn/client-updates/v0.2/macos/desktop-release-index.json'
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return url.endsWith('.sig')
        ? new Response(fixture.signature, { status: 200 })
        : new Response(fixture.bytes, { status: 200 })
    }
    const controller = new MacSelfUpdaterController({
      architecture: 'arm64',
      currentAppPath: currentApp,
      currentVersion: '0.2.0',
      expectedManifestPublicKeySha256: fixture.publicKeySha256,
      expectedSigningTier: 'development-candidate',
      manifestPublicKeyPath: publicKeyPath,
      runtimeTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256,
        expectedSigningTier: 'development-candidate',
        expectedPlatform: 'darwin',
        expectedArch: 'arm64',
        expectedClientVersion: '0.2.0',
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256,
        expectedSigningTier: 'development-candidate',
      },
      updateRoot: join(root, 'private-updates'),
      feedUrl: manifestUrl,
      fetchImpl,
      startInstallHelper: async () => undefined,
    })

    await expect(controller.check()).resolves.toMatchObject({
      status: 'available', currentVersion: '0.2.0', latestVersion: '0.2.3',
    })
  })

  it('admits the direct signed V0.3.3 to V0.4.0 Harness migration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-v040-update-'))
    const currentApp = join(root, '洞见.app')
    mkdirSync(currentApp)
    const fixture = signedManifest('0.4.0')
    const publicKeyPath = join(root, 'runtime-index.pub.pem')
    writeFileSync(publicKeyPath, fixture.publicKey)
    const manifestUrl = 'https://zshjiaotang.cn/client-updates/v0.2/macos/desktop-release-index.json'
    const controller = new MacSelfUpdaterController({
      architecture: 'arm64',
      currentAppPath: currentApp,
      currentVersion: '0.3.3',
      expectedManifestPublicKeySha256: fixture.publicKeySha256,
      expectedSigningTier: 'development-candidate',
      manifestPublicKeyPath: publicKeyPath,
      runtimeTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256,
        expectedSigningTier: 'development-candidate',
        expectedPlatform: 'darwin',
        expectedArch: 'arm64',
        expectedClientVersion: '0.3.3',
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: fixture.publicKeySha256,
        expectedSigningTier: 'development-candidate',
      },
      updateRoot: join(root, 'private-updates'),
      feedUrl: manifestUrl,
      fetchImpl: signedManifestFetch(fixture, manifestUrl),
      startInstallHelper: async () => undefined,
    })

    await expect(controller.check()).resolves.toMatchObject({
      status: 'available', currentVersion: '0.3.3', latestVersion: '0.4.0',
    })
  })

  it('atomically swaps after parent exit and restores the pre-update app when startup never commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-helper-'))
    const transactionRoot = join(root, 'transactions')
    mkdirSync(transactionRoot)
    const currentAppPath = join(root, '洞见.app')
    const stagedAppPath = join(root, `.洞见.next-${TRANSACTION_ID}.app`)
    const backupAppPath = join(root, `.洞见.previous-${TRANSACTION_ID}.app`)
    const failedAppPath = join(root, `.洞见.failed-${TRANSACTION_ID}.app`)
    mkdirSync(currentAppPath)
    mkdirSync(stagedAppPath)
    const userData = join(root, 'user-data')
    const credentials = join(userData, 'credentials.secure.v1.json')
    const workspace = join(userData, 'runtime', 'storages', 'workspace.json')
    mkdirSync(dirname(credentials), { recursive: true })
    mkdirSync(dirname(workspace), { recursive: true })
    writeFileSync(credentials, '{"version":1,"entries":{"GONGCHUANG_ACCOUNT_TOKEN":"Y2lwaGVydGV4dA=="}}\n')
    writeFileSync(workspace, '{"workspaceCount":7,"sessionCount":4}\n')
    const credentialsBefore = readFileSync(credentials, 'utf8')
    const workspaceBefore = readFileSync(workspace, 'utf8')
    writeFileSync(join(currentAppPath, 'identity'), 'old')
    writeFileSync(join(stagedAppPath, 'identity'), 'new')
    const statePath = join(transactionRoot, `${TRANSACTION_ID}.state.json`)
    const jobPath = join(transactionRoot, `${TRANSACTION_ID}.json`)
    writeFileSync(jobPath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId: TRANSACTION_ID,
      parentPid: 999_999,
      expectedVersion: '0.1.4',
      currentAppPath,
      stagedAppPath,
      backupAppPath,
      failedAppPath,
      statePath,
    })}\n`)
    const launched: string[] = []
    await applyMacUpdate(jobPath, {
      replaceApplication: simulateSafeApplicationReplacement,
      processIsRunning: () => false,
      newLaunchTimeoutMs: 0,
      launch: async (path) => { launched.push(path) },
      stop: async () => undefined,
    })
    expect(readFileSync(join(currentAppPath, 'identity'), 'utf8')).toBe('old')
    expect(readFileSync(join(failedAppPath, 'identity'), 'utf8')).toBe('new')
    expect(readFileSync(credentials, 'utf8')).toBe(credentialsBefore)
    expect(readFileSync(workspace, 'utf8')).toBe(workspaceBefore)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ status: 'restored' })
    expect(launched).toEqual([currentAppPath, currentAppPath])
  })

  it('restores the pre-update app when Launch Services rejects the replacement after the swap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-helper-launch-failure-'))
    const transactionRoot = join(root, 'transactions')
    mkdirSync(transactionRoot)
    const currentAppPath = join(root, '洞见.app')
    const stagedAppPath = join(root, `.洞见.next-${TRANSACTION_ID}.app`)
    const backupAppPath = join(root, `.洞见.previous-${TRANSACTION_ID}.app`)
    const failedAppPath = join(root, `.洞见.failed-${TRANSACTION_ID}.app`)
    mkdirSync(currentAppPath)
    mkdirSync(stagedAppPath)
    writeFileSync(join(currentAppPath, 'identity'), 'old')
    writeFileSync(join(stagedAppPath, 'identity'), 'new')
    const statePath = join(transactionRoot, `${TRANSACTION_ID}.state.json`)
    const jobPath = join(transactionRoot, `${TRANSACTION_ID}.json`)
    writeFileSync(jobPath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId: TRANSACTION_ID,
      parentPid: 999_999,
      expectedVersion: '0.2.7',
      currentAppPath,
      stagedAppPath,
      backupAppPath,
      failedAppPath,
      statePath,
    })}\n`)
    const launched: string[] = []
    await expect(applyMacUpdate(jobPath, {
      processIsRunning: () => false,
      launch: async (path) => {
        const identity = readFileSync(join(path, 'identity'), 'utf8')
        launched.push(identity)
        if (identity === 'new') throw new Error('simulated Launch Services failure')
      },
      stop: async () => undefined,
    })).rejects.toThrow('simulated Launch Services failure')
    expect(readFileSync(join(currentAppPath, 'identity'), 'utf8')).toBe('old')
    expect(readFileSync(join(failedAppPath, 'identity'), 'utf8')).toBe('new')
    expect(existsSync(backupAppPath)).toBe(false)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      status: 'restored', error: 'simulated Launch Services failure',
    })
    expect(launched).toEqual(['new', 'old'])
  })

  it('restores the pre-update app when attempt-state persistence fails after the swap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-helper-state-failure-'))
    const transactionRoot = join(root, 'transactions')
    mkdirSync(transactionRoot)
    const currentAppPath = join(root, '洞见.app')
    const stagedAppPath = join(root, `.洞见.next-${TRANSACTION_ID}.app`)
    const backupAppPath = join(root, `.洞见.previous-${TRANSACTION_ID}.app`)
    const failedAppPath = join(root, `.洞见.failed-${TRANSACTION_ID}.app`)
    mkdirSync(currentAppPath)
    mkdirSync(stagedAppPath)
    writeFileSync(join(currentAppPath, 'identity'), 'old')
    writeFileSync(join(stagedAppPath, 'identity'), 'new')
    const statePath = join(transactionRoot, `${TRANSACTION_ID}.state.json`)
    const jobPath = join(transactionRoot, `${TRANSACTION_ID}.json`)
    writeFileSync(jobPath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId: TRANSACTION_ID,
      parentPid: 999_999,
      expectedVersion: '0.2.7',
      currentAppPath,
      stagedAppPath,
      backupAppPath,
      failedAppPath,
      statePath,
    })}\n`)
    const launched: string[] = []
    const persisted: string[] = []
    let rejectedAttempt = false
    await expect(applyMacUpdate(jobPath, {
      processIsRunning: () => false,
      persistState: (job, state) => {
        if (state.status === 'attempting' && !rejectedAttempt) {
          rejectedAttempt = true
          throw new Error('simulated attempt-state write failure')
        }
        persisted.push(state.status)
        writeFileSync(job.statePath, `${JSON.stringify(state)}\n`)
      },
      launch: async (path) => { launched.push(readFileSync(join(path, 'identity'), 'utf8')) },
      stop: async () => undefined,
    })).rejects.toThrow('simulated attempt-state write failure')
    expect(readFileSync(join(currentAppPath, 'identity'), 'utf8')).toBe('old')
    expect(readFileSync(join(failedAppPath, 'identity'), 'utf8')).toBe('new')
    expect(existsSync(backupAppPath)).toBe(false)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ status: 'restored' })
    expect(persisted).toEqual(['waiting', 'restored'])
    expect(launched).toEqual(['old'])
  })

  it('reopens the restored app even when every post-swap state write keeps failing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-helper-persistent-state-failure-'))
    const transactionRoot = join(root, 'transactions')
    mkdirSync(transactionRoot)
    const currentAppPath = join(root, '洞见.app')
    const stagedAppPath = join(root, `.洞见.next-${TRANSACTION_ID}.app`)
    const backupAppPath = join(root, `.洞见.previous-${TRANSACTION_ID}.app`)
    const failedAppPath = join(root, `.洞见.failed-${TRANSACTION_ID}.app`)
    mkdirSync(currentAppPath)
    mkdirSync(stagedAppPath)
    writeFileSync(join(currentAppPath, 'identity'), 'old')
    writeFileSync(join(stagedAppPath, 'identity'), 'new')
    const statePath = join(transactionRoot, `${TRANSACTION_ID}.state.json`)
    const jobPath = join(transactionRoot, `${TRANSACTION_ID}.json`)
    writeFileSync(jobPath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId: TRANSACTION_ID,
      parentPid: 999_999,
      expectedVersion: '0.2.7',
      currentAppPath,
      stagedAppPath,
      backupAppPath,
      failedAppPath,
      statePath,
    })}\n`)
    const launched: string[] = []
    let writes = 0
    await expect(applyMacUpdate(jobPath, {
      processIsRunning: () => false,
      persistState: (job, state) => {
        writes += 1
        if (writes > 1) throw new Error('simulated persistent state write failure')
        writeFileSync(job.statePath, `${JSON.stringify(state)}\n`)
      },
      launch: async (path) => { launched.push(readFileSync(join(path, 'identity'), 'utf8')) },
      stop: async () => undefined,
    })).rejects.toThrow('simulated persistent state write failure')
    expect(readFileSync(join(currentAppPath, 'identity'), 'utf8')).toBe('old')
    expect(readFileSync(join(failedAppPath, 'identity'), 'utf8')).toBe('new')
    expect(existsSync(backupAppPath)).toBe(false)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ status: 'waiting' })
    expect(launched).toEqual(['old'])
  })

  it('keeps the verified new app only after the new launch commits the exact transaction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-helper-commit-'))
    const transactionRoot = join(root, 'transactions')
    mkdirSync(transactionRoot)
    const currentAppPath = join(root, '洞见.app')
    const stagedAppPath = join(root, `.洞见.next-${TRANSACTION_ID}.app`)
    const backupAppPath = join(root, `.洞见.previous-${TRANSACTION_ID}.app`)
    const failedAppPath = join(root, `.洞见.failed-${TRANSACTION_ID}.app`)
    mkdirSync(currentAppPath)
    mkdirSync(stagedAppPath)
    writeFileSync(join(currentAppPath, 'identity'), 'old')
    writeFileSync(join(stagedAppPath, 'identity'), 'new')
    const statePath = join(transactionRoot, `${TRANSACTION_ID}.state.json`)
    const jobPath = join(transactionRoot, `${TRANSACTION_ID}.json`)
    writeFileSync(jobPath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId: TRANSACTION_ID,
      parentPid: 999_999,
      expectedVersion: '0.1.4',
      currentAppPath,
      stagedAppPath,
      backupAppPath,
      failedAppPath,
      statePath,
    })}\n`)
    await applyMacUpdate(jobPath, {
      replaceApplication: simulateSafeApplicationReplacement,
      processIsRunning: () => false,
      launch: async () => {
        writeFileSync(statePath, `${JSON.stringify({
          schemaVersion: 1,
          transactionId: TRANSACTION_ID,
          status: 'committed',
          expectedVersion: '0.1.4',
        })}\n`)
      },
    })
    expect(readFileSync(join(currentAppPath, 'identity'), 'utf8')).toBe('new')
    expect(readFileSync(join(backupAppPath, 'identity'), 'utf8')).toBe('old')
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ status: 'committed' })
  })

  it('does not restore when the new launch commits during liveness confirmation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-helper-commit-race-'))
    const transactionRoot = join(root, 'transactions')
    mkdirSync(transactionRoot)
    const currentAppPath = join(root, '洞见.app')
    const stagedAppPath = join(root, `.洞见.next-${TRANSACTION_ID}.app`)
    const backupAppPath = join(root, `.洞见.previous-${TRANSACTION_ID}.app`)
    const failedAppPath = join(root, `.洞见.failed-${TRANSACTION_ID}.app`)
    mkdirSync(currentAppPath)
    mkdirSync(stagedAppPath)
    writeFileSync(join(currentAppPath, 'identity'), 'old')
    writeFileSync(join(stagedAppPath, 'identity'), 'new')
    const statePath = join(transactionRoot, `${TRANSACTION_ID}.state.json`)
    const jobPath = join(transactionRoot, `${TRANSACTION_ID}.json`)
    writeFileSync(jobPath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId: TRANSACTION_ID,
      parentPid: 999_999,
      expectedVersion: '0.2.7',
      currentAppPath,
      stagedAppPath,
      backupAppPath,
      failedAppPath,
      statePath,
    })}\n`)
    let committed = false
    await applyMacUpdate(jobPath, {
      processIsRunning: () => false,
      launch: async () => {
        writeFileSync(statePath, `${JSON.stringify({
          schemaVersion: 1,
          transactionId: TRANSACTION_ID,
          status: 'attempting',
          expectedVersion: '0.2.7',
          launchedPid: 123_456,
        })}\n`)
      },
      delay: async () => {
        if (committed) return
        committed = true
        writeFileSync(statePath, `${JSON.stringify({
          schemaVersion: 1,
          transactionId: TRANSACTION_ID,
          status: 'committed',
          expectedVersion: '0.2.7',
          launchedPid: 123_456,
        })}\n`)
      },
    })
    expect(readFileSync(join(currentAppPath, 'identity'), 'utf8')).toBe('new')
    expect(existsSync(failedAppPath)).toBe(false)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ status: 'committed' })
  })

  it('commits only the matching version and current application path after full startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-commit-'))
    const updateRoot = join(root, 'desktop-updates')
    const transactionRoot = join(updateRoot, 'transactions')
    mkdirSync(transactionRoot, { recursive: true })
    const currentAppPath = join(root, '洞见.app')
    mkdirSync(currentAppPath)
    const jobPath = join(transactionRoot, `${TRANSACTION_ID}.json`)
    const statePath = join(transactionRoot, `${TRANSACTION_ID}.state.json`)
    writeFileSync(jobPath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId: TRANSACTION_ID,
      parentPid: 999_999,
      expectedVersion: '0.1.4',
      currentAppPath,
      stagedAppPath: join(root, `.洞见.next-${TRANSACTION_ID}.app`),
      backupAppPath: join(root, `.洞见.previous-${TRANSACTION_ID}.app`),
      failedAppPath: join(root, `.洞见.failed-${TRANSACTION_ID}.app`),
      statePath,
    })}\n`)
    writeFileSync(statePath, `${JSON.stringify({
      schemaVersion: 1,
      transactionId: TRANSACTION_ID,
      status: 'attempting',
      expectedVersion: '0.1.4',
    })}\n`)
    const handle = beginMacUpdateLaunch(updateRoot, '0.1.4', currentAppPath)
    expect(handle).not.toBeNull()
    if (handle === null) throw new Error('expected legacy update launch handle')
    expect(handle.status).toBe('attempting')
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      status: 'attempting', launchedPid: process.pid,
    })
    expect(commitMacUpdateLaunch(handle).cleanupPaths).toEqual([
      join(root, `.洞见.previous-${TRANSACTION_ID}.app`),
      join(updateRoot, 'staging', `0.1.4-${TRANSACTION_ID}`),
    ])
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ status: 'committed' })
    expect(dirname(jobPath)).toBe(transactionRoot)
  })

  it('lets only the schema 2 restore winner mutate the installed applications', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-decision-restore-'))
    const updateRoot = join(root, 'desktop-updates')
    const transactionRoot = join(updateRoot, 'transactions')
    mkdirSync(transactionRoot, { recursive: true })
    const currentAppPath = join(root, '洞见.app')
    const stagedAppPath = join(root, `.洞见.next-${TRANSACTION_ID}.app`)
    const backupAppPath = join(root, `.洞见.previous-${TRANSACTION_ID}.app`)
    const failedAppPath = join(root, `.洞见.failed-${TRANSACTION_ID}.app`)
    mkdirSync(currentAppPath)
    mkdirSync(stagedAppPath)
    writeFileSync(join(currentAppPath, 'identity'), 'old')
    writeFileSync(join(stagedAppPath, 'identity'), 'new')
    const statePath = join(transactionRoot, `${TRANSACTION_ID}.state.json`)
    const jobPath = join(transactionRoot, `${TRANSACTION_ID}.json`)
    writeFileSync(jobPath, `${JSON.stringify({
      schemaVersion: 2, transactionId: TRANSACTION_ID, parentPid: 999_999,
      parentExecutablePath: '/Applications/洞见.app/Contents/MacOS/洞见',
      parentProcessStartedAt: 'Sun Aug 30 09:00:00 2026',
      expectedVersion: '0.4.1', currentAppPath, stagedAppPath, backupAppPath, failedAppPath, statePath,
    })}\n`)
    let handle: MacUpdateLaunchHandle | null = null
    let rejectedCommit: unknown
    const replacements: string[][] = []
    await applyMacUpdate(jobPath, {
      replaceApplication: async (current, replacement, backup) => {
        replacements.push([current, replacement, backup])
        await simulateSafeApplicationReplacement(current, replacement, backup)
      },
      processIsRunning: () => false,
      newLaunchTimeoutMs: 0,
      launch: async () => {
        handle = beginMacUpdateLaunch(updateRoot, '0.4.1', currentAppPath, TRANSACTION_ID)
      },
      stop: async () => {
        try {
          if (handle === null) throw new Error('missing launch handle')
          commitMacUpdateLaunch(handle)
        } catch (error) {
          rejectedCommit = error
        }
      },
    })
    expect(rejectedCommit).toBeInstanceOf(Error)
    expect(String(rejectedCommit)).toContain('恢复流程')
    expect(readFileSync(join(currentAppPath, 'identity'), 'utf8')).toBe('old')
    expect(readFileSync(join(failedAppPath, 'identity'), 'utf8')).toBe('new')
    expect(JSON.parse(readFileSync(join(transactionRoot, `${TRANSACTION_ID}.decision.json`), 'utf8')))
      .toMatchObject({ status: 'restoring' })
    expect(replacements).toEqual([
      [currentAppPath, stagedAppPath, backupAppPath],
      [currentAppPath, backupAppPath, failedAppPath],
    ])
  })

  it('keeps the schema 2 replacement when the complete product launch wins commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-decision-commit-'))
    const updateRoot = join(root, 'desktop-updates')
    const transactionRoot = join(updateRoot, 'transactions')
    mkdirSync(transactionRoot, { recursive: true })
    const currentAppPath = join(root, '洞见.app')
    const stagedAppPath = join(root, `.洞见.next-${TRANSACTION_ID}.app`)
    const backupAppPath = join(root, `.洞见.previous-${TRANSACTION_ID}.app`)
    const failedAppPath = join(root, `.洞见.failed-${TRANSACTION_ID}.app`)
    mkdirSync(currentAppPath)
    mkdirSync(stagedAppPath)
    writeFileSync(join(currentAppPath, 'identity'), 'old')
    writeFileSync(join(stagedAppPath, 'identity'), 'new')
    const statePath = join(transactionRoot, `${TRANSACTION_ID}.state.json`)
    const jobPath = join(transactionRoot, `${TRANSACTION_ID}.json`)
    writeFileSync(jobPath, `${JSON.stringify({
      schemaVersion: 2, transactionId: TRANSACTION_ID, parentPid: 999_999,
      parentExecutablePath: '/Applications/洞见.app/Contents/MacOS/洞见',
      parentProcessStartedAt: 'Sun Aug 30 09:00:00 2026',
      expectedVersion: '0.4.1', currentAppPath, stagedAppPath, backupAppPath, failedAppPath, statePath,
    })}\n`)
    await applyMacUpdate(jobPath, {
      replaceApplication: simulateSafeApplicationReplacement,
      // A reused numeric PID must not keep the helper waiting after the exact
      // parent executable/start-time identity has disappeared.
      processIsRunning: () => true,
      launch: async () => {
        const handle = beginMacUpdateLaunch(updateRoot, '0.4.1', currentAppPath, TRANSACTION_ID)
        if (handle === null) throw new Error('missing launch handle')
        commitMacUpdateLaunch(handle)
      },
    })
    expect(readFileSync(join(currentAppPath, 'identity'), 'utf8')).toBe('new')
    expect(existsSync(failedAppPath)).toBe(false)
    expect(JSON.parse(readFileSync(join(transactionRoot, `${TRANSACTION_ID}.decision.json`), 'utf8')))
      .toMatchObject({ status: 'committed' })
    const staleProjection = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
    writeFileSync(statePath, `${JSON.stringify({ ...staleProjection, status: 'attempting' })}\n`)
    const stateBeforeNormalLaunch = readFileSync(statePath, 'utf8')
    expect(beginMacUpdateLaunch(updateRoot, '0.4.1', currentAppPath)).toBeNull()
    expect(readFileSync(statePath, 'utf8')).toBe(stateBeforeNormalLaunch)
    expect(macUpdateTerminalCleanupPaths(updateRoot, currentAppPath, '0.4.1')).toContain(backupAppPath)
    const resumed = beginMacUpdateLaunch(updateRoot, '0.4.1', currentAppPath, TRANSACTION_ID)
    expect(resumed?.status).toBe('committed')
    expect(resumed === null ? [] : commitMacUpdateLaunch(resumed).cleanupPaths).toContain(backupAppPath)
    expect(macUpdateTerminalCleanupPaths(updateRoot, currentAppPath, '0.4.1')).toContain(backupAppPath)
  })

  it('resumes a schema 2 restore after the prior helper exits before moving either app', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-resume-restore-'))
    const transactionRoot = join(root, 'transactions')
    mkdirSync(transactionRoot)
    const currentAppPath = join(root, '洞见.app')
    const stagedAppPath = join(root, `.洞见.next-${TRANSACTION_ID}.app`)
    const backupAppPath = join(root, `.洞见.previous-${TRANSACTION_ID}.app`)
    const failedAppPath = join(root, `.洞见.failed-${TRANSACTION_ID}.app`)
    mkdirSync(currentAppPath)
    mkdirSync(stagedAppPath)
    writeFileSync(join(currentAppPath, 'identity'), 'old')
    writeFileSync(join(stagedAppPath, 'identity'), 'new')
    const statePath = join(transactionRoot, `${TRANSACTION_ID}.state.json`)
    const jobPath = join(transactionRoot, `${TRANSACTION_ID}.json`)
    writeFileSync(jobPath, `${JSON.stringify({
      schemaVersion: 2, transactionId: TRANSACTION_ID, parentPid: 999_999,
      parentExecutablePath: '/Applications/洞见.app/Contents/MacOS/洞见',
      parentProcessStartedAt: 'Sun Aug 30 09:00:00 2026',
      expectedVersion: '0.4.1', currentAppPath, stagedAppPath, backupAppPath, failedAppPath, statePath,
    })}\n`)
    await expect(applyMacUpdate(jobPath, {
      replaceApplication: simulateSafeApplicationReplacement,
      processIsRunning: () => false,
      newLaunchTimeoutMs: 0,
      launch: async () => {
        beginMacUpdateLaunch(root, '0.4.1', currentAppPath, TRANSACTION_ID)
      },
      stop: async () => { throw new Error('simulated helper exit after restoring decision') },
    })).rejects.toThrow('simulated helper exit')
    expect(readFileSync(join(currentAppPath, 'identity'), 'utf8')).toBe('new')
    expect(readFileSync(join(backupAppPath, 'identity'), 'utf8')).toBe('old')
    const restartedTarget = beginMacUpdateLaunch(
      root, '0.4.1', currentAppPath, TRANSACTION_ID,
      {
        processIdentity: simulatedCurrentProcessIdentity,
        persistState: () => { throw new Error('simulated restoring projection failure') },
      },
    )
    expect(restartedTarget).toMatchObject({ status: 'restoring' })
    expect(restartedTarget?.stateProjectionError).toBeInstanceOf(Error)
    const relaunched: string[] = []
    const stopped = vi.fn(async () => undefined)
    await applyMacUpdate(jobPath, {
      replaceApplication: simulateSafeApplicationReplacement,
      processIsRunning: () => false,
      processMatchesLaunch: () => false,
      launch: async (path) => { relaunched.push(readFileSync(join(path, 'identity'), 'utf8')) },
      persistState: (job, state) => {
        if (state.status === 'restoring') throw new Error('simulated restoring projection failure')
        writeFileSync(job.statePath, `${JSON.stringify(state)}\n`)
      },
      stop: stopped,
    })
    expect(readFileSync(join(currentAppPath, 'identity'), 'utf8')).toBe('old')
    expect(readFileSync(join(failedAppPath, 'identity'), 'utf8')).toBe('new')
    expect(relaunched).toEqual(['old'])
    expect(stopped).not.toHaveBeenCalled()
    expect(macUpdateTerminalCleanupPaths(root, currentAppPath, '0.3.3')).toContain(failedAppPath)
  })

  it('claims recovery after target startup failure even when every recovery projection is unwritable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-startup-recovery-'))
    const transactionRoot = join(root, 'transactions')
    mkdirSync(transactionRoot)
    const currentAppPath = join(root, '洞见.app')
    const stagedAppPath = join(root, `.洞见.next-${TRANSACTION_ID}.app`)
    const backupAppPath = join(root, `.洞见.previous-${TRANSACTION_ID}.app`)
    const failedAppPath = join(root, `.洞见.failed-${TRANSACTION_ID}.app`)
    mkdirSync(currentAppPath)
    mkdirSync(backupAppPath)
    writeFileSync(join(currentAppPath, 'identity'), 'new')
    writeFileSync(join(backupAppPath, 'identity'), 'old')
    const statePath = join(transactionRoot, `${TRANSACTION_ID}.state.json`)
    const jobPath = join(transactionRoot, `${TRANSACTION_ID}.json`)
    writeFileSync(jobPath, `${JSON.stringify({
      schemaVersion: 2, transactionId: TRANSACTION_ID, parentPid: 999_999,
      parentExecutablePath: '/Applications/洞见.app/Contents/MacOS/洞见',
      parentProcessStartedAt: 'Sun Aug 30 09:00:00 2026', expectedVersion: '0.4.1',
      currentAppPath, stagedAppPath, backupAppPath, failedAppPath, statePath,
    })}\n`)
    writeFileSync(statePath, `${JSON.stringify({
      schemaVersion: 1, transactionId: TRANSACTION_ID, status: 'attempting', expectedVersion: '0.4.1',
      launchedPid: process.pid, launchedExecutablePath: simulatedCurrentProcessIdentity().executablePath,
      launchedProcessStartedAt: simulatedCurrentProcessIdentity().startedAt,
    })}\n`)
    const handle = beginMacUpdateLaunch(
      root, '0.4.1', currentAppPath, TRANSACTION_ID,
      { processIdentity: simulatedCurrentProcessIdentity },
    )
    if (handle === null) throw new Error('expected attempting launch handle')
    const recovery = beginMacUpdateRecovery(handle, 'simulated target startup failure', () => {
      throw new Error('simulated recovery projection failure')
    })
    expect(recovery.stateProjectionError).toBeInstanceOf(Error)
    expect(JSON.parse(readFileSync(join(transactionRoot, `${TRANSACTION_ID}.decision.json`), 'utf8')))
      .toMatchObject({ status: 'restoring' })
    await expect(waitForMacUpdateHelperReady(jobPath, 88, {
      mode: 'recovery', processIsRunning: () => true, timeoutMs: 250,
    })).resolves.toBeUndefined()
    const launched: string[] = []
    await expect(applyMacUpdate(jobPath, {
      replaceApplication: simulateSafeApplicationReplacement,
      processMatchesLaunch: () => false,
      persistState: () => { throw new Error('simulated recovery projection failure') },
      launch: async (path) => { launched.push(readFileSync(join(path, 'identity'), 'utf8')) },
    })).rejects.toThrow('simulated recovery projection failure')
    expect(readFileSync(join(currentAppPath, 'identity'), 'utf8')).toBe('old')
    expect(readFileSync(join(failedAppPath, 'identity'), 'utf8')).toBe('new')
    expect(launched).toEqual(['old'])
    expect(macUpdateTerminalCleanupPaths(root, currentAppPath, '0.3.3')).toContain(failedAppPath)
  })

  it('reopens the current app when the helper cannot make the first swap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-first-rename-'))
    const transactionRoot = join(root, 'transactions')
    mkdirSync(transactionRoot)
    const currentAppPath = join(root, '洞见.app')
    const stagedAppPath = join(root, `.洞见.next-${TRANSACTION_ID}.app`)
    const backupAppPath = join(root, `.洞见.previous-${TRANSACTION_ID}.app`)
    const failedAppPath = join(root, `.洞见.failed-${TRANSACTION_ID}.app`)
    mkdirSync(currentAppPath)
    mkdirSync(stagedAppPath)
    mkdirSync(backupAppPath)
    const stagingPath = join(root, 'staging', `0.4.1-${TRANSACTION_ID}`)
    mkdirSync(stagingPath, { recursive: true })
    writeFileSync(join(backupAppPath, 'blocker'), 'occupied')
    const statePath = join(transactionRoot, `${TRANSACTION_ID}.state.json`)
    const jobPath = join(transactionRoot, `${TRANSACTION_ID}.json`)
    writeFileSync(jobPath, `${JSON.stringify({
      schemaVersion: 2, transactionId: TRANSACTION_ID, parentPid: 999_999,
      parentExecutablePath: '/Applications/洞见.app/Contents/MacOS/洞见',
      parentProcessStartedAt: 'Sun Aug 30 09:00:00 2026',
      expectedVersion: '0.4.1', currentAppPath, stagedAppPath, backupAppPath, failedAppPath, statePath,
    })}\n`)
    const launched: string[] = []
    await expect(applyMacUpdate(jobPath, {
      replaceApplication: simulateSafeApplicationReplacement,
      processIsRunning: () => false,
      launch: async (path) => { launched.push(path) },
    })).rejects.toThrow()
    expect(existsSync(currentAppPath)).toBe(true)
    expect(launched).toEqual([currentAppPath])
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ status: 'failed' })
    expect(macUpdateTerminalCleanupPaths(root, currentAppPath, '0.3.3')).toEqual(expect.arrayContaining([
      stagedAppPath, stagingPath,
    ]))
  })

  it('waits for the helper waiting receipt before allowing the parent to exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-helper-ready-'))
    const transactionRoot = join(root, 'transactions')
    mkdirSync(transactionRoot)
    const currentAppPath = join(root, '洞见.app')
    const stagedAppPath = join(root, `.洞见.next-${TRANSACTION_ID}.app`)
    mkdirSync(currentAppPath)
    mkdirSync(stagedAppPath)
    const statePath = join(transactionRoot, `${TRANSACTION_ID}.state.json`)
    const jobPath = join(transactionRoot, `${TRANSACTION_ID}.json`)
    writeFileSync(jobPath, `${JSON.stringify({
      schemaVersion: 2, transactionId: TRANSACTION_ID, parentPid: 999_999,
      parentExecutablePath: '/Applications/洞见.app/Contents/MacOS/洞见',
      parentProcessStartedAt: 'Sun Aug 30 09:00:00 2026',
      expectedVersion: '0.4.1', currentAppPath,
      stagedAppPath,
      backupAppPath: join(root, `.洞见.previous-${TRANSACTION_ID}.app`),
      failedAppPath: join(root, `.洞见.failed-${TRANSACTION_ID}.app`), statePath,
    })}\n`)
    writeFileSync(statePath, `${JSON.stringify({
      schemaVersion: 1, transactionId: TRANSACTION_ID, status: 'waiting', expectedVersion: '0.4.1',
      helperPid: 88, helperExecutablePath: '/path/to/dead/helper',
      helperProcessStartedAt: 'Sun Aug 30 09:30:00 2026',
    })}\n`)
    await expect(waitForMacUpdateHelperReady(jobPath, 88, {
      processIsRunning: () => true, timeoutMs: 250,
    })).resolves.toBeUndefined()
    await expect(waitForMacUpdateHelperReady(jobPath, 88, {
      processIsRunning: () => false, timeoutMs: 250,
    })).rejects.toThrow('接管安装前退出')
    expect(macUpdateTerminalCleanupPaths(root, currentAppPath, '0.3.3')).toContain(stagedAppPath)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ status: 'failed' })
    const retryStagedAppPath = join(root, `.洞见.next-${RETRY_TRANSACTION_ID}.app`)
    const retryBackupAppPath = join(root, `.洞见.previous-${RETRY_TRANSACTION_ID}.app`)
    const retryFailedAppPath = join(root, `.洞见.failed-${RETRY_TRANSACTION_ID}.app`)
    const retryStatePath = join(transactionRoot, `${RETRY_TRANSACTION_ID}.state.json`)
    const retryJobPath = join(transactionRoot, `${RETRY_TRANSACTION_ID}.json`)
    mkdirSync(retryStagedAppPath)
    writeFileSync(retryJobPath, `${JSON.stringify({
      schemaVersion: 2, transactionId: RETRY_TRANSACTION_ID, parentPid: 999_999,
      parentExecutablePath: '/Applications/洞见.app/Contents/MacOS/洞见',
      parentProcessStartedAt: 'Sun Aug 30 09:00:00 2026', expectedVersion: '0.4.1',
      currentAppPath, stagedAppPath: retryStagedAppPath, backupAppPath: retryBackupAppPath,
      failedAppPath: retryFailedAppPath, statePath: retryStatePath,
    })}\n`)
    await applyMacUpdate(retryJobPath, {
      replaceApplication: simulateSafeApplicationReplacement,
      launch: async () => {
        const retryHandle = beginMacUpdateLaunch(root, '0.4.1', currentAppPath, RETRY_TRANSACTION_ID)
        if (retryHandle === null) throw new Error('expected retry launch handle')
        commitMacUpdateLaunch(retryHandle)
      },
    })
    expect(beginMacUpdateLaunch(root, '0.4.1', currentAppPath)).toBeNull()
    expect(beginMacUpdateLaunch(root, '0.4.1', currentAppPath, RETRY_TRANSACTION_ID)?.status).toBe('committed')
    writeFileSync(statePath, `${JSON.stringify({
      schemaVersion: 1, transactionId: TRANSACTION_ID, status: 'restoring', expectedVersion: '0.4.1',
    })}\n`)
    await expect(waitForMacUpdateHelperReady(jobPath, 88, {
      mode: 'recovery', processIsRunning: () => true, timeoutMs: 250,
    })).resolves.toBeUndefined()
  })

  it('kills and reaps only the exact helper process when handoff readiness fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-mac-helper-reap-'))
    const transactionRoot = join(root, 'transactions')
    mkdirSync(transactionRoot)
    const statePath = join(transactionRoot, `${TRANSACTION_ID}.state.json`)
    const jobPath = join(transactionRoot, `${TRANSACTION_ID}.json`)
    writeFileSync(jobPath, `${JSON.stringify({
      schemaVersion: 2, transactionId: TRANSACTION_ID, parentPid: 999_999,
      parentExecutablePath: '/Applications/洞见.app/Contents/MacOS/洞见',
      parentProcessStartedAt: 'Sun Aug 30 09:00:00 2026', expectedVersion: '0.4.1',
      currentAppPath: join(root, '洞见.app'),
      stagedAppPath: join(root, `.洞见.next-${TRANSACTION_ID}.app`),
      backupAppPath: join(root, `.洞见.previous-${TRANSACTION_ID}.app`),
      failedAppPath: join(root, `.洞见.failed-${TRANSACTION_ID}.app`), statePath,
    })}\n`)
    const exactChild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'])
    await once(exactChild, 'spawn')
    const exactIdentity = macUpdateProcessIdentity(exactChild.pid ?? -1)
    if (exactIdentity === null) throw new Error('expected exact child identity')
    await expect(waitForMacUpdateHelperHandoff(jobPath, exactChild, exactIdentity, {
      timeoutMs: 0, processMatchesLaunch: () => true,
    })).rejects.toThrow('未在时限内接管安装')
    expect(exactChild.signalCode).toBe('SIGKILL')

    const reusedChild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'])
    await once(reusedChild, 'spawn')
    const reusedIdentity = macUpdateProcessIdentity(reusedChild.pid ?? -1)
    if (reusedIdentity === null || reusedChild.pid === undefined) throw new Error('expected reused child identity')
    setTimeout(() => { process.kill(reusedChild.pid as number, 'SIGTERM') }, 10)
    await expect(waitForMacUpdateHelperHandoff(jobPath, reusedChild, reusedIdentity, {
      timeoutMs: 0, processMatchesLaunch: () => false,
    })).rejects.toThrow('未在时限内接管安装')
    expect(reusedChild.signalCode).toBe('SIGTERM')
  })
})
