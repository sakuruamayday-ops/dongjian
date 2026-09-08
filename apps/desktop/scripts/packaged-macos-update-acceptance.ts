/** Exercise one exact packaged macOS update without touching the installed application or real user data. */

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID, verify } from 'node:crypto'
import {
  createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  statSync, writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { openDb } from '../../../packages/product/gongchuang-graph-memory/src/store/db.ts'
import { logPath, scanLog } from '../../../packages/session/session-persistence-jsonl/src/format.ts'
import {
  compressZstdFrame, createZstdFrameDecoder, scanZstdFrames,
} from '../../../packages/session/session-persistence-jsonl/src/zstd.ts'

const PRODUCT_ID = 'cn.dongjian.desktop'
const PRODUCT_NAME = '洞见'
const PRODUCT_APP_NAME = `${PRODUCT_NAME}.app`
const COOKIE_NAME = 'gongchuang_update_acceptance'
const MAC_UPDATE_HELPER_MARKER = '/dist/macos-update-helper.js'
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
const USER_STATE_CATEGORIES = [
  'credentials', 'enterpriseSpaces', 'sessions', 'archiveDeletePin', 'attachments',
  'modelConnections', 'skills', 'memory', 'automations',
] as const
const ACCEPTANCE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
)
type UserStateCategory = typeof USER_STATE_CATEGORIES[number]
type TargetKeychainAccess = 'required'

interface PersistedUserFixture {
  readonly trackedFiles: Readonly<Record<UserStateCategory, readonly string[]>>
  readonly graphMemoryDatabase: string
  readonly graphMemoryNodeName: string
  readonly expected: {
    readonly accountUsername: string
    readonly enterpriseRoot: string
    readonly activeWorkspaceId: string
    readonly deletedWorkspaceId: string
    readonly activeSessionId: string
    readonly activeSessionTitle: string
    readonly reusableBlankSessionId: string
    readonly archivedSessionId: string
    readonly archivedSessionTitle: string
    readonly deletedSessionId: string
    readonly customModelId: string
    readonly disabledSkillName: string
    readonly automationTaskId: string
  }
}

interface UserStateSnapshot {
  readonly fileDigests: Readonly<Record<UserStateCategory, string>>
  readonly sessionSemantics: Readonly<Record<string, string>>
  readonly archiveDeletePinSemantics: string
  readonly graphMemory: {
    readonly name: string
    readonly content: string
    readonly sourceSessions: string
  }
}

interface VisibleSessionTitles {
  readonly active: string
  readonly archived: string
}

interface ArgumentsValue {
  readonly architecture: 'arm64' | 'x64'
  readonly evidenceLog: string
  readonly receipt: string
  readonly sourceAppAsarSha256: string
  readonly sourceArchive: string
  readonly sourceArchiveSha256: string
  readonly sourceVersion: string
  readonly targetAppAsarSha256: string
  readonly targetArchive: string
  readonly targetArchiveSha256: string
  readonly targetKeychainAccess: TargetKeychainAccess
  readonly targetVersion: string
  readonly manifest: string
  readonly signature: string
}

interface ManifestArtifact {
  readonly architecture: 'arm64' | 'x64'
  readonly archiveUrl: string
  readonly bundleId: string
  readonly fileName: string
  readonly runtimeIndexSha256: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly skillBundleIndexSha256: string
}

interface SignedManifest {
  readonly schemaVersion: 1
  readonly productId: string
  readonly clientVersion: string
  readonly signingTier: string
  readonly sourceCommit: string
  readonly artifacts: readonly ManifestArtifact[]
}

interface Stage {
  readonly name: string
  readonly status: 'passed'
  readonly at: string
  readonly [name: string]: unknown
}

interface ProcessCleanupTargets {
  readonly applicationPids: readonly number[]
  readonly helperPids: readonly number[]
  readonly allPids: readonly number[]
}

interface ProcessCleanupReceipt extends ProcessCleanupTargets {
  readonly candidateApplicationRoots: readonly string[]
  readonly candidateExecutables: readonly string[]
  readonly helperJobPaths: readonly string[]
  readonly forceKilledPids: readonly number[]
}

interface DesktopBridge {
  checkForUpdates(): Promise<{
    readonly status: string
    readonly currentVersion: string
    readonly latestVersion: string | null
    readonly message: string
  }>
  downloadUpdate(): Promise<unknown>
  workspaceRootState(): Promise<{
    readonly rootPath: string
    readonly isDefault: boolean
    readonly needsInitialSetup: boolean
  }>
}

function usage(): string {
  return [
    'usage: packaged-macos-update-acceptance.ts',
    '  --source-archive <old.zip> --source-version <x.y.z> --source-archive-sha256 <sha256>',
    '  --source-app-asar-sha256 <sha256> --target-archive <new.zip> --target-version <x.y.z>',
    '  --target-archive-sha256 <sha256> --target-app-asar-sha256 <sha256>',
    '  --manifest <desktop-release-index.json> --signature <desktop-release-index.sig>',
    '  --target-keychain-access required',
    '  --arch <arm64|x64> --receipt <new.json> --evidence-log <new.log>',
  ].join('\n')
}

function argumentsValue(argv: readonly string[]): ArgumentsValue | null {
  if (argv.includes('--help') || argv.includes('-h')) return null
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === undefined || value === undefined || !key.startsWith('--')) throw new Error(usage())
    values.set(key.slice(2), value)
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim()
    if (value === undefined || value === '') throw new Error(`--${name} is required\n${usage()}`)
    return value
  }
  const version = (name: string): string => {
    const value = required(name)
    if (!VERSION_PATTERN.test(value)) throw new Error(`--${name} must be an exact semantic version`)
    return value
  }
  const sha256 = (name: string): string => {
    const value = required(name).toLowerCase()
    if (!SHA256_PATTERN.test(value)) throw new Error(`--${name} must be a lowercase SHA-256`)
    return value
  }
  const architecture = required('arch')
  if (architecture !== 'arm64' && architecture !== 'x64') throw new Error('--arch must be arm64 or x64')
  const targetKeychainAccess = required('target-keychain-access')
  if (targetKeychainAccess !== 'required') throw new Error('--target-keychain-access must be required')
  return Object.freeze({
    architecture,
    evidenceLog: resolve(required('evidence-log')),
    receipt: resolve(required('receipt')),
    sourceAppAsarSha256: sha256('source-app-asar-sha256'),
    sourceArchive: resolve(required('source-archive')),
    sourceArchiveSha256: sha256('source-archive-sha256'),
    sourceVersion: version('source-version'),
    targetAppAsarSha256: sha256('target-app-asar-sha256'),
    targetArchive: resolve(required('target-archive')),
    targetArchiveSha256: sha256('target-archive-sha256'),
    targetKeychainAccess,
    targetVersion: version('target-version'),
    manifest: resolve(required('manifest')),
    signature: resolve(required('signature')),
  })
}

function accountTestBoundary(targetKeychainAccess: TargetKeychainAccess): Readonly<Record<string, unknown>> {
  return Object.freeze({
    fixtureState: 'signed-out-with-saved-password',
    productionLoginAttempted: false,
    deviceBoundTokenVerified: false,
    signedInSessionRetained: false,
    targetKeychainAccess,
    savedCredentialRefsDecryptedByTarget: true,
    savedPasswordAvailableWithoutRetyping: true,
    systemKeychainAuthorizationDeferred: false,
    acceptedClaim: 'saved credentials are migrated into the frozen broker and remain available without retyping',
    reason: 'the target UI and the packaged native broker both read the exact retained credential values',
  })
}

export function compareSemanticVersions(left: string, right: string): number {
  assert(VERSION_PATTERN.test(left) && VERSION_PATTERN.test(right), 'semantic version comparison requires x.y.z')
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

function exactNewOutput(path: string, label: string): void {
  if (!resolve(path).startsWith(`${resolve(dirname(path))}/`) || !existsSync(dirname(path)) || existsSync(path)) {
    throw new Error(`${label} must be a new file below an existing directory`)
  }
}

function exactFile(path: string, label: string): void {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) throw new Error(`${label} must be a non-empty regular file`)
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function plist(appPath: string, key: string): string {
  return execFileSync(
    '/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(appPath, 'Contents', 'Info.plist')],
    { encoding: 'utf8' },
  ).trim()
}

function executableFilesBelow(root: string): string[] {
  if (!existsSync(root)) return []
  const executables: string[] = []
  const visit = (path: string): void => {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) {
      const target = statSync(path)
      if (target.isFile() && (target.mode & 0o111) !== 0) executables.push(path)
      return
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name))
    } else if (info.isFile() && (info.mode & 0o111) !== 0) executables.push(path)
  }
  visit(root)
  return executables
}

function packagedApplicationExecutables(appPath: string): string[] {
  const mainExecutable = join(appPath, 'Contents', 'MacOS', plist(appPath, 'CFBundleExecutable'))
  exactFile(mainExecutable, 'packaged application executable')
  const frameworks = join(appPath, 'Contents', 'Frameworks')
  const helpers: string[] = []
  if (existsSync(frameworks)) {
    for (const name of readdirSync(frameworks)) {
      if (!/ Helper(?: \(.+\))?\.app$/u.test(name)) continue
      const helperApp = join(frameworks, name)
      const info = lstatSync(helperApp)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      const executable = join(helperApp, 'Contents', 'MacOS', plist(helperApp, 'CFBundleExecutable'))
      exactFile(executable, `packaged Electron helper ${name}`)
      helpers.push(executable)
    }
  }
  const runtime = join(appPath, 'Contents', 'Resources', 'product', 'runtime')
  return [...new Set([
    mainExecutable,
    ...helpers,
    ...executableFilesBelow(frameworks),
    ...executableFilesBelow(runtime),
  ])].sort()
}

/** Map one extracted package inventory onto the app slot that may contain either release. */
export function mapPackagedExecutableInventory(
  inventoryAppPath: string,
  destinationAppPath: string,
  executables: readonly string[],
): string[] {
  return executables.map((executable) => {
    const relativePath = relative(inventoryAppPath, executable)
    assert(relativePath.startsWith('Contents/'), 'packaged executable escaped its inventory app')
    return join(destinationAppPath, relativePath)
  })
}

function packagedApplicationExecutablesForSlot(
  destinationAppPath: string,
  inventoryAppPaths: readonly string[],
): string[] {
  return [...new Set(inventoryAppPaths.flatMap(inventoryAppPath => mapPackagedExecutableInventory(
    inventoryAppPath,
    destinationAppPath,
    packagedApplicationExecutables(inventoryAppPath),
  )))].sort()
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function running(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isSafeInteger(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds) })
}

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== null && value !== undefined && value !== false) return value
    await delay(250)
  }
  throw new Error(`${label} timed out`)
}

function digestFiles(paths: readonly string[]): string {
  const digest = createHash('sha256')
  for (const path of [...paths].sort()) {
    exactFile(path, `retained user-state file ${path}`)
    digest.update(path)
    digest.update('\0')
    digest.update(readFileSync(path))
    digest.update('\0')
  }
  return digest.digest('hex')
}

export function sessionEventAffectsRetainedState(type: string): boolean {
  return type !== 'session/end-seed'
}

interface RetainedSessionSemantics {
  readonly meta: unknown
  readonly events: readonly { readonly type?: unknown; readonly data?: unknown }[]
}

function parseRetainedSessionSemantics(value: string): RetainedSessionSemantics {
  const parsed = JSON.parse(value) as Partial<RetainedSessionSemantics>
  assert(Array.isArray(parsed.events), 'retained session semantics must contain events')
  return { meta: parsed.meta, events: parsed.events }
}

/** Accept only DSH's one-time materialization of missing legacy permission facts. */
export function legacyPermissionFactsAreCompatible(beforeValue: string, afterValue: string): boolean {
  const before = parseRetainedSessionSemantics(beforeValue)
  const after = parseRetainedSessionSemantics(afterValue)
  if (JSON.stringify(before.meta) !== JSON.stringify(after.meta)) return false
  const permissionTypes = new Set(['permission/preset', 'sandbox/mode', 'approval/policy'])
  if (before.events.some(event => typeof event.type === 'string' && permissionTypes.has(event.type))) return false
  const suffix = [
    { type: 'permission/preset', data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    { type: 'approval/policy', data: { policy: 'ask' } },
  ]
  if (after.events.length !== before.events.length + suffix.length) return false
  if (JSON.stringify(after.events.slice(0, before.events.length)) !== JSON.stringify(before.events)) return false
  return after.events.slice(before.events.length).every((event, index) => (
    event.type === suffix[index]?.type && JSON.stringify(event.data) === JSON.stringify(suffix[index]?.data)
  ))
}

function digestSessionFiles(paths: readonly string[]): string {
  const digest = createHash('sha256')
  for (const path of [...paths].sort()) {
    const semantics = retainedSessionSemantics(path)
    digest.update(path)
    digest.update('\0')
    digest.update(semantics)
    digest.update('\0')
  }
  return digest.digest('hex')
}

function retainedSessionSemantics(path: string): string {
  exactFile(path, `retained session file ${path}`)
  const encoded = readFileSync(path)
  const frameScan = scanZstdFrames(encoded)
  assert(frameScan.tornStart === undefined, `retained session file is torn: ${path}`)
  const decoder = createZstdFrameDecoder()
  // 私有多帧解码器会在迭代间复用缓冲区，必须在推进到下一帧前复制当前明文。
  const decodedFrames: Buffer[] = []
  for (const frame of decoder.decode(encoded, frameScan.frames)) decodedFrames.push(Buffer.from(frame))
  const log = scanLog(Buffer.concat(decodedFrames))
  // 旧客户端每次重新打开会话都会追加 end-seed；它不改变正文，但其他事件仍必须逐项保持。
  return JSON.stringify({
    meta: log.meta,
    events: log.events.filter(event => sessionEventAffectsRetainedState(event.type)),
  })
}

function graphMemoryNode(fixture: PersistedUserFixture): UserStateSnapshot['graphMemory'] {
  const db = openDb(fixture.graphMemoryDatabase)
  try {
    const row = db.prepare(
      'SELECT name, content, source_sessions as sourceSessions FROM gm_nodes WHERE name = ?',
    ).get(fixture.graphMemoryNodeName) as UserStateSnapshot['graphMemory'] | undefined
    if (row === undefined) throw new Error('retained graph-memory node is missing')
    return row
  } finally {
    db.close()
  }
}

function captureUserState(fixture: PersistedUserFixture): UserStateSnapshot {
  const sessionSemantics = Object.freeze(Object.fromEntries(
    [...fixture.trackedFiles.sessions].sort().map(path => [path, retainedSessionSemantics(path)]),
  ))
  const fileDigests = Object.fromEntries(USER_STATE_CATEGORIES.map(category => [
    category,
    category === 'sessions'
      ? digestSessionFiles(fixture.trackedFiles[category])
      : digestFiles(fixture.trackedFiles[category]),
  ])) as Record<UserStateCategory, string>
  return Object.freeze({
    fileDigests: Object.freeze(fileDigests),
    sessionSemantics,
    archiveDeletePinSemantics: JSON.stringify(JSON.parse(
      readFileSync(fixture.trackedFiles.archiveDeletePin[0]!, 'utf8'),
    )),
    graphMemory: graphMemoryNode(fixture),
  })
}

function assertUserStateRetained(before: UserStateSnapshot, after: UserStateSnapshot): void {
  for (const category of USER_STATE_CATEGORIES) {
    if (before.fileDigests[category] === after.fileDigests[category]) continue
    if (category === 'archiveDeletePin') {
      throw new Error(`archiveDeletePin changed during update: ${JSON.stringify({
        before: before.archiveDeletePinSemantics,
        after: after.archiveDeletePinSemantics,
      })}`)
    }
    if (category !== 'sessions') throw new Error(`${category} changed during update`)
    const changed = [...new Set([
      ...Object.keys(before.sessionSemantics), ...Object.keys(after.sessionSemantics),
    ])].filter(path => before.sessionSemantics[path] !== after.sessionSemantics[path])
      .map(path => ({ path, before: before.sessionSemantics[path] ?? null, after: after.sessionSemantics[path] ?? null }))
    const incompatible = changed.filter(item => item.before === null || item.after === null
      || !legacyPermissionFactsAreCompatible(item.before, item.after))
    if (incompatible.length > 0) {
      throw new Error(`sessions changed during update: ${JSON.stringify(incompatible)}`)
    }
  }
  assert(JSON.stringify(before.graphMemory) === JSON.stringify(after.graphMemory), 'memory changed during update')
}

async function writeSessionLog(
  root: string,
  id: string,
  cwd: string,
  createdAt: number,
  events: readonly unknown[],
): Promise<string> {
  const path = logPath(root, cwd, id as never, 'zstd')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const header = await compressZstdFrame(`${JSON.stringify({
    type: 'session', version: 0, id, createdAt, cwd, delegationDepth: 0,
  })}\n`)
  const frames = events.length === 0
    ? [header]
    : [header, await compressZstdFrame(`${events.map(event => JSON.stringify(event)).join('\n')}\n`)]
  writeFileSync(path, Buffer.concat(frames), { mode: 0o600 })
  return path
}

function completeSessionEvents(
  title: string,
  text: string,
  createdAt: number,
  model: string,
  attachment?: { readonly sha256: string; readonly bytes: number },
): readonly unknown[] {
  const userContent: unknown[] = [{ type: 'text', text }]
  if (attachment !== undefined) {
    userContent.push({
      type: 'image',
      attachment: {
        attachmentId: `sha256:${attachment.sha256}`,
        mediaType: 'image/png', bytes: attachment.bytes, width: 1, height: 1,
        name: 'update-retained.png',
      },
    })
  }
  return [
    // 跨版本夹具使用 V0.3.3 与当前 Harness 都接受的最小事件形状；不要用新版投影字段回填旧包。
    {
      type: 'turn/start', seq: 0, time: createdAt + 1,
      data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user', rpcId: 'update-acceptance' } } },
    },
    {
      type: 'user/message', seq: 1, time: createdAt + 2, surfaceOp: 'append',
      data: {
        source: { kind: 'user', rpcId: 'update-acceptance' }, content: userContent,
      },
    },
    {
      type: 'session/title', seq: 2, time: createdAt + 3,
      data: { title, messageSeqs: [1], source: { kind: 'fallback' } },
    },
    { type: 'step/start', seq: 3, time: createdAt + 4, data: { turn: 1, step: 0 } },
    {
      type: 'assistant/message', seq: 4, time: createdAt + 5, surfaceOp: 'append',
      data: {
        turn: 1, step: 0,
        message: {
          id: `update-acceptance-assistant-${createHash('sha256').update(title).digest('hex').slice(0, 12)}`,
          role: 'assistant',
          content: [{ type: 'text', text: `${title}内容` }],
          source: { kind: 'model', provider: 'custom-api', model },
        },
      },
    },
    { type: 'step/end', seq: 5, time: createdAt + 6, data: { turn: 1, step: 0 } },
    { type: 'turn/end', seq: 6, time: createdAt + 7, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

async function stagePersistedUserState(
  userDataRoot: string,
  enterpriseRoot: string,
  modelBaseURL: string,
  accountUsername: string,
): Promise<PersistedUserFixture> {
  const runtimeRoot = join(userDataRoot, 'runtime')
  const storageRoot = join(runtimeRoot, 'storages')
  const sessionsRoot = join(runtimeRoot, 'sessions')
  const attachmentRoot = join(runtimeRoot, 'attachments', 'v1')
  const skillMarketplaceRoot = join(userDataRoot, 'skill-marketplace')
  const graphMemoryRoot = join(runtimeRoot, 'graph-memory')
  const automationsRoot = join(userDataRoot, 'automations')
  const credentialStore = join(userDataRoot, 'credentials.secure.v1.json')
  const workspaceSettings = join(userDataRoot, 'enterprise-workspace-root.json')
  const settingsFile = join(runtimeRoot, 'settings.yaml')
  const workspaceState = join(storageRoot, 'workspace.json')
  const skillRegistry = join(skillMarketplaceRoot, 'registry.json')
  const graphPreferences = join(graphMemoryRoot, 'preferences.json')
  const automationRegistry = join(automationsRoot, 'registry.json')
  const activeWorkspaceId = '00000000-0000-4000-8000-000000000041'
  const archivedWorkspaceId = '00000000-0000-4000-8000-000000000042'
  const deletedWorkspaceId = '00000000-0000-4000-8000-000000000043'
  const activeSessionId = 'update-acceptance-active-session'
  const reusableBlankSessionId = 'update-acceptance-reusable-blank-session'
  const archivedSessionId = 'update-acceptance-archived-session'
  const deletedSessionId = 'update-acceptance-deleted-session'
  const customModelId = 'update-acceptance-model'
  const disabledSkillName = 'update-retention-community-skill'
  const installedSkillSource = [
    '---',
    `name: ${disabledSkillName}`,
    'description: 跨版本更新保留验收技能。',
    '---',
    '',
    '# 更新保留验收',
    '',
    '这个社区技能保持停用，用于验证技能注册表与安装文件不会在更新中丢失。',
    '',
  ].join('\n')
  const installedSkillArchive = zipSync({
    [`${disabledSkillName}/SKILL.md`]: new TextEncoder().encode(installedSkillSource),
  })
  const installedSkillDigest = createHash('sha256').update(installedSkillArchive).digest('hex')
  const installedSkillId = `skillhub-${disabledSkillName}-${installedSkillDigest.slice(0, 12)}`
  const installedSkillDirectory = join(skillMarketplaceRoot, 'installed', installedSkillId)
  const installedSkillFile = join(installedSkillDirectory, 'SKILL.md')
  const automationTaskId = `automation-${randomUUID()}`
  const graphMemoryNodeName = '更新保留验收记忆'
  const graphMemoryDatabase = join(
    graphMemoryRoot,
    `enterprise-${createHash('sha256').update(activeWorkspaceId).digest('hex').slice(0, 24)}.db`,
  )
  const now = Date.now()
  const iso = new Date(now).toISOString()
  const activeWorkspace = join(enterpriseRoot, 'active')
  const archivedWorkspace = join(enterpriseRoot, 'archived')
  const deletedWorkspace = join(enterpriseRoot, 'deleted')
  for (const path of [
    userDataRoot, runtimeRoot, storageRoot, sessionsRoot, attachmentRoot, skillMarketplaceRoot,
    graphMemoryRoot, automationsRoot, installedSkillDirectory, activeWorkspace, archivedWorkspace, deletedWorkspace,
  ]) mkdirSync(path, { recursive: true, mode: 0o700 })

  // WorkspaceRegistry canonicalizes Session cwd values. Build every persisted
  // path from the same realpath so the released source accepts the membership.
  const canonicalEnterpriseRoot = realpathSync(enterpriseRoot)
  const canonicalActiveWorkspace = realpathSync(activeWorkspace)
  const canonicalArchivedWorkspace = realpathSync(archivedWorkspace)
  const canonicalDeletedWorkspace = realpathSync(deletedWorkspace)

  const enterpriseSentinels = [
    join(activeWorkspace, 'active-retained.txt'),
    join(archivedWorkspace, 'archived-retained.txt'),
    join(deletedWorkspace, 'deleted-retained.txt'),
  ]
  writeFileSync(enterpriseSentinels[0]!, 'active enterprise file retained\n', { mode: 0o600 })
  writeFileSync(enterpriseSentinels[1]!, 'archived enterprise file retained\n', { mode: 0o600 })
  writeFileSync(enterpriseSentinels[2]!, 'deleted enterprise file retained\n', { mode: 0o600 })
  writeFileSync(workspaceSettings, `${JSON.stringify({
    schemaVersion: 1, rootPath: canonicalEnterpriseRoot, selection: 'custom',
  })}\n`, { mode: 0o600 })

  const attachmentSha256 = createHash('sha256').update(ACCEPTANCE_PNG).digest('hex')
  const attachmentObject = join(attachmentRoot, 'objects', attachmentSha256.slice(0, 2), attachmentSha256)
  mkdirSync(dirname(attachmentObject), { recursive: true, mode: 0o700 })
  writeFileSync(attachmentObject, ACCEPTANCE_PNG, { mode: 0o400 })
  const sessionLogs = await Promise.all([
    writeSessionLog(
      sessionsRoot, activeSessionId, canonicalActiveWorkspace, now,
      completeSessionEvents('更新保留会话', '更新后保留这段会话内容', now, customModelId, {
        sha256: attachmentSha256, bytes: ACCEPTANCE_PNG.length,
      }),
    ),
    writeSessionLog(
      sessionsRoot, archivedSessionId, canonicalArchivedWorkspace, now + 10,
      completeSessionEvents('已归档验收会话', '这段归档会话必须保留', now + 10, customModelId),
    ),
    writeSessionLog(
      sessionsRoot, deletedSessionId, canonicalActiveWorkspace, now + 20,
      completeSessionEvents('已删除验收会话', '这段删除记录在旧版状态中必须保留', now + 20, customModelId),
    ),
    // 在用旧客户端会为当前企业空间保留一条可复用空白会话。
    // 跨版验收必须预置并跟踪它，否则新版的正常首屏选中会被误报为数据污染。
    writeSessionLog(sessionsRoot, reusableBlankSessionId, canonicalActiveWorkspace, now + 30, []),
  ])

  const record = (path: string, title: string, sessionIds: readonly string[], pinnedSessionIds: readonly string[]) => ({
    path, title, sessionIds, pinnedSessionIds, createdAt: iso, updatedAt: iso,
  })
  writeFileSync(workspaceState, `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: [activeWorkspaceId, archivedWorkspaceId, deletedWorkspaceId],
      archivedWorkspaceIds: [archivedWorkspaceId],
      deletedWorkspaceIds: [deletedWorkspaceId],
      archivedSessionIds: [archivedSessionId],
      deletedSessionIds: [deletedSessionId],
    },
    tables: {
      workspaces: {
        [activeWorkspaceId]: record(
          canonicalActiveWorkspace, '更新验收企业',
          [reusableBlankSessionId, activeSessionId, deletedSessionId], [activeSessionId],
        ),
        [archivedWorkspaceId]: record(canonicalArchivedWorkspace, '已归档企业', [archivedSessionId], []),
        [deletedWorkspaceId]: record(canonicalDeletedWorkspace, '已删除企业', [], []),
      },
    },
  }, null, 2)}\n`, { mode: 0o600 })

  writeFileSync(settingsFile, [
    // 跨版本升级对象是已经完成首次设置的在用客户端。若这里保留首次设置态，
    // 升级验收会错误地先触发“新建会话”，把旧版模型故障混入更新链路。
    'gongchuang-connectors:',
    '  enabled: []',
    '  region: hangzhou',
    '  regionConfirmed: true',
    '  custom: []',
    'llm-pi-ai:',
    '  providers:',
    '    custom-api:',
    '      apiKeyEnv: GONGCHUANG_CUSTOM_API_ACCEPTANCE',
    '      displayName: 升级验收模型',
    '      api: openai-completions',
    `      baseURL: ${modelBaseURL}`,
    '      models:',
    `        - id: ${customModelId}`,
    '          name: 升级验收模型',
    '          contextWindow: 8192',
    '          maxTokens: 1024',
    '          input: [text]',
    '          reasoningEfforts: false',
    '',
  ].join('\n'), { mode: 0o600 })
  writeFileSync(installedSkillFile, installedSkillSource, { mode: 0o600 })
  writeFileSync(skillRegistry, `${JSON.stringify({
    schemaVersion: 1,
    installed: [{
      id: installedSkillId,
      name: disabledSkillName,
      description: '跨版本更新保留验收技能。',
      category: '验收',
      enabled: true,
      source: 'skillhub',
      coordinate: '@gongchuang-acceptance/update-retention-community-skill',
      version: '1.0.0',
      digest: installedSkillDigest,
      installedAt: iso,
      bundled: false,
      integrity: 'community-install',
      directory: installedSkillDirectory,
      detailUrl: 'https://skillhub.cn/skills/gongchuang-acceptance/update-retention-community-skill',
      license: '未标注',
      requiresConfiguration: false,
      metadata: {
        upstream: 'https://skillhub.cn/skills/gongchuang-acceptance/update-retention-community-skill',
        license: 'unreported',
        requiresConfiguration: false,
        checks: ['installed'],
      },
    }],
    repositories: [],
    disabledSkillNames: [disabledSkillName],
  }, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(graphPreferences, `${JSON.stringify({
    schemaVersion: 1, enabled: false, includeToolResults: false, updatedAt: iso,
  }, null, 2)}\n`, { mode: 0o600 })
  const graphDb = openDb(graphMemoryDatabase)
  try {
    graphDb.prepare(`INSERT INTO gm_nodes
      (id, type, name, description, content, status, validated_count, source_sessions, created_at, updated_at)
      VALUES (?, 'EVENT', ?, ?, ?, 'active', 1, ?, ?, ?)`)
      .run(
        `n-${randomUUID()}`, graphMemoryNodeName, '跨版本更新保留验收',
        '这条本地长期记忆必须在更新与失败恢复后保持不变',
        JSON.stringify([`dsh:${activeSessionId}`]), now, now,
      )
  } finally {
    graphDb.close()
  }
  writeFileSync(automationRegistry, `${JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    tasks: [{
      id: automationTaskId,
      templateId: null,
      name: '更新保留验收任务',
      prompt: '保留这条停用的自动化任务，不执行网络请求',
      workspaceId: activeWorkspaceId,
      conversationSessionId: activeSessionId,
      everySeconds: 86_400,
      cadenceLabel: '每 24 小时',
      enabled: false,
      scheduleAnchorAt: iso,
      nextRunAt: null,
      createdAt: iso,
      updatedAt: iso,
    }],
    runs: [],
  }, null, 2)}\n`, { mode: 0o600 })

  return Object.freeze({
    trackedFiles: Object.freeze({
      credentials: [credentialStore],
      enterpriseSpaces: [workspaceSettings, ...enterpriseSentinels],
      sessions: sessionLogs,
      archiveDeletePin: [workspaceState],
      attachments: [attachmentObject],
      modelConnections: [settingsFile],
      skills: [skillRegistry, installedSkillFile],
      memory: [graphPreferences],
      automations: [automationRegistry],
    }),
    graphMemoryDatabase,
    graphMemoryNodeName,
    expected: Object.freeze({
      accountUsername, enterpriseRoot: canonicalEnterpriseRoot, activeWorkspaceId, deletedWorkspaceId,
      activeSessionId, activeSessionTitle: '更新保留会话', reusableBlankSessionId,
      archivedSessionId, archivedSessionTitle: '已归档验收会话',
      deletedSessionId, customModelId, disabledSkillName, automationTaskId,
    }),
  })
}

function processTable(): string {
  // 临时根目录、中文产品名和 Helper 参数叠加后会超过 ps 默认列宽；截断会让仍存活的受控进程看似“身份不符”。
  return execFileSync('/bin/ps', ['-ww', '-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
}

function containsExactArgument(command: string, value: string): boolean {
  let index = command.indexOf(value)
  while (index >= 0) {
    const before = command[index - 1]
    const after = command[index + value.length]
    const boundary = (character: string | undefined): boolean => (
      character === undefined || /\s|["']/u.test(character)
    )
    if (boundary(before) && boundary(after)) return true
    index = command.indexOf(value, index + 1)
  }
  return false
}

function macTemporaryPathAliases(path: string): readonly string[] {
  const aliases = new Set([path])
  // Launch Services 会把 /var 的同一 APFS 对象记录为 /private/var；两种拼写必须同时参与精确身份匹配。
  if (path.startsWith('/var/')) aliases.add(`/private${path}`)
  else if (path.startsWith('/private/var/')) aliases.add(path.slice('/private'.length))
  try { aliases.add(realpathSync(path)) } catch { /* Test fixtures and trashed paths may no longer exist. */ }
  return [...aliases]
}

/**
 * Select only the two drill applications and helpers carrying one discovered drill job path.
 * @param output - Exact `ps -ax -o pid=,command=` output.
 * @param candidateExecutables - Absolute executable paths below the current drill root.
 * @param helperJobPaths - Absolute transaction job paths discovered below the current drill root.
 * @param candidateApplicationRoots - Exact drill app roots; a first executable below one is owned.
 * @returns Detached process ids that the drill owns and may terminate.
 */
export function packagedUpdateProcessTargets(
  output: string,
  candidateExecutables: readonly string[],
  helperJobPaths: readonly string[],
  candidateApplicationRoots: readonly string[] = [],
): ProcessCleanupTargets {
  const applicationRootAliases = candidateApplicationRoots.flatMap(macTemporaryPathAliases)
  const executableAliases = candidateExecutables.flatMap(macTemporaryPathAliases)
  const helperJobPathAliases = helperJobPaths.flatMap(macTemporaryPathAliases)
  const boundedExecutables = candidateApplicationRoots.length === 0
    ? executableAliases
    : executableAliases.filter(executable => applicationRootAliases.some(
      root => executable.startsWith(`${root}/`),
    ))
  const applicationPids = new Set<number>()
  const helperPids = new Set<number>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 1) continue
    const command = match[2]
    const exactExecutable = boundedExecutables.some(value => (
      command === value || command.startsWith(`${value} `)
    ))
    if (!exactExecutable) continue
    applicationPids.add(pid)
    if (command.includes(MAC_UPDATE_HELPER_MARKER)
      && helperJobPathAliases.some(jobPath => containsExactArgument(command, jobPath))) {
      helperPids.add(pid)
    }
  }
  const application = [...applicationPids].sort((left, right) => left - right)
  const helpers = [...helperPids].sort((left, right) => left - right)
  return Object.freeze({
    applicationPids: Object.freeze(application),
    helperPids: Object.freeze(helpers),
    allPids: Object.freeze([...new Set([...application, ...helpers])].sort((left, right) => left - right)),
  })
}

function processIdsForPackagedApplication(
  executables: readonly string[],
  helperJobPaths: readonly string[],
  applicationRoots: readonly string[],
): number[] {
  return [...packagedUpdateProcessTargets(
    processTable(), executables, helperJobPaths, applicationRoots,
  ).applicationPids]
}

function signalPackagedProcessIfOwned(
  pid: number,
  signal: NodeJS.Signals,
  candidateExecutables: readonly string[],
  helperJobPaths: readonly string[],
  candidateApplicationRoots: readonly string[] = [],
): boolean {
  const current = packagedUpdateProcessTargets(
    processTable(), candidateExecutables, helperJobPaths, candidateApplicationRoots,
  )
  if (!current.allPids.includes(pid)) return false
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

function transactionJobPaths(transactionRoots: readonly string[]): string[] {
  return transactionRoots.flatMap((root) => {
    if (!existsSync(root)) return []
    return readdirSync(root).flatMap((name) => {
      if (!name.endsWith('.json') || name.endsWith('.state.json')) return []
      const path = join(root, name)
      try {
        const info = lstatSync(path)
        return info.isFile() && !info.isSymbolicLink() ? [path] : []
      } catch {
        return []
      }
    })
  }).sort()
}

async function waitForNoPackagedProcesses(
  candidateExecutables: readonly string[],
  candidateApplicationRoots: readonly string[],
  transactionRoots: readonly string[],
  timeoutMs: number,
): Promise<ProcessCleanupTargets | null> {
  const deadline = Date.now() + timeoutMs
  let emptySince: number | undefined
  while (Date.now() < deadline) {
    const targets = packagedUpdateProcessTargets(
      processTable(), candidateExecutables, transactionJobPaths(transactionRoots), candidateApplicationRoots,
    )
    if (targets.allPids.length === 0) {
      emptySince ??= Date.now()
      if (Date.now() - emptySince >= 1_000) return targets
    } else emptySince = undefined
    await delay(250)
  }
  return null
}

async function terminatePackagedDrillProcesses(
  candidateExecutables: readonly string[],
  candidateApplicationRoots: readonly string[],
  transactionRoots: readonly string[],
): Promise<ProcessCleanupReceipt> {
  const executables = [...new Set(candidateExecutables)].sort()
  const applicationRoots = [...new Set(candidateApplicationRoots)].sort()
  const observedApplicationPids = new Set<number>()
  const observedHelperPids = new Set<number>()
  const forceKilledPids = new Set<number>()
  const observe = (): ProcessCleanupTargets => {
    const targets = packagedUpdateProcessTargets(
      processTable(), executables, transactionJobPaths(transactionRoots), applicationRoots,
    )
    for (const pid of targets.applicationPids) observedApplicationPids.add(pid)
    for (const pid of targets.helperPids) observedHelperPids.add(pid)
    return targets
  }
  for (const pid of observe().allPids) {
    signalPackagedProcessIfOwned(
      pid, 'SIGTERM', executables, transactionJobPaths(transactionRoots), applicationRoots,
    )
  }
  if (await waitForNoPackagedProcesses(executables, applicationRoots, transactionRoots, 10_000) === null) {
    for (const pid of observe().allPids) {
      if (signalPackagedProcessIfOwned(
        pid, 'SIGKILL', executables, transactionJobPaths(transactionRoots), applicationRoots,
      )) {
        forceKilledPids.add(pid)
      }
    }
    assert(await waitForNoPackagedProcesses(executables, applicationRoots, transactionRoots, 10_000) !== null,
      'packaged update drill processes remained alive after SIGKILL')
  }
  const finalTargets = observe()
  assert(finalTargets.allPids.length === 0, 'packaged update drill process cleanup was not stable')
  return Object.freeze({
    candidateApplicationRoots: Object.freeze(applicationRoots),
    candidateExecutables: Object.freeze(executables),
    helperJobPaths: Object.freeze(transactionJobPaths(transactionRoots)),
    applicationPids: Object.freeze([...observedApplicationPids].sort((left, right) => left - right)),
    helperPids: Object.freeze([...observedHelperPids].sort((left, right) => left - right)),
    allPids: Object.freeze([...new Set([...observedApplicationPids, ...observedHelperPids])]
      .sort((left, right) => left - right)),
    forceKilledPids: Object.freeze([...forceKilledPids].sort((left, right) => left - right)),
  })
}

function readyLogCount(path: string, version: string): number {
  if (!existsSync(path)) return 0
  const marker = `desktop main window ready title=${PRODUCT_NAME} V${version}`
  return readFileSync(path, 'utf8').split(marker).length - 1
}

async function writeEncryptedCredentials(
  application: ElectronApplication,
  storePath: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const encrypted = await application.evaluate(async ({ safeStorage }, entries) => {
    if (!await safeStorage.isAsyncEncryptionAvailable()) {
      throw new Error('macOS Keychain-backed safeStorage is unavailable')
    }
    return Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([ref, value]) => [
      ref,
      (await safeStorage.encryptStringAsync(value)).toString('base64'),
    ])))
  }, values)
  writeFileSync(storePath, `${JSON.stringify({ version: 1, entries: encrypted })}\n`, { mode: 0o600 })
}

async function assertCredentialsDecrypt(
  application: ElectronApplication,
  storePath: string,
  expected: Readonly<Record<string, string>>,
): Promise<void> {
  const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as { readonly entries: Record<string, string> }
  const decrypted = await application.evaluate(async ({ safeStorage }, entries) => Object.fromEntries(
    await Promise.all(Object.entries(entries).map(async ([ref, encoded]) => [
      ref,
      (await safeStorage.decryptStringAsync(Buffer.from(encoded, 'base64'))).result,
    ])),
  ), persisted.entries)
  assert(Object.keys(decrypted).length === Object.keys(expected).length
    && Object.entries(expected).every(([ref, value]) => decrypted[ref] === value),
  'client could not decrypt the retained credential refs')
}

const CREDENTIAL_BROKER_RUNNER = String.raw`
const { spawn } = require('node:child_process')
const { dirname, resolve } = require('node:path')
const broker = resolve(dirname(process.execPath), '..', 'Resources', 'product', 'credentials', 'gongchuang-credential-broker')
const child = spawn(broker, [], { stdio: ['pipe', 'pipe', 'pipe'] })
child.stdout.pipe(process.stdout)
child.stderr.resume()
process.stdin.pipe(child.stdin)
child.once('error', () => process.exit(78))
child.once('close', code => { process.exitCode = code ?? 79 })
`

function assertBrokerCredentials(
  appPath: string,
  statePath: string,
  expected: Readonly<Record<string, string>>,
): void {
  exactFile(statePath, 'migrated credential broker state')
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    readonly version?: unknown
    readonly entries?: Readonly<Record<string, unknown>>
  }
  assert(state.version === 2 && state.entries !== undefined,
    'target did not create the credential broker state')
  const references = Object.keys(expected).sort()
  assert(references.every(reference => state.entries?.[reference] === 'present'),
    'target did not mark every retained credential as migrated')

  const executable = join(appPath, 'Contents', 'MacOS', plist(appPath, 'CFBundleExecutable'))
  const requests = references.map(reference => JSON.stringify({ op: 'read', ref: reference })).join('\n')
  const output = execFileSync(executable, ['-e', CREDENTIAL_BROKER_RUNNER], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    input: `${requests}\n`,
    timeout: 30_000,
  })
  const rows = output.trim().split('\n').map(line => JSON.parse(line) as {
    readonly ok?: unknown
    readonly result?: { readonly found?: unknown; readonly value?: unknown }
  })
  assert(rows.length === references.length && rows.every((row, index) => (
    row.ok === true
      && row.result?.found === true
      && row.result.value === expected[references[index]!]
  )), 'target credential broker did not return every retained credential value')
}

async function stageCookie(page: Page, value: string): Promise<void> {
  await page.evaluate(({ name, cookieValue }) => {
    document.cookie = `${name}=${cookieValue}; path=/; max-age=86400; SameSite=Lax`
  }, { name: COOKIE_NAME, cookieValue: value })
  // 产品窗口使用命名持久分区；Playwright BrowserContext 读取的是默认分区，不能作为这里的取证来源。
  const staged = await page.evaluate(({ name, cookieValue }) => document.cookie
    .split('; ')
    .includes(`${name}=${cookieValue}`), { name: COOKIE_NAME, cookieValue: value })
  assert(staged, 'persistent partition cookie could not be staged')
}

async function assertCookie(page: Page, value: string): Promise<void> {
  await page.waitForFunction(({ name, cookieValue }) => document.cookie
    .split('; ')
    .includes(`${String(name)}=${String(cookieValue)}`), {
    name: COOKIE_NAME,
    cookieValue: value,
  }, { timeout: 300_000 })
}

async function assertPackagedUserState(
  page: Page,
  fixture: PersistedUserFixture,
  initializeFirstRun: boolean,
  expectedSessionTitles?: VisibleSessionTitles,
  expectedModelDialogName = '连接自定义 API',
): Promise<VisibleSessionTitles> {
  const expected = fixture.expected
  const firstRunDialog = page.getByRole('dialog', { name: '设置所属地与企业空间' })
  if (initializeFirstRun) {
    await firstRunDialog.waitFor({ state: 'visible', timeout: 300_000 })
    await firstRunDialog.getByRole('radio', { name: /^杭州/u }).click()
    await firstRunDialog.getByRole('button', { name: '保存并进入洞见', exact: true }).click()
    await firstRunDialog.waitFor({ state: 'hidden', timeout: 300_000 })
  }

  const navigation = page.getByRole('navigation', { name: '主导航' })
  await navigation.waitFor({ state: 'visible', timeout: 300_000 })
  await page.getByRole('button', { name: '切换城市，当前杭州', exact: true })
    .waitFor({ state: 'visible', timeout: 300_000 })

  const rootState = await page.evaluate(() => (
    window as unknown as { gongchuangDesktop: DesktopBridge }
  ).gongchuangDesktop.workspaceRootState())
  assert(rootState.rootPath === expected.enterpriseRoot, 'packaged client did not read the canonical enterprise root')
  assert(!rootState.isDefault && !rootState.needsInitialSetup, 'packaged client did not retain the custom enterprise root')
  // 导航可先于目录 IPC 就绪。只读确认持久状态，再等加载弹窗消失；不点击保存或补写配置。
  await firstRunDialog.waitFor({ state: 'hidden', timeout: 300_000 })
  assert(await firstRunDialog.count() === 0, 'retained client reopened first-run setup')

  await page.getByRole('button', { name: '共创账号', exact: true }).click()
  const account = page.getByRole('dialog', { name: '账号与同步' })
  await account.waitFor({ state: 'visible', timeout: 300_000 })
  const username = account.locator('input[name="username"]')
  await username.waitFor({ state: 'visible', timeout: 300_000 })
  await page.waitForFunction(value => (
    document.querySelector<HTMLInputElement>('input[name="username"]')?.value === value
  ), expected.accountUsername, { timeout: 300_000 })
  const password = account.locator('input[name="password"]')
  assert(await password.getAttribute('placeholder') === '已安全保存，留空继续使用',
    'packaged client did not resolve the saved password credential')
  assert(await account.getByRole('checkbox', { name: '保存密码并自动登录' }).isChecked(),
    'packaged client did not project the saved credential state')
  await account.getByRole('button', { name: '关闭', exact: true }).click()
  await account.waitFor({ state: 'hidden', timeout: 300_000 })

  const workspaceToggle = page.locator(
    `[data-sidebar-workspace-id="${expected.activeWorkspaceId}"] [data-sidebar-workspace-toggle]`,
  )
  await workspaceToggle.waitFor({ state: 'visible', timeout: 300_000 })
  if (await workspaceToggle.getAttribute('aria-expanded') !== 'true') await workspaceToggle.click()
  const activeSession = page.locator(
    `[data-sidebar-workspace-id="${expected.activeWorkspaceId}"][data-sidebar-session-id="${expected.activeSessionId}"]`,
  )
  await activeSession.waitFor({ state: 'visible', timeout: 300_000 })
  assert(await page.locator(`[data-sidebar-session-id="${expected.deletedSessionId}"]`).count() === 0,
    'deleted session resurfaced inside its live enterprise workspace')
  assert(await page.locator(
    `[data-sidebar-workspace-id="${expected.deletedWorkspaceId}"] [data-sidebar-workspace-toggle]`,
  ).count() === 0, 'deleted enterprise workspace resurfaced')
  const sessionButtons = await activeSession.locator('button').evaluateAll(buttons => buttons.map(button => ({
    ariaLabel: button.getAttribute('aria-label'),
    ariaPressed: button.getAttribute('aria-pressed'),
    text: button.textContent?.trim() ?? '',
  })))
  const sessionButton = activeSession.locator('button[aria-describedby^="recent-session-meta-"]')
  const displayTitle = await sessionButton.getAttribute('aria-label')
  assert(displayTitle !== null && displayTitle !== '' && displayTitle !== '新任务（未开始）',
    `persisted session title was not parsed: ${JSON.stringify(sessionButtons)}`)
  if (expectedSessionTitles !== undefined) {
    assert(displayTitle === expectedSessionTitles.active,
      `persisted session title changed across update: expected ${expectedSessionTitles.active}, received ${displayTitle}`)
  }
  const pins = sessionButtons.filter(button => button.ariaPressed === 'true')
  assert(pins.length === 1 && pins[0]?.ariaLabel === `取消固定对话：${displayTitle}`,
    `pinned session state was not parsed: ${JSON.stringify(sessionButtons)}`)
  await sessionButton.click()
  await page.getByText('更新后保留这段会话内容', { exact: true })
    .waitFor({ state: 'visible', timeout: 300_000 })
  await page.getByText('更新保留会话内容', { exact: true })
    .waitFor({ state: 'visible', timeout: 300_000 })
  const retainedImage = page.locator('img[alt="update-retained.png"]')
  await retainedImage.waitFor({ state: 'visible', timeout: 300_000 })
  assert(await retainedImage.evaluate((node) => {
    const image = node as HTMLImageElement
    return image.complete && image.naturalWidth === 1 && image.naturalHeight === 1
  }), 'packaged client did not load the retained attachment bytes')

  const provider = page.locator('#gongchuang-provider-select')
  await provider.waitFor({ state: 'visible', timeout: 300_000 })
  await page.waitForFunction(() => (
    document.querySelector<HTMLSelectElement>('#gongchuang-provider-select')?.value === 'custom'
  ), null, { timeout: 300_000 })
  const providerPanel = provider.locator('..')
  await providerPanel.getByText('连接正常', { exact: true }).waitFor({ state: 'visible', timeout: 300_000 })
  await providerPanel.getByRole('button', { name: '管理', exact: true }).click()
  const modelDialog = page.getByRole('dialog', { name: expectedModelDialogName, exact: true })
  await modelDialog.waitFor({ state: 'visible', timeout: 300_000 })
  await modelDialog.getByText('1 个', { exact: true }).waitFor({ state: 'visible', timeout: 300_000 })
  await modelDialog.getByText(expected.customModelId, { exact: true })
    .waitFor({ state: 'visible', timeout: 300_000 })
  await modelDialog.getByRole('button', { name: '关闭', exact: true }).click()
  await modelDialog.waitFor({ state: 'hidden', timeout: 300_000 })

  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.waitFor({ state: 'visible', timeout: 300_000 })
  await settings.getByRole('button', { name: '已归档', exact: true }).click()
  const archived = settings.locator('section[aria-labelledby="settings-archived-title"]')
  await archived.getByText('已归档企业', { exact: true }).waitFor({ state: 'visible', timeout: 300_000 })
  const archivedSession = archived.locator('article').filter({ hasText: '会话记录仍保留在本机' })
  assert(await archivedSession.count() === 1, 'archived session record was not projected exactly once')
  const archivedDisplayTitle = (await archivedSession.locator('strong').textContent())?.trim()
  assert(archivedDisplayTitle !== undefined && archivedDisplayTitle !== '', 'archived session title was not projected')
  if (expectedSessionTitles !== undefined) {
    assert(archivedDisplayTitle === expectedSessionTitles.archived,
      `archived session title changed across update: expected ${expectedSessionTitles.archived}, received ${archivedDisplayTitle}`)
  }
  assert(await archived.getByText('已删除企业', { exact: true }).count() === 0,
    'deleted workspace appeared in the archive recovery surface')
  assert(await archived.getByText('已删除验收会话', { exact: true }).count() === 0,
    'deleted session appeared in the archive recovery surface')

  await settings.getByRole('button', { name: '记忆', exact: true }).click()
  const memory = settings.locator('section[aria-labelledby="settings-memory-title"]')
  const memoryEnabled = memory.getByRole('checkbox', { name: /启用本地长期记忆/u })
  await memoryEnabled.waitFor({ state: 'visible', timeout: 300_000 })
  assert(!await memoryEnabled.isChecked(), 'graph-memory preference changed during packaged boot')
  await memory.getByText('1 个独立空间', { exact: true }).waitFor({ state: 'visible', timeout: 300_000 })
  await memory.getByText('1 项记忆 · 0 条关系', { exact: true }).waitFor({ state: 'visible', timeout: 300_000 })
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await settings.waitFor({ state: 'hidden', timeout: 300_000 })

  await navigation.getByRole('button', { name: '技能中心', exact: true }).click()
  const skillTabs = page.getByRole('navigation', { name: '技能中心分类' })
  await skillTabs.waitFor({ state: 'visible', timeout: 300_000 })
  await skillTabs.getByRole('button', { name: /已安装技能/u }).click()
  const installedSkillSearch = page.getByRole('textbox', { name: '检索已安装技能' })
  await installedSkillSearch.fill(expected.disabledSkillName)
  const skillSwitch = page.getByRole('switch', { name: `启用技能 ${expected.disabledSkillName}`, exact: true })
  await skillSwitch.waitFor({ state: 'visible', timeout: 300_000 })
  assert(await skillSwitch.getAttribute('aria-checked') === 'false', 'disabled community skill was not parsed')
  await page.locator('article').filter({ has: skillSwitch }).getByText('已停用', { exact: true })
    .waitFor({ state: 'visible', timeout: 300_000 })

  await navigation.getByRole('button', { name: '自动化任务', exact: true }).click()
  await page.getByRole('heading', { name: '自动化任务', exact: true })
    .waitFor({ state: 'visible', timeout: 300_000 })
  const automation = page.locator('article').filter({ hasText: '更新保留验收任务' })
  await automation.getByText('更新保留验收任务', { exact: true })
    .waitFor({ state: 'visible', timeout: 300_000 })
  await automation.getByText('尚未运行', { exact: true }).waitFor({ state: 'visible', timeout: 300_000 })
  await automation.getByText('已停用', { exact: true }).waitFor({ state: 'visible', timeout: 300_000 })
  return { active: displayTitle, archived: archivedDisplayTitle }
}

/**
 * 核对旧版仍可完成升级所需的最小界面与本地状态。
 *
 * 升级源可能正是因为模型插件损坏才需要更新；这里若再打开模型管理或创建
 * 会话，就会让修复版本永远无法救回旧版。目标版本仍由完整界面检查和独立
 * 的真实模型验收负责，不能用这条最小路径替代。
 */
async function assertPackagedUpdateSourceState(
  page: Page,
  fixture: PersistedUserFixture,
): Promise<VisibleSessionTitles> {
  const expected = fixture.expected
  const navigation = page.getByRole('navigation', { name: '主导航' })
  await navigation.waitFor({ state: 'visible', timeout: 300_000 })
  await page.getByRole('button', { name: '切换城市，当前杭州', exact: true })
    .waitFor({ state: 'visible', timeout: 300_000 })
  const rootState = await page.evaluate(() => (
    window as unknown as { gongchuangDesktop: DesktopBridge }
  ).gongchuangDesktop.workspaceRootState())
  assert(rootState.rootPath === expected.enterpriseRoot, 'update source did not read the canonical enterprise root')
  assert(!rootState.isDefault && !rootState.needsInitialSetup,
    'update source did not retain its configured enterprise root')

  const workspaceToggle = page.locator(
    `[data-sidebar-workspace-id="${expected.activeWorkspaceId}"] [data-sidebar-workspace-toggle]`,
  )
  await workspaceToggle.waitFor({ state: 'visible', timeout: 300_000 })
  if (await workspaceToggle.getAttribute('aria-expanded') !== 'true') await workspaceToggle.click()
  const activeSession = page.locator(
    `[data-sidebar-workspace-id="${expected.activeWorkspaceId}"][data-sidebar-session-id="${expected.activeSessionId}"]`,
  )
  await activeSession.waitFor({ state: 'visible', timeout: 300_000 })
  const displayTitle = await activeSession.locator('button[aria-describedby^="recent-session-meta-"]')
    .getAttribute('aria-label')
  assert(displayTitle === expected.activeSessionTitle, 'update source did not project the retained session title')
  assert(await page.locator(`[data-sidebar-session-id="${expected.deletedSessionId}"]`).count() === 0,
    'deleted session resurfaced in the update source')
  return { active: displayTitle, archived: expected.archivedSessionTitle }
}

function extractArchive(archive: string, parent: string): string {
  mkdirSync(parent, { mode: 0o700 })
  execFileSync('/usr/bin/ditto', ['-x', '-k', archive, parent])
  const appPath = join(parent, PRODUCT_APP_NAME)
  const info = lstatSync(appPath)
  if (!info.isDirectory() || info.isSymbolicLink() || readdirSync(parent).length !== 1) {
    throw new Error('packaged archive must contain exactly one product application')
  }
  return appPath
}

function executableArchitecture(appPath: string): 'arm64' | 'x64' {
  const executable = plist(appPath, 'CFBundleExecutable')
  const architectures = execFileSync('/usr/bin/lipo', ['-archs', join(appPath, 'Contents', 'MacOS', executable)], {
    encoding: 'utf8',
  }).trim().split(/\s+/u).map(value => value === 'x86_64' ? 'x64' : value)
  if (architectures.length !== 1 || (architectures[0] !== 'arm64' && architectures[0] !== 'x64')) {
    throw new Error('packaged application must contain exactly one supported architecture')
  }
  return architectures[0]
}

function verifyPackagedApplication(
  appPath: string,
  version: string,
  architecture: 'arm64' | 'x64',
  appAsarSha256: string,
): void {
  assert(plist(appPath, 'CFBundleIdentifier') === PRODUCT_ID, 'application bundle id mismatch')
  assert(plist(appPath, 'CFBundleShortVersionString') === version, 'application version mismatch')
  assert(executableArchitecture(appPath) === architecture, 'application architecture mismatch')
  assert(
    sha256File(join(appPath, 'Contents', 'Resources', 'app.asar')) === appAsarSha256,
    'application app.asar mismatch',
  )
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
}

function readSignedManifest(options: ArgumentsValue, targetApp: string): {
  readonly bytes: Buffer
  readonly signature: Buffer
  readonly value: SignedManifest
  readonly artifact: ManifestArtifact
} {
  const bytes = readFileSync(options.manifest)
  const encodedSignature = readFileSync(options.signature, 'utf8').trim()
  const publicKey = readFileSync(join(
    targetApp, 'Contents', 'Resources', 'product', 'runtime', 'runtime-index.pub.pem',
  ))
  assert(verify(null, bytes, publicKey, Buffer.from(encodedSignature, 'base64')), 'signed update manifest is invalid')
  const value = JSON.parse(bytes.toString('utf8')) as SignedManifest
  assert(value.schemaVersion === 1 && value.productId === PRODUCT_ID, 'signed update manifest product mismatch')
  assert(value.clientVersion === options.targetVersion && value.signingTier === 'formal', 'signed update identity mismatch')
  const artifact = value.artifacts.find(row => row.architecture === options.architecture)
  assert(artifact !== undefined, 'signed update manifest does not include the requested architecture')
  assert(
    !/^[a-z][a-z0-9+.-]*:/iu.test(artifact.archiveUrl) && !artifact.archiveUrl.startsWith('//'),
    'target artifact URL must be a same-origin relative reference for the isolated feed',
  )
  const isolatedArchive = new URL(artifact.archiveUrl, 'https://127.0.0.1/desktop-release-index.json')
  assert(artifact.bundleId === PRODUCT_ID && artifact.fileName === basename(options.targetArchive), 'target artifact name mismatch')
  assert(
    decodeURIComponent(basename(isolatedArchive.pathname)) === artifact.fileName,
    'target artifact URL filename mismatch',
  )
  assert(artifact.sha256 === options.targetArchiveSha256, 'target artifact SHA-256 mismatch')
  assert(artifact.sizeBytes === statSync(options.targetArchive).size, 'target artifact size mismatch')
  return { bytes, signature: Buffer.from(`${encodedSignature}\n`), value, artifact }
}

function startFeed(
  root: string,
  manifest: Buffer,
  signature: Buffer,
  artifact: ManifestArtifact,
  archivePath: string,
): Promise<{ readonly certificate: string; readonly manifestUrl: string; readonly server: Server }> {
  const certificate = join(root, 'localhost.pem')
  const certificateKey = join(root, 'localhost-key.pem')
  execFileSync('/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', certificateKey, '-out', certificate, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' })
  const etag = `"sha256-${artifact.sha256}"`
  const server = createServer({ key: readFileSync(certificateKey), cert: readFileSync(certificate) }, (request, response) => {
    const pathname = new URL(request.url ?? '/', 'https://127.0.0.1').pathname
    const send = (bytes: Buffer, contentType: string): void => {
      response.writeHead(200, {
        'content-type': contentType,
        'content-length': bytes.length,
        'content-encoding': 'identity',
      })
      response.end(bytes)
    }
    if (pathname === '/desktop-release-index.json') send(manifest, 'application/json')
    else if (pathname === '/desktop-release-index.sig') send(signature, 'text/plain')
    // V0.4.0 refreshes custom catalogs during startup. Return the same
    // user-facing metadata so rollback assertions do not depend on CPU timing.
    else if (pathname === '/v1/models') send(Buffer.from(JSON.stringify({
      object: 'list',
      data: [{
        id: 'update-acceptance-model', name: '升级验收模型', context_window: 8192,
        max_output_tokens: 1024, object: 'model', owned_by: 'gongchuang-acceptance',
      }],
    })), 'application/json')
    else if (pathname === `/${artifact.fileName}`) {
      const range = request.headers.range
      const expectedPrefix = 'bytes='
      const requestedOffset = range?.startsWith(expectedPrefix)
        ? Number(range.slice(expectedPrefix.length).split('-', 1)[0])
        : 0
      const partial = Number.isSafeInteger(requestedOffset) && requestedOffset > 0
        && requestedOffset < artifact.sizeBytes && request.headers['if-range'] === etag
      const offset = partial ? requestedOffset : 0
      response.writeHead(partial ? 206 : 200, {
        'accept-ranges': 'bytes',
        'content-type': 'application/zip',
        'content-length': artifact.sizeBytes - offset,
        'content-encoding': 'identity',
        etag,
        ...(partial ? { 'content-range': `bytes ${String(offset)}-${String(artifact.sizeBytes - 1)}/${String(artifact.sizeBytes)}` } : {}),
      })
      createReadStream(archivePath, { start: offset }).pipe(response)
    } else {
      response.writeHead(404)
      response.end('not found')
    }
  })
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        rejectPromise(new Error('isolated HTTPS feed did not bind a TCP port'))
        return
      }
      resolvePromise({
        certificate,
        manifestUrl: `https://127.0.0.1:${String(address.port)}/desktop-release-index.json`,
        server,
      })
    })
  })
}

function desktopBridge(page: Page): Promise<boolean> {
  return page.evaluate(() => typeof (window as unknown as { gongchuangDesktop?: DesktopBridge }).gongchuangDesktop
    ?.checkForUpdates === 'function')
}

function checkForUpdates(page: Page): Promise<Awaited<ReturnType<DesktopBridge['checkForUpdates']>>> {
  return page.evaluate(() => (window as unknown as { gongchuangDesktop: DesktopBridge }).gongchuangDesktop.checkForUpdates())
}

function downloadUpdate(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as unknown as { gongchuangDesktop: DesktopBridge }).gongchuangDesktop.downloadUpdate())
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => { server.close(() => { resolvePromise() }) })
}

async function main(): Promise<void> {
  const options = argumentsValue(process.argv.slice(2))
  if (options === null) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (process.platform !== 'darwin') throw new Error('packaged macOS update acceptance can run only on macOS')
  for (const [path, label] of [
    [options.sourceArchive, 'source archive'], [options.targetArchive, 'target archive'],
    [options.manifest, 'signed manifest'], [options.signature, 'manifest signature'],
  ] as const) exactFile(path, label)
  assert(options.receipt !== options.evidenceLog, 'receipt and evidence log must be different files')
  exactNewOutput(options.receipt, 'receipt')
  exactNewOutput(options.evidenceLog, 'evidence log')
  assert(sha256File(options.sourceArchive) === options.sourceArchiveSha256, 'source archive SHA-256 mismatch')
  assert(sha256File(options.targetArchive) === options.targetArchiveSha256, 'target archive SHA-256 mismatch')

  const drillRoot = mkdtempSync(join(tmpdir(), 'gongchuang-packaged-update-'))
  const acceptanceRoot = join(drillRoot, 'acceptance-root')
  const applications = join(drillRoot, 'Applications')
  const sourceExtract = join(drillRoot, 'source')
  const targetExtract = join(drillRoot, 'target')
  const enterpriseRoot = join(drillRoot, 'enterprise-workspaces')
  const rollbackAcceptanceRoot = join(drillRoot, 'rollback-acceptance-root')
  const rollbackApplications = join(drillRoot, 'rollback-Applications')
  const rollbackEnterpriseRoot = join(drillRoot, 'rollback-enterprise-workspaces')
  const transactionRoots = [
    join(acceptanceRoot, 'Library', 'Application Support', PRODUCT_NAME, 'desktop-updates', 'transactions'),
    join(rollbackAcceptanceRoot, 'Library', 'Application Support', PRODUCT_NAME, 'desktop-updates', 'transactions'),
  ]
  mkdirSync(acceptanceRoot, { mode: 0o700 })
  mkdirSync(applications, { mode: 0o700 })
  mkdirSync(enterpriseRoot, { mode: 0o700 })
  const stages: Stage[] = []
  const candidateApplicationRoots = new Set<string>()
  const candidateExecutables = new Set<string>()
  let electronApp: ElectronApplication | undefined
  let launchedPid: number | undefined
  let feed: Awaited<ReturnType<typeof startFeed>> | undefined
  let completed = false
  let failure: unknown
  let processCleanup: ProcessCleanupReceipt | undefined
  let trashStatus: 'moved-to-macos-trash' | 'retained-after-cleanup-failure' = 'retained-after-cleanup-failure'
  const log = (message: string): void => {
    const line = `[${new Date().toISOString()}] ${message}`
    writeFileSync(options.evidenceLog, `${line}\n`, { flag: 'a' })
    process.stdout.write(`${line}\n`)
  }
  const record = (name: string, details: Readonly<Record<string, unknown>> = {}): void => {
    stages.push({ name, status: 'passed', at: new Date().toISOString(), ...details })
    log(`passed ${name}`)
  }
  try {
    const sourceApp = extractArchive(options.sourceArchive, sourceExtract)
    verifyPackagedApplication(
      sourceApp, options.sourceVersion, options.architecture, options.sourceAppAsarSha256,
    )
    execFileSync('/usr/bin/ditto', [sourceApp, join(applications, PRODUCT_APP_NAME)])
    const currentApp = join(applications, PRODUCT_APP_NAME)
    const currentExecutable = join(currentApp, 'Contents', 'MacOS', plist(currentApp, 'CFBundleExecutable'))
    let currentApplicationExecutables = packagedApplicationExecutablesForSlot(currentApp, [sourceApp])
    candidateApplicationRoots.add(currentApp)
    for (const executable of currentApplicationExecutables) candidateExecutables.add(executable)
    record('exact-packaged-source', {
      version: options.sourceVersion,
      architecture: options.architecture,
      archiveSha256: options.sourceArchiveSha256,
      appAsarSha256: options.sourceAppAsarSha256,
    })

    const targetApp = extractArchive(options.targetArchive, targetExtract)
    verifyPackagedApplication(
      targetApp, options.targetVersion, options.architecture, options.targetAppAsarSha256,
    )
    currentApplicationExecutables = packagedApplicationExecutablesForSlot(
      currentApp, [sourceApp, targetApp],
    )
    for (const executable of currentApplicationExecutables) candidateExecutables.add(executable)
    const signed = readSignedManifest(options, targetApp)
    const runtimeIndexPath = join(targetApp, 'Contents', 'Resources', 'product', 'runtime', 'runtime-index.json')
    const skillIndexPath = join(targetApp, 'Contents', 'Resources', 'product', 'skill-suite', 'skill-bundle-index.json')
    assert(sha256File(runtimeIndexPath) === signed.artifact.runtimeIndexSha256, 'runtime index digest mismatch')
    assert(sha256File(skillIndexPath) === signed.artifact.skillBundleIndexSha256, 'skill index digest mismatch')
    record('exact-signed-target', {
      version: options.targetVersion,
      architecture: options.architecture,
      archiveSha256: options.targetArchiveSha256,
      appAsarSha256: options.targetAppAsarSha256,
      sourceCommit: signed.value.sourceCommit,
      runtimeIndexSha256: signed.artifact.runtimeIndexSha256,
      skillBundleIndexSha256: signed.artifact.skillBundleIndexSha256,
    })

    feed = await startFeed(drillRoot, signed.bytes, signed.signature, signed.artifact, options.targetArchive)
    record('isolated-https-feed', {
      manifestSha256: createHash('sha256').update(signed.bytes).digest('hex'),
    })
    const userDataRoot = join(acceptanceRoot, 'Library', 'Application Support', PRODUCT_NAME)
    const credentialValues = Object.freeze({
      GONGCHUANG_ACCOUNT_USERNAME: `acceptance-user-${randomUUID()}`,
      GONGCHUANG_ACCOUNT_PASSWORD: `acceptance-password-${randomUUID()}`,
      GONGCHUANG_ACCOUNT_DEVICE_ID: `acceptance-device-${randomUUID()}`,
      GONGCHUANG_ACCOUNT_AUTO_LOGIN_BLOCKED: 'signed-out',
      GONGCHUANG_CUSTOM_API_ACCEPTANCE: `acceptance-model-key-${randomUUID()}`,
    })
    const credentialStore = join(userDataRoot, 'credentials.secure.v1.json')
    const launchEnvironment = {
      ...process.env,
      GONGCHUANG_ACCEPTANCE_MODE: '1',
      GONGCHUANG_ACCEPTANCE_USER_DATA_ROOT: acceptanceRoot,
      GONGCHUANG_MAC_UPDATE_MANIFEST_URL: feed.manifestUrl,
      NODE_EXTRA_CA_CERTS: feed.certificate,
    }

    // Create native safeStorage ciphertext with the exact released source
    // binary before writing the remaining fixture. This prevents first-run
    // defaults from normalizing the evidence before the source reads it.
    electronApp = await electron.launch({ executablePath: currentExecutable, timeout: 300_000, env: launchEnvironment })
    const bootstrapWindow = await electronApp.firstWindow({ timeout: 300_000 })
    await bootstrapWindow.waitForFunction(() => typeof (window as unknown as { gongchuangDesktop?: DesktopBridge })
      .gongchuangDesktop?.checkForUpdates === 'function', null, { timeout: 300_000 })
    await writeEncryptedCredentials(electronApp, credentialStore, credentialValues)
    await electronApp.close()
    const fixture = await stagePersistedUserState(
      userDataRoot,
      enterpriseRoot,
      new URL('/v1', feed.manifestUrl).href,
      credentialValues.GONGCHUANG_ACCOUNT_USERNAME,
    )
    assert(fixture.trackedFiles.credentials[0] === credentialStore, 'credential fixture path mismatch')
    electronApp = await electron.launch({ executablePath: currentExecutable, timeout: 300_000, env: launchEnvironment })
    const sourceWindow = await electronApp.firstWindow({ timeout: 300_000 })
    await sourceWindow.waitForFunction(() => typeof (window as unknown as { gongchuangDesktop?: DesktopBridge })
      .gongchuangDesktop?.checkForUpdates === 'function', null, { timeout: 300_000 })
    assert(await desktopBridge(sourceWindow), 'source desktop bridge is unavailable')
    await assertCredentialsDecrypt(electronApp, credentialStore, credentialValues)
    record('source-saved-account-credentials-encrypted', {
      credentialRefs: Object.keys(credentialValues).sort(),
      safeStorageAvailable: true,
      signedInSessionClaimed: false,
    })
    const cookieValue = randomUUID()
    await stageCookie(sourceWindow, cookieValue)
    const sourceSessionTitles = await assertPackagedUpdateSourceState(sourceWindow, fixture)
    const retainedState = captureUserState(fixture)
    record('source-persisted-user-state-loaded', {
      categories: USER_STATE_CATEGORIES,
      sourcePersistedSessionTitles: sourceSessionTitles,
      sourceUiBoundary: 'configured update surface only; model management and session creation are target checks',
      ...fixture.expected,
    })
    const checked = await checkForUpdates(sourceWindow)
    assert(checked.status === 'available' && checked.currentVersion === options.sourceVersion
      && checked.latestVersion === options.targetVersion, `packaged update check failed: ${JSON.stringify(checked)}`)
    record('packaged-check', checked)

    const closed = electronApp.waitForEvent('close', { timeout: 300_000 })
    const download = downloadUpdate(sourceWindow).catch(error => ({ closedDuringInstall: true, message: String(error) }))
    await Promise.race([closed, download])
    await closed
    electronApp = undefined
    const updateRoot = join(userDataRoot, 'desktop-updates')
    const transactionRoot = join(updateRoot, 'transactions')
    const statePath = await waitFor(() => {
      if (!existsSync(transactionRoot)) return null
      const name = readdirSync(transactionRoot).find(value => value.endsWith('.state.json'))
      return name === undefined ? null : join(transactionRoot, name)
    }, 120_000, 'update transaction state')
    const jobPath = join(transactionRoot, `${basename(statePath, '.state.json')}.json`)
    const committed = await waitFor(() => {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
        readonly status?: string
        readonly launchedPid?: number
      }
      if (state.status === 'restored' || state.status === 'failed') {
        throw new Error(`packaged target reached terminal failure state: ${JSON.stringify(state)}`)
      }
      return state.status === 'committed' ? state : null
    }, 300_000, 'packaged target startup commit')
    launchedPid = committed.launchedPid
    const mainLog = join(acceptanceRoot, 'Library', 'Logs', PRODUCT_NAME, 'main.log')
    await waitFor(() => existsSync(mainLog)
      && readFileSync(mainLog, 'utf8').includes(`desktop main window ready title=${PRODUCT_NAME} V${options.targetVersion}`),
    300_000, 'target ready log')
    assert(plist(currentApp, 'CFBundleShortVersionString') === options.targetVersion, 'installed target version mismatch')
    assertUserStateRetained(retainedState, captureUserState(fixture))

    if (running(launchedPid)) {
      // 提交后的目标进程可以自行退出；身份复核和发信号之间的退出不应伪造失败，PID 仍存活但不再受控则继续拒绝。
      const signalled = signalPackagedProcessIfOwned(
        launchedPid as number, 'SIGTERM', currentApplicationExecutables, [jobPath], [currentApp],
      )
      assert(signalled || !running(launchedPid),
        'helper-launched target PID no longer belongs to the packaged drill')
      if (signalled) {
        await waitFor(() => packagedUpdateProcessTargets(
          processTable(), currentApplicationExecutables, [jobPath], [currentApp],
        ).allPids.includes(launchedPid as number) ? null : true, 30_000, 'helper-launched target shutdown')
      }
    }
    launchedPid = undefined
    electronApp = await electron.launch({ executablePath: currentExecutable, timeout: 300_000, env: launchEnvironment })
    const targetWindow = await electronApp.firstWindow({ timeout: 300_000 })
    await assertCookie(targetWindow, cookieValue)
    await assertPackagedUserState(targetWindow, fixture, false, {
      active: fixture.expected.activeSessionTitle,
      archived: fixture.expected.archivedSessionTitle,
    }, '连接 本地 / 自定义端点')
    const brokerState = join(userDataRoot, 'credentials.keychain.v2.json')
    assertBrokerCredentials(currentApp, brokerState, credentialValues)
    assertUserStateRetained(retainedState, captureUserState(fixture))
    record('target-saved-account-credentials-migrated', {
      credentialRefs: Object.keys(credentialValues).sort(),
      productionLoginAttempted: false,
      deviceBoundTokenVerified: false,
      credentialStoreBytesRetained: true,
      savedCredentialRefsDecryptedByTarget: true,
      savedCredentialRefsReadByFrozenBroker: true,
      savedPasswordAvailableWithoutRetyping: true,
      systemKeychainAuthorizationDeferred: false,
    })
    record('retained-user-state', {
      categories: USER_STATE_CATEGORIES,
      targetParsedNonSecretState: true,
      targetParsedCredentialBackedState: true,
      persistentPartitionCookieRetained: true,
    })
    await electronApp.close()
    electronApp = undefined

    const job = JSON.parse(readFileSync(jobPath, 'utf8')) as {
      readonly backupAppPath: string
      readonly transactionId: string
    }
    const stagingPath = join(updateRoot, 'staging', `${options.targetVersion}-${job.transactionId}`)
    await waitFor(() => !existsSync(job.backupAppPath) && !existsSync(stagingPath) ? true : null,
      120_000, 'committed update residue cleanup')
    record('packaged-download-verify-swap-launch-commit', {
      installedVersion: options.targetVersion,
      persistentPartitionCookieRetained: true,
      credentialStoreRetained: true,
      savedAccountCredentialRefsDecryptedByTarget: true,
      savedCredentialRefsReadByFrozenBroker: true,
      savedPasswordAvailableWithoutRetyping: true,
      systemKeychainAuthorizationDeferred: false,
      signedInSessionRetained: false,
      deviceBoundTokenVerified: false,
      allUserStateCategoriesRetained: true,
      previousAppMovedToTrash: true,
      stagingMovedToTrash: true,
    })

    mkdirSync(rollbackAcceptanceRoot, { mode: 0o700 })
    mkdirSync(rollbackApplications, { mode: 0o700 })
    mkdirSync(rollbackEnterpriseRoot, { mode: 0o700 })
    execFileSync('/usr/bin/ditto', [sourceApp, join(rollbackApplications, PRODUCT_APP_NAME)])
    const rollbackCurrentApp = join(rollbackApplications, PRODUCT_APP_NAME)
    const rollbackExecutable = join(
      rollbackCurrentApp, 'Contents', 'MacOS', plist(rollbackCurrentApp, 'CFBundleExecutable'),
    )
    const rollbackApplicationExecutables = packagedApplicationExecutablesForSlot(
      rollbackCurrentApp, [sourceApp, targetApp],
    )
    candidateApplicationRoots.add(rollbackCurrentApp)
    for (const executable of rollbackApplicationExecutables) candidateExecutables.add(executable)
    const rollbackUserDataRoot = join(
      rollbackAcceptanceRoot, 'Library', 'Application Support', PRODUCT_NAME,
    )
    const rollbackCredentialStore = join(rollbackUserDataRoot, 'credentials.secure.v1.json')
    const rollbackCredentialValues = Object.freeze({
      GONGCHUANG_ACCOUNT_USERNAME: `rollback-user-${randomUUID()}`,
      GONGCHUANG_ACCOUNT_PASSWORD: `rollback-password-${randomUUID()}`,
      GONGCHUANG_ACCOUNT_DEVICE_ID: `rollback-device-${randomUUID()}`,
      GONGCHUANG_ACCOUNT_AUTO_LOGIN_BLOCKED: 'signed-out',
      GONGCHUANG_CUSTOM_API_ACCEPTANCE: `rollback-model-key-${randomUUID()}`,
    })
    const rollbackEnvironment = {
      ...launchEnvironment,
      GONGCHUANG_ACCEPTANCE_USER_DATA_ROOT: rollbackAcceptanceRoot,
    }
    electronApp = await electron.launch({
      executablePath: rollbackExecutable, timeout: 300_000, env: rollbackEnvironment,
    })
    const rollbackBootstrap = await electronApp.firstWindow({ timeout: 300_000 })
    await rollbackBootstrap.waitForFunction(() => typeof (window as unknown as { gongchuangDesktop?: DesktopBridge })
      .gongchuangDesktop?.checkForUpdates === 'function', null, { timeout: 300_000 })
    await writeEncryptedCredentials(electronApp, rollbackCredentialStore, rollbackCredentialValues)
    await electronApp.close()
    const rollbackFixture = await stagePersistedUserState(
      rollbackUserDataRoot,
      rollbackEnterpriseRoot,
      new URL('/v1', feed.manifestUrl).href,
      rollbackCredentialValues.GONGCHUANG_ACCOUNT_USERNAME,
    )
    assert(rollbackFixture.trackedFiles.credentials[0] === rollbackCredentialStore,
      'rollback credential fixture path mismatch')
    electronApp = await electron.launch({
      executablePath: rollbackExecutable, timeout: 300_000, env: rollbackEnvironment,
    })
    const rollbackSourceWindow = await electronApp.firstWindow({ timeout: 300_000 })
    await rollbackSourceWindow.waitForFunction(() => typeof (window as unknown as { gongchuangDesktop?: DesktopBridge })
      .gongchuangDesktop?.checkForUpdates === 'function', null, { timeout: 300_000 })
    const rollbackCookieValue = randomUUID()
    await stageCookie(rollbackSourceWindow, rollbackCookieValue)
    await assertCredentialsDecrypt(electronApp, rollbackCredentialStore, rollbackCredentialValues)
    const rollbackSessionTitles = await assertPackagedUpdateSourceState(rollbackSourceWindow, rollbackFixture)
    const rollbackRetainedState = captureUserState(rollbackFixture)
    const rollbackChecked = await checkForUpdates(rollbackSourceWindow)
    assert(rollbackChecked.status === 'available'
      && rollbackChecked.currentVersion === options.sourceVersion
      && rollbackChecked.latestVersion === options.targetVersion,
    `rollback update check failed: ${JSON.stringify(rollbackChecked)}`)
    const rollbackMainLog = join(
      rollbackAcceptanceRoot, 'Library', 'Logs', PRODUCT_NAME, 'main.log',
    )
    const sourceReadyBeforeRollback = readyLogCount(rollbackMainLog, options.sourceVersion)
    const rollbackClosed = electronApp.waitForEvent('close', { timeout: 300_000 })
    const rollbackDownload = downloadUpdate(rollbackSourceWindow)
      .catch(error => ({ closedDuringInstall: true, message: String(error) }))
    await Promise.race([rollbackClosed, rollbackDownload])
    await rollbackClosed
    electronApp = undefined
    const rollbackUpdateRoot = join(rollbackUserDataRoot, 'desktop-updates')
    const rollbackTransactionRoot = join(rollbackUpdateRoot, 'transactions')
    const rollbackStatePath = await waitFor(() => {
      if (!existsSync(rollbackTransactionRoot)) return null
      const name = readdirSync(rollbackTransactionRoot).find(value => value.endsWith('.state.json'))
      return name === undefined ? null : join(rollbackTransactionRoot, name)
    }, 120_000, 'rollback update transaction state')
    const attempting = await waitFor(() => {
      const state = JSON.parse(readFileSync(rollbackStatePath, 'utf8')) as {
        readonly status?: string
        readonly launchedPid?: number
      }
      if (state.status === 'committed') throw new Error('rollback target committed before failure injection')
      if (state.status === 'restored' || state.status === 'failed') {
        throw new Error(`rollback target failed before process injection: ${JSON.stringify(state)}`)
      }
      return state.status === 'attempting' && running(state.launchedPid) ? state : null
    }, 300_000, 'rollback target attempting state')
    launchedPid = attempting.launchedPid
    const rollbackJobPath = join(
      rollbackTransactionRoot,
      `${basename(rollbackStatePath, '.state.json')}.json`,
    )
    const rollbackJob = JSON.parse(readFileSync(rollbackJobPath, 'utf8')) as {
      readonly backupAppPath: string
      readonly failedAppPath: string
    }
    assert(plist(rollbackCurrentApp, 'CFBundleShortVersionString') === options.targetVersion,
      'failure drill did not swap the target application into place')
    assert(plist(rollbackJob.backupAppPath, 'CFBundleShortVersionString') === options.sourceVersion,
      'failure drill did not retain the source application backup')
    assert(signalPackagedProcessIfOwned(
      launchedPid as number, 'SIGKILL', rollbackApplicationExecutables,
      [rollbackJobPath], [rollbackCurrentApp],
    ), 'rollback target PID no longer belongs to the packaged drill')
    await waitFor(() => packagedUpdateProcessTargets(
      processTable(), rollbackApplicationExecutables, [rollbackJobPath], [rollbackCurrentApp],
    ).allPids.includes(launchedPid as number) ? null : true, 30_000, 'injected target shutdown')
    launchedPid = undefined
    await waitFor(() => {
      const state = JSON.parse(readFileSync(rollbackStatePath, 'utf8')) as { readonly status?: string }
      if (state.status === 'committed' || state.status === 'failed') {
        throw new Error(`failure drill reached the wrong terminal state: ${JSON.stringify(state)}`)
      }
      return state.status === 'restored' ? state : null
    }, 180_000, 'packaged target failure restoration')
    assert(plist(rollbackCurrentApp, 'CFBundleShortVersionString') === options.sourceVersion,
      'source application version was not restored')
    assert(plist(rollbackJob.failedAppPath, 'CFBundleShortVersionString') === options.targetVersion,
      'failed target application was not isolated')
    assert(!existsSync(rollbackJob.backupAppPath), 'source application backup remained after restoration')
    assertUserStateRetained(rollbackRetainedState, captureUserState(rollbackFixture))
    await waitFor(() => readyLogCount(rollbackMainLog, options.sourceVersion) > sourceReadyBeforeRollback,
      300_000, 'restored source ready log')
    const rollbackStagingPath = join(
      rollbackUpdateRoot, 'staging', `${options.targetVersion}-${basename(rollbackStatePath, '.state.json')}`,
    )
    await waitFor(() => !existsSync(rollbackStagingPath) ? true : null, 120_000,
      'restored transaction staging moved to Trash after source ready')
    const legacyFailedTargetCleanupDeferred = compareSemanticVersions(options.sourceVersion, '0.4.0') < 0
    if (legacyFailedTargetCleanupDeferred) {
      // 已发布的 V0.3.x 不含终态清理器，无法事后立即回收失败槽；V0.4.0 成功启动时会消费该 schema 1 残留。
      assert(existsSync(rollbackJob.failedAppPath), 'legacy restored target was not retained in its isolated failed slot')
    } else {
      await waitFor(() => !existsSync(rollbackJob.failedAppPath) ? true : null, 120_000,
        'restored failed target moved to Trash after source ready')
    }
    for (const pid of processIdsForPackagedApplication(
      rollbackApplicationExecutables, [rollbackJobPath], [rollbackCurrentApp],
    )) {
      signalPackagedProcessIfOwned(
        pid, 'SIGTERM', rollbackApplicationExecutables, [rollbackJobPath], [rollbackCurrentApp],
      )
    }
    await waitFor(
      () => processIdsForPackagedApplication(
        rollbackApplicationExecutables, [rollbackJobPath], [rollbackCurrentApp],
      ).length === 0 ? true : null,
      30_000,
      'helper-restored source shutdown',
    )
    electronApp = await electron.launch({
      executablePath: rollbackExecutable, timeout: 300_000, env: rollbackEnvironment,
    })
    const restoredSourceWindow = await electronApp.firstWindow({ timeout: 300_000 })
    await assertCookie(restoredSourceWindow, rollbackCookieValue)
    await assertCredentialsDecrypt(electronApp, rollbackCredentialStore, rollbackCredentialValues)
    const restoredSessionTitles = await assertPackagedUpdateSourceState(restoredSourceWindow, rollbackFixture)
    // 目标版可能在故障注入前刷新仅用于展示的标题投影；恢复后允许旧版回退标题或规范标题，但不接受第三种值。
    assert([rollbackSessionTitles.active, rollbackFixture.expected.activeSessionTitle]
      .includes(restoredSessionTitles.active), 'restored active session title left the compatible title set')
    assert([rollbackSessionTitles.archived, rollbackFixture.expected.archivedSessionTitle]
      .includes(restoredSessionTitles.archived), 'restored archived session title left the compatible title set')
    assertUserStateRetained(rollbackRetainedState, captureUserState(rollbackFixture))
    await electronApp.close()
    electronApp = undefined
    record('packaged-failure-restores-source-and-user-state', {
      injectedFailure: 'SIGKILL exact helper-launched target PID before startup commit',
      restoredVersion: options.sourceVersion,
      failedTargetMovedToTrash: !legacyFailedTargetCleanupDeferred,
      failedTargetIsolated: true,
      failedTargetCleanupDeferredUntilSuccessfulRetry: legacyFailedTargetCleanupDeferred,
      restoredPersistedSessionTitles: restoredSessionTitles,
      categories: USER_STATE_CATEGORIES,
      persistentPartitionCookieRetained: true,
      savedCredentialRefsDecryptedByRestoredSource: true,
      savedPasswordAvailableWithoutRetyping: true,
      signedInSessionRetained: false,
      deviceBoundTokenVerified: false,
    })
    completed = true
  } catch (error) {
    failure = error
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    log(`failed ${message}`)
  } finally {
    const cleanupErrors: unknown[] = []
    let fallbackHelperJobPaths: string[] = []
    if (electronApp !== undefined) {
      try { await electronApp.close() } catch (error) { cleanupErrors.push(error) }
      electronApp = undefined
    }
    if (feed !== undefined) {
      try { await closeServer(feed.server) } catch (error) { cleanupErrors.push(error) }
      feed = undefined
    }
    try { fallbackHelperJobPaths = transactionJobPaths(transactionRoots) } catch (error) { cleanupErrors.push(error) }
    try {
      processCleanup = await terminatePackagedDrillProcesses(
        [...candidateExecutables], [...candidateApplicationRoots], transactionRoots,
      )
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (processCleanup !== undefined) {
      try {
        if (existsSync(drillRoot)) execFileSync('/usr/bin/trash', [drillRoot])
        trashStatus = 'moved-to-macos-trash'
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length > 0) {
      const cleanupFailure = new AggregateError(cleanupErrors, 'packaged update drill cleanup failed')
      failure = failure === undefined
        ? cleanupFailure
        : new AggregateError([failure, cleanupFailure], 'packaged update drill and cleanup failed')
      log(`failed ${cleanupFailure.stack ?? cleanupFailure.message}`)
    }
    const status = completed && failure === undefined ? 'passed' : 'failed'
    const accountBoundary = accountTestBoundary(options.targetKeychainAccess)
    const cleanup = {
      drillRoot,
      status: trashStatus,
      candidateApplicationRoots: processCleanup?.candidateApplicationRoots
        ?? [...candidateApplicationRoots].sort(),
      candidateExecutables: processCleanup?.candidateExecutables ?? [...candidateExecutables].sort(),
      helperJobPaths: processCleanup?.helperJobPaths ?? fallbackHelperJobPaths,
      applicationPidsTerminated: processCleanup?.applicationPids ?? [],
      detachedHelperPidsTerminated: processCleanup?.helperPids ?? [],
      allPidsTerminated: processCleanup?.allPids ?? [],
      forceKilledPids: processCleanup?.forceKilledPids ?? [],
      remainingPids: processCleanup === undefined ? null : [],
    }
    const receipt = status === 'passed'
      ? {
        schemaVersion: 5,
        status,
        generatedAt: new Date().toISOString(),
        sourceVersion: options.sourceVersion,
        targetVersion: options.targetVersion,
        architecture: options.architecture,
        sourceArchive: { path: options.sourceArchive, sha256: options.sourceArchiveSha256 },
        targetArchive: { path: options.targetArchive, sha256: options.targetArchiveSha256 },
        testBoundary: 'actual packaged source UI and updater against the exact signed target in isolated roots, including retained local state, migration into the frozen Keychain broker, saved-password reuse without retyping, and an injected pre-commit target crash with source restoration; production login and a device-bound token are not exercised',
        accountTestBoundary: accountBoundary,
        stages,
        cleanup,
      }
      : {
        schemaVersion: 5,
        status,
        generatedAt: new Date().toISOString(),
        sourceVersion: options.sourceVersion,
        targetVersion: options.targetVersion,
        architecture: options.architecture,
        accountTestBoundary: accountBoundary,
        stages,
        error: failure instanceof Error ? failure.stack ?? failure.message : String(failure),
        cleanup,
      }
    writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error(String(failure))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
