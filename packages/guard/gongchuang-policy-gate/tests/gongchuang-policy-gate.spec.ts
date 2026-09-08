import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createAssistantMessage, createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  defineTool,
  type PostToolDecision,
  type PreToolDecision,
  type ToolExecution,
  type ToolExecutionResult,
  type ToolExecutionToken,
} from '@deepseek-ai/dsh-tools'
import * as PolicyGate from '@gongchuang/client-policy-gate'
import { ProfessionalTaskCheckpointStore } from '../src/task-checkpoint.ts'
import {
  GONGCHUANG_CLIENT_VERSION,
  GONGCHUANG_SKILL_BUNDLE_VERSION,
} from '../../../../product/gongchuang-client/src/product-version.ts'

function signedFixture(
  overrides: Partial<PolicyGate.Config> = {},
  mutateManifest?: (manifest: Record<string, unknown>) => void,
): PolicyGate.Config {
  const dir = mkdtempSync(join(tmpdir(), 'gongchuang-policy-gate-'))
  const template = resolve(import.meta.dirname, '../../../../product/gongchuang-client/policy-template.json')
  const source = readFileSync(template)
  const manifest = mutateManifest === undefined
    ? source
    : (() => {
      const value = JSON.parse(source.toString('utf8')) as Record<string, unknown>
      mutateManifest(value)
      return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
    })()
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const manifestPath = join(dir, 'policy.json')
  const signaturePath = join(dir, 'policy.sig')
  const publicKeyPath = join(dir, 'policy.pub.pem')
  const professionalContractsPath = join(dir, 'delivery-contracts.json')
  const skillCallGraphPath = join(dir, 'skill-call-graph.json')
  const documentRuntime = join(dir, '_runtime', 'gongchuang-branding')
  mkdirSync(join(documentRuntime, 'references'), { recursive: true })
  mkdirSync(join(documentRuntime, 'assets'), { recursive: true })
  writeFileSync(join(documentRuntime, 'references', 'brand_config.json'), JSON.stringify({
    public_identity: { document_header: '共创研究院' },
  }))
  writeFileSync(join(documentRuntime, 'assets', 'brand-test.png'), 'legacy-watermark-test-bytes')
  writeFileSync(manifestPath, manifest)
  writeFileSync(signaturePath, sign(null, manifest, privateKey).toString('base64'))
  const publicKeyPem = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }))
  writeFileSync(publicKeyPath, publicKeyPem)
  writeFileSync(professionalContractsPath, JSON.stringify({
    schema_version: 3,
    rule_version: GONGCHUANG_SKILL_BUNDLE_VERSION,
    business_domain_markers: ['政府项目', '申报', '评分', '体检', '出报告', '生成报告'],
    policy_task_markers: ['政策'],
    peer_task_markers: ['同行'],
    route_resolution_skills: [
      'enterprise-panorama-analysis',
      'financial-verification',
      'high-tech-enterprise-application-drafting',
      'peer-benchmarking',
      'project-feasibility',
      'quality-brand-projects',
    ],
    delivery_profiles: {
      'project-feasibility-analysis-report': {
        skill_id: 'project-feasibility',
        requires_source_trace: true,
        requires_evidence_ledger: true,
        requires_peer_comparison: false,
        requires_policy_selection_trace: true,
        required_sections: ['项目版本与窗口', '总体结论', '逐项补强计划'],
        required_tables: [{ id: '补强任务表', required_columns: ['补强动作', '完成标准'], min_rows: 1 }],
        required_artifacts: [{ role: 'report', formats: ['html', 'docx', 'pdf'] }],
      },
    },
    skills: {
      'financial-verification': {
        applies_when_prompt_contains: ['财务核验'],
        required_marker_groups: [['指标计算']],
      },
      'enterprise-panorama-analysis': {
        applies_when_prompt_contains: ['企业全景调研报告'],
        required_marker_groups: [['总体结论']],
      },
      'high-tech-enterprise-application-drafting': {
        applies_when_prompt_contains: ['高企申请书', '企业创新能力'],
        required_marker_groups: [
          ['知识产权对企业竞争力的作用'],
          ['科技成果转化情况'],
          ['研究开发与技术创新组织管理情况'],
          ['管理与科技人员情况'],
        ],
      },
      'gongchuang-humanizer-zh': {
        applies_when_prompt_contains: ['去AI味'],
        required_marker_groups: [],
      },
      'project-feasibility': {
        applies_when_prompt_contains: ['项目可行性', '前期评估'],
        required_marker_groups: [['总体结论']],
      },
      'high-tech-enterprise-preassessment': {
        applies_when_prompt_contains: ['高企预评估'],
        required_marker_groups: [['预评估专属结构']],
      },
      'peer-benchmarking': {
        applies_when_prompt_contains: ['同行对标'],
        required_marker_groups: [
          ['来源清单', '来源'],
          ['可比性评分', '可比性'],
          ['事实对比', '对比表'],
          ['政策口径差异', '口径差异'],
          ['不可比较', '数据缺口'],
        ],
      },
      'quality-brand-projects': {
        applies_when_prompt_contains: ['quality-brand-projects', '市场份额'],
        required_marker_groups: [['市场地位证据分析', '项目类型']],
      },
    },
  }))
  writeFileSync(skillCallGraphPath, JSON.stringify({
    schema_version: 1,
    relations: [
      { from: 'high-tech-enterprise-application-drafting', to: 'high-tech-enterprise-preassessment', type: 'requires' },
      { from: 'high-tech-enterprise-application-drafting', to: 'evidence-ledger', type: 'requires' },
      { from: 'high-tech-enterprise-application-drafting', to: 'consistency-check', type: 'quality_gate' },
      { from: 'high-tech-enterprise-preassessment', to: 'policy-retrieval', type: 'requires' },
      { from: 'high-tech-enterprise-preassessment', to: 'enterprise-profile', type: 'requires' },
      { from: 'quality-brand-projects', to: 'industry-chain-foundation-matcher', type: 'requires' },
      { from: 'quality-brand-projects', to: 'industry-positioning', type: 'requires' },
      { from: 'gongchuang-humanizer-zh', to: 'consistency-check', type: 'quality_gate' },
      { from: 'consistency-check', to: 'evidence-ledger', type: 'requires' },
    ],
  }))
  return {
    manifestPath,
    signaturePath,
    publicKeyPath,
    expectedPublicKeySha256: createHash('sha256').update(publicKeyPem).digest('hex'),
    expectedProductId: 'cn.dongjian.desktop',
    // 签名清单来自当前产品模板，预期身份必须来自同一版本源，不能在测试里复制发布版本号。
    expectedClientVersion: GONGCHUANG_CLIENT_VERSION,
    expectedSkillBundleVersion: GONGCHUANG_SKILL_BUNDLE_VERSION,
    activeSkillBundleVersion: GONGCHUANG_SKILL_BUNDLE_VERSION,
    professionalContractsPath,
    skillCallGraphPath,
    professionalCheckpointDir: join(dir, 'professional-tasks'),
    ...overrides,
  }
}

function fakeAgent(
  provider: string,
  steering: unknown[] = [],
  explicitSessionId?: string,
  cwd = process.cwd(),
): Agent {
  const id = SessionId(explicitSessionId ?? `policy-${randomUUID()}`)
  const session = Session.create(id, [], {
    version: 2,
    id,
    createdAt: 0,
    cwd,
    isSeeded: false,
  })
  return {
    options: { provider, model: 'test' },
    session,
    steer(message: unknown) { steering.push(message) },
  } as Agent
}

function execution(
  name: string,
  attributed = true,
  agent?: Agent,
  args: unknown = Object.freeze({}),
  callId = 'call-1',
): ToolExecution {
  return {
    token: Symbol('tool') as ToolExecutionToken,
    callId: ToolCallId(callId),
    rootCallId: ToolCallId(callId),
    name,
    arguments: args,
    ...(attributed ? { agent: agent ?? fakeAgent('deepseek-official') } : {}),
    signal: new AbortController().signal,
  }
}

async function captureEvidence(
  ctx: Context,
  agent: Agent,
  text: string,
  callId = 'source-1',
  name = 'web_fetch',
  args: unknown = {},
): Promise<string> {
  const exec = execution(name, true, agent, args, callId)
  await postTool(ctx, exec, {
    isError: false,
    value: { text },
    content: [{ type: 'text', text }],
  })
  return callId
}

async function preStep(
  ctx: Context,
  providerOrAgent: string | Agent,
  messages: Parameters<typeof createUserMessage>[0][] = [],
  turn = 1,
  step = 1,
): Promise<PreStepDecision> {
  const agent = typeof providerOrAgent === 'string' ? fakeAgent(providerOrAgent) : providerOrAgent
  return ctx.waterfall(
    ctx as never,
    'agent/pre-step',
    {
      agent,
      messages: messages.map(message => createUserMessage(message)),
      turn,
      step,
      signal: new AbortController().signal,
    },
    () => Promise.resolve({ kind: 'enter' as const, messages: messages.map(message => createUserMessage(message)) }),
  )
}

async function collectModelStream(
  ctx: Context,
  provider: string,
  downstream: { entered: boolean },
): Promise<void> {
  const options = {
    provider,
    model: 'test',
    messages: [],
  } satisfies GenerateOptions
  const stream = ctx.waterfall(
    ctx as never,
    'llm/stream',
    options,
    () => (async function* () { downstream.entered = true })(),
  )
  for await (const _chunk of stream) {
    // The fixture emits no chunks; iteration proves whether downstream opened.
  }
}

async function preTool(ctx: Context, exec: ToolExecution): Promise<PreToolDecision> {
  return ctx.waterfall(
    ctx as never,
    'tools/pre-execute',
    exec,
    () => Promise.resolve({ kind: 'allow' as const }),
  )
}

async function postTool(
  ctx: Context,
  exec: ToolExecution,
  result: ToolExecutionResult,
): Promise<PostToolDecision> {
  return ctx.waterfall(
    ctx as never,
    'tools/post-execute',
    exec,
    result,
    () => Promise.resolve({ kind: 'accept' as const }),
  )
}

async function settleProfessionalCandidate(
  ctx: Context,
  agent: Agent,
  candidate: string,
  turn = 1,
): Promise<void> {
  const exec = execution('gongchuang_professional_validate', true, agent)
  ctx.gongchuangPolicy.claim(exec, 'professional-kernel', candidate)
  await postTool(ctx, exec, {
    isError: false,
    value: { ok: true },
    content: [{ type: 'text', text: 'validated' }],
  })
  appendAssistant(agent, candidate, turn)
}

function appendAssistant(agent: Agent, text: string, turn = 1): void {
  agent.session.append('turn/start', { turn })
  agent.session.append('step/start', { turn, step: 1 })
  agent.session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'deepseek-official', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
  agent.session.append('step/end', { turn, step: 1 })
}

async function policyContext(renderer?: PolicyGate.GongchuangArtifactRenderer): Promise<Context> {
  const ctx = new Context()
  if (renderer !== undefined) ctx.provide('gongchuangArtifactRenderer', renderer)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PolicyGate, signedFixture())
  return ctx
}

function presentRenderer(): PolicyGate.GongchuangArtifactRenderer {
  const unavailable = (): Promise<never> => Promise.reject(new Error('renderer method was not expected'))
  return {
    inspectPdf: unavailable,
    exportPdf: unavailable,
    renderAndReview: unavailable,
  }
}

describe('signed policy envelope', () => {
  it('accepts the exact signed bytes and pins both independent version lines', () => {
    const policy = PolicyGate.loadVerifiedPolicy(signedFixture())
    expect(policy.manifest.product).toEqual({
      id: 'cn.dongjian.desktop',
      clientVersion: GONGCHUANG_CLIENT_VERSION,
      skillBundleVersion: GONGCHUANG_SKILL_BUNDLE_VERSION,
    })
    expect(policy.manifest.executionBudgets.search).toEqual({
      triggerAny: ['请对以下问题执行联网检索。'],
      defaultTier: 'standard',
      tiers: [
        {
          id: 'standard', label: '普通问答档', triggerAny: [],
          maxSteps: 8, maxSearchCalls: 2, maxFetchCalls: 4,
        },
        {
          id: 'professional', label: '政策与申报专业档',
          triggerAny: ['政策', '项目匹配', '申报', '政策原文', '申报通知', '联网检索'],
          maxSteps: 20, maxSearchCalls: 6, maxFetchCalls: 8,
        },
        {
          id: 'high-assurance', label: '高风险业务保障档',
          triggerAny: ['评分', '体检', '报告', '数字身份证', '找同行', '同行', '可行性', '尽调'],
          maxSteps: 24, maxSearchCalls: 8, maxFetchCalls: 12,
        },
      ],
    })
    expect(policy.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(() => { policy.manifest.tools.allow.push('escape') }).toThrow()
    expect(() => { policy.manifest.executionBudgets.search.triggerAny.push('escape') }).toThrow()
    expect(() => { policy.manifest.executionBudgets.search.tiers[0]?.triggerAny.push('escape') }).toThrow()
    expect(() => { policy.manifest.delivery.rules[0]?.receipts.push({ id: 'escape', label: 'escape', producerTools: [] }) }).toThrow()
    expect(() => { policy.manifest.delivery.professionalReceipt.producerTools.push('escape') }).toThrow()
  })

  it('fails closed after any manifest-byte tampering', () => {
    const config = signedFixture()
    writeFileSync(config.manifestPath, `${readFileSync(config.manifestPath, 'utf8')}\n`)
    expect(() => PolicyGate.loadVerifiedPolicy(config)).toThrow(/signature is invalid/)
  })

  it('fails closed when the host expects a different client or skill version', () => {
    expect(() => PolicyGate.loadVerifiedPolicy(signedFixture({ expectedClientVersion: '1.6.6' })))
      .toThrow(/client version mismatch/)
    expect(() => PolicyGate.loadVerifiedPolicy(signedFixture({ expectedSkillBundleVersion: '999.0.0' })))
      .toThrow(/skill bundle version mismatch/)
  })

  it('rejects a valid envelope when its public key is not host-pinned', () => {
    expect(() => PolicyGate.loadVerifiedPolicy(signedFixture({ expectedPublicKeySha256: '0'.repeat(64) })))
      .toThrow(/public key is not pinned/u)
  })

  it('requires the cross-platform skill runners and keeps unscoped execution closed', () => {
    expect(() => PolicyGate.loadVerifiedPolicy(signedFixture({}, (manifest) => {
      const tools = manifest.tools as { allow: string[]; ask: string[]; deny: string[] }
      tools.allow = tools.allow.filter(pattern => pattern !== 'bash')
      tools.ask.push('bash')
    }))).toThrow(/required skill execution tool bash is not admitted/u)

    expect(() => PolicyGate.loadVerifiedPolicy(signedFixture({}, (manifest) => {
      const tools = manifest.tools as { allow: string[]; ask: string[]; deny: string[] }
      tools.deny = tools.deny.filter(pattern => pattern !== 'exec_command')
      tools.allow.push('exec_command')
    }))).toThrow(/raw execution tool exec_command is not fail-closed/u)

    expect(() => PolicyGate.loadVerifiedPolicy(signedFixture({}, (manifest) => {
      const delivery = manifest.delivery as { rules: Array<{ id: string; receipts: Array<{ id: string }> }> }
      const formal = delivery.rules.find(rule => rule.id === 'formal-artifact')
      if (formal === undefined) throw new Error('test fixture missing formal rule')
      formal.receipts = formal.receipts.filter(receipt => receipt.id !== 'visual-inspection')
    }))).toThrow(/formal artifact receipt set is incomplete/u)
  })

  it('loads professional routing only from a matching skill-bundle contract version', () => {
    const config = signedFixture()
    const contracts = PolicyGate.loadProfessionalContracts(config)
    expect(contracts.ruleVersion).toBe(GONGCHUANG_SKILL_BUNDLE_VERSION)
    expect(contracts.skills.has('high-tech-enterprise-application-drafting')).toBe(true)
    writeFileSync(config.professionalContractsPath, JSON.stringify({
      rule_version: '1.6.5', business_domain_markers: [], policy_task_markers: [], peer_task_markers: [], skills: {},
    }))
    expect(() => PolicyGate.loadProfessionalContracts(config)).toThrow(/version mismatch/)
  })

  it('binds upgraded professional contracts to the Host-verified active suite without changing the signed product baseline', () => {
    const activeSkillBundleVersion = '1.6.16'
    const config = signedFixture({ activeSkillBundleVersion })
    writeFileSync(config.professionalContractsPath, JSON.stringify({
      schema_version: 3,
      rule_version: activeSkillBundleVersion,
      business_domain_markers: [],
      policy_task_markers: [],
      peer_task_markers: [],
      route_resolution_skills: [],
      delivery_profiles: {},
      skills: {},
    }))
    expect(PolicyGate.loadVerifiedPolicy(config).manifest.product.skillBundleVersion)
      .toBe(GONGCHUANG_SKILL_BUNDLE_VERSION)
    expect(PolicyGate.loadProfessionalContracts(config).ruleVersion).toBe(activeSkillBundleVersion)
  })
})

describe('native Cordis enforcement', () => {
  it('fails closed when the isolated acceptance host injects a live pre-step policy outage', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PolicyGate, signedFixture({ acceptanceFaultMode: 'pre-step' }))
    await expect(preStep(ctx, 'deepseek-official')).rejects.toThrow(/运行中策略服务不可用，已保持关闭/u)

    const downstream = { entered: false }
    await expect(collectModelStream(ctx, 'deepseek-official', downstream))
      .rejects.toThrow(/运行中策略服务不可用，已保持关闭/u)
    expect(downstream.entered).toBe(false)
  })

  it('enforces the signed provider allowlist at the global adapter boundary', async () => {
    const ctx = await policyContext()
    const allowed = { entered: false }
    await collectModelStream(ctx, 'deepseek-official', allowed)
    expect(allowed.entered).toBe(true)

    const denied = { entered: false }
    await expect(collectModelStream(ctx, 'unconfigured-provider', denied))
      .rejects.toThrow(/不在签名策略允许范围内/u)
    expect(denied.entered).toBe(false)
  })

  it('keeps unknown tools denied after the extensible pre-execute waterfall', async () => {
    const ctx = await policyContext()
    let bodyCalls = 0
    ctx.tools.register(defineTool({
      name: 'third_party_escape',
      description: 'fixture tool that must stay outside the signed policy',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => {
        bodyCalls += 1
        return Promise.resolve('escaped')
      },
    }))
    ctx.on('tools/pre-execute', async (_exec, next) => next(), { global: true })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('monotonic-denial'),
      name: 'third_party_escape',
      arguments: {},
      agent: fakeAgent('deepseek-official'),
    })
    expect(bodyCalls).toBe(0)
    expect(JSON.stringify(result)).toContain('签名策略')
  })

  it('gates the first pre-step for every configured provider family', async () => {
    const ctx = await policyContext()
    await expect(preStep(ctx, 'deepseek-official')).resolves.toEqual({ kind: 'enter', messages: [] })
    await expect(preStep(ctx, 'opencode-go')).resolves.toEqual({ kind: 'enter', messages: [] })
    await expect(preStep(ctx, 'openrouter')).resolves.toEqual({ kind: 'enter', messages: [] })
    await expect(preStep(ctx, 'fireworks')).resolves.toEqual({ kind: 'enter', messages: [] })
    await expect(preStep(ctx, 'custom-api')).resolves.toEqual({ kind: 'enter', messages: [] })
    await expect(preStep(ctx, 'siliconflow')).resolves.toEqual({ kind: 'reject' })
    await expect(preStep(ctx, 'orgarid')).resolves.toEqual({ kind: 'reject' })
    await expect(preStep(ctx, 'unconfigured-provider')).resolves.toEqual({ kind: 'reject' })
  })

  it('routes business-qualified scoring, checkup, and report wording into the professional chain', async () => {
    const ctx = await policyContext()
    for (const prompt of ['给这家企业评分', '做一次企业体检', '根据企业资料出报告']) {
      const decision = await preStep(ctx, fakeAgent('deepseek-official'), [{
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }])
      expect(JSON.stringify(decision)).toContain('project-task-router')
      expect(JSON.stringify(decision)).toContain('不得回退为通用模型自由发挥')
      expect(JSON.stringify(decision)).toContain('不同业务报告模式仍按主技能规则选择')
      expect(JSON.stringify(decision)).toContain('run_code 不是 Node.js 模块')
      expect(JSON.stringify(decision)).toContain('evidence-ledger.create-docx')
      expect(JSON.stringify(decision)).toContain('禁止探查运行环境')
      expect(JSON.stringify(decision)).toContain('生成文件不添加客户端品牌页眉、标志或水印')
      expect(JSON.stringify(decision)).toContain('artifact 模式对真实文件校验')
      expect(JSON.stringify(decision)).toContain('签名技能参考文件不是客户文件')
      expect(JSON.stringify(decision)).toContain('kind=official-policy、status=verified')
      expect(JSON.stringify(decision)).toContain('确认全部成功后再读取资料、起草或校验')
      expect(JSON.stringify(decision)).toContain('不要调用 Bash、wc 或脚本预先统计正文')
    }
  })

  it('treats an exact signed skill id as the route instead of inserting the generic router', async () => {
    const ctx = await policyContext()
    const decision = await preStep(ctx, fakeAgent('deepseek-official'), [{
      content: [{
        type: 'text',
        text: '使用 sme-development-projects 对给定合成材料做完整检查并生成 DOCX。',
      }],
      source: { kind: 'user' },
    }])
    const notice = JSON.stringify(decision)
    expect(notice).toContain('sme-development-projects')
    expect(notice).not.toContain('本任务必须激活并遵循：project-task-router')
  })

  it('does not turn an engineering checkup into an enterprise professional workflow', async () => {
    const ctx = await policyContext()
    const decision = await preStep(ctx, fakeAgent('deepseek-official'), [{
      content: [{ type: 'text', text: '给客户端做一次全面体检，列出工程问题和修复顺序。' }],
      source: { kind: 'user' },
    }])
    expect(JSON.stringify(decision)).not.toContain('project-task-router')
    expect(JSON.stringify(decision)).not.toContain('洞见专业执行链已锁定')
  })

  it('routes only the latest user request instead of re-locking from historical professional prompts', async () => {
    const ctx = await policyContext()
    const decision = await preStep(ctx, fakeAgent('deepseek-official'), [
      {
        content: [{ type: 'text', text: '请评估这家企业的高企申报可行性。' }],
        source: { kind: 'user' },
      },
      {
        content: [{ type: 'text', text: '换个话题，简单解释一下为什么天空是蓝色的。' }],
        source: { kind: 'user' },
      },
    ], 2, 1)
    const notice = JSON.stringify(decision)
    expect(notice).not.toContain('project-task-router')
    expect(notice).not.toContain('洞见专业执行链已锁定')
    expect(notice).not.toContain('gongchuang_professional_validate')
  })

  it('allows a general-purpose writing skill without promoting the turn into a professional workflow', async () => {
    const ctx = await policyContext(presentRenderer())
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    const decision = await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '把这段日常自我介绍改得像真人一些，语气自然。' }],
      source: { kind: 'user' },
    }])
    expect(JSON.stringify(decision)).not.toContain('洞见专业执行链已锁定')

    await postTool(ctx, execution('skill', true, agent, { name: 'gongchuang-humanizer-zh' }), {
      isError: false,
      value: { name: 'gongchuang-humanizer-zh' },
      content: [{ type: 'text', text: 'gongchuang-humanizer-zh' }],
    })
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(steering).toEqual([])
  })

  it.each([
    { comment: '为什么报错？', body: '解释注释 1', locked: false },
    { comment: '请评估企业高企申报可行性。', body: '', locked: true },
    { comment: '', body: '请评估企业高企申报可行性。', locked: true },
    {
      comment: 'GC-QA-ANNOTATION-PAIR：请保留政策未核验边界。',
      body: '此次只验收附件与注释传输，不继续之前的农业分析，不调用专业报告校验。请读取本轮附带的合成report.md，仅回复附件中的收入数字，以及我本轮注释选择的原文和注释评论。不要生成新文件，不联网。',
      locked: false,
    },
    { comment: '', body: '只回复政策原文中的字段数字，不继续企业分析，不调用专业报告校验。', locked: false },
    { comment: '', body: '抄录政策原文并判断企业能否申报高企。', locked: true },
    { comment: '请评估企业申报可行性', body: '仅回复原文。', locked: true },
  ])('routes annotation comments and body, not quoted history: %j', async ({ comment, body, locked }) => {
    const ctx = await policyContext()
    const text = '[gongchuang-annotations:v1]' + JSON.stringify([{
      index: 1, text: '生成企业高企申报可行性分析报告，请选择标准销售版。', comment,
      source: { nodeKey: 'assistant-step:2', kind: 'assistant' },
    }]) + `\n\n${body}`
    const decision = await preStep(ctx, fakeAgent('deepseek-official'), [{
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }])
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const notices = JSON.stringify(decision.messages.filter(message => message.source.kind === 'plugin'))
    expect(notices.includes('洞见专业执行链已锁定')).toBe(locked)
    expect(decision.messages.some(message => message.content.some(block => block.type === 'text' && block.text === text))).toBe(true)
  })

  it('does not promote negated policy or peer wording into a professional workflow', async () => {
    const ctx = await policyContext()
    const decision = await preStep(ctx, fakeAgent('deepseek-official'), [{
      content: [{
        type: 'text',
        text: '生成一份普通 DOCX 验收单，不做政策判断，也不要同行对标。',
      }],
      source: { kind: 'user' },
    }])
    const notice = JSON.stringify(decision)
    expect(notice).not.toContain('policy-retrieval')
    expect(notice).not.toContain('peer-benchmarking')
    expect(notice).not.toContain('洞见专业执行链已锁定')
    expect(notice).toContain('gongchuang_artifact_probe')
    expect(notice).toContain('无需调用 gongchuang_professional_validate')
    expect(notice).toContain('每份报告正文只生成一次')
    expect(notice).toContain('只有明确要求 PDF 时才生成 PDF')
  })

  it.each([
    'GC-QA 旧格式附件读取验收。只处理本次上传的 GC-QA-sheet.xls 和 GC-QA-merged.doc，使用默认文件读取流程各读取一次。对于能可靠读取的文件，列出文中的 GC-QA 标记和数字，工作簿同时给出合计；对于不能可靠读取的文件，直接说明支持状态和下一步。不要安装软件、猜测乱码或反复更换解析器，不修改文件，不读取其他企业资料，不生成报告。',
    '只读取附件，不生成报告。',
    '只读取附件，不读取政策文件。',
    '只读取附件，不查询同行。',
    '只读取附件，不检索申报材料。',
    '只读取附件，不访问企业资料。',
    '只读取附件，不处理申报材料。',
    '只读取附件，不修改申报材料。',
    '只读取附件，不导出申报材料。',
    '只读取附件，不使用政策文件。',
  ])('keeps an explicit file-reading exclusion out of professional routing: %s', async (text) => {
    const ctx = await policyContext()
    const decision = await preStep(ctx, fakeAgent('deepseek-official'), [{
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }])
    const notice = JSON.stringify(decision)
    expect(notice).not.toContain('洞见专业执行链已锁定')
    expect(notice).not.toContain('gongchuang_professional_validate')
    expect(notice).not.toContain('gongchuang_artifact_probe')
  })

  it.each([
    '不生成报告，只评估这家企业的高企申报条件。',
    '不生成报告,请查询最新政策。',
    '不生成报告；请做同行对标。',
    '不生成报告;请做同行对标。',
  ])('does not carry a prior exclusion into a later requested action: %s', async (text) => {
    const ctx = await policyContext()
    const decision = await preStep(ctx, fakeAgent('deepseek-official'), [{
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }])
    expect(JSON.stringify(decision)).toContain('洞见专业执行链已锁定')
  })

  it('verifies and publishes a generic completed document without a professional binding', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '生成一份普通 HTML 文件，不做政策或申报判断。' }],
      source: { kind: 'user' },
    }])
    const artifact = join(mkdtempSync(join(tmpdir(), 'gongchuang-generic-artifact-')), '验收单.html')
    writeFileSync(artifact, '<!doctype html><html><body>普通文档交付验收</body></html>')

    const definition = ctx.tools.get('gongchuang_artifact_probe')
    expect(definition?.presentCall?.({ artifactPath: artifact })).toMatchObject({
      card: 'generic',
      locations: [{ path: artifact }],
    })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('generic-artifact-probe'),
      name: 'gongchuang_artifact_probe',
      arguments: { artifactPath: artifact },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ ok: true, format: 'html' })
    expect((result.value as { path: string }).path).toContain('/验收单.html')
  })

  it('routes the golden peer prompt without treating prohibited market-share wording as a quality-brand task', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    const decision = await preStep(ctx, agent, [{
      content: [{
        type: 'text',
        text: '执行“找同行”黄金样例：寻找 3 家浙江省内相关同行。没有当前证据时只能写当前检索层未命中，不得编造企业、排名或市场份额。',
      }],
      source: { kind: 'user' },
    }])
    const notice = JSON.stringify(decision)
    expect(notice).toContain('peer-benchmarking')
    expect(notice).toContain('本轮是局部分析')
    expect(notice).not.toContain('强制正文顺序')
    expect(notice).toContain('kind=official-list')
    expect(notice).not.toContain('quality-brand-projects')

    const affirmative = await preStep(ctx, fakeAgent('deepseek-official'), [{
      content: [{ type: 'text', text: '请计算市场份额并分析质量品牌项目。' }],
      source: { kind: 'user' },
    }])
    expect(JSON.stringify(affirmative)).toContain('quality-brand-projects')
  })

  it('treats an explicitly named skill as the only body-contract owner and recognizes DOCX generation as formal', async () => {
    const ctx = await policyContext()
    const decision = await preStep(ctx, fakeAgent('deepseek-official'), [{
      content: [{
        type: 'text',
        text: '使用 quality-brand-projects 做浙江制造精品前期评估，生成待补资料 DOCX。',
      }],
      source: { kind: 'user' },
    }])
    const notice = JSON.stringify(decision)
    expect(notice).toContain('本轮是正式交付')
    expect(notice).toContain('正文结构只采用任务主技能：quality-brand-projects')
    expect(notice).not.toContain('正文结构只采用任务主技能：project-feasibility')
    expect(notice).toContain('evidence-ledger.create-docx')
    expect(notice).toContain('禁止探查运行环境')
    expect(notice).not.toContain('ELECTRON_RUN_AS_NODE=1')
    expect(notice).toContain('不得返回原始工具结果或含 undefined 的字段')
    expect(notice).toContain('先用尚未写入文件的完整 candidateText 做 chat 预校验')
  })

  it('injects the exact output contract when a business skill is activated after the first notice', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '你好。' }],
      source: { kind: 'user' },
    }])
    const decision = await postTool(ctx, execution('skill', true, agent, { name: 'peer-benchmarking' }), {
      isError: false,
      value: { name: 'peer-benchmarking' },
      content: [{ type: 'text', text: 'peer-benchmarking' }],
    })
    const context = JSON.stringify(decision.additionalContexts)
    expect(context).toContain('洞见技能输出契约：peer-benchmarking')
    expect(context).not.toContain('强制正文顺序')
    expect(context).toContain('kind=government-source')
  })

  it('announces newly expanded skill dependencies before candidate validation', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请处理这份企业申报材料。' }],
      source: { kind: 'user' },
    }])
    const first = await postTool(ctx, execution('skill', true, agent, { name: 'high-tech-enterprise-application-drafting' }), {
      isError: false,
      value: { name: 'high-tech-enterprise-application-drafting' },
      content: [{ type: 'text', text: 'high-tech-enterprise-application-drafting' }],
    })
    const notice = JSON.stringify(first.additionalContexts)
    expect(notice).toContain(`展开了新的 V${GONGCHUANG_SKILL_BUNDLE_VERSION} 必需依赖`)
    expect(notice).toContain('必须先逐项调用 skill 激活上述依赖')
    expect(notice).toContain('await tools.skill(')
    expect(notice).toContain('当前只开放 run_code')
    expect(notice).toContain('不要重新检索、重新读取或从头重写候选')
    expect(notice).not.toContain('必需依赖：high-tech-enterprise-application-drafting')

    const repeated = await postTool(
      ctx,
      execution('skill', true, agent, { name: 'high-tech-enterprise-application-drafting' }, 'same-skill-again'),
      {
        isError: false,
        value: { name: 'high-tech-enterprise-application-drafting' },
        content: [{ type: 'text', text: 'high-tech-enterprise-application-drafting' }],
      },
    )
    expect(JSON.stringify(repeated.additionalContexts ?? []))
      .not.toContain(`展开了新的 V${GONGCHUANG_SKILL_BUNDLE_VERSION} 必需依赖`)
  })

  it('refuses the first professional preflight until every required skill is activated', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '使用 quality-brand-projects 做浙江制造精品前期评估。' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'quality-brand-projects' }), {
      isError: false,
      value: { name: 'quality-brand-projects' },
      content: [{ type: 'text', text: 'quality-brand-projects' }],
    })
    const candidateText = '项目类型：产品认定类。市场地位证据分析：当前资料不足，暂无法判断。'
    const validate = async (callId: string) => ctx.tools.execute({
      callId: ToolCallId(callId),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'quality-brand', deliveryMode: 'chat', candidateText, evidence: [],
      },
      agent,
      signal: new AbortController().signal,
    })

    const early = await validate('missing-required-skills')
    expect(early.isError).toBe(false)
    expect(early.value).toMatchObject({ status: 'repairable' })
    expect(JSON.stringify(early)).toContain('专业校验前尚未激活')
    expect(JSON.stringify(early)).toContain('industry-chain-foundation-matcher')
    expect(JSON.stringify(early)).toContain('industry-positioning')

    for (const name of ['industry-chain-foundation-matcher', 'industry-positioning']) {
      await postTool(ctx, execution('skill', true, agent, { name }, `activate-${name}`), {
        isError: false,
        value: { name },
        content: [{ type: 'text', text: name }],
      })
    }
    const accepted = await validate('all-required-skills-active')
    expect(accepted.isError).toBe(false)
    expect(JSON.stringify(accepted)).not.toContain('专业校验前尚未激活')
  })

  it('explains the PTC entry point before a financial task activates skills', async () => {
    const ctx = await policyContext()
    const decision = await preStep(ctx, fakeAgent('deepseek-official'), [{
      content: [{ type: 'text', text: '请按财务核验流程计算收入增长率、研发投入占比和资产负债率，只在对话中给出结果。' }],
      source: { kind: 'user' },
    }])
    const notice = JSON.stringify(decision)
    expect(notice).toContain('financial-verification')
    expect(notice).toContain('await tools.skill(')
    expect(notice).toContain('当前只开放 run_code')
    expect(notice).toContain('不要直接调用未开放的根工具')
  })

  it('allows installed-skill execution and workspace writes while keeping interactive automation confirmable', async () => {
    const ctx = await policyContext()
    await expect(preTool(ctx, execution('read_file'))).resolves.toEqual({ kind: 'allow' })
    await expect(preTool(ctx, execution('skill'))).resolves.toEqual({ kind: 'allow' })
    await expect(preTool(ctx, execution('gongchuang_render_pdf'))).resolves.toEqual({ kind: 'allow' })
    await expect(preTool(ctx, execution('gongchuang_content_audit'))).resolves.toEqual({ kind: 'allow' })
    await expect(preTool(ctx, execution('gongchuang_create_automation'))).resolves.toMatchObject({ kind: 'ask' })
    await expect(preTool(ctx, execution('apply_patch'))).resolves.toMatchObject({ kind: 'allow' })
    await expect(preTool(ctx, execution('write'))).resolves.toMatchObject({ kind: 'allow' })
    await expect(preTool(ctx, execution('bash', true, undefined, { command: '/usr/bin/security find-generic-password' })))
      .resolves.toMatchObject({ kind: 'allow' })
    await expect(preTool(ctx, execution('pwsh', true, undefined, { command: 'CredRead("target")' })))
      .resolves.toMatchObject({ kind: 'allow' })
    await expect(preTool(ctx, execution('third_party_escape'))).resolves.toMatchObject({ kind: 'deny' })
    await expect(preTool(ctx, execution('read_file', false))).resolves.toMatchObject({ kind: 'deny' })
  })

  it('preserves a stricter downstream denial after this policy allows a tool', async () => {
    const ctx = await policyContext()
    ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => ({ kind: 'deny', reason: 'downstream seal' }))
    await expect(preTool(ctx, execution('read_file'))).resolves.toEqual({ kind: 'deny', reason: 'downstream seal' })
  })

  it.each([
    ['bash', 'cd /tmp && rm -rf digpre && mkdir digpre'],
    ['bash', 'mkdir work; /bin/rm -f old.docx'],
    ['bash', 'sudo command rm -r old'],
    ['bash', 'printf ready\nunlink old.docx'],
    ['bash', 'rmdir old'],
    ['pwsh', 'Get-Location; Remove-Item -Recurse -Force old'],
    ['pwsh', 'del old.docx'],
    ['pwsh', 'rm old.docx'],
  ])('rejects direct permanent deletion through %s', async (name, command) => {
    const ctx = await policyContext()
    const decision = await preTool(ctx, execution(name, true, undefined, { command }))
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).toContain('不得改用其他命令或脚本绕过')
  })

  it.each([
    ['bash', 'mkdir -p work && python3 build_report.py'],
    ['bash', 'printf "%s" "rm -rf is forbidden"'],
    ['bash', 'python3 -c "print(123)"'],
    ['pwsh', 'Get-Content ./report.md'],
  ])('keeps non-deletion %s commands available', async (name, command) => {
    const ctx = await policyContext()
    await expect(preTool(ctx, execution(name, true, undefined, { command })))
      .resolves.toEqual({ kind: 'allow' })
  })

  it('bounds product-launched web discovery and fetches, then forces a final synthesis step', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    const prompt = {
      content: [{ type: 'text' as const, text: '请对以下问题执行联网检索。核验现行政策' }],
      source: { kind: 'user' as const },
    }
    await preStep(ctx, agent, [prompt], 1, 1)

    for (let index = 1; index <= 6; index += 1) {
      await expect(preTool(ctx, execution('web_search', true, agent, {}, `search-${String(index)}`)))
        .resolves.toEqual({ kind: 'allow' })
    }
    const exhausted = await preTool(ctx, execution('web_search', true, agent, {}, 'search-7'))
    expect(exhausted.kind).toBe('deny')
    if (exhausted.kind === 'deny') {
      expect(exhausted.reason).toContain('政策与申报专业档')
      expect(exhausted.reason).toContain('发现次数已达上限（6 次）')
      expect(exhausted.reason).toContain('本地知识库和本机文件读取不计入该额度')
    }

    const fetchStage = await preStep(ctx, agent, [], 1, 2)
    expect(JSON.stringify(fetchStage)).not.toContain('联网检索预算已收束')
    for (let index = 1; index <= 8; index += 1) {
      await expect(preTool(ctx, execution('web_fetch', true, agent, {}, `fetch-${String(index)}`)))
        .resolves.toEqual({ kind: 'allow' })
    }
    const fetchExhausted = await preTool(ctx, execution('web_fetch', true, agent, {}, 'fetch-9'))
    expect(fetchExhausted.kind).toBe('deny')
    if (fetchExhausted.kind === 'deny') {
      expect(fetchExhausted.reason).toContain('政策与申报专业档')
      expect(fetchExhausted.reason).toContain('原文读取次数已达上限（8 次）')
      expect(fetchExhausted.reason).toContain('本地知识库和本机文件读取不计入该额度')
    }

    const synthesis = await preStep(ctx, agent, [], 1, 3)
    expect(JSON.stringify(synthesis)).toContain('联网检索预算已收束')
    expect(JSON.stringify(synthesis)).toContain('不得再调用 web_search')
    expect(JSON.stringify(synthesis)).toContain('verified 证据优先省略 toolCallId')
    expect(JSON.stringify(synthesis)).toContain('kind 必须填写 official-policy')
    expect(JSON.stringify(synthesis)).toContain('访问时间必须复制相关回执的 accessedAt')
    expect(JSON.stringify(synthesis)).toContain('不得放入 values')
    expect(JSON.stringify(synthesis)).toContain('仅在对话中交付正文时')
    expect(JSON.stringify(synthesis)).toContain('文件流程仍须继续生成、artifact 校验与剩余交付检查')
    const afterFinal = await preTool(ctx, execution('web_fetch', true, agent, {}, 'fetch-after-final'))
    expect(afterFinal.kind).toBe('deny')
    if (afterFinal.kind === 'deny') expect(afterFinal.reason).toContain('立即校验并输出结论')
    await expect(preTool(ctx, execution('gongchuang_professional_validate', true, agent)))
      .resolves.toEqual({ kind: 'allow' })
  })

  it('uses the ordinary tier for general questions without charging local knowledge or file reads', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '帮我解释这句话的含义' }],
      source: { kind: 'user' },
    }], 1, 1)

    await expect(preTool(ctx, execution('web_search', true, agent, {}, 'ordinary-search-1')))
      .resolves.toEqual({ kind: 'allow' })
    await expect(preTool(ctx, execution('web_search', true, agent, {}, 'ordinary-search-2')))
      .resolves.toEqual({ kind: 'allow' })
    const exhausted = await preTool(ctx, execution('web_search', true, agent, {}, 'ordinary-search-3'))
    expect(exhausted.kind).toBe('deny')
    if (exhausted.kind === 'deny') {
      expect(exhausted.reason).toContain('普通问答档')
      expect(exhausted.reason).toContain('发现次数已达上限（2 次）')
      expect(exhausted.reason).toContain('本地知识库和本机文件读取不计入该额度')
    }

    await expect(preTool(ctx, execution('read', true, agent)))
      .resolves.toEqual({ kind: 'allow' })
    await expect(preTool(ctx, execution('read_file', true, agent)))
      .resolves.toEqual({ kind: 'allow' })
  })

  it('ends only the web phase at maxSteps and still permits local synthesis and professional validation', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    const prompt = {
      content: [{ type: 'text' as const, text: '请对以下问题执行联网检索。核验现行政策' }],
      source: { kind: 'user' as const },
    }
    await preStep(ctx, agent, [prompt], 1, 1)

    const finalSearchStep = await preStep(ctx, agent, [], 1, 20)
    expect(finalSearchStep.kind).toBe('enter')
    expect(JSON.stringify(finalSearchStep)).toContain('联网检索预算已收束')

    const localSynthesisStep = await preStep(ctx, agent, [], 1, 21)
    expect(localSynthesisStep).toEqual({ kind: 'enter', messages: [] })
    await expect(preTool(ctx, execution('read', true, agent)))
      .resolves.toEqual({ kind: 'allow' })
    await expect(preTool(ctx, execution('gongchuang_professional_validate', true, agent)))
      .resolves.toEqual({ kind: 'allow' })

    const lateSearch = await preTool(ctx, execution('web_search', true, agent, {}, 'late-search'))
    expect(lateSearch.kind).toBe('deny')
    if (lateSearch.kind === 'deny') expect(lateSearch.reason).toContain('联网检索预算已用尽')
  })

  it('activates the signed search budget from actual tool use without a launcher phrase', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '读取企业资料并找三家浙江同行' }],
      source: { kind: 'user' },
    }], 1, 1)

    for (let index = 1; index <= 8; index += 1) {
      await expect(preTool(ctx, execution('web_search', true, agent, {}, `implicit-${String(index)}`)))
        .resolves.toEqual({ kind: 'allow' })
    }
    const exhausted = await preTool(ctx, execution('mcp__gongchuang_search__evidence_search', true, agent, {}, 'implicit-9'))
    expect(exhausted.kind).toBe('deny')
    if (exhausted.kind === 'deny') {
      expect(exhausted.reason).toContain('高风险业务保障档')
      expect(exhausted.reason).toContain('发现次数已达上限（8 次）')
      expect(exhausted.reason).toContain('本地知识库和本机文件读取不计入该额度')
    }

    const fetchStage = await preStep(ctx, agent, [], 1, 2)
    expect(JSON.stringify(fetchStage)).not.toContain('联网检索预算已收束')
    for (let index = 1; index <= 12; index += 1) {
      await expect(preTool(ctx, execution('web_fetch', true, agent, {}, `implicit-fetch-${String(index)}`)))
        .resolves.toEqual({ kind: 'allow' })
    }
    const synthesis = await preStep(ctx, agent, [], 1, 3)
    expect(JSON.stringify(synthesis)).toContain('联网检索预算已收束')
    await expect(preTool(ctx, execution('web_fetch', true, agent, {}, 'implicit-fetch-after-final')))
      .resolves.toMatchObject({ kind: 'deny' })
  })

  it('counts one logical search call once when pre-execute is retried with the same call id', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '读取企业资料并找三家浙江同行' }],
      source: { kind: 'user' },
    }], 1, 1)

    for (let retry = 0; retry < 6; retry += 1) {
      await expect(preTool(ctx, execution(
        'mcp__gongchuang_search__evidence_search', true, agent, {}, 'logical-search-1',
      ))).resolves.toEqual({ kind: 'allow' })
    }
    for (let index = 2; index <= 8; index += 1) {
      await expect(preTool(ctx, execution('web_search', true, agent, {}, `logical-search-${String(index)}`)))
        .resolves.toEqual({ kind: 'allow' })
    }
    const exhausted = await preTool(ctx, execution('web_search', true, agent, {}, 'logical-search-9'))
    expect(exhausted.kind).toBe('deny')
    if (exhausted.kind === 'deny') expect(exhausted.reason).toContain('发现次数已达上限')
  })

  it('counts a concurrent Gongchuang search wrapper and its nested web_search as one logical discovery', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '读取企业资料并找三家浙江同行' }],
      source: { kind: 'user' },
    }], 1, 1)

    // The outer MCP calls can all enter before their nested web_search calls
    // start. Reproduce that real concurrency order explicitly.
    for (let index = 1; index <= 3; index += 1) {
      await expect(preTool(ctx, execution(
        'mcp__gongchuang_search__evidence_search', true, agent, {}, `logical-${String(index)}`,
      ))).resolves.toEqual({ kind: 'allow' })
    }
    for (let index = 1; index <= 3; index += 1) {
      await expect(preTool(ctx, execution(
        'web_search', true, agent, {}, `logical-${String(index)}:gongchuang-search`,
      ))).resolves.toEqual({ kind: 'allow' })
    }
    for (let index = 4; index <= 8; index += 1) {
      await expect(preTool(ctx, execution(
        'mcp__gongchuang_search__evidence_search', true, agent, {}, `logical-${String(index)}`,
      ))).resolves.toEqual({ kind: 'allow' })
      await expect(preTool(ctx, execution(
        'web_search', true, agent, {}, `logical-${String(index)}:gongchuang-search`,
      ))).resolves.toEqual({ kind: 'allow' })
    }

    const exhausted = await preTool(ctx, execution(
      'mcp__gongchuang_search__evidence_search', true, agent, {}, 'logical-9',
    ))
    expect(exhausted.kind).toBe('deny')
    if (exhausted.kind === 'deny') expect(exhausted.reason).toContain('发现次数已达上限')
  })

  it('retries one transient enterprise-source call once and skips authorization cancellation immediately', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请分析这家企业的工商与知识产权情况' }],
      source: { kind: 'user' },
    }])
    const arguments_ = { companyName: '测试企业有限公司' }
    const first = execution('mcp__tianyancha__company_profile', true, agent, arguments_, 'tyc-transient-1')
    await expect(preTool(ctx, first)).resolves.toMatchObject({ kind: 'allow' })
    const firstFailure = await postTool(ctx, first, {
      isError: true,
      error: { message: 'temporary network timeout' },
      content: [{ type: 'text', text: 'temporary network timeout' }],
    })
    expect(JSON.stringify(firstFailure.additionalContexts)).toContain('只允许原参数重试一次')

    const retry = execution('mcp__tianyancha__company_profile', true, agent, arguments_, 'tyc-transient-2')
    await expect(preTool(ctx, retry)).resolves.toMatchObject({ kind: 'allow' })
    const secondFailure = await postTool(ctx, retry, {
      isError: true,
      error: { message: 'temporary network timeout' },
      content: [{ type: 'text', text: 'temporary network timeout' }],
    })
    expect(JSON.stringify(secondFailure.additionalContexts)).toContain('切换下一可用来源')
    await expect(preTool(ctx, execution(
      'mcp__tianyancha__company_profile', true, agent, arguments_, 'tyc-transient-3',
    ))).resolves.toMatchObject({ kind: 'deny' })

    const cancelled = execution('mcp__qcc_company__search', true, agent, arguments_, 'qcc-cancelled-1')
    await expect(preTool(ctx, cancelled)).resolves.toMatchObject({ kind: 'allow' })
    await postTool(ctx, cancelled, {
      isError: true,
      error: { message: '用户取消企查查授权' },
      content: [{ type: 'text', text: '用户取消企查查授权' }],
    })
    await expect(preTool(ctx, execution(
      'mcp__qcc_company__search', true, agent, arguments_, 'qcc-cancelled-2',
    ))).resolves.toMatchObject({ kind: 'deny' })
  })

  it('admits signed delivery publication and local memory tools', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    for (const name of ['gongchuang_publish_files', 'gm_status', 'gm_stats', 'gm_search', 'gm_record']) {
      await expect(preTool(ctx, execution(name, true, agent))).resolves.toEqual({ kind: 'allow' })
    }
  })

  it('keeps a formal-delivery turn open until actionable trusted receipts settle successfully', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    const prompt = {
      content: [{ type: 'text' as const, text: '请生成项目可行性HTML作为最终文件' }],
      source: { kind: 'user' as const },
    }
    await preStep(ctx, agent, [prompt])

    for (const skillName of ['project-task-router', 'project-feasibility']) {
      await postTool(ctx, execution('skill', true, agent, { name: skillName }), {
        isError: false,
        value: { name: skillName },
        content: [{ type: 'text', text: skillName }],
      })
    }

    const signal = new AbortController().signal
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal })
    expect(steering).toHaveLength(1)
    expect(JSON.stringify(steering[0])).toContain('content-audit')
    expect(JSON.stringify(steering[0])).not.toContain('visual-inspection')
    expect(JSON.stringify(steering[0])).toContain('brand-watermark')
    expect(JSON.stringify(steering[0])).toContain('artifact-openability')

    const validatedCandidate = '总体结论：当前证据只支持继续核验，正式结论以交付文件正文为准。'
    const chatPreflight = execution('gongchuang_professional_validate', true, agent, {}, 'chat-preflight')
    ctx.gongchuangPolicy.claim(chatPreflight, 'professional-kernel', validatedCandidate)
    await postTool(ctx, chatPreflight, {
      isError: false,
      value: { ok: true },
      content: [{ type: 'text', text: 'validated' }],
    })

    const artifact = join(mkdtempSync(join(tmpdir(), 'gongchuang-receipts-')), 'report.html')
    writeFileSync(artifact, '<!doctype html><html><body>项目可行性正式报告正文，用于绑定实际文件与受信任回执。</body></html>')
    const inspection = PolicyGate.inspectProfessionalArtifact(artifact)
    const professional = execution('gongchuang_professional_validate', true, agent)
    ctx.gongchuangPolicy.claim(professional, 'professional-kernel', undefined, {
      path: inspection.path,
      format: inspection.format,
      sha256: inspection.sha256,
      candidateSha256: inspection.contentSha256 as string,
      contentSha256: inspection.contentSha256 as string,
    })
    await postTool(ctx, professional, {
      isError: false,
      value: { ok: true },
      content: [{ type: 'text', text: 'validated' }],
    })

    const producers = [
      ['gongchuang_content_audit', 'content-audit'],
      ['gongchuang_branding_gate', 'brand-watermark'],
      ['gongchuang_artifact_probe', 'artifact-openability'],
    ] as const
    for (const [toolName, receiptId] of producers) {
      const exec = execution(toolName, true, agent)
      ctx.gongchuangPolicy.claim(exec, receiptId)
      await postTool(ctx, exec, {
        isError: false,
        value: null,
        content: [{ type: 'text', text: 'ok' }],
      })
    }

    appendAssistant(agent, '文件已生成并发布。')
    steering.length = 0
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal })
    expect(steering).toEqual([])
  })

  it('waits for the enterprise panorama mode instead of choosing one and continuing', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '浙江益成机电科技有限公司，帮我出一份分析报告' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'enterprise-panorama-analysis' }), {
      isError: false,
      value: { name: 'enterprise-panorama-analysis' },
      content: [{ type: 'text', text: 'enterprise-panorama-analysis' }],
    })

    const blocked = await preTool(ctx, execution('web_fetch', true, agent, {
      url: 'https://example.com/company',
    }))
    expect(blocked.kind).toBe('deny')
    if (blocked.kind === 'deny') expect(blocked.reason).toContain('尚未由用户选择 A、B 或 C')

    await expect(preTool(ctx, execution('run_code', true, agent, {
      code: 'await Promise.all([tools.skill({ name: "enterprise-profile" }), tools.skill({ name: "evidence-ledger" })])',
    }))).resolves.toEqual({ kind: 'allow' })
    const disguisedResearch = await preTool(ctx, execution('run_code', true, agent, {
      code: 'return tools.mcp__tianyancha__get_company_basic_profile({ company_name: "测试公司" })',
    }))
    expect(disguisedResearch.kind).toBe('deny')

    await expect(preTool(ctx, execution('ask_user_question', true, agent))).resolves.toEqual({ kind: 'allow' })
    await postTool(ctx, execution('ask_user_question', true, agent), {
      isError: false,
      value: { answers: [{ id: 'report-mode', answer: 'A 标准销售版' }] },
      content: [{ type: 'text', text: '{"answers":[{"id":"report-mode","answer":"A 标准销售版"}]}' }],
    })
    await expect(preTool(ctx, execution('web_fetch', true, agent, {
      url: 'https://example.com/company',
    }))).resolves.toEqual({ kind: 'allow' })
  })

  it('lets a plain report-mode question end the turn so the user can answer', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '浙江益成机电科技有限公司，帮我出一份分析报告' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'enterprise-panorama-analysis' }), {
      isError: false,
      value: { name: 'enterprise-panorama-analysis' },
      content: [{ type: 'text', text: 'enterprise-panorama-analysis' }],
    })
    appendAssistant(agent, '请选择报告模式：A 标准销售版、B 深度顾问版或 C 全生成。')

    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(steering).toEqual([])
  })

  it('keeps a generic file-format request outside the professional delivery chain', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '先整理一下资料' }],
      source: { kind: 'user' },
    }])
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '现在生成PDF作为最终文件' }],
      source: { kind: 'user' },
    }])
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(steering).toEqual([])
  })

  it('does not treat an existing DOCX read as a newly produced formal deliverable', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请读取导入资料/企业申请资料.docx，不要生成新文件' }],
      source: { kind: 'user' },
    }])

    const decision = await preTool(ctx, execution('read', true, agent, {
      path: '/workspace/导入资料/企业申请资料.docx',
    }))
    expect(decision.kind).toBe('allow')

    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(steering).toEqual([])
  })

  it('allows a generic DOCX write without inventing a professional delivery workflow', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '整理资料' }],
      source: { kind: 'user' },
    }])

    const decision = await preTool(ctx, execution('write', true, agent, {
      path: '/workspace/正式报告.docx',
      content: '正式报告正文',
    }))
    expect(decision.kind).toBe('allow')

    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(steering).toEqual([])
  })

  it('keeps the shared reader skill on an ordinary task without activating its business dependencies', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '读取混合 PDF，按页列出标记和算式。不做企业或政策分析，不生成报告。' }],
      source: { kind: 'user' },
    }])
    for (const name of ['project-application-assistant', 'project-task-router']) {
      await postTool(ctx, execution('skill', true, agent, { name }), {
        isError: false, value: { name, content: '文档读取指引' }, content: [{ type: 'text', text: '文档读取指引' }],
      })
    }
    const exec = execution('gongchuang_skill_operation', true, agent)
    expect(ctx.gongchuangPolicy.requiredProfessionalSkills(exec)).toEqual([])
    expect(() => { ctx.gongchuangPolicy.assertSkillActivated(exec, 'project-application-assistant') }).not.toThrow()
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: new AbortController().signal })
    expect(steering).toEqual([])
    await preStep(ctx, agent, [{ content: [{ type: 'text', text: '请形成项目可行性分析报告' }], source: { kind: 'user' } }], 2)
    expect(ctx.gongchuangPolicy.requiredProfessionalSkills(exec)).not.toEqual([])
  })

  it('binds signed workspace-document extraction output as customer-file evidence', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '读取已导入的企业资料' }],
      source: { kind: 'user' },
    }])
    const text = [
      '企业资料导入验收',
      '洞见 DOCX 验收标记：GC-DOCX-816-A',
      '企业名称：洞见文档验收企业',
    ].join('\n')
    const toolCallId = await captureEvidence(
      ctx,
      agent,
      text,
      'signed-document-extract',
      'gongchuang_skill_operation',
      {
        operation: 'project-application-assistant.extract-workspace-document',
        arguments: { document: '导入资料/企业申请资料.docx' },
      },
    )

    const attested = ctx.gongchuangPolicy.attestEvidence(
      execution('gongchuang_professional_validate', true, agent),
      [{
        id: 'DOC-1',
        kind: 'customer-document',
        status: 'user-provided',
        source: '企业空间文档',
        values: ['企业资料导入验收', 'GC-DOCX-816-A'],
      }],
    )
    expect(attested[0]?.toolCallId).toBe(toolCallId)
    const expectedText = `${text}\n${JSON.stringify({ text })}`
    expect(attested[0]?.sha256).toBe(createHash('sha256').update(expectedText).digest('hex'))
  })

  it('binds one signed calculation receipt without making the model enumerate artifact numbers', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请生成制造企业财税分析报告' }],
      source: { kind: 'user' },
    }])
    const operation = 'manufacturing-tax-risk-analysis.calculate-metrics'
    const text = JSON.stringify({
      operation,
      schema_version: 'manufacturing-tax-risk-calculation-operation/v1',
      validation_values: ['25.00%', '1,800.00万元', '18,000,000.00元'],
    })
    const toolCallId = await captureEvidence(
      ctx,
      agent,
      text,
      'signed-tax-calculation',
      'gongchuang_skill_operation',
      { operation },
    )

    const [attested] = ctx.gongchuangPolicy.attestEvidence(
      execution('gongchuang_professional_validate', true, agent),
      [{
        id: 'CALC-1',
        kind: 'deterministic-calculation',
        status: 'calculated',
        source: operation,
        values: [],
      }],
    )
    expect(attested?.toolCallId).toBe(toolCallId)
    expect(attested?.values).toEqual(expect.arrayContaining(['25.00%', '1,800.00', '18,000,000.00']))
  })

  it('canonicalizes hand-copied calculated evidence to its signed operation receipt', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请生成制造企业财税分析报告' }],
      source: { kind: 'user' },
    }])
    const operation = 'manufacturing-tax-risk-analysis.calculate-metrics'
    const text = JSON.stringify({
      operation,
      schema_version: 'manufacturing-tax-risk-calculation-operation/v1',
      validation_values: ['25.00%', '1,800.00万元', '18,000,000.00元'],
    })
    const toolCallId = await captureEvidence(
      ctx,
      agent,
      text,
      'signed-tax-calculation-canonical',
      'gongchuang_skill_operation',
      { operation },
    )

    const [attested] = ctx.gongchuangPolicy.attestEvidence(
      execution('gongchuang_professional_validate', true, agent),
      [{
        id: 'CALC-1',
        kind: 'deterministic-calculation',
        status: 'calculated',
        source: `已验签操作 ${operation}`,
        values: ['手工枚举但并不存在于可信回执中的错误值'],
      }],
    )
    expect(attested?.toolCallId).toBe(toolCallId)
    expect(attested?.source).toBe(operation)
    expect(attested?.values).not.toContain('手工枚举但并不存在于可信回执中的错误值')
    expect(attested?.values).toEqual(expect.arrayContaining(['25.00%', '1,800.00', '18,000,000.00']))
  })

  it('binds one signed preflight receipt as deterministic calculated evidence', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请做 2026 年专精特新前期预评估' }],
      source: { kind: 'user' },
    }])
    const operation = 'sme-score-preassessment.run-preflight'
    const text = JSON.stringify({
      schema_version: 1,
      policy_version: '2026.1',
      quality_score_threshold: 50,
    })
    const toolCallId = await captureEvidence(
      ctx,
      agent,
      text,
      'signed-sme-preflight',
      'gongchuang_skill_operation',
      { operation },
    )

    const [attested] = ctx.gongchuangPolicy.attestEvidence(
      execution('gongchuang_professional_validate', true, agent),
      [{
        id: 'PREFLIGHT-2026',
        kind: 'deterministic-preflight',
        status: 'calculated',
        source: operation,
        values: [],
      }],
    )
    expect(attested?.toolCallId).toBe(toolCallId)
    expect(attested?.source).toBe(operation)
    expect(attested?.values).toEqual(expect.arrayContaining(['2026.1', '50']))
  })

  it('binds PaddleOCR structured output as customer-file evidence when visible content is only a status', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '读取已导入的扫描件' }],
      source: { kind: 'user' },
    }])
    const ocrText = '洞见扫描件OCR验收\n验收标记：GC-OCR-816-E\n项目投资：2468 万元'
    const exec = execution(
      'mcp__paddle_ocr__workspace_pdf',
      true,
      agent,
      { document: '导入资料/扫描件OCR验收.pdf' },
      'paddle-ocr-structured',
    )
    await postTool(ctx, exec, {
      isError: false,
      content: [{ type: 'text', text: 'OCR 完成' }],
      value: { text: ocrText },
    })

    const attested = ctx.gongchuangPolicy.attestEvidence(
      execution('gongchuang_professional_validate', true, agent),
      [{
        id: 'OCR-1',
        kind: 'customer-document',
        status: 'user-provided',
        source: '企业空间扫描件',
        values: ['GC-OCR-816-E', '2468 万元'],
      }],
    )
    const expectedText = `OCR 完成\n${JSON.stringify({ text: ocrText })}`
    expect(attested[0]?.toolCallId).toBe('paddle-ocr-structured')
    expect(attested[0]?.sha256).toBe(createHash('sha256').update(expectedText).digest('hex'))
  })

  it('does not accept a claimed receipt when the producer result failed', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请生成项目可行性PDF作为最终文件' }],
      source: { kind: 'user' },
    }])
    const exec = execution('gongchuang_content_audit', true, agent)
    ctx.gongchuangPolicy.claim(exec, 'content-audit')
    await postTool(ctx, exec, {
      isError: true,
      error: { message: 'audit failed' },
      content: [{ type: 'text', text: 'failed' }],
    })
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(JSON.stringify(steering[0])).toContain('content-audit')
  })

  it('fails immediately with a visible incomplete result when PDF rendering is unavailable', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请生成项目可行性PDF作为最终文件' }],
      source: { kind: 'user' },
    }])
    const artifact = join(mkdtempSync(join(tmpdir(), 'gongchuang-renderer-unavailable-')), 'report.pdf')
    writeFileSync(artifact, '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF\n')
    const candidate = '总体结论：当前 PDF 候选仅包含已核验内容。'
    const artifactSha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex')
    const contentSha256 = createHash('sha256').update(candidate).digest('hex')
    const validation = execution('gongchuang_professional_validate', true, agent)
    ctx.gongchuangPolicy.claim(validation, 'professional-kernel', candidate, {
      path: resolve(artifact),
      format: 'pdf',
      sha256: artifactSha256,
      candidateSha256: contentSha256,
      contentSha256,
    })
    await postTool(ctx, validation, {
      isError: false,
      value: { ok: true },
      content: [{ type: 'text', text: 'validated' }],
    })
    appendAssistant(agent, candidate)

    await expect(agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })).resolves.toBeUndefined()
    expect(JSON.stringify(steering)).toContain('PDF 自动视觉回归能力不可用')
    expect(JSON.stringify(steering)).toContain('不得自动重试')
  })

  it('uses one corrective continuation and then finishes as a draft without looping', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请撰写高企申请书的企业创新能力四栏' }],
      source: { kind: 'user' },
    }])
    const stop = (): Promise<void> => agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })

    await stop()
    await stop()
    await expect(stop()).resolves.toBeUndefined()
    expect(steering).toHaveLength(2)
    expect(JSON.stringify(steering[0])).toContain('唯一一次自动修正机会')
    expect(JSON.stringify(steering[1])).toContain('待完善稿')
  })

  it('persists a paused professional task and restores evidence and skills after a process restart', async () => {
    const config = signedFixture()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PolicyGate, config)
    const sessionId = `checkpoint-${randomUUID()}`
    const first = fakeAgent('deepseek-official', [], sessionId)
    await preStep(ctx, first, [{
      content: [{ type: 'text', text: '请分析项目可行性，并执行联网检索' }],
      source: { kind: 'user' },
    }])
    await captureEvidence(ctx, first, '主管部门原文已经确认申报对象。', 'checkpoint-source')
    await postTool(ctx, execution('skill', true, first, { name: 'project-feasibility' }, 'checkpoint-skill'), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const interrupted = new AbortController()
    interrupted.abort()
    await agentEvents(ctx, first).serial('agent/turn-stopping', { turn: 1, signal: interrupted.signal })

    const stored = await new ProfessionalTaskCheckpointStore(config.professionalCheckpointDir).read(sessionId)
    expect(stored).toMatchObject({ kind: 'found', checkpoint: { phase: 'paused' } })

    const restarted = fakeAgent('deepseek-official', [], sessionId)
    const resumed = await preStep(ctx, restarted, [{
      content: [{ type: 'text', text: '继续' }],
      source: { kind: 'user' },
    }], 2)
    const serialized = JSON.stringify(resumed)
    expect(serialized).toContain('已从本地检查点恢复同一专业任务')
    expect(serialized).toContain('已复用 1 项受信任证据和 1 项已激活技能')
    expect(serialized).toContain('不得重新读取、检索或重复申请授权')

    const unrelated = fakeAgent('deepseek-official', [], sessionId)
    const ordinary = await preStep(ctx, unrelated, [{
      content: [{ type: 'text', text: '帮我把这句话写得更简洁' }],
      source: { kind: 'user' },
    }], 3)
    expect(JSON.stringify(ordinary)).not.toContain('已从本地检查点恢复同一专业任务')
  })

  it('restores exact authored repair sources after an interrupted client session', async () => {
    const config = signedFixture()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PolicyGate, config)
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-repair-resume-'))
    const sessionId = `repair-resume-${randomUUID()}`
    const first = fakeAgent('deepseek-official', [], sessionId, root)
    await preStep(ctx, first, [{
      content: [{ type: 'text', text: '请形成项目可行性报告并生成正式文件' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, first, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const source = join(root, 'report-data.json')
    writeFileSync(source, '{"status":"draft"}')
    await postTool(ctx, execution('write', true, first, {
      file_path: source,
      content: '{"status":"draft"}',
    }, 'resumable-repair-source'), {
      isError: false,
      value: { path: source },
      content: [{ type: 'text', text: 'written' }],
    })
    const untracked = join(root, 'untracked.json')
    writeFileSync(untracked, '{}')
    const artifact = join(root, '可行性报告.html')
    writeFileSync(artifact, '<!doctype html><html><body>内容不足。</body></html>')
    const validation = await ctx.tools.execute({
      callId: ToolCallId('resumable-repair-validation'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report',
        deliveryMode: 'artifact',
        artifactPath: artifact,
        artifactFormat: 'html',
        deliveryProfileId: 'project-feasibility-analysis-report',
        evidence: [],
      },
      agent: first,
      signal: new AbortController().signal,
    })
    expect(JSON.stringify(validation)).toContain('repairable')
    const interrupted = new AbortController()
    interrupted.abort()
    await agentEvents(ctx, first).serial('agent/turn-stopping', {
      turn: 1,
      signal: interrupted.signal,
    })

    const restarted = fakeAgent('deepseek-official', [], sessionId, root)
    const resumed = await preStep(ctx, restarted, [{
      content: [{ type: 'text', text: '继续' }],
      source: { kind: 'user' },
    }], 2, 1)
    expect(JSON.stringify(resumed)).toContain('专业修正窗口已限为一步')
    await expect(preTool(ctx, execution('read', true, restarted, { file_path: source }, 'resumed-source-read')))
      .resolves.toEqual({ kind: 'allow' })
    await expect(preTool(ctx, execution('read', true, restarted, { file_path: artifact }, 'resumed-artifact-read')))
      .resolves.toEqual({ kind: 'allow' })
    const resumedUntracked = await preTool(
      ctx,
      execution('read', true, restarted, { file_path: untracked }, 'resumed-untracked-read'),
    )
    expect(resumedUntracked).toMatchObject({ kind: 'deny' })
    expect(JSON.stringify(resumedUntracked)).toContain('已成功写入')
  })

  it('starts one fresh bounded revision when a user explicitly resumes a draft', async () => {
    const ctx = await policyContext()
    const sessionId = `draft-checkpoint-${randomUUID()}`
    const firstSteering: unknown[] = []
    const first = fakeAgent('deepseek-official', firstSteering, sessionId)
    await preStep(ctx, first, [{
      content: [{ type: 'text', text: '请撰写高企申请书的企业创新能力四栏' }],
      source: { kind: 'user' },
    }])
    await agentEvents(ctx, first).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    await agentEvents(ctx, first).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(JSON.stringify(firstSteering)).toContain('待完善稿')

    const resumedSteering: unknown[] = []
    const restarted = fakeAgent('deepseek-official', resumedSteering, sessionId)
    await preStep(ctx, restarted, [{
      content: [{ type: 'text', text: '继续' }],
      source: { kind: 'user' },
    }], 2)
    await agentEvents(ctx, restarted).serial('agent/turn-stopping', {
      turn: 2,
      signal: new AbortController().signal,
    })
    expect(resumedSteering).toHaveLength(1)
    expect(JSON.stringify(resumedSteering[0])).toContain('唯一一次自动修正机会')
    expect(JSON.stringify(resumedSteering[0])).not.toContain('待完善稿已有限收束')
  })

  it('does not reset the one-correction budget when the missing set changes', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请撰写高企申请书的企业创新能力四栏' }],
      source: { kind: 'user' },
    }])
    const skills = [
      'high-tech-enterprise-application-drafting',
      'high-tech-enterprise-preassessment',
      'enterprise-profile',
      'policy-retrieval',
      'evidence-ledger',
      'consistency-check',
    ] as const
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    await postTool(ctx, execution('skill', true, agent, { name: skills[0] }), {
      isError: false,
      value: { name: skills[0] },
      content: [{ type: 'text', text: skills[0] }],
    })

    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    await expect(agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })).resolves.toBeUndefined()
    expect(steering).toHaveLength(2)
    expect(JSON.stringify(steering[1])).toContain('待完善稿')
  })

  it('returns a structured draft and copies an openable artifact after one failed repair', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成项目可行性报告并生成正式文件' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const artifact = join(mkdtempSync(join(tmpdir(), 'gongchuang-draft-artifact-')), '可行性报告.html')
    writeFileSync(artifact, '<!doctype html><html><body>内容不足但仍需保留的报告候选正文。</body></html>')
    const arguments_ = {
      taskType: 'feasibility-report',
      deliveryMode: 'artifact',
      artifactPath: artifact,
      artifactFormat: 'html',
      deliveryProfileId: 'project-feasibility-analysis-report',
      evidence: [],
    }
    const first = await ctx.tools.execute({
      callId: ToolCallId('draft-first-validation'),
      name: 'gongchuang_professional_validate',
      arguments: arguments_,
      agent,
      signal: new AbortController().signal,
    })
    expect(first.isError).toBe(false)
    expect(JSON.stringify(first)).toContain('repairable')

    const second = await ctx.tools.execute({
      callId: ToolCallId('draft-second-validation'),
      name: 'gongchuang_professional_validate',
      arguments: arguments_,
      agent,
      signal: new AbortController().signal,
    })
    expect(second.isError).toBe(false)
    const serialized = JSON.stringify(second)
    expect(serialized).toContain('"status":"draft"')
    expect(serialized).toContain('待完善')
    const draftPath = /"artifactPath":"([^"]+待完善[^"]*)"/u.exec(serialized)?.[1]
    expect(draftPath).toBeDefined()
    expect(existsSync(draftPath as string)).toBe(true)
    expect(readFileSync(draftPath as string)).toEqual(readFileSync(artifact))
    expect(existsSync(artifact)).toBe(true)

    const originalPathProbe = await ctx.tools.execute({
      callId: ToolCallId('draft-original-path-probe'),
      name: 'gongchuang_artifact_probe',
      arguments: { artifactPath: artifact },
      agent,
      signal: new AbortController().signal,
    })
    expect(originalPathProbe.isError).toBe(false)
    expect(originalPathProbe.value).toMatchObject({ ok: true, path: draftPath })

    const markedPathProbe = await ctx.tools.execute({
      callId: ToolCallId('draft-marked-path-probe'),
      name: 'gongchuang_artifact_probe',
      arguments: { artifactPath: draftPath },
      agent,
      signal: new AbortController().signal,
    })
    expect(markedPathProbe.isError).toBe(false)
    expect(markedPathProbe.value).toMatchObject({ ok: true, path: draftPath })

    const draftContentAudit = await ctx.tools.execute({
      callId: ToolCallId('draft-content-audit'),
      name: 'gongchuang_content_audit',
      arguments: { artifactPath: artifact },
      agent,
      signal: new AbortController().signal,
    })
    expect(draftContentAudit.isError).toBe(false)
    expect(draftContentAudit.value).toMatchObject({ ok: true })

    const unrelated = join(dirname(artifact), '其他报告.html')
    writeFileSync(unrelated, '<!doctype html><html><body>无关文件。</body></html>')
    const unrelatedProbe = await ctx.tools.execute({
      callId: ToolCallId('draft-unrelated-path-probe'),
      name: 'gongchuang_artifact_probe',
      arguments: { artifactPath: unrelated },
      agent,
      signal: new AbortController().signal,
    })
    expect(unrelatedProbe.isError).toBe(true)
    expect(JSON.stringify(unrelatedProbe)).toContain('待完善终态只允许检查宿主返回的待完善副本')

    await postTool(ctx, execution('gongchuang_professional_validate', true, agent, arguments_, 'draft-second-validation'), second)
    expect(await preStep(ctx, agent, [], 1, 3)).toEqual({ kind: 'reject' })
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    const outcome = agent.session.snapshotEvents().findLast(event => event.type === 'user/message'
      && event.data.source?.kind === 'plugin' && event.data.source.plugin === 'gongchuang-policy-gate'
      && 'delivery' in event.data.source)
    expect(outcome?.data).toMatchObject({
      source: { delivery: { phase: 'draft', files: [{ originalPath: artifact, path: draftPath }] } },
    })
  })

  it('settles an explicitly requested policy-unavailable draft without opening a pointless repair step', async () => {
    const ctx = await policyContext()
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-explicit-policy-draft-'))
    const agent = fakeAgent('deepseek-official', [], undefined, root)
    await preStep(ctx, agent, [{
      content: [{
        type: 'text',
        text: '请形成项目可行性报告。如果官方政策无法核验，生成明确标注的待完善草稿并正常交付，不要反复重试。',
      }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const artifact = join(root, '可行性报告.html')
    writeFileSync(artifact, [
      '<!doctype html><html><body>',
      '<h1>项目可行性报告草稿</h1>',
      '<h2>项目版本与窗口</h2><p>官方政策原文待核验，当前结果待完善。</p>',
      '<h2>总体结论</h2><p>仅作内部参考，不作为正式申报结论。</p>',
      '<h2>逐项补强计划</h2>',
      '<table><caption>补强任务表</caption><tr><th>补强动作</th><th>完成标准</th></tr>',
      '<tr><td>取得官方原文</td><td>来源可追溯</td></tr></table>',
      '</body></html>',
    ].join(''))
    const result = await ctx.tools.execute({
      callId: ToolCallId('explicit-policy-draft-validation'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report',
        deliveryMode: 'artifact',
        artifactPath: artifact,
        artifactFormat: 'html',
        deliveryProfileId: 'project-feasibility-analysis-report',
        evidence: [{
          id: 'PENDING-POLICY', kind: 'official-policy', status: 'pending', source: '当期政策待核验', values: [],
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    const serialized = JSON.stringify(result)
    expect(result.isError).toBe(false)
    expect(serialized).toContain('"status":"draft"')
    expect(serialized).not.toContain('repairable')
    expect(serialized).toContain('政策选择链与官方原文')
    expect(serialized).toContain('待完善')
    expect(await preStep(ctx, agent, [], 1, 2)).toEqual({ kind: 'reject' })
  })

  it('lets a policy-limited chat preflight continue only far enough to create the requested draft artifact', async () => {
    const ctx = await policyContext()
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-policy-draft-preflight-'))
    const agent = fakeAgent('deepseek-official', [], undefined, root)
    await preStep(ctx, agent, [{
      content: [{
        type: 'text',
        text: '请仅依据已提供资料撰写高企申请书 DOCX 草稿。不联网，当前政策原文缺口保持待核验，不得补造政策。',
      }],
      source: { kind: 'user' },
    }])
    for (const skill of [
      'high-tech-enterprise-application-drafting',
      'high-tech-enterprise-preassessment',
      'enterprise-profile',
      'policy-retrieval',
      'evidence-ledger',
      'consistency-check',
    ]) {
      await postTool(ctx, execution('skill', true, agent, { name: skill }), {
        isError: false,
        value: { name: skill },
        content: [{ type: 'text', text: skill }],
      })
    }
    const pendingSection = '资料待核验'.repeat(80)
    const candidate = [
      '高企申请书草稿，当前政策原文待核验，不作为正式结论。',
      `知识产权对企业竞争力的作用：${pendingSection}`,
      `科技成果转化情况：${pendingSection}`,
      `研究开发与技术创新组织管理情况：${pendingSection}`,
      `管理与科技人员情况：${pendingSection}`,
    ].join('\n')
    const result = await ctx.tools.execute({
      callId: ToolCallId('policy-draft-chat-preflight'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'application-drafting',
        deliveryMode: 'chat',
        candidateText: candidate,
        artifactFormat: 'docx',
        evidence: [
          { id: 'PENDING-POLICY', kind: 'official-policy', status: 'pending', source: '当期政策待核验', values: [] },
          { id: 'PENDING-IP', kind: 'intellectual-property', status: 'pending', source: '知识产权材料待补', values: [] },
          { id: 'PENDING-FILE', kind: 'customer-file', status: 'pending', source: '企业资料待补', values: [] },
          { id: 'PENDING-PERSONNEL', kind: 'personnel', status: 'pending', source: '人员资料待补', values: [] },
        ],
      },
      agent,
      signal: new AbortController().signal,
    })
    const serialized = JSON.stringify(result)
    expect(serialized).toContain('"status":"draft"')
    expect(serialized).not.toContain('repairable')
    expect(serialized).toContain('生成本次指定格式的文件')
    expect(await preStep(ctx, agent, [], 1, 2)).toMatchObject({ kind: 'enter' })
  })

  it('lets any exhausted file preflight continue to one marked draft artifact instead of losing the file', async () => {
    const ctx = await policyContext()
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-bounded-draft-preflight-'))
    const agent = fakeAgent('deepseek-official', [], undefined, root)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成项目可行性报告并生成 DOCX 文件。' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const arguments_ = {
      taskType: 'feasibility-report',
      deliveryMode: 'chat' as const,
      candidateText: '总体结论：现有内容不足，仍有资料待核验。',
      evidence: [],
    }
    const first = await ctx.tools.execute({
      callId: ToolCallId('bounded-draft-chat-first'),
      name: 'gongchuang_professional_validate',
      arguments: arguments_,
      agent,
      signal: new AbortController().signal,
    })
    expect(JSON.stringify(first)).toContain('repairable')

    const second = await ctx.tools.execute({
      callId: ToolCallId('bounded-draft-chat-second'),
      name: 'gongchuang_professional_validate',
      arguments: arguments_,
      agent,
      signal: new AbortController().signal,
    })
    const serialized = JSON.stringify(second)
    expect(serialized).toContain('"status":"draft"')
    expect(serialized).toContain('生成本次指定格式的文件')
    expect(serialized).toContain('不要再次提交 chat 校验')
    expect(serialized).toContain('下一个且仅一个 run_code')
    expect(await preStep(ctx, agent, [], 1, 3)).toMatchObject({ kind: 'enter' })
  })

  it('carries only attested chat evidence into a workspace-relative terminal draft artifact', async () => {
    const ctx = await policyContext()
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-draft-ledger-'))
    const agent = fakeAgent('deepseek-official', [], undefined, root)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成项目可行性报告并生成 DOCX 文件。' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const sourceCallId = await captureEvidence(
      ctx, agent, '主管部门当期通知：https://example.gov.cn/current', 'draft-ledger-source',
    )
    const candidateText = '总体结论：现有内容不足，仍有资料待核验。'
    const validationArguments = {
      taskType: 'feasibility-report',
      deliveryMode: 'chat' as const,
      candidateText,
      evidence: [{
        id: 'P1', kind: 'official-policy', status: 'verified' as const, source: '主管部门当期通知',
        toolCallId: sourceCallId, sourceUrl: 'https://example.gov.cn/current',
      }],
    }
    const first = await ctx.tools.execute({
      callId: ToolCallId('draft-ledger-chat-first'),
      name: 'gongchuang_professional_validate',
      arguments: validationArguments,
      agent,
      signal: new AbortController().signal,
    })
    expect(first.value).toMatchObject({ status: 'repairable' })
    const second = await ctx.tools.execute({
      callId: ToolCallId('draft-ledger-chat-second'),
      name: 'gongchuang_professional_validate',
      arguments: validationArguments,
      agent,
      signal: new AbortController().signal,
    })
    expect(second.value).toMatchObject({ status: 'draft', evidenceIds: ['P1'] })

    const relativeArtifactPath = 'report.html'
    writeFileSync(join(root, relativeArtifactPath), `<!doctype html><html><body>${candidateText}</body></html>`)
    const artifact = await ctx.tools.execute({
      callId: ToolCallId('draft-ledger-artifact'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report',
        deliveryMode: 'artifact',
        artifactPath: relativeArtifactPath,
        artifactFormat: 'html',
      },
      agent,
      signal: new AbortController().signal,
    })
    const serialized = JSON.stringify(artifact)
    expect(artifact.isError).toBe(false)
    expect(artifact.value).toMatchObject({ status: 'draft', evidenceIds: ['P1'] })
    expect(serialized).not.toContain('artifact 专业校验缺少 evidence')
    const draftPath = (artifact.value as { artifactPath: string }).artifactPath
    expect(dirname(draftPath)).toBe(realpathSync(root))
    expect(existsSync(draftPath)).toBe(true)
  })

  it('does not checkpoint rejected chat evidence for the artifact phase', async () => {
    const ctx = await policyContext()
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-rejected-draft-ledger-'))
    const agent = fakeAgent('deepseek-official', [], undefined, root)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成项目可行性报告并生成 DOCX 文件。' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const arguments_ = {
      taskType: 'feasibility-report',
      deliveryMode: 'chat' as const,
      candidateText: '总体结论：现有内容不足，仍有资料待核验。',
      evidence: [{
        id: 'P1', kind: 'official-policy', status: 'verified' as const, source: '不存在的来源',
        toolCallId: 'missing-source-call', sourceUrl: 'https://example.gov.cn/current',
      }],
    }
    for (const callId of ['rejected-ledger-chat-first', 'rejected-ledger-chat-second']) {
      await ctx.tools.execute({
        callId: ToolCallId(callId),
        name: 'gongchuang_professional_validate',
        arguments: arguments_,
        agent,
        signal: new AbortController().signal,
      })
    }
    writeFileSync(join(root, 'report.html'), '<!doctype html><html><body>待核验</body></html>')
    const artifact = await ctx.tools.execute({
      callId: ToolCallId('rejected-ledger-artifact'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report', deliveryMode: 'artifact', artifactPath: 'report.html',
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(JSON.stringify(artifact)).toContain('artifact 专业校验缺少 evidence')
  })

  it('closes an unused repair window after one model step and blocks renewed discovery', async () => {
    const ctx = await policyContext()
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-expired-repair-'))
    const agent = fakeAgent('deepseek-official', [], undefined, root)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成项目可行性报告并生成正式文件' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const source = join(root, 'report-data.json')
    writeFileSync(source, '{"status":"draft"}')
    await postTool(ctx, execution('write', true, agent, {
      file_path: source,
      content: '{"status":"draft"}',
    }, 'repair-source-write'), {
      isError: false,
      value: { path: source },
      content: [{ type: 'text', text: 'written' }],
    })
    const trustedInput = join(root, 'customer-input.md')
    writeFileSync(trustedInput, '客户原始输入')
    await captureEvidence(ctx, agent, '客户原始输入', 'repair-trusted-input', 'read', {
      file_path: trustedInput,
    })
    const trustedImage = join(root, 'customer-image.png')
    writeFileSync(trustedImage, 'synthetic image fixture')
    await captureEvidence(ctx, agent, '客户图片读取结果', 'repair-trusted-image', 'read_image', {
      file_path: trustedImage,
    })
    const outsideRoot = mkdtempSync(join(tmpdir(), 'gongchuang-repair-outside-'))
    const outsideInput = join(outsideRoot, 'outside-input.md')
    writeFileSync(outsideInput, '工作区外输入')
    await captureEvidence(ctx, agent, '工作区外输入', 'repair-outside-input', 'read', {
      file_path: outsideInput,
    })
    const untrackedSource = join(root, 'other-data.json')
    writeFileSync(untrackedSource, '{}')
    const artifact = join(root, '可行性报告.html')
    writeFileSync(artifact, '<!doctype html><html><body>内容不足但必须有限结束。</body></html>')
    const first = await ctx.tools.execute({
      callId: ToolCallId('expired-repair-validation'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report',
        deliveryMode: 'artifact',
        artifactPath: artifact,
        artifactFormat: 'html',
        deliveryProfileId: 'project-feasibility-analysis-report',
        evidence: [],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(JSON.stringify(first)).toContain('repairable')

    const repairStep = await preStep(ctx, agent, [], 1, 2)
    expect(JSON.stringify(repairStep)).toContain('专业修正窗口已限为一步')
    expect(JSON.stringify(repairStep)).toContain('签名技能参考文件不是客户文件')
    expect(JSON.stringify(repairStep)).toContain('kind=official-policy、status=verified')
    expect(JSON.stringify(repairStep)).toContain('原调用省略则继续省略')
    await expect(preTool(ctx, execution('read', true, agent, { path: artifact }, 'repair-read')))
      .resolves.toEqual({ kind: 'allow' })
    await expect(preTool(ctx, execution('read', true, agent, { file_path: artifact }, 'repair-sdk-read')))
      .resolves.toEqual({ kind: 'allow' })
    await expect(preTool(ctx, execution('read', true, agent, { file_path: source }, 'repair-source-read')))
      .resolves.toEqual({ kind: 'allow' })
    await expect(preTool(ctx, execution('read', true, agent, {
      file_path: trustedInput,
    }, 'repair-trusted-input-reread'))).resolves.toEqual({ kind: 'allow' })
    await expect(preTool(ctx, execution('read_image', true, agent, {
      file_path: trustedImage,
    }, 'repair-trusted-image-reread'))).resolves.toEqual({ kind: 'allow' })
    const outsideRead = await preTool(
      ctx,
      execution('read', true, agent, { file_path: outsideInput }, 'repair-outside-source'),
    )
    expect(outsideRead).toMatchObject({ kind: 'deny' })
    expect(JSON.stringify(outsideRead)).toContain('受信任读取回执')
    const untrackedRead = await preTool(
      ctx,
      execution('read', true, agent, { file_path: untrackedSource }, 'repair-untracked-source'),
    )
    expect(untrackedRead).toMatchObject({ kind: 'deny' })
    expect(JSON.stringify(untrackedRead)).toContain('已成功写入')
    const otherRead = await preTool(
      ctx,
      execution('read', true, agent, { path: `${artifact}.other` }, 'repair-other-read'),
    )
    expect(otherRead).toMatchObject({ kind: 'deny' })
    expect(JSON.stringify(otherRead)).toContain('只允许重读')
    const directoryList = await preTool(
      ctx,
      execution('bash', true, agent, { command: 'ls -la' }, 'repair-list'),
    )
    expect(directoryList).toMatchObject({ kind: 'deny' })
    expect(JSON.stringify(directoryList)).toContain('不得列目录')
    await expect(preTool(ctx, execution('bash', true, agent, {
      command: 'python3 scripts/generate_report_html.py report-data.json report.html',
    }, 'repair-generate'))).resolves.toEqual({ kind: 'allow' })

    expect(await preStep(ctx, agent, [], 1, 3)).toEqual({ kind: 'reject' })
    const outcome = agent.session.snapshotEvents().findLast(event => event.type === 'user/message'
      && event.data.source?.kind === 'plugin' && event.data.source.plugin === 'gongchuang-policy-gate'
      && 'delivery' in event.data.source)
    expect(outcome?.data).toMatchObject({ source: { delivery: { phase: 'draft' } } })
    expect(JSON.stringify(outcome)).toContain('/可行性报告.html')
    expect(JSON.stringify(outcome)).toContain('待完善')
    expect(JSON.stringify(outcome)).toContain('交付画像')
  })

  it('allows one same-file reread after a stale repair write, then closes on repetition', async () => {
    const ctx = await policyContext()
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-repair-stale-write-'))
    const agent = fakeAgent('deepseek-official', [], undefined, root)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成项目可行性报告并生成正式文件' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const draft = join(root, 'report-draft.md')
    writeFileSync(draft, '内容不足')
    await postTool(ctx, execution('write', true, agent, {
      file_path: draft,
      content: '内容不足',
    }, 'stale-repair-source-write'), {
      isError: false,
      value: { path: draft },
      content: [{ type: 'text', text: 'written' }],
    })
    const validation = await ctx.tools.execute({
      callId: ToolCallId('stale-repair-validation'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report',
        deliveryMode: 'chat',
        candidateText: '内容不足',
        evidence: [],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(JSON.stringify(validation)).toContain('repairable')
    expect(JSON.stringify(await preStep(ctx, agent, [], 1, 2))).toContain('专业修正窗口已限为一步')

    const firstFailure = await postTool(ctx, execution('write', true, agent, {
      file_path: draft,
      content: '修正后的内容',
    }, 'stale-repair-write-1'), {
      isError: true,
      error: {
        message: `cannot write "${draft}": file changed since it was read`,
        info: { name: 'HarnessError', code: 'FS_STALE_VERSION' },
      },
      content: [{ type: 'text', text: 'file changed since it was read' }],
    })
    expect(JSON.stringify(firstFailure.additionalContexts)).toContain('仅开放一次同路径重读续写')
    const mechanicalRetry = await preStep(ctx, agent, [], 1, 3)
    expect(JSON.stringify(mechanicalRetry)).toContain('文件并发保护仅续写一次')
    expect(JSON.stringify(mechanicalRetry)).toContain(draft)
    await expect(preTool(ctx, execution('read', true, agent, { file_path: draft }, 'stale-repair-reread')))
      .resolves.toEqual({ kind: 'allow' })

    await postTool(ctx, execution('edit', true, agent, {
      file_path: draft,
      old_string: '内容不足',
      new_string: '修正后的内容',
    }, 'stale-repair-write-2'), {
      isError: true,
      error: {
        message: `cannot edit "${draft}": file changed since it was read`,
        info: { name: 'HarnessError', code: 'FS_STALE_VERSION' },
      },
      content: [{ type: 'text', text: 'file changed since it was read' }],
    })
    expect(await preStep(ctx, agent, [], 1, 4)).toEqual({ kind: 'reject' })
  })

  it('blocks filesystem rediscovery when the user already supplied one exact professional input path', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请进行财务核验，仅处理 GC-QA-SKILL-CASES/inputs/finance.csv，不读取同目录其他案例。' }],
      source: { kind: 'user' },
    }])
    const globDecision = await preTool(ctx, execution('glob', true, agent, { pattern: '**/*' }, 'known-path-glob'))
    expect(globDecision).toMatchObject({ kind: 'deny' })
    expect(JSON.stringify(globDecision)).toContain('精确输入文件路径')
    const listDecision = await preTool(ctx, execution('bash', true, agent, { command: 'ls -la' }, 'known-path-list'))
    expect(listDecision).toMatchObject({ kind: 'deny' })
    expect(JSON.stringify(listDecision)).toContain('Base directory')
    await expect(preTool(ctx, execution('read', true, agent, {
      file_path: 'GC-QA-SKILL-CASES/inputs/finance.csv',
    }, 'known-path-read'))).resolves.toEqual({ kind: 'allow' })
  })

  it('still permits discovery when the user explicitly requests a batch file set', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请进行财务核验，批量处理 inputs 目录下所有 .csv 文件。' }],
      source: { kind: 'user' },
    }])
    await expect(preTool(ctx, execution('glob', true, agent, { pattern: 'inputs/*.csv' }, 'batch-path-glob')))
      .resolves.toEqual({ kind: 'allow' })
  })

  it('keeps running when the one repair step resubmits a formal candidate', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请分析这个项目可行性并给出总体结论' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const validate = (id: string, candidateText: string) => ctx.tools.execute({
      callId: ToolCallId(id),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report',
        deliveryMode: 'chat',
        candidateText,
        evidence: [{
          id: 'E1', kind: 'customer-file', status: 'pending', source: '企业资料待补', values: [],
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(JSON.stringify(await validate('repair-then-formal-1', '内容不足'))).toContain('repairable')
    expect(JSON.stringify(await preStep(ctx, agent, [], 1, 2))).toContain('专业修正窗口已限为一步')
    expect(JSON.stringify(await validate(
      'repair-then-formal-2',
      '总体结论：现有资料仍待核验，当前仅能形成方向性判断，不能扩大为正式资格结论。后续应补齐企业材料与当期政策原文后再作决定。',
    ))).toContain('"status":"formal"')
    expect(await preStep(ctx, agent, [], 1, 3)).toMatchObject({ kind: 'enter' })
  })

  it('stops requests after chat validation reaches draft and exposes diagnostics without a file', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成项目可行性分析报告' }], source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false, value: { name: 'project-feasibility' }, content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const validate = (id: string) => ctx.tools.execute({
      callId: ToolCallId(id), name: 'gongchuang_professional_validate', agent,
      arguments: { taskType: 'feasibility-report', deliveryMode: 'chat', candidateText: '未完成正文', evidence: [] },
      signal: new AbortController().signal,
    })
    expect(JSON.stringify(await validate('chat-first'))).toContain('repairable')
    expect(await preStep(ctx, agent, [], 1, 2)).toMatchObject({ kind: 'enter' })
    expect(JSON.stringify(await validate('chat-second'))).toContain('"status":"draft"')
    expect(await preStep(ctx, agent, [], 1, 3)).toEqual({ kind: 'reject' })
    expect(await preStep(ctx, agent, [], 1, 4)).toEqual({ kind: 'reject' })
    const notices = agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source?.kind === 'plugin' && 'delivery' in event.data.source)
    expect(notices).toHaveLength(1)
    expect(JSON.stringify(notices)).toContain('当前结果不能作为正式交付使用')
    expect(JSON.stringify(notices)).toContain('"phase":"draft","files":[],"issues":[')
    expect(notices[0]?.data).toMatchObject({ source: { delivery: { draftText: '未完成正文' } } })
    const stopped = new AbortController()
    stopped.abort()
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: stopped.signal })
    expect(await preStep(ctx, agent, [{ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }], 2))
      .toMatchObject({ kind: 'enter' })
    expect(JSON.stringify(await validate('chat-user-revision'))).toContain('repairable')
  })

  it('binds a high-tech drafting request to the current skill dependency chain', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    const decision = await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请撰写高企申请书的企业创新能力四栏' }],
      source: { kind: 'user' },
    }])
    expect(JSON.stringify(decision)).toContain('洞见专业执行链已锁定')
    expect(JSON.stringify(decision)).toContain('high-tech-enterprise-application-drafting')
    expect(JSON.stringify(decision)).toContain('consistency-check')

    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    const blocked = JSON.stringify(steering[0])
    expect(blocked).toContain('high-tech-enterprise-application-drafting')
    expect(blocked).toContain('high-tech-enterprise-preassessment')
    expect(blocked).toContain('enterprise-profile')
    expect(blocked).toContain('policy-retrieval')
    expect(blocked).toContain('evidence-ledger')
  })

  it('names signed delivery profile ids without model-side discovery', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请处理这份企业报告' }],
      source: { kind: 'user' },
    }])
    const decision = await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const notice = JSON.stringify(decision.additionalContexts)
    expect(notice).toContain('project-feasibility-analysis-report')
    expect(notice).toContain('deliveryProfileId')
    expect(notice).toContain('必备章节（按顺序）：项目版本与窗口 → 总体结论 → 逐项补强计划')
    expect(notice).toContain('必备表格：补强任务表[列：补强动作、完成标准；至少 1 行正文数据]')
    expect(notice).toContain('允许格式：docx、html、pdf')
    expect(notice).toContain('附加要求：来源追溯、证据台账、政策选择链')
  })

  it('tells skills without their own delivery profile to omit the profile id', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请做财务核验并生成 Word 文件' }],
      source: { kind: 'user' },
    }])
    const decision = await postTool(ctx, execution('skill', true, agent, { name: 'financial-verification' }), {
      isError: false,
      value: { name: 'financial-verification' },
      content: [{ type: 'text', text: 'financial-verification' }],
    })
    expect(JSON.stringify(decision.additionalContexts)).toContain('financial-verification 没有自有签名交付画像')
    expect(JSON.stringify(decision.additionalContexts)).toContain('省略 deliveryProfileId')
  })

  it('rejects a high-tech answer after every skill loaded when the fixed four-section order drifted', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请撰写高企申请书的企业创新能力四栏' }],
      source: { kind: 'user' },
    }])
    for (const skill of [
      'high-tech-enterprise-application-drafting',
      'high-tech-enterprise-preassessment',
      'enterprise-profile',
      'policy-retrieval',
      'evidence-ledger',
      'consistency-check',
    ]) {
      const exec = execution('skill', true, agent, { name: skill })
      await postTool(ctx, exec, {
        isError: false,
        value: { name: skill },
        content: [{ type: 'text', text: skill }],
      })
    }
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{
          type: 'text',
          text: [
            '管理与科技人员情况',
            '研究开发与技术创新组织管理情况',
            '科技成果转化情况',
            '知识产权对企业竞争力的作用',
          ].join('\n'),
        }],
        source: { provider: 'deepseek-official', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })

    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    const blocked = JSON.stringify(steering[0])
    expect(blocked).toContain('专业输出缺少强制结构')
    expect(blocked).toContain('科技成果转化情况')
    expect(blocked).toContain('顺序错误')
    expect(blocked).not.toContain('预评估专属结构')
  })

  it('requires the humanizer and consistency gate together instead of allowing free-form rewriting', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('custom-api', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请给这份政府项目材料去AI味' }],
      source: { kind: 'user' },
    }])
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    const blocked = JSON.stringify(steering[0])
    expect(blocked).toContain('gongchuang-humanizer-zh')
    expect(blocked).toContain('consistency-check')
    expect(blocked).toContain('evidence-ledger')
  })

  it('locks a long humanizer source to the exact trusted local-read receipt without model text copying', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('custom-api')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请给这份政府项目材料去AI味' }],
      source: { kind: 'user' },
    }])
    for (const skill of ['gongchuang-humanizer-zh', 'evidence-ledger', 'consistency-check']) {
      await postTool(ctx, execution('skill', true, agent, { name: skill }), {
        isError: false,
        value: { name: skill },
        content: [{ type: 'text', text: skill }],
      })
    }
    const source = '洞见黄金样例制造有限公司在2026年拥有专利ZL202610000001.0，营业收入为1000万元。'
    const sourceToolCallId = await captureEvidence(
      ctx,
      agent,
      source,
      'humanizer-local-read',
      'read',
      { path: '/workspace/customer.md' },
    )
    const validation = await ctx.tools.execute({
      callId: ToolCallId('humanizer-receipt-source'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'humanizer',
        deliveryMode: 'chat',
        candidateText: '2026年，洞见黄金样例制造有限公司营业收入达到1000万元，并拥有专利ZL202610000001.0。',
        sourceToolCallId,
        evidence: [{
          id: 'CUSTOMER-1',
          kind: 'customer-file',
          status: 'user-provided',
          source: '客户资料',
          toolCallId: sourceToolCallId,
          values: ['洞见黄金样例制造有限公司', '2026年', 'ZL202610000001.0', '1000万元'],
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(validation.isError).toBe(false)

    const remoteReceipt = await captureEvidence(
      ctx,
      agent,
      source,
      'humanizer-remote-fetch',
      'web_fetch',
      { url: 'https://example.gov.cn/source' },
    )
    const rejected = await ctx.tools.execute({
      callId: ToolCallId('humanizer-remote-source'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'humanizer',
        deliveryMode: 'chat',
        candidateText: source,
        sourceToolCallId: remoteReceipt,
        evidence: [],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(rejected.isError).toBe(false)
    expect(JSON.stringify(rejected)).toContain('repairable')
    expect(JSON.stringify(rejected)).toContain('必须来自本轮成功的 read 或 read_image')
  })

  it('does not reuse professional skill activation from an earlier turn', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    const prompt = {
      content: [{ type: 'text' as const, text: '请撰写高企申请书的企业创新能力四栏' }],
      source: { kind: 'user' as const },
    }
    await preStep(ctx, agent, [prompt], 1, 1)
    for (const skill of [
      'high-tech-enterprise-application-drafting',
      'high-tech-enterprise-preassessment',
      'enterprise-profile',
      'policy-retrieval',
      'evidence-ledger',
      'consistency-check',
    ]) {
      const exec = execution('skill', true, agent, { name: skill })
      await postTool(ctx, exec, {
        isError: false,
        value: { name: skill },
        content: [{ type: 'text', text: skill }],
      })
    }

    await preStep(ctx, agent, [prompt], 2, 1)
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 2,
      signal: new AbortController().signal,
    })
    const blocked = JSON.stringify(steering.at(-1))
    expect(blocked).toContain(`尚未激活 V${GONGCHUANG_SKILL_BUNDLE_VERSION} 必需技能`)
    expect(blocked).toContain('high-tech-enterprise-application-drafting')
    expect(blocked).toContain('consistency-check')
  })

  it('requires a quality-gate skill to run after the writing transformation', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('custom-api', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请给这份政府项目材料去AI味' }],
      source: { kind: 'user' },
    }])
    for (const skill of ['consistency-check', 'evidence-ledger', 'gongchuang-humanizer-zh']) {
      const exec = execution('skill', true, agent, { name: skill })
      await postTool(ctx, exec, {
        isError: false,
        value: { name: skill },
        content: [{ type: 'text', text: skill }],
      })
    }
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(JSON.stringify(steering.at(-1))).toContain('质量门禁执行顺序错误')

    const rerun = execution('skill', true, agent, { name: 'consistency-check' })
    await postTool(ctx, rerun, {
      isError: false,
      value: { name: 'consistency-check' },
      content: [{ type: 'text', text: 'consistency-check' }],
    })
    const candidate = '原文中的企业名称、政策标题、数字和知识产权编号均保持不变；本次仅调整句式、段落节奏和衔接方式，使表达更自然。'
    await settleProfessionalCandidate(ctx, agent, candidate)
    steering.length = 0
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(steering).toEqual([])
  })

  it('blocks a generic business answer until the router activates a specific professional skill', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请分析这个政府项目并给出申报建议' }],
      source: { kind: 'user' },
    }])
    const router = execution('skill', true, agent, { name: 'project-task-router' })
    await postTool(ctx, router, {
      isError: false,
      value: { name: 'project-task-router' },
      content: [{ type: 'text', text: 'project-task-router' }],
    })
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(JSON.stringify(steering.at(-1))).toContain('禁止回退为通用模型回答')

    const domain = execution('skill', true, agent, { name: 'project-feasibility' })
    await postTool(ctx, domain, {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const candidate = '总体结论：该任务已由项目总路由交给项目可行性专业技能处理；当前只确认执行路径，具体条件仍须依据政策原文与企业证据核验。'
    const validation = await ctx.tools.execute({
      callId: ToolCallId('professional-validation'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'general',
        deliveryMode: 'chat',
        candidateText: candidate,
        evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '当前任务输入' }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(validation.isError).toBe(false)
    appendAssistant(agent, candidate)
    steering.length = 0
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(steering).toEqual([])
  })

  it('rejects model-invented verified evidence until it is bound to a successful trusted tool call', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请分析这个政府项目并给出申报建议' }],
      source: { kind: 'user' },
    }])
    for (const skillName of ['project-task-router', 'project-feasibility']) {
      await postTool(ctx, execution('skill', true, agent, { name: skillName }), {
        isError: false,
        value: { name: skillName },
        content: [{ type: 'text', text: skillName }],
      })
    }
    const candidate = '总体结论：当前只能依据已取得的主管部门原文继续核验，证据不足部分保持待核验，不能直接作出符合全部条件的判断。'
    const forged = await ctx.tools.execute({
      callId: ToolCallId('forged-evidence'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'policy', deliveryMode: 'chat', candidateText: candidate,
        evidence: [{
          id: 'P1', kind: 'official-policy', status: 'verified', source: '模型声称的原文',
          sourceUrl: 'https://example.gov.cn/current', sha256: 'a'.repeat(64),
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(forged.isError).toBe(false)
    expect(JSON.stringify(forged)).toContain('repairable')
    expect(JSON.stringify(forged)).toContain('无法根据 sourceUrl、values 或 source 自动绑定')
    // 直接工具模式只把 render 文本送回模型，诊断不能只藏在
    // 结构化 value 里，否则模型只知道“有缺口”却只能猜测修复。
    expect(JSON.stringify(forged.content)).toContain('无法根据 sourceUrl、values 或 source 自动绑定')

    const toolCallId = await captureEvidence(
      ctx, agent, '主管部门原文：https://example.gov.cn/current', 'verified-policy-call',
    )
    const autoAttested = await ctx.tools.execute({
      callId: ToolCallId('auto-attested-evidence'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'policy', deliveryMode: 'chat', candidateText: candidate,
        evidence: [{
          id: 'P1', kind: 'official-policy', status: 'verified', source: '主管部门原文',
          sourceUrl: 'https://example.gov.cn/current',
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(autoAttested.isError).toBe(false)

    const attested = await ctx.tools.execute({
      callId: ToolCallId('attested-evidence'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'policy', deliveryMode: 'chat', candidateText: candidate,
        evidence: [{
          id: 'P1', kind: 'official-policy', status: 'verified', source: '主管部门原文',
          sourceUrl: 'https://example.gov.cn/current', toolCallId,
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(attested.isError).toBe(false)
  })

  it('binds a verified source URL from the real web_fetch invocation while facts still come from the result body', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请分析这个政府项目并给出申报建议' }],
      source: { kind: 'user' },
    }])
    for (const skillName of ['project-task-router', 'project-feasibility']) {
      await postTool(ctx, execution('skill', true, agent, { name: skillName }), {
        isError: false,
        value: { name: skillName },
        content: [{ type: 'text', text: skillName }],
      })
    }
    await captureEvidence(
      ctx,
      agent,
      '主管部门现行原文确认了申报范围，其他条件仍须按企业材料核验。',
      'web-fetch-with-url',
      'web_fetch',
      { url: 'https://example.gov.cn/current' },
    )
    const validation = await ctx.tools.execute({
      callId: ToolCallId('url-invocation-attested'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'policy', deliveryMode: 'chat',
        candidateText: '总体结论：主管部门现行原文已确认申报范围；其他条件仍须依据企业材料继续核验，当前不作无证据推断。',
        evidence: [{
          id: 'P1', kind: 'official-policy', status: 'verified', source: '主管部门现行原文',
          sourceUrl: 'https://example.gov.cn/current', values: ['申报范围'],
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(validation.isError).toBe(false)
  })

  it('binds a verbatim intermediate-file excerpt without comparing its display source label to the path', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请分析企业技术材料，只输出修改文案' }], source: { kind: 'user' },
    }])
    const source = '682: （1）通过外层触发介质浓度调整启动周期（3-12个月可调），使用时性能稳定、废弃后可按环境条件启动降解；'
    const readId = await captureEvidence(ctx, agent, source, 'rd-extract-read', 'read', { file_path: '/qa/_rd_extract.txt' })
    const exec = execution('gongchuang_professional_validate', true, agent)
    const evidence = {
      id: 'e5', kind: 'customer-file', status: 'user-provided' as const, source: '合成申请书.docx',
      toolCallId: readId, values: ['使用时性能稳定、废弃后可按环境条件启动降解'],
    }
    // 行号和末尾分号不阻止逐字子串匹配；显示来源名称不冒充原文档的自动提取血缘。
    expect(ctx.gongchuangPolicy.attestEvidence(exec, [evidence])[0]?.toolCallId).toBe(readId)
    expect(() => ctx.gongchuangPolicy.attestEvidence(exec, [{
      ...evidence, values: ['(3-12个月可调)'],
    }])).toThrow(/取值未出现在绑定来源中/u)
    expect(ctx.gongchuangPolicy.attestEvidence(exec, [{
      ...evidence, values: ['（3-12个月可调）'],
    }])[0]?.toolCallId).toBe(readId)
  })

  it('uses the exact read filename to disambiguate duplicate customer values', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请用 quality-brand-projects 核验客户文件。' }],
      source: { kind: 'user' },
    }])
    const companyRead = await captureEvidence(
      ctx,
      agent,
      'GC-QA 晨光检测技术有限公司',
      'company-facts-read',
      'read',
      { file_path: '/qa/company-facts.md' },
    )
    await captureEvidence(
      ctx,
      agent,
      'GC-QA 晨光检测技术有限公司',
      'ip-register-read',
      'read',
      { file_path: '/qa/ip-register.csv' },
    )
    const bound = ctx.gongchuangPolicy.attestEvidence(
      execution('gongchuang_professional_validate', true, agent),
      [{
        id: 'E9',
        kind: 'customer-file',
        status: 'user-provided',
        source: 'company-facts.md',
        values: ['GC-QA 晨光检测技术有限公司'],
      }],
    )
    expect(bound[0]?.toolCallId).toBe(companyRead)
  })

  it('treats repeated reads of the same path and content as one logical evidence source', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请用 quality-brand-projects 核验客户文件。' }],
      source: { kind: 'user' },
    }])
    const text = 'GC-QA 晨光检测技术有限公司主营产品为工业检测模块。'
    await captureEvidence(ctx, agent, text, 'same-source-first', 'read', {
      file_path: '/qa/company-facts.md',
    })
    const latestRead = await captureEvidence(ctx, agent, text, 'same-source-second', 'read', {
      file_path: '/qa/company-facts.md',
    })
    const bound = ctx.gongchuangPolicy.attestEvidence(
      execution('gongchuang_professional_validate', true, agent),
      [{
        id: 'E1', kind: 'customer-file', status: 'user-provided', source: 'company-facts.md',
        values: ['工业检测模块'],
      }],
    )
    expect(bound[0]?.toolCallId).toBe(latestRead)
  })

  it('accepts harmless sentence-punctuation differences without relaxing words or numbers', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请用 quality-brand-projects 核验客户文件。' }],
      source: { kind: 'user' },
    }])
    const readCallId = await captureEvidence(
      ctx,
      agent,
      'ISO9001有效期、环保、安全、违法风险、工商股权、客户名单、实际政策与当期通知均未提供；不得据此声称不存在风险。',
      'company-facts-punctuation-read',
      'read',
      { file_path: '/qa/company-facts.md' },
    )
    const exec = execution('gongchuang_professional_validate', true, agent)
    const bound = ctx.gongchuangPolicy.attestEvidence(exec, [{
      id: 'E9', kind: 'customer-file', status: 'user-provided', source: 'company-facts.md',
      values: ['ISO9001有效期、环保、安全、违法风险、工商股权、客户名单、实际政策与当期通知均未提供。'],
    }])
    expect(bound[0]?.toolCallId).toBe(readCallId)
    const internalPunctuation = ctx.gongchuangPolicy.attestEvidence(exec, [{
      id: 'E10', kind: 'customer-file', status: 'user-provided', source: 'company-facts.md',
      values: ['ISO9001有效期、环保、安全、违法风险、工商股权、客户名单，实际政策与当期通知均未提供。'],
    }])
    expect(internalPunctuation[0]?.toolCallId).toBe(readCallId)
    expect(() => ctx.gongchuangPolicy.attestEvidence(exec, [{
      id: 'E11', kind: 'customer-file', status: 'user-provided', source: 'company-facts.md',
      values: ['ISO9001有效期、环保、安全、违法风险、工商股权、客户名单、实际政策与当期通知均已提供。'],
    }])).toThrow(/取值未出现在绑定来源中/u)
  })

  it('uses one exact source path to report the actual mismatched value in a grouped evidence row', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请用 standard-drafting 核验客户文件。' }],
      source: { kind: 'user' },
    }])
    await captureEvidence(
      ctx,
      agent,
      '环境温度为 23 摄氏度，允许偏差 2 摄氏度；人工复核标签由两名检验人员独立确认；结论不一致时由第三名人员复核确定。',
      'standard-source-path-read',
      'read',
      { file_path: '/qa/standard-complete-case.md' },
    )
    expect(() => ctx.gongchuangPolicy.attestEvidence(
      execution('gongchuang_professional_validate', true, agent),
      [{
        id: 'E5', kind: 'customer-file', status: 'user-provided', source: 'standard-complete-case.md',
        values: [
          '环境温度为 23 摄氏度，允许偏差 2 摄氏度',
          '人工复核标签由三名检验人员独立确认',
        ],
      }],
    )).toThrow(/人工复核标签由三名检验人员独立确认/u)
  })

  it('binds customer-file facts to one unique local read receipt and fails closed on mismatch or ambiguity', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请分析这个政府项目并给出申报建议' }],
      source: { kind: 'user' },
    }])
    for (const skillName of ['project-task-router', 'project-feasibility']) {
      await postTool(ctx, execution('skill', true, agent, { name: skillName }), {
        isError: false,
        value: { name: skillName },
        content: [{ type: 'text', text: skillName }],
      })
    }
    const readCallId = await captureEvidence(
      ctx,
      agent,
      '企业名称：洞见黄金样例制造有限公司\n主营产品：工业循环泵智能控制系统',
      'enterprise-profile-read',
      'read',
      { file_path: '/qa/enterprise-profile.md' },
    )
    const candidate = '总体结论：企业主营产品为工业循环泵智能控制系统；该事实来自本轮客户文件，其他结论仍须依据政策原文与公开证据核验。'
    const autoBound = await ctx.tools.execute({
      callId: ToolCallId('customer-file-auto-bound'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'enterprise-profile', deliveryMode: 'chat', candidateText: candidate,
        evidence: [{
          id: 'ENT-1', kind: 'customer-file', status: 'user-provided', source: '企业资料.md',
          values: ['主营产品：工业循环泵智能控制系统'],
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(autoBound.isError).toBe(false)

    const mismatched = await ctx.tools.execute({
      callId: ToolCallId('customer-file-mismatched'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'enterprise-profile', deliveryMode: 'chat', candidateText: candidate,
        evidence: [{
          id: 'ENT-2', kind: 'customer-file', status: 'user-provided', source: '企业资料.md',
          values: ['主营产品：不存在的产品'],
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(mismatched.isError).toBe(false)
    expect(JSON.stringify(mismatched)).toContain('repairable')
    expect(JSON.stringify(mismatched)).toContain('取值未出现在绑定来源中')

    await captureEvidence(
      ctx,
      agent,
      '企业名称：洞见黄金样例制造有限公司\n主营产品：工业循环泵智能控制系统',
      'enterprise-profile-read-copy',
      'read',
      { file_path: '/qa/enterprise-profile-copy.md' },
    )
    const ambiguous = await ctx.tools.execute({
      callId: ToolCallId('customer-file-ambiguous'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'enterprise-profile', deliveryMode: 'chat', candidateText: candidate,
        evidence: [{
          id: 'ENT-3', kind: 'customer-file', status: 'user-provided', source: '企业资料.md',
          values: ['主营产品：工业循环泵智能控制系统'],
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(ambiguous.isError).toBe(false)
    expect(JSON.stringify(ambiguous)).toContain('"status":"draft"')
    expect(JSON.stringify(ambiguous)).toContain('同时匹配多个本轮客户文件读取回执')

    const disambiguated = await ctx.tools.execute({
      callId: ToolCallId('customer-file-disambiguated'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'enterprise-profile', deliveryMode: 'chat', candidateText: candidate,
        evidence: [{
          id: 'ENT-4', kind: 'customer-file', status: 'user-provided', source: '企业资料.md',
          toolCallId: readCallId,
          values: ['主营产品：工业循环泵智能控制系统'],
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(disambiguated.isError).toBe(false)
    expect(JSON.stringify(disambiguated)).toContain('"status":"draft"')
  })

  it('accepts verified government or company-official peer sources and rejects an unqualified web source', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请找同行并形成可比企业分析。' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'peer-benchmarking' }), {
      isError: false,
      value: { name: 'peer-benchmarking' },
      content: [{ type: 'text', text: 'peer-benchmarking' }],
    })
    const candidate = [
      '来源清单：政府公示已核验。',
      '可比性评分：当前仅按公开产品方向比较。',
      '事实对比：企业甲属于本轮可核验样本。',
      '政策口径差异：不同公示用途不能直接等同。',
      '数据缺口：收入、排名和市场份额当前检索层未命中。',
    ].join('\n')

    await captureEvidence(
      ctx,
      agent,
      '政府公示：https://example.gov.cn/list 企业甲',
      'peer-government-source',
    )
    const government = await ctx.tools.execute({
      callId: ToolCallId('peer-government-validation'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'peer', deliveryMode: 'chat', candidateText: candidate,
        evidence: [{
          id: 'PEER-1', kind: 'government-source', status: 'verified', source: '政府公示',
          sourceUrl: 'https://example.gov.cn/list', values: ['企业甲'],
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(government.isError).toBe(false)
    expect(JSON.stringify(government)).toContain('下一条最终消息只能逐字输出本次候选正文')
    expect(JSON.stringify(government)).toContain('不得添加任何前后缀或改动格式')

    await captureEvidence(
      ctx,
      agent,
      '行业网页：https://example.com/list 企业甲',
      'peer-generic-source',
    )
    const generic = await ctx.tools.execute({
      callId: ToolCallId('peer-generic-validation'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'peer', deliveryMode: 'chat', candidateText: candidate,
        evidence: [{
          id: 'PEER-2', kind: 'government-source', status: 'verified', source: '行业网页',
          sourceUrl: 'https://example.com/list', values: ['企业甲'],
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(generic.isError).toBe(false)
    expect(JSON.stringify(generic)).toContain('repairable')
    expect(JSON.stringify(generic)).toContain('同行结论缺少已核验政府来源、官方名单或企业官方来源')
  })

  it('allows pending evidence to describe a dynamic-page gap without pretending its value was verified', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请核验政策官网来源' }],
      source: { kind: 'user' },
    }])
    const receipt = await captureEvidence(
      ctx,
      agent,
      'https://example.gov.cn/dynamic 页面由 JavaScript 动态渲染，当前正文为空。',
      'dynamic-page-call',
    )
    const verifiedReceipt = await captureEvidence(
      ctx,
      agent,
      '政府官网转载已核验：https://example.gov.cn/repost 政策标题：现行申报通知',
      'verified-repost-call',
    )
    const candidate = '政策原文：政府官网转载已经核验；主管部门动态页面已定位，但正文暂无法读取，相关内容保持待核验。'
    const validation = await ctx.tools.execute({
      callId: ToolCallId('pending-dynamic-page'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'policy', deliveryMode: 'chat', candidateText: candidate,
        evidence: [
          {
            id: 'PENDING-1', kind: 'official-policy', status: 'pending', source: '主管部门动态页面',
            sourceUrl: 'https://example.gov.cn/dynamic', toolCallId: receipt,
            values: ['尚未从页面正文核验的政策标题'],
          },
          {
            id: 'VERIFIED-1', kind: 'official-policy', status: 'verified', source: '政府官网转载',
            sourceUrl: 'https://example.gov.cn/repost', toolCallId: verifiedReceipt,
            values: ['现行申报通知'],
          },
        ],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(validation.isError).toBe(false)
  })

  it('injects the opaque trusted evidence receipt into model-visible context', async () => {
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请核验政策官网来源' }],
      source: { kind: 'user' },
    }])
    const decision = await postTool(
      ctx,
      execution('web_fetch', true, agent, {}, 'visible-evidence-call'),
      {
        isError: false,
        value: { url: 'https://example.gov.cn/current' },
        content: [{ type: 'text', text: '主管部门原文：https://example.gov.cn/current；文号 108' }],
      },
    )

    expect(decision.kind).toBe('accept')
    const receiptContext = JSON.stringify(decision.additionalContexts)
    expect(receiptContext).toContain('toolCallId=visible-evidence-call')
    expect(receiptContext).toMatch(/accessedAt=\d{4}-\d{2}-\d{2}T/u)
    expect(receiptContext).not.toMatch(/sha[\s_-]*256|[0-9a-f]{64}/iu)
    expect(receiptContext).toContain('禁止猜测或改写')
    expect(receiptContext).toContain('优先省略 evidence.toolCallId')

    const accessedAt = receiptContext.match(/accessedAt=([^。]+)/u)?.[1]
    expect(accessedAt).toBeDefined()
    await postTool(ctx, execution('skill', true, agent, { name: 'policy-retrieval' }, 'policy-skill-call'), {
      isError: false,
      value: { name: 'policy-retrieval' },
      content: [{ type: 'text', text: 'policy-retrieval' }],
    })
    const candidate = `总体结论：已核验政府官网来源，文号 108。访问时间为 ${accessedAt as string}。证据边界：仅覆盖本轮读取结果。`
    const validation = await ctx.tools.execute({
      callId: ToolCallId('timestamp-bound-validation'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'policy', deliveryMode: 'chat', candidateText: candidate,
        evidence: [{
          id: 'TIME-1', kind: 'official-policy', status: 'verified', source: '主管部门原文',
          sourceUrl: 'https://example.gov.cn/current', toolCallId: 'visible-evidence-call',
          values: ['主管部门原文'],
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(validation.isError).toBe(false)
  })

  it('binds formal validation to the text extracted from the real artifact and rechecks file identity', async () => {
    const ctx = await policyContext()
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-artifact-'))
    const agent = fakeAgent('deepseek-official', [], undefined, root)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成项目可行性分析并生成PDF作为最终文件' }],
      source: { kind: 'user' },
    }])
    const skill = execution('skill', true, agent, { name: 'project-feasibility' })
    await postTool(ctx, skill, {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const artifact = join(root, 'report.html')
    const artifactArgument = 'report.html'
    writeFileSync(artifact, [
      '<!doctype html><html><body>',
      '<h1>项目版本与窗口</h1><p>已依据主管部门当期通知锁定本轮适用口径。</p>',
      '<h1>总体结论</h1><p>当前结论仅覆盖已核验事实，缺失事项保持待核验。</p>',
      '<h1>逐项补强计划</h1><h2>补强任务表</h2>',
      '<table><tr><th>补强动作</th><th>完成标准</th></tr><tr><td>补齐材料</td><td>原文可追溯</td></tr></table>',
      '</body></html>',
    ].join(''))

    const sourceCallId = await captureEvidence(
      ctx, agent, '主管部门当期通知：https://example.gov.cn/current', 'artifact-policy-source',
    )
    // A professional file cannot be exposed as an openable card before the
    // real artifact is bound to the checked candidate.
    const earlyProbe = await ctx.tools.execute({
      callId: ToolCallId('artifact-early-probe'), name: 'gongchuang_artifact_probe',
      arguments: { artifactPath: artifactArgument }, agent, signal: new AbortController().signal,
    })
    expect(earlyProbe.isError).toBe(true)
    expect(JSON.stringify(earlyProbe)).toContain('尚未完成 artifact 专业校验')
    const deliveryNotices = () => agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin' && 'delivery' in event.data.source)
    const noticesBeforeTool = deliveryNotices().length
    const validation = await ctx.tools.execute({
      callId: ToolCallId('artifact-professional-validation'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report',
        deliveryMode: 'artifact',
        candidateText: '模型自行提供的文本不得成为文件正文回执。',
        artifactPath: artifactArgument,
        artifactFormat: 'html',
        deliveryProfileId: 'project-feasibility-analysis-report',
        evidence: [{
          id: 'P1',
          kind: 'official-policy',
          status: 'verified',
          source: '主管部门当期通知',
          toolCallId: sourceCallId,
          sourceUrl: 'https://example.gov.cn/current',
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(validation.isError).toBe(false)
    // The enclosing tool result is not logged yet. A user notice here would
    // break OpenAI-compatible assistant/tool adjacency on the next request.
    expect(deliveryNotices()).toHaveLength(noticesBeforeTool)
    expect(validation.value).toMatchObject({ status: 'formal' })
    expect(validation.value).toMatchObject({ artifactPath: realpathSync(artifact) })
    const projectedValidation = {
      status: (validation.value as { status: string }).status,
      nextStep: (validation.value as { nextStep: string }).nextStep,
      criticalIssues: (validation.value as { criticalIssues: string[] }).criticalIssues,
      advisoryIssues: (validation.value as { advisoryIssues: string[] }).advisoryIssues,
      checks: (validation.value as { checks: string[] }).checks,
      artifactPath: (validation.value as { artifactPath: string }).artifactPath,
    }
    expect(JSON.parse(JSON.stringify(projectedValidation))).toEqual(projectedValidation)
    expect((validation.value as { nextStep: string }).nextStep).toContain('本次结果不代表文件已正式交付')
    expect((validation.value as { nextStep: string }).nextStep).toContain('首次 artifact 校验前不得执行可打开性探测')
    expect(JSON.stringify(validation.content)).not.toContain('下一条最终消息只能逐字输出本次候选正文')
    await preStep(ctx, agent, [], 1, 2)
    expect(deliveryNotices()).toHaveLength(noticesBeforeTool + 1)
    await preStep(ctx, agent, [], 1, 3)
    expect(deliveryNotices()).toHaveLength(noticesBeforeTool + 1)

    const prematurePublish = await preTool(ctx, execution(
      'gongchuang_publish_files', true, agent, { paths: [artifact] }, 'premature-publish',
    ))
    expect(prematurePublish).toMatchObject({ kind: 'deny' })
    expect(prematurePublish.kind === 'deny' ? prematurePublish.reason : '').toContain('gongchuang_artifact_probe')

    for (const name of ['gongchuang_artifact_probe', 'gongchuang_content_audit'] as const) {
      const result = await ctx.tools.execute({
        callId: ToolCallId(name),
        name,
        arguments: { artifactPath: artifactArgument },
        agent,
        signal: new AbortController().signal,
      })
      expect(result.isError).toBe(false)
    }
    const verifiedPublish = await preTool(ctx, execution(
      'gongchuang_publish_files', true, agent, { paths: [artifact] }, 'verified-publish',
    ))
    expect(verifiedPublish.kind).toBe('allow')
    const visual = await ctx.tools.execute({
      callId: ToolCallId('visual-closed'),
      name: 'gongchuang_visual_inspection',
      arguments: { artifactPath: artifactArgument },
      agent,
      signal: new AbortController().signal,
    })
    expect(visual.isError).toBe(true)
    expect(JSON.stringify(visual)).toContain('只接受最终 PDF')
  })

  it('reuses the successful chat evidence checkpoint for artifact validation after restart', async () => {
    const config = signedFixture()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PolicyGate, config)
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-ledger-resume-'))
    const sessionId = `ledger-resume-${randomUUID()}`
    const first = fakeAgent('deepseek-official', [], sessionId, root)
    await preStep(ctx, first, [{
      content: [{ type: 'text', text: '请形成项目可行性报告并生成 HTML 正式文件' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, first, { name: 'project-feasibility' }, 'ledger-skill'), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const artifact = join(root, 'report.html')
    writeFileSync(artifact, [
      '<!doctype html><html><body>',
      '<h1>项目版本与窗口</h1><p>已依据主管部门当期通知锁定本轮适用口径。</p>',
      '<h1>总体结论</h1><p>当前结论仅覆盖已核验事实，缺失事项保持待核验。</p>',
      '<h1>逐项补强计划</h1><h2>补强任务表</h2>',
      '<table><tr><th>补强动作</th><th>完成标准</th></tr><tr><td>补齐材料</td><td>原文可追溯</td></tr></table>',
      '</body></html>',
    ].join(''))
    const sourceCallId = await captureEvidence(
      ctx, first, '主管部门当期通知：https://example.gov.cn/current', 'ledger-policy-source',
    )
    const preflight = await ctx.tools.execute({
      callId: ToolCallId('ledger-chat-preflight'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report',
        deliveryMode: 'chat',
        candidateArtifactPath: 'report.html',
        artifactFormat: 'html',
        deliveryProfileId: 'project-feasibility-analysis-report',
        evidence: [{
          id: 'P1', kind: 'official-policy', status: 'verified', source: '主管部门当期通知',
          toolCallId: sourceCallId, sourceUrl: 'https://example.gov.cn/current',
        }],
      },
      agent: first,
      signal: new AbortController().signal,
    })
    expect(preflight.isError).toBe(false)
    expect(preflight.value).toMatchObject({ status: 'formal', evidenceIds: ['P1'] })

    const interrupted = new AbortController()
    interrupted.abort()
    await agentEvents(ctx, first).serial('agent/turn-stopping', { turn: 1, signal: interrupted.signal })

    const restarted = fakeAgent('deepseek-official', [], sessionId, root)
    const resumed = await preStep(ctx, restarted, [{
      content: [{ type: 'text', text: '继续' }], source: { kind: 'user' },
    }], 2)
    expect(JSON.stringify(resumed)).toContain('已从本地检查点恢复同一专业任务')
    const validation = await ctx.tools.execute({
      callId: ToolCallId('ledger-artifact-validation'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report',
        deliveryMode: 'artifact',
        artifactPath: 'report.html',
        artifactFormat: 'html',
        deliveryProfileId: 'project-feasibility-analysis-report',
      },
      agent: restarted,
      signal: new AbortController().signal,
    })
    expect(validation.isError).toBe(false)
    expect(validation.value).toMatchObject({ status: 'formal', evidenceIds: ['P1'] })
  })

  it('requires evidence when artifact validation has no chat checkpoint', async () => {
    const ctx = await policyContext()
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-ledger-required-'))
    const agent = fakeAgent('deepseek-official', [], undefined, root)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成项目可行性报告并生成 HTML 正式文件' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    writeFileSync(join(root, 'report.html'), '<!doctype html><html><body>报告</body></html>')
    const validation = await ctx.tools.execute({
      callId: ToolCallId('ledger-required-artifact'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report', deliveryMode: 'artifact', artifactPath: 'report.html',
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(validation.isError).toBe(false)
    expect(validation.value).toMatchObject({ status: 'repairable' })
    expect(JSON.stringify(validation)).toContain('没有可复用的成功 chat 预校验检查点')
  })

  it('does not route Office artifacts through PDF automatic visual regression', async () => {
    const ctx = await policyContext({
      inspectPdf: () => Promise.reject(new Error('HTML test must not inspect PDF text')),
      exportPdf: () => Promise.reject(new Error('HTML visual test must not export PDF')),
      renderAndReview: request => Promise.resolve({
        rendererId: 'gongchuang-electron-pymupdf-v2',
        status: 'passed-host-render',
        review: 'automatic-source-preview',
        artifactSha256: request.artifactSha256,
        comparison: {
          reference: 'same-source-print-layout',
          maxChangedPixelRatio: 0.01,
          maxMeanAbsoluteError: 0.001,
          changedPixelRatioTolerance: 0.12,
          meanAbsoluteErrorTolerance: 0.025,
        },
        pages: [
          { page: 1, width: 1440, height: 900, pngSha256: 'a'.repeat(64) },
          { page: 2, width: 1440, height: 900, pngSha256: 'a'.repeat(64) },
        ],
      }),
    })
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成项目可行性分析并生成HTML交付文件' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const artifact = join(mkdtempSync(join(tmpdir(), 'gongchuang-render-')), 'report.html')
    writeFileSync(artifact, [
      '<!doctype html><html><body>',
      '<h1>项目版本与窗口</h1><p>已锁定主管部门当期通知。</p>',
      '<h1>总体结论</h1><p>仅覆盖已核验事实。</p>',
      '<h1>逐项补强计划</h1><h2>补强任务表</h2>',
      '<table><tr><th>补强动作</th><th>完成标准</th></tr><tr><td>补齐材料</td><td>原文可追溯</td></tr></table>',
      '</body></html>',
    ].join(''))
    const sourceCallId = await captureEvidence(
      ctx, agent, '主管部门当期通知：https://example.gov.cn/current', 'render-policy-source',
    )
    const validation = await ctx.tools.execute({
      callId: ToolCallId('render-professional-validation'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report',
        deliveryMode: 'artifact',
        candidateText: '不能信任的模型候选。',
        artifactPath: artifact,
        artifactFormat: 'html',
        deliveryProfileId: 'project-feasibility-analysis-report',
        evidence: [{
          id: 'P1',
          kind: 'official-policy',
          status: 'verified',
          source: '主管部门当期通知',
          toolCallId: sourceCallId,
          sourceUrl: 'https://example.gov.cn/current',
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(validation.isError).toBe(false)
    const visual = await ctx.tools.execute({
      callId: ToolCallId('visual-host-confirmed'),
      name: 'gongchuang_visual_inspection',
      arguments: { artifactPath: artifact },
      agent,
      signal: new AbortController().signal,
    })
    expect(visual.isError).toBe(true)
    expect(JSON.stringify(visual)).toContain('只接受最终 PDF')
  })

  it('binds PDF professional and content receipts to text extracted by the signed host', async () => {
    const extracted = [
      '项目版本与窗口 已依据主管部门当期通知锁定本轮口径。',
      '总体结论 当前结论仅覆盖已核验事实。',
      '逐项补强计划 补强任务表 补强动作 完成标准 补齐材料 原文可追溯。',
    ].join('\n')
    const contentSha256 = createHash('sha256').update(extracted).digest('hex')
    const ctx = await policyContext({
      inspectPdf: request => Promise.resolve({
        rendererId: 'gongchuang-electron-pymupdf-v2',
        status: 'passed-host-pdf-inspection',
        artifactSha256: request.artifactSha256,
        pageCount: 1,
        contentText: extracted,
        contentSha256,
      }),
      exportPdf: () => Promise.reject(new Error('PDF text test must not export PDF')),
      renderAndReview: request => Promise.resolve({
        rendererId: 'gongchuang-electron-pymupdf-v2',
        status: 'passed-host-render',
        review: 'automatic-source-preview',
        artifactSha256: request.artifactSha256,
        comparison: {
          reference: 'same-source-print-layout',
          maxChangedPixelRatio: 0.01,
          maxMeanAbsoluteError: 0.001,
          changedPixelRatioTolerance: 0.12,
          meanAbsoluteErrorTolerance: 0.025,
        },
        pages: [{ page: 1, width: 794, height: 1123, pngSha256: 'a'.repeat(64) }],
      }),
    })
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成项目可行性分析并生成PDF最终文件' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const artifact = join(mkdtempSync(join(tmpdir(), 'gongchuang-pdf-')), 'report.pdf')
    writeFileSync(artifact, '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF\n')
    const sourceCallId = await captureEvidence(
      ctx, agent, '主管部门当期通知：https://example.gov.cn/current', 'pdf-policy-source',
    )
    const validation = await ctx.tools.execute({
      callId: ToolCallId('pdf-professional-validation'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report',
        deliveryMode: 'artifact',
        candidateText: '模型伪造的 PDF 正文不得被采用。',
        artifactPath: artifact,
        artifactFormat: 'pdf',
        deliveryProfileId: 'project-feasibility-analysis-report',
        evidence: [{
          id: 'P1',
          kind: 'official-policy',
          status: 'verified',
          source: '主管部门当期通知',
          toolCallId: sourceCallId,
          sourceUrl: 'https://example.gov.cn/current',
        }],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(validation.isError).toBe(false)
    const audit = await ctx.tools.execute({
      callId: ToolCallId('pdf-content-audit'),
      name: 'gongchuang_content_audit',
      arguments: { artifactPath: artifact },
      agent,
      signal: new AbortController().signal,
    })
    expect(audit.isError).toBe(false)
    expect(audit.value).toMatchObject({ contentSha256, characters: extracted.length })
    const visual = await ctx.tools.execute({
      callId: ToolCallId('pdf-automatic-visual'),
      name: 'gongchuang_visual_inspection',
      arguments: { artifactPath: artifact },
      agent,
      signal: new AbortController().signal,
    })
    expect(visual.isError).toBe(false)
    expect(visual.value).toMatchObject({
      rendererId: 'gongchuang-electron-pymupdf-v2',
      review: 'automatic-source-preview',
      pages: [{ page: 1 }],
    })
  })

  it('exports a PDF from a chat-validated source and requires artifact revalidation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-pdf-export-'))
    const source = join(root, 'report.html')
    const output = join(root, 'report.pdf')
    writeFileSync(source, [
      '<!doctype html><html><body>',
      '<h1>项目版本与窗口</h1><p>已依据主管部门当期通知锁定本轮适用口径。</p>',
      '<h1>总体结论</h1><p>当前结论仅覆盖已核验事实，缺失事项保持待核验。</p>',
      '<h1>逐项补强计划</h1><h2>补强任务表</h2>',
      '<table><tr><th>补强动作</th><th>完成标准</th></tr><tr><td>补齐材料</td><td>原文可追溯</td></tr></table>',
      '</body></html>',
    ].join(''))
    const candidate = PolicyGate.inspectProfessionalArtifact(source).contentText as string
    const contentSha256 = createHash('sha256').update(candidate).digest('hex')
    const ctx = await policyContext({
      inspectPdf: request => Promise.resolve({
        rendererId: 'gongchuang-electron-pymupdf-v2',
        status: 'passed-host-pdf-inspection',
        artifactSha256: request.artifactSha256,
        pageCount: 1,
        contentText: candidate,
        contentSha256,
      }),
      exportPdf: (request) => {
        const bytes = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF\n')
        writeFileSync(request.outputPath, bytes)
        return Promise.resolve({
          rendererId: 'gongchuang-electron-pymupdf-v2',
          status: 'passed-host-pdf-export',
          sourceArtifactSha256: request.sourceArtifactSha256,
          outputPath: request.outputPath,
          outputSha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
        })
      },
      renderAndReview: () => Promise.reject(new Error('PDF export test must not open visual review')),
    })
    const agent = fakeAgent('deepseek-official', [], undefined, root)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成项目可行性分析并生成PDF最终文件' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const sourceCallId = await captureEvidence(
      ctx, agent, '主管部门当期通知：https://example.gov.cn/current', 'export-policy-source',
    )
    const evidence = [{
      id: 'P1',
      kind: 'official-policy',
      status: 'verified',
      source: '主管部门当期通知',
      toolCallId: sourceCallId,
      sourceUrl: 'https://example.gov.cn/current',
    }]
    const preflight = await ctx.tools.execute({
      callId: ToolCallId('pdf-export-preflight'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report',
        deliveryMode: 'chat',
        candidateArtifactPath: 'report.html',
        evidence,
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(preflight.isError).toBe(false)
    expect(preflight.value).toMatchObject({ status: 'formal' })
    expect((preflight.value as { nextStep: string }).nextStep).toContain('请调用 gongchuang_render_pdf')
    expect(JSON.stringify(preflight.content)).not.toContain('下一条最终消息只能逐字输出本次候选正文')
    const exported = await ctx.tools.execute({
      callId: ToolCallId('signed-pdf-export'),
      name: 'gongchuang_render_pdf',
      arguments: { sourceArtifactPath: 'report.html', outputPath: 'report.pdf' },
      agent,
      signal: new AbortController().signal,
    })
    expect(exported.isError).toBe(false)
    expect(exported.value).toMatchObject({
      ok: true,
      path: PolicyGate.inspectProfessionalArtifact(output).path,
      format: 'pdf',
    })
    expect(() => ctx.gongchuangPolicy.professionalSubject(execution('read', true, agent)))
      .toThrow(/chat 模式校验/u)
    const finalValidation = await ctx.tools.execute({
      callId: ToolCallId('exported-pdf-validation'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report',
        deliveryMode: 'artifact',
        candidateText: '模型文本不会替代真实 PDF 正文。',
        artifactPath: 'report.pdf',
        artifactFormat: 'pdf',
        deliveryProfileId: 'project-feasibility-analysis-report',
        evidence,
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(finalValidation.isError).toBe(false)
  })

  it('rejects ambiguous or final-PDF chat candidate sources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-chat-candidate-source-'))
    const source = join(root, 'report.html')
    const pdf = join(root, 'report.pdf')
    writeFileSync(source, '<!doctype html><html><body><h1>总体结论</h1><p>仅依据已核验事实。</p></body></html>')
    writeFileSync(pdf, '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF\n')
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official')
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成项目报告并生成PDF最终文件' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const ambiguous = await ctx.tools.execute({
      callId: ToolCallId('ambiguous-chat-candidate-source'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report', deliveryMode: 'chat',
        candidateText: '模型候选', candidateArtifactPath: source, evidence: [],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(ambiguous.isError).toBe(false)
    expect(JSON.stringify(ambiguous)).toContain('repairable')
    expect(JSON.stringify(ambiguous)).toContain('必须且只能选择')

    const finalPdf = await ctx.tools.execute({
      callId: ToolCallId('final-pdf-as-chat-candidate-source'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'feasibility-report', deliveryMode: 'chat', candidateArtifactPath: pdf, evidence: [],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(finalPdf.isError).toBe(false)
    expect(JSON.stringify(finalPdf)).toContain('"status":"draft"')
    expect(JSON.stringify(finalPdf)).toContain('PDF 必须使用 artifact 模式')
  })

  it('keeps the exact HTML preflight source readable during its only repair step', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-chat-source-repair-'))
    const source = join(root, '税务风险报告.html')
    writeFileSync(source, '<!doctype html><html><body><h1>财税体检</h1><p>内容不足。</p></body></html>')
    const ctx = await policyContext()
    const agent = fakeAgent('deepseek-official', [], undefined, root)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成制造企业财税体检报告并生成 PDF' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'manufacturing-tax-risk-analysis' }), {
      isError: false,
      value: { name: 'manufacturing-tax-risk-analysis' },
      content: [{ type: 'text', text: 'manufacturing-tax-risk-analysis' }],
    })
    // 此用例关注 HTML 修复窗口，不应被前置依赖缺失提前截断。
    // 直接按当前签名关系激活本轮必需技能，使测试只覆盖其声明的失败类别。
    for (const name of ctx.gongchuangPolicy.requiredProfessionalSkills(
      execution('gongchuang_professional_validate', true, agent),
    )) {
      await postTool(ctx, execution('skill', true, agent, { name }, `html-repair-${name}`), {
        isError: false,
        value: { name },
        content: [{ type: 'text', text: name }],
      })
    }
    const validation = await ctx.tools.execute({
      callId: ToolCallId('chat-source-repair-validation'),
      name: 'gongchuang_professional_validate',
      arguments: {
        taskType: 'manufacturing-tax-risk-report',
        deliveryMode: 'chat',
        candidateArtifactPath: source,
        evidence: [],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(JSON.stringify(validation)).toContain('repairable')

    const repairStep = await preStep(ctx, agent, [], 1, 2)
    expect(JSON.stringify(repairStep)).toContain('专业修正窗口已限为一步')
    expect(JSON.stringify(repairStep)).toContain('不得把本步骤用成只读取、打印候选后等待下一轮')
    await expect(preTool(ctx, execution('read', true, agent, { file_path: source }, 'chat-source-read')))
      .resolves.toEqual({ kind: 'allow' })
    const unrelatedRead = await preTool(
      ctx,
      execution('read', true, agent, { path: join(root, '其他资料.html') }, 'chat-other-read'),
    )
    expect(unrelatedRead).toMatchObject({ kind: 'deny' })
    expect(JSON.stringify(unrelatedRead)).toContain('只允许重读')

    expect(await preStep(ctx, agent, [], 1, 3)).toEqual({ kind: 'reject' })
    const outcome = agent.session.snapshotEvents().findLast(event => event.type === 'user/message'
      && event.data.source?.kind === 'plugin' && event.data.source.plugin === 'gongchuang-policy-gate'
      && 'delivery' in event.data.source)
    expect(outcome?.data).toMatchObject({ source: { delivery: { phase: 'draft' } } })
    expect(JSON.stringify(outcome)).toContain(source)
    expect(JSON.stringify(outcome)).toContain('待完善')
  })

  it('rejects final text that drifts after the exact candidate passed validation', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请分析这个政府项目并给出申报建议' }],
      source: { kind: 'user' },
    }])
    for (const skill of ['project-task-router', 'project-feasibility']) {
      const exec = execution('skill', true, agent, { name: skill })
      await postTool(ctx, exec, {
        isError: false,
        value: { name: skill },
        content: [{ type: 'text', text: skill }],
      })
    }
    const validated = '总体结论：现有证据只支持继续开展项目可行性核验；在取得政策原文和企业材料前，暂无法判断是否满足全部申报条件。'
    const shown = `${validated}\n模型随后擅自补充：企业一定能够获批。`
    const exec = execution('gongchuang_professional_validate', true, agent)
    ctx.gongchuangPolicy.claim(exec, 'professional-kernel', validated)
    await postTool(ctx, exec, {
      isError: false,
      value: { ok: true },
      content: [{ type: 'text', text: 'validated' }],
    })
    appendAssistant(agent, shown)
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    const correction = JSON.stringify(steering.at(-1))
    expect(correction).toContain('最终回答与已通过专业校验的候选正文不一致')
    expect(correction).toContain('<validated-candidate>')
    expect(correction).toContain(validated)
    expect(correction).toContain('禁止重复调用校验')
    expect(correction).not.toContain('必须重新校验最终版本')
  })

  it('closes late skill dependencies before comparing a retained validated candidate', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请分析这个项目可行性并给出总体结论' }],
      source: { kind: 'user' },
    }])
    await postTool(ctx, execution('skill', true, agent, { name: 'project-feasibility' }), {
      isError: false,
      value: { name: 'project-feasibility' },
      content: [{ type: 'text', text: 'project-feasibility' }],
    })
    const validated = '总体结论：现有证据只支持继续核验，当前不能作出无证据判断。'
    const validation = execution('gongchuang_professional_validate', true, agent)
    ctx.gongchuangPolicy.claim(validation, 'professional-kernel', validated)
    await postTool(ctx, validation, {
      isError: false,
      value: { ok: true },
      content: [{ type: 'text', text: 'validated' }],
    })
    appendAssistant(agent, `${validated}\n额外前缀`)

    const lateSkill = await postTool(ctx, execution('skill', true, agent, {
      name: 'high-tech-enterprise-application-drafting',
    }, 'late-skill'), {
      isError: false,
      value: { name: 'high-tech-enterprise-application-drafting' },
      content: [{ type: 'text', text: 'high-tech-enterprise-application-drafting' }],
    })
    const lateNotice = JSON.stringify(lateSkill.additionalContexts)
    const validatedSha256 = createHash('sha256').update(validated).digest('hex')
    expect(lateNotice).toContain('专业正文内容校验已通过')
    expect(lateNotice).toContain('无需重新提交或重写')
    expect(lateNotice).not.toContain(validatedSha256)
    expect(lateNotice).toContain('不要重新提交专业校验、重写或重复输出候选正文')
    expect(lateNotice).not.toContain('再构造或提交 gongchuang_professional_validate')
    const stopSignal = new AbortController().signal
    const stop = (): Promise<void> => agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: stopSignal,
    })
    await stop()
    const dependencyCorrection = JSON.stringify(steering.at(-1))
    expect(dependencyCorrection).toContain('专业正文内容校验已通过；执行链尚未完成')
    expect(dependencyCorrection).toContain('无需重新提交或重写')
    expect(dependencyCorrection).not.toContain(validatedSha256)
    expect(dependencyCorrection).toContain('high-tech-enterprise-preassessment')
    expect(dependencyCorrection).not.toContain('最终回答与已通过专业校验的候选正文不一致')
    expect(dependencyCorrection).not.toContain('<validated-candidate>')
    expect(dependencyCorrection).not.toContain(validated)

    for (const skill of [
      'high-tech-enterprise-preassessment',
      'enterprise-profile',
      'policy-retrieval',
      'evidence-ledger',
      'consistency-check',
    ]) {
      await postTool(ctx, execution('skill', true, agent, { name: skill }, `late-${skill}`), {
        isError: false,
        value: { name: skill },
        content: [{ type: 'text', text: skill }],
      })
    }

    await stop()
    const finiteDraft = JSON.stringify(steering.at(-1))
    expect(finiteDraft).toContain('待完善稿')
    await stop()
    expect(steering).toHaveLength(2)
  })

  it('compares the validated candidate with the latest assistant message instead of progress messages', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请分析这个政府项目并给出申报建议' }],
      source: { kind: 'user' },
    }])
    for (const skill of ['project-task-router', 'project-feasibility']) {
      await postTool(ctx, execution('skill', true, agent, { name: skill }), {
        isError: false,
        value: { name: skill },
        content: [{ type: 'text', text: skill }],
      })
    }
    const candidate = '总体结论：现有证据只支持继续开展项目可行性核验；在取得政策原文和企业材料前，暂无法判断是否满足全部申报条件。'
    const exec = execution('gongchuang_professional_validate', true, agent)
    ctx.gongchuangPolicy.claim(exec, 'professional-kernel', candidate)
    await postTool(ctx, exec, {
      isError: false,
      value: { ok: true },
      content: [{ type: 'text', text: 'validated' }],
    })
    appendAssistant(agent, '正在核验来源并准备最终结论。')
    appendAssistant(agent, candidate)
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(steering).toEqual([])
  })

  it('invalidates earlier professional and artifact receipts after the bound file is rewritten', async () => {
    const ctx = await policyContext()
    const steering: unknown[] = []
    const agent = fakeAgent('deepseek-official', steering)
    await preStep(ctx, agent, [{
      content: [{ type: 'text', text: '请形成项目可行性HTML最终文件' }],
      source: { kind: 'user' },
    }])
    for (const skillName of ['project-task-router', 'project-feasibility']) {
      await postTool(ctx, execution('skill', true, agent, { name: skillName }), {
        isError: false, value: { name: skillName }, content: [{ type: 'text', text: skillName }],
      })
    }
    const artifact = join(mkdtempSync(join(tmpdir(), 'gongchuang-mutation-')), 'report.html')
    writeFileSync(artifact, '<!doctype html><html><body>首个已经完成专业校验的正式报告正文。</body></html>')
    const inspection = PolicyGate.inspectProfessionalArtifact(artifact)
    const kernel = execution('gongchuang_professional_validate', true, agent)
    ctx.gongchuangPolicy.claim(kernel, 'professional-kernel', undefined, {
      path: inspection.path, format: inspection.format, sha256: inspection.sha256,
      candidateSha256: inspection.contentSha256 as string,
      contentSha256: inspection.contentSha256 as string,
    })
    await postTool(ctx, kernel, { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'ok' }] })
    for (const [toolName, receiptId] of [
      ['gongchuang_content_audit', 'content-audit'],
      ['gongchuang_visual_inspection', 'visual-inspection'],
      ['gongchuang_branding_gate', 'brand-watermark'],
      ['gongchuang_artifact_probe', 'artifact-openability'],
    ] as const) {
      const exec = execution(toolName, true, agent)
      ctx.gongchuangPolicy.claim(exec, receiptId)
      await postTool(ctx, exec, { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'ok' }] })
    }

    const mutation = execution('write', true, agent, { path: artifact, content: 'changed' }, 'artifact-write')
    await expect(preTool(ctx, mutation)).resolves.toMatchObject({ kind: 'allow' })
    writeFileSync(artifact, '<!doctype html><html><body>校验后被改写的正式报告正文。</body></html>')
    await postTool(ctx, mutation, { isError: false, value: { path: artifact }, content: [{ type: 'text', text: 'written' }] })
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    const blocked = JSON.stringify(steering.at(-1))
    expect(blocked).toContain('professional-kernel')
    expect(blocked).toContain('正式文件尚未绑定实际文件身份')
  })
})
