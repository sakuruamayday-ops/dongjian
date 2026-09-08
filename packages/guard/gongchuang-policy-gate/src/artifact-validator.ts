/** Cross-platform, fail-closed inspection for formal 共创 delivery artifacts. */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { dirname, extname, join, posix, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { XMLParser } from 'fast-xml-parser'

const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 20_000
const MAX_TOTAL_UNCOMPRESSED_BYTES = 384 * 1024 * 1024
const MAX_XML_BYTES = 32 * 1024 * 1024

/** File formats inspected without relying on Microsoft Office or a system Python runtime. */
export type ProfessionalArtifactFormat = 'docx' | 'xlsx' | 'xlsm' | 'pptx' | 'pdf' | 'html'

/** Immutable identity and extracted content for one formal artifact. */
export interface ProfessionalArtifactInspection {
  path: string
  format: ProfessionalArtifactFormat
  sha256: string
  bytes: number
  contentText?: string
  contentSha256?: string
  units: number
}

/** Successful deterministic brand audit. */
export interface ProfessionalBrandInspection {
  ok: true
  format: ProfessionalArtifactFormat
  artifactSha256: string
  brandIdentity: string
  watermarkCount: number
  checks: readonly string[]
}

interface ZipEntry {
  name: string
  method: number
  flags: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

interface ZipPackage {
  bytes: Buffer
  entries: ReadonlyMap<string, ZipEntry>
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeArtifact(path: string): { path: string; bytes: Buffer } {
  if (path.trim() === '') throw new Error('共创交付物路径为空')
  const requested = resolve(path)
  const requestedStat = lstatSync(requested)
  if (requestedStat.isSymbolicLink() || !requestedStat.isFile()) throw new Error('共创交付物必须是普通文件且不得为符号链接')
  if (requestedStat.size <= 0 || requestedStat.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`共创交付物大小必须在 1–${String(MAX_ARTIFACT_BYTES)} 字节之间`)
  }
  const canonical = realpathSync(requested)
  return { path: canonical, bytes: readFileSync(canonical) }
}

let crcTable: Uint32Array | undefined

function crc32(bytes: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, value) => {
    let row = value
    for (let bit = 0; bit < 8; bit += 1) row = (row & 1) === 1 ? 0xedb88320 ^ (row >>> 1) : row >>> 1
    return row >>> 0
  })
  let result = 0xffffffff
  for (const byte of bytes) result = (crcTable[(result ^ byte) & 0xff] as number) ^ (result >>> 8)
  return (result ^ 0xffffffff) >>> 0
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const lower = Math.max(0, bytes.length - 65_557)
  for (let offset = bytes.length - 22; offset >= lower; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw new Error('OOXML 文件缺少 ZIP 中央目录')
}

function safeEntryName(name: string): void {
  if (name === '' || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/u.test(name)
    || name.split('/').some(segment => segment === '..' || segment === '.')) {
    throw new Error(`OOXML 文件包含不安全路径：${name}`)
  }
}

function parseZip(bytes: Buffer): ZipPackage {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('OOXML 文件不是有效 ZIP 容器')
  const end = findEndOfCentralDirectory(bytes)
  const disk = bytes.readUInt16LE(end + 4)
  const centralDisk = bytes.readUInt16LE(end + 6)
  const entriesOnDisk = bytes.readUInt16LE(end + 8)
  const entryCount = bytes.readUInt16LE(end + 10)
  const centralSize = bytes.readUInt32LE(end + 12)
  const centralOffset = bytes.readUInt32LE(end + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount
    || entryCount <= 0 || entryCount > MAX_ARCHIVE_ENTRIES
    || centralOffset + centralSize > end) {
    throw new Error('OOXML ZIP 中央目录范围或分卷信息无效')
  }
  const entries = new Map<string, ZipEntry>()
  let cursor = centralOffset
  let totalUncompressed = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('OOXML ZIP 中央目录条目损坏')
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const crc = bytes.readUInt32LE(cursor + 16)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > end || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('OOXML ZIP64 或越界条目不受候选版信任链支持')
    }
    const name = bytes.toString((flags & 0x800) === 0x800 ? 'utf8' : 'latin1', cursor + 46, cursor + 46 + nameLength)
    safeEntryName(name)
    if ((flags & 1) === 1) throw new Error(`OOXML 条目已加密，无法审计：${name}`)
    if (entries.has(name)) throw new Error(`OOXML 文件包含重复条目：${name}`)
    totalUncompressed += uncompressedSize
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error('OOXML 解压总量超过安全上限')
    entries.set(name, { name, method, flags, crc32: crc, compressedSize, uncompressedSize, localOffset })
    cursor = next
  }
  if (cursor !== centralOffset + centralSize) throw new Error('OOXML ZIP 中央目录长度不一致')
  return { bytes, entries }
}

function zipEntry(pack: ZipPackage, name: string, maxBytes = MAX_XML_BYTES): Buffer {
  const entry = pack.entries.get(name)
  if (entry === undefined) throw new Error(`OOXML 文件缺少必要部件：${name}`)
  if (entry.uncompressedSize > maxBytes) throw new Error(`OOXML 部件超过安全上限：${name}`)
  const offset = entry.localOffset
  if (offset + 30 > pack.bytes.length || pack.bytes.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`OOXML 本地条目损坏：${name}`)
  }
  const nameLength = pack.bytes.readUInt16LE(offset + 26)
  const extraLength = pack.bytes.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > pack.bytes.length) throw new Error(`OOXML 条目越界：${name}`)
  const compressed = pack.bytes.subarray(start, end)
  let value: Buffer
  if (entry.method === 0) value = Buffer.from(compressed)
  else if (entry.method === 8) value = inflateRawSync(compressed, { maxOutputLength: maxBytes })
  else throw new Error(`OOXML 条目压缩方法不受支持：${name}`)
  if (value.length !== entry.uncompressedSize || crc32(value) !== entry.crc32) throw new Error(`OOXML 条目校验失败：${name}`)
  return value
}

function xmlSource(pack: ZipPackage, name: string): string {
  const source = zipEntry(pack, name).toString('utf8')
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) throw new Error(`OOXML 部件包含不允许的实体声明：${name}`)
  return source
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replace(/&#(\d+);/gu, (_all, raw: string) => String.fromCodePoint(Number(raw)))
    .replace(/&#x([0-9a-f]+);/giu, (_all, raw: string) => String.fromCodePoint(Number.parseInt(raw, 16)))
}

function normalizeContent(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replace(/[\t ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function xmlText(source: string): string {
  const visible = source
    .replace(/<(?:w:tab|a:tab)\b[^>]*\/?\s*>/giu, '\t')
    .replace(/<w:br\b[^>]*\/?\s*>/giu, '\n')
    .replace(/<\/(?:w:p|a:p|row|si|c)>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
  return normalizeContent(decodeEntities(visible))
}

type XmlRecord = Record<string, unknown>

const OOXML_PARSER = new XMLParser({
  attributeNamePrefix: '',
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  removeNSPrefix: true,
  trimValues: false,
})

function xmlRecord(value: unknown): XmlRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as XmlRecord
    : undefined
}

function xmlRows(value: unknown): unknown[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function xmlValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  const record = xmlRecord(value)
  return record === undefined ? '' : xmlValue(record['#text'])
}

function parseXml(pack: ZipPackage, name: string): XmlRecord {
  const parsed = xmlRecord(OOXML_PARSER.parse(xmlSource(pack, name)))
  if (parsed === undefined) throw new Error(`OOXML 部件不是有效 XML 对象：${name}`)
  return parsed
}

function richText(value: unknown): string {
  const record = xmlRecord(value)
  if (record === undefined) return xmlValue(value)
  const direct = xmlValue(record.t)
  if (direct !== '') return direct
  return xmlRows(record.r).map(run => xmlValue(xmlRecord(run)?.t)).join('')
}

function sharedStrings(pack: ZipPackage): readonly string[] {
  if (!pack.entries.has('xl/sharedStrings.xml')) return []
  const root = xmlRecord(parseXml(pack, 'xl/sharedStrings.xml').sst)
  return xmlRows(root?.si).map(richText)
}

interface XlsxStyle {
  formatCode?: string
}

const BUILTIN_FORMATS = new Map<number, string>([
  [9, '0%'], [10, '0.00%'],
  [14, 'yyyy-mm-dd'], [15, 'dd-mmm-yy'], [16, 'd-mmm'], [17, 'mmm-yy'],
  [18, 'h:mm AM/PM'], [19, 'h:mm:ss AM/PM'], [20, 'h:mm'], [21, 'h:mm:ss'],
  [22, 'yyyy-mm-dd h:mm'], [45, 'mm:ss'], [46, '[h]:mm:ss'], [47, 'mmss.0'],
])

function xlsxStyles(pack: ZipPackage): readonly XlsxStyle[] {
  if (!pack.entries.has('xl/styles.xml')) return []
  const root = xmlRecord(parseXml(pack, 'xl/styles.xml').styleSheet)
  const custom = new Map<number, string>()
  const formats = xmlRecord(root?.numFmts)
  for (const entry of xmlRows(formats?.numFmt)) {
    const row = xmlRecord(entry)
    const id = Number(row?.numFmtId)
    const formatCode = row?.formatCode
    if (Number.isInteger(id) && typeof formatCode === 'string') custom.set(id, formatCode)
  }
  const cellXfs = xmlRecord(root?.cellXfs)
  return xmlRows(cellXfs?.xf).map((entry): XlsxStyle => {
    const id = Number(xmlRecord(entry)?.numFmtId)
    const formatCode = custom.get(id) ?? BUILTIN_FORMATS.get(id)
    return formatCode === undefined ? {} : { formatCode }
  })
}

function decimalPlaces(formatCode: string): number {
  const visible = formatCode.replace(/"[^"]*"/gu, '').replace(/\\./gu, '')
  const match = /\.([0#]+)[^%]*%/u.exec(visible)
  return match?.[1]?.length ?? 0
}

function excelDate(serial: number, formatCode: string): string {
  const milliseconds = Math.round((serial - 25_569) * 86_400_000)
  const date = new Date(milliseconds)
  if (!Number.isFinite(date.getTime())) return String(serial)
  const datePart = date.toISOString().slice(0, 10)
  const timePart = date.toISOString().slice(11, 19)
  const hasDate = /[yd]/iu.test(formatCode)
  const hasTime = /[hs]/iu.test(formatCode)
  if (hasDate && hasTime) return `${datePart} ${timePart}`
  if (hasDate) return datePart
  return timePart
}

function isDateFormat(formatCode: string): boolean {
  const visible = formatCode
    .replace(/"[^"]*"/gu, '')
    .replace(/\\./gu, '')
    .replace(/\[(?!h+\]|m+\]|s+\])[^\]]+\]/giu, '')
  return /(?:^|[^A-Z])(?:y{2,4}|m{1,5}|d{1,4}|h{1,2}|s{1,2})(?:[^A-Z]|$)/iu.test(visible)
}

function displayNumber(raw: string, formatCode?: string): string {
  if (raw === '' || formatCode === undefined) return raw
  const value = Number(raw)
  if (!Number.isFinite(value)) return raw
  if (formatCode.includes('%')) return `${(value * 100).toFixed(decimalPlaces(formatCode))}%`
  if (isDateFormat(formatCode)) return excelDate(value, formatCode)
  return raw
}

function cellValue(cell: XmlRecord, strings: readonly string[], styles: readonly XlsxStyle[]): string {
  const kind = typeof cell.t === 'string' ? cell.t : ''
  const raw = xmlValue(cell.v)
  if (kind === 's') {
    const index = Number(raw)
    return Number.isInteger(index) && index >= 0 ? strings[index] ?? '' : ''
  }
  if (kind === 'inlineStr') return richText(cell.is)
  if (kind === 'b') return raw === '1' ? 'TRUE' : 'FALSE'
  if (kind === 'str' || kind === 'd' || kind === 'e') return raw
  const styleIndex = Number(cell.s)
  const style = Number.isInteger(styleIndex) && styleIndex >= 0 ? styles[styleIndex] : undefined
  return displayNumber(raw, style?.formatCode)
}

interface WorkbookSheet {
  name: string
  path: string
}

function workbookSheets(pack: ZipPackage): readonly WorkbookSheet[] {
  const workbook = xmlRecord(parseXml(pack, 'xl/workbook.xml').workbook)
  const sheets = xmlRows(xmlRecord(workbook?.sheets)?.sheet)
  const relationships = new Map<string, string>()
  if (pack.entries.has('xl/_rels/workbook.xml.rels')) {
    const root = xmlRecord(parseXml(pack, 'xl/_rels/workbook.xml.rels').Relationships)
    for (const entry of xmlRows(root?.Relationship)) {
      const row = xmlRecord(entry)
      if (typeof row?.Id !== 'string' || typeof row.Target !== 'string') continue
      const target = row.Target.startsWith('/')
        ? row.Target.slice(1)
        : posix.normalize(posix.join('xl', row.Target))
      if (pack.entries.has(target)) relationships.set(row.Id, target)
    }
  }
  const fallback = naturalNames(pack.entries.keys(), /^xl\/worksheets\/sheet\d+\.xml$/u)
  return sheets.map((entry, index): WorkbookSheet => {
    const row = xmlRecord(entry)
    const name = typeof row?.name === 'string' && row.name.trim() !== '' ? row.name : `工作表${String(index + 1)}`
    const relation = typeof row?.id === 'string' ? relationships.get(row.id) : undefined
    const path = relation ?? fallback[index]
    if (path === undefined) throw new Error(`Excel 工作表缺少正文部件：${name}`)
    return { name, path }
  })
}

function xlsxText(pack: ZipPackage): { text: string; sheets: number } {
  const strings = sharedStrings(pack)
  const styles = xlsxStyles(pack)
  const sheets = workbookSheets(pack)
  const parts: string[] = []
  for (const sheet of sheets) {
    const root = xmlRecord(parseXml(pack, sheet.path).worksheet)
    const sheetData = xmlRecord(root?.sheetData)
    parts.push(`## ${sheet.name}`)
    for (const entry of xmlRows(sheetData?.row)) {
      const row = xmlRecord(entry)
      const values = xmlRows(row?.c).map(cell => cellValue(xmlRecord(cell) ?? {}, strings, styles))
      parts.push(values.join('\t').trimEnd())
    }
  }
  return { text: normalizeContent(parts.join('\n')), sheets: sheets.length }
}

function htmlText(source: string): string {
  const visible = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|section|article)>/giu, '\n')
    .replace(/<br\b[^>]*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
  return normalizeContent(decodeEntities(visible))
}

function naturalNames(names: Iterable<string>, pattern: RegExp): string[] {
  return [...names].filter(name => pattern.test(name)).sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
}

function inspectOffice(path: string, bytes: Buffer, format: ProfessionalArtifactFormat): ProfessionalArtifactInspection {
  const pack = parseZip(bytes)
  if (!pack.entries.has('[Content_Types].xml') || !pack.entries.has('_rels/.rels')) {
    throw new Error('OOXML 文件缺少内容类型或根关系部件')
  }
  let names: string[]
  let units: number
  if (format === 'docx') {
    if (!pack.entries.has('word/document.xml')) throw new Error('Word 文件缺少 document.xml')
    names = naturalNames(pack.entries.keys(), /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/u)
    units = 1
  } else if (format === 'pptx') {
    names = naturalNames(pack.entries.keys(), /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/u)
    units = naturalNames(pack.entries.keys(), /^ppt\/slides\/slide\d+\.xml$/u).length
    if (units === 0) throw new Error('PowerPoint 文件没有幻灯片')
  } else {
    const workbook = xlsxText(pack)
    if (workbook.sheets === 0) throw new Error('Excel 文件没有工作表')
    if (workbook.text.length < 2) throw new Error('OOXML 文件未提取到可审计正文')
    return Object.freeze({
      path,
      format,
      sha256: sha256(bytes),
      bytes: bytes.length,
      contentText: workbook.text,
      contentSha256: sha256(workbook.text),
      units: workbook.sheets,
    })
  }
  const contentText = normalizeContent(names.map(name => xmlText(xmlSource(pack, name))).filter(Boolean).join('\n'))
  if (contentText.length < 2) throw new Error('OOXML 文件未提取到可审计正文')
  return Object.freeze({
    path,
    format,
    sha256: sha256(bytes),
    bytes: bytes.length,
    contentText,
    contentSha256: sha256(contentText),
    units,
  })
}

function inspectPdf(path: string, bytes: Buffer): ProfessionalArtifactInspection {
  const prefix = bytes.subarray(0, Math.min(bytes.length, 16)).toString('latin1')
  const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1')
  if (!prefix.startsWith('%PDF-1.') || !/%%EOF\s*$/u.test(tail)) throw new Error('PDF 头或结束标记无效')
  const raw = bytes.toString('latin1')
  if (/\/Encrypt\b/u.test(raw)) throw new Error('加密 PDF 无法进入专业审计链')
  const units = raw.match(/\/Type\s*\/Page\b/gu)?.length ?? 0
  if (units === 0) throw new Error('PDF 未检测到可打开页面')
  return Object.freeze({ path, format: 'pdf', sha256: sha256(bytes), bytes: bytes.length, units })
}

/**
 * Inspect one formal artifact and extract the actual Office or HTML text used by professional validation.
 * @param artifactPath - User-workspace file selected for formal delivery.
 * @returns Content-bound artifact identity; PDF intentionally has no untrusted best-effort text extraction.
 */
export function inspectProfessionalArtifact(artifactPath: string): ProfessionalArtifactInspection {
  const artifact = safeArtifact(artifactPath)
  const suffix = extname(artifact.path).toLowerCase()
  if (suffix === '.pdf') return inspectPdf(artifact.path, artifact.bytes)
  if (suffix === '.html' || suffix === '.htm') {
    const source = artifact.bytes.toString('utf8')
    if (!/<(?:html|body)\b/iu.test(source)) throw new Error('HTML 交付物缺少 html 或 body 根结构')
    const contentText = htmlText(source)
    if (contentText.length < 2) throw new Error('HTML 交付物未提取到可审计正文')
    return Object.freeze({
      path: artifact.path,
      format: 'html',
      sha256: sha256(artifact.bytes),
      bytes: artifact.bytes.length,
      contentText,
      contentSha256: sha256(contentText),
      units: 1,
    })
  }
  if (suffix === '.docx') return inspectOffice(artifact.path, artifact.bytes, 'docx')
  if (suffix === '.pptx') return inspectOffice(artifact.path, artifact.bytes, 'pptx')
  if (suffix === '.xlsx') return inspectOffice(artifact.path, artifact.bytes, 'xlsx')
  if (suffix === '.xlsm') return inspectOffice(artifact.path, artifact.bytes, 'xlsm')
  throw new Error(`共创专业交付不接受该文件格式：${suffix || '<none>'}`)
}

function brandingAssets(runtimeRoot: string): { identity: string; hashes: ReadonlySet<string> } {
  const configPath = join(runtimeRoot, 'references', 'brand_config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    public_identity?: { document_header?: unknown }
  }
  const identity = config.public_identity?.document_header
  if (typeof identity !== 'string' || identity.length === 0) throw new Error('签名技能包品牌身份缺失')
  const assetDir = join(runtimeRoot, 'assets')
  const assetNames = readdirSync(assetDir).filter(name => /^brand-.*\.png$/u.test(name))
  if (assetNames.length === 0) throw new Error('签名技能包品牌资产缺失')
  return { identity, hashes: new Set(assetNames.map(name => sha256(readFileSync(join(assetDir, name))))) }
}

/**
 * Read the exact public document identity from the host-verified branding runtime.
 * @param brandingRuntimeRoot - Verified skill-bundle `_runtime/gongchuang-branding` directory.
 * @returns The immutable public document identity declared by that runtime.
 */
export function professionalBrandIdentity(brandingRuntimeRoot: string): string {
  return brandingAssets(realpathSync(resolve(brandingRuntimeRoot))).identity
}

function mediaHashes(pack: ZipPackage, pattern: RegExp): string[] {
  return naturalNames(pack.entries.keys(), pattern).map(name => sha256(zipEntry(pack, name, 16 * 1024 * 1024)))
}

/**
 * Reject inherited publisher headers and watermark assets in an independently
 * generated document. Structural and content validation still run first.
 */
export function inspectProfessionalBranding(
  artifactPath: string,
  brandingRuntimeRoot: string,
): ProfessionalBrandInspection {
  const artifact = safeArtifact(artifactPath)
  const inspection = inspectProfessionalArtifact(artifact.path)
  const legacy = brandingAssets(realpathSync(resolve(brandingRuntimeRoot)))
  const markers = /gongchuang-public-brand-style|gongchuang-document-header|Gongchuang Institute Centered Watermark|_GONGCHUANG_INSTITUTE_UNIFORM_WATERMARK/iu
  if (inspection.format === 'pdf') {
    throw new Error('PDF 文档标识检查需要可信 PDF 渲染器。')
  }
  if (inspection.format === 'html') {
    const source = artifact.bytes.toString('utf8')
    if (markers.test(source)) throw new Error('HTML 仍包含旧产品的品牌页眉或水印')
    for (const image of source.matchAll(/data:image\/[^;,]+;base64,([A-Za-z0-9+/=]+)/gu)) {
      if (legacy.hashes.has(sha256(Buffer.from(image[1]!, 'base64')))) {
        throw new Error('HTML 仍包含旧产品的品牌水印资产')
      }
    }
  } else {
    const pack = parseZip(artifact.bytes)
    const prefix = inspection.format === 'docx' ? 'word' : inspection.format === 'pptx' ? 'ppt' : 'xl'
    if (mediaHashes(pack, new RegExp(`^${prefix}/media/[^/]+$`, 'u')).some(hash => legacy.hashes.has(hash))) {
      throw new Error('Office 文件仍包含旧产品的品牌水印资产')
    }
    for (const name of naturalNames(pack.entries.keys(), /\.xml$/u)) {
      const source = xmlSource(pack, name)
      const header = /(?:header|footer|slideMaster|slideLayout)/iu.test(name)
      if (markers.test(source) || (header && source.includes(legacy.identity))) {
        throw new Error(`Office 文件仍包含旧产品的品牌页眉或水印：${name}`)
      }
    }
  }
  return Object.freeze({
    ok: true, format: inspection.format, artifactSha256: inspection.sha256,
    brandIdentity: '', watermarkCount: 0,
    checks: Object.freeze(['no-legacy-brand-markers', 'no-legacy-watermark-assets']),
  })
}

/**
 * Resolve the branding runtime shipped beside the verified professional contracts.
 * @param professionalContractsPath - Host-bound `skills/delivery-contracts.json` path.
 * @returns Canonical branding runtime path inside the same signed bundle.
 */
export function brandingRuntimeFromContracts(professionalContractsPath: string): string {
  return join(dirname(realpathSync(professionalContractsPath)), '_runtime', 'gongchuang-branding')
}
