import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { isPortableSkillSuitePath } from './skill-suite-policy.ts'

interface SkillBundleIndex {
  schemaVersion: number
  productId: string
  skillBundleVersion: string
  sourceReleaseTag: string
  signingTier: string
  skills: unknown
  files: unknown
}

export interface SkillSuiteTrustAnchor {
  expectedPublicKeySha256: string
  expectedSigningTier: 'development-candidate' | 'formal'
}

export interface VerifiedSkillSuite {
  skillsRoot: string
  version: string
  sourceReleaseTag: string
  signingTier: 'development-candidate' | 'formal'
  skillCount: number
  fileCount: number
  publicKeySha256: string
  indexSha256: string
  fileHashes: Readonly<Record<string, string>>
}

const SKILL_BUNDLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u

function requireDirectory(path: string, label: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label}必须是实体目录`)
}

function requireFile(path: string, label: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label}必须是实体文件`)
}

function skillFiles(root: string, current = root): string[] {
  const rows: string[] = []
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name)
    const info = lstatSync(absolute)
    if (info.isSymbolicLink()) throw new Error(`技能包包含符号链接：${absolute}`)
    if (info.isDirectory()) rows.push(...skillFiles(root, absolute))
    else if (info.isFile()) rows.push(relative(root, absolute).split(sep).join('/'))
    else throw new Error(`技能包包含不支持的文件类型：${absolute}`)
  }
  return rows
}

/**
 * Verify one complete staged skill tree against a host-pinned key.
 * @param root - Directory containing the signed index and `skills` tree.
 * @param anchor - Public-key digest and signing tier compiled into the host.
 * @returns Immutable identity and count facts for the verified tree.
 */
export function verifyStagedSkillSuite(root: string, anchor: SkillSuiteTrustAnchor): VerifiedSkillSuite {
  if (!/^[0-9a-f]{64}$/u.test(anchor.expectedPublicKeySha256)) {
    throw new Error('技能包宿主公钥指纹无效')
  }
  const indexPath = join(root, 'skill-bundle-index.json')
  const signaturePath = join(root, 'skill-bundle-index.sig')
  const publicKeyPath = join(root, 'skill-bundle-index.pub.pem')
  const skillsRoot = join(root, 'skills')
  requireDirectory(root, '技能包根目录')
  requireFile(indexPath, '技能包索引')
  requireFile(signaturePath, '技能包签名')
  requireFile(publicKeyPath, '技能包公钥')
  requireDirectory(skillsRoot, '技能包技能目录')
  const indexBytes = readFileSync(indexPath)
  const encoded = readFileSync(signaturePath, 'utf8').trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error('技能包签名不是规范 Base64')
  const publicKeyPem = readFileSync(publicKeyPath)
  const publicKeySha256 = createHash('sha256').update(publicKeyPem).digest('hex')
  if (publicKeySha256 !== anchor.expectedPublicKeySha256) throw new Error('技能包公钥不属于当前签名宿主')
  if (!verify(null, indexBytes, createPublicKey(publicKeyPem), Buffer.from(encoded, 'base64'))) {
    throw new Error('技能包 Ed25519 签名无效')
  }

  const indexSha256 = createHash('sha256').update(indexBytes).digest('hex')
  const index = JSON.parse(indexBytes.toString('utf8')) as SkillBundleIndex
  if (index.schemaVersion !== 1 || index.productId !== 'cn.dongjian.desktop'
    || !SKILL_BUNDLE_VERSION.test(index.skillBundleVersion)
    || index.sourceReleaseTag !== `V${index.skillBundleVersion}`
    || index.signingTier !== anchor.expectedSigningTier
    || !Array.isArray(index.skills) || index.skills.length === 0
    || index.skills.some((skill: unknown) => typeof skill !== 'string'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill))
    || typeof index.files !== 'object' || index.files === null || Array.isArray(index.files)) {
    throw new Error('技能包索引身份或结构无效')
  }
  const skills = index.skills.map((skill: unknown) => {
    if (typeof skill !== 'string') throw new Error('技能包索引包含非字符串技能名')
    return skill
  })
  if (new Set(skills).size !== skills.length) throw new Error('技能包索引包含重复技能')
  const files = Object.fromEntries(Object.entries(index.files).map(([path, digest]) => {
    if (!isPortableSkillSuitePath(path)) throw new Error(`技能包索引包含不可携带路径：${path}`)
    if (typeof digest !== 'string') throw new Error(`技能包完整性记录无效：${path}`)
    return [path, digest]
  }))
  const actualFiles = skillFiles(skillsRoot)
  const expectedFiles = Object.keys(files).sort()
  const forbiddenPath = actualFiles.find(path => !isPortableSkillSuitePath(path))
  if (forbiddenPath !== undefined) throw new Error(`技能包包含不可携带文件：${forbiddenPath}`)
  if (actualFiles.length !== expectedFiles.length
    || actualFiles.some((path, offset) => path !== expectedFiles[offset])) {
    throw new Error('技能包文件集合与签名索引不一致')
  }
  for (const path of actualFiles) {
    const expected = files[path]
    if (!/^[0-9a-f]{64}$/u.test(expected ?? '')) throw new Error(`技能包完整性记录无效：${path}`)
    const actual = createHash('sha256').update(readFileSync(join(skillsRoot, path))).digest('hex')
    if (actual !== expected) throw new Error(`技能包文件完整性校验未通过：${path}`)
  }
  for (const skill of skills) {
    if (!actualFiles.includes(`${skill}/SKILL.md`)) throw new Error(`技能包缺少 ${skill}/SKILL.md`)
  }
  const declaredEntrypoints = new Set(skills.map(skill => `${skill}/SKILL.md`))
  const unexpectedEntrypoint = actualFiles.find(path => path.endsWith('/SKILL.md')
    && !declaredEntrypoints.has(path))
  if (unexpectedEntrypoint !== undefined) {
    throw new Error(`技能包包含清单外技能入口：${unexpectedEntrypoint}`)
  }
  return Object.freeze({
    skillsRoot,
    version: index.skillBundleVersion,
    sourceReleaseTag: index.sourceReleaseTag,
    signingTier: anchor.expectedSigningTier,
    skillCount: skills.length,
    fileCount: actualFiles.length,
    publicKeySha256,
    indexSha256,
    fileHashes: Object.freeze({ ...files }),
  })
}
