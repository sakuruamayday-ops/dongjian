/** Build and Ed25519-sign the immutable desktop skill-suite resource tree. */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { isPortableSkillSuitePath, projectSkillSuiteText } from '../src/skill-suite-policy.ts'
import { verifyStagedSkillSuite } from '../src/skill-suite-verifier.ts'
import { parseSignedSkillRuntimeManifest } from '../../../packages/product/gongchuang-signed-skill-runtime/src/manifest.ts'
import {
  GONGCHUANG_SKILL_BUNDLE_VERSION,
} from '../src/product-version.ts'

interface BundleIndex {
  schemaVersion: 1
  productId: 'cn.dongjian.desktop'
  skillBundleVersion: string
  sourceReleaseTag: string
  signingTier: 'development-candidate' | 'formal'
  skills: string[]
  files: Record<string, string>
}

const args = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (key === undefined || value === undefined || !key.startsWith('--')) {
    throw new Error(
      'usage: stage-skill-suite.ts --source <skills-dir> --out <dir> --key <external.pem>'
        + ' --tier <development-candidate|formal>'
        + ' [--purpose <bundled|independent-update> --expected-version <x.y.z>]',
    )
  }
  args.set(key.slice(2), value)
}

function required(name: string): string {
  const value = args.get(name)
  if (value === undefined || value.trim() === '') throw new Error(`--${name} is required`)
  return value
}

const source = resolve(required('source'))
const out = resolve(required('out'))
const keyPath = resolve(required('key'))
const tier = required('tier')
if (tier !== 'development-candidate' && tier !== 'formal') throw new Error('--tier is invalid')
const purpose = args.get('purpose') ?? 'bundled'
if (purpose !== 'bundled' && purpose !== 'independent-update') throw new Error('--purpose is invalid')
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const evolutionConfig = join(repositoryRoot, 'product', 'gongchuang-client', 'config', 'evolution-common.yaml')
if (!statSync(evolutionConfig).isFile()) throw new Error('product evolution config is absent')
const keyRelative = relative(repositoryRoot, keyPath)
if (keyRelative === '' || (!keyRelative.startsWith('..') && !keyRelative.startsWith(`..${sep}`))) {
  throw new Error('private signing keys must stay outside the repository')
}

const suite = JSON.parse(readFileSync(join(source, 'suite-manifest.json'), 'utf8')) as {
  release?: { tag?: unknown; version?: unknown }
  skills?: unknown
}
const sourceVersion = suite.release?.version
const sourceTag = suite.release?.tag
if (typeof sourceVersion !== 'string'
  || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(sourceVersion)
  || sourceTag !== `V${sourceVersion}`
  || !Array.isArray(suite.skills) || suite.skills.some(skill => typeof skill !== 'string')) {
  throw new Error('source is not a versioned skill-suite manifest')
}
const skills = [...suite.skills] as string[]
if (skills.length === 0 || new Set(skills).size !== skills.length) {
  throw new Error('source skill suite must declare a non-empty unique skill list')
}
const runtimeManifestPath = join(source, 'client-runtime-operations.json')
if (existsSync(runtimeManifestPath)) {
  // 在签名前复用宿主解析器，避免整包版本已更新而操作清单仍是旧版，
  // 导致已验签的客户端直到启动时才因版本不一致退出。
  parseSignedSkillRuntimeManifest(JSON.parse(readFileSync(runtimeManifestPath, 'utf8')), sourceVersion)
}
if (purpose === 'bundled' && sourceVersion !== GONGCHUANG_SKILL_BUNDLE_VERSION) {
  throw new Error(`source skill suite must be V${GONGCHUANG_SKILL_BUNDLE_VERSION}`)
}
if (purpose === 'independent-update') {
  const expectedVersion = required('expected-version')
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(expectedVersion)) {
    throw new Error('--expected-version must be a three-part semantic version')
  }
  if (sourceVersion !== expectedVersion) {
    throw new Error(`independent update source must be V${expectedVersion}`)
  }
}
for (const skill of skills) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill) || !statSync(join(source, skill, 'SKILL.md')).isFile()) {
    throw new Error(`suite skill ${skill} is absent or invalid`)
  }
}

function walk(root: string, current = root): string[] {
  const rows: string[] = []
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name)
    const info = lstatSync(absolute)
    if (info.isSymbolicLink()) throw new Error(`skill suite contains forbidden symlink: ${relative(root, absolute)}`)
    if (info.isDirectory()) rows.push(...walk(root, absolute))
    else if (info.isFile()) rows.push(relative(root, absolute).split(sep).join('/'))
    else throw new Error(`skill suite contains unsupported entry: ${relative(root, absolute)}`)
  }
  return rows
}

const declaredSkillRoots = new Set(skills)
const sourceFiles = walk(source)
  .filter(isPortableSkillSuitePath)
  // A signed bundle is the manifest projection, not a copy of every sibling
  // directory left in the source checkout. Otherwise a retired skill can be
  // signed and discovered even though suite-manifest.json no longer lists it.
  .filter((path) => {
    const slash = path.indexOf('/')
    if (slash === -1) return true
    const root = path.slice(0, slash)
    return root === '_runtime' || declaredSkillRoots.has(root)
  })
const stagedFiles = new Map(sourceFiles.map((path) => {
  const sourceBytes = readFileSync(join(source, path))
  const bytes = path.endsWith('/SKILL.md')
    ? Buffer.from(projectSkillSuiteText(path, sourceBytes.toString('utf8')))
    : sourceBytes
  return [path, bytes] as const
}))
const files = Object.fromEntries([...stagedFiles].map(([path, bytes]) => [
  path,
  createHash('sha256').update(bytes).digest('hex'),
]))
const bundleIndex: BundleIndex = {
  schemaVersion: 1,
  productId: 'cn.dongjian.desktop',
  skillBundleVersion: sourceVersion,
  sourceReleaseTag: sourceTag,
  signingTier: tier,
  skills,
  files,
}
const indexBytes = Buffer.from(`${JSON.stringify(bundleIndex, null, 2)}\n`)

let privatePem: Buffer
try {
  privatePem = readFileSync(keyPath)
} catch (error) {
  if (tier !== 'development-candidate') throw error
  const pair = generateKeyPairSync('ed25519')
  privatePem = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, privatePem, { mode: 0o600, flag: 'wx' })
}
const privateKey = createPrivateKey(privatePem)
const publicPem = Buffer.from(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }))

function uniqueSiblingPath(path: string, kind: 'candidate' | 'previous'): string {
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
  let candidate = `${path}.${kind}-${stamp}-${String(process.pid)}`
  let suffix = 0
  while (existsSync(candidate)) {
    suffix += 1
    candidate = `${path}.${kind}-${stamp}-${String(process.pid)}-${String(suffix)}`
  }
  return candidate
}

function windowsRecycleScript(path: string): string {
  const encodedPath = Buffer.from(path, 'utf8').toString('base64')
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$utf8 = New-Object System.Text.UTF8Encoding($false)
$path = $utf8.GetString([Convert]::FromBase64String('${encodedPath}'))
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
  $path,
  [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
  [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
)
`
}

function moveSkillSuiteToTrash(path: string, kind: 'failed-candidate' | 'previous'): void {
  if (!existsSync(path)) return
  const configured = process.env.GONGCHUANG_STAGE_TRASH_ROOT?.trim()
  if ((configured === undefined || configured === '') && process.platform === 'win32') {
    const encoded = Buffer.from(windowsRecycleScript(path), 'utf16le').toString('base64')
    execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
    ], { stdio: 'pipe', windowsHide: true })
    return
  }
  let trashRoot: string
  if (configured !== undefined && configured !== '') trashRoot = resolve(configured)
  else if (process.platform === 'darwin') trashRoot = join(homedir(), '.Trash')
  else throw new Error('GONGCHUANG_STAGE_TRASH_ROOT must name the system Trash outside macOS')
  mkdirSync(trashRoot, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
  let destination = join(
    trashRoot,
    `gongchuang-skill-suite-${kind}-${stamp}-${String(process.pid)}-${basename(path)}`,
  )
  let suffix = 0
  while (existsSync(destination)) {
    suffix += 1
    destination = join(
      trashRoot,
      `gongchuang-skill-suite-${kind}-${stamp}-${String(process.pid)}-${String(suffix)}-${basename(path)}`,
    )
  }
  renameSync(path, destination)
}

const stagingOut = uniqueSiblingPath(out, 'candidate')
try {
  mkdirSync(dirname(out), { recursive: true })
  mkdirSync(stagingOut, { recursive: false })
  mkdirSync(join(stagingOut, 'config'), { recursive: true })
  copyFileSync(evolutionConfig, join(stagingOut, 'config', 'common.yaml'))
  const stagedSkills = join(stagingOut, 'skills')
  for (const path of sourceFiles) {
    const destination = join(stagedSkills, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, stagedFiles.get(path)!)
  }
  writeFileSync(join(stagingOut, 'skill-bundle-index.json'), indexBytes)
  writeFileSync(join(stagingOut, 'skill-bundle-index.sig'), `${sign(null, indexBytes, privateKey).toString('base64')}\n`)
  writeFileSync(join(stagingOut, 'skill-bundle-index.pub.pem'), publicPem)
  writeFileSync(join(stagingOut, 'staging-receipt.json'), `${JSON.stringify({
    schemaVersion: 1,
    skillBundleVersion: sourceVersion,
    projectionPurpose: purpose,
    signingTier: tier,
    indexSha256: createHash('sha256').update(indexBytes).digest('hex'),
    publicKeySha256: createHash('sha256').update(publicPem).digest('hex'),
    fileCount: Object.keys(files).length,
    skillCount: skills.length,
  }, null, 2)}\n`)
  // The active output is not moved until the complete candidate verifies
  // against the exact signing identity that the host will later pin.
  verifyStagedSkillSuite(stagingOut, {
    expectedPublicKeySha256: createHash('sha256').update(publicPem).digest('hex'),
    expectedSigningTier: tier,
  })
} catch (error: unknown) {
  try {
    moveSkillSuiteToTrash(stagingOut, 'failed-candidate')
  } catch (cleanupError: unknown) {
    throw new AggregateError([error, cleanupError], 'skill-suite candidate construction and recoverable cleanup failed')
  }
  throw error
}

let previous: string | undefined
try {
  if (existsSync(out)) {
    previous = uniqueSiblingPath(out, 'previous')
    renameSync(out, previous)
  }
  renameSync(stagingOut, out)
} catch (error: unknown) {
  if (previous !== undefined && !existsSync(out) && existsSync(previous)) renameSync(previous, out)
  throw error
}

if (previous !== undefined) {
  try {
    moveSkillSuiteToTrash(previous, 'previous')
  } catch (error: unknown) {
    // A refused recoverable move must not silently commit a replacement while
    // the prior current tree is still available beside it.
    const failedCandidate = uniqueSiblingPath(out, 'candidate')
    renameSync(out, failedCandidate)
    renameSync(previous, out)
    throw error
  }
}
