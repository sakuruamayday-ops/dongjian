/** Independent signed skill-suite updater for 洞见. */

import { randomUUID } from 'node:crypto'
import {
  createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { VerifiedSkillSuite, SkillSuiteTrustAnchor } from '../../../product/gongchuang-client/src/skill-suite-verifier.ts'
import { verifyStagedSkillSuite } from '../../../product/gongchuang-client/src/skill-suite-verifier.ts'

export const SKILL_UPDATE_STATE_CHANNEL = 'gongchuang:skill-update:state'
export const SKILL_UPDATE_CHECK_CHANNEL = 'gongchuang:skill-update:check'
export const SKILL_UPDATE_DOWNLOAD_CHANNEL = 'gongchuang:skill-update:download'
export const SKILL_UPDATE_INSTALL_CHANNEL = 'gongchuang:skill-update:install'
const DEFAULT_SKILL_UPDATE_FEED_URL = 'https://zshjiaotang.cn/skill-updates/latest.json'

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_EXPANDED_BYTES = 768 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 100_000
const VERSION_SOURCE = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)'
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const VERSION_PATTERN = new RegExp(`^${VERSION_SOURCE}$`, 'u')
const STAGING_TRANSACTION_PATTERN = new RegExp(`^(${VERSION_SOURCE})-${UUID_SOURCE}$`, 'u')

export type SkillUpdateStatus = 'current' | 'available' | 'downloaded' | 'error'

export interface SkillUpdateSnapshot {
  readonly status: SkillUpdateStatus
  readonly currentVersion: string
  readonly latestVersion: string | null
  readonly message: string
  readonly releaseNotes: string | null
}

export interface SkillUpdateManifest {
  readonly schemaVersion: 1
  readonly productId: 'cn.dongjian.desktop'
  readonly skillBundleVersion: string
  readonly sourceReleaseTag: string
  readonly archiveUrl: string
  readonly releaseNotes: string
}

interface SkillUpdateState {
  readonly schemaVersion: 1
  readonly activeVersion?: string
  readonly downloadedVersion?: string
  readonly pendingVersion?: string
  readonly attemptingVersion?: string
  readonly failedVersion?: string
  readonly lastError?: string
  readonly lastSuccessVersion?: string
  readonly enabledAt?: string
}

export interface SkillBundleLaunchSelection {
  readonly path: string
  readonly verified: VerifiedSkillSuite
  readonly bundledVersion: string
  readonly pendingActivation: boolean
}

interface SkillUpdaterOptions {
  readonly updateRoot: string
  readonly activeVersion: string
  readonly feedUrl?: string
  readonly trustAnchor: SkillSuiteTrustAnchor
  readonly fetchImpl?: typeof fetch
}

function statePath(updateRoot: string): string {
  return join(updateRoot, 'state.json')
}

function versionPath(updateRoot: string, version: string): string {
  return join(updateRoot, 'versions', version)
}

function readState(updateRoot: string): SkillUpdateState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(updateRoot), 'utf8')) as Partial<SkillUpdateState>
    if (parsed.schemaVersion !== 1) return { schemaVersion: 1 }
    return {
      schemaVersion: 1,
      ...(typeof parsed.activeVersion === 'string' && VERSION_PATTERN.test(parsed.activeVersion)
        ? { activeVersion: parsed.activeVersion }
        : {}),
      ...(typeof parsed.downloadedVersion === 'string' && VERSION_PATTERN.test(parsed.downloadedVersion)
        ? { downloadedVersion: parsed.downloadedVersion }
        : {}),
      ...(typeof parsed.pendingVersion === 'string' && VERSION_PATTERN.test(parsed.pendingVersion)
        ? { pendingVersion: parsed.pendingVersion }
        : {}),
      ...(typeof parsed.attemptingVersion === 'string' && VERSION_PATTERN.test(parsed.attemptingVersion)
        ? { attemptingVersion: parsed.attemptingVersion }
        : {}),
      ...(typeof parsed.failedVersion === 'string' && VERSION_PATTERN.test(parsed.failedVersion)
        ? { failedVersion: parsed.failedVersion }
        : {}),
      ...(typeof parsed.lastError === 'string' ? { lastError: parsed.lastError } : {}),
      ...(typeof parsed.lastSuccessVersion === 'string' && VERSION_PATTERN.test(parsed.lastSuccessVersion)
        ? { lastSuccessVersion: parsed.lastSuccessVersion }
        : {}),
      ...(typeof parsed.enabledAt === 'string' && !Number.isNaN(Date.parse(parsed.enabledAt))
        ? { enabledAt: parsed.enabledAt }
        : {}),
    }
  } catch {
    return { schemaVersion: 1 }
  }
}

function writeState(updateRoot: string, state: SkillUpdateState): void {
  mkdirSync(updateRoot, { recursive: true, mode: 0o700 })
  const target = statePath(updateRoot)
  const temporary = `${target}.next-${randomUUID()}`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  })
  renameSync(temporary, target)
}

function normalizeBundledState(state: SkillUpdateState, bundledVersion: string): SkillUpdateState {
  const newer = (version: string | undefined): version is string => (
    version !== undefined && compareVersions(version, bundledVersion) > 0
  )
  const retainFailure = newer(state.failedVersion) && state.lastError !== undefined
  return {
    schemaVersion: 1,
    ...(newer(state.activeVersion) ? { activeVersion: state.activeVersion } : {}),
    ...(newer(state.downloadedVersion) ? { downloadedVersion: state.downloadedVersion } : {}),
    ...(newer(state.pendingVersion) ? { pendingVersion: state.pendingVersion } : {}),
    ...(newer(state.attemptingVersion) ? { attemptingVersion: state.attemptingVersion } : {}),
    ...(retainFailure ? { failedVersion: state.failedVersion, lastError: state.lastError } : {}),
    ...(state.lastSuccessVersion === undefined ? {} : { lastSuccessVersion: state.lastSuccessVersion }),
    ...(state.enabledAt === undefined ? {} : { enabledAt: state.enabledAt }),
  }
}

function hasSuccessfulActivationReceipt(transactionPath: string, version: string): boolean {
  const receiptPath = join(transactionPath, 'activation-receipt.json')
  if (!existsSync(receiptPath)) return false
  const info = lstatSync(receiptPath)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('技能包暂存成功回执无效')
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>
    if (receipt.schemaVersion !== 1 || receipt.skillBundleVersion !== version
      || typeof receipt.indexSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(receipt.indexSha256)) {
      throw new Error('技能包暂存成功回执内容无效')
    }
  } catch (error) {
    if (error instanceof Error && error.message === '技能包暂存成功回执内容无效') throw error
    throw new Error('技能包暂存成功回执无法读取', { cause: error })
  }
  return true
}

/** Return successful or superseded staging transactions, never installed rollback versions. */
export function reconciledSkillUpdateStagingPaths(updateRoot: string, activeVersion: string): string[] {
  if (!VERSION_PATTERN.test(activeVersion)) throw new Error('当前技能包版本号无效')
  const targets: string[] = []
  const staging = join(updateRoot, 'staging')
  if (!existsSync(staging)) return targets
  const info = lstatSync(staging)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('技能包暂存目录无效')
  for (const entry of readdirSync(staging, { withFileTypes: true })) {
    const version = STAGING_TRANSACTION_PATTERN.exec(entry.name)?.[1]
    if (version === undefined || compareVersions(version, activeVersion) > 0) continue
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`技能包暂存项不是目录：${entry.name}`)
    const transactionPath = join(staging, entry.name)
    if (compareVersions(version, activeVersion) < 0 || hasSuccessfulActivationReceipt(transactionPath, version)) {
      targets.push(transactionPath)
    }
  }
  return targets
}

/** Move reconciled staging transactions through the operating system's recoverable trash. */
export async function trashReconciledSkillUpdateStaging(
  updateRoot: string,
  activeVersion: string,
  trashItem: (path: string) => Promise<void>,
): Promise<void> {
  for (const path of reconciledSkillUpdateStagingPaths(updateRoot, activeVersion)) await trashItem(path)
}

export function compareVersions(left: string, right: string): number {
  if (!VERSION_PATTERN.test(left) || !VERSION_PATTERN.test(right)) throw new Error('技能包版本号无效')
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function normalizedFeedUrl(value: string | undefined): URL {
  const url = new URL(value?.trim() || DEFAULT_SKILL_UPDATE_FEED_URL)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('技能包更新源必须使用无凭据 HTTPS 地址')
  }
  url.hash = ''
  return url
}

export function parseSkillUpdateManifest(value: unknown, feedUrl: URL): SkillUpdateManifest {
  if (typeof value !== 'object' || value === null) throw new Error('技能包更新清单格式无效')
  const row = value as Record<string, unknown>
  if (row.schemaVersion !== 1 || row.productId !== 'cn.dongjian.desktop'
    || typeof row.skillBundleVersion !== 'string' || !VERSION_PATTERN.test(row.skillBundleVersion)
    || row.sourceReleaseTag !== `V${row.skillBundleVersion}`
    || typeof row.archiveUrl !== 'string' || typeof row.releaseNotes !== 'string') {
    throw new Error('技能包更新清单身份或版本无效')
  }
  const archive = new URL(row.archiveUrl, feedUrl)
  if (archive.protocol !== 'https:' || archive.username !== '' || archive.password !== ''
    || archive.origin !== feedUrl.origin) {
    throw new Error('技能包下载地址必须与更新源同源且使用 HTTPS')
  }
  return Object.freeze({
    schemaVersion: 1,
    productId: 'cn.dongjian.desktop',
    skillBundleVersion: row.skillBundleVersion,
    sourceReleaseTag: row.sourceReleaseTag,
    archiveUrl: archive.href,
    releaseNotes: row.releaseNotes.slice(0, 8_000),
  })
}

function safeArchivePath(value: string, type: 'File' | 'Directory'): string | undefined {
  if (value === '' || value.includes('\\') || value.includes('\0') || isAbsolute(value)) return undefined
  const withoutDirectoryMarker = type === 'Directory' && value.endsWith('/') ? value.slice(0, -1) : value
  const normalized = posix.normalize(withoutDirectoryMarker)
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')
    || normalized.startsWith('/') || normalized !== withoutDirectoryMarker
    || normalized.split('/').some(part => part === '' || part === '..')) return undefined
  if (normalized === 'skills') return type === 'Directory' ? normalized : undefined
  const allowedRootFile = ['skill-bundle-index.json', 'skill-bundle-index.sig', 'skill-bundle-index.pub.pem', 'staging-receipt.json'].includes(normalized)
  if ((allowedRootFile && type !== 'File') || (!allowedRootFile && !normalized.startsWith('skills/'))) return undefined
  return normalized
}

function zipEntryIsSymbolicLink(entry: {
  readonly externalFileAttributes?: number
  readonly versionMadeBy?: number
}): boolean {
  const madeBy = entry.versionMadeBy
  const attributes = entry.externalFileAttributes
  if (madeBy === undefined || attributes === undefined) return false
  const origin = madeBy >>> 8
  if (origin !== 3 && origin !== 19) return false
  return (((attributes >>> 16) & 0o170000) === 0o120000)
}

async function extractSkillArchive(archiveBytes: Buffer, destination: string): Promise<void> {
  const { Open } = await import('unzipper')
  const archive = await Open.buffer(archiveBytes)
  if (archive.files.length === 0 || archive.files.length > MAX_ARCHIVE_ENTRIES) throw new Error('技能包压缩文件数量异常')
  let expandedBytes = 0
  const paths = new Set<string>()
  for (const entry of archive.files) {
    const relative = safeArchivePath(entry.path, entry.type)
    if (relative === undefined) throw new Error(`技能包包含不安全路径：${entry.path}`)
    if (zipEntryIsSymbolicLink(entry)) throw new Error(`技能包包含符号链接：${entry.path}`)
    if (paths.has(relative)) throw new Error(`技能包包含重复路径：${entry.path}`)
    paths.add(relative)
    const expectedBytes = entry.uncompressedSize ?? 0
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new Error('技能包文件大小无效')
    expandedBytes += expectedBytes
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('技能包解压后体积超过限制')
    const target = resolve(destination, ...relative.split('/'))
    const rootPrefix = `${resolve(destination)}${sep}`
    if (!target.startsWith(rootPrefix)) throw new Error('技能包路径越出更新目录')
    if (entry.type === 'Directory') {
      mkdirSync(target, { recursive: true, mode: 0o700 })
      continue
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    await pipeline(entry.stream(), createWriteStream(target, { flags: 'wx', mode: 0o600 }))
    if (statSync(target).size !== expectedBytes) throw new Error(`技能包文件解压大小不一致：${entry.path}`)
  }
}

function verifiedExternalBundle(updateRoot: string, version: string, trustAnchor: SkillSuiteTrustAnchor): VerifiedSkillSuite {
  if (!VERSION_PATTERN.test(version)) throw new Error('技能包版本号无效')
  const root = versionPath(updateRoot, version)
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new Error('已下载技能包目录不可用')
  }
  const verified = verifyStagedSkillSuite(root, trustAnchor)
  if (verified.version !== version) throw new Error('技能包目录与签名版本不一致')
  return verified
}

/** Resolve the bundled or active external suite and stage a pending one-way update. */
export function resolveSkillBundleForLaunch(
  bundledPath: string,
  updateRoot: string,
  trustAnchor: SkillSuiteTrustAnchor,
): SkillBundleLaunchSelection {
  const bundled = verifyStagedSkillSuite(bundledPath, trustAnchor)
  const persistedState = readState(updateRoot)
  let state = persistedState
  // `attemptingVersion` is the prepare record of a two-phase launch. Only
  // `commitSkillBundleLaunch` may clear it after the full runtime is ready;
  // finding it on the next process means that activation never committed.
  if (state.attemptingVersion !== undefined) {
    const attemptedVersion = state.attemptingVersion
    state = {
      schemaVersion: 1,
      failedVersion: attemptedVersion,
      lastError: `技能包 V${attemptedVersion} 启用失败，请重新下载安装`,
      ...(state.lastSuccessVersion === undefined ? {} : { lastSuccessVersion: state.lastSuccessVersion }),
      ...(state.enabledAt === undefined ? {} : { enabledAt: state.enabledAt }),
    }
    writeState(updateRoot, state)
  }
  const normalized = normalizeBundledState(state, bundled.version)
  state = normalized

  let selectedPath = bundledPath
  let selected = bundled
  let selectedExternal = false
  if (state.activeVersion !== undefined && compareVersions(state.activeVersion, bundled.version) > 0) {
    try {
      selected = verifiedExternalBundle(updateRoot, state.activeVersion, trustAnchor)
      selectedPath = versionPath(updateRoot, state.activeVersion)
      selectedExternal = true
    } catch (error) {
      state = {
        schemaVersion: 1,
        ...(state.downloadedVersion === undefined ? {} : { downloadedVersion: state.downloadedVersion }),
        ...(state.pendingVersion === undefined ? {} : { pendingVersion: state.pendingVersion }),
        failedVersion: state.activeVersion,
        lastError: error instanceof Error ? error.message : String(error),
        ...(state.lastSuccessVersion === undefined ? {} : { lastSuccessVersion: state.lastSuccessVersion }),
        ...(state.enabledAt === undefined ? {} : { enabledAt: state.enabledAt }),
      }
      writeState(updateRoot, state)
    }
  } else if (state.activeVersion !== undefined) {
    state = {
      schemaVersion: 1,
      ...(state.downloadedVersion === undefined ? {} : { downloadedVersion: state.downloadedVersion }),
      ...(state.pendingVersion === undefined ? {} : { pendingVersion: state.pendingVersion }),
      ...(state.failedVersion === undefined ? {} : { failedVersion: state.failedVersion }),
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
      ...(state.lastSuccessVersion === undefined ? {} : { lastSuccessVersion: state.lastSuccessVersion }),
      ...(state.enabledAt === undefined ? {} : { enabledAt: state.enabledAt }),
    }
  }

  const pendingVersion = state.pendingVersion
  if (pendingVersion === undefined) {
    return {
      path: selectedPath, verified: selected, bundledVersion: bundled.version, pendingActivation: false,
    }
  }
  if (compareVersions(pendingVersion, selected.version) <= 0) {
    return {
      path: selectedPath, verified: selected, bundledVersion: bundled.version, pendingActivation: false,
    }
  }
  try {
    const verified = verifiedExternalBundle(updateRoot, pendingVersion, trustAnchor)
    writeState(updateRoot, {
      schemaVersion: 1,
      ...(selectedExternal ? { activeVersion: selected.version } : {}),
      pendingVersion,
      attemptingVersion: pendingVersion,
      ...(state.lastSuccessVersion === undefined ? {} : { lastSuccessVersion: state.lastSuccessVersion }),
      ...(state.enabledAt === undefined ? {} : { enabledAt: state.enabledAt }),
    })
    return {
      path: versionPath(updateRoot, pendingVersion), verified,
      bundledVersion: bundled.version,
      pendingActivation: true,
    }
  } catch (error) {
    writeState(updateRoot, {
      schemaVersion: 1,
      ...(selectedExternal ? { activeVersion: selected.version } : {}),
      failedVersion: pendingVersion,
      lastError: error instanceof Error ? error.message : String(error),
      ...(state.lastSuccessVersion === undefined ? {} : { lastSuccessVersion: state.lastSuccessVersion }),
      ...(state.enabledAt === undefined ? {} : { enabledAt: state.enabledAt }),
    })
    return {
      path: selectedPath, verified: selected, bundledVersion: bundled.version, pendingActivation: false,
    }
  }
}

/** Commit a bundle only after the complete DSH runtime has started successfully. */
export function commitSkillBundleLaunch(
  updateRoot: string,
  selection: SkillBundleLaunchSelection,
  enabledAt = new Date().toISOString(),
): void {
  const state = readState(updateRoot)
  const version = selection.verified.version
  if (selection.pendingActivation && (state.pendingVersion !== version || state.attemptingVersion !== version
    || resolve(selection.path) !== resolve(versionPath(updateRoot, version)))) {
    throw new Error('技能包待启用状态与启动结果不一致')
  }
  const retainDownload = state.downloadedVersion !== undefined
    && compareVersions(state.downloadedVersion, version) > 0
  const retainFailure = state.failedVersion !== undefined && state.lastError !== undefined
    && compareVersions(state.failedVersion, version) > 0
  const reconciled: SkillUpdateState = {
    schemaVersion: 1,
    ...(compareVersions(version, selection.bundledVersion) > 0 ? { activeVersion: version } : {}),
    ...(retainDownload ? { downloadedVersion: state.downloadedVersion } : {}),
    ...(retainFailure ? { failedVersion: state.failedVersion, lastError: state.lastError } : {}),
    lastSuccessVersion: version,
    enabledAt: state.lastSuccessVersion === version && state.enabledAt !== undefined ? state.enabledAt : enabledAt,
  }
  if (JSON.stringify(reconciled) !== JSON.stringify(state)) writeState(updateRoot, reconciled)
}

export class SkillUpdaterController {
  private readonly feedUrl: URL
  private readonly fetchImpl: typeof fetch
  private latest: SkillUpdateManifest | null = null

  constructor(private readonly options: SkillUpdaterOptions) {
    if (!VERSION_PATTERN.test(options.activeVersion)) throw new Error('当前技能包版本号无效')
    this.feedUrl = normalizedFeedUrl(options.feedUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  current(): SkillUpdateSnapshot {
    const state = readState(this.options.updateRoot)
    const downloadedVersion = state.downloadedVersion !== undefined
      && compareVersions(state.downloadedVersion, this.options.activeVersion) > 0
      ? state.downloadedVersion
      : undefined
    return this.snapshot(
      downloadedVersion === undefined ? 'current' : 'downloaded',
      downloadedVersion === undefined
        ? `当前技能包 V${this.options.activeVersion}`
        : `技能包 V${downloadedVersion} 已下载，可重启启用`,
      downloadedVersion ?? null,
      null,
    )
  }

  async check(): Promise<SkillUpdateSnapshot> {
    try {
      const response = await this.fetchImpl(this.feedUrl, {
        headers: { accept: 'application/json' }, redirect: 'error',
      })
      if (response.status === 404) {
        this.latest = null
        // A missing feed says nothing about the latest release or local activation.
        return this.snapshot('error', '技能包更新源暂不可用，请稍后重试', null, null)
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (response.url !== '' && new URL(response.url).origin !== this.feedUrl.origin) {
        throw new Error('技能包更新清单响应与更新源不同源')
      }
      const manifest = parseSkillUpdateManifest(await response.json(), this.feedUrl)
      this.latest = manifest
      return compareVersions(manifest.skillBundleVersion, this.options.activeVersion) > 0
        ? this.snapshot('available', `发现技能包 V${manifest.skillBundleVersion}`, manifest.skillBundleVersion, manifest.releaseNotes)
        : this.snapshot('current', '当前技能包已是最新版本', manifest.skillBundleVersion, manifest.releaseNotes)
    } catch {
      return this.snapshot('error', '检查技能包更新失败，请确认网络后重试', null, null)
    }
  }

  async download(): Promise<SkillUpdateSnapshot> {
    const manifest = this.latest
    if (manifest === null || compareVersions(manifest.skillBundleVersion, this.options.activeVersion) <= 0) {
      return this.snapshot('error', '请先检查技能包更新', null, null)
    }
    const staging = join(this.options.updateRoot, 'staging', `${manifest.skillBundleVersion}-${randomUUID()}`)
    try {
      mkdirSync(staging, { recursive: true, mode: 0o700 })
      const response = await this.fetchImpl(manifest.archiveUrl, {
        headers: { accept: 'application/zip' }, redirect: 'error',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (response.url !== '' && new URL(response.url).origin !== this.feedUrl.origin) {
        throw new Error('技能包下载响应与更新源不同源')
      }
      const advertised = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(advertised) && advertised > MAX_ARCHIVE_BYTES) throw new Error('技能包压缩文件超过限制')
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES) throw new Error('技能包压缩文件大小异常')
      const extracted = join(staging, 'extracted')
      mkdirSync(extracted, { recursive: true, mode: 0o700 })
      await extractSkillArchive(bytes, extracted)
      const verified = verifyStagedSkillSuite(extracted, this.options.trustAnchor)
      if (verified.version !== manifest.skillBundleVersion || verified.sourceReleaseTag !== manifest.sourceReleaseTag) {
        throw new Error('下载内容与更新清单版本不一致')
      }
      const target = versionPath(this.options.updateRoot, verified.version)
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      if (existsSync(target)) {
        const existing = verifiedExternalBundle(this.options.updateRoot, verified.version, this.options.trustAnchor)
        if (existing.indexSha256 !== verified.indexSha256) {
          throw new Error(`技能包 V${verified.version} 已存在不同的签名内容`)
        }
      } else {
        renameSync(extracted, target)
      }
      writeFileSync(join(staging, 'activation-receipt.json'), `${JSON.stringify({
        schemaVersion: 1,
        skillBundleVersion: verified.version,
        indexSha256: verified.indexSha256,
        preparedAt: new Date().toISOString(),
      }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      const prior = readState(this.options.updateRoot)
      writeState(this.options.updateRoot, { ...prior, downloadedVersion: verified.version })
      return this.snapshot('downloaded', `技能包 V${verified.version} 已下载，可重启启用`, verified.version, manifest.releaseNotes)
    } catch (error) {
      return this.snapshot('error', error instanceof Error ? error.message : '技能包下载失败', manifest.skillBundleVersion, manifest.releaseNotes)
    }
  }

  prepareInstall(): SkillUpdateSnapshot {
    const state = readState(this.options.updateRoot)
    if (state.downloadedVersion === undefined) return this.snapshot('error', '尚未完成技能包下载', null, null)
    if (state.pendingVersion !== undefined || state.attemptingVersion !== undefined) {
      return this.snapshot('error', '已有技能包正在等待启用', state.pendingVersion ?? state.attemptingVersion ?? null, null)
    }
    if (compareVersions(state.downloadedVersion, this.options.activeVersion) <= 0) {
      return this.snapshot('error', '不能重复安装或降级技能包', state.downloadedVersion, null)
    }
    try {
      verifiedExternalBundle(this.options.updateRoot, state.downloadedVersion, this.options.trustAnchor)
    } catch (error) {
      return this.snapshot(
        'error', error instanceof Error ? error.message : '已下载技能包不可用', state.downloadedVersion, null,
      )
    }
    const { downloadedVersion, failedVersion: _failedVersion, lastError: _lastError, ...remaining } = state
    writeState(this.options.updateRoot, { ...remaining, pendingVersion: downloadedVersion })
    return this.snapshot('downloaded', '正在重启并启用技能包更新', state.downloadedVersion, this.latest?.releaseNotes ?? null)
  }

  private snapshot(
    status: SkillUpdateStatus,
    message: string,
    latestVersion: string | null,
    releaseNotes: string | null,
  ): SkillUpdateSnapshot {
    return Object.freeze({
      status,
      currentVersion: this.options.activeVersion,
      latestVersion,
      message,
      releaseNotes,
    })
  }
}
