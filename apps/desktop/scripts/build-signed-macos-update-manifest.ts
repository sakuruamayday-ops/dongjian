/** Generate the Ed25519-authenticated manifest consumed by the self-managed macOS updater. */

import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PRODUCT_TRUST_ANCHORS } from '../../../product/gongchuang-client/src/trust-anchors.ts'
import { desktopReleaseNotes } from './release-notes.ts'

type MacArchitecture = 'arm64' | 'x64'
type SigningTier = 'development-candidate' | 'formal'

const PRODUCT_ID = 'cn.dongjian.desktop'
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u

/** Reject a manually supplied release identity that is not the checked-out source. */
export function assertCurrentSourceCommit(sourceCommit: string, repositoryHead: string): string {
  const normalizedSourceCommit = sourceCommit.toLowerCase()
  const normalizedRepositoryHead = repositoryHead.trim().toLowerCase()
  if (!COMMIT_PATTERN.test(normalizedSourceCommit) || !COMMIT_PATTERN.test(normalizedRepositoryHead)) {
    throw new Error('桌面发布源提交必须是 40 位 Git SHA')
  }
  if (normalizedSourceCommit !== normalizedRepositoryHead) {
    throw new Error('桌面发布源提交必须等于当前 Git HEAD')
  }
  return normalizedSourceCommit
}

interface RuntimeIndex {
  readonly schemaVersion?: unknown
  readonly productId?: unknown
  readonly clientVersion?: unknown
  readonly platform?: unknown
  readonly arch?: unknown
  readonly signingTier?: unknown
}

interface SkillIndex {
  readonly schemaVersion?: unknown
  readonly productId?: unknown
  readonly signingTier?: unknown
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

function requiredFile(path: string, label: string): number {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0) throw new Error(`${label}必须是非空实体文件`)
  return info.size
}

function exactRuntimeIndex(
  path: string,
  version: string,
  architecture: MacArchitecture,
  signingTier: SigningTier,
): Buffer {
  requiredFile(path, `${architecture} 运行时索引`)
  const bytes = readFileSync(path)
  const index = JSON.parse(bytes.toString('utf8')) as RuntimeIndex
  if (index.schemaVersion !== 2 || index.productId !== PRODUCT_ID || index.clientVersion !== version
    || index.platform !== 'darwin' || index.arch !== architecture || index.signingTier !== signingTier) {
    throw new Error(`${architecture} 运行时索引与桌面发布身份不一致`)
  }
  return bytes
}

function exactSkillIndex(path: string, signingTier: SigningTier): Buffer {
  requiredFile(path, '技能包索引')
  const bytes = readFileSync(path)
  const index = JSON.parse(bytes.toString('utf8')) as SkillIndex
  if (index.schemaVersion !== 1 || index.productId !== PRODUCT_ID || index.signingTier !== signingTier) {
    throw new Error('技能包索引与桌面发布身份不一致')
  }
  return bytes
}

interface SignedMacManifestOptions {
  readonly desktopRoot: string
  readonly releaseDir: string
  readonly signingKeyPath: string
  readonly expectedPublicKeySha256: string
  readonly signingTier: SigningTier
  readonly sourceCommit: string
  readonly publishedAt?: string
}

/** Sign both architecture artifacts with the already-pinned product-runtime publisher identity. */
export async function buildSignedMacUpdateManifest(options: SignedMacManifestOptions): Promise<{
  readonly manifestPath: string
  readonly signaturePath: string
}> {
  if (!SHA256_PATTERN.test(options.expectedPublicKeySha256)) throw new Error('桌面发布公钥指纹无效')
  if (!COMMIT_PATTERN.test(options.sourceCommit)) throw new Error('桌面发布源提交必须是 40 位 Git SHA')
  const publishedAt = options.publishedAt ?? new Date().toISOString()
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error('桌面发布时间无效')
  const packageManifest = JSON.parse(readFileSync(join(options.desktopRoot, 'package.json'), 'utf8')) as {
    readonly version?: unknown
  }
  if (typeof packageManifest.version !== 'string' || !VERSION_PATTERN.test(packageManifest.version)) {
    throw new Error('桌面客户端版本号无效')
  }
  const version = packageManifest.version
  const skillIndexPath = join(options.desktopRoot, '.build', 'product-skills', 'skill-bundle-index.json')
  const skillIndex = exactSkillIndex(skillIndexPath, options.signingTier)
  const skillBundleIndexSha256 = createHash('sha256').update(skillIndex).digest('hex')
  const artifacts = await Promise.all((['arm64', 'x64'] as const).map(async (architecture) => {
    const fileName = `Dongjian-${version}-mac-${architecture}.zip`
    const archivePath = join(options.releaseDir, fileName)
    const sizeBytes = requiredFile(archivePath, `${architecture} macOS 更新包`)
    const runtimeIndex = exactRuntimeIndex(
      join(options.desktopRoot, '.build', `product-runtime-mac-${architecture}`, 'runtime-index.json'),
      version,
      architecture,
      options.signingTier,
    )
    return Object.freeze({
      architecture,
      archiveUrl: `./${fileName}`,
      bundleId: PRODUCT_ID,
      fileName,
      runtimeIndexSha256: createHash('sha256').update(runtimeIndex).digest('hex'),
      sha256: await sha256File(archivePath),
      sizeBytes,
      skillBundleIndexSha256,
    })
  }))
  const manifestBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    productId: PRODUCT_ID,
    clientVersion: version,
    publishedAt,
    signingTier: options.signingTier,
    sourceCommit: options.sourceCommit,
    releaseNotes: desktopReleaseNotes(options.desktopRoot, version),
    artifacts,
  }, null, 2)}\n`)
  const privateKey = createPrivateKey(readFileSync(options.signingKeyPath))
  const publicKeyPem = Buffer.from(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }))
  const publicKeySha256 = createHash('sha256').update(publicKeyPem).digest('hex')
  if (publicKeySha256 !== options.expectedPublicKeySha256) {
    throw new Error('桌面发布私钥不属于客户端已固定的发布者')
  }
  const manifestPath = join(options.releaseDir, 'desktop-release-index.json')
  const signaturePath = join(options.releaseDir, 'desktop-release-index.sig')
  const suffix = `.next-${randomUUID()}`
  const nextManifest = `${manifestPath}${suffix}`
  const nextSignature = `${signaturePath}${suffix}`
  writeFileSync(nextManifest, manifestBytes, { mode: 0o644, flag: 'wx' })
  writeFileSync(nextSignature, `${sign(null, manifestBytes, privateKey).toString('base64')}\n`, {
    mode: 0o644,
    flag: 'wx',
  })
  // Publish the signature first and the signed manifest last. A concurrent
  // reader can see at most a temporary signature mismatch, which fails closed.
  renameSync(nextSignature, signaturePath)
  renameSync(nextManifest, manifestPath)
  return { manifestPath, signaturePath }
}

function requiredArgument(argumentsMap: ReadonlyMap<string, string>, name: string): string {
  const value = argumentsMap.get(name)
  if (value === undefined || value.trim() === '') throw new Error(`--${name} is required`)
  return value
}

async function main(): Promise<void> {
  const argumentsMap = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]
    const value = process.argv[index + 1]
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error('usage: build-signed-macos-update-manifest.ts --release-dir <dir> --key <pem> --source-commit <sha>')
    }
    argumentsMap.set(key.slice(2), value)
  }
  const desktopRoot = resolve(import.meta.dirname, '..')
  const sourceCommit = assertCurrentSourceCommit(
    requiredArgument(argumentsMap, 'source-commit'),
    execFileSync('git', ['-C', desktopRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
  )
  const result = await buildSignedMacUpdateManifest({
    desktopRoot,
    releaseDir: resolve(desktopRoot, requiredArgument(argumentsMap, 'release-dir')),
    signingKeyPath: resolve(requiredArgument(argumentsMap, 'key')),
    expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.runtimePublicKeySha256,
    signingTier: PRODUCT_TRUST_ANCHORS.runtimeSigningTier,
    sourceCommit,
  })
  process.stdout.write(`${basename(result.manifestPath)}\n${basename(result.signaturePath)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
