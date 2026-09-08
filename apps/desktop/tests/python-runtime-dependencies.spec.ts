import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

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

interface Manifest {
  schemaVersion: number
  pythonVersion: string
  targets: Record<string, { pipPlatform: string; abis: string[]; artifacts: Artifact[] }>
}

const manifest = JSON.parse(readFileSync(resolve(
  import.meta.dirname,
  '../../../product/gongchuang-client/python-runtime-dependencies.json',
), 'utf8')) as Manifest

const requiredVersions = {
  'python-docx': '1.2.0',
  lxml: '6.1.1',
  pymupdf: '1.28.2',
  openpyxl: '3.1.5',
  xlrd: '2.0.2',
  'et-xmlfile': '2.0.0',
  'python-pptx': '1.0.2',
  pillow: '12.3.0',
  xlsxwriter: '3.2.5',
}

function canonical(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[._-]+/gu, '-')
}

describe('packaged Python dependency manifest', () => {
  it('pins the complete document runtime for every supported installer target', () => {
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.pythonVersion).toBe('3.13')
    expect(Object.keys(manifest.targets).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'win32-x64'])
    for (const target of Object.values(manifest.targets)) {
      const actual = Object.fromEntries(target.artifacts.map(artifact => [
        canonical(artifact.distribution),
        artifact.version,
      ]))
      expect(actual).toEqual(requiredVersions)
      expect(target.abis).toContain('cp313')
      for (const artifact of target.artifacts) {
        expect(artifact.filename).toMatch(/^[^/\\]+\.whl$/u)
        expect(artifact.url).toBe(`https://files.pythonhosted.org/${artifact.url.split('files.pythonhosted.org/')[1] ?? ''}`)
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u)
        expect(artifact.topLevel).toContainEqual(expect.stringMatching(/\.dist-info$/u))
      }
      expect(target.artifacts.find(value => canonical(value.distribution) === 'python-pptx')?.licenseFiles)
        .toEqual(['python_pptx-1.0.2.dist-info/LICENSE'])
      expect(target.artifacts.find(value => canonical(value.distribution) === 'pillow')?.licenseFiles)
        .toEqual(['pillow-12.3.0.dist-info/licenses/LICENSE'])
      expect(target.artifacts.find(value => canonical(value.distribution) === 'xlsxwriter')?.licenseFiles)
        .toEqual(['xlsxwriter-3.2.5.dist-info/LICENSE.txt'])
    }
  })

  it('pins the platform-native Pillow wheel while sharing pure python-pptx dependencies', () => {
    const artifact = (target: string, distribution: string): Artifact | undefined => (
      manifest.targets[target]?.artifacts.find(value => canonical(value.distribution) === distribution)
    )
    expect(artifact('darwin-arm64', 'pillow')?.wheelTag).toBe('cp313-cp313-macosx_11_0_arm64')
    expect(artifact('darwin-x64', 'pillow')?.wheelTag).toBe('cp313-cp313-macosx_10_13_x86_64')
    expect(artifact('win32-x64', 'pillow')?.wheelTag).toBe('cp313-cp313-win_amd64')
    for (const distribution of ['python-pptx', 'xlrd', 'xlsxwriter']) {
      const identities = Object.keys(manifest.targets).map((target) => {
        const value = artifact(target, distribution)
        return `${value?.filename ?? ''}:${value?.sha256 ?? ''}`
      })
      expect(new Set(identities).size).toBe(1)
    }
  })
})
