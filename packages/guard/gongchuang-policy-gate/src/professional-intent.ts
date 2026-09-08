/** Clause-scoped professional task intent shared by routing and validation. */

const PROHIBITED_ACTION = new RegExp(
  String.raw`(?:不得|禁止|不要|无需|不用|不需|不能(?:冒充|把|将|支持|证明|认定|推断|判断|给出|形成|得出)|不(?:是|作|做|继续|调用|涉及|计算|判断|分析|评估|生成|展示|声称|读取|处理|修改|导出|使用|检索|查询|访问|代表|构成|冒充)|避免)`
  + String.raw`[^，,。！？；;\n]*$|(?:不|别|未)\s*$`,
  'u',
)
const SUPPLIED_RULE = new RegExp(
  String.raw`(?:按(?:照)?|依据|根据)[^。！？；;\n]{0,16}(?:给定|提供|约定|题设|限定)[^。！？；;\n]{0,12}(?:规则|口径)`
  + String.raw`|(?:本题|题设|用户|我)[^。！？；;\n]{0,12}(?:给定|提供|限定|约定)[^。！？；;\n]{0,12}(?:规则|口径)`,
  'u',
)
const PROVIDED_DATA = new RegExp(
  String.raw`(?:仅|只)(?:按(?:照)?|依据|根据|使用|读取)[^。！？；;\n]{0,160}`
  + String.raw`(?:数据|资料|记录|清单|表|\.csv|\.xlsx?|\.md|\.docx?|\.pdf)`,
  'iu',
)
const SKILL_RESPONSIBILITY_CLAUSE = /^(?:请)?(?:明确|说明|记录)[^，,。！？；;\n]{0,80}(?:技能|Skill)[^，,。！？；;\n]{0,12}职责(?:边界|范围)$/u
const MISSING_EVIDENCE_CLAUSE = /^(?:没有|缺少|未取得|无法取得)[^，,。！？；;\n]{0,80}时(?:应|须|必须)?(?:保留|标记为|标为|列为)(?:待核验|未知|待确认|缺口)$/u

/**
 * Match an action outside an explicitly negated clause.
 * @param text - User request or candidate text.
 * @param marker - Literal action or subject marker.
 * @returns Whether at least one occurrence is affirmative.
 */
export function containsActionableMarker(text: string, marker: string): boolean {
  let offset = 0
  while (offset < text.length) {
    const index = text.indexOf(marker, offset)
    if (index < 0) return false
    const clauseStart = Math.max(
      ...['。', '！', '？', '；', ';', '，', ',', '\n'].map(separator => text.lastIndexOf(separator, index - 1)),
    ) + 1
    const prefix = text.slice(clauseStart, index)
    const endOffset = text.slice(index).search(/[，,。！？；;\n]/u)
    const clause = text.slice(clauseStart, endOffset < 0 ? text.length : index + endOffset).trim()
    // 技能分工说明和缺证据时的处理约定不是业务执行；只排除完整分句，后续请求仍生效。
    if (SKILL_RESPONSIBILITY_CLAUSE.test(clause) || MISSING_EVIDENCE_CLAUSE.test(clause)) {
      offset = index + marker.length
      continue
    }
    // 否定只约束当前分句；“不是现实政策判断”不激活政策任务，后续肯定请求仍生效。
    if (!PROHIBITED_ACTION.test(prefix)) return true
    offset = index + marker.length
  }
  return false
}

/**
 * Match any affirmative marker using the same clause rules as task routing.
 * @param text - Text whose intent is being classified.
 * @param markers - Literal actions or subjects.
 * @returns Whether an affirmative occurrence exists.
 */
export function containsActionableAny(text: string, markers: readonly string[]): boolean {
  return markers.some(marker => containsActionableMarker(text, marker))
}

/**
 * Detect an explicit exclusion of real policy or eligibility judgments.
 * @param text - User request or candidate scope disclosure.
 * @returns Whether the text declares the limited non-policy scope.
 */
export function excludesPolicyJudgment(text: string): boolean {
  return /(?:不(?:作(?:出|为)?|做|进行|涉及|判断)|不是|不代表|不构成)[^。！？；;\n]{0,24}(?:政策(?:资格)?(?:判断|结论|认定)|申报资格(?:判断|结论|认定)?|补贴资格(?:判断|结论|认定)?)/u.test(text)
}

/**
 * Recognize a calculation explicitly limited by the user to supplied rules.
 * @param userText - Host-captured user intent, never model tool arguments.
 * @returns Whether policy retrieval is unrelated to this requested calculation.
 */
export function isUserRuleCalculation(userText: string): boolean {
  return SUPPLIED_RULE.test(userText) && excludesPolicyJudgment(userText)
    && containsActionableAny(userText, ['计算', '核算', '复算', '测算', '金额核验'])
    && !containsActionableAny(userText, [
      '政策检索', '查询政策', '政策资格', '申报资格', '补贴资格', '申报条件', '政策条件', '补贴条件',
      '能否申报', '能否获得补贴', '能否获得补助',
    ])
}

/**
 * Recognize a comparison limited to user-supplied records, not market research.
 * @param userText - Host-captured user request, never model-supplied task labels.
 * @returns Whether only the supplied sample is being compared.
 */
export function isProvidedDataComparison(userText: string): boolean {
  return PROVIDED_DATA.test(userText)
    && containsActionableAny(userText, ['比较', '对比', '对标', '排序'])
    && !containsActionableAny(userText, [
      '市场地位结论', '市场份额', '市场占有率', '行业排名', '全国排名', '全省排名',
      '查询真实企业', '核验企业身份', '查询政策', '能否申报', '申报资格',
    ])
}
