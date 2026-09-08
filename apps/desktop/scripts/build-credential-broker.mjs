import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Keep the native helper source and its independently signed identity with the
// product. The helper admits only a valid signed cn.dongjian.desktop parent.
const root = resolve(import.meta.dirname, '..')
const source = resolve(root, 'native-src/credential-broker.swift')
const output = resolve(root, 'native-credentials')
const artifacts = {}
for (const [arch, target] of [['arm64', 'arm64-apple-macos11.0'], ['x64', 'x86_64-apple-macos11.0']]) {
  const directory = resolve(output, `mac-${arch}`)
  mkdirSync(directory, { recursive: true })
  const binary = resolve(directory, 'gongchuang-credential-broker')
  execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', target, source, '-o', binary], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'cn.dongjian.desktop.credentials', binary], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', binary], { stdio: 'inherit' })
  const signing = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', binary], { encoding: 'utf8' })
  const cdhash = /^CDHash=([a-f0-9]{40})$/mu.exec(signing.stderr)?.[1]
  if (signing.status !== 0 || cdhash === undefined) throw new Error(`Cannot inspect ${arch} credential helper signature`)
  artifacts[arch] = { sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), cdhash }
}
writeFileSync(resolve(output, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'), artifacts }, null, 2)}\n`)
