import { describe, expect, it } from 'vitest'
import type { ProfessionalCalculation, ProfessionalCandidateInput, ProfessionalContracts, ProfessionalDeliveryProfile } from '@gongchuang/client-policy-gate'
import { validateProfessionalCandidate } from '@gongchuang/client-policy-gate'

function contracts(
  rules: ProfessionalContracts['skills'] = new Map(),
  deliveryProfiles: ProfessionalContracts['deliveryProfiles'] = new Map(),
): ProfessionalContracts {
  return {
    ruleVersion: '1.6.11',
    businessDomainMarkers: [],
    policyTaskMarkers: [],
    peerTaskMarkers: [],
    fourQuestionMarkerGroups: [],
    routeResolutionSkills: new Set(),
    skills: rules,
    deliveryProfiles,
    dependencies: new Map(),
    qualityGates: new Map(),
  }
}

describe('deterministic professional candidate validator', () => {
  it('keeps a single professional query free of formal report marker groups', () => {
    const rules = new Map([['project-feasibility', {
      appliesWhenPromptContains: ['能不能申报'],
      queryMarkerGroups: [],
      analysisMarkerGroups: [],
      requiredMarkerGroups: [['总体结论'], ['硬门槛'], ['行动清单']],
    }]])
    const input = {
      taskType: 'query',
      deliveryMode: 'chat' as const,
      candidateText: '可以先核对这一项条件。现有资料只支持判断产品方向相符，其余项目条件本轮没有展开。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided' as const, source: '用户问题' }],
    }

    expect(validateProfessionalCandidate(
      contracts(rules), ['project-feasibility'], input, ['project-feasibility'], 'query',
    ).ok).toBe(true)
    expect(() => validateProfessionalCandidate(
      contracts(rules), ['project-feasibility'], input, ['project-feasibility'], 'formal',
    )).toThrow(/总体结论/u)
  })

  it('accepts a policy conclusion only when an official source is bound', () => {
    const result = validateProfessionalCandidate(contracts(), ['policy-retrieval'], {
      taskType: 'policy',
      deliveryMode: 'chat',
      candidateText: '适用版本已经依据当期官方通知核验。总体结论仍以主管部门正式受理口径为准，未命中事项保留为暂无法判断。',
      evidence: [{
        id: 'P1',
        kind: 'official-policy',
        status: 'verified',
        source: '主管部门当期通知',
        sourceUrl: 'https://example.gov.cn/notice/1',
      }],
    })
    expect(result.ok).toBe(true)
    expect(result.checks).toContain('source-classification')
  })

  const calculationRequest = '按用户给定规则核算：仅计 2025 年支付的新设备款，不作现实政策资格判断。A 为 240，D 为 30。'
  const calculationCandidate: ProfessionalCandidateInput = {
    taskType: 'investment-calculation',
    deliveryMode: 'chat',
    candidateText: '按用户给定规则核算，可计入金额为 270，即 240 + 30。该结果不构成申报资格结论，资产登记不能替代实际付款。',
    evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '用户给定事实', values: ['240', '30'] }],
    calculations: [{ id: 'C1', operator: 'sum', inputs: [240, 30], result: 270, evidenceIds: ['E1'] }],
  }

  it('checks a user-scoped calculation without demanding an unrelated policy source', () => {
    const result = validateProfessionalCandidate(
      contracts(), ['investment-subsidy-projects', 'policy-retrieval'], calculationCandidate,
      ['investment-subsidy-projects'], 'analysis', calculationRequest,
    )
    expect(result.ok).toBe(true)
    expect(result.checks).toContain('user-rule-calculation-scope')
    expect(result.checks).toContain('calculation-replay')
  })

  it.each([
    ['', 'the model task type cannot set the user scope'],
    ['按用户给定规则核算，并判断能否申报补贴。', 'actual eligibility needs policy'],
    [`${calculationRequest}另外请判断能否申报。`, 'a later affirmative request keeps policy applicable'],
  ])('keeps official policy required when %s (%s)', (request) => {
    expect(() => validateProfessionalCandidate(
      contracts(), ['investment-subsidy-projects', 'policy-retrieval'], calculationCandidate,
      ['investment-subsidy-projects'], 'analysis', request,
    )).toThrow(/政策结论缺少/u)
  })

  it('does not accept eligibility claims or missing scope disclosure in a limited calculation', () => {
    for (const candidateText of [
      `${calculationCandidate.candidateText}企业符合申报条件，可以申报补贴。`,
      '总体结论：可计入金额为 270，即 240 + 30。资产登记不能替代实际付款，未付款不能按已支付处理。',
    ]) {
      expect(() => validateProfessionalCandidate(
        contracts(), ['investment-subsidy-projects', 'policy-retrieval'], { ...calculationCandidate, candidateText },
        ['investment-subsidy-projects'], 'analysis', calculationRequest,
      )).toThrow(/限定核算/u)
    }
  })

  it('retains arithmetic, direct-policy and formal-artifact checks for user rules', () => {
    expect(() => validateProfessionalCandidate(
      contracts(), ['investment-subsidy-projects', 'policy-retrieval'], {
        ...calculationCandidate,
        calculations: [{ id: 'C1', operator: 'sum', inputs: [240, 30], result: 280, evidenceIds: ['E1'] }],
      }, ['investment-subsidy-projects'], 'analysis', calculationRequest,
    )).toThrow(/复算/u)
    expect(() => validateProfessionalCandidate(
      contracts(), ['policy-retrieval'], calculationCandidate, ['policy-retrieval'], 'analysis', calculationRequest,
    )).toThrow(/政策结论缺少/u)
    expect(() => validateProfessionalCandidate(
      contracts(), ['investment-subsidy-projects', 'policy-retrieval'], {
        ...calculationCandidate, deliveryMode: 'artifact', artifactPath: '/fixture/report.docx', artifactFormat: 'docx',
      }, ['investment-subsidy-projects'], 'formal', calculationRequest,
    )).toThrow(/政策结论缺少/u)
  })

  it('never treats a digest shape as official-source authority', () => {
    expect(() => validateProfessionalCandidate(contracts(), ['policy-retrieval'], {
      taskType: 'policy',
      deliveryMode: 'chat',
      candidateText: '总体结论仅覆盖已经核验的主管部门原文，未取得官方依据的事项继续列为待核验，不作确定判断。',
      evidence: [{
        id: 'P1', kind: 'official-policy', status: 'verified', source: '非政府网页',
        sourceUrl: 'https://example.com/notice', sha256: 'a'.repeat(64),
      }],
    })).toThrow(/缺少政府官网或已校验锁定的官方原文/u)

    const result = validateProfessionalCandidate(contracts(), ['policy-retrieval'], {
      taskType: 'policy',
      deliveryMode: 'chat',
      candidateText: '总体结论仅覆盖已经核验的主管部门原文，未取得官方依据的事项继续列为待核验，不作确定判断。',
      evidence: [{
        id: 'P1', kind: 'official-policy', status: 'verified', source: '本轮受信任读取的主管部门原文',
        toolCallId: 'trusted-read-1',
      }],
    })
    expect(result.ok).toBe(true)
  })

  const comparisonRequest = '同行对标，仅依据用户提供的数据比较 1800 与 2400，在样本内部排序，不判断真实企业市场地位结论。'
  const comparisonCandidate: ProfessionalCandidateInput = {
    taskType: 'provided-data-comparison', deliveryMode: 'chat',
    candidateText: '仅在用户提供的样本内部比较，乙收入 2400 高于甲收入 1800。该排序不代表真实行业地位，缺少市场分母不能计算市场份额。',
    evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '用户给定记录', values: ['1800', '2400'] }],
  }

  it('does not demand official research for a supplied-record comparison', () => {
    const result = validateProfessionalCandidate(
      contracts(), ['peer-benchmarking', 'policy-retrieval'], comparisonCandidate,
      ['peer-benchmarking'], 'analysis', comparisonRequest,
    )
    expect(result.ok).toBe(true)
    expect(result.checks).toContain('provided-data-comparison-scope')
  })

  it.each([
    '',
    '仅依据用户提供的数据比较 1800 与 2400，并判断市场份额。',
    '请查询真实企业，再完成同行比较。',
  ])('does not let a model label suppress official peer research: %s', (request) => {
    expect(() => validateProfessionalCandidate(
      contracts(), ['peer-benchmarking'], comparisonCandidate, ['peer-benchmarking'], 'analysis', request,
    )).toThrow(/同行结论缺少/u)
  })

  it('keeps arithmetic, scope and formal-delivery checks in a supplied-record comparison', () => {
    for (const candidateText of [
      `${comparisonCandidate.candidateText}该企业是行业第一。`,
      '乙收入 2400 高于甲收入 1800。已按收入规模得出同行结论，其余数据不再补充。',
    ]) {
      expect(() => validateProfessionalCandidate(
        contracts(), ['peer-benchmarking'], { ...comparisonCandidate, candidateText },
        ['peer-benchmarking'], 'analysis', comparisonRequest,
      )).toThrow(/给定资料比较/u)
    }
    expect(() => validateProfessionalCandidate(
      contracts(), ['peer-benchmarking'], {
        ...comparisonCandidate,
        calculations: [{ id: 'C1', operator: 'sum', inputs: [1800, 2400], result: 4000, evidenceIds: ['E1'] }],
      }, ['peer-benchmarking'], 'analysis', comparisonRequest,
    )).toThrow(/复算/u)
    expect(() => validateProfessionalCandidate(
      contracts(), ['peer-benchmarking'], {
        ...comparisonCandidate, deliveryMode: 'artifact', artifactPath: '/fixture/report.docx', artifactFormat: 'docx',
      }, ['peer-benchmarking'], 'formal', comparisonRequest,
    )).toThrow(/同行结论缺少/u)
  })

  it('requires a Host receipt rather than a digest for a local official-list peer source', () => {
    expect(() => validateProfessionalCandidate(contracts(), ['peer-benchmarking'], {
      taskType: 'peer-comparison',
      deliveryMode: 'chat',
      candidateText: '同行结论仅覆盖已经核验的官方名单，未进入名单或尚未核对的企业继续列为待核验，不作扩大推断。',
      evidence: [{
        id: 'L1', kind: 'official-list', status: 'verified', source: '本地官方名单', sha256: 'b'.repeat(64),
      }],
    })).toThrow(/同行结论缺少已核验政府来源/u)

    const result = validateProfessionalCandidate(contracts(), ['peer-benchmarking'], {
      taskType: 'peer-comparison',
      deliveryMode: 'chat',
      candidateText: '同行结论仅覆盖已经核验的官方名单，未进入名单或尚未核对的企业继续列为待核验，不作扩大推断。',
      evidence: [{
        id: 'L1', kind: 'official-list', status: 'verified', source: '本轮受信任读取的官方名单',
        toolCallId: 'trusted-read-2',
      }],
    })
    expect(result.ok).toBe(true)
  })

  it('rejects internal digests from every user-facing professional delivery', () => {
    expect(() => validateProfessionalCandidate(contracts(), ['project-feasibility'], {
      taskType: 'report',
      deliveryMode: 'artifact',
      candidateText: `数据来源：SHA-256 ${'a'.repeat(64)}`,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '客户资料' }],
    })).toThrow(/对外交付不得展示内部校验值/u)
  })

  it('rejects numbers that are absent from evidence and calculations', () => {
    expect(() => validateProfessionalCandidate(contracts(), ['project-feasibility'], {
      taskType: 'feasibility',
      deliveryMode: 'chat',
      candidateText: '总体结论：企业当前得分为 87.5 分，但现有材料没有提供任何可复算输入或来源，因此不能形成正式判断。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'verified', source: '企业材料' }],
    })).toThrow(/87\.5.*未绑定证据/u)
  })

  it('binds thousands-separated values as one number instead of matching fragments', () => {
    expect(validateProfessionalCandidate(contracts(), [], {
      taskType: 'analysis',
      deliveryMode: 'chat',
      candidateText: '总体结论：本期收入为 7,200.00 万元，结论仅覆盖已绑定数据。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '客户资料', values: ['7200'] }],
    }).ok).toBe(true)

    expect(() => validateProfessionalCandidate(contracts(), [], {
      taskType: 'analysis',
      deliveryMode: 'chat',
      candidateText: '总体结论：本期收入为 9,999.00 万元，而来源只分别出现 9 与 999。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '客户资料', values: ['9', '999'] }],
    })).toThrow(/9,999\.00.*未绑定证据/u)
  })

  it('binds a decimal followed by a compact Latin measurement unit as the complete value', () => {
    const result = validateProfessionalCandidate(contracts(), [], {
      taskType: 'analysis',
      deliveryMode: 'chat',
      candidateText: '总体结论：最小可识别缺陷尺寸为 0.20mm，触发同步延迟不高于 2ms。',
      evidence: [{
        id: 'E1',
        kind: 'customer-file',
        status: 'user-provided',
        source: '客户资料',
        values: ['最小可识别缺陷尺寸 0.20 毫米；触发同步延迟不高于 2 毫秒。'],
      }],
    })
    expect(result.ok).toBe(true)

    expect(() => validateProfessionalCandidate(contracts(), [], {
      taskType: 'analysis',
      deliveryMode: 'chat',
      candidateText: '总体结论：最小可识别缺陷尺寸为 0.25mm。',
      evidence: [{
        id: 'E1', kind: 'customer-file', status: 'user-provided', source: '客户资料', values: ['0.20 毫米'],
      }],
    })).toThrow(/0\.25.*未绑定证据/u)
  })

  it('does not mistake citation URLs or Markdown row numbers for business facts', () => {
    const result = validateProfessionalCandidate(contracts(), ['policy-retrieval'], {
      taskType: 'policy',
      deliveryMode: 'chat',
      candidateText: [
        '总体结论：适用通知已由政府官网来源核验。',
        '## 0. 技能锁定',
        '1. 主管部门原文：https://example.gov.cn/notice/detail.html?id=60753',
        '2. 证据边界：仅覆盖本轮已读取内容。',
        '| 3 | 政府官网转载 |',
      ].join('\n'),
      evidence: [{
        id: 'P1', kind: 'official-policy', status: 'verified', source: '主管部门通知',
        sourceUrl: 'https://example.gov.cn/notice/detail.html?id=60753',
      }],
    })
    expect(result.ok).toBe(true)
  })

  it('does not mistake receipt UTC timestamps for business facts', () => {
    const result = validateProfessionalCandidate(contracts(), ['policy-retrieval'], {
      taskType: 'policy',
      deliveryMode: 'chat',
      candidateText: [
        '总体结论：适用通知已由政府官网来源核验。',
        '完整访问时间为 2026-08-16T00:12:06Z，回执摘要显示 00:12:06Z。',
        '人工复核时间为 2026-08-16 00:58:10 UTC，日志摘要显示 00:58:10 UTC。',
      ].join('\n'),
      evidence: [{
        id: 'P1', kind: 'official-policy', status: 'verified', source: '主管部门通知',
        sourceUrl: 'https://example.gov.cn/current',
      }],
    })
    expect(result.ok).toBe(true)
  })

  it('does not mistake report structure, issue metadata, or planned time coordinates for business facts', () => {
    const candidateText = [
      '报告日期 2026年8月16日',
      '第一部分｜尽调准入',
      '1.1 主体事实核验',
      '总体结论：企业基础事实仍以客户资料为准，缺失事项保持待补。',
      '2.4 企业风控与90天整改',
      '完成时间：第1至2周。',
      '风险清理完成后按3.3项目矩阵与3.4五年规划执行。',
      '3.4 未来五年发展与申报规划',
      '2027 新增发明专利申请。',
      '2028至2030 按年度复核申报条件。',
      '正式交付文件：示例企业_深度顾问版_20260816.pdf。',
    ].join('\n')
    const result = validateProfessionalCandidate(contracts(), ['enterprise-panorama-analysis'], {
      taskType: 'report',
      deliveryMode: 'chat',
      candidateText,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '客户资料' }],
    })
    expect(result.ok).toBe(true)
  })

  it('ignores extracted page labels, remediation rows, and the turnover-day formula constant', () => {
    const result = validateProfessionalCandidate(contracts(), [], {
      taskType: 'report',
      deliveryMode: 'chat',
      candidateText: [
        '14 90天整改路线',
        '90天内完成证据封存、复算与机制固化。',
        '30天 补充资料。',
        '60天 建立台账。',
        '90天 完成复核。',
        '15 计算过程与来源',
        '存货周转天数：平均存货÷营业成本×365，当前资料待核验。',
      ].join('\n'),
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户资料待补' }],
    })
    expect(result.ok).toBe(true)
  })

  it('ignores split PDF page labels and wrapped remediation phase ranges', () => {
    const result = validateProfessionalCandidate(contracts(), [], {
      taskType: 'report',
      deliveryMode: 'chat',
      candidateText: [
        '11',
        '所得税与研发',
        '当前资料待核验。',
        '14',
        '90天整改路线',
        '31—60   复算差异并形成清单。',
        '天       财税专项组。',
        '61—90   建立月度看板。',
        '天       管理层。',
        '60',
        '天',
        '复算差异。',
        '90',
        '天',
        '形成整改闭环。',
        '16',
        '最终判断',
        '缺失事项仍待补。',
      ].join('\n'),
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户资料待补' }],
    })
    expect(result.ok).toBe(true)
  })

  it('ignores a remediation phase range when PDF extraction moves its time unit to the next line', () => {
    const candidateText = [
      '14',
      '90天整改路线',
      '阶段',
      '0-30天',
      '补齐待核验资料。',
      '31-60',
      '天',
      '复算差异并形成清单。',
      '61-90',
      '天',
      '建立复核机制。',
    ].join('\n')
    expect(validateProfessionalCandidate(contracts(), [], {
      taskType: 'report',
      deliveryMode: 'chat',
      candidateText,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户资料待补' }],
    }).ok).toBe(true)

    expect(() => validateProfessionalCandidate(contracts(), [], {
      taskType: 'report',
      deliveryMode: 'chat',
      candidateText: `${candidateText}\n整改预算9999万元。`,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户资料待补' }],
    })).toThrow(/9999.*未绑定证据/u)
  })

  it('still requires evidence for a monetary target on a remediation page', () => {
    expect(() => validateProfessionalCandidate(contracts(), [], {
      taskType: 'report',
      deliveryMode: 'chat',
      candidateText: '14 90天整改路线\n60天内完成90万元资金补充，其他事项待核验。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户资料待补' }],
    })).toThrow(/90.*未绑定证据/u)
  })

  it('still requires evidence when a monetary unit follows a bare plan-page number', () => {
    expect(() => validateProfessionalCandidate(contracts(), [], {
      taskType: 'report',
      deliveryMode: 'chat',
      candidateText: '14\n90天整改路线\n90\n万元\n资金补充目标，其他事项待核验。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户资料待补' }],
    })).toThrow(/90.*未绑定证据/u)
  })

  it('accepts PDF glyph spacing and line wraps without weakening signed section order', () => {
    // 手写画像夹具也必须显式声明关键项与建议项，避免合同扩展后测试绕过新语义。
    const profile: ProfessionalDeliveryProfile = {
      skillId: 'enterprise-panorama-analysis',
      requiredSections: ['土地、厂房、设备融资与投资', '企业风控与90天整改', '未来五年发展与申报规划'],
      requiredTables: [],
      artifactFormats: new Set(['pdf']),
      requiresSourceTrace: false,
      requiresEvidenceLedger: true,
      requiresPeerComparison: false,
      requiresPolicySelectionTrace: false,
      requiresFourQuestionReview: false,
      criticalRequirements: new Set(['required-sections', 'evidence-ledger']),
      advisoryRequirements: new Set(),
    }
    const profiles = new Map([['enterprise-panorama-professional', profile]])
    const candidateText = [
      '2.3 土地、 厂房、 设备融资',
      '与投资',
      '2.4 企业风控与90 天整改',
      '3. 4 未来五年发展与申报规划',
      '2027 年新增发明专利申请。',
      '4. 能力升级（2027 至 2030）：逐年复核申报条件。',
      '全部缺失事项保持待补。',
    ].join('\n')
    const result = validateProfessionalCandidate(contracts(new Map(), profiles), ['enterprise-panorama-analysis'], {
      taskType: 'report',
      deliveryMode: 'artifact',
      artifactPath: '/tmp/report.pdf',
      artifactFormat: 'pdf',
      deliveryProfileId: 'enterprise-panorama-professional',
      candidateText,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '客户资料' }],
    })
    expect(result.ok).toBe(true)
  })

  it('accepts a required PDF table header split across extraction lines', () => {
    const profile: ProfessionalDeliveryProfile = {
      skillId: 'manufacturing-tax-risk-analysis',
      requiredSections: ['风险地图'],
      requiredTables: [{ id: '风险地图', requiredColumns: ['风险链', '等级'], minRows: 1 }],
      artifactFormats: new Set(['pdf']),
      requiresSourceTrace: false,
      requiresEvidenceLedger: true,
      requiresPeerComparison: false,
      requiresPolicySelectionTrace: false,
      requiresFourQuestionReview: false,
      criticalRequirements: new Set(['required-sections', 'required-tables', 'evidence-ledger']),
      advisoryRequirements: new Set(),
    }
    const result = validateProfessionalCandidate(
      contracts(new Map(), new Map([['manufacturing-tax-risk-report', profile]])),
      ['manufacturing-tax-risk-analysis'],
      {
        taskType: 'report',
        deliveryMode: 'artifact',
        artifactPath: '/tmp/report.pdf',
        artifactFormat: 'pdf',
        deliveryProfileId: 'manufacturing-tax-risk-report',
        candidateText: '风险地图\n风险链\n等\n级\n所有事实、解释、缺失证据与动作均已逐项列示，缺失事项仍待补。',
        evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户资料待补' }],
      },
    )
    expect(result.ok).toBe(true)
  })

  it('recognizes inline process numbering and an explicit checklist item limit as layout', () => {
    const candidateText = [
      '落地顺序建议：1. 确定形态 → 2. 核对资料 → 3. 核验当期政策。',
      '高影响待核验条件（<=5项）',
      '1. 工作经历未提供。',
      '2. 劳动关系未提供。',
      '流程顺序不代表资格已经满足。',
    ].join('\n')
    expect(validateProfessionalCandidate(contracts(), ['talent-projects'], {
      taskType: 'analysis', deliveryMode: 'chat', candidateText,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '用户问题' }],
    }).ok).toBe(true)
  })

  it('does not merge a spaced ordered-list marker into the following business year', () => {
    const result = validateProfessionalCandidate(contracts(), [], {
      taskType: 'analysis',
      deliveryMode: 'chat',
      candidateText: [
        '总体结论：当前材料仅形成待核验草稿。',
        '1. 2026年政策状态保持待核验。',
        '2 . 2025年数据来自客户资料。',
      ].join('\n'),
      evidence: [{
        id: 'E1', kind: 'customer-file', status: 'user-provided', source: '客户资料', values: ['2025', '2026'],
      }],
    })
    expect(result.ok).toBe(true)
  })

  it('ignores only a proven flat Office table ordinal column', () => {
    const candidateText = [
      '总体结论：当前材料仅形成待核验清单。',
      '序号', '待补项', '证据状态',
      '1', '主体资料', '待补',
      '2', '产品资料', '待补',
      '3', '质量资料', '待核验',
      '4', '市场资料', '待补',
    ].join('\n')
    expect(validateProfessionalCandidate(contracts(), [], {
      taskType: 'report', deliveryMode: 'chat', candidateText,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户资料待补' }],
    }).ok).toBe(true)

    expect(() => validateProfessionalCandidate(contracts(), [], {
      taskType: 'report', deliveryMode: 'chat',
      candidateText: `${candidateText}\n产品计划投入9999万元，仍待核验。`,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户资料待补' }],
    })).toThrow(/9999.*未绑定证据/u)
  })

  it('binds a number that the user directly supplied in the current request', () => {
    expect(validateProfessionalCandidate(contracts(), [], {
      taskType: 'report', deliveryMode: 'chat',
      candidateText: '总体结论：按用户指定的虚构2026年场景形成待核验文案，不写入现实政策结论。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户资料待补' }],
    }, [], 'analysis', '按虚构的2026年场景生成待补资料。').ok).toBe(true)
  })

  it('keeps a disclosed source-limited draft visibly pending instead of treating it as verified policy', () => {
    const input: ProfessionalCandidateInput = {
      taskType: 'quality-brand-draft',
      deliveryMode: 'chat',
      candidateText: '总体结论：当前官方政策不可用，本待补清单不设定政策门槛，缺口继续标为待核验。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户资料待补' }],
    }
    expect(() => validateProfessionalCandidate(
      contracts(), ['quality-brand-projects', 'policy-retrieval'], input,
      ['quality-brand-projects'], 'formal', '当前官方政策不可用，请生成待补资料草稿。',
    )).toThrow(/政策结论缺少/u)
    expect(() => validateProfessionalCandidate(
      contracts(), ['quality-brand-projects', 'policy-retrieval'], {
        ...input,
        candidateText: '总体结论：现行政策规定该企业可申报，其余资料仍待核验。',
      }, ['quality-brand-projects'], 'formal', '当前官方政策不可用，请生成待补资料草稿。',
    )).toThrow(/政策结论缺少/u)
  })

  it('still treats a real decimal at the start of a line as a fact', () => {
    expect(() => validateProfessionalCandidate(contracts(), [], {
      taskType: 'analysis',
      deliveryMode: 'chat',
      candidateText: [
        '总体结论：现有材料不足，以下金额只用于验证事实绑定，其他事项均保持待核验。',
        '2.5万元尚无任何来源支持。',
      ].join('\n'),
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户资料待补' }],
    })).toThrow(/2\.5.*未绑定证据/u)
  })

  it('ignores Markdown clause numbers but still binds quantities in the same heading', () => {
    const candidateText = [
      '总体结论：标准草案的缺失事项保持待核验。',
      '## 3 术语和定义',
      '### 3.1 高速检测',
      '### 5.1 检测速度 3 m/s',
    ].join('\n')
    expect(validateProfessionalCandidate(contracts(), [], {
      taskType: 'standard', deliveryMode: 'chat', candidateText,
      evidence: [{
        id: 'E1', kind: 'customer-file', status: 'user-provided', source: '客户材料', values: ['3 m/s'],
      }],
    }).ok).toBe(true)
    expect(() => validateProfessionalCandidate(contracts(), [], {
      taskType: 'standard', deliveryMode: 'chat', candidateText,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户材料待补' }],
    })).toThrow(/数字 3.*未绑定证据/u)
  })

  it('ignores plain-text standard clause references without exempting business decimals', () => {
    const candidateText = [
      '企业标准草案的缺失事项保持待核验。',
      '1 范围',
      '5 技术要求',
      '5.1 外观',
      '5.5 处理能力',
      '5.7 连续运行',
      '5.8 外观检查',
      '5.9 软件记录',
      '6 试验方法',
      '6.1 试验条件',
      '6.2 外观检查（验证5.1）',
      '结果按5.1的要求判定，并按6.4至6.6的指标复核；计算方法见式(1)，汇总见表2。',
      '使用 6.2 规定的性能试验样品，在 6.1 规定的条件下进行检测。',
      '出厂检验项目为外观（5.8）、软件记录（5.9）、处理能力（5.5）和连续运行（5.7）。',
      '型式检验项目为本文件规定的全部技术要求，即 5.1～5.9。',
    ].join('\n')
    expect(validateProfessionalCandidate(contracts(), [], {
      taskType: 'standard', deliveryMode: 'chat', candidateText,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户材料待补' }],
    }).ok).toBe(true)

    const misclassifiedStandard = [
      '本文件按照GB/T 1.1-2020的规定起草。',
      '2 规范性引用文件',
      '3 术语和定义',
      candidateText,
      '7 检验规则',
    ].join('\n')
    expect(validateProfessionalCandidate(contracts(), [], {
      taskType: 'report', deliveryMode: 'chat', candidateText: misclassifiedStandard,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户材料待补' }],
    }).ok).toBe(true)

    expect(() => validateProfessionalCandidate(contracts(), [], {
      taskType: 'standard', deliveryMode: 'chat',
      candidateText: `${candidateText}\n未经来源支持的业务阈值为5.1%，预算为5.1万元，另一未定义小数为6.12，仍待核验。`,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户材料待补' }],
    })).toThrow(/数字 5\.1%.*未绑定证据/u)

    expect(() => validateProfessionalCandidate(contracts(), [], {
      taskType: 'standard', deliveryMode: 'chat',
      candidateText: `${candidateText}\n预算为5.1万元，仍待核验。`,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户材料待补' }],
    })).toThrow(/数字 5\.1.*未绑定证据/u)

    expect(() => validateProfessionalCandidate(contracts(), [], {
      taskType: 'standard', deliveryMode: 'chat',
      candidateText: `${candidateText}\n另一未定义小数为6.12，仍待核验。`,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户材料待补' }],
    })).toThrow(/数字 6\.12.*未绑定证据/u)

    expect(() => validateProfessionalCandidate(contracts(), [], {
      taskType: 'report', deliveryMode: 'chat',
      candidateText: 'GB/T 1.1-2020是本报告的参考。\n5.1 技术分析\n未绑定的评估值为（5.1）。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户材料待补' }],
    })).toThrow(/数字 5\.1.*未绑定证据/u)
  })

  it('ignores Chinese item ordinals while still binding business numbers on the same line', () => {
    const candidateText = '总体结论：第 1 项至第 6 项均已核对，硬门槛第5项结论为待核验；当前质量分为58分。'
    expect(validateProfessionalCandidate(contracts(), [], {
      taskType: 'analysis', deliveryMode: 'chat', candidateText,
      evidence: [{
        id: 'E1', kind: 'customer-file', status: 'user-provided', source: '客户材料', values: ['58'],
      }],
    }).ok).toBe(true)
    expect(() => validateProfessionalCandidate(contracts(), [], {
      taskType: 'analysis', deliveryMode: 'chat', candidateText,
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户材料待补' }],
    })).toThrow(/58.*未绑定证据/u)
  })

  it('binds each numeric field in a CSV evidence row without splitting quoted thousands', () => {
    expect(validateProfessionalCandidate(contracts(), [], {
      taskType: 'analysis',
      deliveryMode: 'chat',
      candidateText: '总体结论：2023年存货为140.00万元，格式化金额7,200.00万元来自同一行输入。',
      evidence: [{
        id: 'E1', kind: 'customer-file', status: 'user-provided', source: '客户CSV',
        values: ['2023,万元,600,800,180,700,350,140,200,"7,200.00",同一主体口径'],
      }],
    }).ok).toBe(true)
  })

  it('ignores report analysis-period calendar days but still binds business dates', () => {
    expect(validateProfessionalCandidate(contracts(), [], {
      taskType: 'report', deliveryMode: 'chat',
      candidateText: '分析期间 2023-01-01—2025-12-31。当前资料保持待核验。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户资料待补' }],
    }).ok).toBe(true)
    expect(() => validateProfessionalCandidate(contracts(), [], {
      taskType: 'report', deliveryMode: 'chat',
      candidateText: '合同履行期间为2023-01-01至2025-12-31，当前资料保持待核验。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'pending', source: '客户资料待补' }],
    })).toThrow(/数字.*未绑定证据/u)
  })

  it('still checks unsupported business quantities beside inline process numbers', () => {
    expect(() => validateProfessionalCandidate(contracts(), ['talent-projects'], {
      taskType: 'analysis', deliveryMode: 'chat',
      candidateText: '落地顺序建议：1. 注册企业 → 2. 领取9999万元补贴。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '用户问题' }],
    })).toThrow(/9999.*未绑定证据/u)
  })

  it('still binds business targets inside a proposed plan', () => {
    expect(() => validateProfessionalCandidate(contracts(), ['enterprise-panorama-analysis'], {
      taskType: 'report',
      deliveryMode: 'chat',
      candidateText: [
        '总体结论：缺失事项保持待补。',
        '3.4 未来五年发展与申报规划',
        '2027 建议研发预算达到9999万元。',
      ].join('\n'),
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '客户资料' }],
    })).toThrow(/9999.*未绑定证据/u)
  })

  it('binds Chinese date numbers even when digits touch Chinese year month and day units', () => {
    const result = validateProfessionalCandidate(contracts(), ['policy-retrieval'], {
      taskType: 'policy',
      deliveryMode: 'chat',
      candidateText: '总体结论：申报时间为2026年5月12日至5月22日，具体安排以主管部门通知为准。',
      evidence: [{
        id: 'P1', kind: 'official-policy', status: 'verified', source: '主管部门通知',
        sourceUrl: 'https://example.gov.cn/current', values: ['2026年5月12日至5月22日'],
      }],
    })
    expect(result.ok).toBe(true)
  })

  it('binds percentage notation by numeric value and ignores standards and personal identifiers', () => {
    const result = validateProfessionalCandidate(contracts(), ['project-application-assistant'], {
      taskType: 'customer-workbook',
      deliveryMode: 'chat',
      candidateText: '检测结果采用 GB/T 1033.1-2008，断裂伸长率为 190%；联系方式 13812345678 和证件号 330523199910134710 只用于目标表格。',
      evidence: [{
        id: 'E1', kind: 'customer-file', status: 'user-provided', source: '客户检测报告与人员表',
        values: ['1033.1', '190', '13812345678', '330523199910134710'],
      }],
    })
    expect(result.ok).toBe(true)
  })

  it('replays scoring arithmetic and rejects a mismatched result', () => {
    expect(() => validateProfessionalCandidate(contracts(), ['sme-score-preassessment'], {
      taskType: 'scoring',
      deliveryMode: 'chat',
      candidateText: '评分结论依据企业材料复算，当前结果为 70 分；证据不足的指标继续列为待核验，不承诺申报通过。',
      evidence: [{ id: 'S1', kind: 'customer-file', status: 'verified', source: '评分输入', values: ['30', '30', '70'] }],
      calculations: [{ id: 'score', operator: 'sum', inputs: [30, 30], result: 70, evidenceIds: ['S1'] }],
    })).toThrow(/无法复算/u)
  })

  it('explains original evidence IDs for calculations using earlier results', () => {
    const derived: ProfessionalCalculation = {
      id: 'c3', operator: 'subtract', inputs: [370, 350], result: 20, evidenceIds: ['c1', 'c2'],
    }
    const input: ProfessionalCandidateInput = {
      taskType: 'arithmetic', deliveryMode: 'chat',
      candidateText: '两类账面金额扣除各自跨期项后分别为 370 万元与 350 万元，差额 20 万元不代表未收汇。',
      evidence: [{ id: 'E1', kind: 'user-provided', status: 'user-provided', source: '用户输入', values: ['420', '50', '380', '30'] }],
      calculations: [
        { id: 'c1', operator: 'subtract', inputs: [420, 50], result: 370, evidenceIds: ['E1'] },
        { id: 'c2', operator: 'subtract', inputs: [380, 30], result: 350, evidenceIds: ['E1'] },
        derived,
      ],
    }
    expect(() => validateProfessionalCandidate(contracts(), [], input)).toThrow(/派生计算沿用原始来源证据 ID，不填其他计算 ID/u)
    derived.evidenceIds = ['E1']
    expect(validateProfessionalCandidate(contracts(), [], input).ok).toBe(true)
  })

  it('binds rounded percentages and equivalent floating-point renderings to replayed calculations', () => {
    const result = validateProfessionalCandidate(contracts(), ['sme-score-preassessment'], {
      taskType: 'scoring',
      deliveryMode: 'chat',
      candidateText: '主营占比为 81.03%（calc-01），研发强度为 0.07068965517241379（ev-03）；结论仍以已核验资料为准。',
      evidence: [{ id: 'S1', kind: 'customer-file', status: 'verified', source: '评分输入', values: ['2350', '2900', '205'] }],
      calculations: [
        { id: 'ratio', operator: 'divide', inputs: [2350, 2900], result: 2350 / 2900, evidenceIds: ['S1'] },
        { id: 'rd', operator: 'divide', inputs: [205, 2900], result: 0.0706896551724138, evidenceIds: ['S1'] },
      ],
    })
    expect(result.ok).toBe(true)
  })

  it('accepts a replayed ratio rounded to the declared calculation precision', () => {
    const result = validateProfessionalCandidate(contracts(), ['sme-score-preassessment'], {
      taskType: 'scoring',
      deliveryMode: 'chat',
      candidateText: '评分复算结论：研发投入为 205 万元，营业收入为 2900 万元，研发强度按同一口径复算为 7.07%。该比例仅用于本轮已核验材料的指标判断，证据不足的其他项目继续列为待核验，不承诺申报通过。',
      evidence: [{ id: 'S1', kind: 'customer-file', status: 'verified', source: '评分输入', values: ['205', '2900'] }],
      calculations: [
        { id: 'rd-ratio', operator: 'ratio', inputs: [205, 2900], result: 7.07, evidenceIds: ['S1'] },
      ],
    })
    expect(result.ok).toBe(true)
  })

  it('allows an enterprise profile to disclose a missing registration code without fabricating one', () => {
    const result = validateProfessionalCandidate(contracts(), ['enterprise-profile'], {
      taskType: 'profile',
      deliveryMode: 'chat',
      candidateText: '主体锚定：示例企业。统一社会信用代码：暂无法判断，营业执照未提供，列为待补资料。',
      evidence: [{ id: 'E1', kind: 'user-provided', status: 'user-provided', source: '客户文件' }],
    })
    expect(result.ok).toBe(true)
  })

  it('does not impose enterprise-profile anchoring or high-tech four sections on scoped analysis', () => {
    const profile = validateProfessionalCandidate(contracts(), ['enterprise-profile'], {
      taskType: 'terminology-review',
      deliveryMode: 'chat',
      candidateText: '这段文字中的企业画像只是功能名称，本轮只检查措辞是否准确，不形成企业主体结论。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '待检查文字' }],
    }, ['enterprise-profile'], 'analysis')
    expect(profile.ok).toBe(true)

    const highTech = validateProfessionalCandidate(contracts(), ['high-tech-enterprise-application-drafting'], {
      taskType: 'single-section-review',
      deliveryMode: 'chat',
      candidateText: '这一段只说明知识产权与主营产品的技术关联，其他申请书栏目本轮不展开。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '申请书单栏原文' }],
    }, ['high-tech-enterprise-application-drafting'], 'analysis')
    expect(highTech.ok).toBe(true)
  })

  it('does not impose another task contract when profile, scoring, and drafting skills only support the response', () => {
    const candidate = '这是一份客户端黑箱回归测试记录。正文仅说明企业画像、主体核验、高企四栏和评分功能已经纳入测试范围，不形成企业画像、申报书或评分结论。'
    const result = validateProfessionalCandidate(
      contracts(),
      [
        'enterprise-profile',
        'sme-score-preassessment',
        'high-tech-enterprise-application-drafting',
        'gongchuang-humanizer-zh',
      ],
      {
        taskType: 'report',
        deliveryMode: 'chat',
        sourceText: candidate,
        candidateText: candidate,
        evidence: [],
      },
      ['gongchuang-humanizer-zh'],
    )
    expect(result.ok).toBe(true)
  })

  it('binds a labelled registration code from any verified trusted receipt to the same code in the candidate', () => {
    const result = validateProfessionalCandidate(contracts(), ['enterprise-profile'], {
      taskType: 'profile',
      deliveryMode: 'chat',
      candidateText: '主体锚定：洞见测试企业。统一社会信用代码：91110000TEST000001。该主体已由企业数据回执核验。',
      evidence: [{
        id: 'E1', kind: 'enterprise-profile', status: 'verified', source: '天眼查与企查查企业基础信息',
        values: ['企业名称：洞见测试企业', '统一社会信用代码：91110000TEST000001'],
      }],
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a registration code that does not match the verified enterprise receipt', () => {
    expect(() => validateProfessionalCandidate(contracts(), ['enterprise-profile'], {
      taskType: 'profile',
      deliveryMode: 'chat',
      candidateText: '主体锚定：洞见测试企业。统一社会信用代码：91110000TEST000001。',
      evidence: [{
        id: 'E1', kind: 'enterprise-profile', status: 'verified', source: '企业基础信息',
        values: ['统一社会信用代码：91110000TEST000002'],
      }],
    })).toThrow(/统一社会信用代码主体锚定或缺失披露/u)
  })

  it('rejects an enterprise profile that neither verifies nor discloses the registration code', () => {
    expect(() => validateProfessionalCandidate(contracts(), ['enterprise-profile'], {
      taskType: 'profile',
      deliveryMode: 'chat',
      candidateText: '主体锚定：示例企业。现有资料足以形成完整画像。',
      evidence: [{ id: 'E1', kind: 'user-provided', status: 'user-provided', source: '客户文件' }],
    })).toThrow(/统一社会信用代码主体锚定或缺失披露/u)
  })

  it('explains ordered alternative marker groups without implying slash-concatenated text', () => {
    const rules = new Map([['enterprise-profile', {
      appliesWhenPromptContains: [],
      requiredMarkerGroups: [
        ['主体锚定', '统一社会信用代码'],
        ['数据时点', '核验日期'],
        ['暂无法判断', '结论'],
      ],
    }]])
    expect(() => validateProfessionalCandidate(contracts(rules), ['enterprise-profile'], {
      taskType: 'profile',
      deliveryMode: 'chat',
      candidateText: '结论：暂无法判断。主体锚定：示例企业。统一社会信用代码：未提供。',
      evidence: [{ id: 'E1', kind: 'user-provided', status: 'user-provided', source: '客户文件' }],
    })).toThrow(/第 2 组缺少或顺序错误；本组只需原样出现任意一个备选标记：数据时点、核验日期/u)
  })

  it('keeps numbers, enterprise names, policy titles, and patent identifiers during humanization', () => {
    const sourceText = '杭州示例有限公司依据《示例项目管理办法》申报，研发投入为 120 万元，关联专利为 CN1234567A。以上信息均来自客户材料。'
    expect(() => validateProfessionalCandidate(contracts(), ['gongchuang-humanizer-zh'], {
      taskType: 'humanizer',
      deliveryMode: 'chat',
      sourceText,
      candidateText: '企业依据项目管理要求开展申报，研发投入和专利基础已经形成，整体表达已调整得更加自然。',
      evidence: [],
    })).toThrow(/丢失锁定事实/u)
  })

  it('applies the source fact lock only when humanization owns the task contract', () => {
    expect(validateProfessionalCandidate(
      contracts(),
      ['enterprise-panorama-analysis', 'gongchuang-humanizer-zh', 'evidence-ledger'],
      {
        taskType: 'report',
        deliveryMode: 'chat',
        candidateText: '总体结论：本报告仅依据已绑定的客户资料形成，尚未核验事项继续明确列为待核验。',
        evidence: [{
          id: 'E1',
          kind: 'customer-file',
          status: 'user-provided',
          source: '客户资料',
        }],
      },
      ['enterprise-panorama-analysis'],
    ).ok).toBe(true)
  })

  it('enforces the fixed high-tech four-section length and evidence boundary', () => {
    const rules = new Map([['high-tech-enterprise-application-drafting', {
      appliesWhenPromptContains: [],
      requiredMarkerGroups: [
        ['知识产权对企业竞争力的作用'],
        ['科技成果转化情况'],
        ['研究开发与技术创新组织管理情况'],
        ['管理与科技人员情况'],
      ],
    }]])
    const body = '实'.repeat(400)
    const candidate = [
      `知识产权对企业竞争力的作用${body}`,
      `科技成果转化情况${body}`,
      `研究开发与技术创新组织管理情况${body}`,
      `管理与科技人员情况${body}`,
    ].join('\n')
    const result = validateProfessionalCandidate(contracts(rules), ['high-tech-enterprise-application-drafting'], {
      taskType: 'high-tech-application',
      deliveryMode: 'chat',
      candidateText: candidate,
      evidence: [
        { id: 'IP1', kind: 'intellectual-property', status: 'verified', source: '知识产权台账' },
        { id: 'C1', kind: 'customer-file', status: 'verified', source: '研发与成果材料' },
        { id: 'P1', kind: 'personnel', status: 'verified', source: '人员材料' },
      ],
    })
    expect(result.checks).toContain('high-tech-four-section-contract')
  })

  it('keeps high-tech section-specific facts inside their signed evidence boundaries', () => {
    const rules = new Map([['high-tech-enterprise-application-drafting', {
      appliesWhenPromptContains: [],
      requiredMarkerGroups: [
        ['知识产权对企业竞争力的作用'],
        ['科技成果转化情况'],
        ['研究开发与技术创新组织管理情况'],
        ['管理与科技人员情况'],
      ],
    }]])
    const build = (sections: readonly string[]): string => [
      `知识产权对企业竞争力的作用${sections[0]}`,
      `科技成果转化情况${sections[1]}`,
      `研究开发与技术创新组织管理情况${sections[2]}`,
      `管理与科技人员情况${sections[3]}`,
    ].join('\n')
    const evidence = [
      { id: 'IP1', kind: 'intellectual-property', status: 'verified' as const, source: '知识产权台账' },
      { id: 'C1', kind: 'customer-file', status: 'verified' as const, source: '研发与成果材料', values: ['12'] },
      { id: 'P1', kind: 'personnel', status: 'verified' as const, source: '人员材料' },
    ]
    expect(() => validateProfessionalCandidate(contracts(rules), ['high-tech-enterprise-application-drafting'], {
      taskType: 'high-tech-application', deliveryMode: 'chat',
      candidateText: build([
        '实'.repeat(400),
        `本栏不得写入客户数量。${'实'.repeat(390)}`,
        '实'.repeat(400),
        '实'.repeat(400),
      ]),
      evidence,
    })).toThrow(/不得混入收入增长率或客户数量/u)

    expect(() => validateProfessionalCandidate(contracts(rules), ['high-tech-enterprise-application-drafting'], {
      taskType: 'high-tech-application', deliveryMode: 'chat',
      candidateText: build([
        '实'.repeat(400),
        '实'.repeat(400),
        `企业已执行《研发项目管理制度》并形成考核记录。${'实'.repeat(370)}`,
        '实'.repeat(400),
      ]),
      evidence,
    })).toThrow(/制度名称未逐字绑定客户详细制度文件/u)

    expect(() => validateProfessionalCandidate(contracts(rules), ['high-tech-enterprise-application-drafting'], {
      taskType: 'high-tech-application', deliveryMode: 'chat',
      candidateText: build([
        '实'.repeat(400),
        '实'.repeat(400),
        '实'.repeat(400),
        `现有管理与科技人员共 12 人。${'实'.repeat(385)}`,
      ]),
      evidence,
    })).toThrow(/人员栏.*只能使用人员材料：12/u)
  })

  it('enforces the signed formal-delivery profile instead of chat-only marker groups', () => {
    const profile: ProfessionalDeliveryProfile = {
      skillId: 'project-feasibility',
      requiredSections: ['项目版本与窗口', '总体结论', '逐项补强计划'],
      requiredTables: [{ id: '补强任务表', requiredColumns: ['补强动作', '完成标准'], minRows: 1 }],
      artifactFormats: new Set(['docx', 'pdf']),
      requiresSourceTrace: true,
      requiresEvidenceLedger: true,
      requiresPeerComparison: false,
      requiresPolicySelectionTrace: true,
      requiresFourQuestionReview: false,
      criticalRequirements: new Set([
        'required-sections', 'required-tables', 'source-trace', 'evidence-ledger', 'policy-selection-trace',
      ]),
      advisoryRequirements: new Set(),
    }
    const profiles = new Map([['project-feasibility-analysis-report', profile]])
    const professional = contracts(new Map(), profiles)
    expect(() => validateProfessionalCandidate(professional, ['project-feasibility'], {
      taskType: 'feasibility-report',
      deliveryMode: 'chat',
      deliveryProfileId: 'project-feasibility-analysis-report',
      candidateText: '项目版本与窗口\n总体结论\n逐项补强计划\n补强任务表\n补强动作\n完成标准\n政策结论来自签名技能参考文件。',
      evidence: [{
        id: 'P1', kind: 'official-policy', status: 'user-provided', source: '签名技能政策基线',
        sourceUrl: 'https://example.gov.cn/current',
      }],
    })).toThrow(/status=verified.*签名技能参考文件不属于客户文件/u)

    expect(() => validateProfessionalCandidate(professional, ['project-feasibility'], {
      taskType: 'feasibility-report',
      deliveryMode: 'chat',
      deliveryProfileId: 'project-feasibility-analysis-report',
      candidateText: '项目版本与窗口\n总体结论\n逐项补强计划\n补强任务表\n补强动作\n此处故意遗漏一项必要表头。',
      evidence: [{
        id: 'P1', kind: 'official-policy', status: 'verified', source: '主管部门当期通知',
        sourceUrl: 'https://example.gov.cn/current',
      }],
    })).toThrow(/完成标准/u)

    const preflight = validateProfessionalCandidate(professional, ['project-feasibility'], {
      taskType: 'feasibility-report',
      deliveryMode: 'chat',
      deliveryProfileId: 'project-feasibility-analysis-report',
      candidateText: '项目版本与窗口\n总体结论\n逐项补强计划\n补强任务表\n补强动作\n完成标准\n所有结论均绑定当前企业证据和主管部门正式原文。',
      evidence: [{
        id: 'P1', kind: 'official-policy', status: 'verified', source: '主管部门当期通知',
        sourceUrl: 'https://example.gov.cn/current',
      }],
    })
    expect(preflight.checks).toContain('delivery-profile-preflight')

    expect(() => validateProfessionalCandidate(professional, ['project-feasibility'], {
      taskType: 'feasibility-report',
      deliveryMode: 'artifact',
      artifactPath: '/tmp/report.docx',
      artifactFormat: 'docx',
      deliveryProfileId: 'project-feasibility-analysis-report',
      candidateText: '项目版本与窗口\n总体结论\n逐项补强计划\n补强任务表\n补强动作\n此处故意遗漏一项必要表头。',
      evidence: [{
        id: 'P1',
        kind: 'official-policy',
        status: 'verified',
        source: '主管部门当期通知',
        sourceUrl: 'https://example.gov.cn/current',
      }],
    })).toThrow(/完成标准/u)

    const result = validateProfessionalCandidate(professional, ['project-feasibility'], {
      taskType: 'feasibility-report',
      deliveryMode: 'artifact',
      artifactPath: '/tmp/report.docx',
      artifactFormat: 'docx',
      deliveryProfileId: 'project-feasibility-analysis-report',
      candidateText: '项目版本与窗口\n总体结论\n逐项补强计划\n补强任务表\n补强动作\n完成标准\n全部结论均绑定当前企业证据和主管部门正式原文。',
      evidence: [{
        id: 'P1',
        kind: 'official-policy',
        status: 'verified',
        source: '主管部门当期通知',
        sourceUrl: 'https://example.gov.cn/current',
      }],
    })
    expect(result.checks).toContain('delivery-profile-structure')
  })

  it('reports signed advisory requirements without blocking formal identity', () => {
    const profiles = new Map([['advisory-report', {
      skillId: 'project-feasibility',
      requiredSections: ['总体结论'],
      requiredTables: [],
      artifactFormats: new Set(['docx']),
      requiresSourceTrace: false,
      requiresEvidenceLedger: false,
      requiresPeerComparison: false,
      requiresPolicySelectionTrace: false,
      requiresFourQuestionReview: true,
      criticalRequirements: new Set(['required-sections', 'artifact-format'] as const),
      advisoryRequirements: new Set(['four-question-review'] as const),
    }]])
    const professional = {
      ...contracts(new Map(), profiles),
      fourQuestionMarkerGroups: [['最没有把握'], ['最大遗漏']],
    }
    const result = validateProfessionalCandidate(professional, ['project-feasibility'], {
      taskType: 'report',
      deliveryMode: 'artifact',
      artifactPath: '/tmp/report.docx',
      artifactFormat: 'docx',
      deliveryProfileId: 'advisory-report',
      candidateText: '总体结论：当前报告已经满足全部关键结构要求，可以作为正式文件交付。',
      evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '客户资料' }],
    })
    expect(result.ok).toBe(true)
    expect(result.advisoryIssues).toEqual(['交付画像 advisory-report 的四问复盘尚缺 2 组建议内容'])
  })
})
