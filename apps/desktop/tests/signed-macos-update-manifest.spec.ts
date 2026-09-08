import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertCurrentSourceCommit,
  buildSignedMacUpdateManifest,
} from '../scripts/build-signed-macos-update-manifest.ts'
import { verifyMacDesktopUpdateManifest } from '../src/macos-self-updater.ts'

describe('signed self-managed macOS release manifest', () => {
  it('binds the CLI release identity to the checked-out Git commit', () => {
    const head = 'a'.repeat(40)
    expect(assertCurrentSourceCommit(head.toUpperCase(), ` ${head}\n`)).toBe(head)
    expect(() => assertCurrentSourceCommit('b'.repeat(40), head)).toThrow('必须等于当前 Git HEAD')
    expect(() => assertCurrentSourceCommit('short', head)).toThrow('必须是 40 位 Git SHA')
  })

  it('binds both archives and both embedded runtime indexes to the pinned publisher', async () => {
    const desktopRoot = mkdtempSync(join(tmpdir(), 'gongchuang-signed-mac-release-'))
    const releaseDir = join(desktopRoot, 'release')
    const skillRoot = join(desktopRoot, '.build', 'product-skills')
    mkdirSync(releaseDir)
    mkdirSync(skillRoot, { recursive: true })
    writeFileSync(join(desktopRoot, 'package.json'), '{"version":"0.1.4"}\n')
    writeFileSync(join(skillRoot, 'skill-bundle-index.json'), `${JSON.stringify({
      schemaVersion: 1,
      productId: 'cn.dongjian.desktop',
      signingTier: 'formal',
    })}\n`)
    for (const architecture of ['arm64', 'x64'] as const) {
      const runtimeRoot = join(desktopRoot, '.build', `product-runtime-mac-${architecture}`)
      mkdirSync(runtimeRoot, { recursive: true })
      writeFileSync(join(runtimeRoot, 'runtime-index.json'), `${JSON.stringify({
        schemaVersion: 2,
        productId: 'cn.dongjian.desktop',
        clientVersion: '0.1.4',
        platform: 'darwin',
        arch: architecture,
        signingTier: 'formal',
      })}\n`)
      writeFileSync(
        join(releaseDir, `Dongjian-0.1.4-mac-${architecture}.zip`),
        `${architecture}-archive`,
      )
    }
    const pair = generateKeyPairSync('ed25519')
    const keyPath = join(desktopRoot, 'publisher.pem')
    const privatePem = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const publicPem = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' }))
    writeFileSync(keyPath, privatePem)
    const publicKeySha256 = createHash('sha256').update(publicPem).digest('hex')
    const result = await buildSignedMacUpdateManifest({
      desktopRoot,
      releaseDir,
      signingKeyPath: keyPath,
      expectedPublicKeySha256: publicKeySha256,
      signingTier: 'formal',
      sourceCommit: 'b'.repeat(40),
      publishedAt: '2026-08-20T13:00:00.000Z',
    })
    const manifestBytes = readFileSync(result.manifestPath)
    const verified = verifyMacDesktopUpdateManifest(
      manifestBytes,
      readFileSync(result.signaturePath, 'utf8'),
      publicPem,
      new URL('https://zshjiaotang.cn/client-updates/desktop-release-index.json'),
      publicKeySha256,
      'formal',
    )
    expect(verified.artifacts.map(row => row.architecture)).toEqual(['arm64', 'x64'])
    expect(verified.artifacts.every(row => row.sha256.length === 64)).toBe(true)
    expect(verified.sourceCommit).toBe('b'.repeat(40))
  })
})
