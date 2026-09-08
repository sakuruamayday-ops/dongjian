/** Copy, index, and Ed25519-sign one platform's Python document runtime. */

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { inspectPaddleOcrMcpRuntime } from '../src/product-runtime-verifier.ts'
import { GONGCHUANG_CLIENT_VERSION } from '../src/product-version.ts'
import { signMacRuntimeCode } from './macos-runtime-code-signing.ts'

type Platform = 'darwin' | 'win32'
type Architecture = 'arm64' | 'x64'
type SigningTier = 'development-candidate' | 'formal'

interface RuntimeIndex {
  schemaVersion: 2
  productId: 'cn.dongjian.desktop'
  clientVersion: typeof GONGCHUANG_CLIENT_VERSION
  platform: Platform
  arch: Architecture
  signingTier: SigningTier
  executables: { python: string }
  files: Record<string, string>
  links: Record<string, string>
}

interface PythonDependencyArtifact {
  distribution: string
  version: string
  wheelTag: string
  topLevel: string[]
  licenseFiles?: string[]
}

interface PythonDependencyManifest {
  schemaVersion: number
  pythonVersion: string
  targets: Record<string, { artifacts: PythonDependencyArtifact[] }>
}

const REQUIRED_PYTHON_DISTRIBUTIONS = [
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

const args = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (key === undefined || value === undefined || !key.startsWith('--')) {
    throw new Error('usage: stage-product-runtime.ts --python <runtime-root> --python-overlay <dependency-root> --out <dir> --key <external.pem> --tier <development-candidate|formal> --platform <darwin|win32> --arch <arm64|x64> [--macos-entitlements <plist>]')
  }
  args.set(key.slice(2), value)
}

function required(name: string): string {
  const value = args.get(name)
  if (value === undefined || value.trim() === '') throw new Error(`--${name} is required`)
  return value
}

function closedValue<T extends string>(name: string, allowed: readonly T[]): T {
  const value = required(name)
  if (!allowed.includes(value as T)) throw new Error(`--${name} is invalid`)
  return value as T
}

const pythonSource = realpathSync(resolve(required('python')))
const out = resolve(required('out'))
const keyPath = resolve(required('key'))
const tier = closedValue<SigningTier>('tier', ['development-candidate', 'formal'])
const platform = closedValue<Platform>('platform', ['darwin', 'win32'])
const arch = closedValue<Architecture>('arch', ['arm64', 'x64'])
const pythonOverlaySource = realpathSync(resolve(required('python-overlay')))
const macosEntitlementsPath = platform === 'darwin'
  ? resolve(required('macos-entitlements'))
  : undefined
const repositoryRoot = resolve(import.meta.dirname, '../../..')
for (const [label, source] of [
  ['python', pythonSource],
  ['python overlay', pythonOverlaySource],
] as const) {
  if (!statSync(source).isDirectory()) throw new Error(`${label} runtime source must be a directory`)
}
const keyInfo = lstatSync(keyPath)
if (keyInfo.isSymbolicLink() || !keyInfo.isFile()) {
  throw new Error('private signing key must be a regular file and not a symbolic link')
}
const keyRelative = relative(repositoryRoot, keyPath)
if (keyRelative === '' || (!keyRelative.startsWith('..') && !keyRelative.startsWith(`..${sep}`))) {
  throw new Error('private signing keys must stay outside the repository')
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

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (!child.startsWith('..') && !child.startsWith(`..${sep}`) && !child.includes(`..${sep}`))
}

function copyTree(sourceRoot: string, destinationRoot: string): void {
  const copyEntry = (source: string, destination: string, ancestors: readonly string[]): void => {
    const info = lstatSync(source)
    if (info.isSymbolicLink()) {
      const target = realpathSync(source)
      if (!contained(sourceRoot, target)) throw new Error(`runtime symlink escapes source root: ${source}`)
      const targetInfo = statSync(target)
      if (platform === 'darwin') {
        if (!targetInfo.isDirectory() && !targetInfo.isFile()) {
          throw new Error(`runtime symlink target has unsupported type: ${source}`)
        }
        mkdirSync(dirname(destination), { recursive: true })
        const portableTarget = relative(dirname(source), target)
        if (portableTarget === '') throw new Error(`runtime symlink resolves to itself: ${source}`)
        symlinkSync(portableTarget, destination, targetInfo.isDirectory() ? 'dir' : 'file')
      } else if (targetInfo.isDirectory()) copyDirectory(target, destination, ancestors)
      else if (targetInfo.isFile()) {
        mkdirSync(dirname(destination), { recursive: true })
        copyFileSync(target, destination)
        chmodSync(destination, targetInfo.mode & 0o777)
      } else throw new Error(`runtime symlink target has unsupported type: ${source}`)
      return
    }
    if (info.isDirectory()) copyDirectory(source, destination, ancestors)
    else if (info.isFile()) {
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(source, destination)
      chmodSync(destination, info.mode & 0o777)
    } else throw new Error(`runtime source contains unsupported type: ${source}`)
  }

  const copyDirectory = (source: string, destination: string, ancestors: readonly string[]): void => {
    const realSource = realpathSync(source)
    if (ancestors.includes(realSource)) throw new Error(`runtime symlink cycle detected: ${source}`)
    mkdirSync(destination, { recursive: true })
    const nextAncestors = [...ancestors, realSource]
    for (const name of readdirSync(source).sort()) {
      copyEntry(join(source, name), join(destination, name), nextAncestors)
    }
  }

  copyDirectory(sourceRoot, destinationRoot, [])
}

let trashSequence = 0
let pruningTrashRoot: string | undefined
let recycleWindowsPruningRoot = false

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

function recycleWindowsDirectory(path: string): void {
  const encoded = Buffer.from(windowsRecycleScript(path), 'utf16le').toString('base64')
  execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], { stdio: 'pipe', windowsHide: true })
}

/** Finish the native Windows staging bucket through the system Recycle Bin. */
function finishPruningTrash(): void {
  if (!recycleWindowsPruningRoot || pruningTrashRoot === undefined || !existsSync(pruningTrashRoot)) return
  recycleWindowsDirectory(pruningTrashRoot)
}

function moveRuntimeDirectoryToTrash(path: string, reason: 'failed-candidate' | 'previous'): void {
  if (!existsSync(path)) return
  const configured = process.env.GONGCHUANG_STAGE_TRASH_ROOT?.trim()
  if ((configured === undefined || configured === '') && process.platform === 'win32') {
    recycleWindowsDirectory(path)
    return
  }
  let trashHome: string
  if (configured !== undefined && configured !== '') trashHome = resolve(configured)
  else if (process.platform === 'darwin') trashHome = join(homedir(), '.Trash')
  else throw new Error('GONGCHUANG_STAGE_TRASH_ROOT must name the system Trash outside macOS')
  mkdirSync(trashHome, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
  let destination = join(trashHome, `gongchuang-runtime-${reason}-${stamp}-${String(process.pid)}-${basename(path)}`)
  let suffix = 0
  while (existsSync(destination)) {
    suffix += 1
    destination = join(
      trashHome,
      `gongchuang-runtime-${reason}-${stamp}-${String(process.pid)}-${String(suffix)}-${basename(path)}`,
    )
  }
  renameSync(path, destination)
}

/** Move the superseded complete runtime to a recoverable system trash location. */
function movePreviousRuntimeToTrash(path: string): void {
  moveRuntimeDirectoryToTrash(path, 'previous')
}

/** Keep a failed partial runtime recoverable without leaving gigabytes beside the build output. */
function moveFailedRuntimeCandidateToTrash(path: string): void {
  moveRuntimeDirectoryToTrash(path, 'failed-candidate')
}

/** Move staging-only exclusions out of the signed tree without permanently deleting them. */
function moveStagingEntryToTrash(path: string): void {
  if (!existsSync(path)) return
  if (pruningTrashRoot === undefined) {
    const configured = process.env.GONGCHUANG_STAGE_TRASH_ROOT?.trim()
    let trashHome: string
    if (configured === undefined || configured === '') {
      if (process.platform === 'win32') {
        // Rename every exclusion into one same-volume bucket first, then send
        // that bucket to the native Recycle Bin once staging has succeeded.
        // This avoids one PowerShell process per Python cache file.
        trashHome = dirname(out)
        recycleWindowsPruningRoot = true
      } else if (process.platform !== 'darwin') {
        throw new Error('GONGCHUANG_STAGE_TRASH_ROOT must name the system Trash outside macOS')
      } else {
        trashHome = join(homedir(), '.Trash')
      }
    } else {
      trashHome = resolve(configured)
    }
    const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
    pruningTrashRoot = join(trashHome, `gongchuang-runtime-stage-${stamp}-${String(process.pid)}`)
    mkdirSync(pruningTrashRoot, { recursive: false })
  }
  trashSequence += 1
  const trashedName = `${String(trashSequence).padStart(6, '0')}-${basename(path)}`
  renameSync(path, join(pruningTrashRoot, trashedName))
}

function removeIfPresent(path: string): void {
  moveStagingEntryToTrash(path)
}

function pruneRedundantPythonBytecode(root: string): void {
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        visit(path)
        if (entry.name === '__pycache__') {
          if (readdirSync(path).length !== 0) {
            throw new Error(`Python cache directory contains a non-bytecode entry: ${path}`)
          }
          moveStagingEntryToTrash(path)
        }
        continue
      }
      if (!entry.isFile() || (!entry.name.endsWith('.pyc') && !entry.name.endsWith('.pyo'))) continue
      const cacheParent = basename(dirname(path)) === '__pycache__'
      const tagged = /^(.*)\.cpython-\d+(?:\.opt-\d+)?\.(?:pyc|pyo)$/u.exec(entry.name)
      const source = cacheParent
        ? tagged === null ? undefined : join(dirname(dirname(path)), `${tagged[1]}.py`)
        : path.slice(0, -1)
      // Only discard compiled copies when the matching source is present.
      // Bytecode without retained source is rejected by the size/caching hygiene step.
      if (source === undefined || !existsSync(source) || !lstatSync(source).isFile()) {
        throw new Error(`Python bytecode has no retained source file: ${path}`)
      }
      moveStagingEntryToTrash(path)
    }
  }
  visit(root)
}

function assertNoPythonBytecode(root: string): void {
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')) {
        throw new Error(`staged Python runtime contains generated bytecode: ${path}`)
      }
      if (entry.isDirectory()) visit(path)
    }
  }
  visit(root)
}

/** Remove package installers from the immutable runtime and unused Windows launchers from setuptools. */
function pruneRuntimePackageInstallers(root: string): void {
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        const portable = relative(root, path).split(sep).join('/').toLowerCase()
        const packageInstaller = /\/site-packages\/pip$/u.test(portable)
          || /\/site-packages\/pip-[^/]+\.dist-info$/u.test(portable)
          || /\/(?:lib\/python\d+(?:\.\d+)?|lib)\/ensurepip$/u.test(portable)
        if (packageInstaller) {
          removeIfPresent(path)
          continue
        }
        visit(path)
        continue
      }
      if (!entry.isFile()) continue
      const parent = relative(root, dirname(path)).split(sep).join('/').toLowerCase()
      const pipLauncher = /\/(?:bin|scripts)$/u.test(parent)
        && /^pip(?:3(?:\.\d+)?)?(?:\.exe)?$/iu.test(entry.name)
      const setuptoolsLauncher = platform === 'win32' && parent.endsWith('/setuptools')
        && /^(?:cli|gui)(?:-(?:32|64|arm64))?\.exe$/iu.test(entry.name)
      if (pipLauncher || setuptoolsLauncher) moveStagingEntryToTrash(path)
    }
  }
  visit(root)
}

function replaceIdenticalFileWithLink(path: string, canonical: string, target: string): void {
  if (!existsSync(path) || !existsSync(canonical)) return
  const info = lstatSync(path)
  const canonicalInfo = lstatSync(canonical)
  if (!info.isFile() || !canonicalInfo.isFile()) return
  const left = createHash('sha256').update(readFileSync(path)).digest('hex')
  const right = createHash('sha256').update(readFileSync(canonical)).digest('hex')
  if (left !== right) return
  moveStagingEntryToTrash(path)
  symlinkSync(target, path, 'file')
}

function materializeContainedExecutableLink(root: string, path: string): void {
  if (!existsSync(path) || !lstatSync(path).isSymbolicLink()) return
  const source = realpathSync(path)
  if (!contained(realpathSync(root), source) || !statSync(source).isFile()) {
    throw new Error(`runtime executable link has an invalid target: ${path}`)
  }
  const temporary = `${path}.materialized-${String(process.pid)}`
  copyFileSync(source, temporary)
  chmodSync(temporary, statSync(source).mode & 0o777)
  moveStagingEntryToTrash(path)
  renameSync(temporary, path)
}

function locatePaddleSitePackages(pythonRoot: string): string | undefined {
  const visit = (current: string): string | undefined => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name)
      const info = lstatSync(path)
      if (info.isSymbolicLink() || !info.isDirectory()) continue
      if (name === 'site-packages' && existsSync(join(path, 'paddleocr_mcp'))) return path
      const nested = visit(path)
      if (nested !== undefined) return nested
    }
    return undefined
  }
  return visit(pythonRoot)
}

function canonicalDistribution(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[._-]+/gu, '-')
}

function isClosedPythonArtifactSet(artifacts: readonly PythonDependencyArtifact[]): boolean {
  const actual = artifacts.map(artifact => canonicalDistribution(artifact.distribution)).sort()
  const expected = [...REQUIRED_PYTHON_DISTRIBUTIONS].sort()
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function entriesAreIdentical(source: string, destination: string): boolean {
  const sourceInfo = lstatSync(source)
  const destinationInfo = lstatSync(destination)
  if (sourceInfo.isSymbolicLink() || destinationInfo.isSymbolicLink()) {
    return sourceInfo.isSymbolicLink()
      && destinationInfo.isSymbolicLink()
      && readlinkSync(source) === readlinkSync(destination)
  }
  if (sourceInfo.isFile() || destinationInfo.isFile()) {
    return sourceInfo.isFile()
      && destinationInfo.isFile()
      && sourceInfo.size === destinationInfo.size
      && readFileSync(source).equals(readFileSync(destination))
  }
  if (!sourceInfo.isDirectory() || !destinationInfo.isDirectory()) return false
  const sourceNames = readdirSync(source).sort()
  const destinationNames = readdirSync(destination).sort()
  return sourceNames.length === destinationNames.length
    && sourceNames.every((name, index) => (
      name === destinationNames[index]
      && entriesAreIdentical(join(source, name), join(destination, name))
    ))
}

function normalizedInstallerRecord(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter(line => line !== '')
    .map((line) => {
      const separator = line.indexOf(',')
      if (separator < 0) return line
      const recordPath = line.slice(0, separator)
      // pip rewrites hashes and sizes for launchers installed outside site-packages.
      // Those launchers are not supplied by this overlay; every in-package RECORD
      // entry must still match byte-for-byte before the runtime can be signed.
      return recordPath.startsWith('../') ? recordPath : line
    })
}

function distInfoEntriesAreEquivalent(source: string, destination: string): boolean {
  const sourceNames = readdirSync(source).sort()
  const destinationNames = readdirSync(destination).sort()
  if (sourceNames.length !== destinationNames.length
    || sourceNames.some((name, index) => name !== destinationNames[index])) return false
  return sourceNames.every((name) => {
    const sourceEntry = join(source, name)
    const destinationEntry = join(destination, name)
    if (name !== 'RECORD') return entriesAreIdentical(sourceEntry, destinationEntry)
    const sourceRecord = normalizedInstallerRecord(sourceEntry)
    const destinationRecord = normalizedInstallerRecord(destinationEntry)
    return sourceRecord.length === destinationRecord.length
      && sourceRecord.every((line, index) => line === destinationRecord[index])
  })
}

/** Merge the small, hash-pinned build overlay required by signed skill scripts. */
function installPinnedPythonOverlay(pythonRoot: string): void {
  const manifest = JSON.parse(readFileSync(
    resolve(import.meta.dirname, '../python-runtime-dependencies.json'),
    'utf8',
  )) as PythonDependencyManifest
  const target = manifest.targets[`${platform}-${arch}`]
  if (manifest.schemaVersion !== 1 || manifest.pythonVersion !== '3.13'
    || target === undefined || !isClosedPythonArtifactSet(target.artifacts)) {
    throw new Error('Python dependency manifest does not match the staged runtime')
  }
  const sitePackages = locatePaddleSitePackages(pythonRoot)
  if (sitePackages === undefined) throw new Error('staged Python site-packages directory is absent')
  const expectedTopLevel = new Set(target.artifacts.flatMap(artifact => artifact.topLevel))
  const overlayTopLevel = readdirSync(pythonOverlaySource).sort()
  if (overlayTopLevel.length !== expectedTopLevel.size
    || overlayTopLevel.some(name => !expectedTopLevel.has(name))) {
    throw new Error(`Python dependency overlay is not the pinned closed set: ${overlayTopLevel.join(', ')}`)
  }
  for (const name of overlayTopLevel) {
    const destination = join(sitePackages, name)
    const source = join(pythonOverlaySource, name)
    if (existsSync(destination)) {
      const equivalent = entriesAreIdentical(source, destination)
        || (name.endsWith('.dist-info') && distInfoEntriesAreEquivalent(source, destination))
      if (!equivalent) {
        throw new Error(`Python dependency overlay conflicts with an existing package: ${name}`)
      }
      continue
    }
    const info = lstatSync(source)
    if (info.isDirectory()) copyTree(source, destination)
    else if (info.isFile()) {
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(source, destination)
    } else throw new Error(`Python dependency overlay contains an unsupported entry: ${name}`)
  }
  for (const artifact of target.artifacts) {
    const distInfoName = artifact.topLevel.find(name => name.endsWith('.dist-info'))
    if (distInfoName === undefined) throw new Error(`Python dependency has no dist-info identity: ${artifact.distribution}`)
    const metadata = readFileSync(join(sitePackages, distInfoName, 'METADATA'), 'utf8')
    const wheel = readFileSync(join(sitePackages, distInfoName, 'WHEEL'), 'utf8')
    const name = /^Name:\s*(.+)$/imu.exec(metadata)?.[1] ?? ''
    const version = /^Version:\s*(.+)$/imu.exec(metadata)?.[1] ?? ''
    const tags = [...wheel.matchAll(/^Tag:\s*(.+)$/gmu)].map(match => match[1]?.trim())
    if (canonicalDistribution(name) !== canonicalDistribution(artifact.distribution)
      || version.trim() !== artifact.version || !tags.includes(artifact.wheelTag)) {
      throw new Error(`Python dependency overlay identity mismatch: ${artifact.distribution}`)
    }
    for (const license of artifact.licenseFiles ?? []) {
      const path = join(sitePackages, license)
      if (license.startsWith('/') || license.includes('\\') || license.split('/').includes('..')
        || !existsSync(path) || !lstatSync(path).isFile()) {
        throw new Error(`Python dependency overlay license is absent: ${artifact.distribution}`)
      }
    }
  }
  for (const requiredPath of [
    'docx/__init__.py',
    'lxml/__init__.py',
    'fitz/__init__.py',
    'pymupdf/__init__.py',
    'openpyxl/__init__.py',
    'xlrd/__init__.py',
    'et_xmlfile/__init__.py',
    'pptx/__init__.py',
    'PIL/__init__.py',
    'xlsxwriter/__init__.py',
    'python_pptx-1.0.2.dist-info/METADATA',
    'pillow-12.3.0.dist-info/METADATA',
    'xlsxwriter-3.2.5.dist-info/METADATA',
    'typing_extensions.py',
    'typing_extensions-4.16.0.dist-info/METADATA',
  ]) {
    if (!existsSync(join(sitePackages, requiredPath))) {
      throw new Error(`staged Python dependency closure is incomplete: ${requiredPath}`)
    }
  }
}

/**
 * The product only exposes PaddleOCR through AI Studio.  Upstream 0.8.5
 * eagerly imports the optional local OCR class even for that cloud route,
 * which otherwise drags OpenCV, PaddleX, ModelScope and their data stack into
 * every installer.  Make that single optional import lazy, then remove only
 * the packages proven to belong to the unsupported local inference route.
 */
function slimCloudOnlyPython(pythonRoot: string): void {
  const sitePackages = locatePaddleSitePackages(pythonRoot)
  if (sitePackages === undefined) return

  const localOcr = join(sitePackages, 'paddleocr_mcp', 'inference', 'ocr', 'local.py')
  if (existsSync(localOcr)) {
    const source = readFileSync(localOcr, 'utf8')
    const eagerImport = /^from paddleocr import PaddleOCR\n/mu
    const startMarker = '    async def start(self) -> None:\n'
    const lazyImport = `${startMarker}        from paddleocr import PaddleOCR\n\n`
    if (eagerImport.test(source)) {
      if (!source.includes(startMarker)) throw new Error('PaddleOCR MCP local adapter shape changed')
      writeFileSync(localOcr, source.replace(eagerImport, '').replace(startMarker, lazyImport))
    } else if (!source.includes(lazyImport)) {
      throw new Error('PaddleOCR MCP local adapter no longer has the reviewed import shape')
    }
  }

  const localOnly = [
    /^cv2$/u,
    /^opencv[_-]contrib[_-]python-.+\.dist-info$/u,
    /^pandas(?:\.libs)?$/u,
    /^pandas-.+\.dist-info$/u,
    /^paddlex$/u,
    /^paddlex-.+\.dist-info$/u,
    /^modelscope$/u,
    /^modelscope-.+\.dist-info$/u,
    /^modelscope_hub$/u,
    /^modelscope[_-]hub-.+\.dist-info$/u,
    /^huggingface_hub$/u,
    /^huggingface[_-]hub-.+\.dist-info$/u,
    /^hf_xet$/u,
    /^hf[_-]xet-.+\.dist-info$/u,
    /^shapely(?:\.libs)?$/u,
    /^shapely-.+\.dist-info$/u,
    /^pyclipper$/u,
    /^pyclipper-.+\.dist-info$/u,
    /^fsspec$/u,
    /^fsspec-.+\.dist-info$/u,
    /^filelock$/u,
    /^filelock-.+\.dist-info$/u,
  ]
  for (const name of readdirSync(sitePackages)) {
    if (localOnly.some(pattern => pattern.test(name))) removeIfPresent(join(sitePackages, name))
  }

  for (const current of readdirSync(sitePackages, { withFileTypes: true })) {
    if (!current.isDirectory() || !['test', 'tests', 'testing'].includes(current.name)) continue
    removeIfPresent(join(sitePackages, current.name))
  }
  const removeNestedTests = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (!entry.isDirectory()) continue
      if (['test', 'tests', 'testing', '__pycache__'].includes(entry.name)) removeIfPresent(path)
      else removeNestedTests(path)
    }
  }
  removeNestedTests(sitePackages)

  removeIfPresent(join(pythonRoot, 'include'))
  removeIfPresent(join(pythonRoot, 'share', 'man'))
  removeIfPresent(join(pythonRoot, 'lib', 'pkgconfig'))

  if (platform === 'darwin') {
    const bin = join(pythonRoot, 'bin')
    const canonical = join(bin, 'python3')
    // python-build-standalone publishes python3 as an internal symlink, while
    // the signed runtime index intentionally anchors a regular executable.
    // Materialize only that anchor and deduplicate the two aliases around it.
    materializeContainedExecutableLink(pythonRoot, canonical)
    const pythonAlias = join(bin, 'python')
    if (existsSync(pythonAlias) && lstatSync(pythonAlias).isSymbolicLink()) {
      moveStagingEntryToTrash(pythonAlias)
      symlinkSync('python3', pythonAlias, 'file')
    }
    replaceIdenticalFileWithLink(pythonAlias, canonical, 'python3')
    for (const name of readdirSync(bin)) {
      if (/^python3\.\d+$/u.test(name)) replaceIdenticalFileWithLink(join(bin, name), canonical, 'python3')
    }
  }
}

function walk(root: string, current = root): { files: string[]; links: Record<string, string> } {
  const files: string[] = []
  const links: Record<string, string> = {}
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name)
    const info = lstatSync(absolute)
    const portable = relative(root, absolute).split(sep).join('/')
    if (info.isSymbolicLink()) {
      const target = readlinkSync(absolute)
      if (resolve(dirname(absolute), target) === absolute || !contained(root, resolve(dirname(absolute), target))) {
        throw new Error(`staged runtime symlink escapes its signed tree: ${absolute}`)
      }
      links[portable] = target.split(sep).join('/')
    } else if (info.isDirectory()) {
      const nested = walk(root, absolute)
      files.push(...nested.files)
      Object.assign(links, nested.links)
    } else if (info.isFile()) files.push(portable)
    else throw new Error(`staged runtime contains unsupported type: ${absolute}`)
  }
  return { files, links }
}

for (const source of [pythonSource, pythonOverlaySource]) {
  if (contained(source, out) || contained(out, source)) {
    throw new Error('output directory must not contain, or be contained by, a runtime source')
  }
}
mkdirSync(dirname(out), { recursive: true })
const stagingOut = `${out}.candidate-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${String(process.pid)}`
if (existsSync(stagingOut)) throw new Error(`runtime staging directory already exists: ${stagingOut}`)
const filesRoot = join(stagingOut, 'files')
const pythonDestination = join(filesRoot, 'python')
try {
  copyTree(pythonSource, pythonDestination)
  installPinnedPythonOverlay(pythonDestination)
  slimCloudOnlyPython(pythonDestination)
  pruneRuntimePackageInstallers(filesRoot)
  pruneRedundantPythonBytecode(filesRoot)
  // The signed tree is immutable after staging.  Fail before indexing if a
  // future staging hook/import ever creates bytecode that would later drift the
  // file inventory on first launch.
  assertNoPythonBytecode(filesRoot)

  const pythonExecutable = platform === 'win32' ? 'python/python.exe' : 'python/bin/python3'
  for (const executable of [pythonExecutable]) {
    const path = join(filesRoot, executable)
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`staged runtime executable is absent: ${executable}`)
  }

  const paths = walk(filesRoot)
  inspectPaddleOcrMcpRuntime(filesRoot, paths.files)
  const machOFileCount = macosEntitlementsPath === undefined
    ? 0
    : signMacRuntimeCode(filesRoot, paths.files, macosEntitlementsPath).length
  const files = Object.fromEntries(paths.files.map(path => [
    path,
    createHash('sha256').update(readFileSync(join(filesRoot, path))).digest('hex'),
  ]))
  const runtimeIndex: RuntimeIndex = {
    schemaVersion: 2,
    productId: 'cn.dongjian.desktop',
    clientVersion: GONGCHUANG_CLIENT_VERSION,
    platform,
    arch,
    signingTier: tier,
    executables: { python: pythonExecutable },
    files,
    links: paths.links,
  }
  const indexBytes = Buffer.from(`${JSON.stringify(runtimeIndex, null, 2)}\n`)
  const privateKey = createPrivateKey(readFileSync(keyPath))
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
  writeFileSync(join(stagingOut, 'runtime-index.json'), indexBytes)
  writeFileSync(join(stagingOut, 'runtime-index.sig'), `${sign(null, indexBytes, privateKey).toString('base64')}\n`)
  writeFileSync(join(stagingOut, 'runtime-index.pub.pem'), publicPem)
  writeFileSync(join(stagingOut, 'staging-receipt.json'), `${JSON.stringify({
    schemaVersion: 2,
    productId: runtimeIndex.productId,
    clientVersion: runtimeIndex.clientVersion,
    platform,
    arch,
    signingTier: tier,
    indexSha256: createHash('sha256').update(indexBytes).digest('hex'),
    publicKeySha256: createHash('sha256').update(publicPem).digest('hex'),
    fileCount: paths.files.length,
    linkCount: Object.keys(paths.links).length,
    machOFileCount,
  }, null, 2)}\n`)
} catch (error: unknown) {
  const cleanupErrors: unknown[] = []
  try {
    finishPruningTrash()
  } catch (cleanupError: unknown) {
    cleanupErrors.push(cleanupError)
  }
  try {
    moveFailedRuntimeCandidateToTrash(stagingOut)
  } catch (cleanupError: unknown) {
    cleanupErrors.push(cleanupError)
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError([error, ...cleanupErrors], 'runtime staging and recoverable cleanup both failed')
  }
  throw error
}

// Native Windows has no ordinary filesystem path for its Recycle Bin. Keep
// the promoted output untouched if the shell refuses the recoverable move.
finishPruningTrash()

let previous: string | undefined
try {
  if (existsSync(out)) {
    previous = uniquePreviousPath(out)
    renameSync(out, previous)
  }
  renameSync(stagingOut, out)
  // Promotion is now committed. Keeping the superseded full runtime beside the
  // output made every successful release consume another complete runtime; it
  // is recoverable from system Trash instead and never removed permanently.
  if (previous !== undefined) movePreviousRuntimeToTrash(previous)
} catch (error: unknown) {
  if (previous !== undefined && !existsSync(out) && existsSync(previous)) renameSync(previous, out)
  throw error
}
