/** Isolated legacy Word extraction for the one signed document-read operation. */

import { createRequire } from 'node:module'
import { dirname, extname } from 'node:path'
import type { SignedSkillOperation } from './manifest.ts'

const DOCUMENT_EXTRACTION_OPERATION = 'project-application-assistant.extract-workspace-document'
const DOCUMENT_EXTRACTION_SCRIPT = 'project-application-assistant/scripts/extract_workspace_document.py'
const DOCUMENT_EXTRACTION_SCHEMA = 'gongchuang-document-extraction/v1'
const LEGACY_WORD_EXTENSIONS = new Set(['.doc', '.wps'])
const SAFE_ENVIRONMENT_NAME = /KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL|AUTH|COOKIE|PROXY|DSH_|^(?:NODE|ELECTRON)_/iu
const resolveFromHost = createRequire(import.meta.url)

/** Fixed child program. Paths are passed as argv values and never interpolated into this source. */
const LEGACY_WORD_WORKER_SOURCE = String.raw`
'use strict'

const { basename } = require('node:path')
const [extractorEntry, documentPath, declaredSuffix, containsMacrosValue] = process.argv.slice(1)
const schemaVersion = 'gongchuang-document-extraction/v1'
// Leave at least 200 KiB for JSON escaping, metadata, and the outer tool receipt.
const maxTextBytes = 400000

function emit(payload, exitCode) {
  process.stdout.write(JSON.stringify({ schema_version: schemaVersion, name: basename(documentPath || ''), ...payload }) + '\n')
  process.exitCode = exitCode
}

function normalize(value) {
  return String(value || '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function utf8Prefix(value, maximumBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return { text: value, truncated: false }
  let lower = 0
  let upper = value.length
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maximumBytes) lower = middle
    else upper = middle - 1
  }
  let end = lower
  if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1])) end -= 1
  return { text: value.slice(0, end).trimEnd(), truncated: true }
}

void (async () => {
  if (!extractorEntry || !documentPath || !['.doc', '.wps'].includes(declaredSuffix)
    || !['true', 'false'].includes(containsMacrosValue)) {
    process.stderr.write('legacy-word-worker: invalid fixed arguments\n')
    process.exitCode = 64
    return
  }
  let WordExtractor
  try {
    WordExtractor = require(extractorEntry)
  } catch {
    process.stderr.write('legacy-word-worker: runtime dependency unavailable\n')
    process.exitCode = 70
    return
  }
  const format = {
    declared_suffix: declaredSuffix,
    detected_kind: 'doc',
    contains_macros: containsMacrosValue === 'true',
    detail: '',
    retryable: false,
    macro_policy: containsMacrosValue === 'true' ? 'ignored-read-only' : 'not-present',
    formula_policy: 'not-applicable',
    external_links: 'not-followed',
  }
  try {
    const document = await new WordExtractor().extract(documentPath)
    // A successful OLE extraction means the parser found WordDocument and its
    // selected 0Table/1Table stream. Other OLE containers fail before here.
    const combined = normalize([
      document.getBody({ filterUnicode: false }),
      document.getHeaders({ filterUnicode: false, includeFooters: false }),
      document.getFooters({ filterUnicode: false }),
      document.getFootnotes({ filterUnicode: false }),
      document.getEndnotes({ filterUnicode: false }),
      document.getTextboxes({ filterUnicode: false }),
      document.getAnnotations({ filterUnicode: false }),
    ].filter(Boolean).join('\n'))
    const bounded = utf8Prefix(combined, maxTextBytes)
    emit({
      kind: 'doc',
      ...format,
      status: bounded.text === '' ? 'needs_ocr' : 'extracted',
      text: bounded.text,
      truncated: bounded.truncated,
      message: bounded.text === '' ? '未检测到可提取文字。' : '',
    }, 0)
  } catch {
    emit({
      ...format,
      status: 'conversion_required',
      message: '旧式 Word 文档未能安全提取，请另存为 DOCX、ODT 或 RTF 后重试；原文件不会被修改。',
      action: 'convert_to_supported_format',
      text: '',
      truncated: false,
    }, 0)
  }
})()
`

/** One fixed subprocess launch selected only after the signed operation and file have been validated. */
export interface LegacyWordWorkerCommand {
  readonly argv: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

function childEnvironment(executable: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: '1',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    NO_COLOR: '1',
    PATH: dirname(executable),
  }
  for (const name of Object.keys(process.env)) {
    if (SAFE_ENVIRONMENT_NAME.test(name)) env[name] = undefined
  }
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

/**
 * Select the isolated parser only after the signed detector identifies an OLE Word candidate.
 * The child parser, not the Electron Host, verifies WordDocument plus 0Table/1Table before success.
 * @param operation - Signed read-only Skill operation selected by the Host.
 * @param rendered - Host-rendered and already validated operation parameters.
 * @param detectorStdout - JSON receipt from the signed container detector.
 * @returns A fixed isolated worker command, or undefined when the input is not eligible.
 */
export function legacyWordWorkerCommand(
  operation: SignedSkillOperation,
  rendered: ReadonlyMap<string, string>,
  detectorStdout: string,
): LegacyWordWorkerCommand | undefined {
  if (operation.id !== DOCUMENT_EXTRACTION_OPERATION
    || operation.skill !== 'project-application-assistant'
    || operation.script !== DOCUMENT_EXTRACTION_SCRIPT
    || operation.sandboxMode !== 'read-only'
    || operation.stdoutJsonSchemaVersion !== DOCUMENT_EXTRACTION_SCHEMA) return undefined
  const parameter = operation.parameters.document
  const documentPath = rendered.get('document')
  if (parameter?.type !== 'workspace-input-file' || documentPath === undefined) return undefined
  const declaredSuffix = extname(documentPath).toLowerCase()
  if (!LEGACY_WORD_EXTENSIONS.has(declaredSuffix)) return undefined
  let detection: Record<string, unknown>
  try {
    const candidate: unknown = JSON.parse(detectorStdout.trim())
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined
    detection = candidate as Record<string, unknown>
  } catch {
    return undefined
  }
  // The verified Python detector owns container parsing. Requiring its exact
  // non-extractable Word result keeps renamed XLS and unknown OLE files on the
  // Python path while the Electron Host only selects a fixed child command.
  if (detection.schema_version !== DOCUMENT_EXTRACTION_SCHEMA
    || detection.declared_suffix !== declaredSuffix
    || detection.detected_kind !== 'doc'
    || detection.status !== 'conversion_required'
    || detection.action !== 'convert_to_supported_format'
    || detection.retryable !== false
    || typeof detection.contains_macros !== 'boolean') return undefined
  const extractorEntry = resolveFromHost.resolve('word-extractor')
  return Object.freeze({
    argv: Object.freeze([
      process.execPath,
      '-e',
      LEGACY_WORD_WORKER_SOURCE,
      extractorEntry,
      documentPath,
      declaredSuffix,
      detection.contains_macros ? 'true' : 'false',
    ]),
    env: childEnvironment(process.execPath),
  })
}
