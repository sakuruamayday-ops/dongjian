import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { SkillSuiteTrustAnchor } from '../../../product/gongchuang-client/src/skill-suite-verifier.ts'
import {
  compareVersions, commitSkillBundleLaunch, parseSkillUpdateManifest,
  reconciledSkillUpdateStagingPaths, resolveSkillBundleForLaunch, SkillUpdaterController,
  trashReconciledSkillUpdateStaging,
} from '../src/skill-updater.ts'

async function moveToTestTrash(path: string): Promise<void> {
  renameSync(path, join(dirname(path), `.Trash-${basename(path)}`))
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function updateFetch(archive: Buffer): typeof fetch {
  const archiveBody = Uint8Array.from(archive).buffer
  return async input => requestUrl(input).endsWith('latest.json')
    ? new Response(JSON.stringify({
      schemaVersion: 1,
      productId: 'cn.dongjian.desktop',
      skillBundleVersion: '1.6.7',
      sourceReleaseTag: 'V1.6.7',
      archiveUrl: './skills.zip',
      releaseNotes: '',
    }), { status: 200 })
    : new Response(archiveBody, { status: 200 })
}

function signingFixture(): {
  readonly privateKey: KeyObject
  readonly publicPem: Buffer
  readonly anchor: SkillSuiteTrustAnchor
} {
  const pair = generateKeyPairSync('ed25519')
  const publicPem = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' }))
  return {
    privateKey: pair.privateKey,
    publicPem,
    anchor: {
      expectedPublicKeySha256: createHash('sha256').update(publicPem).digest('hex'),
      expectedSigningTier: 'development-candidate',
    },
  }
}

function signedBundle(
  root: string,
  version: string,
  fixture: ReturnType<typeof signingFixture>,
  description = `V${version}`,
): Record<string, Uint8Array> {
  const skill = Buffer.from(`---\nname: test-skill\ndescription: ${description}\n---\n`)
  const index = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    productId: 'cn.dongjian.desktop',
    skillBundleVersion: version,
    sourceReleaseTag: `V${version}`,
    signingTier: 'development-candidate',
    skills: ['test-skill'],
    files: { 'test-skill/SKILL.md': createHash('sha256').update(skill).digest('hex') },
  }, null, 2)}\n`)
  const signature = Buffer.from(`${sign(null, index, fixture.privateKey).toString('base64')}\n`)
  mkdirSync(join(root, 'skills', 'test-skill'), { recursive: true })
  writeFileSync(join(root, 'skills', 'test-skill', 'SKILL.md'), skill)
  writeFileSync(join(root, 'skill-bundle-index.json'), index)
  writeFileSync(join(root, 'skill-bundle-index.sig'), signature)
  writeFileSync(join(root, 'skill-bundle-index.pub.pem'), fixture.publicPem)
  return {
    'skills/test-skill/SKILL.md': skill,
    'skill-bundle-index.json': index,
    'skill-bundle-index.sig': signature,
    'skill-bundle-index.pub.pem': fixture.publicPem,
  }
}

describe('independent skill-suite updater', () => {
  it('compares semantic versions and validates same-origin update manifests', () => {
    expect(compareVersions('1.6.7', '1.6.6')).toBeGreaterThan(0)
    expect(compareVersions('1.6.6', '1.6.6')).toBe(0)
    const feed = new URL('https://zshjiaotang.cn/skill-updates/latest.json')
    expect(parseSkillUpdateManifest({
      schemaVersion: 1,
      productId: 'cn.dongjian.desktop',
      skillBundleVersion: '1.6.7',
      sourceReleaseTag: 'V1.6.7',
      archiveUrl: './gongchuang-skills-V1.6.7.zip',
      releaseNotes: '更新高企与政策检索规则',
    }, feed).archiveUrl).toBe('https://zshjiaotang.cn/skill-updates/gongchuang-skills-V1.6.7.zip')
    expect(() => parseSkillUpdateManifest({
      schemaVersion: 1,
      productId: 'cn.dongjian.desktop',
      skillBundleVersion: '1.6.7',
      sourceReleaseTag: 'V1.6.7',
      archiveUrl: 'https://example.com/skills.zip',
      releaseNotes: '',
    }, feed)).toThrow('同源')
  })

  it('keeps the active version but never calls a missing feed the latest release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-skill-no-release-'))
    const fixture = signingFixture()
    const controller = new SkillUpdaterController({
      updateRoot: root,
      activeVersion: '1.6.16',
      feedUrl: 'https://zshjiaotang.cn/skill-updates/latest.json',
      trustAnchor: fixture.anchor,
      fetchImpl: async () => new Response(null, { status: 404 }),
    })
    await expect(controller.check()).resolves.toMatchObject({
      status: 'error', currentVersion: '1.6.16', latestVersion: null, message: '技能包更新源暂不可用，请稍后重试',
    })
    expect(controller.current()).toMatchObject({ currentVersion: '1.6.16', latestVersion: null })
  })

  it('downloads, verifies, arms, activates, and reuses a newer signed skill package', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-skill-updater-'))
    const bundled = join(root, 'bundled')
    const updates = join(root, 'updates')
    const fixture = signingFixture()
    signedBundle(bundled, '1.6.6', fixture)
    const updateFiles = signedBundle(join(root, 'source-1.6.7'), '1.6.7', fixture)
    const archive = Buffer.from(zipSync(updateFiles, { level: 0 }))
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(init?.redirect).toBe('error')
      const url = requestUrl(input)
      if (url.endsWith('latest.json')) {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          productId: 'cn.dongjian.desktop',
          skillBundleVersion: '1.6.7',
          sourceReleaseTag: 'V1.6.7',
          archiveUrl: './Dongjian-Skills-V1.6.7.zip',
          releaseNotes: '规则更新',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(archive, { status: 200, headers: { 'content-type': 'application/zip' } })
    }
    const controller = new SkillUpdaterController({
      updateRoot: updates,
      activeVersion: '1.6.6',
      feedUrl: 'https://zshjiaotang.cn/skill-updates/latest.json',
      trustAnchor: fixture.anchor,
      fetchImpl,
    })
    await expect(controller.check()).resolves.toMatchObject({ status: 'available', latestVersion: '1.6.7' })
    await expect(controller.download()).resolves.toMatchObject({ status: 'downloaded', latestVersion: '1.6.7' })
    const transactions = readdirSync(join(updates, 'staging'))
    expect(transactions).toHaveLength(1)
    const transaction = join(updates, 'staging', transactions[0] ?? '')
    expect(existsSync(join(transaction, 'skill-suite.zip'))).toBe(false)
    expect(JSON.parse(readFileSync(join(transaction, 'activation-receipt.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1, skillBundleVersion: '1.6.7',
    })
    expect(controller.prepareInstall()).toMatchObject({ status: 'downloaded', latestVersion: '1.6.7' })
    const pending = resolveSkillBundleForLaunch(bundled, updates, fixture.anchor)
    expect(pending).toMatchObject({ pendingActivation: true, verified: { version: '1.6.7' } })
    commitSkillBundleLaunch(updates, pending, '2026-08-23T08:00:00.000Z')
    expect(JSON.parse(readFileSync(join(updates, 'state.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      activeVersion: '1.6.7',
      lastSuccessVersion: '1.6.7',
      enabledAt: '2026-08-23T08:00:00.000Z',
    })
    await trashReconciledSkillUpdateStaging(updates, '1.6.7', moveToTestTrash)
    expect(existsSync(transaction)).toBe(false)
    expect(existsSync(join(updates, 'staging', `.Trash-${basename(transaction)}`))).toBe(true)
    expect(resolveSkillBundleForLaunch(bundled, updates, fixture.anchor)).toMatchObject({
      pendingActivation: false, verified: { version: '1.6.7' },
    })
  })

  it('falls back to the bundled suite while retaining the installed version for recovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-skill-rollback-'))
    const bundled = join(root, 'bundled')
    const updates = join(root, 'updates')
    const fixture = signingFixture()
    signedBundle(bundled, '1.6.6', fixture)
    const updateRoot = join(updates, 'versions', '1.6.7')
    signedBundle(updateRoot, '1.6.7', fixture)
    mkdirSync(updates, { recursive: true })
    writeFileSync(join(updates, 'state.json'), `${JSON.stringify({
      schemaVersion: 1, pendingVersion: '1.6.7', downloadedVersion: '1.6.7',
    })}\n`)
    expect(resolveSkillBundleForLaunch(bundled, updates, fixture.anchor).verified.version).toBe('1.6.7')
    const recovered = resolveSkillBundleForLaunch(bundled, updates, fixture.anchor)
    expect(recovered.verified.version).toBe('1.6.6')
    const recoveredState = readFileSync(join(updates, 'state.json'), 'utf8')
    expect(recoveredState).toContain('请重新下载安装')
    expect(recoveredState).not.toContain('previousVersion')
    expect(existsSync(updateRoot)).toBe(true)
  })

  it('does not reactivate a prior external version after a failed pending activation', () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-skill-external-rollback-'))
    const bundled = join(root, 'bundled')
    const updates = join(root, 'updates')
    const fixture = signingFixture()
    signedBundle(bundled, '1.6.6', fixture)
    signedBundle(join(updates, 'versions', '1.6.7'), '1.6.7', fixture)
    signedBundle(join(updates, 'versions', '1.6.8'), '1.6.8', fixture)
    writeFileSync(join(updates, 'state.json'), `${JSON.stringify({
      schemaVersion: 1, activeVersion: '1.6.7', downloadedVersion: '1.6.8',
    })}\n`)
    const controller = new SkillUpdaterController({
      updateRoot: updates, activeVersion: '1.6.7', trustAnchor: fixture.anchor,
    })
    expect(controller.prepareInstall()).toMatchObject({ status: 'downloaded', latestVersion: '1.6.8' })
    expect(resolveSkillBundleForLaunch(bundled, updates, fixture.anchor)).toMatchObject({
      pendingActivation: true, verified: { version: '1.6.8' },
    })
    expect(resolveSkillBundleForLaunch(bundled, updates, fixture.anchor)).toMatchObject({
      pendingActivation: false, verified: { version: '1.6.6' },
    })
    const recoveredState = readFileSync(join(updates, 'state.json'), 'utf8')
    expect(recoveredState).not.toContain('"activeVersion"')
    expect(recoveredState).not.toContain('previousVersion')
    expect(recoveredState).toContain('请重新下载安装')
    expect(existsSync(join(updates, 'versions', '1.6.7'))).toBe(true)
    expect(existsSync(join(updates, 'versions', '1.6.8'))).toBe(true)
  })

  it('prefers the bundled suite and refuses duplicate or downgraded activation', () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-skill-bundled-fallback-'))
    const bundled = join(root, 'bundled')
    const updates = join(root, 'updates')
    const fixture = signingFixture()
    signedBundle(bundled, '1.6.8', fixture)
    signedBundle(join(updates, 'versions', '1.6.7'), '1.6.7', fixture)
    writeFileSync(join(updates, 'state.json'), `${JSON.stringify({
      schemaVersion: 1, activeVersion: '1.6.7', previousVersion: '1.6.6', pendingVersion: '1.6.7',
    })}\n`)
    const selection = resolveSkillBundleForLaunch(bundled, updates, fixture.anchor)
    expect(selection).toMatchObject({
      path: bundled, pendingActivation: false, verified: { version: '1.6.8' },
    })
    commitSkillBundleLaunch(updates, selection, '2026-08-23T08:00:30.000Z')
    expect(readFileSync(join(updates, 'state.json'), 'utf8')).not.toContain('"activeVersion"')
    expect(readFileSync(join(updates, 'state.json'), 'utf8')).not.toContain('previousVersion')
    expect(existsSync(join(updates, 'versions', '1.6.7'))).toBe(true)

    writeFileSync(join(updates, 'state.json'), `${JSON.stringify({
      schemaVersion: 1, downloadedVersion: '1.6.7',
    })}\n`)
    const controller = new SkillUpdaterController({
      updateRoot: updates, activeVersion: '1.6.8', trustAnchor: fixture.anchor,
    })
    const refused = controller.prepareInstall()
    expect(refused.status).toBe('error')
    expect(refused.message).toMatch(/重复安装|降级/u)
  })

  it('clears a superseded activation error and trashes stale artifacts recoverably', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-skill-superseded-'))
    const bundled = join(root, 'bundled')
    const updates = join(root, 'updates')
    const fixture = signingFixture()
    signedBundle(bundled, '1.6.12', fixture)
    signedBundle(join(updates, 'versions', '1.6.8'), '1.6.8', fixture)
    const staleTransaction = join(updates, 'staging', '1.6.8-bc5a5200-144e-420d-ae4e-c895a4db5509')
    const currentFailed = join(updates, 'staging', '1.6.12-11111111-1111-4111-8111-111111111111')
    const newerFailed = join(updates, 'staging', '1.7.0-22222222-2222-4222-8222-222222222222')
    mkdirSync(staleTransaction, { recursive: true })
    mkdirSync(currentFailed, { recursive: true })
    mkdirSync(newerFailed, { recursive: true })
    writeFileSync(join(staleTransaction, 'skill-suite.zip'), 'stale')
    writeFileSync(join(currentFailed, 'failure.txt'), 'current failure')
    writeFileSync(join(newerFailed, 'failure.txt'), 'newer failure')
    writeFileSync(join(updates, 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      lastError: '技能包 V1.6.8 启用失败，请重新下载安装',
    })}\n`)

    const selection = resolveSkillBundleForLaunch(bundled, updates, fixture.anchor)
    expect(selection).toMatchObject({
      pendingActivation: false,
      verified: { version: '1.6.12' },
    })
    expect(readFileSync(join(updates, 'state.json'), 'utf8')).toContain('启用失败')
    commitSkillBundleLaunch(updates, selection, '2026-08-23T08:01:00.000Z')
    expect(JSON.parse(readFileSync(join(updates, 'state.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      lastSuccessVersion: '1.6.12',
      enabledAt: '2026-08-23T08:01:00.000Z',
    })
    expect(reconciledSkillUpdateStagingPaths(updates, '1.6.12')).toEqual([staleTransaction])
    await trashReconciledSkillUpdateStaging(updates, '1.6.12', moveToTestTrash)
    expect(existsSync(staleTransaction)).toBe(false)
    expect(existsSync(join(updates, 'staging', `.Trash-${basename(staleTransaction)}`))).toBe(true)
    expect(existsSync(currentFailed)).toBe(true)
    expect(existsSync(newerFailed)).toBe(true)
    expect(existsSync(join(updates, 'versions', '1.6.8'))).toBe(true)
  })

  it('rewrites a legacy encoded failure as UTF-8 only after a successful full launch', () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-skill-legacy-encoding-'))
    const bundled = join(root, 'bundled')
    const updates = join(root, 'updates')
    const fixture = signingFixture()
    signedBundle(bundled, '1.6.12', fixture)
    mkdirSync(updates, { recursive: true })
    const legacyBytes = Buffer.concat([
      Buffer.from('{"schemaVersion":1,"lastError":"'),
      Buffer.from([0xbc, 0xbc, 0xc4, 0xdc]),
      Buffer.from('"}\n'),
    ])
    writeFileSync(join(updates, 'state.json'), legacyBytes)

    const selection = resolveSkillBundleForLaunch(bundled, updates, fixture.anchor)
    expect(readFileSync(join(updates, 'state.json'))).toEqual(legacyBytes)
    commitSkillBundleLaunch(updates, selection, '2026-08-23T08:02:00.000Z')

    const rewritten = readFileSync(join(updates, 'state.json'))
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(rewritten)).not.toThrow()
    expect(JSON.parse(rewritten.toString('utf8'))).toEqual({
      schemaVersion: 1,
      lastSuccessVersion: '1.6.12',
      enabledAt: '2026-08-23T08:02:00.000Z',
    })
  })

  it('retains a newer failure and preserves the original success timestamp on later launches', () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-skill-reconcile-'))
    const bundled = join(root, 'bundled')
    const updates = join(root, 'updates')
    const fixture = signingFixture()
    signedBundle(bundled, '1.6.12', fixture)
    mkdirSync(updates, { recursive: true })
    writeFileSync(join(updates, 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      failedVersion: '1.7.0',
      lastError: '技能包 V1.7.0 验签失败',
    })}\n`)

    const selection = resolveSkillBundleForLaunch(bundled, updates, fixture.anchor)
    commitSkillBundleLaunch(updates, selection, '2026-08-23T08:03:00.000Z')
    commitSkillBundleLaunch(updates, selection, '2026-08-23T09:00:00.000Z')
    expect(JSON.parse(readFileSync(join(updates, 'state.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      failedVersion: '1.7.0',
      lastError: '技能包 V1.7.0 验签失败',
      lastSuccessVersion: '1.6.12',
      enabledAt: '2026-08-23T08:03:00.000Z',
    })
  })

  it('commits only the pending version selected for the successful launch', () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-skill-commit-'))
    const bundled = join(root, 'bundled')
    const updates = join(root, 'updates')
    const fixture = signingFixture()
    signedBundle(bundled, '1.6.6', fixture)
    signedBundle(join(updates, 'versions', '1.6.7'), '1.6.7', fixture)
    mkdirSync(updates, { recursive: true })
    writeFileSync(join(updates, 'state.json'), `${JSON.stringify({
      schemaVersion: 1, pendingVersion: '1.6.7',
    })}\n`)
    const selection = resolveSkillBundleForLaunch(bundled, updates, fixture.anchor)
    writeFileSync(join(updates, 'state.json'), `${JSON.stringify({
      schemaVersion: 1, pendingVersion: '1.6.8', attemptingVersion: '1.6.8',
    })}\n`)
    expect(() => { commitSkillBundleLaunch(updates, selection) }).toThrow(/待启用状态/u)
  })

  it('rejects a signed reissue under an already installed version', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-skill-reissue-'))
    const updates = join(root, 'updates')
    const fixture = signingFixture()
    signedBundle(join(updates, 'versions', '1.6.7'), '1.6.7', fixture, 'original')
    const reissued = signedBundle(join(root, 'reissued'), '1.6.7', fixture, 'changed')
    const archive = Buffer.from(zipSync(reissued, { level: 0 }))
    const controller = new SkillUpdaterController({
      updateRoot: updates,
      activeVersion: '1.6.6',
      trustAnchor: fixture.anchor,
      fetchImpl: updateFetch(archive),
    })
    await controller.check()
    const result = await controller.download()
    expect(result.status).toBe('error')
    expect(result.message).toContain('不同的签名内容')
    expect(readFileSync(join(updates, 'versions', '1.6.7', 'skills', 'test-skill', 'SKILL.md'), 'utf8'))
      .toContain('original')
    const failedTransactions = readdirSync(join(updates, 'staging'))
    expect(failedTransactions).toHaveLength(1)
    expect(existsSync(join(updates, 'staging', failedTransactions[0] ?? '', 'activation-receipt.json'))).toBe(false)
    expect(reconciledSkillUpdateStagingPaths(updates, '1.6.6')).toEqual([])
  })

  it('rejects non-canonical ZIP paths and Unix symbolic-link entries', async () => {
    const fixture = signingFixture()
    const makeController = (archive: Buffer) => {
      const updates = mkdtempSync(join(tmpdir(), 'gongchuang-skill-unsafe-zip-'))
      return new SkillUpdaterController({
        updateRoot: updates,
        activeVersion: '1.6.6',
        trustAnchor: fixture.anchor,
        fetchImpl: updateFetch(archive),
      })
    }
    const files = signedBundle(mkdtempSync(join(tmpdir(), 'gongchuang-skill-zip-source-')), '1.6.7', fixture)
    const traversal = makeController(Buffer.from(zipSync({
      ...files, 'skills/test-skill/../escape.txt': Buffer.from('escape'),
    }, { level: 0 })))
    await traversal.check()
    const traversalResult = await traversal.download()
    expect(traversalResult.status).toBe('error')
    expect(traversalResult.message).toContain('不安全路径')

    const symlinkEntry: [Uint8Array, { readonly attrs: number; readonly level: 0; readonly os: 3 }] = [
      Buffer.from('SKILL.md'), { attrs: (0o120777 << 16) >>> 0, level: 0, os: 3 },
    ]
    const symlink = makeController(Buffer.from(zipSync({
      ...files, 'skills/test-skill/latest': symlinkEntry,
    }, { level: 0 })))
    await symlink.check()
    const symlinkResult = await symlink.download()
    expect(symlinkResult.status).toBe('error')
    expect(symlinkResult.message).toContain('符号链接')
  })

  it('rejects the standalone generic-suite wrapper instead of weakening the desktop path boundary', async () => {
    const fixture = signingFixture()
    const updates = mkdtempSync(join(tmpdir(), 'gongchuang-skill-generic-wrapper-'))
    const genericArchive = Buffer.from(zipSync({
      'gongchuang-research-institute-skills/publisher-ed25519.pub': fixture.publicPem,
      'gongchuang-research-institute-skills/skills/test-skill/SKILL.md': Buffer.from('generic'),
    }, { level: 0 }))
    const controller = new SkillUpdaterController({
      updateRoot: updates,
      activeVersion: '1.6.6',
      trustAnchor: fixture.anchor,
      fetchImpl: updateFetch(genericArchive),
    })
    await controller.check()
    const result = await controller.download()
    expect(result.status).toBe('error')
    expect(result.message).toContain('gongchuang-research-institute-skills/publisher-ed25519.pub')
  })
})
