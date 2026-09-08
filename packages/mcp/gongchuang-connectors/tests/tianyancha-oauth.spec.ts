import { describe, expect, it, vi } from 'vitest'
import { TianyanchaOAuthCoordinator } from '../src/tianyancha-oauth.ts'

const RESOURCE_METADATA = 'https://mcp.tianyancha.com/.well-known/oauth-protected-resource/mcp'
const AUTHORIZATION_METADATA = 'https://capi.tianyancha.com/.well-known/oauth-authorization-server/oauth'
const REGISTER = 'https://capi.tianyancha.com/oauth/register'
const DEVICE = 'https://capi.tianyancha.com/oauth/device_authorization'
const TOKEN = 'https://capi.tianyancha.com/oauth/token'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function bodyOf(init?: RequestInit): string {
  if (typeof init?.body === 'string') return init.body
  if (init?.body instanceof URLSearchParams) return init.body.toString()
  throw new Error('unexpected Tianyancha OAuth request body type')
}

function officialMetadata(url: string): Response | undefined {
  if (url === RESOURCE_METADATA) {
    return json({
      resource: 'https://mcp.tianyancha.com/mcp',
      authorization_servers: ['https://capi.tianyancha.com/oauth'],
      scopes_supported: ['mcp:tools.call', 'mcp:quota.read'],
    })
  }
  if (url === AUTHORIZATION_METADATA) {
    return json({
      issuer: 'https://capi.tianyancha.com/oauth',
      registration_endpoint: REGISTER,
      device_authorization_endpoint: DEVICE,
      token_endpoint: TOKEN,
      grant_types_supported: ['refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
      scopes_supported: ['mcp:tools.call'],
    })
  }
  return undefined
}

describe('TianyanchaOAuthCoordinator', () => {
  it.each(['pending', 'late-token'] as const)('cancels %s without polling again or accepting late tokens', async (mode) => {
    let finish!: (response: Response) => void
    let exchanges = 0
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input)
      const metadata = officialMetadata(url)
      if (metadata !== undefined) return metadata
      if (url === REGISTER) return json({ client_id: 'client' })
      if (url === DEVICE) return json({ device_code: 'device', user_code: '123', verification_uri: 'https://capi.tianyancha.com/oauth/device', interval: 5, expires_in: 600 })
      exchanges += 1
      if (mode === 'pending') return json({ error: 'authorization_pending' }, 400)
      return await new Promise((resolve) => { finish = resolve })
    })
    const coordinator = new TianyanchaOAuthCoordinator(fetcher)
    try {
      const started = await coordinator.start()
      const completing = coordinator.complete(started.transactionId)
      const rejected = expect(completing).rejects.toThrow()
      await vi.waitFor(() => { expect(exchanges).toBe(1) })
      coordinator.cancel(started.transactionId)
      if (mode === 'late-token') finish(json({ access_token: 'late-token' }))
      await rejected
      expect(exchanges).toBe(1)
      await expect(coordinator.complete(started.transactionId)).rejects.toThrow('不存在')
    } finally {
      coordinator.dispose()
    }
  })

  it('discovers official metadata, starts Device Flow, and never exposes token material', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      const metadata = officialMetadata(url)
      if (metadata !== undefined) return metadata
      if (url === REGISTER) {
        expect(JSON.parse(bodyOf(init))).toMatchObject({
          client_name: '洞见',
          token_endpoint_auth_method: 'none',
        })
        return json({ client_id: 'registered-client', client_secret: 'host-client-secret' })
      }
      if (url === DEVICE) {
        expect(bodyOf(init)).toContain('scope=mcp%3Atools.call')
        expect(bodyOf(init)).toContain('client_secret=host-client-secret')
        return json({
          device_code: 'host-device-code', user_code: '123456',
          verification_uri: 'https://capi.tianyancha.com/oauth/device', expires_in: 600, interval: 5,
        })
      }
      if (url === TOKEN) {
        expect(bodyOf(init)).toContain('device_code=host-device-code')
        return json({ access_token: 'host-access-token', refresh_token: 'host-refresh-token', expires_in: 3600 })
      }
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch
    const coordinator = new TianyanchaOAuthCoordinator(fetcher)

    const started = await coordinator.start()
    expect(started).toMatchObject({
      authorizationUrl: 'https://capi.tianyancha.com/oauth/device', userCode: '123456',
    })
    expect(started.transactionId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(JSON.stringify(started)).not.toMatch(/host-device-code|host-client-secret|host-access-token/u)

    const tokens = await coordinator.complete(started.transactionId)
    expect(tokens).toMatchObject({
      accessToken: 'host-access-token', refreshToken: 'host-refresh-token',
      clientId: 'registered-client', clientSecret: 'host-client-secret',
    })
    coordinator.dispose()
  })

  it('refreshes with the stored dynamic client without exposing it to the renderer', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(urlOf(input)).toBe(TOKEN)
      expect(bodyOf(init)).toContain('grant_type=refresh_token')
      expect(bodyOf(init)).toContain('refresh_token=old-refresh')
      return json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 1800 })
    }) as typeof fetch
    const coordinator = new TianyanchaOAuthCoordinator(fetcher)

    await expect(coordinator.refresh('client-id', 'old-refresh', 'client-secret')).resolves.toMatchObject({
      accessToken: 'new-access', refreshToken: 'new-refresh', clientId: 'client-id', clientSecret: 'client-secret',
    })
  })

  it('replaces an abandoned Device Flow when authorization is started again', async () => {
    let deviceSequence = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      const metadata = officialMetadata(url)
      if (metadata !== undefined) return metadata
      if (url === REGISTER) return json({ client_id: 'registered-client' })
      if (url === DEVICE) {
        deviceSequence += 1
        return json({
          device_code: `device-${String(deviceSequence)}`,
          user_code: `code-${String(deviceSequence)}`,
          verification_uri: 'https://capi.tianyancha.com/oauth/device',
          expires_in: 600,
          interval: 5,
        })
      }
      if (url === TOKEN) return json({ access_token: 'latest-access-token' })
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch
    const coordinator = new TianyanchaOAuthCoordinator(fetcher)

    const abandoned = await coordinator.start()
    const current = await coordinator.start()

    await expect(coordinator.complete(abandoned.transactionId)).rejects.toThrow('不存在或已过期')
    await expect(coordinator.complete(current.transactionId)).resolves.toMatchObject({
      accessToken: 'latest-access-token',
    })
  })

  it('fails closed when discovery points away from the fixed official resource', async () => {
    const fetcher = vi.fn(async () => json({
      resource: 'https://attacker.example/mcp',
      authorization_servers: ['https://attacker.example/oauth'],
    })) as typeof fetch
    const coordinator = new TianyanchaOAuthCoordinator(fetcher)

    await expect(coordinator.start()).rejects.toThrow('资源元数据与官方地址不一致')
  })

  it.each([
    'https://capi.tianyancha.com/oauth/token-v2',
    'https://untrusted.example/token',
  ])('rejects an unsupported token endpoint before starting authorization: %s', async (tokenEndpoint) => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      const metadata = officialMetadata(url)
      if (metadata === undefined) throw new Error('authorization must stop before registration')
      if (url !== AUTHORIZATION_METADATA) return metadata
      const body: unknown = await metadata.json()
      if (typeof body !== 'object' || body === null) throw new Error('invalid test metadata')
      return json({ ...body, token_endpoint: tokenEndpoint })
    })
    const coordinator = new TianyanchaOAuthCoordinator(fetcher)

    await expect(coordinator.start()).rejects.toThrow('Token 地址与固定官方地址不一致')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
