/** Detached helper that swaps one already-verified macOS application after its parent exits. */

import { execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, linkSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { MacUpdateInstallJob } from './macos-self-updater.ts'

const WAIT_STEP_MS = 250
const PARENT_EXIT_TIMEOUT_MS = 60_000
const NEW_LAUNCH_TIMEOUT_MS = 120_000
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SAFE_REPLACEMENT_OPTIONS = 3
const SAFE_REPLACEMENT_SCRIPT = `ObjC.import('Foundation')
function run(argv) {
  if (argv.length !== 3) throw new Error('invalid safe replacement arguments')
  const manager = $.NSFileManager.defaultManager
  const current = $.NSURL.fileURLWithPath(argv[0])
  const replacement = $.NSURL.fileURLWithPath(argv[1])
  const replaced = manager.replaceItemAtURLWithItemAtURLBackupItemNameOptionsResultingItemURLError(
    current, replacement, argv[2], ${String(SAFE_REPLACEMENT_OPTIONS)}, null, null)
  if (!replaced) throw new Error('safe application replacement failed')
}`
const SAFE_REPLACEMENT_PREFLIGHT_SCRIPT = `ObjC.import('Foundation')
function run(argv) {
  if (argv.length !== 1) throw new Error('invalid safe replacement preflight arguments')
  const value = Ref()
  const url = $.NSURL.fileURLWithPath(argv[0])
  const read = url.getResourceValueForKeyError(value, $.NSURLVolumeSupportsSwapRenamingKey, null)
  if (!read || !value[0] || !ObjC.unwrap(value[0])) {
    throw new Error('application volume does not support safe replacement')
  }
}`

/** Durable identity used to distinguish one launched process from a reused PID. */
export interface MacUpdateProcessIdentity {
  readonly pid: number
  readonly executablePath: string
  readonly startedAt: string
}

interface MacUpdateState {
  readonly schemaVersion: 1
  readonly transactionId: string
  readonly status: 'waiting' | 'attempting' | 'committed' | 'restoring' | 'restored' | 'failed'
  readonly expectedVersion: string
  readonly launchedPid?: number
  readonly launchedExecutablePath?: string
  readonly launchedProcessStartedAt?: string
  readonly helperPid?: number
  readonly helperExecutablePath?: string
  readonly helperProcessStartedAt?: string
  readonly error?: string
}

interface MacUpdateDecision {
  readonly schemaVersion: 1
  readonly transactionId: string
  readonly status: 'committed' | 'restoring'
  readonly expectedVersion: string
  readonly decidedPid: number
}

export interface MacUpdateLaunchHandle {
  readonly cleanupPaths: readonly string[]
  readonly jobPath: string
  readonly stateProjectionError?: unknown
  readonly status: 'attempting' | 'committed' | 'restoring'
  readonly transactionId: string
  readonly processIdentity: MacUpdateProcessIdentity
  /** Validated transaction identity pinned by beginMacUpdateLaunch. */
  readonly job: MacUpdateInstallJob
}

export interface MacUpdateCommitResult {
  readonly cleanupPaths: readonly string[]
  readonly stateProjectionError?: unknown
}

export interface MacUpdateRecoveryResult {
  readonly jobPath: string
  readonly stateProjectionError?: unknown
}

interface MacUpdateHelperOptions {
  readonly delay?: (milliseconds: number) => Promise<void>
  readonly launch?: (path: string) => Promise<void>
  readonly parentExitTimeoutMs?: number
  readonly persistState?: (job: MacUpdateInstallJob, state: MacUpdateState) => void
  readonly newLaunchTimeoutMs?: number
  readonly processIsRunning?: (pid: number) => boolean
  readonly processMatchesLaunch?: (identity: MacUpdateProcessIdentity) => boolean
  readonly replaceApplication?: (current: string, replacement: string, backup: string) => Promise<void>
  readonly stop?: (identity: MacUpdateProcessIdentity) => Promise<void>
}

interface MacUpdateHelperReadyOptions {
  readonly delay?: (milliseconds: number) => Promise<void>
  readonly expectedHelperIdentity?: MacUpdateProcessIdentity
  readonly mode?: 'install' | 'recovery'
  readonly processMatchesLaunch?: (identity: MacUpdateProcessIdentity) => boolean
  readonly processIsRunning?: (pid: number) => boolean
  readonly timeoutMs?: number
}

interface MacUpdateHelperHandoffOptions extends MacUpdateHelperReadyOptions {
  readonly exitTimeoutMs?: number
}

interface MacUpdateLaunchOptions {
  readonly persistState?: (job: MacUpdateInstallJob, state: MacUpdateState) => void
  readonly processIdentity?: () => MacUpdateProcessIdentity
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds) })
}

function normalizedError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(typeof error === 'string' ? error : '未知的 macOS 更新错误')
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Read the executable and kernel start time that identify one current process instance. */
export function macUpdateProcessIdentity(pid: number): MacUpdateProcessIdentity | null {
  try {
    const startedAt = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim()
    const executablePath = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim()
    return startedAt === '' || executablePath === ''
      ? null
      : Object.freeze({ pid, executablePath, startedAt })
  } catch {
    return null
  }
}

function processMatchesLaunch(identity: MacUpdateProcessIdentity): boolean {
  const current = macUpdateProcessIdentity(identity.pid)
  return current !== null && current.executablePath === identity.executablePath
    && current.startedAt === identity.startedAt
}

function stateProcessIdentity(state: MacUpdateState | null): MacUpdateProcessIdentity | null {
  return state?.launchedPid !== undefined && state.launchedExecutablePath !== undefined
    && state.launchedProcessStartedAt !== undefined
    ? Object.freeze({
      pid: state.launchedPid,
      executablePath: state.launchedExecutablePath,
      startedAt: state.launchedProcessStartedAt,
    })
    : null
}

function stateHelperIdentity(state: MacUpdateState | null): MacUpdateProcessIdentity | null {
  return state?.helperPid !== undefined && state.helperExecutablePath !== undefined
    && state.helperProcessStartedAt !== undefined
    ? Object.freeze({
      pid: state.helperPid,
      executablePath: state.helperExecutablePath,
      startedAt: state.helperProcessStartedAt,
    })
    : null
}

function helperIdentityStateFields(identity: MacUpdateProcessIdentity | null): Pick<
  MacUpdateState,
  'helperPid' | 'helperExecutablePath' | 'helperProcessStartedAt'
> | Record<string, never> {
  return identity === null ? {} : {
    helperPid: identity.pid,
    helperExecutablePath: identity.executablePath,
    helperProcessStartedAt: identity.startedAt,
  }
}

function identityStateFields(identity: MacUpdateProcessIdentity | null): Pick<
  MacUpdateState,
  'launchedPid' | 'launchedExecutablePath' | 'launchedProcessStartedAt'
> | Record<string, never> {
  return identity === null ? {} : {
    launchedPid: identity.pid,
    launchedExecutablePath: identity.executablePath,
    launchedProcessStartedAt: identity.startedAt,
  }
}

function sameProcessIdentity(left: MacUpdateProcessIdentity, right: MacUpdateProcessIdentity | null): boolean {
  return right !== null && left.pid === right.pid && left.executablePath === right.executablePath
    && left.startedAt === right.startedAt
}

function runJxa(script: string, argumentsValue: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...argumentsValue], {
      windowsHide: true,
    }, (error) => {
      if (error === null) resolvePromise()
      else rejectPromise(new Error(error.message, { cause: error }))
    })
  })
}

async function safeReplaceApplication(current: string, replacement: string, backup: string): Promise<void> {
  await runJxa(SAFE_REPLACEMENT_SCRIPT, [current, replacement, basename(backup)])
}

/** Verify that the installed application's volume supports Foundation safe replacement. */
export async function verifyMacSafeReplacementSupport(
  applicationPath: string,
  runProgram: (executable: string, argumentsValue: readonly string[]) => Promise<void>,
): Promise<void> {
  await runProgram('/usr/bin/osascript', [
    '-l', 'JavaScript', '-e', SAFE_REPLACEMENT_PREFLIGHT_SCRIPT, resolve(applicationPath),
  ])
}

function entityDirectory(path: string): boolean {
  try {
    const info = lstatSync(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

function writeState(job: MacUpdateInstallJob, state: MacUpdateState): void {
  const temporary = `${job.statePath}.next-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, job.statePath)
}

function readState(job: MacUpdateInstallJob): MacUpdateState | null {
  try {
    const value = JSON.parse(readFileSync(job.statePath, 'utf8')) as Partial<MacUpdateState>
    const hasExecutable = value.launchedExecutablePath !== undefined
    const hasStartedAt = value.launchedProcessStartedAt !== undefined
    const hasHelperExecutable = value.helperExecutablePath !== undefined
    const hasHelperStartedAt = value.helperProcessStartedAt !== undefined
    const launchIdentityIsValid = value.launchedPid === undefined
      ? !hasExecutable && !hasStartedAt
      : Number.isSafeInteger(value.launchedPid) && value.launchedPid > 1
        && hasExecutable === hasStartedAt
        && (!hasExecutable || (typeof value.launchedExecutablePath === 'string'
          && value.launchedExecutablePath !== '' && typeof value.launchedProcessStartedAt === 'string'
          && value.launchedProcessStartedAt !== ''))
    const helperIdentityIsValid = value.helperPid === undefined
      ? !hasHelperExecutable && !hasHelperStartedAt
      : Number.isSafeInteger(value.helperPid) && value.helperPid > 1
        && hasHelperExecutable && hasHelperStartedAt
        && typeof value.helperExecutablePath === 'string' && value.helperExecutablePath !== ''
        && typeof value.helperProcessStartedAt === 'string' && value.helperProcessStartedAt !== ''
    return value.schemaVersion === 1 && value.transactionId === job.transactionId
      && (value.status === 'waiting' || value.status === 'attempting' || value.status === 'committed'
        || value.status === 'restoring' || value.status === 'restored' || value.status === 'failed')
      && typeof value.expectedVersion === 'string' && launchIdentityIsValid && helperIdentityIsValid
      ? value as MacUpdateState
      : null
  } catch {
    return null
  }
}

function decisionPath(job: MacUpdateInstallJob): string {
  return join(dirname(job.statePath), `${job.transactionId}.decision.json`)
}

function readDecision(job: MacUpdateInstallJob): MacUpdateDecision | null {
  try {
    const path = decisionPath(job)
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) return null
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<MacUpdateDecision>
    return value.schemaVersion === 1 && value.transactionId === job.transactionId
      && (value.status === 'committed' || value.status === 'restoring')
      && value.expectedVersion === job.expectedVersion && Number.isSafeInteger(value.decidedPid)
      ? value as MacUpdateDecision
      : null
  } catch {
    return null
  }
}

function claimDecision(job: MacUpdateInstallJob, status: MacUpdateDecision['status']): MacUpdateDecision {
  const existing = readDecision(job)
  if (existing !== null) return existing
  const decision: MacUpdateDecision = Object.freeze({
    schemaVersion: 1,
    transactionId: job.transactionId,
    status,
    expectedVersion: job.expectedVersion,
    decidedPid: process.pid,
  })
  const target = decisionPath(job)
  const candidate = `${target}.candidate-${process.pid}-${randomUUID()}`
  writeFileSync(candidate, `${JSON.stringify(decision, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    // The fully written candidate and the target share one inode. link(2)
    // fails with EEXIST, so commit and restore cannot both win.
    linkSync(candidate, target)
    chmodSync(target, 0o400)
    return decision
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const winner = readDecision(job)
    if (winner === null) throw new Error('macOS 更新事务决策文件无效')
    return winner
  }
}

function validateJob(value: unknown, requireInstallDirectories = true): MacUpdateInstallJob {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('更新任务格式无效')
  const job = value as Partial<MacUpdateInstallJob>
  if ((job.schemaVersion !== 1 && job.schemaVersion !== 2)
    || typeof job.transactionId !== 'string' || !UUID_PATTERN.test(job.transactionId)
    || !Number.isSafeInteger(job.parentPid) || Number(job.parentPid) <= 1
    || typeof job.expectedVersion !== 'string' || !VERSION_PATTERN.test(job.expectedVersion)
    || typeof job.currentAppPath !== 'string' || typeof job.stagedAppPath !== 'string'
    || typeof job.backupAppPath !== 'string' || typeof job.failedAppPath !== 'string'
    || typeof job.statePath !== 'string') throw new Error('更新任务身份无效')
  if (job.schemaVersion === 2 && (typeof job.parentExecutablePath !== 'string'
    || job.parentExecutablePath === '' || typeof job.parentProcessStartedAt !== 'string'
    || job.parentProcessStartedAt === '')) throw new Error('更新任务父进程身份无效')
  const paths = [job.currentAppPath, job.stagedAppPath, job.backupAppPath, job.failedAppPath]
    .map(path => resolve(path))
  const parent = dirname(paths[0] ?? '')
  if (new Set(paths).size !== paths.length || paths.some(path => dirname(path) !== parent || !path.endsWith('.app'))
    || basename(paths[1] ?? '') !== `.洞见.next-${job.transactionId}.app`
    || basename(paths[2] ?? '') !== `.洞见.previous-${job.transactionId}.app`
    || basename(paths[3] ?? '') !== `.洞见.failed-${job.transactionId}.app`) {
    throw new Error('更新任务应用路径无效')
  }
  if (requireInstallDirectories && (!entityDirectory(paths[0] ?? '') || !entityDirectory(paths[1] ?? ''))) {
    throw new Error('更新任务应用目录不可用')
  }
  return Object.freeze({
    schemaVersion: job.schemaVersion,
    transactionId: job.transactionId,
    parentPid: Number(job.parentPid),
    ...(job.parentExecutablePath === undefined ? {} : { parentExecutablePath: job.parentExecutablePath }),
    ...(job.parentProcessStartedAt === undefined ? {} : { parentProcessStartedAt: job.parentProcessStartedAt }),
    expectedVersion: job.expectedVersion,
    currentAppPath: paths[0] ?? '',
    stagedAppPath: paths[1] ?? '',
    backupAppPath: paths[2] ?? '',
    failedAppPath: paths[3] ?? '',
    statePath: resolve(job.statePath),
  })
}

/** Remove helper-only Electron flags before Launch Services starts the GUI app. */
export function macUpdateLaunchEnvironment(
  environment: NodeJS.ProcessEnv,
  transactionId?: string,
): NodeJS.ProcessEnv {
  const result = { ...environment }
  delete result.ELECTRON_RUN_AS_NODE
  delete result.GONGCHUANG_UPDATE_HELPER
  if (transactionId === undefined) delete result.GONGCHUANG_UPDATE_TRANSACTION_ID
  else result.GONGCHUANG_UPDATE_TRANSACTION_ID = transactionId
  return result
}

function launch(path: string, transactionId?: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('/usr/bin/open', ['-n', path], {
      env: macUpdateLaunchEnvironment(process.env, transactionId),
      windowsHide: true,
    }, (error) => {
      if (error === null) resolvePromise()
      else rejectPromise(new Error(error.message, { cause: error }))
    })
  })
}

async function stop(identity: MacUpdateProcessIdentity): Promise<void> {
  if (!processMatchesLaunch(identity)) return
  try { process.kill(identity.pid, 'SIGTERM') } catch { return }
  for (let elapsed = 0; elapsed < 10_000 && processMatchesLaunch(identity); elapsed += WAIT_STEP_MS) {
    await delay(WAIT_STEP_MS)
  }
  // The start time and executable are re-read immediately before SIGKILL. A
  // reused PID therefore cannot transfer this update's stop authority.
  if (processMatchesLaunch(identity)) {
    try { process.kill(identity.pid, 'SIGKILL') } catch { /* already exited */ }
  }
}

async function restore(
  job: MacUpdateInstallJob,
  reason: string,
  launchApplication: (path: string) => Promise<void>,
  stopProcess: (identity: MacUpdateProcessIdentity) => Promise<void>,
  persistState: (job: MacUpdateInstallJob, state: MacUpdateState) => void,
  replaceApplication: (current: string, replacement: string, backup: string) => Promise<void>,
  matchesLaunch: (identity: MacUpdateProcessIdentity) => boolean,
): Promise<void> {
  const state = readState(job)
  // The new process can commit between the helper's liveness probe and the
  // recovery branch. Never roll back an already committed transaction.
  if (state?.status === 'committed') return
  if (job.schemaVersion === 2) {
    const decision = claimDecision(job, 'restoring')
    if (decision.status === 'committed') return
    try {
      persistState(job, {
        schemaVersion: 1,
        transactionId: job.transactionId,
        status: 'restoring',
        expectedVersion: job.expectedVersion,
        ...identityStateFields(stateProcessIdentity(state)),
      })
    } catch {
      // The immutable restoring decision remains authoritative when its diagnostic projection is unwritable.
    }
  }
  const launchedProcess = stateProcessIdentity(state)
  if (launchedProcess !== null && matchesLaunch(launchedProcess)) await stopProcess(launchedProcess)
  const currentExists = entityDirectory(job.currentAppPath)
  const backupExists = entityDirectory(job.backupAppPath)
  const failedExists = entityDirectory(job.failedAppPath)
  if (backupExists) {
    if (currentExists) {
      if (failedExists) throw new Error('更新恢复目录状态冲突')
      if (job.schemaVersion === 2) {
        await replaceApplication(job.currentAppPath, job.backupAppPath, job.failedAppPath)
      } else {
        renameSync(job.currentAppPath, job.failedAppPath)
        renameSync(job.backupAppPath, job.currentAppPath)
      }
    } else {
      // This only repairs schema 1 jobs and schema 2 jobs interrupted by an
      // older helper. New schema 2 replacements never remove the canonical
      // application path between operations.
      renameSync(job.backupAppPath, job.currentAppPath)
    }
  } else if (!currentExists || !failedExists) {
    throw new Error('更新失败且更新前应用备份不可用')
  }
  let stateError: unknown
  try {
    persistState(job, {
      schemaVersion: 1,
      transactionId: job.transactionId,
      status: 'restored',
      expectedVersion: job.expectedVersion,
      error: reason.slice(0, 1_000),
    })
  } catch (error) {
    stateError = error
  }
  let launchError: unknown
  try {
    // 状态文件可能因磁盘满或权限异常持续写入失败，但旧应用已经恢复到
    // 正式路径。重新打开旧应用不能被诊断状态写入阻断。
    await launchApplication(job.currentAppPath)
  } catch (error) {
    launchError = error
  }
  if (stateError !== undefined && launchError !== undefined) {
    throw new AggregateError([stateError, launchError], '旧应用已恢复，但恢复状态和重新打开均失败')
  }
  if (stateError !== undefined) {
    throw normalizedError(stateError)
  }
  if (launchError !== undefined) {
    throw normalizedError(launchError)
  }
}

/** Run the verified recoverable swap and restore the previous app if startup never commits. */
export async function applyMacUpdate(jobPath: string, options: MacUpdateHelperOptions = {}): Promise<void> {
  const parsedJob = JSON.parse(readFileSync(jobPath, 'utf8')) as unknown
  let job = validateJob(parsedJob, false)
  const delayStep = options.delay ?? delay
  const launchApplication = options.launch ?? ((path: string) => launch(path))
  const launchReplacement = options.launch ?? ((path: string) => launch(path, job.transactionId))
  const isRunning = options.processIsRunning ?? processIsRunning
  const matchesLaunch = options.processMatchesLaunch ?? processMatchesLaunch
  const persistState = options.persistState ?? writeState
  const replaceApplication = options.replaceApplication ?? safeReplaceApplication
  const stopProcess = options.stop ?? stop
  const parentExitTimeout = options.parentExitTimeoutMs ?? PARENT_EXIT_TIMEOUT_MS
  const newLaunchTimeout = options.newLaunchTimeoutMs ?? NEW_LAUNCH_TIMEOUT_MS
  const parentIdentity = job.schemaVersion === 2
    ? Object.freeze({
      pid: job.parentPid,
      executablePath: job.parentExecutablePath ?? '',
      startedAt: job.parentProcessStartedAt ?? '',
    })
    : null
  if (job.schemaVersion === 2) {
    const decision = readDecision(job)
    if (decision?.status === 'committed') return
    if (decision?.status === 'restoring') {
      await restore(
        job, '继续完成上次中断的更新恢复', launchApplication, stopProcess, persistState,
        replaceApplication, matchesLaunch,
      )
      return
    }
  }
  job = validateJob(parsedJob)
  const helperIdentity = job.schemaVersion === 2 ? macUpdateProcessIdentity(process.pid) : null
  if (job.schemaVersion === 2 && helperIdentity === null) {
    throw new Error('无法绑定 macOS 更新辅助进程身份')
  }
  persistState(job, {
    schemaVersion: 1,
    transactionId: job.transactionId,
    status: 'waiting',
    expectedVersion: job.expectedVersion,
    ...helperIdentityStateFields(helperIdentity),
  })
  const parentIsRunning = (): boolean => parentIdentity === null
    ? isRunning(job.parentPid)
    : matchesLaunch(parentIdentity)
  for (let elapsed = 0; elapsed < parentExitTimeout && parentIsRunning(); elapsed += WAIT_STEP_MS) {
    await delayStep(WAIT_STEP_MS)
  }
  if (parentIsRunning()) throw new Error('当前客户端未在更新时限内退出')
  try {
    if (job.schemaVersion === 2) {
      await replaceApplication(job.currentAppPath, job.stagedAppPath, job.backupAppPath)
    } else {
      renameSync(job.currentAppPath, job.backupAppPath)
    }
  } catch (error) {
    let stateError: unknown
    try {
      persistState(job, {
        schemaVersion: 1,
        transactionId: job.transactionId,
        status: 'failed',
        expectedVersion: job.expectedVersion,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      })
    } catch (persistError) {
      stateError = persistError
    }
    let reopenError: unknown
    try { await launchApplication(job.currentAppPath) } catch (launchError) { reopenError = launchError }
    if (stateError !== undefined || reopenError !== undefined) {
      throw new AggregateError(
        [error, ...(stateError === undefined ? [] : [stateError]), ...(reopenError === undefined ? [] : [reopenError])],
        reopenError === undefined ? '更新无法开始，当前应用已重新打开但事务终态写入失败' : '更新无法开始，当前应用重新打开也失败',
      )
    }
    throw error
  }
  try {
    if (job.schemaVersion === 1) renameSync(job.stagedAppPath, job.currentAppPath)
    persistState(job, {
      schemaVersion: 1,
      transactionId: job.transactionId,
      status: 'attempting',
      expectedVersion: job.expectedVersion,
    })
    await launchReplacement(job.currentAppPath)
  } catch (error) {
    await restore(
      job,
      error instanceof Error ? error.message : String(error),
      launchApplication,
      stopProcess,
      persistState,
      replaceApplication,
      matchesLaunch,
    )
    throw error
  }
  for (let elapsed = 0; elapsed < newLaunchTimeout; elapsed += WAIT_STEP_MS) {
    const state = readState(job)
    if (state?.status === 'committed') return
    const launchedProcess = stateProcessIdentity(state)
    if (launchedProcess !== null && !matchesLaunch(launchedProcess)) {
      // Confirm the same failure observation after one poll interval. The new
      // app records its PID before completing startup, so a stale state read
      // must not race a successful commit into an unnecessary rollback.
      await delayStep(WAIT_STEP_MS)
      const confirmedState = readState(job)
      if (confirmedState?.status === 'committed') return
      if (!sameProcessIdentity(launchedProcess, stateProcessIdentity(confirmedState))
        || matchesLaunch(launchedProcess)) continue
      await restore(
        job, '新版本在完成启动验收前退出', launchApplication, stopProcess, persistState,
        replaceApplication, matchesLaunch,
      )
      return
    }
    await delayStep(WAIT_STEP_MS)
  }
  await restore(
    job, '新版本未在时限内完成启动验收', launchApplication, stopProcess, persistState,
    replaceApplication, matchesLaunch,
  )
}

/** Wait until the detached helper durably records that it owns the install handoff. */
export async function waitForMacUpdateHelperReady(
  jobPath: string,
  helperPid: number,
  options: MacUpdateHelperReadyOptions = {},
): Promise<void> {
  const job = validateJob(JSON.parse(readFileSync(jobPath, 'utf8')) as unknown, false)
  const delayStep = options.delay ?? delay
  const isRunning = options.processIsRunning ?? processIsRunning
  const matchesLaunch = options.processMatchesLaunch ?? processMatchesLaunch
  const mode = options.mode ?? 'install'
  const timeout = options.timeoutMs ?? 10_000
  for (let elapsed = 0; elapsed < timeout; elapsed += WAIT_STEP_MS) {
    const state = readState(job)
    const helperProcessMatches = options.expectedHelperIdentity === undefined
      ? isRunning(helperPid)
      : matchesLaunch(options.expectedHelperIdentity)
    const helperReceiptMatches = options.expectedHelperIdentity === undefined
      ? helperProcessMatches
      : sameProcessIdentity(options.expectedHelperIdentity, stateHelperIdentity(state)) && helperProcessMatches
    if (mode === 'install' && state?.status === 'waiting' && helperReceiptMatches) return
    if (mode === 'recovery' && state?.status === 'restored') return
    if (mode === 'recovery' && state?.status === 'restoring' && helperReceiptMatches) return
    if (mode === 'recovery' && job.schemaVersion === 2
      && readDecision(job)?.status === 'restoring' && helperProcessMatches) return
    if (!isRunning(helperPid)) throw new Error('macOS 更新辅助程序在接管安装前退出')
    await delayStep(WAIT_STEP_MS)
  }
  throw new Error('macOS 更新辅助程序未在时限内接管安装')
}

/** Wait for helper ownership; on failure, kill and reap the spawned helper before rejecting. */
export async function waitForMacUpdateHelperHandoff(
  jobPath: string,
  child: ChildProcess,
  helperIdentity: MacUpdateProcessIdentity,
  options: MacUpdateHelperHandoffOptions = {},
): Promise<void> {
  if (child.pid === undefined || child.pid !== helperIdentity.pid) {
    throw new Error('macOS 更新辅助程序进程身份无效')
  }
  try {
    await waitForMacUpdateHelperReady(jobPath, child.pid, { ...options, expectedHelperIdentity: helperIdentity })
    child.unref()
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      const matchesHelper = options.processMatchesLaunch ?? processMatchesLaunch
      if (matchesHelper(helperIdentity)) child.kill('SIGKILL')
      const exitTimeout = options.exitTimeoutMs ?? 5_000
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          exited,
          new Promise<never>((_resolvePromise, rejectPromise) => {
            timer = setTimeout(() => { rejectPromise(new Error('macOS 更新辅助程序未在终止后退出')) }, exitTimeout)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    throw error
  }
}

if (process.env.GONGCHUANG_UPDATE_HELPER === '1' && process.argv[2] !== undefined) {
  void applyMacUpdate(process.argv[2]).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

/** Record one exact replacement launch and return a pinned transaction handle. */
export function beginMacUpdateLaunch(
  updateRoot: string,
  currentVersion: string,
  currentAppPath: string,
  requestedTransactionId = process.env.GONGCHUANG_UPDATE_TRANSACTION_ID,
  options: MacUpdateLaunchOptions = {},
): MacUpdateLaunchHandle | null {
  const transactionRoot = join(updateRoot, 'transactions')
  let names: string[]
  try { names = readdirSync(transactionRoot) } catch { return null }
  const states = names.filter(name => name.endsWith('.state.json')).sort().reverse()
  const matches: Array<{
    readonly job: MacUpdateInstallJob
    readonly jobPath: string
    readonly state: MacUpdateState
  }> = []
  for (const name of states) {
    const statePath = join(transactionRoot, name)
    let state: MacUpdateState
    try { state = JSON.parse(readFileSync(statePath, 'utf8')) as MacUpdateState } catch { continue }
    if ((state.status !== 'waiting' && state.status !== 'attempting' && state.status !== 'committed'
      && state.status !== 'restoring')
      || state.expectedVersion !== currentVersion) continue
    if (requestedTransactionId !== undefined && state.transactionId !== requestedTransactionId) continue
    const jobPath = join(transactionRoot, `${state.transactionId}.json`)
    let job: MacUpdateInstallJob
    try { job = validateJob(JSON.parse(readFileSync(jobPath, 'utf8')) as unknown, false) } catch { continue }
    const terminalDecision = job.schemaVersion === 2 ? readDecision(job) : null
    // 普通启动没有更新事务标识时，不得重新绑定已经提交的历史事务。
    // 否则每次打开客户端都会改写旧事务 PID，多个同版本历史事务还会阻断正常启动。
    if (requestedTransactionId === undefined
      && (state.status === 'committed' || terminalDecision?.status === 'committed')) continue
    if (state.status === 'waiting' && job.schemaVersion !== 2) continue
    if (resolve(job.currentAppPath) !== resolve(currentAppPath)) continue
    matches.push(Object.freeze({ job, jobPath, state }))
  }
  if (matches.length > 1) throw new Error('存在多个同版本 macOS 更新事务，无法安全提交')
  const match = matches[0]
  if (match === undefined) return null
  const { job, jobPath, state } = match
  const cleanupPaths = Object.freeze([
    job.backupAppPath,
    join(updateRoot, 'staging', `${state.expectedVersion}-${state.transactionId}`),
  ])
  const decision = job.schemaVersion === 2 ? readDecision(job) : null
  if (state.status === 'committed' && job.schemaVersion === 2 && decision?.status !== 'committed') {
    throw new Error('macOS 更新提交状态缺少不可变事务决策')
  }
  const processIdentity = options.processIdentity?.() ?? macUpdateProcessIdentity(process.pid)
  if (processIdentity === null || processIdentity.pid !== process.pid) {
    throw new Error('无法绑定 macOS 更新目标进程身份')
  }
  const persistState = options.persistState ?? writeState
  if (decision?.status === 'committed' || (job.schemaVersion === 1 && state.status === 'committed')) {
    let stateProjectionError: unknown
    try {
      persistState(job, {
        schemaVersion: 1,
        transactionId: state.transactionId,
        status: 'committed',
        expectedVersion: currentVersion,
        ...identityStateFields(processIdentity),
      })
    } catch (error) {
      stateProjectionError = error
    }
    return Object.freeze({
      cleanupPaths, job, jobPath, processIdentity, stateProjectionError,
      status: 'committed', transactionId: state.transactionId,
    })
  }
  let stateProjectionError: unknown
  try {
    persistState(job, {
      schemaVersion: 1,
      transactionId: state.transactionId,
      status: decision?.status === 'restoring' ? 'restoring' : 'attempting',
      expectedVersion: currentVersion,
      ...identityStateFields(processIdentity),
    })
  } catch (error) {
    if (decision?.status !== 'restoring' || job.schemaVersion === 1) throw error
    stateProjectionError = error
  }
  return Object.freeze({
    cleanupPaths, job, jobPath, processIdentity,
    ...(stateProjectionError === undefined ? {} : { stateProjectionError }),
    status: decision?.status === 'restoring' ? 'restoring' : 'attempting',
    transactionId: state.transactionId,
  })
}

/** Claim recovery for a pinned launch before starting the detached recovery helper. */
export function beginMacUpdateRecovery(
  handle: MacUpdateLaunchHandle,
  reason: string,
  persistState: (job: MacUpdateInstallJob, state: MacUpdateState) => void = writeState,
): MacUpdateRecoveryResult {
  if (handle.status === 'committed') throw new Error('macOS 更新已经提交，不能再进入恢复流程')
  if (handle.job.schemaVersion === 2) {
    const decision = claimDecision(handle.job, 'restoring')
    if (decision.status !== 'restoring') throw new Error('macOS 更新已经提交，不能再进入恢复流程')
  }
  let stateProjectionError: unknown
  try {
    persistState(handle.job, {
      schemaVersion: 1,
      transactionId: handle.transactionId,
      status: 'restoring',
      expectedVersion: handle.job.expectedVersion,
      ...identityStateFields(handle.processIdentity),
      error: reason.slice(0, 1_000),
    })
  } catch (error) {
    if (handle.job.schemaVersion === 1) throw error
    stateProjectionError = error
  }
  return Object.freeze({
    jobPath: handle.jobPath,
    ...(stateProjectionError === undefined ? {} : { stateProjectionError }),
  })
}

/** Return transaction-owned residue that is safe to Trash after a real product startup. */
export function macUpdateTerminalCleanupPaths(
  updateRoot: string,
  currentAppPath: string,
  currentVersion?: string,
): readonly string[] {
  const transactionRoot = join(updateRoot, 'transactions')
  let names: string[]
  try { names = readdirSync(transactionRoot) } catch { return [] }
  const cleanup = new Set<string>()
  for (const name of names.filter(value => value.endsWith('.state.json'))) {
    const transactionId = name.slice(0, -'.state.json'.length)
    const statePath = join(transactionRoot, name)
    const jobPath = join(transactionRoot, `${transactionId}.json`)
    let job: MacUpdateInstallJob
    try { job = validateJob(JSON.parse(readFileSync(jobPath, 'utf8')) as unknown, false) } catch { continue }
    if (job.transactionId !== transactionId || resolve(job.statePath) !== resolve(statePath)
      || resolve(job.currentAppPath) !== resolve(currentAppPath) || !entityDirectory(job.currentAppPath)) continue
    const state = readState(job)
    const decision = job.schemaVersion === 2 ? readDecision(job) : null
    if ((state?.status === 'committed' && (job.schemaVersion === 1 || decision?.status === 'committed'))
      || decision?.status === 'committed') {
      cleanup.add(job.backupAppPath)
      cleanup.add(job.stagedAppPath)
    } else if ((state?.status === 'restored' && (job.schemaVersion === 1 || decision?.status === 'restoring'))
      || (decision?.status === 'restoring' && !entityDirectory(job.backupAppPath))) {
      // A schema 2 restoring decision plus an absent backup means the safe
      // reverse replacement has completed. This function is called only after
      // the restored product reaches ready, so a stale diagnostic projection
      // cannot strand the failed slot without exposing active swap state.
      if (entityDirectory(job.backupAppPath)) continue
      cleanup.add(job.failedAppPath)
      cleanup.add(job.stagedAppPath)
    } else if (state?.status === 'failed') {
      cleanup.add(job.stagedAppPath)
    } else if (state?.status === 'waiting' && job.schemaVersion === 2 && decision === null
      && currentVersion !== undefined && state.expectedVersion !== currentVersion) {
      const helperIdentity = stateHelperIdentity(state)
      if (helperIdentity === null || processMatchesLaunch(helperIdentity)) continue
      try {
        writeState(job, {
          schemaVersion: 1,
          transactionId: job.transactionId,
          status: 'failed',
          expectedVersion: job.expectedVersion,
          error: '更新辅助程序在替换应用前退出，当前版本已重新启动',
        })
      } catch {
        // Keep the staged application while the terminal state cannot be made durable.
        continue
      }
      cleanup.add(job.stagedAppPath)
    } else {
      continue
    }
    cleanup.add(join(updateRoot, 'staging', `${job.expectedVersion}-${job.transactionId}`))
  }
  return Object.freeze([...cleanup])
}

/** Commit the exact transaction returned by beginMacUpdateLaunch after complete product startup. */
export function commitMacUpdateLaunch(handle: MacUpdateLaunchHandle): MacUpdateCommitResult {
  if (handle.status === 'restoring') throw new Error('macOS 更新已进入旧版本恢复流程')
  if (handle.status === 'committed') {
    return Object.freeze({
      cleanupPaths: handle.cleanupPaths,
      ...(handle.stateProjectionError === undefined ? {} : { stateProjectionError: handle.stateProjectionError }),
    })
  }
  if (handle.job.schemaVersion === 2) {
    const decision = claimDecision(handle.job, 'committed')
    if (decision.status !== 'committed') throw new Error('macOS 更新已进入旧版本恢复流程')
  }
  let stateProjectionError: unknown
  try {
    writeState(handle.job, {
      schemaVersion: 1,
      transactionId: handle.transactionId,
      status: 'committed',
      expectedVersion: handle.job.expectedVersion,
      ...identityStateFields(handle.processIdentity),
    })
  } catch (error) {
    if (handle.job.schemaVersion === 1) throw error
    stateProjectionError = error
  }
  return Object.freeze({
    cleanupPaths: handle.cleanupPaths,
    ...(stateProjectionError === undefined ? {} : { stateProjectionError }),
  })
}
