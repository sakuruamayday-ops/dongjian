import { afterEach, describe, expect, it, vi } from 'vitest'
import { QccOAuthCoordinator } from '../src/qcc-oauth.ts'

const coordinators: QccOAuthCoordinator[] = []

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose()
})

describe('QccOAuthCoordinator', () => {
  it('discards registration that returns after cancellation', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn<typeof fetch>(() => new Promise((resolve) => { finish = resolve }))
    const coordinator = new QccOAuthCoordinator(fetcher)
    coordinators.push(coordinator)
    const controller = new AbortController()
    const starting = coordinator.start('cancel-registration', controller)
    const rejected = expect(starting).rejects.toThrow()
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledOnce() })
    controller.abort(new Error('授权已取消'))
    finish(Response.json({ client_id: 'late-client' }))
    await rejected
    await expect(coordinator.complete('cancel-registration')).rejects.toThrow('不存在')
  })

  it('cancels a waiting callback and discards a late token exchange', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (requestUrl(input).endsWith('/oauth/register')) return Response.json({ client_id: 'client' })
      return await new Promise((resolve) => { finish = resolve })
    })
    const coordinator = new QccOAuthCoordinator(fetcher)
    coordinators.push(coordinator)
    const first = await coordinator.start()
    const waiting = coordinator.complete(first.transactionId)
    const cancelled = expect(waiting).rejects.toThrow('取消')
    coordinator.cancel(first.transactionId)
    await cancelled

    const next = await coordinator.start()
    const completing = coordinator.complete(next.transactionId)
    const rejected = expect(completing).rejects.toThrow('取消')
    const authorization = new URL(next.authorizationUrl)
    const callback = new URL(authorization.searchParams.get('redirect_uri')!)
    callback.searchParams.set('state', authorization.searchParams.get('state')!)
    callback.searchParams.set('code', 'code')
    await (await fetch(callback)).text()
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(3) })
    coordinator.cancel(next.transactionId)
    finish(Response.json({ access_token: 'late-token' }))
    await rejected
  })

  it('uses dynamic registration, PKCE, a state-bound loopback callback, and token exchange', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const remoteFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input)
      calls.push({ url, ...(init === undefined ? {} : { init }) })
      if (url.endsWith('/oauth/register')) {
        return new Response(JSON.stringify({ client_id: 'qcc-public-client' }), {
          status: 201, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: 'oauth-access-token', refresh_token: 'oauth-refresh-token', expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch
    const coordinator = new QccOAuthCoordinator(remoteFetch)
    coordinators.push(coordinator)

    const started = await coordinator.start()
    const authorizationUrl = new URL(started.authorizationUrl)
    expect(authorizationUrl.origin).toBe('https://agent.qcc.com')
    expect(authorizationUrl.pathname).toBe('/oauth/authorize')
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizationUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    const redirectUri = authorizationUrl.searchParams.get('redirect_uri')
    const state = authorizationUrl.searchParams.get('state')
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/qcc\/callback$/u)
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/u)

    const registrationBody = calls[0]?.init?.body
    if (typeof registrationBody !== 'string') throw new Error('expected JSON registration body')
    const registration = JSON.parse(registrationBody) as { redirect_uris: string[] }
    expect(registration.redirect_uris).toEqual([redirectUri])
    const completion = coordinator.complete(started.transactionId)
    const callback = new URL(redirectUri ?? '')
    callback.searchParams.set('state', state ?? '')
    callback.searchParams.set('code', 'authorization-code')
    const callbackResponse = await fetch(callback)
    expect(callbackResponse.status).toBe(200)
    expect(await callbackResponse.text()).toContain('授权已完成')

    const tokens = await completion
    expect(tokens).toMatchObject({
      accessToken: 'oauth-access-token', refreshToken: 'oauth-refresh-token', clientId: 'qcc-public-client',
    })
    expect(tokens.expiresAt).toMatch(/^\d{4}-/u)
    const tokenBody = calls[1]?.init?.body
    expect(tokenBody).toBeInstanceOf(URLSearchParams)
    expect((tokenBody as URLSearchParams).get('code')).toBe('authorization-code')
    expect((tokenBody as URLSearchParams).get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/u)
  })

  it('rejects a mismatched callback state without completing the transaction', async () => {
    const remoteFetch = vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith('/oauth/register')) {
        return new Response(JSON.stringify({ client_id: 'qcc-public-client' }), {
          status: 201, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ access_token: 'token' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const coordinator = new QccOAuthCoordinator(remoteFetch)
    coordinators.push(coordinator)
    const started = await coordinator.start()
    const authorizationUrl = new URL(started.authorizationUrl)
    const redirectUri = new URL(authorizationUrl.searchParams.get('redirect_uri') ?? '')
    redirectUri.searchParams.set('state', 'wrong-state')
    redirectUri.searchParams.set('code', 'wrong-code')
    expect((await fetch(redirectUri)).status).toBe(400)

    redirectUri.searchParams.set('state', authorizationUrl.searchParams.get('state') ?? '')
    redirectUri.searchParams.set('code', 'correct-code')
    const completion = coordinator.complete(started.transactionId)
    expect((await fetch(redirectUri)).status).toBe(200)
    await expect(completion).resolves.toMatchObject({ accessToken: 'token' })
  })

  it('refreshes an expired token without opening another browser flow', async () => {
    const remoteFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(input)).toBe('https://agent.qcc.com/oauth/token')
      const body = init?.body
      expect(body).toBeInstanceOf(URLSearchParams)
      expect((body as URLSearchParams).get('grant_type')).toBe('refresh_token')
      expect((body as URLSearchParams).get('client_id')).toBe('qcc-public-client')
      expect((body as URLSearchParams).get('refresh_token')).toBe('old-refresh-token')
      expect((body as URLSearchParams).get('resource')).toBe('https://agent.qcc.com/mcp/company/stream')
      return new Response(JSON.stringify({
        access_token: 'refreshed-access-token', refresh_token: 'rotated-refresh-token', expires_in: 7200,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const coordinator = new QccOAuthCoordinator(remoteFetch)
    coordinators.push(coordinator)

    await expect(coordinator.refresh('qcc-public-client', 'old-refresh-token')).resolves.toMatchObject({
      accessToken: 'refreshed-access-token',
      refreshToken: 'rotated-refresh-token',
      clientId: 'qcc-public-client',
    })
    expect(remoteFetch).toHaveBeenCalledOnce()
  })
})
