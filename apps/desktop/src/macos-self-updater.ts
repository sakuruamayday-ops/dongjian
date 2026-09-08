/** Ed25519-authenticated self-managed macOS desktop updater. */

import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  createReadStream, createWriteStream, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, writeFileSync,
} from 'node:fs'
import { once } from 'node:events'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ProductRuntimeTrustAnchor } from '../../../product/gongchuang-client/src/product-runtime-verifier.ts'
import { verifyProductRuntime } from '../../../product/gongchuang-client/src/product-runtime-verifier.ts'
import type { SkillSuiteTrustAnchor } from '../../../product/gongchuang-client/src/skill-suite-verifier.ts'
import { verifyStagedSkillSuite } from '../../../product/gongchuang-client/src/skill-suite-verifier.ts'
import type { DesktopUpdateProgress, DesktopUpdateSnapshot } from './desktop-updater.ts'
import {
  macUpdateProcessIdentity, macUpdateTerminalCleanupPaths, verifyMacSafeReplacementSupport,
} from './macos-update-helper.ts'
import { compareVersions } from './skill-updater.ts'

export const DEFAULT_MACOS_SELF_UPDATE_MANIFEST_URL =
  'https://zshjiaotang.cn/client-updates/v0.2/macos/desktop-release-index.json'

const PRODUCT_ID = 'cn.dongjian.desktop'
const PRODUCT_APP_NAME = '洞见.app'
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u
const noBeforeInstall = (): Promise<void> => Promise.resolve()

export interface MacDesktopUpdateArtifact {
  readonly architecture: 'arm64' | 'x64'
  readonly archiveUrl: string
  readonly bundleId: typeof PRODUCT_ID
  readonly fileName: string
  readonly runtimeIndexSha256: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly skillBundleIndexSha256: string
}

export interface MacDesktopUpdateManifest {
  readonly schemaVersion: 1
  readonly productId: typeof PRODUCT_ID
  readonly clientVersion: string
  readonly publishedAt: string
  readonly signingTier: 'development-candidate' | 'formal'
  readonly sourceCommit: string
  readonly artifacts: readonly MacDesktopUpdateArtifact[]
  readonly releaseNotes?: string
}

interface VerifiedMacApplicationIdentity {
  readonly architecture: 'arm64' | 'x64'
  readonly bundleId: typeof PRODUCT_ID
  readonly runtimeIndexSha256: string
  readonly skillBundleIndexSha256: string
  readonly version: string
}

export interface MacUpdateInstallJob {
  readonly schemaVersion: 1 | 2
  readonly transactionId: string
  readonly parentPid: number
  readonly parentExecutablePath?: string
  readonly parentProcessStartedAt?: string
  readonly expectedVersion: string
  readonly currentAppPath: string
  readonly stagedAppPath: string
  readonly backupAppPath: string
  readonly failedAppPath: string
  readonly statePath: string
}

interface MacSelfUpdaterOptions {
  readonly architecture: 'arm64' | 'x64'
  readonly currentAppPath: string
  readonly currentVersion: string
  readonly expectedManifestPublicKeySha256: string
  readonly expectedSigningTier: 'development-candidate' | 'formal'
  readonly manifestPublicKeyPath: string
  readonly runtimeTrustAnchor: ProductRuntimeTrustAnchor
  readonly skillTrustAnchor: SkillSuiteTrustAnchor
  readonly updateRoot: string
  readonly feedUrl?: string
  /** Exact one-time transition target; ordinary V0.2 self-updates leave this unset. */
  readonly requiredTargetVersion?: string
  readonly fetchImpl?: typeof fetch
  readonly createArchiveWriteStream?: typeof createWriteStream
  readonly runProgram?: (executable: string, argumentsValue: readonly string[]) => Promise<void>
  readonly runProgramOutput?: (executable: string, argumentsValue: readonly string[]) => Promise<string>
  readonly startInstallHelper: (jobPath: string) => Promise<void>
  readonly reportError?: (error: unknown) => void
  readonly reportProgress?: (progress: DesktopUpdateProgress) => void
  readonly trashItem?: (path: string) => Promise<void>
  readonly verifyApplication?: (
    appPath: string,
    expected: MacDesktopUpdateArtifact,
    version: string,
  ) => Promise<VerifiedMacApplicationIdentity>
}

interface MacArchiveDownloadState {
  readonly schemaVersion: 1
  readonly manifestSha256: string
  readonly archiveUrl: string
  readonly architecture: 'arm64' | 'x64'
  readonly fileName: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly validatorHeader: 'etag' | 'last-modified'
  readonly validatorValue: string
}

function normalizedManifestUrl(value: string | undefined): URL {
  const url = new URL(value?.trim() || DEFAULT_MACOS_SELF_UPDATE_MANIFEST_URL)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('macOS 客户端更新源必须使用无凭据 HTTPS 地址')
  }
  if (!url.pathname.endsWith('.json')) throw new Error('macOS 客户端更新清单路径无效')
  url.hash = ''
  return url
}

function signatureUrl(manifestUrl: URL): URL {
  return new URL(`${manifestUrl.pathname.slice(0, -'.json'.length)}.sig${manifestUrl.search}`, manifestUrl)
}

function exactResponseUrl(response: Response, expected: URL, label: string): void {
  if (response.url === '') return
  const actual = new URL(response.url)
  if (actual.href !== expected.href) throw new Error(`${label}响应地址与请求不一致`)
}

async function limitedResponseBytes(response: Response, limit: number, label: string): Promise<Buffer> {
  const advertised = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(advertised) && advertised > limit) throw new Error(`${label}超过体积限制`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > limit) throw new Error(`${label}体积无效`)
  return bytes
}

function requiredString(row: Readonly<Record<string, unknown>>, name: string): string {
  const value = row[name]
  if (typeof value !== 'string') throw new Error(`macOS 更新清单字段无效：${name}`)
  return value
}

function parseArtifact(value: unknown, manifestUrl: URL, version: string): MacDesktopUpdateArtifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('macOS 更新产物记录无效')
  }
  const row = value as Readonly<Record<string, unknown>>
  const architecture = requiredString(row, 'architecture')
  const fileName = requiredString(row, 'fileName')
  const archiveUrlValue = requiredString(row, 'archiveUrl')
  const bundleId = requiredString(row, 'bundleId')
  const sha256 = requiredString(row, 'sha256').toLowerCase()
  const runtimeIndexSha256 = requiredString(row, 'runtimeIndexSha256').toLowerCase()
  const skillBundleIndexSha256 = requiredString(row, 'skillBundleIndexSha256').toLowerCase()
  const archiveUrl = new URL(archiveUrlValue, manifestUrl)
  const expectedName = `Dongjian-${version}-mac-${architecture}.zip`
  if ((architecture !== 'arm64' && architecture !== 'x64')
    || fileName !== expectedName || decodeURIComponent(basename(archiveUrl.pathname)) !== fileName
    || archiveUrl.protocol !== 'https:' || archiveUrl.username !== '' || archiveUrl.password !== ''
    || archiveUrl.origin !== manifestUrl.origin || bundleId !== PRODUCT_ID
    || !SHA256_PATTERN.test(sha256) || !SHA256_PATTERN.test(runtimeIndexSha256)
    || !SHA256_PATTERN.test(skillBundleIndexSha256)
    || !Number.isSafeInteger(row.sizeBytes) || Number(row.sizeBytes) <= 0
    || Number(row.sizeBytes) > MAX_ARCHIVE_BYTES) {
    throw new Error(`macOS 更新产物身份无效：${fileName}`)
  }
  return Object.freeze({
    architecture,
    archiveUrl: archiveUrl.href,
    bundleId: PRODUCT_ID,
    fileName,
    runtimeIndexSha256,
    sha256,
    sizeBytes: Number(row.sizeBytes),
    skillBundleIndexSha256,
  })
}

/** Verify exact manifest bytes with the product-runtime publisher key pinned by the Host. */
export function verifyMacDesktopUpdateManifest(
  manifestBytes: Buffer,
  encodedSignature: string,
  publicKeyPem: Buffer,
  manifestUrl: URL,
  expectedPublicKeySha256: string,
  expectedSigningTier: 'development-candidate' | 'formal',
): MacDesktopUpdateManifest {
  if (!SHA256_PATTERN.test(expectedPublicKeySha256)) throw new Error('macOS 更新宿主公钥指纹无效')
  const publicKeySha256 = createHash('sha256').update(publicKeyPem).digest('hex')
  if (publicKeySha256 !== expectedPublicKeySha256) throw new Error('macOS 更新公钥不属于当前签名宿主')
  const signature = encodedSignature.trim()
  if (!BASE64_PATTERN.test(signature)
    || !verify(null, manifestBytes, createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'))) {
    throw new Error('macOS 更新清单 Ed25519 签名无效')
  }
  const parsed = JSON.parse(manifestBytes.toString('utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('macOS 更新清单格式无效')
  }
  const row = parsed as Readonly<Record<string, unknown>>
  const version = requiredString(row, 'clientVersion')
  const publishedAt = requiredString(row, 'publishedAt')
  const signingTier = requiredString(row, 'signingTier')
  const sourceCommit = requiredString(row, 'sourceCommit').toLowerCase()
  if (row.schemaVersion !== 1 || row.productId !== PRODUCT_ID || !VERSION_PATTERN.test(version)
    || signingTier !== expectedSigningTier || !COMMIT_PATTERN.test(sourceCommit)
    || !Number.isFinite(Date.parse(publishedAt)) || !Array.isArray(row.artifacts)
    || row.artifacts.length === 0 || row.artifacts.length > 2) {
    throw new Error('macOS 更新清单身份或版本无效')
  }
  const artifacts = row.artifacts.map(value => parseArtifact(value, manifestUrl, version))
  if (row.releaseNotes !== undefined && (typeof row.releaseNotes !== 'string' || row.releaseNotes.length > 8_000)) {
    throw new Error('macOS 更新日志格式无效')
  }
  if (new Set(artifacts.map(artifact => artifact.architecture)).size !== artifacts.length) {
    throw new Error('macOS 更新清单包含重复架构')
  }
  return Object.freeze({
    schemaVersion: 1,
    productId: PRODUCT_ID,
    clientVersion: version,
    publishedAt,
    signingTier: expectedSigningTier,
    sourceCommit,
    artifacts: Object.freeze(artifacts),
    ...(typeof row.releaseNotes === 'string' ? { releaseNotes: row.releaseNotes } : {}),
  })
}

function defaultRunProgram(executable: string, argumentsValue: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(executable, [...argumentsValue], { windowsHide: true }, (error) => {
      if (error === null) resolvePromise()
      else rejectPromise(new Error(error.message, { cause: error }))
    })
  })
}

function defaultRunProgramOutput(executable: string, argumentsValue: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(executable, [...argumentsValue], { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error === null) resolvePromise(stdout)
      else rejectPromise(new Error(error.message, { cause: error }))
    })
  })
}

function artifactDownloadIdentity(manifestSha256: string, artifact: MacDesktopUpdateArtifact): string {
  return createHash('sha256').update(JSON.stringify({
    manifestSha256,
    architecture: artifact.architecture,
    archiveUrl: artifact.archiveUrl,
    fileName: artifact.fileName,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
  })).digest('hex')
}

function responseValidator(
  response: Response,
): Pick<MacArchiveDownloadState, 'validatorHeader' | 'validatorValue'> | null {
  const etag = response.headers.get('etag')
  if (etag !== null && etag !== '' && !etag.startsWith('W/')) {
    return { validatorHeader: 'etag', validatorValue: etag }
  }
  const lastModified = response.headers.get('last-modified')
  if (lastModified !== null && Number.isFinite(Date.parse(lastModified))) {
    return { validatorHeader: 'last-modified', validatorValue: lastModified }
  }
  return null
}

function expectedDownloadState(
  manifestSha256: string,
  artifact: MacDesktopUpdateArtifact,
  validator: Pick<MacArchiveDownloadState, 'validatorHeader' | 'validatorValue'>,
): MacArchiveDownloadState {
  return Object.freeze({
    schemaVersion: 1,
    manifestSha256,
    archiveUrl: artifact.archiveUrl,
    architecture: artifact.architecture,
    fileName: artifact.fileName,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    ...validator,
  })
}

function matchingDownloadState(
  statePath: string,
  manifestSha256: string,
  artifact: MacDesktopUpdateArtifact,
): MacArchiveDownloadState | null {
  try {
    const info = lstatSync(statePath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) return null
    const value = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<MacArchiveDownloadState>
    if (value.schemaVersion !== 1 || value.manifestSha256 !== manifestSha256
      || value.archiveUrl !== artifact.archiveUrl || value.architecture !== artifact.architecture
      || value.fileName !== artifact.fileName || value.sha256 !== artifact.sha256
      || value.sizeBytes !== artifact.sizeBytes
      || (value.validatorHeader !== 'etag' && value.validatorHeader !== 'last-modified')
      || typeof value.validatorValue !== 'string' || value.validatorValue === '') return null
    return value as MacArchiveDownloadState
  } catch {
    return null
  }
}

function resumableArchiveBytes(
  updateRoot: string,
  manifestSha256: string,
  artifact: MacDesktopUpdateArtifact,
): number {
  const identity = artifactDownloadIdentity(manifestSha256, artifact)
  const downloadRoot = join(updateRoot, 'downloads', identity)
  const archivePath = join(downloadRoot, `${artifact.fileName}.partial`)
  const statePath = join(downloadRoot, 'download-state.json')
  const state = matchingDownloadState(statePath, manifestSha256, artifact)
  if (state === null || !existsSync(archivePath)) return 0
  try {
    const info = lstatSync(archivePath)
    return info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= artifact.sizeBytes
      ? info.size
      : 0
  } catch {
    return 0
  }
}

function writeDownloadState(path: string, state: MacArchiveDownloadState): void {
  const temporary = `${path}.next-${process.pid}-${randomUUID()}`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  renameSync(temporary, path)
}

async function updateDigestFromFile(path: string, digest: ReturnType<typeof createHash>): Promise<void> {
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
}

async function retireDownloadRoot(
  downloadRoot: string,
  trashItem: ((path: string) => Promise<void>) | undefined,
): Promise<void> {
  if (!existsSync(downloadRoot)) return
  const retired = `${downloadRoot}.retired-${randomUUID()}`
  renameSync(downloadRoot, retired)
  if (trashItem !== undefined) await trashItem(retired)
}

async function verifyDecisionLinkSupport(
  transactionRoot: string,
  transactionId: string,
  trashItem: ((path: string) => Promise<void>) | undefined,
): Promise<void> {
  const probeRoot = join(transactionRoot, `.decision-link-probe-${transactionId}`)
  const candidate = join(probeRoot, 'candidate')
  const target = join(probeRoot, 'decision')
  mkdirSync(probeRoot, { mode: 0o700 })
  try {
    writeFileSync(candidate, 'macOS update decision link probe\n', { mode: 0o600, flag: 'wx' })
    linkSync(candidate, target)
    const info = lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink < 2) {
      throw new Error('macOS 更新目录不支持原子事务决策')
    }
  } finally {
    if (trashItem !== undefined && existsSync(probeRoot)) await trashItem(probeRoot)
  }
}

async function cleanObsoleteDownloadResidue(
  updateRoot: string,
  activeIdentity: string | null,
  currentAppPath: string,
  trashItem: ((path: string) => Promise<void>) | undefined,
): Promise<void> {
  if (trashItem === undefined) return
  const downloadsRoot = join(updateRoot, 'downloads')
  if (existsSync(downloadsRoot)) {
    const info = lstatSync(downloadsRoot)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('macOS 更新下载目录必须是实体目录')
    for (const name of readdirSync(downloadsRoot)) {
      const path = join(downloadsRoot, name)
      const entry = lstatSync(path)
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (/^[a-f0-9]{64}$/u.test(name) && name !== activeIdentity) {
        await retireDownloadRoot(path, trashItem)
      } else if (/^[a-f0-9]{64}\.retired-[0-9a-f-]{36}$/u.test(name)) {
        await trashItem(path)
      }
    }
  }
  const stagingRoot = join(updateRoot, 'staging')
  if (existsSync(stagingRoot)) {
    const stagingInfo = lstatSync(stagingRoot)
    if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()) {
      throw new Error('macOS 更新暂存目录必须是实体目录')
    }
    for (const name of readdirSync(stagingRoot)) {
      if (!/^\d+\.\d+\.\d+-[0-9a-f-]{36}$/u.test(name)) continue
      const path = join(stagingRoot, name)
      const entry = lstatSync(path)
      if (entry.isDirectory() && !entry.isSymbolicLink()) await trashItem(path)
    }
  }

  const applicationRoot = dirname(currentAppPath)
  const applicationRootInfo = lstatSync(applicationRoot)
  if (!applicationRootInfo.isDirectory() || applicationRootInfo.isSymbolicLink()) {
    throw new Error('macOS 更新应用父目录必须是实体目录')
  }
  const transactionRoot = join(updateRoot, 'transactions')
  for (const name of readdirSync(applicationRoot)) {
    const match = /^\.洞见\.next-([0-9a-f-]{36})\.app$/u.exec(name)
    if (match === null) continue
    const transactionId = match[1]
    if (transactionId === undefined) continue
    const path = join(applicationRoot, name)
    const entry = lstatSync(path)
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    let active = false
    try {
      const state = JSON.parse(readFileSync(join(transactionRoot, `${transactionId}.state.json`), 'utf8')) as {
        transactionId?: unknown
        status?: unknown
      }
      active = state.transactionId === transactionId
        && (state.status === 'waiting' || state.status === 'attempting' || state.status === 'restoring')
    } catch {
      // No active helper state means this product-owned .next bundle was left
      // before handoff and can only consume disk; the current app is untouched.
    }
    if (!active) await trashItem(path)
  }
}

function exactContentLength(response: Response, expected: number): void {
  const advertised = response.headers.get('content-length')
  if (advertised === null || !/^\d+$/u.test(advertised) || Number(advertised) !== expected) {
    throw new Error('macOS 更新包响应体积与签名清单不一致')
  }
  const encoding = response.headers.get('content-encoding')
  if (encoding !== null && encoding.toLowerCase() !== 'identity') {
    throw new Error('macOS 更新包响应不得改变签名字节编码')
  }
}

function exactPartialResponse(response: Response, offset: number, artifact: MacDesktopUpdateArtifact): void {
  if (response.status !== 206) throw new Error('macOS 更新服务器未按请求返回断点内容')
  const expectedRange = `bytes ${String(offset)}-${String(artifact.sizeBytes - 1)}/${String(artifact.sizeBytes)}`
  if (response.headers.get('content-range') !== expectedRange) {
    throw new Error('macOS 更新包 Content-Range 与已验证半包不一致')
  }
  exactContentLength(response, artifact.sizeBytes - offset)
}

async function downloadArchive(
  fetchImpl: typeof fetch,
  archiveUrl: URL,
  updateRoot: string,
  manifestSha256: string,
  latestVersion: string,
  artifact: MacDesktopUpdateArtifact,
  reportProgress: ((progress: DesktopUpdateProgress) => void) | undefined,
  trashItem: ((path: string) => Promise<void>) | undefined,
  createArchiveWriteStream: typeof createWriteStream = createWriteStream,
): Promise<{ archivePath: string; downloadRoot: string }> {
  const identity = artifactDownloadIdentity(manifestSha256, artifact)
  let downloadRoot = join(updateRoot, 'downloads', identity)
  let archivePath = join(downloadRoot, `${artifact.fileName}.partial`)
  let statePath = join(downloadRoot, 'download-state.json')
  let state = matchingDownloadState(statePath, manifestSha256, artifact)
  let offset = 0
  if (existsSync(downloadRoot)) {
    const archiveInfo = existsSync(archivePath) ? lstatSync(archivePath) : null
    const validArchive = archiveInfo !== null && archiveInfo.isFile() && !archiveInfo.isSymbolicLink()
      && archiveInfo.size > 0 && archiveInfo.size <= artifact.sizeBytes
    if (state === null || !validArchive) {
      await retireDownloadRoot(downloadRoot, trashItem)
      state = null
    } else {
      offset = archiveInfo.size
    }
  }
  mkdirSync(downloadRoot, { recursive: true, mode: 0o700 })

  let digest = createHash('sha256')
  if (offset > 0) await updateDigestFromFile(archivePath, digest)
  if (offset === artifact.sizeBytes) {
    if (digest.digest('hex') === artifact.sha256) {
      reportProgress?.({
        phase: 'verifying', latestVersion, receivedBytes: offset, totalBytes: artifact.sizeBytes,
        percent: 100, remainingSeconds: 0, resumedFromBytes: offset,
      })
      return { archivePath, downloadRoot }
    }
    await retireDownloadRoot(downloadRoot, trashItem)
    downloadRoot = join(updateRoot, 'downloads', identity)
    archivePath = join(downloadRoot, `${artifact.fileName}.partial`)
    statePath = join(downloadRoot, 'download-state.json')
    mkdirSync(downloadRoot, { recursive: true, mode: 0o700 })
    state = null
    offset = 0
    digest = createHash('sha256')
  }

  let resumedFromBytes = offset
  const headers = new Headers({ accept: 'application/zip', 'accept-encoding': 'identity' })
  if (state !== null && offset > 0) {
    headers.set('range', `bytes=${String(offset)}-`)
    headers.set('if-range', state.validatorValue)
  }
  const response = await fetchImpl(archiveUrl, { headers, redirect: 'error' })
  exactResponseUrl(response, archiveUrl, 'macOS 更新包')
  if (state !== null && offset > 0 && response.status === 206) {
    try {
      exactPartialResponse(response, offset, artifact)
      const validator = responseValidator(response)
      if (validator === null || validator.validatorHeader !== state.validatorHeader
        || validator.validatorValue !== state.validatorValue) {
        throw new Error('macOS 更新包断点响应校验器已变化')
      }
    } catch (error) {
      // The stored prefix is bound to the old validator and exact byte range.
      // Retire it after a contradictory 206 so a later click starts clean
      // instead of repeating the same unrecoverable resume request forever.
      await retireDownloadRoot(downloadRoot, trashItem)
      throw error
    }
  } else {
    if (!response.ok || response.status !== 200 || response.headers.get('content-range') !== null) {
      throw new Error(`macOS 更新包下载失败，HTTP ${String(response.status)}`)
    }
    exactContentLength(response, artifact.sizeBytes)
    const validator = responseValidator(response)
    if (offset > 0) {
      await retireDownloadRoot(downloadRoot, trashItem)
      downloadRoot = join(updateRoot, 'downloads', identity)
      archivePath = join(downloadRoot, `${artifact.fileName}.partial`)
      statePath = join(downloadRoot, 'download-state.json')
      mkdirSync(downloadRoot, { recursive: true, mode: 0o700 })
      offset = 0
      resumedFromBytes = 0
      state = null
      digest = createHash('sha256')
    }
    if (validator !== null) {
      state = expectedDownloadState(manifestSha256, artifact, validator)
      writeDownloadState(statePath, state)
    }
  }
  if (response.body === null) throw new Error('macOS 更新包响应为空')

  const output = createArchiveWriteStream(archivePath, { flags: offset === 0 ? 'wx' : 'a', mode: 0o600 })
  let rejectOutputFailure: ((error: Error) => void) | undefined
  const outputFailure = new Promise<never>((_resolvePromise, rejectPromise) => {
    rejectOutputFailure = (error: Error): void => { rejectPromise(error) }
    output.once('error', rejectOutputFailure)
  })
  let received = offset
  const startedAt = Date.now()
  let lastReportAt = 0
  const publish = (force = false): void => {
    const now = Date.now()
    if (!force && now - lastReportAt < 250) return
    lastReportAt = now
    const elapsedSeconds = Math.max((now - startedAt) / 1_000, 0.001)
    const transferred = received - resumedFromBytes
    const bytesPerSecond = transferred / elapsedSeconds
    const remainingSeconds = bytesPerSecond > 0
      ? Math.ceil((artifact.sizeBytes - received) / bytesPerSecond)
      : null
    reportProgress?.({
      phase: 'downloading', latestVersion, receivedBytes: received, totalBytes: artifact.sizeBytes,
      percent: Math.min(100, Math.floor(received * 100 / artifact.sizeBytes)),
      remainingSeconds, resumedFromBytes,
    })
  }
  publish(true)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    await Promise.race([once(output, 'open'), outputFailure])
    reader = response.body.getReader()
    while (true) {
      const chunk = await Promise.race([reader.read(), outputFailure])
      if (chunk.done) break
      const bytes = Buffer.from(chunk.value)
      received += bytes.length
      if (received > artifact.sizeBytes || received > MAX_ARCHIVE_BYTES) {
        throw new Error('macOS 更新包体积超过签名清单')
      }
      digest.update(bytes)
      if (!output.write(bytes)) await Promise.race([once(output, 'drain'), outputFailure])
      publish()
    }
    output.end()
    await Promise.race([once(output, 'finish'), outputFailure])
  } catch (error) {
    await reader?.cancel().catch(() => undefined)
    output.destroy()
    if (!output.closed) {
      await new Promise<void>((resolvePromise) => { output.once('close', resolvePromise) })
    }
    // A prefix without a server validator can never be resumed safely. Retire it
    // immediately so a failed full download does not leave an unusable cache.
    if (state === null) await retireDownloadRoot(downloadRoot, trashItem)
    throw error
  } finally {
    if (rejectOutputFailure !== undefined) output.off('error', rejectOutputFailure)
  }
  publish(true)
  if (received !== artifact.sizeBytes || digest.digest('hex') !== artifact.sha256) {
    if (received === artifact.sizeBytes) await retireDownloadRoot(downloadRoot, trashItem)
    throw new Error('macOS 更新包摘要或体积与签名清单不一致')
  }
  reportProgress?.({
    phase: 'verifying', latestVersion, receivedBytes: received, totalBytes: artifact.sizeBytes,
    percent: 100, remainingSeconds: 0, resumedFromBytes,
  })
  return { archivePath, downloadRoot }
}

function requireEntityDirectory(path: string, label: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label}必须是实体目录`)
}

function verifyContainedApplicationTree(root: string, current = root): void {
  const canonicalRoot = realpathSync(root)
  for (const name of readdirSync(current)) {
    const path = join(current, name)
    const info = lstatSync(path)
    if (info.isSymbolicLink()) {
      const target = realpathSync(path)
      const child = relative(canonicalRoot, target)
      if (child.startsWith('..') || isAbsolute(child)) throw new Error('macOS 更新应用包含越界符号链接')
    } else if (info.isDirectory()) verifyContainedApplicationTree(canonicalRoot, path)
    else if (!info.isFile()) throw new Error('macOS 更新应用包含不支持的文件类型')
  }
}

function extractedApplication(root: string): string {
  const entries = readdirSync(root)
  if (entries.length !== 1 || entries[0] !== PRODUCT_APP_NAME) {
    throw new Error('macOS 更新包必须只包含唯一的洞见应用')
  }
  const path = join(root, PRODUCT_APP_NAME)
  requireEntityDirectory(path, 'macOS 更新应用')
  return path
}

/** Verify bundle identity, ad-hoc code integrity, and both embedded signed product trees. */
async function verifyStagedMacApplication(
  appPath: string,
  expected: MacDesktopUpdateArtifact,
  version: string,
  runtimeTrustAnchor: ProductRuntimeTrustAnchor,
  skillTrustAnchor: SkillSuiteTrustAnchor,
  runProgram: (executable: string, argumentsValue: readonly string[]) => Promise<void> = defaultRunProgram,
  runProgramOutput: (
    executable: string,
    argumentsValue: readonly string[],
  ) => Promise<string> = defaultRunProgramOutput,
): Promise<VerifiedMacApplicationIdentity> {
  requireEntityDirectory(appPath, 'macOS 更新应用')
  verifyContainedApplicationTree(appPath)
  const contents = join(appPath, 'Contents')
  const infoPath = join(contents, 'Info.plist')
  const resources = join(contents, 'Resources', 'product')
  const plistValue = async (name: string): Promise<string> => (
    (await runProgramOutput('/usr/bin/plutil', ['-extract', name, 'raw', '-o', '-', infoPath])).trim()
  )
  const [bundleId, bundleVersion, executableName] = await Promise.all([
    plistValue('CFBundleIdentifier'),
    plistValue('CFBundleShortVersionString'),
    plistValue('CFBundleExecutable'),
  ])
  if (bundleId !== expected.bundleId || bundleVersion !== version
    || executableName === '' || basename(executableName) !== executableName) {
    throw new Error('macOS 更新应用的 Bundle ID 或版本与签名清单不一致')
  }
  const executablePath = join(contents, 'MacOS', executableName)
  await runProgram('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  const architectures = (await runProgramOutput('/usr/bin/lipo', ['-archs', executablePath])).trim().split(/\s+/u)
    .map(architecture => architecture === 'x86_64' ? 'x64' : architecture)
  if (architectures.length !== 1 || architectures[0] !== expected.architecture) {
    throw new Error('macOS 更新应用架构与签名清单不一致')
  }
  const runtime = verifyProductRuntime(join(resources, 'runtime'), {
    ...runtimeTrustAnchor,
    expectedClientVersion: version,
  })
  const skills = verifyStagedSkillSuite(join(resources, 'skill-suite'), skillTrustAnchor)
  if (runtime.indexSha256 !== expected.runtimeIndexSha256
    || skills.indexSha256 !== expected.skillBundleIndexSha256) {
    throw new Error('macOS 更新应用内置签名运行时或技能包与发布清单不一致')
  }
  return Object.freeze({
    architecture: expected.architecture,
    bundleId: PRODUCT_ID,
    runtimeIndexSha256: runtime.indexSha256,
    skillBundleIndexSha256: skills.indexSha256,
    version,
  })
}

/** Derive the containing `.app` from Electron's packaged executable path. */
export function macApplicationPath(executablePath: string): string {
  const candidate = resolve(dirname(executablePath), '../..')
  if (!candidate.endsWith('.app')) throw new Error('macOS 客户端不在应用包中运行')
  requireEntityDirectory(candidate, 'macOS 当前应用')
  return candidate
}

/** Verify the exact installed V0.1.4 application selected for the one-time V0.2.0 transition. */
export async function verifyMacTransitionSource(
  appPath: string,
  expectedVersion: string,
  runProgram: (executable: string, argumentsValue: readonly string[]) => Promise<void> = defaultRunProgram,
  runProgramOutput: (
    executable: string,
    argumentsValue: readonly string[],
  ) => Promise<string> = defaultRunProgramOutput,
): Promise<'arm64' | 'x64'> {
  if (!VERSION_PATTERN.test(expectedVersion)) throw new Error('macOS 过渡源版本无效')
  requireEntityDirectory(appPath, 'macOS 过渡源应用')
  verifyContainedApplicationTree(appPath)
  const contents = join(appPath, 'Contents')
  const infoPath = join(contents, 'Info.plist')
  const plistValue = async (name: string): Promise<string> => (
    (await runProgramOutput('/usr/bin/plutil', ['-extract', name, 'raw', '-o', '-', infoPath])).trim()
  )
  const [bundleId, version, executableName] = await Promise.all([
    plistValue('CFBundleIdentifier'),
    plistValue('CFBundleShortVersionString'),
    plistValue('CFBundleExecutable'),
  ])
  if (bundleId !== PRODUCT_ID || version !== expectedVersion
    || executableName === '' || basename(executableName) !== executableName) {
    throw new Error('所选应用不是可过渡的洞见 V0.1.4')
  }
  await runProgram('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  const architectures = (await runProgramOutput(
    '/usr/bin/lipo', ['-archs', join(contents, 'MacOS', executableName)],
  )).trim().split(/\s+/u).map(architecture => architecture === 'x86_64' ? 'x64' : architecture)
  if (architectures.length !== 1 || (architectures[0] !== 'arm64' && architectures[0] !== 'x64')) {
    throw new Error('所选 V0.1.4 应用必须包含唯一的 arm64 或 x64 架构')
  }
  return architectures[0]
}

/** Check, download, verify, stage, and hand off one self-managed macOS update. */
export class MacSelfUpdaterController {
  private readonly feedUrl: URL
  private readonly fetchImpl: typeof fetch
  private readonly runProgram: (executable: string, argumentsValue: readonly string[]) => Promise<void>
  private readonly runProgramOutput: (executable: string, argumentsValue: readonly string[]) => Promise<string>
  private latest: {
    manifest: MacDesktopUpdateManifest
    manifestSha256: string
    artifact: MacDesktopUpdateArtifact
  } | null = null
  private prepared: { jobPath: string; stagedAppPath: string; downloadRoot: string } | null = null
  private activeDownload: Promise<DesktopUpdateSnapshot> | null = null
  private activeInstall: Promise<DesktopUpdateSnapshot> | null = null

  constructor(private readonly options: MacSelfUpdaterOptions) {
    if (!VERSION_PATTERN.test(options.currentVersion)) throw new Error('macOS 当前客户端版本无效')
    if (options.requiredTargetVersion !== undefined && !VERSION_PATTERN.test(options.requiredTargetVersion)) {
      throw new Error('macOS 过渡目标版本无效')
    }
    this.feedUrl = normalizedManifestUrl(options.feedUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.runProgram = options.runProgram ?? defaultRunProgram
    this.runProgramOutput = options.runProgramOutput ?? defaultRunProgramOutput
    requireEntityDirectory(options.currentAppPath, 'macOS 当前应用')
  }

  private activeDownloadSnapshot(): DesktopUpdateSnapshot | null {
    if (this.activeInstall !== null && this.latest !== null) return this.snapshot('downloaded', this.latest.manifest.clientVersion, '正在准备重启升级')
    if (this.activeDownload === null) return null
    return this.latest === null
      ? this.snapshot('error', null, '更新任务正在进行')
      : this.snapshot('available', this.latest.manifest.clientVersion, '更新正在下载')
  }

  async check(): Promise<DesktopUpdateSnapshot> {
    const activeAtStart = this.activeDownloadSnapshot()
    if (activeAtStart !== null) return activeAtStart
    if (this.options.trashItem !== undefined) {
      try {
        for (const path of macUpdateTerminalCleanupPaths(
          this.options.updateRoot, this.options.currentAppPath, this.options.currentVersion,
        )) {
          if (existsSync(path)) await this.options.trashItem(path)
        }
      } catch (error) {
        this.options.reportError?.(error)
      }
    }
    try {
      const [manifestResponse, signatureResponse] = await Promise.all([
        this.fetchImpl(this.feedUrl, { headers: { accept: 'application/json' }, redirect: 'error' }),
        this.fetchImpl(signatureUrl(this.feedUrl), { headers: { accept: 'text/plain' }, redirect: 'error' }),
      ])
      if (!manifestResponse.ok || !signatureResponse.ok) throw new Error('macOS 更新清单暂不可用')
      exactResponseUrl(manifestResponse, this.feedUrl, 'macOS 更新清单')
      exactResponseUrl(signatureResponse, signatureUrl(this.feedUrl), 'macOS 更新签名')
      const manifestBytes = await limitedResponseBytes(manifestResponse, MAX_MANIFEST_BYTES, 'macOS 更新清单')
      const signature = (await limitedResponseBytes(signatureResponse, 4_096, 'macOS 更新签名')).toString('utf8')
      const manifest = verifyMacDesktopUpdateManifest(
        manifestBytes,
        signature,
        readFileSync(this.options.manifestPublicKeyPath),
        this.feedUrl,
        this.options.expectedManifestPublicKeySha256,
        this.options.expectedSigningTier,
      )
      const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
      const artifact = manifest.artifacts.find(row => row.architecture === this.options.architecture)
      if (artifact === undefined) throw new Error('macOS 更新清单不包含当前架构')
      if (this.options.requiredTargetVersion !== undefined
        && manifest.clientVersion !== this.options.requiredTargetVersion) {
        throw new Error('macOS 过渡清单不是指定目标版本')
      }
      // A download can begin while this signed check is awaiting the network.
      // Keep its selected manifest and residue identity stable until it finishes.
      const activeAfterFetch = this.activeDownloadSnapshot()
      if (activeAfterFetch !== null) return activeAfterFetch
      if (this.latest?.manifestSha256 === manifestSha256 && this.prepared !== null) {
        return this.snapshot('downloaded', manifest.clientVersion, '更新已下载并验证，可重启升级')
      }
      this.prepared = null
      if (compareVersions(manifest.clientVersion, this.options.currentVersion) <= 0) {
        this.latest = null
        try {
          await cleanObsoleteDownloadResidue(
            this.options.updateRoot,
            null,
            this.options.currentAppPath,
            this.options.trashItem,
          )
        } catch (error) {
          this.options.reportError?.(error)
        }
        return this.snapshot('current', manifest.clientVersion, '当前已是最新版本')
      }
      this.latest = { manifest, manifestSha256, artifact }
      try {
        await cleanObsoleteDownloadResidue(
          this.options.updateRoot,
          artifactDownloadIdentity(manifestSha256, artifact),
          this.options.currentAppPath,
          this.options.trashItem,
        )
      } catch (error) {
        this.options.reportError?.(error)
      }
      const resumableBytes = resumableArchiveBytes(this.options.updateRoot, manifestSha256, artifact)
      return this.snapshot(
        'available',
        manifest.clientVersion,
        resumableBytes > 0
          ? `客户端 V${manifest.clientVersion} 已保留 ${String(Math.floor(resumableBytes * 100 / artifact.sizeBytes))}% 下载进度`
          : `发现客户端 V${manifest.clientVersion}`,
        resumableBytes,
      )
    } catch (error) {
      this.options.reportError?.(error)
      const activeAfterFailure = this.activeDownloadSnapshot()
      if (activeAfterFailure !== null) return activeAfterFailure
      this.latest = null
      this.prepared = null
      return this.snapshot('error', null, '检查更新失败，请确认网络后重试')
    }
  }

  download(): Promise<DesktopUpdateSnapshot> {
    if (this.activeDownload !== null) return this.activeDownload
    if (this.prepared !== null && this.latest !== null) return Promise.resolve(this.snapshot('downloaded', this.latest.manifest.clientVersion, '更新已下载并验证，可重启升级'))
    const tracked = this.performDownload().finally(() => {
      if (this.activeDownload === tracked) this.activeDownload = null
    })
    this.activeDownload = tracked
    return tracked
  }

  private async performDownload(): Promise<DesktopUpdateSnapshot> {
    const selected = this.latest
    if (selected === null) return this.snapshot('error', null, '请先检查更新')
    const transactionId = randomUUID()
    const staging = join(this.options.updateRoot, 'staging', `${selected.manifest.clientVersion}-${transactionId}`)
    const extractedRoot = join(staging, 'extracted')
    const currentParent = dirname(this.options.currentAppPath)
    const stagedAppPath = join(currentParent, `.洞见.next-${transactionId}.app`)
    const backupAppPath = join(currentParent, `.洞见.previous-${transactionId}.app`)
    const failedAppPath = join(currentParent, `.洞见.failed-${transactionId}.app`)
    const transactionRoot = join(this.options.updateRoot, 'transactions')
    const jobPath = join(transactionRoot, `${transactionId}.json`)
    const statePath = join(transactionRoot, `${transactionId}.state.json`)
    let downloadedRoot: string | null = null
    try {
      mkdirSync(staging, { recursive: true, mode: 0o700 })
      mkdirSync(extractedRoot, { recursive: true, mode: 0o700 })
      mkdirSync(transactionRoot, { recursive: true, mode: 0o700 })
      const archiveUrl = new URL(selected.artifact.archiveUrl)
      const downloaded = await downloadArchive(
        this.fetchImpl,
        archiveUrl,
        this.options.updateRoot,
        selected.manifestSha256,
        selected.manifest.clientVersion,
        selected.artifact,
        this.options.reportProgress,
        this.options.trashItem,
        this.options.createArchiveWriteStream,
      )
      downloadedRoot = downloaded.downloadRoot
      await this.runProgram('/usr/bin/ditto', ['-x', '-k', downloaded.archivePath, extractedRoot])
      const extracted = extractedApplication(extractedRoot)
      await this.runProgram('/usr/bin/ditto', [extracted, stagedAppPath])
      const verifyApplication = this.options.verifyApplication ?? (async (path, expected, version) => (
        verifyStagedMacApplication(
          path,
          expected,
          version,
          this.options.runtimeTrustAnchor,
          this.options.skillTrustAnchor,
          this.runProgram,
          this.runProgramOutput,
        )
      ))
      await verifyApplication(stagedAppPath, selected.artifact, selected.manifest.clientVersion)
      const parentIdentity = macUpdateProcessIdentity(process.pid)
      if (parentIdentity === null) throw new Error('无法绑定 macOS 更新父进程身份')
      const job: MacUpdateInstallJob = Object.freeze({
        schemaVersion: 2,
        transactionId,
        parentPid: process.pid,
        parentExecutablePath: parentIdentity.executablePath,
        parentProcessStartedAt: parentIdentity.startedAt,
        expectedVersion: selected.manifest.clientVersion,
        currentAppPath: this.options.currentAppPath,
        stagedAppPath,
        backupAppPath,
        failedAppPath,
        statePath,
      })
      writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      this.prepared = { jobPath, stagedAppPath, downloadRoot: downloaded.downloadRoot }
      await verifyDecisionLinkSupport(transactionRoot, transactionId, this.options.trashItem)
      // Foundation safe replacement is the schema 2 swap primitive. Reject the
      // handoff while the current app is still running if its volume cannot
      // preserve a canonical application path during replacement.
      await verifyMacSafeReplacementSupport(this.options.currentAppPath, this.runProgram)
      return this.snapshot(
        'downloaded', selected.manifest.clientVersion,
        `客户端 V${selected.manifest.clientVersion} 已下载并验证，可重启升级`,
      )
    } catch (error) {
      this.options.reportError?.(error)
      if (downloadedRoot !== null) {
        // Once the signed archive completed, extraction or application
        // verification failures are not resumable downloads. Retire the cache
        // so the UI cannot get stuck offering the same misleading 100% retry.
        try {
          await retireDownloadRoot(downloadedRoot, this.options.trashItem)
        } catch (trashError) {
          this.options.reportError?.(trashError)
        }
      }
      if (this.options.trashItem !== undefined) {
        for (const path of [stagedAppPath, staging, jobPath, statePath]) {
          if (!existsSync(path)) continue
          try {
            await this.options.trashItem(path)
          } catch (trashError) {
            this.options.reportError?.(trashError)
          }
        }
      }
      this.prepared = null
      const resumableBytes = downloadedRoot === null
        ? resumableArchiveBytes(this.options.updateRoot, selected.manifestSha256, selected.artifact)
        : 0
      if (resumableBytes > 0) {
        return this.snapshot(
          'available',
          selected.manifest.clientVersion,
          `下载中断，已保留 ${String(Math.floor(resumableBytes * 100 / selected.artifact.sizeBytes))}% 下载进度`,
          resumableBytes,
        )
      }
      return this.snapshot('error', selected.manifest.clientVersion, '更新下载或验证失败，已保留当前版本')
    }
  }

  install(beforeInstall: () => Promise<void> = noBeforeInstall): Promise<DesktopUpdateSnapshot> {
    if (this.activeInstall !== null) return this.activeInstall
    const pending = this.performInstall(beforeInstall).finally(() => { this.activeInstall = null })
    this.activeInstall = pending
    return pending
  }

  private async performInstall(beforeInstall: () => Promise<void>): Promise<DesktopUpdateSnapshot> {
    const prepared = this.prepared
    const selected = this.latest
    if (prepared === null || selected === null) {
      return this.snapshot('error', null, '尚未完成更新下载')
    }
    try {
      // 下载与安装可以相隔很久；交接前必须再次验证 App，不能信任过时的验证结果。
      const verifyApplication = this.options.verifyApplication ?? (async (path, artifact, version) => verifyStagedMacApplication(
        path, artifact, version, this.options.runtimeTrustAnchor, this.options.skillTrustAnchor,
        this.runProgram, this.runProgramOutput,
      ))
      await verifyApplication(prepared.stagedAppPath, selected.artifact, selected.manifest.clientVersion)
    } catch (error) {
      this.options.reportError?.(error)
      this.prepared = null
      return this.snapshot('error', selected.manifest.clientVersion, '安装前验证失败，已保留当前版本，请重新下载')
    }
    await beforeInstall()
    await this.options.startInstallHelper(prepared.jobPath)
    try { await retireDownloadRoot(prepared.downloadRoot, this.options.trashItem) }
    catch (error) { this.options.reportError?.(error) }
    return this.snapshot('downloaded', selected.manifest.clientVersion, '正在退出并安装更新')
  }

  private snapshot(
    status: DesktopUpdateSnapshot['status'],
    latestVersion: string | null,
    message: string,
    resumableBytes = 0,
  ): DesktopUpdateSnapshot {
    return Object.freeze({
      status,
      currentVersion: this.options.currentVersion,
      latestVersion,
      message,
      ...(this.latest?.manifest.releaseNotes === undefined ? {} : { releaseNotes: this.latest.manifest.releaseNotes }),
      ...(resumableBytes > 0 ? { resumableBytes } : {}),
    })
  }
}
