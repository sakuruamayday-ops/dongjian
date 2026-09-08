/** Verified model connections for 共创企业助手. */

import { randomBytes } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { assertUsableApiKey, attributionHeaders } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { gongchuangDiagnostic, gongchuangUserError } from '@gongchuang/user-errors'
import type {
  GongchuangCustomModelConfigureRequest,
  GongchuangDeepSeekFileRetentionRequest,
  GongchuangDeepSeekFilesCleanupReceipt,
  GongchuangDeepSeekFilesView,
  GongchuangModelConfigureRequest,
  GongchuangModelConnectionView,
  GongchuangModelConnectionsSnapshot,
  GongchuangModelProvider,
  GongchuangModelRefreshRequest,
  GongchuangOfficialModelConfigureRequest,
} from './types.ts'
import {
  GONGCHUANG_MODEL_PROVIDERS,
  gongchuangProviderDefinition,
  type GongchuangProviderDefinition,
  type GongchuangProviderProtocol,
} from './provider-registry.ts'

export type * from './types.ts'

/** Provider route ids that the product publishes into the shared LLM runtime. */
export const GONGCHUANG_MODEL_PROVIDER_ROUTES = Object.freeze(Object.fromEntries(
  GONGCHUANG_MODEL_PROVIDERS.map(provider => [provider.id, provider.route]),
)) as Readonly<Record<GongchuangModelProvider, string>>

const DEEPSEEK_ROUTE = GONGCHUANG_MODEL_PROVIDER_ROUTES.deepseek
const CUSTOM_ROUTE = GONGCHUANG_MODEL_PROVIDER_ROUTES.custom
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const DEEPSEEK_KEY = credentialRef('DEEPSEEK_API_KEY')
const PI_AI_NS = 'llm-pi-ai'
const DEEPSEEK_NS = 'llm-deepseek'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000
const CUSTOM_KEY_PREFIX = 'GONGCHUANG_CUSTOM_API_'
const LOCAL_NO_AUTH_KEY = 'gongchuang-local-no-auth'
const DEEPSEEK_FILE_RETENTION_OPTIONS = Object.freeze([3_600, 604_800, 2_592_000] as const)

class ModelDirectoryProbeError extends Error {
  constructor(
    readonly failureKind: 'auth' | 'transient' | 'catalog',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ModelDirectoryProbeError'
  }
}

class UnsupportedModelsEndpointError extends Error {
  constructor(readonly status: number) {
    super(`模型服务不支持 GET /models，HTTP ${String(status)}`)
    this.name = 'UnsupportedModelsEndpointError'
  }
}

function modelDirectoryFailureKind(error: unknown): 'auth' | 'transient' | 'catalog' {
  if (error instanceof Error && error.message.includes('Keychain is temporarily unavailable')) return 'transient'
  return error instanceof ModelDirectoryProbeError ? error.failureKind : 'catalog'
}

interface ProbedModel {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
  readonly maxTokens?: number
}

interface DeepSeekFilesControlView {
  releaseAll(signal?: AbortSignal): Promise<number>
}

type ProfileReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

interface ProfileModel extends ProbedModel {
  readonly input?: readonly ('text' | 'image')[]
  readonly reasoningEfforts?: false | Readonly<Partial<Record<ProfileReasoningLevel, string | null>>>
  readonly compat?: {
    readonly thinkingFormat?: string
    readonly supportsReasoningEffort?: boolean
  }
}

interface CustomProfile {
  readonly catalogProvider?: string
  readonly apiKeyEnv: string
  readonly displayName: string
  readonly api: GongchuangProviderProtocol
  readonly baseURL: string
  readonly models: readonly ProfileModel[]
  readonly streamIdleTimeoutMs?: number
}

type ManagedPresetProvider = Exclude<GongchuangModelProvider, 'deepseek' | 'custom'>

function normalizedModelId(modelId: string): string {
  return modelId.toLocaleLowerCase('en-US').replaceAll(/[^a-z0-9]+/gu, '-')
}

function isDeepSeekV4FlashId(modelId: string): boolean {
  const normalized = normalizedModelId(modelId)
  return normalized === 'deepseek-v4-flash' || normalized.endsWith('-deepseek-v4-flash')
}

function endpointProfileModel(
  model: ProbedModel,
  trusted?: ProfileModel,
  inheritInstalledCatalog = false,
): ProfileModel {
  if (inheritInstalledCatalog) return { ...model }
  return {
    // Model-directory responses often contain only an id. Preserve user-entered
    // capacity and display metadata unless the endpoint returns a newer value.
    ...trusted,
    ...model,
    input: trusted?.input ?? ['text'],
    reasoningEfforts: trusted?.reasoningEfforts ?? false,
    ...trusted?.compat === undefined ? {} : { compat: trusted.compat },
  }
}

interface ManagedPreset {
  readonly route: string
  readonly baseURL: string
  readonly credential: CredentialRef
  readonly definition: GongchuangProviderDefinition
  readonly displayName: string
  readonly streamIdleTimeoutMs?: number
}

const MANAGED_PRESETS = Object.freeze(Object.fromEntries(
  GONGCHUANG_MODEL_PROVIDERS
    .filter((provider): provider is typeof provider & { id: ManagedPresetProvider } =>
      provider.id !== 'deepseek' && provider.id !== 'custom')
    .map((provider) => {
      const definition: GongchuangProviderDefinition = provider
      return [provider.id, {
        route: definition.route,
        baseURL: definition.baseURL,
        credential: credentialRef(definition.credentialEnv as string),
        definition,
        displayName: definition.label,
        ...definition.streamIdleTimeoutMs === undefined
          ? {}
          : { streamIdleTimeoutMs: definition.streamIdleTimeoutMs },
      }]
    }),
)) as Readonly<Record<ManagedPresetProvider, ManagedPreset>>

function routeFor(provider: GongchuangModelProvider): string {
  return gongchuangProviderDefinition(provider).route
}

function isManagedPreset(provider: GongchuangModelProvider): provider is ManagedPresetProvider {
  return provider !== 'deepseek' && provider !== 'custom'
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseModels(value: unknown): ProbedModel[] {
  const data = record(value)?.data
  if (!Array.isArray(data)) throw new Error('模型服务返回的目录缺少 data 数组')
  const models: ProbedModel[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    const row = record(raw)
    const id = nonEmptyString(row?.id)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const name = nonEmptyString(row?.name) ?? nonEmptyString(row?.display_name)
    const contextWindow = positiveInteger(row?.context_window) ?? positiveInteger(row?.context_length)
    const maxTokens = positiveInteger(row?.max_output_tokens) ?? positiveInteger(row?.max_tokens)
    models.push({
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  if (models.length === 0) throw new Error('模型服务已响应，但没有返回可用模型')
  return models
}

async function readBounded(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error('模型目录响应超过 4 MB 安全上限')
  }
  if (response.body === null) throw new Error('模型服务返回了空响应')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new Error('模型目录响应超过 4 MB 安全上限')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {
      // Drained or rejected responses need only best-effort transport cleanup.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown
  } catch (error) {
    throw new Error('模型服务返回了无法解析的 JSON', { cause: error })
  }
}

function normalizeBaseURL(value: string): string {
  const trimmed = value.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch (error) {
    throw new Error('请输入完整的 API 基础地址，例如 https://api.example.com/v1', { cause: error })
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('自定义 API 必须使用 HTTPS；本机 127.0.0.1、localhost 或 ::1 可使用 HTTP')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('API 基础地址不能包含账号、密码、查询参数或片段')
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (/\/(?:chat\/completions|responses|models)$/i.test(path)) {
    throw new Error('请填写 API 基础地址，不要包含 /models、/chat/completions 或 /responses')
  }
  url.pathname = path === '' ? '/' : path
  return url.toString().replace(/\/+$/, '')
}

function configuredBaseURL(
  preset: ManagedPreset,
  request?: GongchuangOfficialModelConfigureRequest,
): string {
  const supplied = request?.baseURL?.trim()
  // Kimi Code subscription keys belong to a different endpoint from Moonshot API keys.
  if (preset.definition.id === 'kimi-coding' && request?.apiKey?.trim().startsWith('sk-kimi-')) {
    return 'https://api.kimi.com/coding/v1'
  }
  if (preset.definition.baseURLMode === 'required') {
    if (supplied === undefined || supplied === '') throw new Error(`${preset.displayName} 需要填写 API 基础地址`)
    return normalizeBaseURL(supplied)
  }
  if (preset.definition.baseURLMode === 'optional' && supplied !== undefined && supplied !== '') {
    return normalizeBaseURL(supplied)
  }
  return normalizeBaseURL(preset.baseURL)
}

function requestedModelId(request: GongchuangOfficialModelConfigureRequest): string | undefined {
  const modelId = request.modelId?.trim()
  if (modelId === undefined || modelId === '') return undefined
  if (modelId.length > 200) throw new Error('模型 ID 应为 1 至 200 个字符')
  return modelId
}

async function probeModels(
  baseURL: string,
  apiKey: string,
  protocol: GongchuangProviderProtocol = 'openai-completions',
): Promise<readonly ProbedModel[]> {
  const root = baseURL.replace(/\/+$/, '')
  const endpoint = protocol === 'anthropic-messages'
    ? `${root.replace(/\/v1$/, '')}/v1/models`
    : `${root}/models`
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        ...apiKey === LOCAL_NO_AUTH_KEY
          ? {}
          : protocol === 'anthropic-messages'
            ? { 'anthropic-version': '2023-06-01', 'x-api-key': apiKey }
            : { authorization: `Bearer ${apiKey}` },
        ...attributionHeaders(),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ModelDirectoryProbeError('transient', '连接模型服务超时', { cause: error })
    }
    throw new ModelDirectoryProbeError('transient', '无法连接模型服务，请检查网络与 API 基础地址', { cause: error })
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      throw new UnsupportedModelsEndpointError(response.status)
    }
    const keyHint = response.status === 401 || response.status === 403 ? '，请检查 API Key' : ''
    const failureKind = response.status === 401 || response.status === 403
      ? 'auth'
      : response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
        ? 'transient'
        : 'catalog'
    throw new ModelDirectoryProbeError(
      failureKind,
      `模型服务连接检查失败，HTTP ${String(response.status)}${keyHint}`,
    )
  }
  return parseModels(await readBounded(response))
}

function initialView(provider: GongchuangModelProvider, route: string): GongchuangModelConnectionView {
  return Object.freeze({
    provider, route, phase: 'missing', configured: false, verifiedAt: null,
    modelCount: 0, selectedModel: null, message: '尚未配置',
  })
}

function initialProviders(): Record<GongchuangModelProvider, GongchuangModelConnectionView> {
  return Object.fromEntries(GONGCHUANG_MODEL_PROVIDERS.map(provider => [
    provider.id,
    initialView(provider.id, provider.route),
  ])) as Record<GongchuangModelProvider, GongchuangModelConnectionView>
}

function freezeSnapshot(
  revision: number,
  providers: Record<GongchuangModelProvider, GongchuangModelConnectionView>,
): GongchuangModelConnectionsSnapshot {
  return Object.freeze({ revision, providers: Object.freeze({ ...providers }) })
}

function asCustomProfile(value: unknown): CustomProfile | undefined {
  const row = record(value)
  const apiKeyEnv = nonEmptyString(row?.apiKeyEnv)
  const displayName = nonEmptyString(row?.displayName)
  const catalogProvider = row?.catalogProvider === 'opencode' || row?.catalogProvider === 'opencode-go' ? row.catalogProvider : undefined
  const nativePreset = catalogProvider === 'opencode' ? MANAGED_PRESETS['opencode-zen']
    : catalogProvider === 'opencode-go' ? MANAGED_PRESETS['opencode-go'] : undefined
  const api = row?.api ?? (nativePreset === undefined ? undefined : 'openai-completions')
  const baseURL = nonEmptyString(row?.baseURL) ?? nativePreset?.baseURL
  if (apiKeyEnv === undefined || displayName === undefined || baseURL === undefined
    || (api !== 'openai-completions' && api !== 'openai-responses' && api !== 'anthropic-messages')) return undefined
  const rawModels = row?.models
  if (!Array.isArray(rawModels)) return undefined
  const models = rawModels.flatMap((candidate): ProfileModel[] => {
    const model = record(candidate)
    const id = nonEmptyString(model?.id)
    if (id === undefined) return []
    const name = nonEmptyString(model?.name)
    const contextWindow = positiveInteger(model?.contextWindow)
    const maxTokens = positiveInteger(model?.maxTokens)
    const rawInput = model?.input
    const input = Array.isArray(rawInput)
      && rawInput.length > 0
      && rawInput.every(modality => modality === 'text' || modality === 'image')
      ? rawInput as Array<'text' | 'image'>
      : undefined
    const rawReasoning = model?.reasoningEfforts
    const reasoning = record(rawReasoning)
    const reasoningEfforts = rawReasoning === false
      ? false
      : reasoning === undefined
        ? undefined
        : Object.fromEntries(Object.entries(reasoning).filter(([level, wire]) =>
          ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)
          && (wire === null || typeof wire === 'string')))
    const compat = record(model?.compat)
    const thinkingFormat = nonEmptyString(compat?.thinkingFormat)
    const supportsReasoningEffort = typeof compat?.supportsReasoningEffort === 'boolean'
      ? compat.supportsReasoningEffort
      : undefined
    return [{
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...input === undefined ? {} : { input },
      ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
      ...thinkingFormat === undefined && supportsReasoningEffort === undefined
        ? {}
        : {
          compat: {
            ...thinkingFormat === undefined ? {} : { thinkingFormat },
            ...supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort },
          },
        },
    }]
  })
  if (models.length === 0) return undefined
  const streamIdleTimeoutMs = positiveInteger(row?.streamIdleTimeoutMs)
  return {
    apiKeyEnv, displayName, api, baseURL, models,
    ...catalogProvider === undefined ? {} : { catalogProvider },
    ...streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs },
  }
}

function storedManagedProfile(profile: CustomProfile): unknown {
  if (profile.catalogProvider !== 'opencode' && profile.catalogProvider !== 'opencode-go') return profile
  // OpenCode has mixed native protocols; a route-wide API or URL would override all of them.
  const { api: _api, baseURL: _baseURL, ...stored } = profile
  return { ...stored, api: null, baseURL: null }
}

/** Host-owned verified state for the product model choices. */
export class GongchuangModelConnectionsService extends TypertRemoteService {
  static inject = ['credentials', 'settings', 'llm']

  private current = freezeSnapshot(0, initialProviders())
  private operation: Promise<void> = Promise.resolve()
  private startupReconciliation: Promise<void> = Promise.resolve()
  private closed = false
  private internalCommitDepth = 0

  constructor(ctx: Context) {
    super(ctx, 'gongchuangModelConnections')
  }

  protected [Service.init](): void {
    this.ctx.effect(() => async () => {
      this.closed = true
      await this.operation
    }, 'gongchuang-model-connections: quiesce operations')

    // Refresh exactly once on startup. Later network refreshes happen only
    // during explicit configuration or when the user clicks Refresh models.
    // Never make the desktop plugin tree or main window wait for Keychain.
    this.startupReconciliation = this.exclusive(async () => { await this.refreshProviders() }).catch((error: unknown) => {
      this.ctx.logger.warn('gongchuang-model-connections: startup connection reconciliation failed')
      this.ctx.logger.warn(error)
    })
  }

  /**
   * Read the first settled startup state, then the latest redacted state without new network activity.
   * @returns Immutable provider status without keys or credential references.
   */
  @Remote('snapshot')
  async snapshot(): Promise<GongchuangModelConnectionsSnapshot> {
    await this.startupReconciliation
    return this.current
  }

  /**
   * Read the current DeepSeek remote-image lifetime without exposing credentials or file ids.
   * @returns Current resolved retention and the three product-supported choices.
   */
  @Remote('deepseekFiles')
  deepseekFiles(): GongchuangDeepSeekFilesView {
    const section = record(this.ctx.settings.get(DEEPSEEK_NS))
    const retentionSeconds = positiveInteger(section?.fileExpiresAfterSeconds)
    if (retentionSeconds === undefined) throw new Error('DeepSeek 图片保留期设置尚未装载')
    return Object.freeze({
      retentionSeconds,
      retentionOptions: DEEPSEEK_FILE_RETENTION_OPTIONS,
    })
  }

  /**
   * Apply one product-supported lifetime to future DeepSeek image uploads.
   * @param request - One hour, seven days, or thirty days.
   * @returns Resolved redacted settings after the atomic update.
   */
  @Remote('setDeepSeekFileRetention')
  setDeepSeekFileRetention(
    request: GongchuangDeepSeekFileRetentionRequest,
  ): Promise<GongchuangDeepSeekFilesView> {
    return this.exclusive(async () => {
      if (!DEEPSEEK_FILE_RETENTION_OPTIONS.includes(request.retentionSeconds)) {
        throw new Error('DeepSeek 图片保留期只支持 1 小时、7 天或 30 天')
      }
      const descriptor = this.ctx.settings.describe().find(row => row.ns === DEEPSEEK_NS)
      if (descriptor === undefined) throw new Error('DeepSeek 图片保留期设置尚未装载')
      const section = record(this.ctx.settings.get(DEEPSEEK_NS))
      const currentMargin = positiveInteger(section?.fileRefreshMarginSeconds) ?? 300
      const fileRefreshMarginSeconds = Math.min(currentMargin, request.retentionSeconds - 1)
      await this.commitInternally(() => this.ctx.settings.mutate(DEEPSEEK_NS, [{
        op: 'set', path: ['fileExpiresAfterSeconds'], value: request.retentionSeconds,
      }, {
        op: 'set', path: ['fileRefreshMarginSeconds'], value: fileRefreshMarginSeconds,
      }], descriptor.revision))
      return this.deepseekFiles()
    })
  }

  /**
   * Delete every Harness-owned DeepSeek file for the active credential and clear its local mapping.
   * @returns Redacted deletion count and completion time.
   */
  @Remote('clearDeepSeekFiles')
  clearDeepSeekFiles(): Promise<GongchuangDeepSeekFilesCleanupReceipt> {
    return this.exclusive(async () => {
      const control = (this.ctx as unknown as { deepseekFilesControl?: DeepSeekFilesControlView })
        .deepseekFilesControl
      if (control === undefined) throw new Error('DeepSeek 远端文件清理能力尚未装载')
      const deletedRemoteFiles = await control.releaseAll()
      return Object.freeze({ deletedRemoteFiles, clearedAt: new Date().toISOString() })
    })
  }

  /**
   * Re-check one or all configured providers using stored OS-keychain credentials.
   * @param request - Optional provider filter; omission refreshes every product route.
   * @returns Redacted state after every requested probe settles.
   */
  @Remote('refresh')
  refresh(request: GongchuangModelRefreshRequest): Promise<GongchuangModelConnectionsSnapshot> {
    return this.exclusive(async () => {
      await this.refreshProviders(request.provider)
      return this.current
    })
  }

  /**
   * Probe a supplied key and commit it only after the endpoint proves usable.
   * @param request - Fixed official or validated custom-provider configuration.
   * @returns Redacted state after the transactional credential update.
   */
  @Remote('configure')
  configure(request: GongchuangModelConfigureRequest): Promise<GongchuangModelConnectionsSnapshot> {
    return this.exclusive(async () => {
      const previous = this.current.providers[request.provider]
      try {
        if (request.provider === 'custom') await this.configureCustom(request)
        else if (request.provider === 'deepseek') await this.configureOfficial(request)
        else await this.configureManagedPreset(request.provider, request)
      } catch (error) {
        // Credential reads and rollback diagnostics can fail before a provider's
        // own catch publishes. Every rejected configure must leave checking.
        if (this.current.providers[request.provider].phase === 'checking') {
          this.publish(request.provider, { ...previous, phase: 'error', verifiedAt: null,
            message: this.presentFailure('配置模型连接', error), failureKind: modelDirectoryFailureKind(error) })
        }
        throw error
      }
      return this.current
    })
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('模型连接服务已关闭'))
    const task = this.operation.then(operation)
    this.operation = task.then(() => undefined, () => undefined)
    return task
  }

  /** Keep this service's own atomic writes from echoing back as stale probes. */
  private async commitInternally<T>(operation: () => Promise<T>): Promise<T> {
    this.internalCommitDepth += 1
    try {
      return await operation()
    } finally {
      this.internalCommitDepth -= 1
    }
  }

  private publish(
    provider: GongchuangModelProvider,
    view: Omit<GongchuangModelConnectionView, 'provider' | 'route'>,
  ): void {
    const route = routeFor(provider)
    const definition = gongchuangProviderDefinition(provider)
    const profile = provider === 'custom' || definition.baseURLMode !== 'fixed'
      ? this.profileForRoute(route)
      : undefined
    let configuration: GongchuangModelConnectionView['configuration']
    if (profile !== undefined) {
      let baseURL: string | undefined
      try {
        baseURL = normalizeBaseURL(profile.baseURL)
      } catch { /* Invalid legacy URLs may contain secrets; never echo them into the form. */ }
      if (baseURL !== undefined) {
        configuration = Object.freeze({
          displayName: profile.displayName, baseURL, protocol: profile.api,
          modelId: view.selectedModel ?? profile.models[0]?.id ?? '',
        })
      }
    }
    this.current = freezeSnapshot(this.current.revision + 1, {
      ...this.current.providers,
      [provider]: Object.freeze({
        provider, route, ...view,
        ...(configuration === undefined ? {} : { configuration }),
      }),
    })
  }

  private async refreshProviders(only?: GongchuangModelProvider): Promise<void> {
    const providers: readonly GongchuangModelProvider[] = only === undefined
      ? GONGCHUANG_MODEL_PROVIDERS.map(provider => provider.id)
      : [only]
    await this.refreshProviderSet(providers)
  }

  /** Keep providers sharing llm-pi-ai in one revision sequence. */
  private async refreshProviderSet(providers: readonly GongchuangModelProvider[]): Promise<void> {
    const deepSeekRefresh = providers.includes('deepseek')
      ? this.refreshProviderIsolated('deepseek')
      : Promise.resolve()
    const sharedCatalogRefresh = async (): Promise<void> => {
      for (const provider of providers) {
        if (provider !== 'deepseek') await this.refreshProviderIsolated(provider)
      }
    }
    await Promise.all([deepSeekRefresh, sharedCatalogRefresh()])
  }

  /** Keep one credential-store failure from aborting the other provider refreshes. */
  private async refreshProviderIsolated(provider: GongchuangModelProvider): Promise<void> {
    const previous = this.current.providers[provider]
    try {
      await this.refreshProvider(provider)
    } catch (error) {
      const presented = this.presentFailure('刷新模型提供方', error)
      this.publish(provider, {
        phase: 'error', configured: previous.configured, verifiedAt: previous.verifiedAt,
        modelCount: previous.modelCount, selectedModel: previous.selectedModel,
        message: presented, failureKind: modelDirectoryFailureKind(error),
      })
    }
  }

  private async refreshProvider(provider: GongchuangModelProvider): Promise<void> {
    if (isManagedPreset(provider)) {
      await this.refreshManagedPreset(provider)
      return
    }
    if (provider === 'deepseek') {
      await this.refreshDeepSeek()
      return
    }
    await this.refreshCustom()
  }

  private async refreshDeepSeek(): Promise<void> {
    const stored = await this.ctx.credentials.resolve(DEEPSEEK_KEY)
    if (stored === undefined) {
      this.publish('deepseek', {
        phase: 'missing', configured: false, verifiedAt: null,
        modelCount: 0, selectedModel: null, message: '尚未配置 API Key',
      })
      return
    }
    const previousModels = this.deepSeekCatalog()
    const previousConnection = this.deepSeekConnection()
    const previousSelection = this.current.providers.deepseek.selectedModel
    this.publish('deepseek', {
      phase: 'checking', configured: true, verifiedAt: null,
      modelCount: 0, selectedModel: previousSelection, message: '正在刷新官方模型列表',
    })
    let catalogCommitted = false
    try {
      const key = assertUsableApiKey(stored.value, '@gongchuang/model-connections', DEEPSEEK_KEY)
      const probed = await probeModels(DEEPSEEK_BASE_URL, key)
      await this.commitDeepSeekCatalog(this.dynamicDeepSeekCatalog(probed))
      catalogCommitted = true
      const models = await this.usableOfficialModels(probed)
      const selectedModel = previousSelection !== null && models.some(model => model.id === previousSelection)
        ? previousSelection
        : this.preferredModel(models)
      this.publish('deepseek', {
        phase: 'ready', configured: true, verifiedAt: new Date().toISOString(),
        modelCount: models.length, selectedModel,
        message: `官方模型列表已刷新，可用模型 ${String(models.length)} 个`,
      })
    } catch (error) {
      if (catalogCommitted) {
        await this.restoreDeepSeekCatalog(previousModels, previousConnection).catch((rollbackError: unknown) => {
          this.ctx.logger.warn('gongchuang-model-connections: DeepSeek catalog rollback failed')
          this.ctx.logger.warn(gongchuangDiagnostic(rollbackError))
        })
      }
      const presented = this.presentFailure('刷新模型连接', error)
      this.publish('deepseek', {
        phase: 'error', configured: true, verifiedAt: null,
        modelCount: 0, selectedModel: previousSelection,
        message: presented, failureKind: modelDirectoryFailureKind(error),
      })
    }
  }

  private async refreshCustom(): Promise<void> {
    const previous = this.customProfile()
    if (previous === undefined) {
      this.publish('custom', {
        phase: 'missing', configured: false, verifiedAt: null,
        modelCount: 0, selectedModel: null, message: '尚未配置 API Key',
      })
      return
    }
    let ref: CredentialRef
    try {
      ref = credentialRef(previous.apiKeyEnv)
    } catch {
      this.publish('custom', {
        phase: 'missing', configured: false, verifiedAt: null,
        modelCount: 0, selectedModel: null, message: '尚未配置 API Key',
      })
      return
    }
    const stored = await this.ctx.credentials.resolve(ref)
    if (stored === undefined) {
      this.publish('custom', {
        phase: 'missing', configured: false, verifiedAt: null,
        modelCount: 0, selectedModel: null, message: '尚未配置 API Key',
      })
      return
    }
    const previousSelection = this.current.providers.custom.selectedModel ?? previous.models[0]?.id ?? null
    this.publish('custom', {
      phase: 'checking', configured: true, verifiedAt: null,
      modelCount: 0, selectedModel: previousSelection, message: '正在刷新自定义模型列表',
    })
    let candidate: CustomProfile | undefined
    try {
      const key = assertUsableApiKey(stored.value, '@gongchuang/model-connections', ref)
      let probed: readonly ProbedModel[]
      try {
        probed = await probeModels(normalizeBaseURL(previous.baseURL), key, previous.api)
      } catch (error) {
        if (!(error instanceof UnsupportedModelsEndpointError) || previousSelection === null) throw error
        candidate = {
          ...previous,
          models: [endpointProfileModel({ id: previousSelection })],
        }
        await this.commitCustomProfile(candidate)
        await this.usableProfileModels('custom', [{ id: previousSelection }])
        this.publish('custom', {
          phase: 'candidate', configured: true, verifiedAt: null,
          modelCount: 1, selectedModel: previousSelection,
          message: `端点不提供模型目录；${previousSelection} 已登记为文本模型`,
        })
        return
      }
      const trusted = new Map(previous.models.map(model => [model.id, model]))
      const selected = previousSelection === null ? undefined : probed.find(model => model.id === previousSelection)
      const ordered = selected === undefined
        ? probed
        : [selected, ...probed.filter(model => model.id !== selected.id)]
      candidate = {
        ...previous,
        models: ordered.map(model => endpointProfileModel(model, trusted.get(model.id))),
      }
      await this.commitCustomProfile(candidate)
      const models = await this.usableProfileModels('custom', probed)
      const selectedModel = selected?.id ?? this.preferredModel(models)
      this.publish('custom', {
        phase: 'ready', configured: true, verifiedAt: new Date().toISOString(),
        modelCount: models.length, selectedModel,
        message: `自定义模型列表已刷新，可用模型 ${String(models.length)} 个`,
      })
    } catch (error) {
      if (candidate !== undefined) await this.rollbackCustomProfile(candidate, previous)
      const presented = this.presentFailure('刷新自定义模型列表', error)
      this.publish('custom', {
        phase: 'error', configured: true, verifiedAt: null,
        modelCount: 0, selectedModel: previousSelection,
        message: presented, failureKind: modelDirectoryFailureKind(error),
      })
    }
  }

  /** Replace a managed relay's adapter catalog with its latest authenticated directory. */
  private async refreshManagedPreset(provider: ManagedPresetProvider): Promise<void> {
    const preset = MANAGED_PRESETS[provider]
    const previousProfile = this.profileForRoute(preset.route)
    let stored = await this.ctx.credentials.resolve(preset.credential)
    if (stored === undefined) {
      for (const legacyEnv of preset.definition.legacyCredentialEnvs ?? []) {
        const legacy = await this.ctx.credentials.resolve(credentialRef(legacyEnv))
        if (legacy === undefined) continue
        await this.commitInternally(() => this.ctx.credentials.set(preset.credential, legacy.value))
        stored = legacy
        break
      }
    }
    if (stored === undefined) {
      this.publish(provider, {
        phase: 'missing', configured: false, verifiedAt: null,
        modelCount: 0, selectedModel: null, message: '尚未配置 API Key',
      })
      return
    }
    const previousAdapterModels = await this.ctx.llm.listModels(preset.route).catch(() => [])
    const previousSelection = previousProfile?.models[0]?.id ?? previousAdapterModels[0]?.id ?? null
    this.publish(provider, {
      phase: 'checking', configured: true, verifiedAt: null,
      modelCount: 0, selectedModel: previousSelection, message: '正在刷新中转站模型列表',
    })
    let profileCommitted = false
    try {
      const key = assertUsableApiKey(stored.value, '@gongchuang/model-connections', preset.credential)
      const baseURL = configuredBaseURL(preset, {
        provider, apiKey: key, ...previousProfile === undefined ? {} : { baseURL: previousProfile.baseURL },
      })
      let models: readonly ProbedModel[]
      let directoryUnsupported = false
      try {
        models = await probeModels(baseURL, key, preset.definition.api)
      } catch (error) {
        if (!(error instanceof UnsupportedModelsEndpointError) || previousSelection === null) throw error
        models = [{ id: previousSelection }]
        directoryUnsupported = true
      }
      const descriptor = this.ctx.settings.describe().find(row => row.ns === PI_AI_NS)
      if (descriptor === undefined) throw new Error('模型预设设置服务尚未装载')
      models = await this.managedDirectoryModels(provider, models)
      const trustedModels = new Map(previousProfile?.models.map(model => [model.id, model]))
      const refreshedProfile: CustomProfile = {
        ...previousProfile,
        ...provider === 'opencode-zen' ? { catalogProvider: 'opencode' }
          : provider === 'opencode-go' ? { catalogProvider: 'opencode-go' } : {},
        // Discovery and dispatch must use the same credential, endpoint and
        // protocol, including profiles migrated from a legacy credential name.
        apiKeyEnv: String(preset.credential),
        displayName: preset.displayName,
        api: preset.definition.api,
        baseURL,
        ...preset.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: preset.streamIdleTimeoutMs },
        models: models.map(model => endpointProfileModel(
          model,
          trustedModels.get(model.id),
          provider === 'opencode-go' || provider === 'opencode-zen',
        )),
      }
      await this.commitInternally(() => this.ctx.settings.mutate(PI_AI_NS, [{
        op: 'set', path: ['providers', preset.route], value: storedManagedProfile(refreshedProfile),
      }], descriptor.revision))
      profileCommitted = true
      const usable = await this.usableProfileModels(provider, models)
      const selectedModel = previousSelection !== null && usable.some(model => model.id === previousSelection)
        ? previousSelection
        : this.preferredModel(usable)
      this.publish(provider, {
        phase: directoryUnsupported ? 'candidate' : 'ready', configured: true,
        verifiedAt: directoryUnsupported ? null : new Date().toISOString(),
        modelCount: usable.length, selectedModel,
        message: directoryUnsupported
          ? `端点不提供模型目录；${selectedModel} 已登记为文本模型`
          : `${preset.displayName} 模型列表已刷新，可用模型 ${String(usable.length)} 个${refreshedProfile.catalogProvider ? '，仅列出当前底座已适配的模型' : ''}`,
      })
    } catch (error) {
      let rollbackFailed = false
      if (profileCommitted) {
        try {
          await this.restoreManagedProfile(provider, previousProfile)
        } catch (rollbackError) {
          rollbackFailed = true
          this.ctx.logger.warn('gongchuang-model-connections: managed profile rollback failed')
          this.ctx.logger.warn(gongchuangDiagnostic(rollbackError))
        }
      }
      const presented = this.presentFailure('刷新中转站模型列表', error)
        + (rollbackFailed ? '旧配置未完整恢复，请重新配置该模型连接。' : '')
      this.publish(provider, {
        phase: 'error', configured: true, verifiedAt: null,
        modelCount: previousProfile?.models.length ?? previousAdapterModels.length, selectedModel: previousSelection,
        message: presented, failureKind: modelDirectoryFailureKind(error),
      })
    }
  }

  private profileForRoute(route: string): CustomProfile | undefined {
    const section = record(this.ctx.settings.get(PI_AI_NS))
    const providers = record(section?.providers)
    return asCustomProfile(providers?.[route])
  }

  private deepSeekCatalog(): readonly Readonly<Record<string, unknown>>[] {
    const section = record(this.ctx.settings.get(DEEPSEEK_NS))
    const models = section?.models
    if (!Array.isArray(models)) return []
    return models.flatMap((candidate): Array<Readonly<Record<string, unknown>>> => {
      const model = record(candidate)
      return nonEmptyString(model?.id) === undefined ? [] : [{ ...model }]
    })
  }

  private deepSeekConnection(): Pick<CustomProfile, 'apiKeyEnv' | 'baseURL'> {
    const section = record(this.ctx.settings.get(DEEPSEEK_NS))
    return {
      apiKeyEnv: nonEmptyString(section?.apiKeyEnv) ?? String(DEEPSEEK_KEY),
      baseURL: nonEmptyString(section?.baseURL) ?? DEEPSEEK_BASE_URL,
    }
  }

  private dynamicDeepSeekCatalog(
    probed: readonly ProbedModel[],
  ): readonly Readonly<Record<string, unknown>>[] {
    const trusted = new Map(this.deepSeekCatalog().map(model => [String(model.id), model]))
    return probed.map((model) => {
      const existing = trusted.get(model.id)
      return {
        // 同名模型也会更新容量和名称；目录缺省字段不覆盖已确认的能力。
        ...existing,
        ...model,
        inputModalities: existing?.inputModalities ?? ['text'],
      }
    })
  }

  private async commitDeepSeekCatalog(
    models: readonly Readonly<Record<string, unknown>>[],
    connection = { apiKeyEnv: String(DEEPSEEK_KEY), baseURL: DEEPSEEK_BASE_URL },
  ): Promise<void> {
    const descriptor = this.ctx.settings.describe().find(row => row.ns === DEEPSEEK_NS)
    if (descriptor === undefined) throw new Error('DeepSeek 模型设置服务尚未装载')
    await this.commitInternally(() => this.ctx.settings.mutate(DEEPSEEK_NS, [{
      op: 'set', path: ['models'], value: models,
    }, {
      op: 'set', path: ['apiKeyEnv'], value: connection.apiKeyEnv,
    }, {
      op: 'set', path: ['baseURL'], value: connection.baseURL,
    }], descriptor.revision))
  }

  private restoreDeepSeekCatalog(
    models: readonly Readonly<Record<string, unknown>>[],
    connection: Pick<CustomProfile, 'apiKeyEnv' | 'baseURL'>,
  ): Promise<void> {
    return this.commitDeepSeekCatalog(models, connection)
  }

  private async commitCustomProfile(profile: CustomProfile): Promise<void> {
    const descriptor = this.ctx.settings.describe().find(row => row.ns === PI_AI_NS)
    if (descriptor === undefined) throw new Error('自定义模型设置服务尚未装载')
    await this.commitInternally(() => this.ctx.settings.mutate(PI_AI_NS, [{
      op: 'set', path: ['providers', CUSTOM_ROUTE], value: profile,
    }], descriptor.revision))
  }

  private customProfile(): CustomProfile | undefined {
    return this.profileForRoute(CUSTOM_ROUTE)
  }

  private preferredModel(models: readonly ProbedModel[]): string {
    const flash = models.find(model => isDeepSeekV4FlashId(model.id) && !normalizedModelId(model.id).endsWith('-free'))
    if (flash !== undefined) return flash.id
    const freeFlash = models.find(model => normalizedModelId(model.id).endsWith('deepseek-v4-flash-free'))
    if (freeFlash !== undefined) return freeFlash.id
    const pro = models.find(model => model.id === 'deepseek-v4-pro')
    if (pro !== undefined) return pro.id
    const first = models[0]
    if (first === undefined) throw new Error('模型目录没有可用模型')
    return first.id
  }

  /** Confirm that the DeepSeek adapter adopted every authenticated directory row. */
  private async usableOfficialModels(
    probed: readonly ProbedModel[],
  ): Promise<readonly ProbedModel[]> {
    // This is a local adapter/catalog reconciliation, not a completion probe.
    // Refresh uses the provider's /models directory once; selecting a model
    // never enters this service or spends a billable inference request.
    const route = DEEPSEEK_ROUTE
    if (!this.ctx.llm.listProviders().some(entry => entry.id === route)) {
      throw new Error(`模型服务已验证，但客户端没有装载 ${route} 对话适配器`)
    }
    const adapterModels = await this.ctx.llm.listModels(route)
    if (adapterModels.length === 0) {
      throw new Error(`模型服务已验证，但客户端的 ${route} 适配器没有可用模型目录`)
    }
    const supported = new Set(adapterModels.map(model => model.id))
    const usable = probed.filter(model => supported.has(model.id))
    if (usable.length !== probed.length) {
      throw new Error('模型服务已验证，但 DeepSeek 对话适配器未完成目录同步')
    }
    return usable
  }

  /**
   * A managed OpenAI-compatible preset stores the directory returned by its
   * own endpoint.  Keep its adapter catalog honest on refresh instead of
   * presenting a model that the profile cannot dispatch.
   */
  private async usableProfileModels(
    provider: Exclude<GongchuangModelProvider, 'deepseek'>,
    probed: readonly ProbedModel[],
  ): Promise<readonly ProbedModel[]> {
    // Keep the same no-completion-probe invariant for relays and custom APIs.
    const route = routeFor(provider)
    if (!this.ctx.llm.listProviders().some(entry => entry.id === route)) {
      throw new Error(`模型服务已验证，但客户端没有装载 ${route} 对话适配器`)
    }
    const adapterModels = await this.ctx.llm.listModels(route)
    const supported = new Set(adapterModels.map(model => model.id))
    const usable = probed.filter(model => supported.has(model.id))
    if (usable.length !== probed.length) {
      throw new Error('模型服务已验证，但对话适配器未完成目录同步')
    }
    return usable
  }

  private async configureOfficial(
    request: GongchuangOfficialModelConfigureRequest,
  ): Promise<void> {
    const ref = DEEPSEEK_KEY
    const baseURL = DEEPSEEK_BASE_URL
    const key = assertUsableApiKey(request.apiKey ?? '', '@gongchuang/model-connections', ref)
    this.publish(request.provider, {
      phase: 'checking', configured: false, verifiedAt: null,
      modelCount: 0,
      selectedModel: null,
      message: '正在验证 API Key',
    })
    const previousModels = this.deepSeekCatalog()
    const previousConnection = this.deepSeekConnection()
    let previousKey: string | undefined
    let catalogCommitted = false
    let keyCommitted = false
    try {
      // A locked credential store is a settled failure, not an ongoing probe.
      previousKey = (await this.ctx.credentials.resolve(ref))?.value
      const probed = await probeModels(baseURL, key)
      await this.commitDeepSeekCatalog(this.dynamicDeepSeekCatalog(probed))
      catalogCommitted = true
      const models = await this.usableOfficialModels(probed)
      await this.commitInternally(() => this.ctx.credentials.set(ref, key))
      keyCommitted = true
      this.publish(request.provider, {
        phase: 'ready', configured: true, verifiedAt: new Date().toISOString(),
        modelCount: models.length, selectedModel: this.preferredModel(models),
        message: `API Key 已写入系统凭据库，连接验证通过，可用模型 ${String(models.length)} 个`,
      })
    } catch (error) {
      if (keyCommitted) {
        await this.commitInternally(async () => {
          if (previousKey === undefined) await this.ctx.credentials.unset(ref)
          else await this.ctx.credentials.set(ref, previousKey)
        }).catch((rollbackError: unknown) => {
          this.ctx.logger.warn('gongchuang-model-connections: DeepSeek credential rollback failed')
          this.ctx.logger.warn(gongchuangDiagnostic(rollbackError))
        })
      }
      if (catalogCommitted) {
        await this.restoreDeepSeekCatalog(previousModels, previousConnection).catch((rollbackError: unknown) => {
          this.ctx.logger.warn('gongchuang-model-connections: DeepSeek catalog rollback failed')
          this.ctx.logger.warn(gongchuangDiagnostic(rollbackError))
        })
      }
      const configured = (await this.ctx.credentials.describe(ref)).configured
      const presented = this.presentFailure('验证官方模型连接', error)
      this.publish(request.provider, {
        phase: 'error', configured, verifiedAt: null,
        modelCount: 0,
        selectedModel: null,
        message: presented, failureKind: modelDirectoryFailureKind(error),
      })
      throw new Error(presented)
    }
  }

  /** Configure a fixed product preset with a live, endpoint-owned model catalog. */
  private async configureManagedPreset(
    provider: ManagedPresetProvider,
    request: GongchuangOfficialModelConfigureRequest,
  ): Promise<void> {
    const preset = MANAGED_PRESETS[provider]
    const baseURL = configuredBaseURL(preset, request)
    const selectedRequestModel = requestedModelId(request)
    const rawKey = request.apiKey?.trim() ?? ''
    const key = rawKey === '' && preset.definition.authKind === 'optional-key'
      ? LOCAL_NO_AUTH_KEY
      : assertUsableApiKey(rawKey, '@gongchuang/model-connections', preset.credential)
    this.publish(provider, {
      phase: 'checking', configured: false, verifiedAt: null,
      modelCount: 0, selectedModel: null, message: '正在验证 API Key',
    })
    let previousProfile: CustomProfile | undefined
    let previousKey: string | undefined
    let profileCommitted = false
    let keyCommitted = false
    try {
      let models: readonly ProbedModel[]
      let directoryUnsupported = false
      try {
        models = await probeModels(baseURL, key, preset.definition.api)
      } catch (error) {
        if (!(error instanceof UnsupportedModelsEndpointError) || selectedRequestModel === undefined) throw error
        models = [{ id: selectedRequestModel }]
        directoryUnsupported = true
      }
      models = await this.managedDirectoryModels(provider, models)
      if (selectedRequestModel !== undefined && !models.some(model => model.id === selectedRequestModel)) {
        throw new Error(`模型目录中未找到 ${selectedRequestModel}`)
      }
      const selectedId = selectedRequestModel ?? this.preferredModel(models)
      const selected = models.find(model => model.id === selectedId)
      if (selected === undefined) throw new Error(`${preset.displayName} 没有返回可用模型`)
      const orderedModels = [selected, ...models.filter(model => model.id !== selected.id)]
      previousProfile = this.profileForRoute(preset.route)
      previousKey = (await this.ctx.credentials.resolve(preset.credential))?.value
      const descriptor = this.ctx.settings.describe().find(row => row.ns === PI_AI_NS)
      if (descriptor === undefined) throw new Error('模型预设设置服务尚未装载')
      const trustedModels = new Map(previousProfile?.models.map(model => [model.id, model]))
      const profile: CustomProfile = {
        ...provider === 'opencode-zen' ? { catalogProvider: 'opencode' }
          : provider === 'opencode-go' ? { catalogProvider: 'opencode-go' } : {},
        apiKeyEnv: String(preset.credential),
        displayName: preset.displayName,
        api: preset.definition.api,
        baseURL,
        models: orderedModels.map(model => endpointProfileModel(
          model,
          trustedModels.get(model.id),
          provider === 'opencode-go' || provider === 'opencode-zen',
        )),
        ...preset.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: preset.streamIdleTimeoutMs },
      }
      await this.commitInternally(() => this.ctx.credentials.set(preset.credential, key))
      keyCommitted = true
      await this.commitInternally(() => this.ctx.settings.mutate(PI_AI_NS, [{
        op: 'set', path: ['providers', preset.route], value: storedManagedProfile(profile),
      }], descriptor.revision))
      profileCommitted = true
      const usable = await this.usableProfileModels(provider, models)
      this.publish(provider, {
        phase: directoryUnsupported ? 'candidate' : 'ready', configured: true,
        verifiedAt: directoryUnsupported ? null : new Date().toISOString(),
        modelCount: usable.length, selectedModel: selected.id,
        message: directoryUnsupported
          ? `端点不提供模型目录；${selected.id} 已登记为文本模型`
          : `连接验证通过，可用模型 ${String(usable.length)} 个${profile.catalogProvider ? '，仅列出当前底座已适配的模型' : ''}`,
      })
    } catch (error) {
      let rollbackFailed = false
      if (profileCommitted) {
        // 配置回滚失败也必须继续恢复密钥并退出 checking，不能中断其余补偿。
        try {
          await this.restoreManagedProfile(provider, previousProfile)
        } catch (rollbackError) {
          rollbackFailed = true
          this.ctx.logger.warn('gongchuang-model-connections: managed profile rollback failed')
          this.ctx.logger.warn(gongchuangDiagnostic(rollbackError))
        }
      }
      if (keyCommitted) {
        try {
          await this.commitInternally(async () => {
            if (previousKey === undefined) await this.ctx.credentials.unset(preset.credential)
            else await this.ctx.credentials.set(preset.credential, previousKey)
          })
        } catch (rollbackError) {
          rollbackFailed = true
          this.ctx.logger.warn('gongchuang-model-connections: managed credential rollback failed')
          this.ctx.logger.warn(gongchuangDiagnostic(rollbackError))
        }
      }
      const configured = (await this.ctx.credentials.describe(preset.credential)).configured
      const presented = this.presentFailure('验证模型预设连接', error)
        + (rollbackFailed ? '旧配置未完整恢复，请重新配置该模型连接。' : '')
      this.publish(provider, {
        phase: 'error', configured, verifiedAt: null,
        modelCount: 0, selectedModel: null,
        message: presented, failureKind: modelDirectoryFailureKind(error),
      })
      throw new Error(presented)
    }
  }

  private async managedDirectoryModels(provider: ManagedPresetProvider, models: readonly ProbedModel[]): Promise<readonly ProbedModel[]> {
    if (provider !== 'opencode-zen' && provider !== 'opencode-go') return models
    const installed = await this.ctx.llm.discoverModels(PI_AI_NS, { provider: provider === 'opencode-zen' ? 'opencode' : 'opencode-go' })
    const known = new Set(installed.map(model => model.id))
    const supported = models.filter(model => known.has(model.id))
    if (supported.length === 0) throw new Error('模型不可用：OpenCode 返回的模型尚未被当前底座支持，请更新客户端')
    return supported
  }

  private async restoreManagedProfile(provider: ManagedPresetProvider, previous: CustomProfile | undefined): Promise<void> {
    const preset = MANAGED_PRESETS[provider]
    const descriptor = this.ctx.settings.describe().find(row => row.ns === PI_AI_NS)
    if (descriptor === undefined) return
    await this.commitInternally(() => this.ctx.settings.mutate(PI_AI_NS, [previous === undefined
      ? { op: 'unset', path: ['providers', preset.route] }
      : { op: 'set', path: ['providers', preset.route], value: storedManagedProfile(previous) }], descriptor.revision))
  }

  private async configureCustom(request: GongchuangCustomModelConfigureRequest): Promise<void> {
    const displayName = request.displayName.trim()
    if (displayName.length === 0 || displayName.length > 80) throw new Error('自定义 API 名称应为 1 至 80 个字符')
    const baseURL = normalizeBaseURL(request.baseURL)
    const temporaryRef = credentialRef(`${CUSTOM_KEY_PREFIX}${randomBytes(12).toString('hex').toUpperCase()}`)
    const rawKey = request.apiKey?.trim() ?? ''
    const key = rawKey === ''
      ? LOCAL_NO_AUTH_KEY
      : assertUsableApiKey(rawKey, '@gongchuang/model-connections', temporaryRef)
    const requestedModel = request.modelId?.trim()
    if (requestedModel !== undefined && (requestedModel.length === 0 || requestedModel.length > 200)) {
      throw new Error('模型 ID 应为 1 至 200 个字符')
    }
    this.publish('custom', {
      phase: 'checking', configured: false, verifiedAt: null,
      modelCount: 0, selectedModel: requestedModel ?? null, message: '正在验证自定义 API',
    })
    let credentialWritten = false
    let settingsCommitted = false
    let previous: CustomProfile | undefined
    let candidate: CustomProfile | undefined
    try {
      let models: readonly ProbedModel[]
      let directoryUnsupported = false
      try {
        models = await probeModels(baseURL, key, request.protocol)
      } catch (error) {
        if (!(error instanceof UnsupportedModelsEndpointError) || requestedModel === undefined) throw error
        models = [{ id: requestedModel }]
        directoryUnsupported = true
      }
      const selected = requestedModel === undefined
        ? models[0]
        : models.find(model => model.id === requestedModel)
      if (selected === undefined) throw new Error(`模型目录中未找到 ${requestedModel}`)
      previous = this.customProfile()
      const descriptor = this.ctx.settings.describe().find(row => row.ns === PI_AI_NS)
      if (descriptor === undefined) throw new Error('自定义模型设置服务尚未装载')
      await this.commitInternally(() => this.ctx.credentials.set(temporaryRef, key))
      credentialWritten = true
      const profile: CustomProfile = {
        apiKeyEnv: temporaryRef,
        displayName,
        api: request.protocol,
        baseURL,
        models: [selected, ...models.filter(model => model.id !== selected.id)]
          .map(model => endpointProfileModel(model)),
        streamIdleTimeoutMs: 300_000,
      }
      candidate = profile
      await this.commitInternally(() => this.ctx.settings.mutate(PI_AI_NS, [{
        op: 'set', path: ['providers', CUSTOM_ROUTE], value: profile,
      }], descriptor.revision))
      settingsCommitted = true
      await this.usableProfileModels('custom', models)
      const oldRef = previous?.apiKeyEnv
      if (oldRef !== undefined && oldRef !== temporaryRef && oldRef.startsWith(CUSTOM_KEY_PREFIX)) {
        void this.commitInternally(() => this.ctx.credentials.unset(credentialRef(oldRef))).catch((error: unknown) => {
          this.ctx.logger.warn('gongchuang-model-connections: obsolete custom credential cleanup failed')
          this.ctx.logger.warn(gongchuangDiagnostic(error))
        })
      }
      this.publish('custom', {
        phase: directoryUnsupported ? 'candidate' : 'ready', configured: true,
        verifiedAt: directoryUnsupported ? null : new Date().toISOString(),
        modelCount: models.length, selectedModel: selected.id,
        message: directoryUnsupported
          ? `端点不提供模型目录；${selected.id} 已登记为文本模型`
          : `自定义 API 已验证并启用模型 ${selected.id}`,
      })
    } catch (error) {
      let rolledBack = !settingsCommitted
      if (settingsCommitted && candidate !== undefined) {
        rolledBack = await this.rollbackCustomProfile(candidate, previous)
      }
      if (credentialWritten && rolledBack) {
        await this.commitInternally(() => this.ctx.credentials.unset(temporaryRef)).catch(() => {
          // A rolled-back candidate remains unused; cleanup failure must not mask the root error.
        })
      }
      const presented = this.presentFailure('验证自定义模型连接', error)
        + (rolledBack ? '' : '；配置回滚遇到并发修改，候选密钥仍保留在系统凭据库，请重新检查')
      this.publish('custom', {
        phase: 'error', configured: this.customProfile() !== undefined, verifiedAt: null,
        modelCount: 0, selectedModel: requestedModel ?? null,
        message: presented, failureKind: modelDirectoryFailureKind(error),
      })
      throw new Error(presented)
    }
  }

  private async rollbackCustomProfile(candidate: CustomProfile, previous: CustomProfile | undefined): Promise<boolean> {
    const active = this.customProfile()
    if (active === undefined || JSON.stringify(active) !== JSON.stringify(candidate)) return false
    const descriptor = this.ctx.settings.describe().find(row => row.ns === PI_AI_NS)
    if (descriptor === undefined) return false
    try {
      await this.commitInternally(() => this.ctx.settings.mutate(PI_AI_NS, [previous === undefined
        ? { op: 'unset', path: ['providers', CUSTOM_ROUTE] }
        : { op: 'set', path: ['providers', CUSTOM_ROUTE], value: previous }], descriptor.revision))
      return true
    } catch (rollbackError) {
      this.ctx.logger.warn('gongchuang-model-connections: custom provider rollback failed')
      this.ctx.logger.warn(gongchuangDiagnostic(rollbackError))
      return false
    }
  }

  private presentFailure(operation: string, error: unknown): string {
    const presented = gongchuangUserError(error, 'model')
    this.ctx.logger.warn(`[${presented.code}] ${operation}: ${gongchuangDiagnostic(error)}`)
    return presented.text
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gongchuangModelConnections: GongchuangModelConnectionsService
  }
}

export default GongchuangModelConnectionsService
