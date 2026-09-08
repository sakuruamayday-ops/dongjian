import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GongchuangSkillMarketplaceService, { featuredEntriesForEpochDay } from '../src/index.ts'

const repositoryTransportMocks = vi.hoisted(() => ({
  fetchPinnedRepositoryBytes: vi.fn(async (
    input: URL, headers: Readonly<Record<string, string>>, maxBytes: number, label: string,
  ) => {
    const response = await globalThis.fetch(input, { method: 'GET', headers, redirect: 'manual' })
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new Error(`${label}超过大小上限`)
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      bytes,
    }
  }),
}))

vi.mock('../src/repository-https.ts', () => repositoryTransportMocks)

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function skillSource(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} test skill\n---\n\nFollow the verified test instructions.`
}

async function boot(): Promise<{
  ctx: Context
  service: GongchuangSkillMarketplaceService
  marketplaceRoot: string
  dispose: () => Promise<void>
}> {
  const base = await mkdtemp(join(tmpdir(), 'gongchuang-skill-marketplace-'))
  const bundle = join(base, 'bundle')
  const bundledSkills = join(bundle, 'skills')
  await mkdir(join(bundledSkills, 'bundled-one'), { recursive: true })
  const bundledSource = skillSource('bundled-one')
  const bundledAgent = 'interface:\n  display_name: "内置测试技能"\n  short_description: "内置技能的中文说明"\n'
  const bundledLicense = 'MIT License\n\nCopyright (c) Test\n'
  await writeFile(join(bundledSkills, 'bundled-one', 'SKILL.md'), bundledSource)
  await mkdir(join(bundledSkills, 'bundled-one', 'agents'), { recursive: true })
  await writeFile(join(bundledSkills, 'bundled-one', 'agents', 'openai.yaml'), bundledAgent)
  await writeFile(join(bundledSkills, 'bundled-one', 'LICENSE-MIT.txt'), bundledLicense)
  await writeFile(join(bundle, 'skill-bundle-index.json'), JSON.stringify({
    skillBundleVersion: '1.6.7', skills: ['bundled-one'],
    files: {
      'bundled-one/SKILL.md': sha256(bundledSource),
      'bundled-one/agents/openai.yaml': sha256(bundledAgent),
      'bundled-one/LICENSE-MIT.txt': sha256(bundledLicense),
    },
  }))
  const marketplaceRoot = join(base, 'marketplace')
  process.env.GONGCHUANG_BUNDLED_SKILL_DIR = bundledSkills
  process.env.GONGCHUANG_SKILL_MARKETPLACE_DIR = marketplaceRoot
  const ctx = new Context()
  const fibers: Fiber[] = []
  fibers.push(await ctx.plugin(SkillRegistry))
  fibers.push(await ctx.plugin(GongchuangSkillMarketplaceService))
  const service = ctx.get('gongchuangSkillMarketplace')
  if (service === undefined) throw new Error('marketplace service did not mount')
  return {
    ctx, service, marketplaceRoot,
    dispose: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  repositoryTransportMocks.fetchPinnedRepositoryBytes.mockClear()
  delete process.env.GONGCHUANG_BUNDLED_SKILL_DIR
  delete process.env.GONGCHUANG_SKILL_MARKETPLACE_DIR
})

describe('GongchuangSkillMarketplaceService', () => {
  it('keeps core business picks while rotating the reviewed recommendation window', () => {
    const first = featuredEntriesForEpochDay(100)
    const next = featuredEntriesForEpochDay(101)
    expect(first).toHaveLength(14)
    expect(first.slice(0, 8)).toEqual(next.slice(0, 8))
    expect(first.slice(8)).not.toEqual(next.slice(8))
    expect(first.map(row => row.coordinate)).toContain('hu1230/cn-policy-search')
    expect(first.map(row => row.coordinate)).toContain('WEIAIb/ocr-finance-skill')
  })

  it('aggregates featured catalog failures without reporting every entry as a core skill warning', async () => {
    const { ctx, service, dispose } = await boot()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => ctx.logger)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('synthetic catalog outage') }))
    try {
      await expect(service.snapshot()).resolves.toMatchObject({ featured: [] })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('code=GC-SKILL-FEATURED-UNAVAILABLE'))
      expect(info).not.toHaveBeenCalledWith(expect.stringContaining('GC-SKILL-FEATURED-PARTIAL'))
    } finally {
      await dispose()
    }
  })

  it('exports catalog, search, and verified install Remote methods', async () => {
    const { service, dispose } = await boot()
    expect(service.typertRemote.namespace).toBe('gongchuangSkillMarketplace')
    expect(remoteMethods(service).map(method => method.exportName ?? method.method).sort()).toEqual([
      'addRepository', 'installSkill', 'removeRepository', 'removeSkill', 'search', 'setSkillEnabled', 'snapshot',
    ])
    await dispose()
  })

  it('projects live ModelScope and SkillHub search responses into the client catalog', async () => {
    const { service, dispose } = await boot()
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('modelscope.cn/openapi/v1/skills?')) {
        return Response.json({ data: { total: 1, skills: [{
          id: '@anthropics/docx', display_name: 'DOCX 文档', description: '创建和编辑 Word 文档',
          category: 'office', license: 'Apache-2.0', downloads: 7000, developer: 'anthropics',
        }] } })
      }
      if (url.includes('api.skillhub.cn/api/skills?')) {
        return Response.json({ code: 0, data: { total: 1, skills: [{
          slug: 'tencent-docs', displayName: '腾讯文档', summary_zh: '管理企业在线文档',
          category: 'office', version: '1.0.41', stats: { downloads: 230000 }, source: 'enterprise',
          labels: { requires_api_key: 'true' },
          namespace: { handle: 'tencent-adm', canonicalName: '@tencent-adm/tencent-docs' },
        }] } })
      }
      throw new Error(`unexpected URL ${url}`)
    }))
    await expect(service.search({ source: 'modelscope', query: 'docx', page: 1, pageSize: 18 }))
      .resolves.toMatchObject({ total: 1, skills: [{ coordinate: '@anthropics/docx', publisherVerified: true }] })
    await expect(service.search({ source: 'skillhub', query: '文档', page: 1, pageSize: 18 }))
      .resolves.toMatchObject({ total: 1, skills: [{
        coordinate: '@tencent-adm/tencent-docs', name: '腾讯文档', description: '管理企业在线文档',
        downloads: 230000, publisherVerified: true, requiresConfiguration: true,
      }] })
    const skillHubResult = await service.search({ source: 'skillhub', query: '文档', page: 1, pageSize: 18 })
    expect(skillHubResult.skills[0]?.configurationUrl).toBeUndefined()
    await dispose()
  })

  it('opens only a reviewed vendor configuration URL instead of relabeling a community detail page', async () => {
    const { service, dispose } = await boot()
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('api.skillhub.cn/api/skills?')) return Response.json({ code: 0, data: {
        total: 1,
        skills: [{
          slug: 'patseek-patent-search', displayName: 'PatSeek', summary_zh: '专利检索',
          category: 'professional', version: '1.8.1', isServiceized: true,
          namespace: { handle: 'user_0b65fce7', canonicalName: '@user_0b65fce7/patseek-patent-search' },
        }],
      } })
      throw new Error(`unexpected URL ${url}`)
    }))

    await expect(service.search({ source: 'skillhub', query: 'PatSeek', page: 1, pageSize: 18 }))
      .resolves.toMatchObject({ skills: [{
        coordinate: '@user_0b65fce7/patseek-patent-search',
        requiresConfiguration: true,
        configurationUrl: 'https://patseek.cn/',
        detailUrl: 'https://skillhub.cn/skills/user_0b65fce7/patseek-patent-search',
      }] })
    await dispose()
  })

  it('migrates a persisted SkillHub detail-page configuration URL to the reviewed vendor page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
    const { service, marketplaceRoot, dispose } = await boot()
    try {
      const staleDirectory = join(marketplaceRoot, 'installed', 'skillhub-patseek-stale')
      const source = skillSource('patseek-patent-search')
      await mkdir(staleDirectory, { recursive: true })
      await writeFile(join(staleDirectory, 'SKILL.md'), source)
      await writeFile(join(marketplaceRoot, 'registry.json'), JSON.stringify({
        schemaVersion: 1,
        installed: [{
          id: 'skillhub-patseek-stale', name: 'patseek-patent-search', description: 'Patent search.',
          source: 'skillhub', coordinate: '@user_0b65fce7/patseek-patent-search', version: '1.0.0',
          digest: 'a'.repeat(64), installedAt: '2026-08-15T00:00:00.000Z', bundled: false,
          integrity: 'pinned-digest', directory: staleDirectory,
          files: { 'SKILL.md': sha256(source) },
          detailUrl: 'https://skillhub.cn/skills/user_0b65fce7/patseek-patent-search',
          configurationUrl: 'https://skillhub.cn/skills/user_0b65fce7/patseek-patent-search',
          requiresConfiguration: true,
          metadata: {
            upstream: 'https://skillhub.cn/skills/user_0b65fce7/patseek-patent-search',
            configurationUrl: 'https://skillhub.cn/skills/user_0b65fce7/patseek-patent-search',
            requiresConfiguration: true,
          },
        }],
        repositories: [],
      }))

      const snapshot = await service.snapshot()
      expect(fetch).toHaveBeenCalledTimes(14)
      expect(snapshot.installed.find(row => row.coordinate === '@user_0b65fce7/patseek-patent-search')).toMatchObject({
        coordinate: '@user_0b65fce7/patseek-patent-search',
        category: '其他',
        enabled: true,
        configurationUrl: 'https://patseek.cn/',
        detailUrl: 'https://skillhub.cn/skills/user_0b65fce7/patseek-patent-search',
      })
      await service.setEnabled({ id: 'skillhub-patseek-stale', enabled: false })
      const migrated = JSON.parse(await readFile(join(marketplaceRoot, 'registry.json'), 'utf8')) as {
        installed: Array<Record<string, unknown>>
      }
      expect(migrated.installed[0]).not.toHaveProperty('files')
    } finally {
      await dispose()
    }
  })

  it('installs a SkillHub archive directly and keeps user-local changes available', async () => {
    const { ctx, service, marketplaceRoot, dispose } = await boot()
    const archiveFiles = { 'community-test/SKILL.md': new TextEncoder().encode(skillSource('community-test')) }
    const archive = zipSync(archiveFiles)
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/api/v1/skills/community-test?')) return Response.json({
        skill: { slug: 'community-test', namespace: { handle: 'verified-org', canonicalName: '@verified-org/community-test' } },
        namespace: { handle: 'verified-org', canonicalName: '@verified-org/community-test' },
        latestVersion: { version: '1.2.3' },
      })
      if (url.includes('/api/v1/download?')) return new Response(archive, { status: 200, headers: { 'content-type': 'application/zip' } })
      throw new Error(`unexpected URL ${url}`)
    }))

    const receipt = await service.install({
      source: 'skillhub', coordinate: '@verified-org/community-test', namespace: 'verified-org',
      slug: 'community-test', version: '1.2.3', category: '办公效率',
    })
    expect(receipt.installed).toMatchObject({
      name: 'community-test', category: '办公效率', enabled: true, integrity: 'community-install',
    })
    expect(receipt.checks).toEqual(['installed'])
    const registry = JSON.parse(await readFile(join(marketplaceRoot, 'registry.json'), 'utf8')) as {
      installed: Array<Record<string, unknown>>
    }
    expect(registry.installed[0]).not.toHaveProperty('files')
    await expect(ctx.skills.get('community-test', { cwd: '/first-check' }))
      .resolves.toMatchObject({ content: 'Follow the verified test instructions.' })

    const installedPath = join(marketplaceRoot, 'installed', receipt.installed.id, 'SKILL.md')
    await chmod(installedPath, 0o600)
    await writeFile(installedPath, `${await readFile(installedPath, 'utf8')}\nTampered.`)
    const changed = await ctx.skills.get('community-test', { cwd: '/local-change-check' })
    expect(changed?.content).toContain('Tampered.')

    await expect(service.setEnabled({ id: receipt.installed.id, enabled: false })).resolves.toEqual({
      id: receipt.installed.id, name: 'community-test', enabled: false,
    })
    expect((await service.snapshot()).installed.find(row => row.id === receipt.installed.id)).toMatchObject({
      enabled: false,
    })
    await expect(ctx.skills.get('community-test', { cwd: '/disabled-check' })).resolves.toBeUndefined()
    expect((await stat(installedPath)).isFile()).toBe(true)

    await expect(service.setEnabled({ id: receipt.installed.id, enabled: true })).resolves.toEqual({
      id: receipt.installed.id, name: 'community-test', enabled: true,
    })
    const reenabled = await ctx.skills.get('community-test', { cwd: '/reenabled-check' })
    expect(reenabled?.content).toContain('Tampered.')

    await expect(service.remove({ id: receipt.installed.id })).resolves.toMatchObject({
      id: receipt.installed.id, name: 'community-test', source: 'skillhub',
    })
    expect((await service.snapshot()).installed.some(row => row.name === 'community-test')).toBe(false)
    await expect(ctx.skills.get('community-test', { cwd: '/after-remove' })).resolves.toBeUndefined()
    await expect(stat(installedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(service.remove({ id: 'bundled-bundled-one' })).rejects.toThrow(/内置技能不能/u)
    await dispose()
  })

  it('keeps bundled professional skills enabled and rejects disable requests', { timeout: 20_000 }, async () => {
    const { service, marketplaceRoot, dispose } = await boot()
    const before = await service.snapshot()
    const bundled = before.installed.find(row => row.id === 'bundled-bundled-one')
    expect(bundled).toMatchObject({
      name: '内置测试技能', description: '内置技能的中文说明', category: '共创专业',
      enabled: true, bundled: true, coordinate: 'bundled-one', license: 'MIT',
    })
    if (bundled === undefined) throw new Error('bundled test skill missing')

    await expect(service.setEnabled({ id: bundled.id, enabled: false })).rejects.toThrow(/内置专业技能固定启用/u)
    expect((await service.snapshot()).installed.find(row => row.id === bundled.id)).toMatchObject({ enabled: true })
    await expect(readFile(join(process.env.GONGCHUANG_BUNDLED_SKILL_DIR!, 'bundled-one', 'SKILL.md'), 'utf8'))
      .resolves.toBe(skillSource('bundled-one'))
    await expect(readFile(join(marketplaceRoot, 'registry.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })

    await expect(service.setEnabled({ id: bundled.id, enabled: true })).resolves.toEqual({
      id: bundled.id, name: '内置测试技能', enabled: true,
    })
    await dispose()
  })

  it('removes a repository without removing skills already installed from it', async () => {
    const { ctx, service, marketplaceRoot, dispose } = await boot()
    const archive = zipSync({ 'repo-skill/SKILL.md': new TextEncoder().encode(skillSource('repo-skill')) })
    const digest = sha256(archive)
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url === 'https://repo.example.com/gongchuang-skills.json') return Response.json({
        schemaVersion: 1,
        id: 'example.skills',
        name: '示例可信仓库',
        homepage: 'https://repo.example.com/',
        skills: [{
          coordinate: '@example/repo-skill', name: '仓库测试技能', description: '验证第三方仓库真实目录和安装',
          category: 'test', version: '1.0.0', license: 'MIT', archiveUrl: './repo-skill.zip',
          archiveSha256: digest, publisherVerified: true,
        }],
      })
      if (url === 'https://repo.example.com/repo-skill.zip') return new Response(archive, {
        status: 200, headers: { 'content-type': 'application/zip' },
      })
      throw new Error(`unexpected URL ${url}`)
    }))

    const added = await service.addRepository({ manifestUrl: 'https://repo.example.com/gongchuang-skills.json' })
    expect(added).toMatchObject({ repository: { id: 'example.skills', skillCount: 1 }, updated: false })
    const registry = JSON.parse(await readFile(join(marketplaceRoot, 'registry.json'), 'utf8')) as {
      repositories: Array<Record<string, unknown>>
    }
    expect(registry.repositories[0]).not.toHaveProperty('manifestDigest')
    await expect(service.search({ source: 'custom', query: '测试', page: 1, pageSize: 18 }))
      .resolves.toMatchObject({ total: 1, skills: [{ coordinate: '@example/repo-skill', repositoryId: 'example.skills' }] })

    const receipt = await service.install({
      source: 'custom', repositoryId: 'example.skills', coordinate: '@example/repo-skill',
      namespace: 'example', slug: 'repo-skill', version: '1.0.0',
    })
    expect(receipt.installed).toMatchObject({
      name: 'repo-skill', source: 'custom', repositoryId: 'example.skills', integrity: 'community-install',
    })
    expect(receipt.checks).toEqual(['installed'])
    await expect(ctx.skills.get('repo-skill', { cwd: '/repository-check' }))
      .resolves.toMatchObject({ content: 'Follow the verified test instructions.' })

    await expect(service.removeRepository({ id: 'example.skills' })).resolves.toEqual({
      id: 'example.skills', name: '示例可信仓库', installedSkillCount: 1,
    })
    expect((await service.snapshot()).repositories).toHaveLength(0)
    expect((await service.snapshot()).installed).toContainEqual(expect.objectContaining({
      id: receipt.installed.id, repositoryId: 'example.skills',
    }))
    await expect(ctx.skills.get('repo-skill', { cwd: '/repository-removed' }))
      .resolves.toMatchObject({ content: 'Follow the verified test instructions.' })
    await dispose()
  })

  it('fails closed before transport when repository DNS resolves to a local address', async () => {
    const { service, dispose } = await boot()
    const transport = vi.fn()
    vi.stubGlobal('fetch', transport)
    repositoryTransportMocks.fetchPinnedRepositoryBytes.mockRejectedValueOnce(
      new Error('仓库地址 rebound.example 解析到本机或内网，已阻止连接'),
    )

    await expect(service.addRepository({ manifestUrl: 'https://rebound.example/gongchuang-skills.json' }))
      .rejects.toThrow(/解析到本机或内网/u)
    expect(transport).not.toHaveBeenCalled()
    expect((await service.snapshot()).repositories).toHaveLength(0)
    await dispose()
  })

  it('does not require a third-party archive digest before installation', async () => {
    const { ctx, service, dispose } = await boot()
    const archive = zipSync({ 'digest-mismatch/SKILL.md': new TextEncoder().encode(skillSource('digest-mismatch')) })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url === 'https://repo.example.com/gongchuang-skills.json') return Response.json({
        schemaVersion: 1,
        id: 'digest.mismatch.skills',
        name: '摘要失配测试仓库',
        homepage: 'https://repo.example.com/',
        skills: [{
          coordinate: '@example/digest-mismatch', name: '摘要失配技能', description: '验证摘要失败关闭',
          category: 'test', version: '1.0.0', license: 'MIT', archiveUrl: './digest-mismatch.zip',
          archiveSha256: '0'.repeat(64), publisherVerified: true,
        }],
      })
      if (url === 'https://repo.example.com/digest-mismatch.zip') return new Response(archive, {
        status: 200, headers: { 'content-type': 'application/zip' },
      })
      throw new Error(`unexpected URL ${url}`)
    }))

    await service.addRepository({ manifestUrl: 'https://repo.example.com/gongchuang-skills.json' })
    await expect(service.install({
      source: 'custom', repositoryId: 'digest.mismatch.skills', coordinate: '@example/digest-mismatch',
      namespace: 'example', slug: 'digest-mismatch', version: '1.0.0',
    })).resolves.toMatchObject({ installed: { name: 'digest-mismatch', integrity: 'community-install' } })
    expect((await service.snapshot()).installed.some(row => row.name === 'digest-mismatch')).toBe(true)
    await expect(ctx.skills.get('digest-mismatch', { cwd: '/digest-mismatch-check' }))
      .resolves.toMatchObject({ content: 'Follow the verified test instructions.' })
    await dispose()
  })
})
