/**
 * 洞见 credential provider.
 *
 * The inherited launch environment stays the explicit read-only top layer.
 * User-managed secrets are protected by macOS Keychain-backed encryption or
 * stored in Windows Credential Manager; project and user dotenv files are
 * intentionally ignored so an opened enterprise directory cannot inject model
 * or MCP credentials.
 * @module @gongchuang/credentials-keychain
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo,
  CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { createPlatformBackend, type CredentialBackend } from './backend.ts'

/** No user-configurable storage path or helper command exists by design. */
export type Config = Record<never, never>

const MACOS_KEYCHAIN_TEMPORARILY_UNAVAILABLE = 'gongchuang-credentials-keychain: macOS Keychain is temporarily unavailable'
const BROWSER_SESSION_RECORD_KEY = 'client-connection/browser-session'
const BROWSER_SESSION_BACKEND_REF = 'GONGCHUANG_INTERNAL_BROWSER_SESSION'
const RECORDS_DISABLED = 'gongchuang-credentials-keychain: only the internal browser-session record is enabled in this product'

function isTemporarilyUnavailable(error: unknown): error is Error {
  return error instanceof Error && error.message === MACOS_KEYCHAIN_TEMPORARILY_UNAVAILABLE
}

function isBrowserSessionRecord(key: CredentialKey): boolean {
  return key === BROWSER_SESSION_RECORD_KEY
}

function parseBrowserSessionRecord(value: string): CredentialRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error('gongchuang-credentials-keychain: browser-session record is invalid JSON', { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || !Object.hasOwn(parsed, 'payload') || (parsed as { kind?: unknown }).kind !== 'grant') {
    throw new Error('gongchuang-credentials-keychain: browser-session record has an unsupported format')
  }
  return parsed as CredentialRecord
}

function serializeBrowserSessionRecord(record: CredentialRecord): string {
  if (record.kind !== 'grant') {
    throw new Error('gongchuang-credentials-keychain: browser-session record must be a grant')
  }
  let serialized: string
  try {
    serialized = JSON.stringify(record)
  } catch (error) {
    throw new Error('gongchuang-credentials-keychain: browser-session record is not JSON serializable', { cause: error })
  }
  parseBrowserSessionRecord(serialized)
  return serialized
}

async function readBrowserSessionRecord(backend: CredentialBackend): Promise<CredentialRecord | undefined> {
  const serialized = await backend.read(BROWSER_SESSION_BACKEND_REF).catch((error: unknown) => {
    // An ad-hoc update may lose access to the previous app identity's
    // recoverable loopback-cookie key. Treat only that key as absent so
    // BrowserAuth rotates it; user-entered credentials remain untouched.
    if (isTemporarilyUnavailable(error)) return undefined
    throw error
  })
  return serialized === undefined ? undefined : parseBrowserSessionRecord(serialized)
}

/** Native OS credential provider used only by the signed product composition. */
export class GongchuangKeychainCredentialProvider extends CredentialProvider {
  static Config: z<Config> = z.object({})

  private readonly backend: CredentialBackend
  private operations: Promise<void> = Promise.resolve()
  private temporaryReadFailure: Error | undefined
  private closed = false

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.backend = createPlatformBackend()
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    await this.operations
    yield async () => {
      this.closed = true
      await this.operations
      await this.backend.close()
    }
  }

  private inherited(ref: CredentialRef): string | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])
    return entry !== undefined && entry.value.length > 0 ? entry.value : undefined
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('gongchuang-credentials-keychain is disposed'))
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  private readStored(ref: string): Promise<string | undefined> {
    if (this.temporaryReadFailure !== undefined) return Promise.reject(this.temporaryReadFailure)
    return this.backend.read(ref).catch((error: unknown) => {
      if (isTemporarilyUnavailable(error)) {
        // 同一轮启动会并发检查多个凭据；一次系统拒绝即可代表本批次，避免每个引用再等待一次授权超时。
        this.temporaryReadFailure = error
        setTimeout(() => {
          if (this.temporaryReadFailure === error) this.temporaryReadFailure = undefined
        }, 0).unref()
      }
      throw error
    })
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const inherited = this.inherited(ref)
    if (inherited !== undefined) return Promise.resolve({ value: inherited, source: 'env' })
    return this.enqueue(async () => {
      // 读取失败不等于未保存；消费者须显示可重试错误，不能要求重填或清空原凭据。
      const value = await this.readStored(ref)
      return value === undefined || value.length === 0 ? undefined : { value, source: 'os-keychain' }
    })
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (this.inherited(ref) !== undefined) return { configured: true, source: 'env', writable: false }
    const stored = await this.enqueue(() => this.readStored(ref))
    return stored === undefined || stored.length === 0
      ? { configured: false, writable: true }
      : { configured: true, source: 'os-keychain', writable: true }
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) throw new Error(`gongchuang-credentials-keychain: an empty value cannot be stored for "${ref}"; use unset`)
    if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
      throw new Error(`gongchuang-credentials-keychain: "${ref}" contains unsupported control characters`)
    }
    this.assertUnshadowed(ref, 'set')
    await this.enqueue(async () => {
      this.assertUnshadowed(ref, 'set')
      await this.backend.write(ref, value)
      this.notifyUpdated(ref)
    })
  }

  override async unset(ref: CredentialRef): Promise<void> {
    this.assertUnshadowed(ref, 'unset')
    await this.enqueue(async () => {
      this.assertUnshadowed(ref, 'unset')
      await this.backend.remove(ref)
      this.notifyUpdated(ref)
    })
  }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    if (!isBrowserSessionRecord(key)) return Promise.resolve(undefined)
    return this.enqueue(async () => readBrowserSessionRecord(this.backend))
  }

  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    if (!isBrowserSessionRecord(key)) return { configured: false, writable: false }
    const record = await this.readRecord(key)
    return record === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: record.kind, writable: true }
  }

  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    const key = BROWSER_SESSION_RECORD_KEY as CredentialKey
    const record = await this.readRecord(key)
    return record === undefined ? [] : [{ key, kind: record.kind }]
  }

  override modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    if (!isBrowserSessionRecord(key)) return Promise.reject(new Error(RECORDS_DISABLED))
    return this.enqueue(async () => {
      const current = await readBrowserSessionRecord(this.backend)
      const replacement = await mutate(current)
      if (replacement === undefined) return current
      const canonical = parseBrowserSessionRecord(serializeBrowserSessionRecord(replacement))
      await this.backend.write(BROWSER_SESSION_BACKEND_REF, JSON.stringify(canonical))
      this.notifyRecordUpdated(key)
      return canonical
    })
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    if (!isBrowserSessionRecord(key)) return Promise.reject(new Error(RECORDS_DISABLED))
    return this.enqueue(async () => {
      const current = await this.backend.read(BROWSER_SESSION_BACKEND_REF)
      if (current === undefined) return
      await this.backend.remove(BROWSER_SESSION_BACKEND_REF)
      this.notifyRecordUpdated(key)
    })
  }

  private assertUnshadowed(ref: CredentialRef, verb: 'set' | 'unset'): void {
    if (this.inherited(ref) !== undefined) {
      throw new Error(
        `gongchuang-credentials-keychain: "${ref}" is supplied read-only by the launching environment, so ${verb} would be shadowed`,
      )
    }
  }
}

export default GongchuangKeychainCredentialProvider
