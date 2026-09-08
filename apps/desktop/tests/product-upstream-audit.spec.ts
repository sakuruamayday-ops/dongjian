import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  compareProductUpstream,
  githubJson,
  resolveProductUpstreamGitHubToken,
} from '../src/product-upstream-audit.ts'

const manifest = JSON.parse(readFileSync(resolve(
  import.meta.dirname,
  '../../../product/gongchuang-client/upstream-products.json',
), 'utf8')) as {
  upstreams: Array<{
    adoptedCommit: string
    id: string
    ref: string
    relationship: string
    releasePolicy: 'must-match' | 'report-change'
    repository: string
    reviewedCommit: string
    tracking: 'branch' | 'release'
  }>
}

describe('product upstream release audit', () => {
  it('prefers explicit credentials and falls back to the authenticated GitHub CLI', () => {
    expect(resolveProductUpstreamGitHubToken(
      { GITHUB_TOKEN: ' github-token ', GH_TOKEN: 'gh-token' },
      () => { throw new Error('must not read gh auth') },
    )).toBe('github-token')
    expect(resolveProductUpstreamGitHubToken(
      { GH_TOKEN: ' gh-token ' },
      () => { throw new Error('must not read gh auth') },
    )).toBe('gh-token')
    expect(resolveProductUpstreamGitHubToken({}, () => ' cli-token\n')).toBe('cli-token')
  })

  it('uses the anonymous allowance when GitHub CLI authentication is unavailable', () => {
    expect(resolveProductUpstreamGitHubToken({}, () => { throw new Error('not logged in') })).toBeUndefined()
    expect(resolveProductUpstreamGitHubToken({}, () => '   ')).toBeUndefined()
  })

  it('retries a transient GitHub transport failure only within the fixed attempt budget', async () => {
    const fetchImpl = vi.fn<Parameters<typeof githubJson>[2]>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'a'.repeat(40) }), { status: 200 }))
    const delays: number[] = []
    await expect(githubJson<{ sha: string }>(
      '/repos/example/project/commits/main',
      undefined,
      fetchImpl,
      (delayMs) => { delays.push(delayMs); return Promise.resolve() },
    )).resolves.toEqual({ sha: 'a'.repeat(40) })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(delays).toEqual([250])
  })

  it('does not retry a permanent GitHub response failure', async () => {
    const fetchImpl = vi.fn<Parameters<typeof githubJson>[2]>()
      .mockResolvedValue(new Response('{}', { status: 404 }))
    await expect(githubJson(
      '/repos/example/missing/releases',
      undefined,
      fetchImpl,
      () => Promise.resolve(),
    )).rejects.toThrow(/HTTP 404/u)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('tracks the product-level GitHub sources separately from transitive packages', () => {
    expect(manifest.upstreams.map(upstream => upstream.id)).toEqual([
      'deepseek-harness',
      'dsh-routing-suite',
      'hermes-agent',
      'mattpocock-skills',
      'ponytail',
      'opencode',
      'open-webui',
    ])
    expect(manifest.upstreams.find(upstream => upstream.id === 'hermes-agent')?.relationship)
      .toBe('design-reference')
    expect(manifest.upstreams.find(upstream => upstream.id === 'ponytail')?.relationship)
      .toBe('adapted-principle-not-packaged')
    expect(manifest.upstreams.find(upstream => upstream.id === 'open-webui')?.relationship)
      .toBe('design-reference-not-packaged')
    expect(manifest.upstreams.filter(upstream => upstream.releasePolicy === 'must-match').map(upstream => upstream.id))
      .toEqual(['deepseek-harness', 'dsh-routing-suite'])
  })

  it('passes only the exact reviewed ref and commit', () => {
    const upstream = manifest.upstreams[0]
    expect(compareProductUpstream(upstream, {
      ref: upstream.ref,
      commit: upstream.reviewedCommit,
    }).current).toBe(true)
    expect(compareProductUpstream(upstream, {
      ref: upstream.ref,
      commit: '0'.repeat(40),
    })).toMatchObject({ current: false, blocking: true })
    expect(compareProductUpstream(upstream, {
      ref: 'new-release',
      commit: upstream.reviewedCommit,
    })).toMatchObject({ current: false, blocking: true })
  })

  it('reports reference drift without treating unshipped reference code as a release mismatch', () => {
    const upstream = manifest.upstreams.find(candidate => candidate.id === 'hermes-agent')!
    expect(compareProductUpstream(upstream, {
      ref: upstream.ref,
      commit: '0'.repeat(40),
    })).toMatchObject({ current: false, blocking: false })
  })

  it('is invoked by every supported desktop packaging preflight', () => {
    const desktop = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(desktop.scripts['verify:upstreams']).toBe('tsx scripts/audit-product-upstreams.ts')
    for (const command of ['verify:inputs:mac', 'verify:inputs:mac-intel', 'verify:inputs:win']) {
      expect(desktop.scripts[command]).toMatch(/^pnpm run verify:upstreams && /u)
    }
  })
})
