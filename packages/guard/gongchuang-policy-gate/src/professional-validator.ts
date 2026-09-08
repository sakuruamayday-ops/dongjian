/** Deterministic candidate validation for the 洞见 professional execution chain. */

import { createHash } from 'node:crypto'
import type { ProfessionalContracts, ProfessionalResponseDepth } from './index.ts'
import { containsActionableAny, excludesPolicyJudgment, isProvidedDataComparison, isUserRuleCalculation } from './professional-intent.ts'

/** One traceable fact supplied to the professional candidate validator. */
export interface ProfessionalEvidence {
  id: string
  kind: string
  status: 'verified' | 'user-provided' | 'calculated' | 'pending' | 'conflict'
  source: string
  /** Optional Host receipt disambiguator; verified rows and facts read from customer files otherwise bind automatically. */
  toolCallId?: string
  sourceUrl?: string
  sha256?: string
  asOf?: string
  values?: string[]
}

/** One deterministic calculation whose result can be replayed from evidence-bound inputs. */
export interface ProfessionalCalculation {
  id: string
  operator: 'sum' | 'subtract' | 'multiply' | 'divide' | 'ratio' | 'weighted-sum'
  inputs: number[]
  weights?: number[]
  result: number
  /** IDs from the evidence array; derived calculations retain their original source evidence IDs. */
  evidenceIds: string[]
}

/** Exact candidate text and its task-scoped evidence ledger. */
export interface ProfessionalCandidateInput {
  taskType: string
  deliveryMode: 'chat' | 'artifact'
  candidateText: string
  artifactPath?: string
  artifactFormat?: string
  deliveryProfileId?: string
  sourceText?: string
  evidence: ProfessionalEvidence[]
  calculations?: ProfessionalCalculation[]
}

/** Successful immutable validation receipt returned to the policy gate. */
export interface ProfessionalCandidateResult {
  ok: true
  taskType: string
  deliveryMode: 'chat' | 'artifact'
  candidateSha256: string
  evidenceIds: string[]
  checks: string[]
  advisoryIssues: string[]
}

/**
 * Normalize candidate text before hashing or comparing it with the final answer.
 * @param value - Candidate text to normalize.
 * @returns Text with LF line endings and no surrounding whitespace.
 */
function normalizedText(value: string): string {
  return value.replaceAll('\r\n', '\n').trim()
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function withoutNonFactIdentifiers(value: string): string {
  return value
    .replace(/(?<![A-Z0-9])(?:GB(?:\/T)?|GJB|HG\/T|JB\/T|QB\/T|YY\/T|ISO|IEC|ASTM|DIN|EN|T\/[A-Z0-9]+)\s*\d+(?:\.\d+)*(?:[-—–]\d{2,4})?(?![A-Z0-9])/giu, '')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/gu, '')
    .replace(/(?<!\d)(?:\d{15}|\d{17}[\dXx]|\d{18})(?!\d)/gu, '')
}

const LATIN_MEASUREMENT_UNIT = String.raw`(?:kwh|mpa|gpa|rpm|fps|dpi|ppm|ppb|mm|cm|km|ms|kg|kw|gb|mb|tb|db|min|nm|um|m|s|g|l|v|a|w|h)`

function numberTokens(value: string): string[] {
  // 数值后紧跟拉丁单位时仍要提取完整小数。旧表达式会把 `0.20mm`
  // 回退截成孤立的 `0`，导致同一证据中的 `0.20 毫米`无法绑定，并把
  // 一份本来可核验的报告错误降级为待完善。末尾同时禁止在小数点前
  // 截断，未知字母后缀仍保持不识别，避免把型号片段当作业务事实。
  const pattern = new RegExp(
    String.raw`(?<![A-Za-z\d])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?=\s*${LATIN_MEASUREMENT_UNIT}\b|(?![A-Za-z\d.]))`,
    'giu',
  )
  return unique(withoutNonFactIdentifiers(value).match(pattern) ?? [])
}

/**
 * Extract quantitative fact tokens while excluding standards and personal identifiers.
 * @param value - Trusted evidence or candidate text.
 * @returns Unique numeric tokens eligible for professional fact binding.
 */
export function professionalFactNumberTokens(value: string): string[] {
  return numberTokens(value)
}

/**
 * Extract numbers from evidence values, including real CSV rows.
 *
 * A CSV row such as `...,600,800,180,700,...` is lexically identical to one
 * very large thousands-separated number. The generic candidate scanner must
 * keep the latter interpretation, while evidence that is visibly a CSV record
 * must expose each field independently. Otherwise a genuine field such as
 * `140` disappears from the evidence set and the report is rejected as
 * unbound. The small parser honours quoted commas so a legal `"7,200.00"`
 * cell remains one value.
 * @param value - 受信任证据中的原始文本。
 * @returns 可用于专业事实绑定的去重数值标记。
 */
export function professionalEvidenceNumberTokens(value: string): string[] {
  const tokens = [...numberTokens(value)]
  for (const line of value.split('\n')) {
    const fields: string[] = []
    let field = ''
    let quoted = false
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index] as string
      if (character === '"') {
        if (quoted && line[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = !quoted
        }
      } else if (character === ',' && !quoted) {
        fields.push(field)
        field = ''
      } else {
        field += character
      }
    }
    fields.push(field)
    const csvRecord = fields.length >= 4
      && fields.some(candidate => /[\p{L}\p{Script=Han}]/u.test(candidate))
    if (csvRecord) {
      for (const candidate of fields) tokens.push(...numberTokens(candidate))
    }
  }
  return unique(tokens)
}

function numberKey(token: string): string {
  const raw = (token.endsWith('%') ? token.slice(0, -1) : token).replaceAll(',', '')
  const numeric = Number(raw)
  return Number.isFinite(numeric) ? String(numeric) : raw
}

function safeNumberLabel(token: string): string {
  return /^\d{7,}$/u.test(token) ? '敏感或长标识符（已脱敏）' : token
}

function roundedNumberMatches(token: string, expected: number): boolean {
  const percent = token.endsWith('%')
  const raw = (percent ? token.slice(0, -1) : token).replaceAll(',', '')
  const actual = Number(raw)
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false
  const decimalPlaces = raw.includes('.') ? raw.length - raw.indexOf('.') - 1 : 0
  const displayTolerance = 0.5 * 10 ** -decimalPlaces
  const floatingTolerance = Math.max(1, Math.abs(expected)) * 1e-12
  const tolerance = Math.max(displayTolerance, floatingTolerance)
  return Math.abs(actual - expected) <= tolerance
}

function calculationBindsNumber(token: string, calculations: readonly ProfessionalCalculation[]): boolean {
  const percent = token.endsWith('%')
  return calculations.some((calculation) => {
    if (percent) {
      const expected = calculation.operator === 'ratio'
        ? calculation.result
        : calculation.result * 100
      return roundedNumberMatches(token, expected)
    }
    return roundedNumberMatches(token, calculation.result)
      || calculation.inputs.some(input => roundedNumberMatches(token, input))
  })
}

const PLAN_TIMELINE_MARKERS = /(?:未来.{0,8}(?:规划|计划)|(?:\d+\s*天)?整改|(?:行动|实施|补强|发展|申报)计划|能力升级|路线图|时间安排|完成时间|时间窗口|拟于|拟在|建议周期)/u
const PAGE_HEADING_MARKERS = new RegExp([
  '执行摘要|口径与证据|财务总览|盈利能力|现金流|偿债能力|资产质量|票据与保证金|往来与关联方|对外担保',
  '所得税与研发|暂估预提与收入|风险地图|整改路线|计算过程与来源|最终判断|来源与限制|证据边界|风险清单|附录',
].join('|'), 'u')
const STANDARD_TOP_LEVEL_HEADING_MARKERS = new RegExp([
  '^(?:范围|规范性引用文件|术语和定义|符号和缩略语|分类(?:、|和)?编码|产品分类、型号或标记',
  '技术要求|要求|试验方法|检验规则|标志、包装、运输和贮存|标志|包装|运输|贮存|参考文献|索引)$',
].join('|'), 'u')
const PUBLIC_INTERNAL_DIGEST = /(?:SHA[\s_-]*256|(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f]))/iu
const LEADING_MEASURED_DECIMAL = /^\s*\d+(?:\.\d+){1,4}[ \t]*(?:%|个百分点|亿元|万元|元|人|项|件|个|台|套|年|月|日|天|周|季度|平方米|亩|吨|公斤|千克|公里|千米|厘米|毫米|米)/u

function normalizeLayoutForFactScan(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/(?<=[\p{Script=Han}，。；：！？、（）【】《》])[ \t]+(?=[\p{Script=Han}\d，。；：！？、（）【】《》])/gu, '')
    .replace(/(?<=\d)[ \t]+(?=[\p{Script=Han}，。；：！？、（）【】《》])/gu, '')
    .replace(/(?<=\d)[ \t]+\.(?=\d)/gu, '.')
    .replace(/(?<=\d)\.[ \t]+(?=\d)/gu, '.')
}

function flatTableOrdinalLineIndexes(lines: readonly string[]): ReadonlySet<number> {
  const ordinals = new Set<number>()
  for (let headerIndex = 0; headerIndex < lines.length; headerIndex += 1) {
    if (normalizeLayoutForFactScan(lines[headerIndex] ?? '').trim() !== '序号') continue
    let best: { stride: number; count: number } | undefined
    // Office 正文提取会把表格单元格展平成逐行文本。只有在“序号”表头后出现
    // 至少三个等间距、严格递增的整数时，才把这些行视为排版序号。不能简单
    // 忽略所有独立整数，否则单元格中的人数、金额和年限也会被错当成布局。
    for (let stride = 2; stride <= 32; stride += 1) {
      let count = 0
      for (let row = 1; headerIndex + row * stride < lines.length; row += 1) {
        const value = normalizeLayoutForFactScan(lines[headerIndex + row * stride] ?? '').trim()
        if (value !== String(row)) break
        count += 1
      }
      if (count >= 3 && (best === undefined || count > best.count)) best = { stride, count }
    }
    if (best === undefined) continue
    for (let row = 1; row <= best.count; row += 1) ordinals.add(headerIndex + row * best.stride)
  }
  return ordinals
}

function standardClauseNumbers(value: string, taskType: string): ReadonlySet<string> {
  const clauses = new Set<string>()
  const topLevelMarkers = new Set<string>()
  for (const line of value.split('\n')) {
    const normalized = line.normalize('NFKC')
    const match = /^\s*(?:#{1,6}\s+)?(\d+(?:\.\d+){1,4})(?:(?:[.)、]\s*|\s+)|(?=[\u3400-\u9fffA-Za-z]))/u.exec(normalized)
    if (match?.[1] !== undefined) clauses.add(match[1])
    const topLevel = /^\s*(?:#{1,6}\s+)?\d{1,2}(?:(?:[.)、]\s*|\s+)|(?=[\u3400-\u9fffA-Za-z]))(.+?)\s*$/u.exec(normalized)
    const marker = topLevel?.[1]?.trim()
    if (marker !== undefined && STANDARD_TOP_LEVEL_HEADING_MARKERS.test(marker)) topLevelMarkers.add(marker)
  }

  const declaredStandard = /(?:^|[-_])standard(?:$|[-_])/iu.test(taskType)
  const structuredStandard = /GB\s*\/\s*T\s*1\.1(?:\s*[-—]\s*\d{4})?/iu.test(value)
    && topLevelMarkers.size >= 4
  // taskType 由模型填写，不能让一次 `report`/`standard` 误分类把标准条款号
  // 重新解释成业务数值。正文同时具备 GB/T 1.1 前言和至少四个标准专属一级
  // 章节时，按实际文档结构识别；普通报告即使提到某项标准也不会命中。
  return declaredStandard || structuredStandard ? clauses : new Set()
}

function withoutDocumentMetadataNumbers(
  value: string,
  structuralClauses: ReadonlySet<string> = new Set(),
): string {
  const lines = value.split('\n')
  const flatTableOrdinals = flatTableOrdinalLineIndexes(lines)
  let insidePlanTimeline = false
  return lines.map((line, index) => {
    const headingLine = line
      .normalize('NFKC')
      .replace(/(?<=\d)[ \t]+\.(?=\d)/gu, '.')
      .replace(/(?<=\d)\.[ \t]+(?=\d)/gu, '.')
    const layoutLine = normalizeLayoutForFactScan(line)
    const nextContentLine = lines.slice(index + 1).find(candidate => candidate.trim() !== '')?.normalize('NFKC')
    const numberedHeading = /^\s*\d+(?:\.\d+){1,4}\s+(.+)$/u.exec(headingLine)
    const pageHeading = /^\s*\d{1,2}\s+(.+)$/u.exec(headingLine)
    const standardTopLevelHeading = /^\s*\d{1,2}\s+(.+?)\s*$/u.exec(headingLine)
    const isStandardTopLevelHeading = standardTopLevelHeading !== null
      && STANDARD_TOP_LEVEL_HEADING_MARKERS.test(standardTopLevelHeading[1] as string)
    const isPageHeading = pageHeading !== null && PAGE_HEADING_MARKERS.test(pageHeading[1] as string)
    const isSplitPageHeading = /^\s*\d{1,2}\s*$/u.test(headingLine)
      && nextContentLine !== undefined
      && PAGE_HEADING_MARKERS.test(nextContentLine)
    const isWrappedPlanPhase = insidePlanTimeline
      && /^\s*\d+\s*(?:至|到|-|—|–)\s*\d+(?=\s+)/u.test(headingLine)
    const isSplitPlanPhase = insidePlanTimeline
      && /^\s*\d+(?:\s*(?:至|到|-|—|–)\s*\d+)?\s*$/u.test(headingLine)
      && nextContentLine !== undefined
      && /^\s*(?:个?工作日|天|日|周|个月|月|季度|年)(?:\s|$)/u.test(nextContentLine)
    if (numberedHeading !== null) insidePlanTimeline = PLAN_TIMELINE_MARKERS.test(numberedHeading[1] as string)
    else if (isPageHeading) {
      // PDF/HTML extraction often emits a bare page number before the page
      // title. Keep the title for structural checks, but never treat that
      // layout number as an enterprise fact. A timeline page also keeps its
      // scope across the following extracted table rows.
      insidePlanTimeline = PLAN_TIMELINE_MARKERS.test(pageHeading[1] as string)
    }
    else if (isSplitPageHeading) insidePlanTimeline = PLAN_TIMELINE_MARKERS.test(nextContentLine)
    else if (/^\s*[1-9](?:[.)、]\s*|\s+)(?=[\u3400-\u9fffA-Za-z])/u.test(headingLine)) insidePlanTimeline = false
    else if (/^\s*(?:第[一二三四五六七八九十百]+部分|附录|结语)\b/u.test(headingLine)) insidePlanTimeline = false

    let visible = flatTableOrdinals.has(index) ? '' : layoutLine
      // 行内流程编号和清单篇幅限制也是排版信息；只去掉序号，金额、年限等事实仍须绑定。
      .replace(/((?:顺序|流程|步骤)[^:：\n]*[:：])\s*\d+[.)、]\s+/gu, '$1')
      .replace(/(→\s*)\d+[.)、]\s+/gu, '$1')
      // “第 5 项”“第6项”引用的是表格或门槛的结构位置，不是企业事实。
      // 只移除带“第…项”边界的阿拉伯数字；同句中的分值、金额等仍继续校验。
      .replace(/第\s*\d+\s*项/gu, '第项')
      .replace(/((?:高影响)?(?:待核验条件|资料清单|行动清单))[(（](?:不超过|最多|<=|≤)\s*\d+\s*项[)）]/gu, '$1')
      .replace(/\d+(?:\.\d+){1,4}(?=(?:节|章节|部分|项目矩阵|规划|表|图))/gu, '')
      // 标准正文会反复写“验证5.1”“按5.1的要求”以及“式(1)”。这些是
      // 条款、表图和公式的结构坐标，不是需要证据绑定的业务数值。只在明确的
      // 引用词和结构边界内移除；`5.1%`、`5.1万元` 等量值仍进入事实校验。
      .replace(/(?:见|详见|参见|按|与|和|验证|对应|符合|依据|满足)\s*(?:第\s*)?\d+(?:\.\d+){1,4}(?:\s*(?:至|到|及|和|与|、|,|，|[-—–~～])\s*\d+(?:\.\d+){1,4})*\s*(?:条|款|节|章)?(?=\s*(?:的(?:要求|规定)?|要求|规定|试验|方法|项目|[）)\]】,，。.；;:：]|$))/gu, match => match.replace(/\d+(?:\.\d+){1,4}/gu, ''))
      // 先处理完整范围，再处理“与3.4五年规划”这类紧跟中文标题的单个引用；
      // 顺序不能颠倒，否则“按6.4至6.6”会先残留一个孤立的6.6。
      .replace(/(?:见|详见|参见|按|与|和)\s*\d+(?:\.\d+){1,4}(?=[\u3400-\u9fff])/gu, match => match.replace(/\d+(?:\.\d+){1,4}/u, ''))
      .replace(/(?:表|图|式|公式)\s*[（(]?\s*\d+(?:\.\d+){0,4}\s*[）)]?/gu, match => match.replace(/\d+(?:\.\d+){0,4}/u, ''))
      // 企业标准常以“使用 6.2 规定的样品”“外观（5.8）”或
      // “即 5.1～5.9”回指自身条款。这里只忽略本标准正文中已定义的条款号；
      // 未定义的小数以及 `5.1%`、`5.1 万元`等业务量值仍须绑定证据。
      .replace(/(?:使用|根据|按照|在)\s*(\d+(?:\.\d+){1,4})(?=\s*(?:规定|条款))/gu, (match, clause: string) => (
        structuralClauses.has(clause) ? match.replace(clause, '') : match
      ))
      .replace(/[（(]\s*(\d+(?:\.\d+){1,4})\s*[）)]/gu, (match, clause: string) => (
        structuralClauses.has(clause) ? match.replace(clause, '') : match
      ))
      .replace(/(?:即|包括|涵盖)\s*(\d+(?:\.\d+){1,4})\s*(?:至|到|[-—–~～])\s*(\d+(?:\.\d+){1,4})/gu,
        (match, start: string, end: string) => (
          structuralClauses.has(start) && structuralClauses.has(end)
            ? match.replace(start, '').replace(end, '')
            : match
        ))
      // A displayed delivery filename is already bound by the artifact hash.
      // Its release/date suffix must not be mistaken for a business number.
      .replace(/[\p{L}\p{N}_().（）\-]+\.(?:pdf|docx|xlsx|xlsm|pptx|html?)/giu, '')
      // The report issue date is host/document metadata. Ordinary policy and
      // enterprise dates remain subject to evidence binding.
      .replace(/(?:报告|生成|出具|制表|交付)日期\s*[:：]?\s*(?:\d{4}年\d{1,2}月\d{1,2}日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/gu, '')
      // The analysis/data period labels the report scope. Calendar day 31 is
      // not an enterprise claim; contract, establishment and policy dates do
      // not use these labels and remain evidence-bound.
      .replace(/(?:分析|数据|报告|统计|核验)期间\s*[:：]?\s*(?:\d{4}年\d{1,2}月\d{1,2}日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s*(?:至|到|[-—–~～])\s*(?:\d{4}年\d{1,2}月\d{1,2}日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}))?/gu, '')
      // A duration directly naming its remediation plan is itself a plan
      // coordinate even when PDF extraction splits the surrounding heading.
      .replace(/\d+\s*天(?=整改)/gu, '')
      // 365 is a fixed unit-conversion constant in turnover-day formulas, not
      // a customer fact. Only exempt it when the multiplication sign is
      // present; an independent claim containing 365 still needs evidence.
      .replace(/[x×*]\s*365(?=[^\d]|$)/giu, '')

    // 层级标题属于版式，但行首带业务单位的小数是事实。两者不能只凭 `2.5`
    // 的字形判断，否则金额、比例、人数和期限会被当成章节号静默放过。
    if (!LEADING_MEASURED_DECIMAL.test(layoutLine)) {
      visible = visible.replace(
        /^\s*\d+(?:\.\d+){1,4}(?:(?:[.)、]\s*|\s+)|(?=[\u3400-\u9fffA-Za-z]))/u,
        '',
      )
    }
    if (isStandardTopLevelHeading) visible = visible.replace(/^\s*\d{1,2}/u, '')

    // Layout normalization intentionally removes the gap between a number and
    // a Chinese title. Use the unmodified heading decision to strip the page
    // label after normalization, including forms such as `15计算过程`.
    if (isPageHeading) visible = visible.replace(/^\s*\d{1,2}/u, '')
    // PDF extractors may put the page number and title on separate lines.
    // Only suppress a bare number when the next non-empty line is a known page
    // title, so a genuine stand-alone business value remains evidence-bound.
    if (isSplitPageHeading) visible = ''

    if (insidePlanTimeline || PLAN_TIMELINE_MARKERS.test(visible)) {
      // Only time coordinates inside an explicitly labelled proposed plan are
      // exempt. Money, percentages, people, IP counts and every other number
      // on the same line continue through the normal evidence gate.
      visible = visible
        .replace(/第?\s*\d+(?:\s*(?:至|到|-|—|–)\s*\d+)?\s*(?:个?工作日|天|日|周|个月|月|季度|年)/gu, '')
        .replace(/(?<!\d)(?:19|20)\d{2}(?:\s*(?:年|年度))?(?!\d)/gu, '')
      // Wide PDF tables sometimes wrap the unit in `31—60 天` onto the next
      // line. A leading, whitespace-delimited interval on a labelled plan
      // page is the phase coordinate, not an enterprise fact. Amount ranges
      // such as `100—200万元` remain visible because they have no separator.
      if (isWrappedPlanPhase) visible = visible.replace(/^\s*\d+\s*(?:至|到|-|—|–)\s*\d+/u, '')
      // 表格抽取也可能把 `60天` 或 `31-60天` 拆成相邻两行。只在已经确认的计划页、
      // 且下一行是时间单位时忽略这个独立数字或区间；`90` 后接 `万元` 仍须绑定。
      if (isSplitPlanPhase) visible = ''
    }
    return visible
  }).join('\n')
}

function candidateFactNumberTokens(value: string, taskType = ''): string[] {
  const structuralClauses = standardClauseNumbers(value, taskType)
  const withoutLinksAndLayout = withoutDocumentMetadataNumbers(value
    // DOCX/PDF 抽取可能把清单序号输出成 `1. 2026年` 或 `2 . 2025年`。
    // 必须在布局归一化前去掉序号，否则会压缩成 `1.2026` 或 `2.2025`。
    // 这里只收窄到“序号后紧跟四位年份”，不会误伤 `3. 4` 这类层级标题。
    .replaceAll(/^[ \t]*\d{1,3}[ \t]*[.、）)][ \t]+(?=(?:19|20)\d{2}(?:[ \t]*年|\b))/gmu, '')
    // 必须在版式归一化前处理 Markdown 标题；归一化会把 `3.1 术语`
    // 压成 `3.1术语`，届时章节号与紧随其后的中文指标难以可靠区分。
    .replaceAll(/^\s{0,3}#{1,6}\s+\d+(?:\.\d+){0,4}(?:(?:[)、]|\.(?!\d))\s*|\s+)/gmu, ''), structuralClauses)
    .replaceAll(/https?:\/\/[^\s)\]}>]+/gu, '')
    // Evidence and calculation identifiers are receipt metadata, not facts.
    // A reference such as `ev-03` must not create an unbound business number.
    .replaceAll(/\b(?:ev|evidence|calc|calculation)[-_]\d+\b/giu, '')
    // Evidence access timestamps are receipt metadata, not business facts.
    // Keep ordinary policy dates (for example 2026年5月12日) in the evidence
    // binding check while ignoring ISO/UTC clock fragments copied from receipts.
    .replaceAll(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*(?:Z|UTC)\b/giu, '')
    .replaceAll(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*(?:Z|UTC)\b/giu, '')
    .replaceAll(/^\s*\d+[.)、]\s+/gmu, '')
    .replaceAll(/^\s*\|\s*\d+\s*\|/gmu, '| |')
    .replaceAll(/\[\d+\]/gu, '')
  return numberTokens(withoutLinksAndLayout)
}

function companyNames(value: string): string[] {
  return unique(value.match(/[\u3400-\u9fff]{2,30}(?:有限责任公司|股份有限公司|有限公司|集团公司)/gu) ?? [])
}

function unifiedSocialCreditCodes(value: string): string[] {
  return unique(value.toUpperCase().match(/(?<![0-9A-Z])[0-9A-Z]{18}(?![0-9A-Z])/gu) ?? [])
}

function lockedHumanizerTerms(value: string): string[] {
  const policyTitles = value.match(/《[^》\r\n]{2,80}》/gu) ?? []
  const identifiers = value.match(/(?:CN|ZL)[A-Z0-9.\-]{5,}/giu) ?? []
  return unique([...numberTokens(value), ...companyNames(value), ...policyTitles, ...identifiers])
}

function requiredMarkerErrors(
  contracts: ProfessionalContracts,
  requiredSkills: readonly string[],
  candidate: string,
  responseDepth: ProfessionalResponseDepth,
): string[] {
  const errors: string[] = []
  for (const skill of requiredSkills) {
    const rule = contracts.skills.get(skill)
    if (rule === undefined) continue
    const groups = responseDepth === 'formal'
      ? rule.requiredMarkerGroups
      : responseDepth === 'analysis'
        ? rule.analysisMarkerGroups ?? []
        : rule.queryMarkerGroups ?? []
    let cursor = 0
    for (const [groupIndex, group] of groups.entries()) {
      const found = group
        .map(marker => ({ marker, index: candidate.indexOf(marker, cursor) }))
        .filter(item => item.index >= 0)
        .sort((left, right) => left.index - right.index)[0]
      if (found === undefined) {
        const orderHint = groupIndex === 0
          ? '本组必须作为该技能的第一组标记出现'
          : `本组必须出现在第 ${String(groupIndex)} 组标记之后`
        errors.push(
          `${skill} 第 ${String(groupIndex + 1)} 组缺少或顺序错误；`
          + `本组只需原样出现任意一个备选标记：${group.join('、')}；${orderHint}。`
          + '斜杠仅用于展示备选关系，不要把备选词连写。',
        )
      } else {
        cursor = found.index + found.marker.length
      }
    }
  }
  return errors
}

function orderedMarkerErrors(candidate: string, markers: readonly string[], label: string): string[] {
  const errors: string[] = []
  const searchable = candidate.replace(/\s+/gu, '')
  let cursor = 0
  for (const marker of markers) {
    const compactMarker = marker.replace(/\s+/gu, '')
    const index = searchable.indexOf(compactMarker, cursor)
    if (index < 0) errors.push(`${label}缺少或错序：${marker}`)
    else cursor = index + compactMarker.length
  }
  return errors
}

function deliveryProfileErrors(
  contracts: ProfessionalContracts,
  requiredSkills: readonly string[],
  input: ProfessionalCandidateInput,
  candidate: string,
): string[] {
  const errors: string[] = []
  const eligible = [...contracts.deliveryProfiles]
    .filter(([, profile]) => requiredSkills.includes(profile.skillId))
  if (eligible.length === 0) {
    if (input.deliveryProfileId !== undefined) errors.push('所选交付画像不属于当前激活技能')
    return errors
  }
  if (input.deliveryProfileId === undefined || input.deliveryProfileId.trim() === '') {
    return ['正式文件缺少 V1.6.11 交付画像 ID']
  }
  const profile = contracts.deliveryProfiles.get(input.deliveryProfileId)
  if (profile === undefined || !requiredSkills.includes(profile.skillId)) {
    return ['所选交付画像不存在或不属于当前激活技能']
  }
  errors.push(...orderedMarkerErrors(candidate, profile.requiredSections, `交付画像 ${input.deliveryProfileId} `))
  const compactCandidate = candidate.replace(/\s+/gu, '')
  for (const table of profile.requiredTables) {
    if (!compactCandidate.includes(table.id.replace(/\s+/gu, ''))) {
      errors.push(`交付画像 ${input.deliveryProfileId} 缺少表格：${table.id}`)
    }
    for (const column of table.requiredColumns) {
      // PDF text extraction may wrap a narrow header between Han characters,
      // for example `等\n级`. Match layout whitespace exactly as section
      // markers already do; other intervening text still cannot satisfy it.
      if (!compactCandidate.includes(column.replace(/\s+/gu, ''))) {
        errors.push(`表格 ${table.id} 缺少列：${column}`)
      }
    }
  }
  // chat 预检与最终文件必须使用同一份结构合同。过去 chat
  // 只检技能标记，artifact 才检交付画像，会让正文写入 Word 后
  // 才发现章节名不一致，迫使模型重新生成文件。格式和路径则只能
  // 在 artifact 阶段检查，因为预检时文件还不存在。
  if (input.deliveryMode === 'artifact') {
    const format = input.artifactFormat?.trim().toLowerCase()
    if (profile.artifactFormats.size > 0 && (format === undefined || !profile.artifactFormats.has(format))) {
      errors.push(`交付画像 ${input.deliveryProfileId} 不允许文件格式：${format ?? '<missing>'}`)
    }
  }
  if (profile.requiresEvidenceLedger && input.evidence.length === 0) errors.push('交付画像要求证据台账')
  if (profile.requiresSourceTrace && input.evidence.some(item => item.source.trim() === '')) {
    errors.push('交付画像存在未填写来源的证据')
  }
  if (profile.requiresPeerComparison
    && !input.evidence.some(isOfficialPeerEvidence)) {
    errors.push('交付画像要求基于已核验政府来源、官方名单或企业官方来源的同行比较')
  }
  if (profile.requiresPolicySelectionTrace && !input.evidence.some(isOfficialPolicyEvidence)) {
    // 签名技能参考文件不是客户文件。历史上模型把其中的政策基线误标为
    // user-provided，正文即使写了政策名称也会永远缺少“已核验政策”回执。
    // 诊断直接给出可执行的证据形态，确保唯一修正步骤能修参数而非重写报告。
    errors.push('交付画像要求政策选择链与官方原文：至少提供一条 kind=official-policy、status=verified 的证据；签名技能参考文件不属于客户文件，不得标为 user-provided。sourceUrl 使用该读取回执中的 gov.cn 原文网址，values 逐字复制同一回执内容')
  }
  return errors
}

function deliveryProfileAdvisoryIssues(
  contracts: ProfessionalContracts,
  input: ProfessionalCandidateInput,
  candidate: string,
): string[] {
  if (input.deliveryMode !== 'artifact' || input.deliveryProfileId === undefined) return []
  const profile = contracts.deliveryProfiles.get(input.deliveryProfileId)
  if (profile === undefined || !profile.advisoryRequirements.has('four-question-review')) return []
  const missing = contracts.fourQuestionMarkerGroups
    .filter(group => !group.some(marker => candidate.includes(marker)))
  return missing.length === 0
    ? []
    : [`交付画像 ${input.deliveryProfileId} 的四问复盘尚缺 ${String(missing.length)} 组建议内容`]
}

function isOfficialPolicyEvidence(item: ProfessionalEvidence): boolean {
  if (item.kind !== 'official-policy' || item.status !== 'verified') return false
  if (typeof item.toolCallId === 'string' && item.toolCallId.trim() !== '') return true
  try {
    const hostname = new URL(item.sourceUrl ?? '').hostname.toLowerCase()
    return hostname === 'gov.cn' || hostname.endsWith('.gov.cn')
  } catch {
    return false
  }
}

function isOfficialPeerEvidence(item: ProfessionalEvidence): boolean {
  if (item.status !== 'verified' || typeof item.toolCallId !== 'string' || item.toolCallId.trim() === '') return false
  if (item.kind === 'official-list') return true
  if (item.kind === 'official-policy' || item.kind === 'government-source') {
    try {
      const hostname = new URL(item.sourceUrl ?? '').hostname.toLowerCase()
      return hostname === 'gov.cn' || hostname.endsWith('.gov.cn')
    } catch {
      return false
    }
  }
  if (item.kind === 'enterprise-official') {
    try {
      return new URL(item.sourceUrl ?? '').protocol === 'https:'
    } catch {
      return false
    }
  }
  return false
}

function compute(calculation: ProfessionalCalculation): number | undefined {
  const values = calculation.inputs
  if (values.length === 0 || values.some(value => !Number.isFinite(value))) return undefined
  switch (calculation.operator) {
    case 'sum': return values.reduce((total, value) => total + value, 0)
    case 'subtract': return values.slice(1).reduce((total, value) => total - value, values[0] as number)
    case 'multiply': return values.reduce((total, value) => total * value, 1)
    case 'divide': return values.length === 2 && values[1] !== 0 ? values[0] as number / (values[1] as number) : undefined
    case 'ratio': return values.length === 2 && values[1] !== 0 ? (values[0] as number) / (values[1] as number) * 100 : undefined
    case 'weighted-sum': {
      if (calculation.weights?.length !== values.length
        || calculation.weights.some(value => !Number.isFinite(value))) return undefined
      return values.reduce((total, value, index) => total + value * (calculation.weights?.[index] as number), 0)
    }
  }
}

function calculationErrors(
  calculations: readonly ProfessionalCalculation[],
  evidenceIds: ReadonlySet<string>,
): string[] {
  const errors: string[] = []
  for (const calculation of calculations) {
    if (calculation.id.trim() === '' || calculation.evidenceIds.length === 0
      || calculation.evidenceIds.some(id => !evidenceIds.has(id))) {
      errors.push(`计算 ${calculation.id || '<missing>'} 未绑定有效证据；evidenceIds 只接受 evidence 数组中的 ID，派生计算沿用原始来源证据 ID，不填其他计算 ID`)
      continue
    }
    const actual = compute(calculation)
    if (actual === undefined || !Number.isFinite(calculation.result)
      || !roundedNumberMatches(String(calculation.result), actual)) {
      errors.push(`计算 ${calculation.id} 无法复算`)
    }
  }
  return errors
}

function highTechErrors(candidate: string, evidence: readonly ProfessionalEvidence[]): string[] {
  const headings = [
    '知识产权对企业竞争力的作用',
    '科技成果转化情况',
    '研究开发与技术创新组织管理情况',
    '管理与科技人员情况',
  ]
  const errors: string[] = []
  const bodies: string[] = []
  for (let index = 0; index < headings.length; index += 1) {
    const start = candidate.indexOf(headings[index] as string)
    const end = index + 1 < headings.length ? candidate.indexOf(headings[index + 1] as string, start + 1) : candidate.length
    if (start < 0 || end <= start) {
      bodies.push('')
      continue
    }
    const body = candidate.slice(start + (headings[index] as string).length, end)
    bodies.push(body)
    const count = body.match(/[\u3400-\u9fff]/gu)?.length ?? 0
    if (count < 390 || count > 450) errors.push(`${headings[index]} 中文字符数为 ${String(count)}，必须在 390–450 之间`)
  }
  if (/(?:申请|受理).{0,12}授权|授权.{0,12}(?:申请|受理)/su.test(candidate)) {
    errors.push('申请或受理状态不得表述为授权')
  }
  const kinds = new Set(evidence.map(item => item.kind))
  for (const required of ['intellectual-property', 'customer-file', 'personnel']) {
    if (!kinds.has(required)) errors.push(`高企四栏缺少 ${required} 证据`)
  }
  if (/(?:融资|估值)/u.test(candidate) && !kinds.has('financing')) errors.push('融资或估值表述缺少融资证据')

  const sectionEvidenceNumbers = (acceptedKinds: readonly string[]): ReadonlySet<string> => new Set(
    evidence.filter(item => acceptedKinds.includes(item.kind))
      .flatMap(item => item.values ?? [])
      .flatMap(numberTokens)
      .map(numberKey),
  )
  const numberBoundaries: ReadonlyArray<readonly [number, readonly string[], string]> = [
    [0, ['intellectual-property'], '知识产权栏数字只能使用知识产权材料'],
    [1, ['research-development', 'achievement-conversion', 'customer-file'], '成果转化栏数字只能使用研发与成果材料'],
    [2, ['management-system', 'management-execution', 'customer-file'], '研发组织管理栏数字只能使用制度与执行材料'],
    [3, ['personnel'], '人员栏人数、学历、留任率等数字只能使用人员材料'],
  ]
  for (const [section, acceptedKinds, message] of numberBoundaries) {
    const allowed = sectionEvidenceNumbers(acceptedKinds)
    for (const token of numberTokens(bodies[section] ?? '')) {
      if (!allowed.has(numberKey(token))) errors.push(`${message}：${safeNumberLabel(token)}`)
    }
  }

  const conversionBody = bodies[1] ?? ''
  if (/(?:收入增长率|营收增长率|客户数量|客户数|新增客户|客户[0-9一二三四五六七八九十百千万]+家)/u.test(conversionBody)) {
    errors.push('科技成果转化栏不得混入收入增长率或客户数量')
  }

  const managementBody = bodies[2] ?? ''
  const allowedSystemTitles = new Set(
    evidence.filter(item => item.kind === 'management-system' || item.kind === 'customer-file')
      .flatMap(item => item.values ?? [])
      .flatMap(value => value.match(/《[^》\r\n]{2,80}》/gu) ?? []),
  )
  for (const title of managementBody.match(/《[^》\r\n]{2,80}》/gu) ?? []) {
    if (!allowedSystemTitles.has(title)) errors.push(`研发组织管理栏制度名称未逐字绑定客户详细制度文件：${title}`)
  }
  if (/(?:已执行|已落实|已实施|实际执行|实际运行|形成.{0,12}(?:记录|台账|考核))/su.test(managementBody)
    && !kinds.has('management-execution')) {
    errors.push('制度存在与实际执行必须分别举证，当前缺少制度执行证据')
  }

  const allowedCompanies = new Set(evidence.flatMap(item => item.values ?? []).filter(value => /公司$/u.test(value)))
  for (const name of companyNames(candidate)) {
    if (!allowedCompanies.has(name)) errors.push(`企业名称未进入本任务证据：${name}`)
  }
  return errors
}

/**
 * Validate one candidate against the signed active-skill contract. Throws on any drift.
 * @param contracts - Host-verified professional delivery contracts.
 * @param requiredSkills - Skills activated for the current turn only.
 * @param input - Exact candidate, evidence, and replayable calculations.
 * @param contractSkills - Task-owning skills whose response structure applies.
 * Supporting dependencies keep factual checks without imposing another template.
 * @param responseDepth - Host-derived depth that selects the applicable marker groups.
 * @param userRequestText - Host-captured user scope, not the model's task label.
 * @returns A content-bound receipt when every deterministic check passes.
 */
export function validateProfessionalCandidate(
  contracts: ProfessionalContracts,
  requiredSkills: readonly string[],
  input: ProfessionalCandidateInput,
  contractSkills: readonly string[] = requiredSkills,
  responseDepth: ProfessionalResponseDepth = 'formal',
  userRequestText = '',
): ProfessionalCandidateResult {
  const candidate = normalizedText(input.candidateText)
  const errors: string[] = []
  const checks: string[] = []

  if (PUBLIC_INTERNAL_DIGEST.test(candidate)) {
    errors.push('对外交付不得展示内部校验值')
  }
  checks.push('public-delivery-sanitization')
  if (candidate.length < 30) errors.push('候选正文过短，无法形成专业结论')
  if (input.deliveryMode === 'artifact' && (input.artifactPath === undefined || input.artifactPath.trim() === '')) {
    errors.push('文件交付必须绑定 artifactPath')
  }
  const ids = input.evidence.map(item => item.id)
  if (ids.some(id => id.trim() === '') || new Set(ids).size !== ids.length) errors.push('证据 ID 缺失或重复')
  if (input.evidence.length === 0 && !contractSkills.includes('gongchuang-humanizer-zh')) {
    errors.push('专业任务缺少证据台账')
  }
  if (input.deliveryMode === 'chat') {
    errors.push(...requiredMarkerErrors(contracts, contractSkills, candidate, responseDepth))
    checks.push('skill-marker-order')
    if (input.deliveryProfileId !== undefined) {
      errors.push(...deliveryProfileErrors(contracts, contractSkills, input, candidate))
      checks.push('delivery-profile-preflight')
    }
  } else {
    errors.push(...deliveryProfileErrors(contracts, contractSkills, input, candidate))
    checks.push('delivery-profile-structure')
  }

  const pending = input.evidence.some(item => item.status === 'pending')
  const conflict = input.evidence.some(item => item.status === 'conflict')
  if (pending && !/(?:待核验|暂无法判断|待补)/u.test(candidate)) errors.push('存在待核验证据但正文未披露不确定性')
  if (conflict && !/(?:冲突|不一致)/u.test(candidate)) errors.push('存在冲突证据但正文未披露冲突')
  if (/(?:保证获批|确保通过|百分之百获批)/u.test(candidate)) errors.push('不得承诺项目一定获批')

  const calculations = input.calculations ?? []
  const evidenceIds = new Set(ids)
  errors.push(...calculationErrors(calculations, evidenceIds))
  if (contractSkills.includes('sme-score-preassessment') && calculations.length === 0) errors.push('评分任务缺少可复算计算')
  checks.push('calculation-replay')

  const allowedNumbers = new Set([
    ...input.evidence.flatMap(item => item.values ?? []).flatMap(professionalEvidenceNumberTokens),
    ...input.sourceText === undefined ? [] : numberTokens(input.sourceText),
    // 用户在本轮指令里直接给出的年份、页数和其他数值本身就是
    // user-provided 事实，不应再强迫模型手工复制一条证据行。只放行
    // 当前用户文本中真实出现的数值，模型新增的业务数字仍需绑定。
    ...professionalEvidenceNumberTokens(userRequestText),
  ].map(numberKey))
  for (const token of candidateFactNumberTokens(candidate, input.taskType)) {
    if (!allowedNumbers.has(numberKey(token)) && !calculationBindsNumber(token, calculations)) {
      errors.push(`数字 ${safeNumberLabel(token)} 未绑定证据或复算过程`)
    }
  }
  checks.push('numeric-evidence-binding')

  // 支持依赖不把限定核算升级成政策判断；正式文件和政策主任务不适用此范围。
  const userRuleCalculation = input.deliveryMode === 'chat' && responseDepth !== 'formal'
    && !contractSkills.includes('policy-retrieval') && isUserRuleCalculation(userRequestText)
  if (userRuleCalculation) {
    const claimsEligibility = containsActionableAny(candidate, [
      '符合申报', '符合政策', '符合补贴', '满足申报', '满足政策', '满足补贴',
      '具备申报资格', '具备补贴资格', '可以申报', '可以申请补贴', '可申报', '可享受',
      '可获补贴', '可获补助', '能申报', '补贴金额为', '补助金额为',
    ])
    if (!excludesPolicyJudgment(candidate) || claimsEligibility) {
      errors.push('限定核算须说明不构成申报资格结论，不得扩大为真实政策资格或补贴结论')
    }
    checks.push('user-rule-calculation-scope')
  }
  // 已给资料的内部比较仍绑定读取与计算，不要求把客户数据冒充官方同行证据。
  const providedComparison = input.deliveryMode === 'chat' && responseDepth !== 'formal'
    && contractSkills.includes('peer-benchmarking') && !contractSkills.includes('policy-retrieval')
    && isProvidedDataComparison(userRequestText)
  if (providedComparison) {
    const bounded = /(?:仅|只)[^。！？；;\n]{0,80}(?:样本|给定|提供|测试集|已给|输入)[^。！？；;\n]{0,80}(?:比较|对比|排序|范围)/u.test(candidate)
      || /不(?:代表|构成)[^。！？；;\n]{0,24}真实[^。！？；;\n]{0,16}(?:市场|行业)/u.test(candidate)
    const claimsStanding = containsActionableAny(candidate, [
      '是行业第一', '为行业第一', '是市场第一', '为市场第一', '行业排名第一',
      '全国排名第一', '全省排名第一', '市场份额为', '市场占有率为',
      '具备申报资格', '符合申报条件', '可获补贴',
    ])
    if (!bounded || claimsStanding) errors.push('给定资料比较须限定于输入样本，不得扩大为市场地位或申报资格结论')
    checks.push('provided-data-comparison-scope')
  }
  // 支持依赖仍会报告政策缺口，但宿主会把用户明确要求的待补稿
  // 有限收束为 draft 并继续生成文件，而不是伪装成已通过的政策结论。
  if (requiredSkills.includes('policy-retrieval') && !userRuleCalculation && !providedComparison && !input.evidence.some(isOfficialPolicyEvidence)) {
    errors.push('政策结论缺少政府官网或已校验锁定的官方原文')
  }
  if (requiredSkills.includes('peer-benchmarking')
    && !providedComparison && !input.evidence.some(isOfficialPeerEvidence)) {
    errors.push('同行结论缺少已核验政府来源、官方名单或企业官方来源')
  }
  if (responseDepth === 'formal' && contractSkills.includes('enterprise-profile')) {
    const verifiedRegistrationCodes = new Set(input.evidence
      .filter(item => item.status === 'verified')
      .flatMap(item => [item.source, ...(item.values ?? [])])
      .flatMap(unifiedSocialCreditCodes))
    const hasVerifiedRegistration = unifiedSocialCreditCodes(candidate)
      .some(code => verifiedRegistrationCodes.has(code))
    const disclosesMissingRegistration = /统一社会信用代码[\s\S]{0,48}(?:暂无法判断|未提供|待补|待核验)/u.test(candidate)
    if (!hasVerifiedRegistration && !disclosesMissingRegistration) {
      errors.push('企业画像缺少统一社会信用代码主体锚定或缺失披露')
    }
  }
  checks.push('source-classification')

  if (responseDepth === 'formal' && contractSkills.includes('high-tech-enterprise-application-drafting')) {
    errors.push(...highTechErrors(candidate, input.evidence))
    checks.push('high-tech-four-section-contract')
  }

  if (contractSkills.includes('gongchuang-humanizer-zh')) {
    if (input.sourceText === undefined || normalizedText(input.sourceText).length < 30) {
      errors.push('去 AI 味任务缺少原文，无法锁定事实')
    } else {
      for (const term of lockedHumanizerTerms(input.sourceText)) {
        if (!candidate.includes(term)) errors.push(`自然化改写丢失锁定事实：${term}`)
      }
    }
    checks.push('humanizer-fact-lock')
  }

  if (errors.length > 0) throw new Error(`洞见专业校验未通过：\n- ${unique(errors).join('\n- ')}`)
  return {
    ok: true,
    taskType: input.taskType,
    deliveryMode: input.deliveryMode,
    candidateSha256: createHash('sha256').update(candidate).digest('hex'),
    evidenceIds: [...evidenceIds].sort(),
    checks: unique(checks),
    advisoryIssues: deliveryProfileAdvisoryIssues(contracts, input, candidate),
  }
}

export { normalizedText as normalizeProfessionalCandidate }
