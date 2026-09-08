/** Download hash-pinned wheels and build one offline Python dependency overlay. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { moveGeneratedPathToTrash } from '../../../scripts/move-generated-path-to-trash.ts'

type Platform = 'darwin' | 'win32'
type Architecture = 'arm64' | 'x64'

interface Artifact {
  distribution: string
  version: string
  filename: string
  url: string
  sha256: string
  wheelTag: string
  topLevel: string[]
  licenseFiles?: string[]
}

interface TargetManifest {
  pipPlatform: string
  abis: string[]
  artifacts: Artifact[]
}

interface DependencyManifest {
  schemaVersion: number
  pythonVersion: string
  targets: Record<string, TargetManifest>
}

const REQUIRED_DISTRIBUTIONS = [
  'python-docx',
  'lxml',
  'pymupdf',
  'openpyxl',
  'xlrd',
  'et-xmlfile',
  'python-pptx',
  'pillow',
  'xlsxwriter',
] as const

function canonicalDistribution(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[._-]+/gu, '-')
}

function isClosedArtifactSet(artifacts: readonly Artifact[]): boolean {
  const actual = artifacts.map(artifact => canonicalDistribution(artifact.distribution)).sort()
  const expected = [...REQUIRED_DISTRIBUTIONS].sort()
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

const argumentsMap = new Map<string, string>()
for (let offset = 2; offset < process.argv.length; offset += 2) {
  const key = process.argv[offset]
  const value = process.argv[offset + 1]
  if (key === undefined || value === undefined || !key.startsWith('--')) {
    throw new Error('usage: prepare-python-runtime-overlay.ts --platform <darwin|win32> --arch <arm64|x64> --python <host-python> --wheelhouse <dir> --out <dir>')
  }
  argumentsMap.set(key.slice(2), value)
}

function required(name: string): string {
  const value = argumentsMap.get(name)
  if (value === undefined || value.trim() === '') throw new Error(`--${name} is required`)
  return value
}

const platform = required('platform') as Platform
const arch = required('arch') as Architecture
if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
  throw new Error('unsupported Python overlay target')
}
const targetKey = `${platform}-${arch}`
const hostPython = realpathSync(resolve(required('python')))
const wheelhouse = resolve(required('wheelhouse'))
const out = resolve(required('out'))
if (!existsSync(hostPython) || !lstatSync(hostPython).isFile()) throw new Error('host Python executable is absent')
mkdirSync(wheelhouse, { recursive: true })
mkdirSync(resolve(out, '..'), { recursive: true })

const manifestPath = resolve(import.meta.dirname, '../python-runtime-dependencies.json')
const manifestBytes = readFileSync(manifestPath)
const manifest = JSON.parse(manifestBytes.toString('utf8')) as DependencyManifest
const target = manifest.targets[targetKey]
if (manifest.schemaVersion !== 1 || manifest.pythonVersion !== '3.13' || target === undefined
  || !isClosedArtifactSet(target.artifacts) || target.abis.length === 0) {
  throw new Error(`Python dependency manifest is invalid for ${targetKey}`)
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function materializeWheel(artifact: Artifact): Promise<string> {
  if (!/^[0-9a-f]{64}$/u.test(artifact.sha256)
    || basename(artifact.filename) !== artifact.filename
    || !artifact.filename.endsWith('.whl')) throw new Error('Python dependency artifact identity is invalid')
  const wheel = join(wheelhouse, artifact.filename)
  if (existsSync(wheel) && digest(wheel) === artifact.sha256) return wheel
  const response = await fetch(artifact.url, { redirect: 'error' })
  if (!response.ok) throw new Error(`official Python wheel download failed: ${artifact.filename}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new Error(`official Python wheel digest mismatch: ${artifact.filename}`)
  }
  const temporary = `${wheel}.download-${String(process.pid)}`
  writeFileSync(temporary, bytes)
  renameSync(temporary, wheel)
  return wheel
}

function uniquePreviousPath(path: string): string {
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
  let candidate = `${path}.previous-${stamp}`
  let suffix = 0
  while (existsSync(candidate)) {
    suffix += 1
    candidate = `${path}.previous-${stamp}-${String(suffix)}`
  }
  return candidate
}

function walkFiles(root: string, current = root): string[] {
  const files: string[] = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(root, path))
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'))
    else throw new Error(`Python overlay contains unsupported entry: ${path}`)
  }
  return files.sort()
}

const wheels = [] as string[]
for (const artifact of target.artifacts) wheels.push(await materializeWheel(artifact))
const expectedWheelNames = new Set(target.artifacts.map(artifact => artifact.filename))
const actualWheelNames = readdirSync(wheelhouse).filter(name => name.endsWith('.whl')).sort()
if (actualWheelNames.length !== expectedWheelNames.size
  || actualWheelNames.some(name => !expectedWheelNames.has(name))) {
  throw new Error(`Python wheelhouse is not the pinned closed set: ${actualWheelNames.join(', ')}`)
}
const candidate = `${out}.candidate-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${String(process.pid)}`
if (existsSync(candidate)) throw new Error('Python overlay candidate already exists')
mkdirSync(candidate, { recursive: true })
execFileSync(hostPython, [
  '-m', 'pip', 'install',
  '--no-index', '--find-links', wheelhouse,
  '--no-deps', '--no-compile', '--only-binary=:all:',
  '--platform', target.pipPlatform,
  '--implementation', 'cp',
  '--python-version', manifest.pythonVersion,
  ...target.abis.flatMap(value => ['--abi', value]),
  '--target', candidate,
  ...target.artifacts.map(artifact => `${artifact.distribution}==${artifact.version}`),
], {
  stdio: 'inherit',
  env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONDONTWRITEBYTECODE: '1' },
})
// pip emits console scripts for imported libraries. They are not part of the
// pinned overlay, but remain recoverable if a packaging investigation needs them.
moveGeneratedPathToTrash(join(candidate, 'bin'))
const expectedTopLevel = new Set(target.artifacts.flatMap(artifact => artifact.topLevel))
const actualTopLevel = readdirSync(candidate).sort()
if (actualTopLevel.length !== expectedTopLevel.size
  || actualTopLevel.some(name => !expectedTopLevel.has(name))) {
  throw new Error(`Python overlay top-level set is not pinned: ${actualTopLevel.join(', ')}`)
}
for (const artifact of target.artifacts) {
  for (const license of artifact.licenseFiles ?? []) {
    const path = join(candidate, license)
    if (license.startsWith('/') || license.includes('\\') || license.split('/').includes('..')
      || !existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(`Python dependency license file is absent: ${artifact.distribution}`)
    }
  }
}
const files = Object.fromEntries(walkFiles(candidate).map(path => [path, digest(join(candidate, path))]))
let previous: string | undefined
try {
  if (existsSync(out)) {
    previous = uniquePreviousPath(out)
    renameSync(out, previous)
  }
  renameSync(candidate, out)
} catch (error: unknown) {
  if (previous !== undefined && !existsSync(out) && existsSync(previous)) renameSync(previous, out)
  throw error
}
writeFileSync(`${out}-receipt.json`, `${JSON.stringify({
  schemaVersion: 1,
  target: targetKey,
  pythonVersion: manifest.pythonVersion,
  manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  wheels: target.artifacts.map((artifact, index) => ({
    filename: artifact.filename,
    sha256: artifact.sha256,
    sourceUrl: artifact.url,
    installedFrom: wheels[index],
  })),
  files,
}, null, 2)}\n`)
