import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildUpdateMetadata } from '../scripts/build-update-metadata.ts'

function fixture(): { desktopRoot: string; releaseDir: string } {
  const desktopRoot = mkdtempSync(join(tmpdir(), 'gongchuang-update-metadata-'))
  const releaseDir = join(desktopRoot, 'release')
  mkdirSync(releaseDir)
  writeFileSync(join(desktopRoot, 'package.json'), '{"version":"0.1.4"}\n')
  return { desktopRoot, releaseDir }
}

describe('desktop update metadata', () => {
  it('pins the Windows updater manifest to the x64 package target', () => {
    const packageManifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    expect(packageManifest.scripts['updates:metadata:win']).toContain('--arch x64')
  })

  it('publishes a macOS feed for the 0.1.4 client', async () => {
    const paths = fixture()
    const zipName = 'Dongjian-0.1.4-mac-arm64.zip'
    const dmgName = 'Dongjian-0.1.4-mac-arm64.dmg'
    writeFileSync(join(paths.releaseDir, zipName), 'zip-update')
    writeFileSync(join(paths.releaseDir, dmgName), 'dmg-installer')

    const target = await buildUpdateMetadata(paths.desktopRoot, paths.releaseDir, 'darwin', '2026-08-18T00:00:00.000Z')
    const metadata = readFileSync(target, 'utf8')
    expect(metadata).toContain('version: 0.1.4')
    expect(metadata).toContain(`path: '${zipName}'`)
    expect(metadata).toContain(`sha512: ${createHash('sha512').update('zip-update').digest('base64')}`)
    expect(metadata).toContain(`  - url: '${dmgName}'`)
  })

  it('publishes Intel macOS artifacts and keeps both architectures in one feed when available', async () => {
    const paths = fixture()
    const armZip = 'Dongjian-0.1.4-mac-arm64.zip'
    const armDmg = 'Dongjian-0.1.4-mac-arm64.dmg'
    const intelZip = 'Dongjian-0.1.4-mac-x64.zip'
    const intelDmg = 'Dongjian-0.1.4-mac-x64.dmg'
    writeFileSync(join(paths.releaseDir, armZip), 'arm-zip')
    writeFileSync(join(paths.releaseDir, armDmg), 'arm-dmg')
    writeFileSync(join(paths.releaseDir, intelZip), 'intel-zip')
    writeFileSync(join(paths.releaseDir, intelDmg), 'intel-dmg')

    const target = await buildUpdateMetadata(
      paths.desktopRoot,
      paths.releaseDir,
      'darwin',
      '2026-08-18T00:00:00.000Z',
      'x64',
    )
    expect(target).toContain('latest-mac.yml')
    const metadata = readFileSync(target, 'utf8')
    expect(metadata).toContain(`path: '${intelZip}'`)
    expect(metadata).toContain(`  - url: '${armZip}'`)
    expect(metadata).toContain(`  - url: '${intelDmg}'`)
  })

  it('publishes the Windows NSIS installer feed independently', async () => {
    const paths = fixture()
    const installerName = 'Dongjian-0.1.4-win-x64.exe'
    writeFileSync(join(paths.releaseDir, installerName), 'nsis-installer')

    const target = await buildUpdateMetadata(paths.desktopRoot, paths.releaseDir, 'win32', '2026-08-18T00:00:00.000Z')
    const metadata = readFileSync(target, 'utf8')
    expect(metadata).toContain('version: 0.1.4')
    expect(metadata).toContain(`path: '${installerName}'`)
    expect(metadata).not.toContain('mac-arm64')
  })

  it('publishes an Intel macOS feed using x64 artifacts and keeps both macOS architectures when present', async () => {
    const paths = fixture()
    const armZip = 'Dongjian-0.1.4-mac-arm64.zip'
    const armDmg = 'Dongjian-0.1.4-mac-arm64.dmg'
    const intelZip = 'Dongjian-0.1.4-mac-x64.zip'
    const intelDmg = 'Dongjian-0.1.4-mac-x64.dmg'
    writeFileSync(join(paths.releaseDir, armZip), 'arm-zip')
    writeFileSync(join(paths.releaseDir, armDmg), 'arm-dmg')
    writeFileSync(join(paths.releaseDir, intelZip), 'intel-zip')
    writeFileSync(join(paths.releaseDir, intelDmg), 'intel-dmg')

    const target = await buildUpdateMetadata(paths.desktopRoot, paths.releaseDir, 'darwin', '2026-08-18T00:00:00.000Z', 'x64')
    const metadata = readFileSync(target, 'utf8')
    expect(metadata).toContain(`path: '${intelZip}'`)
    expect(metadata).toContain(`  - url: '${armZip}'`)
    expect(metadata).toContain(`  - url: '${intelDmg}'`)
  })

  it('refuses to emit metadata before all expected artifacts exist', async () => {
    const paths = fixture()
    writeFileSync(join(paths.releaseDir, 'Dongjian-0.1.4-mac-arm64.zip'), 'zip-update')
    await expect(buildUpdateMetadata(paths.desktopRoot, paths.releaseDir, 'darwin')).rejects.toThrow()
  })
})
