import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyMacCredentialBrokerInputs } from '../scripts/verify-final-macos-application.ts'

describe.skipIf(process.platform !== 'darwin')('frozen macOS credential broker', () => {
  it('binds its source, both native architectures, hashes, and ad-hoc identities', () => {
    const desktopRoot = resolve(import.meta.dirname, '..')
    const manifest = verifyMacCredentialBrokerInputs(desktopRoot)

    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.sourceSha256).toHaveLength(64)
    expect(manifest.artifacts.arm64.sha256).toHaveLength(64)
    expect(manifest.artifacts.arm64.cdhash).toHaveLength(40)
    expect(manifest.artifacts.x64.sha256).toHaveLength(64)
    expect(manifest.artifacts.x64.cdhash).toHaveLength(40)
  })

  it('rejects a broker manifest that no longer matches its source', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'gongchuang-credential-broker-input-'))
    const sourceRoot = resolve(import.meta.dirname, '..')
    for (const relativePath of [
      'native-credentials/manifest.json',
      'native-src/credential-broker.swift',
      'native-credentials/mac-arm64/gongchuang-credential-broker',
      'native-credentials/mac-x64/gongchuang-credential-broker',
    ]) {
      const destination = join(fixtureRoot, relativePath)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, readFileSync(join(sourceRoot, relativePath)), {
        mode: relativePath.endsWith('gongchuang-credential-broker') ? 0o755 : 0o644,
      })
    }
    writeFileSync(
      join(fixtureRoot, 'native-src', 'credential-broker.swift'),
      '// modified after the frozen binaries were built\n',
    )

    expect(() => verifyMacCredentialBrokerInputs(fixtureRoot))
      .toThrow('source SHA-256 does not match')
  })
})
