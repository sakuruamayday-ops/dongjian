import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyStagedSkillSuite } from '../../../product/gongchuang-client/src/skill-suite-verifier.ts'

function fixture(options: { forbidden?: boolean; tier?: 'development-candidate' | 'formal' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gongchuang-skill-suite-'))
  const signingTier = options.tier ?? 'development-candidate'
  const skillPath = options.forbidden ? 'demo/__pycache__/module.pyc' : 'demo/SKILL.md'
  const absolute = join(root, 'skills', skillPath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, options.forbidden ? 'cache' : '---\nname: demo\n---\n')
  if (options.forbidden) {
    writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n')
  }
  const paths = ['demo/SKILL.md', ...(options.forbidden ? [skillPath] : [])]
  const files = Object.fromEntries(paths.map(path => [
    path,
    createHash('sha256').update(readFileSync(join(root, 'skills', path))).digest('hex'),
  ]))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }))
  const index = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    productId: 'cn.dongjian.desktop',
    skillBundleVersion: '1.6.13',
    sourceReleaseTag: 'V1.6.13',
    signingTier,
    skills: ['demo'],
    files,
  }, null, 2)}\n`)
  writeFileSync(join(root, 'skill-bundle-index.json'), index)
  writeFileSync(join(root, 'skill-bundle-index.sig'), `${sign(null, index, privateKey).toString('base64')}\n`)
  writeFileSync(join(root, 'skill-bundle-index.pub.pem'), publicKeyPem)
  return {
    root,
    anchor: {
      expectedPublicKeySha256: createHash('sha256').update(publicKeyPem).digest('hex'),
      expectedSigningTier: signingTier,
    },
  }
}

describe('desktop staged skill-suite verifier', () => {
  it('accepts an exact formal hash-bound V1.6.13 tree', () => {
    const value = fixture({ tier: 'formal' })
    expect(verifyStagedSkillSuite(value.root, value.anchor)).toMatchObject({
      signingTier: 'formal', skillCount: 1, fileCount: 1,
    })
  })

  it('rejects file drift, a replacement signing identity, and cache artifacts', () => {
    const drift = fixture()
    writeFileSync(join(drift.root, 'skills', 'demo', 'SKILL.md'), 'tampered')
    expect(() => verifyStagedSkillSuite(drift.root, drift.anchor)).toThrow(/完整性校验未通过/u)

    const replacement = fixture()
    expect(() => verifyStagedSkillSuite(replacement.root, {
      ...replacement.anchor, expectedPublicKeySha256: '0'.repeat(64),
    })).toThrow(/不属于当前签名宿主/u)

    const forbidden = fixture({ forbidden: true })
    expect(() => verifyStagedSkillSuite(forbidden.root, forbidden.anchor)).toThrow(/不可携带/u)
  })

  it('rejects a signing tier not compiled into the host', () => {
    const value = fixture({ tier: 'formal' })
    expect(() => verifyStagedSkillSuite(value.root, {
      ...value.anchor,
      expectedSigningTier: 'development-candidate',
    })).toThrow(/身份或结构无效/u)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked skills root before reading signed files', () => {
    const value = fixture()
    const actualSkills = join(value.root, 'actual-skills')
    renameSync(join(value.root, 'skills'), actualSkills)
    symlinkSync(actualSkills, join(value.root, 'skills'), 'dir')
    expect(() => verifyStagedSkillSuite(value.root, value.anchor)).toThrow(/技能目录必须是实体目录/u)
  })
})
