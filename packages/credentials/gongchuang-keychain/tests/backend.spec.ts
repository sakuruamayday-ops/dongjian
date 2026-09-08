import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlatformBackend, MACOS_KEYCHAIN_OPERATION_TIMEOUT_MS } from '../src/backend.ts'
import type { MacosSafeStorageRuntime, NativeCredentialSession, SafeStorageAdapter } from '../src/backend.ts'

function reversibleSafeStorage(): SafeStorageAdapter {
  return {
    async isAsyncEncryptionAvailable() { return true },
    async encryptStringAsync(value) { return Buffer.from(`sealed:${value}`, 'utf8') },
    async decryptStringAsync(value) {
      const encoded = value.toString('utf8')
      if (!encoded.startsWith('sealed:')) throw new Error('not sealed')
      return { result: encoded.slice('sealed:'.length), shouldReEncrypt: false }
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('native credential backends', () => {
  it('stores only safeStorage ciphertext on macOS and survives backend recreation', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'gongchuang-safe-storage-'))
    const runtime = async (): Promise<MacosSafeStorageRuntime> => ({
      safeStorage: reversibleSafeStorage(),
      userDataPath,
    })
    const backend = createPlatformBackend('darwin', { macosRuntime: runtime })

    await expect(backend.read('DEEPSEEK_API_KEY')).resolves.toBeUndefined()
    await backend.write('DEEPSEEK_API_KEY', 'secret-value')
    await expect(backend.read('DEEPSEEK_API_KEY')).resolves.toBe('secret-value')

    const raw = await readFile(join(userDataPath, 'credentials.secure.v1.json'), 'utf8')
    expect(raw).not.toContain('secret-value')
    expect(raw).toContain(Buffer.from('sealed:secret-value').toString('base64'))

    const restarted = createPlatformBackend('darwin', { macosRuntime: runtime })
    await expect(restarted.read('DEEPSEEK_API_KEY')).resolves.toBe('secret-value')
    await restarted.remove('DEEPSEEK_API_KEY')
    await expect(restarted.read('DEEPSEEK_API_KEY')).resolves.toBeUndefined()
  })

  it('does not enter Keychain when the macOS encrypted store or requested entry is absent', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'gongchuang-safe-storage-empty-'))
    const isAsyncEncryptionAvailable = vi.fn(async () => true)
    const runtime = async (): Promise<MacosSafeStorageRuntime> => ({
      safeStorage: { ...reversibleSafeStorage(), isAsyncEncryptionAvailable },
      userDataPath,
    })
    const backend = createPlatformBackend('darwin', { macosRuntime: runtime })

    await expect(backend.read('DEEPSEEK_API_KEY')).resolves.toBeUndefined()
    await writeFile(
      join(userDataPath, 'credentials.secure.v1.json'),
      `${JSON.stringify({ version: 1, entries: { OPENCODE_API_KEY: 'c2VhbGVkOnZhbHVl' } })}\n`,
      { mode: 0o600 },
    )
    await expect(backend.read('DEEPSEEK_API_KEY')).resolves.toBeUndefined()
    await backend.remove('DEEPSEEK_API_KEY')
    expect(isAsyncEncryptionAvailable).not.toHaveBeenCalled()
  })

  it('fails closed when a macOS credential needs unavailable Keychain encryption', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'gongchuang-safe-storage-offline-'))
    const backend = createPlatformBackend('darwin', {
      macosRuntime: async () => ({
        safeStorage: {
          ...reversibleSafeStorage(),
          async isAsyncEncryptionAvailable() { return false },
        },
        userDataPath,
      }),
    })
    await expect(backend.read('DEEPSEEK_API_KEY')).resolves.toBeUndefined()
    await writeFile(
      join(userDataPath, 'credentials.secure.v1.json'),
      `${JSON.stringify({ version: 1, entries: { DEEPSEEK_API_KEY: 'c2VhbGVkOnNlY3JldA==' } })}\n`,
      { mode: 0o600 },
    )
    await expect(backend.read('DEEPSEEK_API_KEY')).rejects.toThrow(/Keychain encryption is unavailable/)
    await expect(backend.write('DEEPSEEK_API_KEY', 'secret')).rejects.toThrow(/Keychain encryption is unavailable/)
  })

  it('reports a temporarily denied macOS Keychain read without losing ciphertext', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'gongchuang-safe-storage-denied-'))
    const backend = createPlatformBackend('darwin', {
      macosRuntime: async () => ({
        safeStorage: {
          ...reversibleSafeStorage(),
          async decryptStringAsync() {
            return { result: '', shouldReEncrypt: false, isTemporarilyUnavailable: true }
          },
        },
        userDataPath,
      }),
    })
    const ciphertext = Buffer.from('sealed:secret').toString('base64')
    await writeFile(
      join(userDataPath, 'credentials.secure.v1.json'),
      `${JSON.stringify({ version: 1, entries: { DEEPSEEK_API_KEY: ciphertext } })}\n`,
      { mode: 0o600 },
    )
    await expect(backend.read('DEEPSEEK_API_KEY')).rejects.toThrow(/temporarily unavailable/)
    await expect(readFile(join(userDataPath, 'credentials.secure.v1.json'), 'utf8'))
      .resolves.toContain(ciphertext)
  })

  it('normalizes Electron safeStorage rejection after the user denies Keychain access', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'gongchuang-safe-storage-rejected-'))
    const backend = createPlatformBackend('darwin', {
      macosRuntime: async () => ({
        safeStorage: {
          ...reversibleSafeStorage(),
          async decryptStringAsync() {
            throw new Error('safeStorage.decryptStringAsync is temporarily unavailable. Please try again.')
          },
        },
        userDataPath,
      }),
    })
    await writeFile(
      join(userDataPath, 'credentials.secure.v1.json'),
      `${JSON.stringify({ version: 1, entries: { DEEPSEEK_API_KEY: 'c2VhbGVkOnNlY3JldA==' } })}\n`,
      { mode: 0o600 },
    )
    await expect(backend.read('DEEPSEEK_API_KEY')).rejects.toThrow(/macOS Keychain is temporarily unavailable/)
  })

  it('bounds an unresolved macOS Keychain read and preserves its ciphertext', async () => {
    vi.useFakeTimers()
    const userDataPath = await mkdtemp(join(tmpdir(), 'gongchuang-safe-storage-read-timeout-'))
    const decryptStringAsync = vi.fn(() => new Promise<never>(() => {}))
    const backend = createPlatformBackend('darwin', {
      macosRuntime: async () => ({
        safeStorage: {
          ...reversibleSafeStorage(),
          decryptStringAsync,
        },
        userDataPath,
      }),
    })
    const ciphertext = Buffer.from('sealed:secret').toString('base64')
    const storePath = join(userDataPath, 'credentials.secure.v1.json')
    await writeFile(
      storePath,
      `${JSON.stringify({ version: 1, entries: { OPENCODE_GO_API_KEY: ciphertext } })}\n`,
      { mode: 0o600 },
    )
    const pending = backend.read('OPENCODE_GO_API_KEY')
    const rejected = expect(pending).rejects.toThrow(/macOS Keychain is temporarily unavailable/)

    await vi.waitFor(() => { expect(decryptStringAsync).toHaveBeenCalledOnce() })
    await vi.advanceTimersByTimeAsync(MACOS_KEYCHAIN_OPERATION_TIMEOUT_MS)
    await rejected
    await expect(readFile(storePath, 'utf8')).resolves.toContain(ciphertext)
  })

  it('bounds an unresolved macOS Keychain write without persisting plaintext', async () => {
    vi.useFakeTimers()
    const userDataPath = await mkdtemp(join(tmpdir(), 'gongchuang-safe-storage-write-timeout-'))
    const encryptStringAsync = vi.fn(() => new Promise<never>(() => {}))
    const backend = createPlatformBackend('darwin', {
      macosRuntime: async () => ({
        safeStorage: {
          ...reversibleSafeStorage(),
          encryptStringAsync,
        },
        userDataPath,
      }),
    })
    const pending = backend.write('OPENCODE_GO_API_KEY', 'must-not-be-written')
    const rejected = expect(pending).rejects.toThrow(/macOS Keychain is temporarily unavailable/)

    await vi.waitFor(() => { expect(encryptStringAsync).toHaveBeenCalledOnce() })
    await vi.advanceTimersByTimeAsync(MACOS_KEYCHAIN_OPERATION_TIMEOUT_MS)
    await rejected
    await expect(readFile(join(userDataPath, 'credentials.secure.v1.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('migrates legacy macOS ciphertext once into the stable native broker', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'gongchuang-keychain-broker-migration-'))
    const safeStorage = reversibleSafeStorage()
    const decrypt = vi.spyOn(safeStorage, 'decryptStringAsync')
    const values = new Map<string, string>()
    const requests: object[] = []
    const macosSession: NativeCredentialSession = {
      async request<T>(request: object): Promise<T> {
        requests.push(request)
        const row = request as { op: string; ref: string; value?: string }
        if (row.op === 'read') return { found: values.has(row.ref), value: values.get(row.ref) } as T
        if (row.op === 'write') values.set(row.ref, row.value ?? '')
        if (row.op === 'delete') values.delete(row.ref)
        return { ok: true } as T
      },
      close: vi.fn(async () => undefined),
    }
    const legacyStore = join(userDataPath, 'credentials.secure.v1.json')
    const ciphertext = Buffer.from('sealed:legacy-secret').toString('base64')
    await writeFile(legacyStore, `${JSON.stringify({
      version: 1,
      entries: { OPENCODE_GO_API_KEY: ciphertext },
    })}\n`, { mode: 0o600 })
    const backend = createPlatformBackend('darwin', {
      macosRuntime: async () => ({ safeStorage, userDataPath }),
      macosSession,
    })

    await expect(backend.read('OPENCODE_GO_API_KEY')).resolves.toBe('legacy-secret')
    await expect(backend.read('OPENCODE_GO_API_KEY')).resolves.toBe('legacy-secret')
    expect(decrypt).toHaveBeenCalledOnce()
    expect(requests).toContainEqual({ op: 'write', ref: 'OPENCODE_GO_API_KEY', value: 'legacy-secret' })
    await expect(readFile(legacyStore, 'utf8')).resolves.toContain(ciphertext)
    const statePath = join(userDataPath, 'credentials.keychain.v2.json')
    await expect(readFile(statePath, 'utf8')).resolves.toContain('"OPENCODE_GO_API_KEY":"present"')
    expect((await stat(statePath)).mode & 0o077).toBe(0)
  })

  it('serializes concurrent first-upgrade reads and migrates the complete legacy snapshot', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'gongchuang-keychain-broker-bulk-migration-'))
    let activeDecryptions = 0
    let maximumActiveDecryptions = 0
    const safeStorage: SafeStorageAdapter = {
      ...reversibleSafeStorage(),
      async decryptStringAsync(value) {
        activeDecryptions += 1
        maximumActiveDecryptions = Math.max(maximumActiveDecryptions, activeDecryptions)
        await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
        activeDecryptions -= 1
        const encoded = value.toString('utf8')
        return { result: encoded.slice('sealed:'.length), shouldReEncrypt: false }
      },
    }
    const decrypt = vi.spyOn(safeStorage, 'decryptStringAsync')
    const values = new Map<string, string>()
    const requests: object[] = []
    const macosSession: NativeCredentialSession = {
      async request<T>(request: object): Promise<T> {
        requests.push(request)
        const row = request as { op: string; ref: string; value?: string }
        if (row.op === 'read') return { found: values.has(row.ref), value: values.get(row.ref) } as T
        if (row.op === 'write') values.set(row.ref, row.value ?? '')
        return { ok: true } as T
      },
      close: vi.fn(async () => undefined),
    }
    const entries = {
      DEEPSEEK_API_KEY: Buffer.from('sealed:deepseek').toString('base64'),
      OPENCODE_GO_API_KEY: Buffer.from('sealed:opencode-go').toString('base64'),
      TYC_API_TOKEN: Buffer.from('sealed:tyc').toString('base64'),
    }
    await writeFile(join(userDataPath, 'credentials.secure.v1.json'), `${JSON.stringify({
      version: 1,
      entries,
    })}\n`, { mode: 0o600 })
    const backend = createPlatformBackend('darwin', {
      macosRuntime: async () => ({ safeStorage, userDataPath }),
      macosSession,
    })

    await expect(Promise.all([
      backend.read('OPENCODE_GO_API_KEY'),
      backend.read('DEEPSEEK_API_KEY'),
      backend.read('TYC_API_TOKEN'),
    ])).resolves.toEqual(['opencode-go', 'deepseek', 'tyc'])
    expect(decrypt).toHaveBeenCalledTimes(3)
    expect(maximumActiveDecryptions).toBe(1)
    expect(requests.filter(request => (request as { op?: string }).op === 'write')).toHaveLength(3)
    const state = await readFile(join(userDataPath, 'credentials.keychain.v2.json'), 'utf8')
    expect(state).toContain('"DEEPSEEK_API_KEY":"present"')
    expect(state).toContain('"OPENCODE_GO_API_KEY":"present"')
    expect(state).toContain('"TYC_API_TOKEN":"present"')
  })

  it('never resurrects a migrated or explicitly removed macOS credential from legacy ciphertext', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'gongchuang-keychain-broker-removal-'))
    const safeStorage = reversibleSafeStorage()
    const decrypt = vi.spyOn(safeStorage, 'decryptStringAsync')
    const macosSession: NativeCredentialSession = {
      async request<T>(request: object): Promise<T> {
        const row = request as { op: string }
        return (row.op === 'read' ? { found: false } : { ok: true }) as T
      },
      close: vi.fn(async () => undefined),
    }
    const legacyStore = join(userDataPath, 'credentials.secure.v1.json')
    await writeFile(legacyStore, `${JSON.stringify({
      version: 1,
      entries: { DEEPSEEK_API_KEY: Buffer.from('sealed:stale-secret').toString('base64') },
    })}\n`, { mode: 0o600 })
    await writeFile(join(userDataPath, 'credentials.keychain.v2.json'), `${JSON.stringify({
      version: 2,
      entries: { DEEPSEEK_API_KEY: 'present' },
    })}\n`, { mode: 0o600 })
    const backend = createPlatformBackend('darwin', {
      macosRuntime: async () => ({ safeStorage, userDataPath }),
      macosSession,
    })

    await expect(backend.read('DEEPSEEK_API_KEY')).rejects.toThrow(/migrated macOS Keychain credential is missing/)
    expect(decrypt).not.toHaveBeenCalled()

    await backend.remove('DEEPSEEK_API_KEY')
    await expect(backend.read('DEEPSEEK_API_KEY')).resolves.toBeUndefined()
    await expect(readFile(legacyStore, 'utf8')).resolves.not.toContain('DEEPSEEK_API_KEY')
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('does not reopen legacy safeStorage for an absent post-migration reference', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'gongchuang-keychain-broker-absent-after-migration-'))
    const safeStorage = reversibleSafeStorage()
    const decrypt = vi.spyOn(safeStorage, 'decryptStringAsync')
    const requests: object[] = []
    const macosSession: NativeCredentialSession = {
      async request<T>(request: object): Promise<T> {
        requests.push(request)
        const row = request as { op: string; ref: string }
        return (row.op === 'read' && row.ref === 'OPENCODE_GO_API_KEY'
          ? { found: true, value: 'broker-secret' }
          : { found: false }) as T
      },
      close: vi.fn(async () => undefined),
    }
    await writeFile(join(userDataPath, 'credentials.secure.v1.json'), `${JSON.stringify({
      version: 1,
      entries: { OPENCODE_GO_API_KEY: Buffer.from('sealed:legacy-secret').toString('base64') },
    })}\n`, { mode: 0o600 })
    await writeFile(join(userDataPath, 'credentials.keychain.v2.json'), `${JSON.stringify({
      version: 2,
      entries: { OPENCODE_GO_API_KEY: 'present' },
    })}\n`, { mode: 0o600 })
    const backend = createPlatformBackend('darwin', {
      macosRuntime: async () => ({ safeStorage, userDataPath }),
      macosSession,
    })

    await expect(backend.read('GONGCHUANG_INTERNAL_BROWSER_SESSION')).resolves.toBeUndefined()
    expect(decrypt).not.toHaveBeenCalled()
    expect(requests).toEqual([
      { op: 'read', ref: 'GONGCHUANG_INTERNAL_BROWSER_SESSION' },
    ])
  })

  it('writes new packaged macOS credentials only through the native broker', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'gongchuang-keychain-broker-write-'))
    const safeStorage = reversibleSafeStorage()
    const encrypt = vi.spyOn(safeStorage, 'encryptStringAsync')
    const values = new Map<string, string>()
    const macosSession: NativeCredentialSession = {
      async request<T>(request: object): Promise<T> {
        const row = request as { op: string; ref: string; value?: string }
        if (row.op === 'read') return { found: values.has(row.ref), value: values.get(row.ref) } as T
        if (row.op === 'write') values.set(row.ref, row.value ?? '')
        return { ok: true } as T
      },
      close: vi.fn(async () => undefined),
    }
    const backend = createPlatformBackend('darwin', {
      macosRuntime: async () => ({ safeStorage, userDataPath }),
      macosSession,
    })

    await backend.write('DEEPSEEK_API_KEY', 'new-secret')
    await expect(backend.read('DEEPSEEK_API_KEY')).resolves.toBe('new-secret')
    expect(encrypt).not.toHaveBeenCalled()
    await expect(readFile(join(userDataPath, 'credentials.secure.v1.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes broker state updates from concurrent credential writes', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'gongchuang-keychain-broker-state-writes-'))
    const values = new Map<string, string>()
    const macosSession: NativeCredentialSession = {
      async request<T>(request: object): Promise<T> {
        const row = request as { op: string; ref: string; value?: string }
        if (row.op === 'write') values.set(row.ref, row.value ?? '')
        return { ok: true } as T
      },
      close: vi.fn(async () => undefined),
    }
    const backend = createPlatformBackend('darwin', {
      macosRuntime: async () => ({ safeStorage: reversibleSafeStorage(), userDataPath }),
      macosSession,
    })

    await Promise.all([
      backend.write('DEEPSEEK_API_KEY', 'deepseek'),
      backend.write('OPENCODE_GO_API_KEY', 'opencode-go'),
      backend.write('TYC_API_TOKEN', 'tyc'),
    ])
    const state = await readFile(join(userDataPath, 'credentials.keychain.v2.json'), 'utf8')
    expect(state).toContain('"DEEPSEEK_API_KEY":"present"')
    expect(state).toContain('"OPENCODE_GO_API_KEY":"present"')
    expect(state).toContain('"TYC_API_TOKEN":"present"')
  })

  it('keeps a logical deletion when the broker cleanup fails', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'gongchuang-keychain-broker-delete-failure-'))
    const safeStorage = reversibleSafeStorage()
    const decrypt = vi.spyOn(safeStorage, 'decryptStringAsync')
    const legacyStore = join(userDataPath, 'credentials.secure.v1.json')
    await writeFile(legacyStore, `${JSON.stringify({
      version: 1,
      entries: { DEEPSEEK_API_KEY: Buffer.from('sealed:stale-secret').toString('base64') },
    })}\n`, { mode: 0o600 })
    const macosSession: NativeCredentialSession = {
      async request<T>(request: object): Promise<T> {
        const row = request as { op: string }
        if (row.op === 'delete') throw new Error('synthetic broker cleanup failure')
        return { found: true, value: 'broker-secret' } as T
      },
      close: vi.fn(async () => undefined),
    }
    const backend = createPlatformBackend('darwin', {
      macosRuntime: async () => ({ safeStorage, userDataPath }),
      macosSession,
    })

    await expect(backend.remove('DEEPSEEK_API_KEY')).rejects.toThrow('broker rejected the request')
    await expect(backend.read('DEEPSEEK_API_KEY')).resolves.toBeUndefined()
    await expect(readFile(legacyStore, 'utf8')).resolves.toContain('DEEPSEEK_API_KEY')
    await expect(readFile(join(userDataPath, 'credentials.keychain.v2.json'), 'utf8'))
      .resolves.toContain('"DEEPSEEK_API_KEY":"removed"')
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('uses Windows Credential Manager and sends secret values through stdin', async () => {
    const requests: object[] = []
    const close = vi.fn(async () => undefined)
    const windowsSession: NativeCredentialSession = {
      async request<T>(request: object): Promise<T> {
        requests.push(request)
        const result = requests.length === 1
          ? { found: true, value: 'win-secret' }
          : { ok: true }
        return result as T
      },
      close,
    }
    const backend = createPlatformBackend('win32', { windowsSession })

    await expect(backend.read('OPENCODE_API_KEY')).resolves.toBe('win-secret')
    await backend.write('OPENCODE_API_KEY', 'next-secret')
    await backend.remove('OPENCODE_API_KEY')
    await backend.close()

    expect(requests[1]).toEqual({ op: 'write', ref: 'OPENCODE_API_KEY', value: 'next-secret' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('returns undefined for an absent Windows credential and rejects unsupported platforms', async () => {
    const windowsSession: NativeCredentialSession = {
      async request<T>(): Promise<T> { return { found: false } as T },
      close: vi.fn(async () => undefined),
    }
    const backend = createPlatformBackend('win32', {
      windowsSession,
    })
    await expect(backend.read('TYC_API_TOKEN')).resolves.toBeUndefined()
    expect(() => createPlatformBackend('linux')).toThrow(/unsupported platform linux/)
  })
})
