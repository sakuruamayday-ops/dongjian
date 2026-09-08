import { createHash, generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { FileSystemSkillProvider } from '../../../packages/skill/skill-filesystem/src/index.ts'
import {
  GONGCHUANG_SKILL_BUNDLE_VERSION,
} from '../../../product/gongchuang-client/src/product-version.ts'
import { verifyStagedSkillSuite } from '../../../product/gongchuang-client/src/skill-suite-verifier.ts'

const script = resolve(import.meta.dirname, '../../../product/gongchuang-client/scripts/stage-skill-suite.ts')
const archiveScript = resolve(import.meta.dirname, '../scripts/build-skill-update-package.ts')
const FIXTURE_SKILL_COUNT = 3

function fixture(): {
  root: string
  source: string
  out: string
  trash: string
  key: string
  publicKeySha256: string
  firstSkill: string
} {
  const root = mkdtempSync(join(tmpdir(), 'gongchuang-stage-skills-'))
  const source = join(root, 'source')
  const out = join(root, 'product-skills')
  const trash = join(root, 'Trash')
  const skills = Array.from(
    { length: FIXTURE_SKILL_COUNT },
    (_, index) => `fixture-skill-${String(index + 1).padStart(2, '0')}`,
  )
  const firstSkill = skills[0]
  if (firstSkill === undefined) throw new Error('skill-suite fixture must contain at least one skill')
  for (const skill of skills) {
    const path = join(source, skill, 'SKILL.md')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `---\nname: ${skill}\ndescription: Fixture skill.\n---\n\nfirst revision\n`)
  }
  writeFileSync(join(source, 'suite-manifest.json'), `${JSON.stringify({
    release: {
      version: GONGCHUANG_SKILL_BUNDLE_VERSION,
      tag: `V${GONGCHUANG_SKILL_BUNDLE_VERSION}`,
    },
    skills,
  }, null, 2)}\n`)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const key = join(root, 'skill-signing.pem')
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const publicPem = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }))
  return {
    root,
    source,
    out,
    trash,
    key,
    publicKeySha256: createHash('sha256').update(publicPem).digest('hex'),
    firstSkill,
  }
}

function stage(
  paths: ReturnType<typeof fixture>,
  options: {
    out?: string
    trash?: string
    purpose?: 'bundled' | 'independent-update'
    expectedVersion?: string
  } = {},
): void {
  const argv = [
    '--import', 'tsx/esm', script,
    '--source', paths.source,
    '--out', options.out ?? paths.out,
    '--key', paths.key,
    '--tier', 'development-candidate',
  ]
  if (options.purpose !== undefined) argv.push('--purpose', options.purpose)
  if (options.expectedVersion !== undefined) argv.push('--expected-version', options.expectedVersion)
  execFileSync(process.execPath, argv, {
    stdio: 'pipe',
    env: {
      ...process.env,
      GONGCHUANG_STAGE_TRASH_ROOT: options.trash ?? paths.trash,
    },
  })
}

function setSuiteVersion(paths: ReturnType<typeof fixture>, version: string): void {
  const manifestPath = join(paths.source, 'suite-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    release: { version: string; tag: string }
  }
  manifest.release = { version, tag: `V${version}` }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function updateFirstSkill(paths: ReturnType<typeof fixture>): void {
  writeFileSync(
    join(paths.source, paths.firstSkill, 'SKILL.md'),
    `---\nname: ${paths.firstSkill}\ndescription: Fixture skill.\n---\n\nsecond revision\n`,
  )
}

function verify(paths: ReturnType<typeof fixture>): void {
  expect(verifyStagedSkillSuite(paths.out, {
    expectedPublicKeySha256: paths.publicKeySha256,
    expectedSigningTier: 'development-candidate',
  })).toMatchObject({
    version: GONGCHUANG_SKILL_BUNDLE_VERSION,
    skillCount: FIXTURE_SKILL_COUNT,
  })
}

describe('desktop skill-suite staging', () => {
  it('projects only manifest-declared skills into the signed bundle and filesystem provider', async () => {
    const paths = fixture()
    const retired = join(paths.source, 'retired-skill', 'SKILL.md')
    mkdirSync(dirname(retired), { recursive: true })
    writeFileSync(retired, '---\nname: retired-skill\ndescription: Must not ship.\n---\n')

    stage(paths)

    expect(existsSync(join(paths.out, 'skills', 'retired-skill'))).toBe(false)
    const verified = verifyStagedSkillSuite(paths.out, {
      expectedPublicKeySha256: paths.publicKeySha256,
      expectedSigningTier: 'development-candidate',
    })
    const provider = new FileSystemSkillProvider(
      new Context(),
      { invalidate() {}, signal: new AbortController().signal },
      { includeDefaultRoots: false, bundledSkillDir: verified.skillsRoot, watch: false },
    )
    const observation = await provider.list({})
    const candidates = Array.isArray(observation) ? observation : observation.candidates
    expect(candidates.map(candidate => candidate.name)).toEqual([
      'fixture-skill-01',
      'fixture-skill-02',
      'fixture-skill-03',
    ])
    expect(candidates.map(candidate => candidate.name)).not.toContain('retired-skill')
    await provider.dispose()
  })

  it('rejects a stale operation registry before signing or replacing the installed tree', () => {
    const paths = fixture()
    stage(paths)
    const previous = readFileSync(join(paths.out, 'skill-bundle-index.json'), 'utf8')
    writeFileSync(join(paths.source, 'client-runtime-operations.json'), JSON.stringify({
      schema_version: 'gongchuang-signed-skill-operations/v1',
      skill_bundle_version: '0.0.1', operations: [],
    }))
    expect(() => { stage(paths) }).toThrow(/受签名技能运行清单版本或操作集合无效/)
    expect(readFileSync(join(paths.out, 'skill-bundle-index.json'), 'utf8')).toBe(previous)
    verify(paths)
  })
  it('replaces standalone preparation with the desktop runtime boundary before signing', () => {
    const paths = fixture()
    const sourcePath = join(paths.source, paths.firstSkill, 'SKILL.md')
    const source = readFileSync(sourcePath, 'utf8') + [
      '<!-- BEGIN MANAGED PORTABLE SKILL RUNTIME -->',
      '每次触发必须运行 standalone-prepare-now',
      '<!-- END MANAGED PORTABLE SKILL RUNTIME -->',
      'Business instructions stay intact.',
    ].join('\n')
    writeFileSync(sourcePath, source)
    stage(paths)
    const staged = readFileSync(join(paths.out, 'skills', paths.firstSkill, 'SKILL.md'), 'utf8')
    expect(staged).not.toContain('standalone-prepare-now')
    expect(staged).toContain('不执行其他宿主的独立安装、准备或二次验签流程')
    expect(staged).toContain('description 与 code')
    expect(staged).toContain('不可使用 require、process 或 fs')
    expect(staged).toContain('Business instructions stay intact.')
    expect(readFileSync(sourcePath, 'utf8')).toBe(source)
    verify(paths)
    writeFileSync(join(paths.out, 'skills', paths.firstSkill, 'SKILL.md'), staged + '\ntampered')
    expect(() => { verify(paths) }).toThrow()
  })

  it('builds a root-level independently versioned update archive without weakening bundled checks', () => {
    const paths = fixture()
    const [major, minor, patch] = GONGCHUANG_SKILL_BUNDLE_VERSION.split('.').map(Number)
    const version = `${String(major)}.${String(minor)}.${String((patch ?? 0) + 1)}`
    setSuiteVersion(paths, version)

    expect(() => { stage(paths) }).toThrow()
    stage(paths, { purpose: 'independent-update', expectedVersion: version })
    expect(verifyStagedSkillSuite(paths.out, {
      expectedPublicKeySha256: paths.publicKeySha256,
      expectedSigningTier: 'development-candidate',
    })).toMatchObject({ version, skillCount: FIXTURE_SKILL_COUNT })

    const formalOut = join(paths.root, 'formal-update')
    execFileSync(process.execPath, [
      '--import', 'tsx/esm', script,
      '--source', paths.source,
      '--out', formalOut,
      '--key', paths.key,
      '--tier', 'formal',
      '--purpose', 'independent-update',
      '--expected-version', version,
    ], { stdio: 'pipe', env: { ...process.env, GONGCHUANG_STAGE_TRASH_ROOT: paths.trash } })
    const archive = join(paths.root, `skills-V${version}.zip`)
    const archiveArgs = [
      '--import', 'tsx/esm', archiveScript,
      '--source', formalOut,
      '--out', archive,
      '--expected-version', version,
      '--expected-public-key-sha256', paths.publicKeySha256,
    ]
    execFileSync(process.execPath, archiveArgs, { stdio: 'pipe', env: { ...process.env, TZ: 'UTC' } })
    const original = readFileSync(archive)
    // Time-zone changes make the old wall-clock ZIP headers differ even when
    // two builds happen within the same DOS timestamp interval.
    for (const TZ of ['Pacific/Honolulu', 'Asia/Shanghai']) {
      execFileSync(process.execPath, archiveArgs, { stdio: 'pipe', env: { ...process.env, TZ } })
      expect(readFileSync(archive)).toEqual(original)
    }
    const entries = Object.keys(unzipSync(readFileSync(archive))).sort()
    expect(entries).toContain('skill-bundle-index.json')
    expect(entries).toContain(`skills/${paths.firstSkill}/SKILL.md`)
    expect(entries).not.toContain('config/common.yaml')
    expect(entries.some(path => path.startsWith('bundle/'))).toBe(false)
  })

  it('rejects an independent update when its explicit version does not match the source', () => {
    const paths = fixture()
    setSuiteVersion(paths, '1.6.16')

    expect(() => {
      stage(paths, { purpose: 'independent-update', expectedVersion: '1.6.17' })
    }).toThrow()
    expect(existsSync(paths.out)).toBe(false)
  })

  it('promotes a complete candidate and moves the superseded suite to injected recoverable Trash', () => {
    const paths = fixture()
    stage(paths)
    updateFirstSkill(paths)

    stage(paths)

    expect(readFileSync(join(paths.out, 'skills', paths.firstSkill, 'SKILL.md'), 'utf8'))
      .toContain('second revision')
    verify(paths)
    expect(readdirSync(dirname(paths.out)).filter(name => name.startsWith(`${basename(paths.out)}.previous-`)))
      .toEqual([])
    const previous = readdirSync(paths.trash)
      .find(name => name.startsWith('gongchuang-skill-suite-previous-'))
    expect(previous).toBeDefined()
    expect(readFileSync(join(paths.trash, previous ?? '', 'skills', paths.firstSkill, 'SKILL.md'), 'utf8'))
      .toContain('first revision')
  })

  it('keeps the current output untouched when candidate construction cannot start', () => {
    const paths = fixture()
    const longOut = join(paths.root, 's'.repeat(220))
    mkdirSync(longOut)
    writeFileSync(join(longOut, 'current.marker'), 'current\n')

    expect(() => { stage(paths, { out: longOut }) }).toThrow()

    expect(readFileSync(join(longOut, 'current.marker'), 'utf8')).toBe('current\n')
  })

  it('restores the prior current suite when the recoverable Trash move is refused', () => {
    const paths = fixture()
    stage(paths)
    const first = readFileSync(join(paths.out, 'skills', paths.firstSkill, 'SKILL.md'), 'utf8')
    updateFirstSkill(paths)
    const blockedTrash = join(paths.root, 'not-a-trash-directory')
    writeFileSync(blockedTrash, 'file blocks Trash directory creation\n')

    expect(() => { stage(paths, { trash: blockedTrash }) }).toThrow()

    expect(readFileSync(join(paths.out, 'skills', paths.firstSkill, 'SKILL.md'), 'utf8')).toBe(first)
    expect(readdirSync(dirname(paths.out)).filter(name => name.startsWith(`${basename(paths.out)}.previous-`)))
      .toEqual([])
    expect(readdirSync(dirname(paths.out)).some(name => name.startsWith(`${basename(paths.out)}.candidate-`)))
      .toBe(true)
    verify(paths)
  })

  it('uses the current macOS account Trash when no injected root is configured', () => {
    const paths = fixture()
    stage(paths)
    updateFirstSkill(paths)
    const argv = [
      process.execPath, script,
      '--source', paths.source,
      '--out', paths.out,
      '--key', paths.key,
      '--tier', 'development-candidate',
    ]
    const bootstrap = [
      'Object.defineProperty(process, \'platform\', { value: \'darwin\' })',
      `process.argv = ${JSON.stringify(argv)}`,
      `await import(${JSON.stringify(pathToFileURL(script).href)})`,
    ].join('; ')

    execFileSync(process.execPath, ['--import', 'tsx/esm', '--eval', bootstrap], {
      stdio: 'pipe',
      env: {
        ...process.env,
        HOME: paths.root,
        GONGCHUANG_STAGE_TRASH_ROOT: '',
      },
    })

    const accountTrash = join(paths.root, '.Trash')
    expect(readdirSync(accountTrash).some(name => name.startsWith('gongchuang-skill-suite-previous-')))
      .toBe(true)
    expect(readFileSync(join(paths.out, 'skills', paths.firstSkill, 'SKILL.md'), 'utf8'))
      .toContain('second revision')
    verify(paths)
  })

  it('uses the native Windows Recycle Bin when no injected Trash root is configured', () => {
    const paths = fixture()
    stage(paths)
    updateFirstSkill(paths)
    const fakeBin = join(paths.root, 'fake-bin')
    const recycleRoot = join(paths.root, 'fake-native-recycle-bin')
    const invocation = join(paths.root, 'powershell-invocation.txt')
    mkdirSync(fakeBin)
    mkdirSync(recycleRoot)
    const fakePowerShell = join(fakeBin, 'powershell.exe')
    writeFileSync(fakePowerShell, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const encoded = args[args.indexOf('-EncodedCommand') + 1]
const script = Buffer.from(encoded, 'base64').toString('utf16le')
const match = /FromBase64String\\('([^']+)'\\)/u.exec(script)
if (match === null) throw new Error('encoded recycle path missing')
const source = Buffer.from(match[1], 'base64').toString('utf8')
fs.writeFileSync(process.env.GONGCHUANG_FAKE_POWERSHELL_LOG, script)
fs.renameSync(source, path.join(process.env.GONGCHUANG_FAKE_RECYCLE_ROOT, path.basename(source)))
`)
    chmodSync(fakePowerShell, 0o755)
    const argv = [
      process.execPath, script,
      '--source', paths.source,
      '--out', paths.out,
      '--key', paths.key,
      '--tier', 'development-candidate',
    ]
    const bootstrap = [
      'Object.defineProperty(process, \'platform\', { value: \'win32\' })',
      `process.argv = ${JSON.stringify(argv)}`,
      `await import(${JSON.stringify(pathToFileURL(script).href)})`,
    ].join('; ')

    execFileSync(process.execPath, ['--import', 'tsx/esm', '--eval', bootstrap], {
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        GONGCHUANG_FAKE_POWERSHELL_LOG: invocation,
        GONGCHUANG_FAKE_RECYCLE_ROOT: recycleRoot,
        GONGCHUANG_STAGE_TRASH_ROOT: '',
      },
    })

    expect(readFileSync(invocation, 'utf8')).toContain('SendToRecycleBin')
    expect(readdirSync(recycleRoot)).toHaveLength(1)
    expect(readFileSync(join(paths.out, 'skills', paths.firstSkill, 'SKILL.md'), 'utf8'))
      .toContain('second revision')
    expect(existsSync(paths.out)).toBe(true)
    verify(paths)
  })
})
