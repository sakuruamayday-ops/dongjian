import type {
  ClientRemote,
  GongchuangDeepSeekFileRetentionSeconds,
  GongchuangModelConfigureRequest,
  GongchuangModelConnectionView,
  GongchuangModelConnectionsSnapshot,
  GongchuangModelDirectoryFailureKind,
  GongchuangModelProvider,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { LlmConfigurableProvider, LlmProviderInfo } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { GONGCHUANG_MODEL_PROVIDERS } from '@gongchuang/model-connections/registry'
import { gongchuangUserError } from '@gongchuang/user-errors'

type ProductProvider = GongchuangModelProvider

/** Provider directory row formed from alpha's live and configurable LLM Remotes. */
interface ProviderDirectoryEntry {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly active: boolean
  readonly declared?: boolean
}

/** Provider readiness states presented by the product shell. */
export type ConnectionReadiness = 'loading' | 'ready' | 'missing' | 'unavailable' | 'error'

/** Client-safe readiness and route details for one model provider. */
export interface ProviderConnection {
  status: ConnectionReadiness
  /** Host receipt that a credential/profile exists, never the credential itself. */
  configured: boolean
  route?: string
  message: string
  verifiedAt?: string
  modelCount?: number
  selectedModel?: string
  failureKind?: GongchuangModelDirectoryFailureKind
  configuration?: GongchuangModelConnectionView['configuration']
}

/** Renderer-safe state of the DeepSeek provider-owned image transfer controls. */
export interface DeepSeekFilesState {
  status: 'loading' | 'ready' | 'error'
  retentionSeconds: number
  retentionOptions: readonly GongchuangDeepSeekFileRetentionSeconds[]
  message: string | null
}

/** Combined verified model-route discovery and selection state. */
export interface ConnectivityState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  providers: Record<ProductProvider, ProviderConnection>
  /** Product provider owning the Host's persisted default model route. */
  activeProvider: ProductProvider | null
  selection: 'idle' | 'selecting' | 'ready' | 'error'
  selectionError: string | null
  deepseekFiles: DeepSeekFilesState
}

function unavailable(message: string, configured = false): ProviderConnection {
  return { status: 'unavailable', configured, message }
}

function initialState(): ConnectivityState {
  return {
    status: 'idle',
    providers: Object.fromEntries(GONGCHUANG_MODEL_PROVIDERS.map(provider => [
      provider.id,
      unavailable(`正在读取 ${provider.label} 宿主连接回执`),
    ])) as Record<ProductProvider, ProviderConnection>,
    activeProvider: null,
    selection: 'idle',
    selectionError: null,
    deepseekFiles: {
      status: 'loading', retentionSeconds: 3_600,
      retentionOptions: [3_600, 604_800, 2_592_000], message: null,
    },
  }
}

function project(
  entry: ProviderDirectoryEntry | undefined,
  verified: GongchuangModelConnectionView,
): ProviderConnection {
  const saved = verified.configuration === undefined ? {} : { configuration: verified.configuration }
  if (verified.phase === 'error') {
    return {
      ...saved,
      status: 'error', configured: verified.configured, route: verified.route, message: verified.message,
      ...verified.failureKind === undefined ? {} : { failureKind: verified.failureKind },
    }
  }
  if (entry === undefined) {
    if (verified.phase === 'missing') {
      return { ...saved, status: 'missing', configured: false, route: verified.route, message: verified.message }
    }
    return { ...saved, ...unavailable('当前客户端未装载该模型适配器', verified.configured) }
  }
  if (!entry.active) return { ...saved, ...unavailable('模型适配器已安装，但当前路由尚未启用', verified.configured) }
  if (verified.phase === 'ready' && verified.verifiedAt !== null) {
    return {
      ...saved,
      status: 'ready',
      configured: verified.configured,
      route: entry.provider,
      message: verified.message,
      verifiedAt: verified.verifiedAt,
      modelCount: verified.modelCount,
      ...verified.selectedModel === null ? {} : { selectedModel: verified.selectedModel },
    }
  }
  if (verified.phase === 'candidate') {
    return {
      ...saved,
      status: 'ready', configured: verified.configured, route: entry.provider,
      message: verified.message, modelCount: verified.modelCount,
      ...verified.selectedModel === null ? {} : { selectedModel: verified.selectedModel },
    }
  }
  if (verified.phase === 'checking') {
    return { ...saved, status: 'loading', configured: verified.configured, route: entry.provider, message: verified.message }
  }
  return { ...saved, status: 'missing', configured: verified.configured, route: entry.provider, message: verified.message }
}

type ModelConnectionsRemote = ClientRemote['gongchuangModelConnections']
type LlmDirectoryRemote = Pick<ClientRemote['llm'], 'listConfigurableProviders' | 'listProviders'>

/** Browser controller over Host-owned endpoint probes and provider selection state. */
export class ConnectivityController {
  /** Observable connectivity state consumed by the model selector. */
  readonly store: SnapshotStore<ConnectivityState> = createSnapshotStore(initialState())
  private generation = 0

  constructor(
    private readonly llm: LlmDirectoryRemote,
    private readonly remote: ModelConnectionsRemote,
    private readonly activeRoute: () => string | undefined,
  ) {}

  /** Reload provider topology and the Host's verified, redacted connection receipts. */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'loading' })
    try {
      const [registered, configurable, modelConnections, deepseekFiles] = await Promise.all([
        this.llm.listProviders(),
        this.llm.listConfigurableProviders(),
        this.remote.snapshot(),
        this.remote.deepseekFiles(),
      ])
      if (!registered.ok) throw new Error(registered.error.message)
      if (!configurable.ok) throw new Error(configurable.error.message)
      if (!modelConnections.ok) throw new Error(modelConnections.error.message)
      if (!deepseekFiles.ok) throw new Error(deepseekFiles.error.message)
      if (generation !== this.generation) return
      this.publish(
        providerDirectory(registered.value, configurable.value),
        modelConnections.value,
        this.activeRoute(),
        deepseekFiles.value,
      )
    } catch (error) {
      if (generation !== this.generation) return
      const message = gongchuangUserError(error, 'model').text
      this.store.update((state) => {
        state.status = 'error'
        state.deepseekFiles.status = 'error'
        state.deepseekFiles.message = message
        state.providers = Object.fromEntries(GONGCHUANG_MODEL_PROVIDERS.map(provider => [
          provider.id,
          { ...state.providers[provider.id], status: 'error', message },
        ])) as Record<ProductProvider, ProviderConnection>
      })
    }
  }

  /**
   * Probe and commit one provider through the trusted Host service.
   * @param request - Provider-specific credential and endpoint fields entered by the user.
   */
  async configure(request: GongchuangModelConfigureRequest): Promise<void> {
    this.store.update((state) => {
      state.status = 'loading'
      // A replacement probe does not remove the Host's previously saved key.
      state.providers[request.provider] = {
        ...state.providers[request.provider], status: 'loading', message: '正在验证连接',
      }
    })
    const result = await this.remote.configure(request).catch((cause: unknown) => {
      this.failProvider(request.provider, cause)
      throw new Error(gongchuangUserError(cause, 'model').text)
    })
    if (!result.ok) {
      const error = new Error(gongchuangUserError(new Error(result.error.message), 'model').text)
      this.failProvider(request.provider, error)
      throw error
    }
    await this.load()
    const projected = this.store.getSnapshot().providers[request.provider]
    if (projected.status !== 'ready') throw new Error(projected.message)
  }

  /**
   * Re-check a stored key without exposing it to the renderer.
   * @param provider - Fixed product provider whose stored credential is rechecked.
   */
  async refreshProvider(provider: GongchuangModelProvider): Promise<void> {
    this.store.update((state) => {
      state.providers[provider] = {
        ...state.providers[provider],
        status: 'loading',
        configured: state.providers[provider].configured,
        message: '正在重新验证连接',
      }
    })
    const result = await this.remote.refresh({ provider }).catch((cause: unknown) => {
      this.failProvider(provider, cause)
      throw new Error(gongchuangUserError(cause, 'model').text)
    })
    if (!result.ok) {
      const error = new Error(gongchuangUserError(new Error(result.error.message), 'model').text)
      this.failProvider(provider, error)
      throw error
    }
    await this.load()
    const projected = this.store.getSnapshot().providers[provider]
    if (projected.status !== 'ready') throw new Error(projected.message)
  }

  /**
   * Recheck a retained Keychain failure after the first real response of a turn.
   * @param route - Provider recorded on the model response, not the current UI selection.
   */
  async recoverAfterResponse(route: string): Promise<void> {
    const provider = GONGCHUANG_MODEL_PROVIDERS.find(provider => provider.route === route)?.id
    if (provider === undefined) return
    const connection = this.store.getSnapshot().providers[provider]
    if (connection.status !== 'error' || connection.failureKind !== 'transient'
      || !connection.message.includes('GC-MODEL-KEYCHAIN')) return
    await this.refreshProvider(provider)
  }

  /**
   * Change the lifetime assigned to future DeepSeek remote image uploads.
   * @param retentionSeconds - Supported provider retention duration in seconds.
   */
  async setDeepSeekFileRetention(retentionSeconds: GongchuangDeepSeekFileRetentionSeconds): Promise<void> {
    this.store.update((state) => {
      state.deepseekFiles.status = 'loading'
      state.deepseekFiles.message = null
    })
    const result = await this.remote.setDeepSeekFileRetention({ retentionSeconds })
    if (!result.ok) {
      const message = gongchuangUserError(new Error(result.error.message), 'model').text
      this.store.update((state) => {
        state.deepseekFiles.status = 'error'
        state.deepseekFiles.message = message
      })
      throw new Error(message)
    }
    this.store.update((state) => {
      state.deepseekFiles = { status: 'ready', ...result.value, message: null }
    })
  }

  /**
   * Delete active-scope DeepSeek remote files and their local mappings.
   * @returns Number of remote files deleted.
   */
  async clearDeepSeekFiles(): Promise<number> {
    this.store.update((state) => {
      state.deepseekFiles.status = 'loading'
      state.deepseekFiles.message = null
    })
    const result = await this.remote.clearDeepSeekFiles()
    if (!result.ok) {
      const message = gongchuangUserError(new Error(result.error.message), 'model').text
      this.store.update((state) => {
        state.deepseekFiles.status = 'error'
        state.deepseekFiles.message = message
      })
      throw new Error(message)
    }
    this.store.update((state) => {
      state.deepseekFiles.status = 'ready'
      state.deepseekFiles.message = null
    })
    return result.value.deletedRemoteFiles
  }

  /** Mark a model selection as in flight. */
  beginSelection(): void {
    this.store.update((state) => {
      state.selection = 'selecting'
      state.selectionError = null
    })
  }

  /** Mark the current model selection as accepted by the Host. */
  selectionSucceeded(): void {
    this.store.update((state) => {
      state.selection = 'ready'
      state.selectionError = null
    })
  }

  /**
   * Publish one model-selection failure.
   * @param error - Host or transport failure to render in the connection state.
   */
  selectionFailed(error: unknown): void {
    this.store.update((state) => {
      state.selection = 'error'
      state.selectionError = gongchuangUserError(error, 'model').text
    })
  }

  /** Keep a committed connection visible when only its automatic selection failed.
   * @param error - Host selection failure after the connection was saved.
   * @returns User-facing partial-success message stored in the selection state.
   */
  selectionPartiallySucceeded(error: unknown): string {
    const detail = gongchuangUserError(error, 'model').text
    const message = `连接已保存，自动切换失败：${detail}`
    this.store.update((state) => {
      state.selection = 'error'
      state.selectionError = message
    })
    return message
  }

  /** Surface a provider-side quota/model failure from an actual conversation turn.
   * @param provider - The provider value.
   * @param message - The message value.
   */
  recordRuntimeFailure(provider: ProductProvider, message: string): void {
    const safeMessage = gongchuangUserError(new Error(message), 'model').text
    this.store.update((state) => {
      const current = state.providers[provider]
      state.providers[provider] = {
        ...current,
        status: 'error',
        configured: true,
        message: safeMessage,
      }
      state.status = 'error'
    })
  }

  private publish(
    entries: readonly ProviderDirectoryEntry[],
    snapshot: GongchuangModelConnectionsSnapshot,
    activeRoute: string | undefined,
    deepseekFiles: { readonly retentionSeconds: number; readonly retentionOptions: readonly GongchuangDeepSeekFileRetentionSeconds[] },
  ): void {
    this.store.update((state) => {
      state.status = 'ready'
      state.providers = Object.fromEntries(GONGCHUANG_MODEL_PROVIDERS.map((provider) => {
        const verified = snapshot.providers[provider.id]
        const entry = entries.find(candidate => candidate.provider === verified.route)
        return [provider.id, project(entry, verified)]
      })) as Record<ProductProvider, ProviderConnection>
      state.activeProvider = productProviderForRoute(snapshot, activeRoute)
      state.deepseekFiles = { status: 'ready', ...deepseekFiles, message: null }
    })
  }

  private failProvider(provider: GongchuangModelProvider, error: unknown): void {
    const message = gongchuangUserError(error, 'model').text
    this.store.update((state) => {
      state.status = 'error'
      state.providers[provider] = {
        ...state.providers[provider],
        status: 'error',
        configured: state.providers[provider].configured,
        message,
      }
    })
  }
}

/** Join alpha's declared provider directory with the routes that currently have adapters. */
function providerDirectory(
  registered: readonly LlmProviderInfo[],
  configurable: readonly LlmConfigurableProvider[],
): ProviderDirectoryEntry[] {
  const active = new Set(registered.map(entry => entry.id))
  const declared = new Set(configurable.map(entry => entry.provider))
  const rows: ProviderDirectoryEntry[] = configurable.map(entry => ({
    provider: entry.provider,
    displayName: entry.displayName,
    settingsNs: entry.settingsNs,
    settingsPath: [...entry.settingsPath],
    active: active.has(entry.provider),
    ...entry.declared === undefined ? {} : { declared: entry.declared },
  }))
  for (const entry of registered) {
    if (declared.has(entry.id)) continue
    rows.push({
      provider: entry.id,
      displayName: entry.name,
      settingsNs: '',
      settingsPath: [],
      active: true,
    })
  }
  return rows
}

/** Resolve one Host route to the product selector without guessing from readiness.
 * @param snapshot - The snapshot value.
 * @param route - The route value.
 * @returns The product provider for route result.
 */
export function productProviderForRoute(
  snapshot: GongchuangModelConnectionsSnapshot,
  route: string | undefined,
): ProductProvider | null {
  if (route === undefined) return null
  return GONGCHUANG_MODEL_PROVIDERS.find(provider => snapshot.providers[provider.id].route === route)?.id ?? null
}
