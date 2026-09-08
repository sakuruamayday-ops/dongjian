import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyWindowsPythonDocumentRuntimeLayout } from '../scripts/python-document-runtime-smoke.ts'

const smokeSource = readFileSync(
  join(import.meta.dirname, '../scripts/python-document-runtime-smoke.ts'),
  'utf8',
)

const packages = [
  ['python-docx', 'python_docx', 'docx', '1.2.0'],
  ['openpyxl', 'openpyxl', 'openpyxl', '3.1.5'],
  ['xlrd', 'xlrd', 'xlrd', '2.0.2'],
  ['pymupdf', 'pymupdf', 'pymupdf', '1.28.2'],
  ['python-pptx', 'python_pptx', 'pptx', '1.0.2'],
  ['pillow', 'pillow', 'PIL', '12.3.0'],
  ['xlsxwriter', 'xlsxwriter', 'xlsxwriter', '3.2.5'],
] as const

function createWindowsRuntime(nativeExtension = Buffer.from('MZfixture')): string {
  const root = mkdtempSync(join(tmpdir(), 'gongchuang-win-python-'))
  const executable = join(root, 'python.exe')
  const sitePackages = join(root, 'Lib', 'site-packages')
  writeFileSync(executable, Buffer.from('MZfixture'))
  for (const [name, metadataName, importName, version] of packages) {
    const metadata = join(sitePackages, `${metadataName}-${version}.dist-info`)
    mkdirSync(metadata, { recursive: true })
    writeFileSync(join(metadata, 'METADATA'), `Name: ${name}\nVersion: ${version}\n`)
    const imported = join(sitePackages, importName)
    mkdirSync(imported, { recursive: true })
    writeFileSync(join(imported, '__init__.py'), '')
  }
  writeFileSync(join(sitePackages, 'pymupdf', '_mupdf.pyd'), nativeExtension)
  return executable
}

describe('cross-platform Windows document runtime verification', () => {
  it('disables Python bytecode writes at both the interpreter and environment layers', () => {
    expect(smokeSource).toContain("['-B', '-c', smokeProgram]")
    expect(smokeSource).toContain("PYTHONDONTWRITEBYTECODE: '1'")
  })

  it('validates package metadata, import layout, and PE native extensions without execution', () => {
    expect(verifyWindowsPythonDocumentRuntimeLayout(createWindowsRuntime())).toEqual({
      'python-docx': '1.2.0',
      openpyxl: '3.1.5',
      xlrd: '2.0.2',
      pymupdf: '1.28.2',
      'python-pptx': '1.0.2',
      pillow: '12.3.0',
      xlsxwriter: '3.2.5',
    })
  })

  it('rejects a host-native binary mixed into the Windows runtime', () => {
    const executable = createWindowsRuntime(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
    expect(() => verifyWindowsPythonDocumentRuntimeLayout(executable)).toThrow(/非 PE 扩展/u)
  })
})
