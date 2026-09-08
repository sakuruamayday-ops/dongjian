import type { request as httpsRequest } from 'node:https'
import { describe, expect, it, vi } from 'vitest'
import { fetchPinnedRepositoryBytes } from '../src/repository-https.ts'
import {
  assertPublicRepositoryAddresses,
  isPublicRepositoryAddress,
  resolvePublicRepositoryAddresses,
} from '../src/repository-network-policy.ts'

describe('third-party repository network boundary', () => {
  it('rejects local, private, documentation, and synthetic proxy ranges', () => {
    for (const address of [
      '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1',
      '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', 'fc00::1', '2001:db8::1',
    ]) expect(isPublicRepositoryAddress(address)).toBe(false)
    expect(isPublicRepositoryAddress('93.184.216.34')).toBe(true)
    expect(isPublicRepositoryAddress('2606:4700:4700::1111')).toBe(true)
  })

  it('rejects the complete DNS answer set when even one answer is private', () => {
    expect(() => assertPublicRepositoryAddresses('mixed.example', [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])).toThrow(/解析到本机或内网/u)
  })

  it('rejects a loopback literal without calling DNS', async () => {
    const lookup = vi.fn()
    await expect(resolvePublicRepositoryAddresses('127.0.0.1', { lookup }))
      .rejects.toThrow(/解析到本机或内网/u)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('stops before opening HTTPS when public-only DNS validation fails', async () => {
    const request = vi.fn()
    await expect(fetchPinnedRepositoryBytes(
      new URL('https://rebound.example/gongchuang-skills.json'),
      { Accept: 'application/json' },
      512 * 1024,
      '仓库清单',
      {
        resolve: async () => { throw new Error('仓库地址 rebound.example 解析到本机或内网，已阻止连接') },
        request: request as unknown as typeof httpsRequest,
      },
    )).rejects.toThrow(/解析到本机或内网/u)
    expect(request).not.toHaveBeenCalled()
  })
})
