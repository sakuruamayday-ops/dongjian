/** OAuth Device Flow for the official Tianyancha MCP service. */

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const TYC_RESOURCE = 'https://mcp.tianyancha.com/mcp'
const TYC_RESOURCE_METADATA = 'https://mcp.tianyancha.com/.well-known/oauth-protected-resource/mcp'
const TYC_ISSUER = 'https://capi.tianyancha.com/oauth'
const TYC_TOKEN_ENDPOINT = `${TYC_ISSUER}/token`
const TYC_AUTHORIZATION_METADATA = 'https://capi.tianyancha.com/.well-known/oauth-authorization-server/oauth'
const TYC_REDIRECT_URI = `${TYC_ISSUER}/cli/callback`
const TYC_SCOPE = 'mcp:tools.call'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const COMPLETE_POLL_WINDOW_MS = 30_000

interface OAuthEndpoints {
  registrationEndpoint: string
  deviceAuthorizationEndpoint: string
}

interface PendingAuthorization {
  readonly controller: AbortController
  readonly clientId: string
  readonly clientSecret?: string
  readonly deviceCode: string
  readonly expiresAt: number
  readonly intervalMs: number
  readonly timer: ReturnType<typeof setTimeout>
}

/** Public fields needed to complete Tianyancha's browser Device Flow. */
export interface TianyanchaAuthorizationStart {
  readonly transactionId: string
  readonly authorizationUrl: string
  readonly userCode: string
}

/** Host-owned OAuth tokens returned after Tianyancha authorization. */
export interface TianyanchaAuthorizationTokens {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt?: string
  readonly clientId: string
  readonly clientSecret?: string
}

class OAuthEndpointError extends Error {
  constructor(readonly errorCode: string, message: string) {
    super(message)
  }
}

function usableString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}未返回`)
  const normalized = value.trim()
  if (normalized === '' || normalized.length > 8_192 || /[\0\r\n]/u.test(normalized)) {
    throw new Error(`${label}格式无效`)
  }
  return normalized
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : usableString(value, label)
}

async function responseObject(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${label}返回格式无效`, { cause: error })
  }
  if (!response.ok) {
    const payload = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
    const code = typeof payload.error === 'string' ? payload.error : `http_${String(response.status)}`
    const description = typeof payload.error_description === 'string' ? payload.error_description : label
    throw new OAuthEndpointError(code, description)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}返回格式无效`)
  return value as Record<string, unknown>
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Host-owned Tianyancha OAuth coordinator; no token crosses the Remote boundary. */
export class TianyanchaOAuthCoordinator {
  private readonly pending = new Map<string, PendingAuthorization>()

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  /**
   * Discover and start Tianyancha's official Device Flow.
   * @param transactionId - Identity known to the client before discovery begins.
   * @param controller - Host-owned cancellation shared by discovery and exchange.
   * @returns Public browser URL, user code and opaque transaction identity.
   */
  async start(transactionId: string = randomUUID(), controller = new AbortController()): Promise<TianyanchaAuthorizationStart> {
    this.dispose()
    const { signal } = controller
    signal.throwIfAborted()
    const endpoints = await this.discover(signal)
    const registration = await responseObject(await this.fetcher(endpoints.registrationEndpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: '洞见',
        redirect_uris: [TYC_REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token', DEVICE_GRANT],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    }), '天眼查 OAuth 客户端注册')
    signal.throwIfAborted()
    const clientId = usableString(registration.client_id, '天眼查 OAuth client_id')
    const clientSecret = optionalString(registration.client_secret, '天眼查 OAuth client_secret')
    const body = new URLSearchParams({ client_id: clientId, scope: TYC_SCOPE, resource: TYC_RESOURCE })
    if (clientSecret !== undefined) body.set('client_secret', clientSecret)
    const device = await responseObject(await this.fetcher(endpoints.deviceAuthorizationEndpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    }), '天眼查设备授权')
    signal.throwIfAborted()
    const deviceCode = usableString(device.device_code, '天眼查 device_code')
    const userCode = usableString(device.user_code, '天眼查授权码')
    const authorizationUrl = usableString(
      device.verification_uri_complete ?? device.verification_uri,
      '天眼查授权地址',
    )
    const expiresIn = typeof device.expires_in === 'number' && Number.isFinite(device.expires_in) && device.expires_in > 0
      ? device.expires_in
      : 600
    const interval = typeof device.interval === 'number' && Number.isFinite(device.interval) && device.interval > 0
      ? device.interval
      : 5
    const expiresAt = Date.now() + expiresIn * 1_000
    const timer = setTimeout(() => {
      controller.abort(new Error('天眼查授权已过期，请重新发起授权'))
      this.deletePending(transactionId)
    }, expiresIn * 1_000)
    timer.unref()
    this.pending.set(transactionId, {
      controller,
      clientId,
      ...(clientSecret === undefined ? {} : { clientSecret }),
      deviceCode,
      expiresAt,
      intervalMs: interval * 1_000,
      timer,
    })
    return Object.freeze({ transactionId, authorizationUrl, userCode })
  }

  /**
   * Poll briefly after the user confirms browser authorization.
   * @param transactionId - Opaque transaction returned by {@link start}.
   * @returns Host-owned access and refresh token material.
   */
  async complete(transactionId: string): Promise<TianyanchaAuthorizationTokens> {
    const pending = this.pending.get(transactionId)
    if (pending === undefined) throw new Error('天眼查授权事务不存在或已过期，请重新发起授权')
    if (pending.expiresAt <= Date.now()) {
      this.deletePending(transactionId)
      throw new Error('天眼查授权已过期，请重新发起授权')
    }
    const deadline = Math.min(pending.expiresAt, Date.now() + COMPLETE_POLL_WINDOW_MS)
    let intervalMs = pending.intervalMs
    for (;;) {
      pending.controller.signal.throwIfAborted()
      try {
        const tokens = await this.exchange({
          grant_type: DEVICE_GRANT,
          client_id: pending.clientId,
          device_code: pending.deviceCode,
          resource: TYC_RESOURCE,
          ...(pending.clientSecret === undefined ? {} : { client_secret: pending.clientSecret }),
        }, '天眼查 OAuth Token 交换', pending.controller.signal)
        pending.controller.signal.throwIfAborted()
        this.deletePending(transactionId)
        return this.normalizeTokens(tokens, pending.clientId, pending.clientSecret)
      } catch (error) {
        if (!(error instanceof OAuthEndpointError)) throw error
        if (error.errorCode === 'slow_down') intervalMs += 5_000
        else if (error.errorCode !== 'authorization_pending') {
          if (['expired_token', 'access_denied', 'invalid_grant'].includes(error.errorCode)) {
            this.deletePending(transactionId)
          }
          throw error
        }
        if (Date.now() + intervalMs > deadline) {
          throw new Error('天眼查授权尚未完成，请在官方页面确认后重试')
        }
        await delay(intervalMs, undefined, { signal: pending.controller.signal })
      }
    }
  }

  /**
   * Refresh an expired Tianyancha access token.
   * @param clientId - Dynamic OAuth client identity.
   * @param refreshToken - Host-owned refresh token.
   * @param clientSecret - Optional dynamic client secret.
   * @returns Refreshed Host-owned token material.
   */
  async refresh(clientId: string, refreshToken: string, clientSecret?: string): Promise<TianyanchaAuthorizationTokens> {
    const normalizedClientId = usableString(clientId, '天眼查 OAuth client_id')
    const normalizedRefresh = usableString(refreshToken, '天眼查 refresh_token')
    const normalizedSecret = optionalString(clientSecret, '天眼查 OAuth client_secret')
    const tokens = await this.exchange({
      grant_type: 'refresh_token',
      client_id: normalizedClientId,
      refresh_token: normalizedRefresh,
      resource: TYC_RESOURCE,
      ...(normalizedSecret === undefined ? {} : { client_secret: normalizedSecret }),
    }, '天眼查 OAuth Token 续期')
    return this.normalizeTokens(tokens, normalizedClientId, normalizedSecret)
  }

  /** Stop and forget every abandoned authorization transaction. */
  dispose(): void {
    for (const [transactionId, pending] of this.pending) {
      pending.controller.abort(new Error('天眼查授权已取消'))
      this.deletePending(transactionId)
    }
  }

  /** Cancel the selected Device Flow, including an in-flight polling request.
   * @param transactionId - The authorization attempt being closed.
   */
  cancel(transactionId: string): void {
    this.pending.get(transactionId)?.controller.abort(new Error('天眼查授权已取消'))
    this.deletePending(transactionId)
  }

  /** Whether a device authorization can still be completed after a short polling window.
   * @param transactionId - The pending device authorization identity.
   * @returns True while the provider's authorization window is still open.
   */
  hasPending(transactionId: string): boolean {
    const pending = this.pending.get(transactionId)
    return pending !== undefined && !pending.controller.signal.aborted && pending.expiresAt > Date.now()
  }

  private async discover(signal: AbortSignal): Promise<OAuthEndpoints> {
    const resource = await responseObject(await this.fetcher(TYC_RESOURCE_METADATA, {
      headers: { accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    }), '天眼查 OAuth 资源发现')
    if (resource.resource !== TYC_RESOURCE || !stringArray(resource.authorization_servers).includes(TYC_ISSUER)) {
      throw new Error('天眼查 OAuth 资源元数据与官方地址不一致')
    }
    const authorization = await responseObject(await this.fetcher(TYC_AUTHORIZATION_METADATA, {
      headers: { accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    }), '天眼查 OAuth 授权发现')
    if (authorization.issuer !== TYC_ISSUER
      || !stringArray(authorization.grant_types_supported).includes(DEVICE_GRANT)
      || !stringArray(authorization.scopes_supported).includes(TYC_SCOPE)) {
      throw new Error('天眼查 OAuth 授权元数据与官方契约不一致')
    }
    // 交换和续期绑定固定官方端点，不能接受一个后续请求不会使用的发现地址。
    if (usableString(authorization.token_endpoint, '天眼查 token_endpoint') !== TYC_TOKEN_ENDPOINT) {
      throw new Error('天眼查 OAuth Token 地址与固定官方地址不一致，请更新客户端后重试')
    }
    return {
      registrationEndpoint: usableString(authorization.registration_endpoint, '天眼查 registration_endpoint'),
      deviceAuthorizationEndpoint: usableString(
        authorization.device_authorization_endpoint,
        '天眼查 device_authorization_endpoint',
      ),
    }
  }

  private async exchange(fields: Record<string, string>, label: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await responseObject(await this.fetcher(TYC_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
      signal: signal === undefined ? AbortSignal.timeout(30_000) : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    }), label)
  }

  private normalizeTokens(
    tokens: Record<string, unknown>,
    clientId: string,
    clientSecret?: string,
  ): TianyanchaAuthorizationTokens {
    const accessToken = usableString(tokens.access_token, '天眼查 access_token')
    const refreshToken = optionalString(tokens.refresh_token, '天眼查 refresh_token')
    const expiresIn = typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0
      ? tokens.expires_in
      : undefined
    return Object.freeze({
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString() }),
      clientId,
      ...(clientSecret === undefined ? {} : { clientSecret }),
    })
  }

  private deletePending(transactionId: string): void {
    const pending = this.pending.get(transactionId)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pending.delete(transactionId)
  }
}
