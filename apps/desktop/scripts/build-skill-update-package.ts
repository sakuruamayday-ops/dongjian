/** Build the root-level ZIP consumed by the desktop skill updater. */

import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { verifyStagedSkillSuite } from '../../../product/gongchuang-client/src/skill-suite-verifier.ts'

const args = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (key === undefined || value === undefined || !key.startsWith('--')) {
    throw new Error(
      'usage: build-skill-update-package.ts --source <staged-root> --out <zip>'
        + ' --expected-version <x.y.z> --expected-public-key-sha256 <sha256>',
    )
  }
  args.set(key.slice(2), value)
}

function required(name: string): string {
  const value = args.get(name)
  if (value === undefined || value.trim() === '') throw new Error(`--${name} is required`)
  return value
}

function walk(root: string, current = root): string[] {
  const files: string[] = []
  for (const name of readdirSync(current).sort()) {
    const absolute = resolve(current, name)
    const info = lstatSync(absolute)
    if (info.isSymbolicLink()) throw new Error(`staged skill suite contains a symlink: ${relative(root, absolute)}`)
    if (info.isDirectory()) files.push(...walk(root, absolute))
    else if (info.isFile()) files.push(relative(root, absolute).split(sep).join('/'))
    else throw new Error(`staged skill suite contains an unsupported entry: ${relative(root, absolute)}`)
  }
  return files
}

const source = resolve(required('source'))
const out = resolve(required('out'))
const expectedVersion = required('expected-version')
const expectedPublicKeySha256 = required('expected-public-key-sha256')
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(expectedVersion)) {
  throw new Error('--expected-version must be a three-part semantic version')
}
if (!/^[0-9a-f]{64}$/u.test(expectedPublicKeySha256)) {
  throw new Error('--expected-public-key-sha256 must be a lowercase SHA-256 digest')
}
if (!statSync(source).isDirectory()) throw new Error('--source must be a staged skill-suite directory')
if (!out.endsWith('.zip')) throw new Error('--out must end in .zip')

const verified = verifyStagedSkillSuite(source, {
  expectedPublicKeySha256,
  expectedSigningTier: 'formal',
})
if (verified.version !== expectedVersion) {
  throw new Error(`staged skill suite must be V${expectedVersion}`)
}

// The desktop updater expects these files at ZIP root. A generic release ZIP
// has a wrapper directory and a different signature, so it must not be reused.
// `config/common.yaml` is a packaging-time resource for the bundled suite.
// The released V0.4.1 updater deliberately accepts only its four signed root
// files plus `skills/**`, so carrying that file makes every download fail.
const paths = walk(source).filter(path => path !== 'config/common.yaml')
const sourceFiles = Object.fromEntries(paths.map(path => [
  path,
  readFileSync(resolve(source, path)),
])) as Record<string, Uint8Array>
// ZIP stores local DOS time. Fixed local fields give identical bytes across
// rebuilds and time zones without changing any signed file in the archive.
const archive = Buffer.from(zipSync(sourceFiles, { level: 6, mtime: new Date(1980, 0, 1) }))
const extracted = unzipSync(archive)
if (Object.keys(extracted).sort().join('\n') !== paths.join('\n')) {
  throw new Error('skill update ZIP changed the staged file inventory')
}
for (const path of paths) {
  if (Buffer.compare(Buffer.from(extracted[path] ?? []), Buffer.from(sourceFiles[path] ?? [])) !== 0) {
    throw new Error(`skill update ZIP changed ${path}`)
  }
}

if (existsSync(out)) {
  if (Buffer.compare(readFileSync(out), archive) !== 0) {
    throw new Error('the output path already contains different bytes')
  }
} else {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, archive, { flag: 'wx', mode: 0o644 })
}

process.stdout.write(`${JSON.stringify({
  status: 'verified',
  version: verified.version,
  skillCount: verified.skillCount,
  fileCount: paths.length,
  archive: out,
  archiveBytes: archive.length,
  archiveSha256: createHash('sha256').update(archive).digest('hex'),
}, null, 2)}\n`)
