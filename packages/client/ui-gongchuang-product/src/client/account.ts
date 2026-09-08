import type {
  ClientRemote,
  GongchuangAccountLoginRequest,
  GongchuangAccountSnapshot,
  GongchuangPersonalizationSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { gongchuangUserError } from '@gongchuang/user-errors'

/** Client-safe loading state for the Host-owned account snapshot. */
export interface AccountState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot: GongchuangAccountSnapshot
  error: string | null
}

const EMPTY_ACCOUNT: GongchuangAccountSnapshot = Object.freeze({
  revision: 0,
  phase: 'local',
  portalUrl: '',
  username: null,
  message: '',
  hasSavedPassword: false,
  autoLoginBlocked: false,
  singleDevice: false,
  clientCompatibility: null,
  minimumSupportedVersion: null,
})

type AccountRemote = ClientRemote['gongchuangAccount']

/** Renderer projection for Host-owned password login and OS-keychain state. */
export class AccountController {
  /** Observable account state consumed by the product shell. */
  readonly store: SnapshotStore<AccountState> = createSnapshotStore({
    status: 'idle', snapshot: EMPTY_ACCOUNT, error: null,
  })

  private generation = 0

  constructor(
    private readonly remote: AccountRemote,
    private readonly onConnected: () => void,
  ) {}

  /**
   * Load the latest account snapshot, including startup auto-login results.
   * @returns once the client store reflects the latest Host result.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    try {
      const result = await this.remote.refresh()
      if (!result.ok) throw new Error(result.error.message)
      if (generation !== this.generation) return
      this.publish(result.value)
      if (result.value.phase === 'connected') this.onConnected()
    } catch (error) {
      if (generation !== this.generation) return
      this.fail(error)
    }
  }

  /**
   * Submit one explicit username/password login through the private Remote.
   * @param request - the client-safe login request.
   * @returns once the Host accepts or rejects the login.
   */
  async login(request: GongchuangAccountLoginRequest): Promise<void> {
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    try {
      const result = await this.remote.login(request)
      if (!result.ok) throw new Error(result.error.message)
      this.publish(result.value)
      if (result.value.phase === 'connected') this.onConnected()
    } catch (error) {
      throw this.fail(error)
    }
  }

  /**
   * Revalidate the current device-bound token with the Host.
   * @returns once the refreshed snapshot is published.
   */
  async refresh(): Promise<void> {
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    try {
      const result = await this.remote.refresh()
      if (!result.ok) throw new Error(result.error.message)
      this.publish(result.value)
      if (result.value.phase === 'connected') this.onConnected()
    } catch (error) {
      this.fail(error)
    }
  }

  /** Quietly revalidate a connected desktop session so another-device login is reflected promptly. */
  async poll(): Promise<void> {
    const before = this.store.getSnapshot()
    if (before.status === 'loading' || (before.snapshot.phase !== 'connected' && before.snapshot.phase !== 'offline')) return
    const generation = ++this.generation
    const result = await this.remote.refresh().catch(() => undefined)
    if (result === undefined) return
    if (generation !== this.generation || !result.ok) return
    const wasConnected = before.snapshot.phase === 'connected'
    this.publish(result.value)
    if (!wasConnected && result.value.phase === 'connected') this.onConnected()
  }

  /**
   * Sign out this device and clear its saved login material.
   * @returns once Host credential cleanup and snapshot publication finish.
   */
  async disconnect(): Promise<void> {
    try {
      const result = await this.remote.disconnect({ forgetSavedLogin: true })
      if (!result.ok) throw new Error(result.error.message)
      this.publish(result.value)
    } catch (error) {
      throw this.fail(error)
    }
  }

  /**
   * Read the product-owned local AGENTS.md preferences.
   * @returns the current client-safe personalization snapshot.
   */
  async loadPersonalization(): Promise<GongchuangPersonalizationSnapshot> {
    const result = await this.remote.personalization()
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  /**
   * Persist local preferences that are loaded by future professional conversations.
   * @param instructions - complete user-authored personalization text.
   * @returns the saved client-safe personalization snapshot.
   */
  async savePersonalization(instructions: string): Promise<GongchuangPersonalizationSnapshot> {
    const result = await this.remote.savePersonalization({ instructions })
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  /**
   * Invalidate any in-flight snapshot load.
   * @returns nothing.
   */
  dispose(): void {
    this.generation += 1
  }

  private publish(snapshot: GongchuangAccountSnapshot): void {
    this.store.update((state) => {
      state.status = 'ready'
      state.snapshot = snapshot
      state.error = null
    })
  }

  private fail(error: unknown): Error {
    const presented = new Error(gongchuangUserError(error, 'account').text)
    this.store.update((state) => {
      state.status = 'error'
      state.error = presented.message
    })
    return presented
  }
}
