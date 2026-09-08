/** OAuth 2.1 + PKCE authorization for the official QCC MCP service. */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'

const QCC_ORIGIN = 'https://agent.qcc.com'
const QCC_REGISTER_URL = `${QCC_ORIGIN}/oauth/register`
const QCC_AUTHORIZE_URL = `${QCC_ORIGIN}/oauth/authorize`
const QCC_TOKEN_URL = `${QCC_ORIGIN}/oauth/token`
const QCC_RESOURCE = `${QCC_ORIGIN}/mcp/company/stream`
const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1_000

/**
 * Data contract for qcc authorization start.
 */
export interface QccAuthorizationStart {
  readonly transactionId: string
  readonly authorizationUrl: string
}

/**
 * Data contract for qcc authorization tokens.
 */
export interface QccAuthorizationTokens {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt?: string
  readonly clientId: string
}

interface PendingAuthorization {
  readonly controller: AbortController
  readonly server: Server
  readonly redirectUri: string
  readonly clientId: string
  readonly codeVerifier: string
  readonly code: Promise<string>
  readonly cancel: (reason: Error) => void
  readonly close: () => void
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function usableToken(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}未返回`)
  const normalized = value.trim()
  if (normalized === '' || normalized.length > 8_192 || /[\0\r\n]/u.test(normalized)) {
    throw new Error(`${label}格式无效`)
  }
  return normalized
}

async function responseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/gu, ' ').trim().slice(0, 500)
    throw new Error(`${label}失败：HTTP ${String(response.status)}${detail === '' ? '' : `；${detail}`}`)
  }
  const value = await response.json() as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}返回格式无效`)
  return value as Record<string, unknown>
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => { reject(error) }
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('企查查授权回调端口创建失败'))
        return
      }
      resolve(address.port)
    })
  })
}

/** Owns short-lived loopback callbacks and never exposes OAuth tokens to the renderer. */
export class QccOAuthCoordinator {
  private readonly pending = new Map<string, PendingAuthorization>()

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  /** Prepare dynamic registration and return the public authorization URL.
   * @param transactionId - Identity known to the client before registration begins.
   * @param controller - Host-owned cancellation shared by the callback and exchange.
   * @returns The start result.
   */
  async start(transactionId: string = randomUUID(), controller = new AbortController()): Promise<QccAuthorizationStart> {
    const { signal } = controller
    signal.throwIfAborted()
    const state = base64url(randomBytes(24))
    const codeVerifier = base64url(randomBytes(48))
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    let resolveCode: (code: string) => void = () => undefined
    let rejectCode: (reason: Error) => void = () => undefined
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve
      rejectCode = reject
    })
    // Cancellation can precede complete(); the rejection must already have an owner.
    void code.catch(() => undefined)
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method !== 'GET' || url.pathname !== '/oauth/qcc/callback') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Not Found')
        return
      }
      if (url.searchParams.get('state') !== state) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('授权状态校验失败，请返回客户端重试。')
        return
      }
      const oauthError = url.searchParams.get('error')
      const authorizationCode = url.searchParams.get('code')
      response.writeHead(oauthError === null && authorizationCode !== null ? 200 : 400, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      if (oauthError !== null) {
        response.end('<!doctype html><meta charset="utf-8"><title>授权未完成</title><p>企查查授权未完成，可以关闭此页面并返回客户端重试。</p>')
        rejectCode(new Error(`企查查授权未完成：${oauthError}`))
        return
      }
      if (authorizationCode === null || authorizationCode === '') {
        response.end('<!doctype html><meta charset="utf-8"><title>授权失败</title><p>没有收到授权码，可以关闭此页面并返回客户端重试。</p>')
        rejectCode(new Error('企查查授权回调没有返回授权码'))
        return
      }
      response.end('<!doctype html><meta charset="utf-8"><title>授权成功</title><p>企查查授权已完成，可以关闭此页面并返回洞见。</p>')
      resolveCode(authorizationCode)
    })
    const abort = () => {
      rejectCode(new Error('企查查授权已取消'))
      server.close()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const port = await listen(server)
      signal.throwIfAborted()
      const redirectUri = `http://127.0.0.1:${String(port)}/oauth/qcc/callback`
      const registration = await responseJson(await this.fetcher(QCC_REGISTER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: '洞见',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: 'mcp:tools',
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      }), '企查查 OAuth 客户端注册')
      signal.throwIfAborted()
      const clientId = usableToken(registration.client_id, '企查查 OAuth client_id')
      const authorizationUrl = new URL(QCC_AUTHORIZE_URL)
      authorizationUrl.searchParams.set('response_type', 'code')
      authorizationUrl.searchParams.set('client_id', clientId)
      authorizationUrl.searchParams.set('redirect_uri', redirectUri)
      authorizationUrl.searchParams.set('scope', 'mcp:tools')
      authorizationUrl.searchParams.set('state', state)
      authorizationUrl.searchParams.set('code_challenge', codeChallenge)
      authorizationUrl.searchParams.set('code_challenge_method', 'S256')
      authorizationUrl.searchParams.set('resource', QCC_RESOURCE)
      const timeout = setTimeout(() => {
        controller.abort(new Error('企查查登录授权等待超时，请重新发起授权'))
        this.pending.delete(transactionId)
      }, AUTHORIZATION_TIMEOUT_MS)
      timeout.unref()
      const cancel = (reason: Error) => {
        controller.abort(reason)
        close()
      }
      const close = () => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        server.close()
      }
      void code.finally(() => { clearTimeout(timeout) }).catch(() => undefined)
      this.pending.set(transactionId, { controller, server, redirectUri, clientId, codeVerifier, code, cancel, close })
      return Object.freeze({ transactionId, authorizationUrl: authorizationUrl.href })
    } catch (error) {
      signal.removeEventListener('abort', abort)
      server.close()
      throw error
    }
  }

  /** Await the loopback code and exchange it without exposing tokens to the renderer.
   * @param transactionId - The transaction id value.
   * @returns The complete result.
   */
  async complete(transactionId: string): Promise<QccAuthorizationTokens> {
    const pending = this.pending.get(transactionId)
    if (pending === undefined) throw new Error('企查查授权事务不存在或已过期，请重新发起授权')
    try {
      const authorizationCode = await pending.code
      pending.controller.signal.throwIfAborted()
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        code_verifier: pending.codeVerifier,
        resource: QCC_RESOURCE,
      })
      const tokens = await responseJson(await this.fetcher(QCC_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
        signal: AbortSignal.any([pending.controller.signal, AbortSignal.timeout(30_000)]),
      }), '企查查 OAuth Token 交换')
      pending.controller.signal.throwIfAborted()
      return this.normalizeTokens(tokens, pending.clientId)
    } finally {
      this.pending.delete(transactionId)
      pending.close()
    }
  }

  /** Refresh an expired access token without involving the renderer or reopening a browser.
   * @param clientId - The client id value.
   * @param refreshToken - The refresh token value.
   * @returns The refresh result.
   */
  async refresh(clientId: string, refreshToken: string): Promise<QccAuthorizationTokens> {
    const normalizedClientId = usableToken(clientId, '企查查 OAuth client_id')
    const normalizedRefreshToken = usableToken(refreshToken, '企查查 refresh_token')
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: normalizedRefreshToken,
      client_id: normalizedClientId,
      resource: QCC_RESOURCE,
    })
    const tokens = await responseJson(await this.fetcher(QCC_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    }), '企查查 OAuth Token 续期')
    return this.normalizeTokens(tokens, normalizedClientId)
  }

  private normalizeTokens(tokens: Record<string, unknown>, clientId: string): QccAuthorizationTokens {
    const accessToken = usableToken(tokens.access_token, '企查查 access_token')
    const refreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim() !== ''
      ? usableToken(tokens.refresh_token, '企查查 refresh_token')
      : undefined
    const expiresIn = typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0
      ? tokens.expires_in
      : undefined
    return Object.freeze({
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString() }),
      clientId,
    })
  }

  /** Stop every abandoned callback server during Host teardown. */
  dispose(): void {
    for (const pending of this.pending.values()) pending.cancel(new Error('客户端已关闭，企查查授权已取消'))
    this.pending.clear()
  }

  /** Cancel one callback or token exchange without changing stored credentials.
   * @param transactionId - The authorization attempt being closed.
   */
  cancel(transactionId: string): void {
    this.pending.get(transactionId)?.cancel(new Error('企查查授权已取消'))
    this.pending.delete(transactionId)
  }
}
