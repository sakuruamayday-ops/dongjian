import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import {
  inspectProfessionalArtifact,
  inspectProfessionalBranding,
} from '@gongchuang/client-policy-gate'

function brandedHtml(): { artifact: string; runtime: string } {
  const root = mkdtempSync(join(tmpdir(), 'gongchuang-brand-inspection-'))
  const runtime = join(root, 'runtime')
  const assets = join(runtime, 'assets')
  const references = join(runtime, 'references')
  mkdirSync(assets, { recursive: true })
  mkdirSync(references, { recursive: true })
  const brand = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex')
  writeFileSync(join(assets, 'brand-red-test.png'), brand)
  writeFileSync(join(references, 'brand_config.json'), JSON.stringify({
    public_identity: { document_header: '共创研究院' },
  }))
  const encoded = brand.toString('base64')
  const artifact = join(root, 'report.html')
  writeFileSync(artifact, [
    '<!doctype html><html><head>',
    `<style id="gongchuang-public-brand-style">body::before{background: url(data:image/png;base64,${encoded}) center}</style>`,
    '</head><body>',
    '<div class="gongchuang-document-header">共创研究院</div>',
    '<h1>总体结论</h1><p>正文事实均已绑定来源，缺失事项保持待核验。</p>',
    '</body></html>',
  ].join(''))
  return { artifact, runtime }
}

function visibleWorkbook(): string {
  const root = mkdtempSync(join(tmpdir(), 'gongchuang-xlsx-inspection-'))
  const artifact = join(root, 'visible-values.xlsx')
  const archive = zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="检测结果" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
    'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>断裂伸长率</t></si><si><r><t>57</t></r><r><t>.1</t></r></si></sst>',
    'xl/styles.xml': '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="[Red]0"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="10"/><xf numFmtId="164"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" s="1"><v>1.9</v></c><c r="B2" t="inlineStr"><is><t>GB/T 1033.1-2008</t></is></c></row><row r="3"><c r="A3" s="2"><v>6</v></c></row></sheetData></worksheet>',
  }).map(([name, value]) => [name, strToU8(value)])))
  writeFileSync(artifact, archive)
  return artifact
}

describe('formal artifact inspection', () => {
  it('extracts real HTML text and binds content to a stable digest', () => {
    const fixture = brandedHtml()
    const result = inspectProfessionalArtifact(fixture.artifact)
    expect(result.format).toBe('html')
    expect(result.contentText).toContain('总体结论')
    expect(result.contentText).not.toContain('body::before')
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.contentSha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('rejects inherited branding and accepts a neutral document without changing its content', () => {
    const fixture = brandedHtml()
    expect(() => inspectProfessionalBranding(fixture.artifact, fixture.runtime)).toThrow(/旧产品/u)
    writeFileSync(fixture.artifact, '<!doctype html><html><head></head><body><h1>总体结论</h1><p>依据企业资料核验。</p></body></html>')
    const result = inspectProfessionalBranding(fixture.artifact, fixture.runtime)
    expect(result.ok).toBe(true)
    expect(result.brandIdentity).toBe('')
    expect(result.watermarkCount).toBe(0)
    expect(result.checks).toContain('no-legacy-watermark-assets')
    expect(inspectProfessionalArtifact(fixture.artifact).contentText).toContain('依据企业资料核验。')
  })

  it('extracts displayed XLSX values instead of shared-string indexes and raw percentages', () => {
    const result = inspectProfessionalArtifact(visibleWorkbook())
    expect(result.format).toBe('xlsx')
    expect(result.units).toBe(1)
    expect(result.contentText).toBe([
      '## 检测结果',
      '断裂伸长率 57.1',
      '190.00% GB/T 1033.1-2008',
      '6',
    ].join('\n'))
    expect(result.contentText).not.toMatch(/(?:^|\s)[01](?:\s|$)/u)
  })

  it('rejects encrypted PDFs even when page tokens are present', () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-pdf-inspection-'))
    const artifact = join(root, 'encrypted.pdf')
    writeFileSync(artifact, '%PDF-1.7\n1 0 obj << /Type /Page /Encrypt true >> endobj\n%%EOF\n')
    expect(() => inspectProfessionalArtifact(artifact)).toThrow(/加密 PDF/u)
  })
})
