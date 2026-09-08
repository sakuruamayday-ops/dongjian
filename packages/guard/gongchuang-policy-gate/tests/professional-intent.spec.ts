import { describe, expect, it } from 'vitest'
import { containsActionableAny, isUserRuleCalculation } from '../src/professional-intent.ts'

describe('professional action scope', () => {
  it.each(['不是现实政策资格判断', '不作政策资格判断', '不要进行政策资格判断'])('keeps exclusions clause-local: %s', (text) => {
    expect(containsActionableAny(text, ['政策资格'])).toBe(false)
    expect(containsActionableAny(`${text}；但请查政策资格条件。`, ['政策资格'])).toBe(true)
  })

  it('recognizes the native investment failure without any QA marker exemption', () => {
    expect(isUserRuleCalculation('本题限定测试规则：仅计 2025 年支付的新设备款，不是现实政策资格判断。逐项复算可计入额。')).toBe(true)
    expect(isUserRuleCalculation('按我提供的口径核算投资金额，不作申报资格结论。')).toBe(true)
    expect(isUserRuleCalculation('GC-QA-SKILL-24：判断申报资格。')).toBe(false)
    expect(isUserRuleCalculation('请不要按我提供的口径核算投资金额，不作申报资格结论。')).toBe(false)
    expect(isUserRuleCalculation('按给定规则核算投资金额。')).toBe(false)
  })

  it('keeps source misrepresentation constraints out of policy routing', () => {
    for (const text of ['不能冒充官方政策', '不能把测试资料作为官方政策', '不能将测试资料标为官方政策', '不冒充官方政策']) {
      expect(containsActionableAny(text, ['政策'])).toBe(false)
      expect(containsActionableAny(`${text}；请检索现行政策。`, ['政策'])).toBe(true)
    }
    expect(containsActionableAny('为什么不能申报这项政策？', ['申报', '政策'])).toBe(true)
  })

  it('distinguishes skill responsibilities and missing-evidence handling from business requests', () => {
    const scope = '明确与财务核验、投资补助技能的职责边界；没有官方政策或可靠业务证据时保留待核验。'
    expect(containsActionableAny(scope, ['财务核验', '投资补助', '官方政策'])).toBe(false)
    expect(containsActionableAny(`${scope}请执行财务核验。`, ['财务核验'])).toBe(true)
    expect(containsActionableAny('明确与财务核验技能的职责边界并实际核验企业收入。', ['财务核验'])).toBe(true)
    expect(containsActionableAny('没有官方政策时请检索政策原文。', ['官方政策', '政策原文'])).toBe(true)
    expect(containsActionableAny('不能给出真实补助资格结论。', ['补助资格'])).toBe(false)
    expect(containsActionableAny('不能形成申报资格结论，但请计算研发占比。', ['研发占比'])).toBe(true)
  })
})
