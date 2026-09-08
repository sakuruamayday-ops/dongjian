/** Native credential-store adapters used by the product credential provider. */

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface as ReadLineInterface } from 'node:readline'

const COMMAND_TIMEOUT_MS = 30_000
/**
 * macOS 在应用签名身份变化后可能让 safeStorage 长时间等待钥匙串授权。
 * 每次原生调用都必须有边界，避免模型启动与客户端退出被同一个系统提示永久阻塞。
 */
export const MACOS_KEYCHAIN_OPERATION_TIMEOUT_MS = 15_000
const MACOS_KEYCHAIN_TEMPORARILY_UNAVAILABLE = 'gongchuang-credentials-keychain: macOS Keychain is temporarily unavailable'
const ENCRYPTED_STORE_FILENAME = 'credentials.secure.v1.json'
const MACOS_BROKER_STATE_FILENAME = 'credentials.keychain.v2.json'
const MAX_STORE_BYTES = 1024 * 1024
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class GongchuangCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite([In] ref CREDENTIAL credential, UInt32 flags);
  [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credentialPtr);
  [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("Advapi32.dll", EntryPoint="CredFree", SetLastError=false)]
  public static extern void CredFree(IntPtr buffer);
}
'@
if (-not ('GongchuangCredentialManager' -as [type])) { Add-Type -TypeDefinition $source }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $request = $line | ConvertFrom-Json
    $target = 'cn.dongjian.desktop:' + [string]$request.ref
    $type = [uint32]1
    $result = $null
    if ($request.op -eq 'read') {
      $pointer = [IntPtr]::Zero
      if (-not [GongchuangCredentialManager]::CredRead($target, $type, 0, [ref]$pointer)) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($code -eq 1168) { $result = @{ found = $false } }
        else { throw "CredRead failed with Win32 code $code" }
      } else {
        try {
          $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][GongchuangCredentialManager+CREDENTIAL])
          $value = [Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob, [int]($credential.CredentialBlobSize / 2))
          $result = @{ found = $true; value = $value }
        } finally { [GongchuangCredentialManager]::CredFree($pointer) }
      }
    } elseif ($request.op -eq 'write') {
      $value = [string]$request.value
      $blob = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($value)
      try {
        $credential = New-Object GongchuangCredentialManager+CREDENTIAL
        $credential.Type = $type
        $credential.TargetName = $target
        $credential.CredentialBlobSize = [uint32]([Text.Encoding]::Unicode.GetByteCount($value))
        $credential.CredentialBlob = $blob
        $credential.Persist = [uint32]2
        $credential.UserName = 'gongchuang-client'
        if (-not [GongchuangCredentialManager]::CredWrite([ref]$credential, 0)) {
          $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
          throw "CredWrite failed with Win32 code $code"
        }
      } finally { [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($blob) }
      $result = @{ ok = $true }
    } elseif ($request.op -eq 'delete') {
      if (-not [GongchuangCredentialManager]::CredDelete($target, $type, 0)) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($code -ne 1168) { throw "CredDelete failed with Win32 code $code" }
      }
      $result = @{ ok = $true }
    } else { throw 'Unsupported credential operation' }
    [Console]::Out.WriteLine((ConvertTo-Json -Compress @{ ok = $true; result = $result }))
  } catch {
    [Console]::Out.WriteLine('{"ok":false}')
  }
  [Console]::Out.Flush()
}
`

/** Platform credential store operations keyed by a product-owned reference. */
export interface CredentialBackend {
  read(ref: string): Promise<string | undefined>
  write(ref: string, value: string): Promise<void>
  remove(ref: string): Promise<void>
  close(): Promise<void>
}

/** Injectable serialized session used by the Windows Credential Manager adapter. */
export interface NativeCredentialSession {
  request<T>(request: object): Promise<T>
  close(): Promise<void>
}

/**
 * Data contract for safe storage adapter.
 */
export interface SafeStorageAdapter {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{
    result: string
    shouldReEncrypt: boolean
    isTemporarilyUnavailable?: boolean
  }>
}

/**
 * Data contract for macos safe storage runtime.
 */
export interface MacosSafeStorageRuntime {
  readonly safeStorage: SafeStorageAdapter
  readonly userDataPath: string
  /** Present only in a packaged client that carries the frozen native broker. */
  readonly credentialBrokerPath?: string
}

interface EncryptedStore {
  version: 1
  entries: Record<string, string>
}

interface MacosBrokerState {
  version: 2
  entries: Record<string, 'present' | 'removed'>
}

interface LegacyMacosBackend extends CredentialBackend {
  /** Decrypt one immutable snapshot serially so first-upgrade authorization is requested only once. */
  readAll(): Promise<Readonly<Record<string, string>>>
}

async function macosKeychainOperation<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = Promise.resolve().then(operation)
  const deadline = new Promise<never>((_resolvePromise, rejectPromise) => {
    timer = setTimeout(() => {
      rejectPromise(new Error(MACOS_KEYCHAIN_TEMPORARILY_UNAVAILABLE))
    }, MACOS_KEYCHAIN_OPERATION_TIMEOUT_MS)
  })
  try {
    return await Promise.race([pending, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * One long-lived newline-delimited JSON session for Windows Credential Manager.
 * Credential reads are serialized because each request consumes exactly one
 * response line; re-spawning PowerShell per read made startup latency grow with
 * the number of configured model and MCP credentials.
 */
class NdjsonCredentialSession implements NativeCredentialSession {
  private child: ChildProcessWithoutNullStreams | undefined
  private reader: ReadLineInterface | undefined
  private pendingReject: ((error: Error) => void) | undefined
  private operation: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly command: string,
    private readonly argumentsValue: readonly string[],
  ) {}

  request<T>(request: object): Promise<T> {
    if (this.closed) return Promise.reject(new Error('credential backend session is closed'))
    const task = this.operation.then(async () => this.invoke<T>(request))
    this.operation = task.then(() => undefined, () => undefined)
    return task
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.operation
    const child = this.child
    if (child === undefined) return
    await new Promise<void>((resolvePromise) => {
      const timeout = setTimeout(() => {
        child.kill()
        resolvePromise()
      }, 2_000)
      timeout.unref()
      child.once('close', () => {
        clearTimeout(timeout)
        resolvePromise()
      })
      child.stdin.end()
    })
  }

  private start(): { child: ChildProcessWithoutNullStreams; reader: ReadLineInterface } {
    if (this.child !== undefined && this.reader !== undefined) {
      return { child: this.child, reader: this.reader }
    }
    const child = spawn(this.command, [...this.argumentsValue], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.resume()
    const reader = createInterface({ input: child.stdout, terminal: false })
    this.child = child
    this.reader = reader
    child.once('error', (error) => {
      this.failSession(new Error(`credential backend command failed to start: ${error.message}`, { cause: error }))
    })
    child.once('close', (code) => {
      this.failSession(new Error(`credential backend command exited with code ${String(code)}`))
    })
    return { child, reader }
  }

  private invoke<T>(request: object): Promise<T> {
    const { child, reader } = this.start()
    return new Promise<string>((resolvePromise, rejectPromise) => {
      let settled = false
      const finish = (operation: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.pendingReject = undefined
        reader.off('line', onLine)
        operation()
      }
      const onLine = (line: string): void => {
        finish(() => { resolvePromise(line) })
      }
      const timeout = setTimeout(() => {
        finish(() => {
          child.kill()
          rejectPromise(new Error('credential backend command timed out'))
        })
      }, COMMAND_TIMEOUT_MS)
      timeout.unref()
      this.pendingReject = (error) => { finish(() => { rejectPromise(error) }) }
      reader.once('line', onLine)
      child.stdin.write(`${JSON.stringify(request)}\n`, 'utf8', (error) => {
        if (error !== null && error !== undefined) {
          finish(() => { rejectPromise(new Error('credential backend request could not be written', { cause: error })) })
        }
      })
    }).then((line) => {
      let envelope: { ok?: unknown; result?: unknown }
      try {
        envelope = JSON.parse(line) as { ok?: unknown; result?: unknown }
      } catch (error) {
        child.kill()
        throw new Error('credential backend returned invalid JSON', { cause: error })
      }
      if (envelope.ok !== true) throw new Error('credential backend rejected the request')
      return envelope.result as T
    })
  }

  private failSession(error: Error): void {
    this.child = undefined
    this.reader?.close()
    this.reader = undefined
    const reject = this.pendingReject
    this.pendingReject = undefined
    reject?.(error)
  }
}

function loadElectronSafeStorage(): Promise<MacosSafeStorageRuntime> {
  // Product plugins execute inside DSH's isolated module loader, which does
  // not install a VM dynamic-import callback. Resolve Electron through Node's
  // main-process require bridge so the first credential read cannot remain
  // pending forever during profile activation.
  const require = createRequire(import.meta.url)
  const electron = require('electron') as typeof import('electron')
  return Promise.resolve({
    safeStorage: electron.safeStorage,
    userDataPath: electron.app.getPath('userData'),
    ...(electron.app.isPackaged
      ? { credentialBrokerPath: join(process.resourcesPath, 'product', 'credentials', 'gongchuang-credential-broker') }
      : {}),
  })
}

function emptyStore(): EncryptedStore {
  return { version: 1, entries: {} }
}

function emptyBrokerState(): MacosBrokerState {
  return { version: 2, entries: {} }
}

function parseStore(raw: string, filename: string): EncryptedStore {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`gongchuang-credentials-keychain: encrypted store is invalid at ${filename}`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`gongchuang-credentials-keychain: encrypted store must be an object at ${filename}`)
  }
  const candidate = parsed as { version?: unknown; entries?: unknown }
  if (candidate.version !== 1 || typeof candidate.entries !== 'object' || candidate.entries === null || Array.isArray(candidate.entries)) {
    throw new Error(`gongchuang-credentials-keychain: encrypted store schema is invalid at ${filename}`)
  }
  const entries: Record<string, string> = {}
  for (const [ref, value] of Object.entries(candidate.entries)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) || typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      throw new Error(`gongchuang-credentials-keychain: encrypted store entry is invalid at ${filename}`)
    }
    entries[ref] = value
  }
  return { version: 1, entries }
}

async function readEncryptedStore(filename: string): Promise<EncryptedStore> {
  try {
    const info = await lstat(filename)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`gongchuang-credentials-keychain: encrypted store is not a regular file at ${filename}`)
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error(`gongchuang-credentials-keychain: encrypted store permissions are too broad at ${filename}`)
    }
    if (info.size > MAX_STORE_BYTES) {
      throw new Error(`gongchuang-credentials-keychain: encrypted store exceeds the size limit at ${filename}`)
    }
    return parseStore(await readFile(filename, 'utf8'), filename)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore()
    throw error
  }
}

async function writeEncryptedStore(filename: string, store: EncryptedStore): Promise<void> {
  const directory = dirname(filename)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${ENCRYPTED_STORE_FILENAME}.${randomUUID()}.tmp`)
  // If the atomic replacement fails, leave the encrypted 0600 temporary file
  // for recoverable maintenance instead of permanently deleting it here.
  await writeFile(temporary, `${JSON.stringify(store)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await rename(temporary, filename)
  await chmod(filename, 0o600)
}

async function readBrokerState(filename: string): Promise<MacosBrokerState> {
  try {
    const info = await lstat(filename)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > MAX_STORE_BYTES) {
      throw new Error(`gongchuang-credentials-keychain: broker state is unsafe at ${filename}`)
    }
    const parsed = JSON.parse(await readFile(filename, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`gongchuang-credentials-keychain: broker state is invalid at ${filename}`)
    }
    const candidate = parsed as { version?: unknown; entries?: unknown }
    if (candidate.version !== 2 || typeof candidate.entries !== 'object'
      || candidate.entries === null || Array.isArray(candidate.entries)) {
      throw new Error(`gongchuang-credentials-keychain: broker state schema is invalid at ${filename}`)
    }
    const entries: Record<string, 'present' | 'removed'> = {}
    const candidateEntries = candidate.entries as Record<string, unknown>
    for (const [ref, value] of Object.entries(candidateEntries)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) || (value !== 'present' && value !== 'removed')) {
        throw new Error(`gongchuang-credentials-keychain: broker state entry is invalid at ${filename}`)
      }
      entries[ref] = value
    }
    return { version: 2, entries }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyBrokerState()
    throw error
  }
}

async function writeBrokerState(filename: string, state: MacosBrokerState): Promise<void> {
  const directory = dirname(filename)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${MACOS_BROKER_STATE_FILENAME}.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await rename(temporary, filename)
  await chmod(filename, 0o600)
}

function legacyMacosBackend(runtimeLoader: () => Promise<MacosSafeStorageRuntime>): LegacyMacosBackend {
  let runtimePromise: Promise<MacosSafeStorageRuntime> | undefined
  const runtime = (): Promise<MacosSafeStorageRuntime> => {
    runtimePromise ??= runtimeLoader()
    return runtimePromise
  }
  const encryptionRuntime = async (): Promise<MacosSafeStorageRuntime> => {
    const loaded = await runtime()
    if (!await macosKeychainOperation(() => loaded.safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('gongchuang-credentials-keychain: macOS Keychain encryption is unavailable')
    }
    return loaded
  }
  const filename = async (): Promise<string> => join((await runtime()).userDataPath, ENCRYPTED_STORE_FILENAME)
  const decrypt = async (
    loaded: MacosSafeStorageRuntime,
    encoded: string,
  ): Promise<Awaited<ReturnType<SafeStorageAdapter['decryptStringAsync']>>> => {
    let decrypted: Awaited<ReturnType<SafeStorageAdapter['decryptStringAsync']>>
    try {
      decrypted = await macosKeychainOperation(
        () => loaded.safeStorage.decryptStringAsync(Buffer.from(encoded, 'base64')),
      )
    } catch (error) {
      if (error instanceof Error && error.message.includes('decryptStringAsync is temporarily unavailable')) {
        throw new Error('gongchuang-credentials-keychain: macOS Keychain is temporarily unavailable', { cause: error })
      }
      throw error
    }
    if (decrypted.isTemporarilyUnavailable === true) {
      throw new Error('gongchuang-credentials-keychain: macOS Keychain is temporarily unavailable')
    }
    return decrypted
  }
  return {
    async read(ref) {
      const path = await filename()
      const store = await readEncryptedStore(path)
      const encoded = store.entries[ref]
      if (encoded === undefined) return undefined
      const loaded = await encryptionRuntime()
      const decrypted = await decrypt(loaded, encoded)
      if (decrypted.shouldReEncrypt) {
        store.entries[ref] = (await macosKeychainOperation(
          () => loaded.safeStorage.encryptStringAsync(decrypted.result),
        )).toString('base64')
        await writeEncryptedStore(path, store)
      }
      return decrypted.result
    },
    async readAll() {
      const path = await filename()
      const store = await readEncryptedStore(path)
      const rows = Object.entries(store.entries)
      if (rows.length === 0) return Object.freeze({})
      const loaded = await encryptionRuntime()
      const values: Record<string, string> = {}
      let changed = false
      // 首次升级只允许一条串行迁移链，避免多个提供方同时读取时弹出成串钥匙串授权并拖慢退出。
      for (const [ref, encoded] of rows) {
        const decrypted = await decrypt(loaded, encoded)
        values[ref] = decrypted.result
        if (decrypted.shouldReEncrypt) {
          store.entries[ref] = (await macosKeychainOperation(
            () => loaded.safeStorage.encryptStringAsync(decrypted.result),
          )).toString('base64')
          changed = true
        }
      }
      if (changed) await writeEncryptedStore(path, store)
      return Object.freeze(values)
    },
    async write(ref, value) {
      const loaded = await encryptionRuntime()
      const path = join(loaded.userDataPath, ENCRYPTED_STORE_FILENAME)
      const store = await readEncryptedStore(path)
      store.entries[ref] = (await macosKeychainOperation(
        () => loaded.safeStorage.encryptStringAsync(value),
      )).toString('base64')
      await writeEncryptedStore(path, store)
    },
    async remove(ref) {
      const path = await filename()
      const store = await readEncryptedStore(path)
      if (!(ref in store.entries)) return
      Reflect.deleteProperty(store.entries, ref)
      await writeEncryptedStore(path, store)
    },
    close() { return Promise.resolve() },
  }
}

function macosBackend(
  runtimeLoader: () => Promise<MacosSafeStorageRuntime>,
  injectedSession?: NativeCredentialSession,
): CredentialBackend {
  let runtimePromise: Promise<MacosSafeStorageRuntime> | undefined
  const runtime = (): Promise<MacosSafeStorageRuntime> => {
    runtimePromise ??= runtimeLoader()
    return runtimePromise
  }
  const legacy = legacyMacosBackend(runtime)
  let sessionPromise: Promise<NativeCredentialSession | undefined> | undefined
  const session = (): Promise<NativeCredentialSession | undefined> => {
    sessionPromise ??= injectedSession !== undefined
      ? Promise.resolve(injectedSession)
      : runtime().then(loaded => loaded.credentialBrokerPath === undefined
        ? undefined
        : new NdjsonCredentialSession(loaded.credentialBrokerPath, []))
    return sessionPromise
  }
  const statePath = async (): Promise<string> => join((await runtime()).userDataPath, MACOS_BROKER_STATE_FILENAME)
  const hasUnaccountedLegacyEntries = async (state: MacosBrokerState): Promise<boolean> => {
    const loaded = await runtime()
    const store = await readEncryptedStore(join(loaded.userDataPath, ENCRYPTED_STORE_FILENAME))
    return Object.keys(store.entries).some(ref => state.entries[ref] === undefined)
  }
  const brokerRequest = async <T>(request: object): Promise<T> => {
    const active = await session()
    if (active === undefined) throw new Error('gongchuang-credentials-keychain: macOS Keychain broker is unavailable')
    try {
      return await active.request<T>(request)
    } catch (error) {
      throw new Error('gongchuang-credentials-keychain: macOS Keychain broker rejected the request', { cause: error })
    }
  }
  let stateOperation: Promise<void> = Promise.resolve()
  const updateState = (ref: string, value: 'present' | 'removed'): Promise<void> => {
    const task = stateOperation.then(async () => {
      const filename = await statePath()
      const state = await readBrokerState(filename)
      state.entries[ref] = value
      await writeBrokerState(filename, state)
    })
    stateOperation = task.catch(() => undefined)
    return task
  }
  let migrationPromise: Promise<ReadonlySet<string>> | undefined
  const migrateLegacyEntries = (): Promise<ReadonlySet<string>> => {
    migrationPromise ??= (async () => {
      const entries = await legacy.readAll()
      const migrated = new Set<string>()
      for (const [ref, value] of Object.entries(entries)) {
        const current = await brokerRequest<{ found: boolean }>({ op: 'read', ref })
        if (!current.found) await brokerRequest({ op: 'write', ref, value })
        await updateState(ref, 'present')
        migrated.add(ref)
      }
      return migrated
    })().catch((error: unknown) => {
      // A denied or timed-out first-upgrade authorization may be retried explicitly from the UI.
      migrationPromise = undefined
      throw error
    })
    return migrationPromise
  }
  return {
    async read(ref) {
      if (await session() === undefined) return legacy.read(ref)
      const state = await readBrokerState(await statePath())
      if (state.entries[ref] === 'removed') return undefined
      const result = await brokerRequest<{ found: boolean; value?: string }>({ op: 'read', ref })
      if (result.found) {
        if (typeof result.value !== 'string') {
          throw new Error('gongchuang-credentials-keychain: macOS Keychain broker returned an invalid credential')
        }
        if (state.entries[ref] === undefined) await updateState(ref, 'present')
        return result.value
      }

      if (state.entries[ref] === 'present') {
        // 已迁移记录在钥匙串中消失属于存储故障，绝不能退回旧密文并复活过期密钥。
        throw new Error('gongchuang-credentials-keychain: migrated macOS Keychain credential is missing')
      }
      // 已知旧条目都已迁移或删除时，未知引用就是“未配置”。不要再次解密完整
      // safeStorage 快照；否则每次启动读取浏览器会话这类新引用，都会让新版
      // ad-hoc App 重新触发旧签名的钥匙串授权并拖住账号与全部模型初始化。
      if (!await hasUnaccountedLegacyEntries(state)) return undefined
      await migrateLegacyEntries()
      const migrated = await brokerRequest<{ found: boolean; value?: string }>({ op: 'read', ref })
      if (!migrated.found) return undefined
      if (typeof migrated.value !== 'string') {
        throw new Error('gongchuang-credentials-keychain: macOS Keychain broker returned an invalid credential')
      }
      return migrated.value
    },
    async write(ref, value) {
      if (await session() === undefined) return legacy.write(ref, value)
      await brokerRequest({ op: 'write', ref, value })
      await updateState(ref, 'present')
    },
    async remove(ref) {
      if (await session() === undefined) return legacy.remove(ref)
      // 先提交逻辑删除；即使后续钥匙串清理失败，旧密文也不能在下一次读取时复活。
      await updateState(ref, 'removed')
      await brokerRequest({ op: 'delete', ref })
      // 显式删除同步清理旧条目；这样回滚到迁移前版本也不会重新读出已删除凭据。
      await legacy.remove(ref)
    },
    async close() {
      await legacy.close()
      await (await session())?.close()
    },
  }
}

function windowsCredentialSession(): NativeCredentialSession {
  const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')
  return new NdjsonCredentialSession('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ])
}

function windowsBackend(session: NativeCredentialSession): CredentialBackend {
  return {
    async read(ref) {
      const result = await session.request<{ found: boolean; value?: string }>({ op: 'read', ref })
      return result.found ? result.value : undefined
    },
    async write(ref, value) {
      await session.request({ op: 'write', ref, value })
    },
    async remove(ref) {
      await session.request({ op: 'delete', ref })
    },
    close: () => session.close(),
  }
}

/**
 * Select the native credential backend for a supported desktop platform.
 * Packaged macOS builds use a frozen native Keychain broker and migrate legacy
 * Electron safeStorage ciphertext only after the original Keychain grants access;
 * Windows keeps the credential itself in Credential Manager.
 * @param platform - The platform value.
 * @param dependencies - The dependencies value.
 * @returns The create platform backend result.
 */
export function createPlatformBackend(
  platform: NodeJS.Platform = process.platform,
  dependencies: {
    windowsSession?: NativeCredentialSession
    macosRuntime?: () => Promise<MacosSafeStorageRuntime>
    macosSession?: NativeCredentialSession
  } = {},
): CredentialBackend {
  if (platform === 'darwin') {
    return macosBackend(dependencies.macosRuntime ?? loadElectronSafeStorage, dependencies.macosSession)
  }
  if (platform === 'win32') return windowsBackend(dependencies.windowsSession ?? windowsCredentialSession())
  throw new Error(`gongchuang-credentials-keychain: unsupported platform ${platform}`)
}
