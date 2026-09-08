import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SkillInvocationSource } from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as PolicyGate from '@gongchuang/client-policy-gate'
import { GONGCHUANG_MODEL_PROVIDER_ROUTES } from '@gongchuang/model-connections'
import * as SignedRuntime from '@gongchuang/signed-skill-runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { createProductTrustedPatches } from '../src/host-admission.ts'

let fixtureRoot: string | undefined
let context: Context | undefined

class FixtureCodeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'in-process-fixture'

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (request.program === 'curated-skill') {
      const skill = request.bindings.find(binding => binding.global === 'tools')?.functions.skill
      if (skill === undefined) throw new Error('skill binding is missing')
      const value = await skill({ name: 'project-application-assistant' }) as { name: string; content: string }
      return { logs: [value.content.slice(0, 20)], value: { name: value.name } }
    }
    if (request.program.includes('gongchuang_professional_validate')) {
      const tools = request.bindings.find(binding => binding.global === 'tools')
      const validate = tools?.functions.gongchuang_professional_validate
      if (validate === undefined) {
        return { logs: [], error: { kind: 'exception', message: 'professional validation binding is missing' } }
      }
      const guidanceInput = request.program.match(/^return await tools\.gongchuang_professional_validate\((.+)\) \/\/ delivery-guidance$/u)?.[1]
      if (guidanceInput !== undefined) {
        const input: unknown = JSON.parse(guidanceInput)
        return { logs: [], value: await validate(input) }
      }
      if (request.program.includes('combined-diagnostics')) {
        const repaired = request.program.includes('repaired')
        const value = await validate({
          taskType: 'investment-calculation', deliveryMode: 'chat',
          candidateText: '按用户给定规则核算，可计入金额为 270。合同额与实付差额为 60；本结果不构成申报资格结论，资产登记不能替代实际付款。',
          evidence: [{
            id: 'E1', kind: 'customer-file', status: 'user-provided', source: '用户原始问题',
            values: repaired ? ['300', '240', '30'] : ['300', '240', '30', '虚构来源取值'],
          }],
          calculations: [
            { id: 'C1', operator: 'sum', inputs: [240, 30], result: repaired ? 270 : 280, evidenceIds: ['E1'] },
            ...(repaired ? [{ id: 'C2', operator: 'subtract', inputs: [300, 240], result: 60, evidenceIds: ['E1'] }] : []),
          ],
        })
        return { logs: [], value }
      }
      if (request.program.includes('user-rule-calculation')) {
        const value = await validate({
          taskType: 'user-rule-calculation', deliveryMode: 'chat',
          candidateText: '按用户给定规则核算，可计入金额为 270，即 240 + 30。本结果不构成申报资格结论，资产登记不能替代实际付款。',
          evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '用户原始问题', values: ['240', '30'] }],
          calculations: [{ id: 'C1', operator: 'sum', inputs: [240, 30], result: 270, evidenceIds: ['E1'] }],
        })
        return { logs: [], value }
      }
      if (request.program.includes('provided-data-comparison')) {
        const value = await validate({
          taskType: 'provided-data-comparison', deliveryMode: 'chat',
          candidateText: '仅在用户提供的样本内部比较，乙收入 2400 高于甲收入 1800。该排序不代表真实行业地位，缺少市场分母不能计算市场份额。',
          evidence: [{ id: 'E1', kind: 'customer-file', status: 'user-provided', source: '用户原始问题', values: ['1800', '2400'] }],
        })
        return { logs: [], value }
      }
      const value = await validate({
        taskType: request.program.includes('terminal-validation') ? 'feasibility-report' : 'scoped-feasibility-analysis',
        deliveryMode: 'chat',
        candidateText: '现有资料只支持判断指定栏位的技术方向，结论以用户提供的原始问题为限，不形成或补写完整报告。',
        evidence: [{
          id: 'E1',
          kind: 'customer-file',
          status: 'user-provided',
          source: '用户原始问题',
          ...(request.program.includes('terminal-validation') ? { values: ['未在用户输入中出现的业务值'] } : {}),
        }],
      })
      return { logs: [], value }
    }
    if (request.program.includes('gongchuang_skill_operation')) {
      const tools = request.bindings.find(binding => binding.global === 'tools')
      const operation = tools?.functions.gongchuang_skill_operation
      if (operation === undefined) {
        return { logs: [], error: { kind: 'exception', message: 'signed operation binding is missing' } }
      }
      const value = await operation({
        operation: 'project-feasibility.validate-input',
        parameters: { company: '杭州测试企业' },
      })
      return { logs: [], value }
    }
    return Promise.resolve({ logs: [], value: 'fixture code transport reached' })
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = undefined
})

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fixtureAgent(cwd: string, suffix: string): Agent {
  const id = SessionId(`professional-loader-${suffix}`)
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
  })
  return {
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    session,
    steer() {},
  } as unknown as Agent
}

function userMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function preStep(ctx: Context, agent: Agent, messages: ReturnType<typeof createUserMessage>[]): Promise<PreStepDecision> {
  return ctx.waterfall(
    ctx as never,
    'agent/pre-step',
    { agent, messages, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

async function providerReached(ctx: Context, provider: string): Promise<boolean> {
  let reached = false
  const stream = ctx.waterfall(
    ctx as never,
    'llm/stream',
    { provider, model: 'fixture-model', messages: [] },
    () => (async function* () { reached = true })(),
  )
  for await (const _chunk of stream) {
    // The fixture emits no chunks; iteration proves the provider boundary opened.
  }
  return reached
}

async function bootProfessionalComposition(deliveryProfiles: Record<string, unknown> = {}): Promise<{ ctx: Context; workspace: string; tools: ToolRuntime }> {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'gongchuang-professional-loader-'))
  const workspace = join(fixtureRoot, 'workspace')
  const skillsRoot = join(fixtureRoot, 'skills')
  const scriptRoot = join(skillsRoot, 'project-feasibility', 'scripts')
  await mkdir(workspace)
  await mkdir(scriptRoot, { recursive: true })

  const python = join(fixtureRoot, 'python')
  const script = join(scriptRoot, 'validate.py')
  const operationManifest = join(skillsRoot, 'client-runtime-operations.json')
  const contracts = join(skillsRoot, 'delivery-contracts.json')
  const callGraph = join(skillsRoot, 'skill-call-graph.json')
  await writeFile(python, 'signed fixture python\n')
  await writeFile(script, '# signed project feasibility validator\n')
  await writeFile(operationManifest, `${JSON.stringify({
    schema_version: 'gongchuang-signed-skill-operations/v1',
    skill_bundle_version: '1.6.15',
    operations: [{
      id: 'project-feasibility.validate-input',
      skill: 'project-feasibility',
      description: 'Validate one enterprise report input.',
      script: 'project-feasibility/scripts/validate.py',
      files: [],
      sandbox_mode: 'read-only',
      network: 'none',
      timeout_ms: 5_000,
      max_output_bytes: 4_096,
      result_exit_codes: [0, 2],
      passing_exit_codes: [0],
      parameters: { company: { type: 'text', required: true, min_length: 2, max_length: 100 } },
      argv: [{ literal: '--company' }, { parameter: 'company' }],
    }],
  }, null, 2)}\n`)
  await writeFile(contracts, `${JSON.stringify({
    schema_version: 3,
    rule_version: '1.6.15',
    business_domain_markers: ['企业', '申报', '报告'],
    policy_task_markers: ['政策'],
    peer_task_markers: ['同行'],
    route_resolution_skills: ['project-feasibility', 'project-application-assistant', 'project-task-router', 'investment-subsidy-projects'],
    delivery_profiles: deliveryProfiles,
    skills: {
      'project-feasibility': {
        applies_when_prompt_contains: ['可行性分析报告'],
        required_marker_groups: [['总体结论']],
      },
      'investment-subsidy-projects': {
        applies_when_prompt_contains: ['投资核算'],
        required_marker_groups: [],
      },
      'peer-benchmarking': {
        applies_when_prompt_contains: ['同行对标'],
        required_marker_groups: [],
      },
    },
  }, null, 2)}\n`)
  await writeFile(callGraph, `${JSON.stringify({ schema_version: 1, relations: [
    { from: 'investment-subsidy-projects', to: 'policy-retrieval', type: 'requires' },
    { from: 'peer-benchmarking', to: 'policy-retrieval', type: 'requires' },
  ] }, null, 2)}\n`)

  const productRoot = resolve(import.meta.dirname, '..')
  // Exercise the real signature verifier without requiring a production signing
  // key or a previously published signature for the current candidate bytes.
  const fixtureKeys = generateKeyPairSync('ed25519')
  const fixturePublicKey = Buffer.from(fixtureKeys.publicKey.export({ type: 'spki', format: 'pem' }))
  const fixturePolicy = await readFile(join(productRoot, 'policy-template.json'))
  await writeFile(join(fixtureRoot, 'policy-template.json'), fixturePolicy)
  await writeFile(join(fixtureRoot, 'policy.sig'), sign(null, fixturePolicy, fixtureKeys.privateKey).toString('base64'))
  await writeFile(join(fixtureRoot, 'policy.pub.pem'), fixturePublicKey)
  const paths = {
    policyManifestPath: join(fixtureRoot, 'policy-template.json'),
    policySignaturePath: join(fixtureRoot, 'policy.sig'),
    policyPublicKeyPath: join(fixtureRoot, 'policy.pub.pem'),
    professionalContractsPath: contracts,
    skillCallGraphPath: callGraph,
    professionalCheckpointDir: join(fixtureRoot, 'professional-tasks'),
    activeSkillBundleVersion: '1.6.15',
  }
  const entries = composeEntries([createProductTrustedPatches('/product/agent-presets', paths)])
    .filter(entry => entry.id === 'gongchuang-policy-gate' || entry.id === 'gongchuang-signed-skill-runtime')
  const policy = entries.find(entry => entry.id === 'gongchuang-policy-gate')
  const runtime = entries.find(entry => entry.id === 'gongchuang-signed-skill-runtime')
  if (policy?.config === undefined || runtime === undefined) throw new Error('professional Host rows are missing')
  const configPath = join(fixtureRoot, 'cordis.yml')
  await writeFile(configPath, [
    `- name: ${JSON.stringify(policy.name)}`,
    `  config: ${JSON.stringify({ ...policy.config, expectedPublicKeySha256: sha256(fixturePublicKey) })}`,
    `- name: ${JSON.stringify(runtime.name)}`,
    '',
  ].join('\n'))

  const fileHashes = Object.freeze({
    'client-runtime-operations.json': sha256(await readFile(operationManifest)),
    'project-feasibility/scripts/validate.py': sha256(await readFile(script)),
  })
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(fixtureRoot).href}/`
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(FixtureCodeRuntime).await()
  await ctx.plugin(ToolRuntime, { mode: 'ptc' }).await()
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('tool runtime did not publish')
  ctx.provide('subprocess', {
    spawn: () => ({
      collected: {
        stdout: { readFrom: () => ({ text: '{"status":"pass"}\n', nextOffset: 18, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: 0, signal: null }),
      waitForExit: () => Promise.resolve(true),
    }),
  } as never)
  ctx.provide('sandbox', {
    confine: (argv: readonly string[]) => ({
      argv: [...argv],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [],
    }),
  } as never)
  ctx.provide('gongchuangSkillRuntimeBinding', Object.freeze({
    skillsRoot,
    skillBundleVersion: '1.6.15',
    skillBundleIndexSha256: 'a'.repeat(64),
    skillFileHashes: fileHashes,
    signingTier: 'formal',
    pythonExecutable: python,
    pythonExecutableSha256: sha256(await readFile(python)),
    runtimeIntegrity: 'signed',
    runtimeIndexSha256: 'b'.repeat(64),
    paddleOcrMcpVersion: SignedRuntime.GONGCHUANG_PADDLEOCR_MCP_VERSION,
  }))
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@gongchuang/client-policy-gate', PolicyGate],
    ['@gongchuang/signed-skill-runtime', SignedRuntime],
  ])
  ctx.loader.internal = {
    version: 'gongchuang-professional-loader-test',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as never
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const unloaded = [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  if (unloaded.length > 0) throw new Error(`professional Loader entries did not mount: ${unloaded.join(', ')}`)
  return { ctx, workspace, tools }
}

describe('packaged professional runtime composition', () => {
  it('keeps full skill instructions after a PTC caller returns only a short preview', async () => {
    const { ctx, workspace, tools } = await bootProfessionalComposition()
    const instructions = `START\n${'Read the assigned document.\n'.repeat(100)}END: model vision is not human review.`
    tools.register(defineTool({
      name: 'skill', description: 'Load the requested skill.',
      parameters: { name: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, content: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.content }],
      },
      execute: args => Promise.resolve({ name: args.name, content: instructions }),
    }))
    const agent = fixtureAgent(workspace, 'complete-instructions')
    // Exact public user message from the B08 native attachment failure, including Client-added context.
    const captured = JSON.parse(await readFile(join(import.meta.dirname, 'fixtures/native-document-reader-message.json'), 'utf8')) as {
      content: { type: 'text'; text: string }[]
      source: { kind: 'user'; displayText: string }
    }
    const submitted = createUserMessage(captured)
    const initial = await preStep(ctx, agent, [submitted])
    expect(initial).toEqual({ kind: 'enter', messages: [submitted] })
    const result = await tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('curated-skill'),
      name: 'run_code', arguments: { code: 'curated-skill' }, agent,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ logs: [instructions.slice(0, 20)] })
    expect(result.additionalContexts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: { kind: 'plugin', plugin: 'gongchuang-policy-gate', form: 'instructions' },
        content: [{ type: 'text', text: instructions }],
      }),
    ]))
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(0)
    expect(await preStep(ctx, agent, [])).toEqual({ kind: 'enter', messages: [] })
  })

  it('does not lock an offline index task because it forbids impersonating official policy', async () => {
    const { ctx, workspace } = await bootProfessionalComposition()
    const agent = fixtureAgent(workspace, 'offline-index-source')
    const user = userMessage('实际使用 third-party-data-indexing，处理纯合成离线数据并建立隔离增量索引。输入只是测试资料，不能冒充官方政策；不联网、不访问客户资料、不改正式知识库。')
    expect(await preStep(ctx, agent, [user])).toEqual({ kind: 'enter', messages: [user] })
  })

  it('does not turn a skill-authoring scope description into a professional business task', async () => {
    const { ctx, workspace } = await bootProfessionalComposition()
    const agent = fixtureAgent(workspace, 'skill-authoring-scope')
    const scope = '实际使用 skill-authoring，创建园区设备台账整理技能候选。用途是从用户已给的合同、发票、支付和设备清单整理台账，不能给出真实补助资格结论。明确与财务核验、投资补助技能的职责边界；没有官方政策或可靠业务证据时保留待核验。只处理本条需求，不联网、不安装、不发布、不删除。'
    const user = userMessage(scope)
    expect(await preStep(ctx, agent, [user])).toEqual({ kind: 'enter', messages: [user] })
    const actualBusiness = fixtureAgent(workspace, 'skill-authoring-and-business')
    const decision = await preStep(ctx, actualBusiness, [userMessage(`${scope}另外请出企业科技项目可行性分析报告。`)])
    expect(JSON.stringify(decision)).toContain('project-feasibility')
  })

  it('mounts the signed policy and operation executor through the real Loader', async () => {
    const { ctx, workspace, tools } = await bootProfessionalComposition()
    const mounted = [...ctx.loader.entries()]
      .filter(entry => entry.fiber !== undefined)
      .map(entry => entry.options.name)
    expect(mounted).toEqual(expect.arrayContaining([
      '@gongchuang/client-policy-gate',
      '@gongchuang/signed-skill-runtime',
    ]))
    expect(tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining([
      'gongchuang_professional_validate',
      'gongchuang_skill_operation',
    ]))
    const operationSchema = tools.schemas().find(schema => schema.name === 'gongchuang_skill_operation')
    expect(operationSchema?.description).toContain(JSON.stringify({
      operation: 'project-feasibility.validate-input',
      skill: 'project-feasibility',
      description: 'Validate one enterprise report input.',
      parameterSchema: { company: { type: 'string', minLength: 2, maxLength: 100 } },
    }))
    expect(operationSchema?.description).toMatchInlineSnapshot(`
      "执行 V1.6.15 已验签技能的固定操作。先用 skill 激活该操作的 skill，再按清单调用；无需寻找运行清单、脚本或解释器。
      若当前只开放 run_code，在其中先 await tools.skill({name: skill})，成功后 await tools.gongchuang_skill_operation({operation, parameters})。skill 与 operation 使用下面逐字列出的值，不要直接调用未开放的根工具。
      parameters 的所有参数均必填，不得添加未列出的参数。text 和 enum 传字符串；integer 和 boolean 传对应 JSON 类型。workspace-input-file 和 workspace-output-file 传当前工作区内的文件路径字符串。专业正文预校验已通过时，evidence-ledger.create-docx 的 content 由宿主以已验收检查点覆盖并自行校验字符串长度；直接调用一次，不要用 Bash、wc 或脚本预先统计字符数或字节数，防止二次读取和拼写漂移。
      parameterSchema 只描述类型和约束，不是参数值。文件参数直接传路径字符串，不传 {type, path, extensions} 对象。提取成功后读取 stdout 的 JSON；needs_ocr 时保留已提取文字，只补 ocr_pages，不要重复提取同一文件或猜测工具参数。
      不接受命令、脚本路径、解释器、环境变量或网址。
      {"operation":"project-feasibility.validate-input","skill":"project-feasibility","description":"Validate one enterprise report input.","parameterSchema":{"company":{"type":"string","minLength":2,"maxLength":100}}}"
    `)
    const prompt = await ctx.systemPrompt.assemble()
    expect(prompt.tools.map(tool => tool.name)).toEqual(['run_code'])
    const sdk = prompt.sections.find(section => section.name === 'tools:sdk')?.text
    expect(sdk).toContain('await tools.skill({name: skill})')
    expect(sdk).toContain('source is a display label, not a read identity; renaming it cannot repair mismatched values.')
    expect(sdk).toContain('"parameterSchema":{"company":{"type":"string","minLength":2,"maxLength":100}}')
    expect(sdk?.match(/IDs from the evidence array only,[\s\S]*?not \[c1, c2\]\./u)?.[0]).toMatchInlineSnapshot(`"IDs from the evidence array only, never calculation IDs. A calculation using earlier results must retain those results' original source evidence IDs. For example, if c1 uses E1 and c2 uses E2, c3 = c1 - c2 binds [E1, E2], not [c1, c2]."`)

    const agent = fixtureAgent(workspace, 'professional')
    const user = userMessage('杭州测试企业，出科技项目可行性分析报告。')
    const invocation = createUserMessage({
      content: [{ type: 'text', text: 'project-feasibility signed instructions' }],
      source: {
        kind: 'skill-invocation', name: 'project-feasibility', form: 'instructions',
      } satisfies SkillInvocationSource,
    })
    await preStep(ctx, agent, [user, invocation])
    const result = await tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('signed-operation'),
      rootCallId: ToolCallId('signed-operation'),
      name: 'run_code',
      arguments: {
        code: 'return await tools.gongchuang_skill_operation({ operation: "project-feasibility.validate-input", parameters: { company: "杭州测试企业" } })',
        description: 'Execute the signed professional operation',
      },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      result: {
        operation: 'project-feasibility.validate-input',
        skill: 'project-feasibility',
        status: 'passed',
        runtimeIntegrity: 'signed',
      },
    })
  })

  it('closes a terminal PTC validation before another model step through the real Loader', async () => {
    const { ctx, workspace, tools } = await bootProfessionalComposition()
    const agent = fixtureAgent(workspace, 'terminal-ptc')
    await preStep(ctx, agent, [userMessage('杭州测试企业，出科技项目可行性分析报告。'), createUserMessage({
      content: [{ type: 'text', text: 'project-feasibility signed instructions' }],
      source: { kind: 'skill-invocation', name: 'project-feasibility', form: 'instructions' },
    })])
    for (const [index, status] of ['repairable', 'draft'].entries()) {
      const result = await tools.execute({
        signal: new AbortController().signal, callId: ToolCallId(`terminal-ptc-${index}`),
        name: 'run_code', arguments: { code: 'return await tools.gongchuang_professional_validate({}) // terminal-validation' }, agent,
      })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ result: { status } })
      expect(result.content).toEqual(expect.arrayContaining([
        { type: 'text', text: expect.stringContaining(status === 'draft' ? '不再自动重复校验' : '本轮只允许按诊断修正一次') },
      ]))
    }
    expect(await preStep(ctx, agent, [])).toEqual({ kind: 'reject' })
    const notices = agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin' && 'delivery' in event.data.source)
    expect(JSON.stringify(notices)).toContain('当前结果不能作为正式交付使用')
    expect(notices).toHaveLength(1)
  })

  it('returns mode-specific next steps through PTC and records the same tool text', async () => {
    const { ctx, workspace, tools } = await bootProfessionalComposition({
      'project-feasibility-analysis-report': {
        skill_id: 'project-feasibility',
        requires_source_trace: true,
        requires_evidence_ledger: true,
        requires_peer_comparison: false,
        requires_policy_selection_trace: false,
        required_sections: ['总体结论'],
        required_tables: [],
        required_artifacts: [{ role: 'report', formats: ['html', 'docx', 'pdf'] }],
      },
    })
    const candidate = '总体结论：现有资料仅支持技术方向判断，资料缺口保持待核验，不扩大为正式资格结论。'
    const artifactPath = join(workspace, 'report.html')
    await writeFile(artifactPath, `<!doctype html><html><body><p>${candidate}</p></body></html>`)
    const guidance: Record<string, string> = {}
    for (const mode of ['chat', 'office-preflight', 'pdf-preflight', 'artifact'] as const) {
      const agent = fixtureAgent(workspace, `delivery-guidance-${mode}`)
      await preStep(ctx, agent, [userMessage(candidate), createUserMessage({
        content: [{ type: 'text', text: 'project-feasibility signed instructions' }],
        source: { kind: 'skill-invocation', name: 'project-feasibility', form: 'instructions' },
      })])
      const input = {
        taskType: 'scoped-feasibility-analysis',
        deliveryMode: mode === 'artifact' ? 'artifact' : 'chat',
        ...(mode === 'pdf-preflight' ? { candidateArtifactPath: artifactPath } : { candidateText: candidate }),
        ...(mode === 'office-preflight' || mode === 'artifact'
          ? { deliveryProfileId: 'project-feasibility-analysis-report', artifactFormat: mode === 'artifact' ? 'html' : 'docx' }
          : {}),
        ...(mode === 'artifact' ? { artifactPath } : {}),
        evidence: [{
          id: 'E1', kind: 'customer-file', status: 'user-provided', source: '用户原始问题', values: ['资料缺口保持待核验'],
        }],
      }
      const result = await tools.execute({
        signal: new AbortController().signal, callId: ToolCallId(`delivery-guidance-${mode}`),
        name: 'run_code', agent,
        arguments: { code: `return await tools.gongchuang_professional_validate(${JSON.stringify(input)}) // delivery-guidance` },
      })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ result: { status: 'formal', nextStep: expect.any(String) } })
      const { nextStep } = (result.value as { result: { nextStep: string } }).result
      expect(JSON.stringify(result.content)).toContain(nextStep)
      const recorded = agent.session.snapshotEvents().flatMap(event => event.type === 'tool/code-dispatch'
        && event.data.name === 'gongchuang_professional_validate' ? event.data.content : [])
      expect(recorded).toEqual([{ type: 'text', text: nextStep }])
      guidance[mode] = nextStep
    }
    expect(guidance).toMatchInlineSnapshot(`
      {
        "artifact": "专业规则检查已完成。请对同一最终文件继续完成 gongchuang_artifact_probe、gongchuang_content_audit、gongchuang_branding_gate；PDF 还需 gongchuang_visual_inspection。首次 artifact 校验前不得执行可打开性探测；同一已绑定且未修改文件的有效检查无需重复。全部交付检查通过后再返回文件，本次结果不代表文件已正式交付。",
        "chat": "专业规则检查已完成。下一条最终消息只能逐字输出本次候选正文，不得添加任何前后缀或改动格式。",
        "office-preflight": "文件正文预校验已完成。请在当前 run_code 内立即用同一 candidateText 变量生成所选格式的文件；宿主会注入已验收正文，不得重新拼写。再用 artifact 模式校验真实文件，并完成对应交付检查。当前尚未完成文件交付，不得直接输出候选正文结束本轮。",
        "pdf-preflight": "文件正文预校验已完成。请调用 gongchuang_render_pdf 从本次 HTML 源文件生成 PDF，再用 artifact 模式校验实际 PDF，并完成可打开性、正文一致性、文档标识与逐页视觉检查。当前尚未完成文件交付，不得直接结束或发布 HTML 中间源。",
      }
    `)
    const prompt = await ctx.systemPrompt.assemble()
    const sdk = prompt.sections.find(section => section.name === 'tools:sdk')?.text
    expect(sdk).toContain('Only a chat-only delivery ends by reproducing the validated candidate exactly.')
    expect(sdk).toContain('Required next action for this delivery mode.')
  })

  it.each([
    '把这句生日祝福改得自然一点。',
    'GC-QA 旧格式附件读取验收。只处理 GC-QA-sheet.xls 和 GC-QA-merged.doc，列出标记和数字。不要安装软件、猜测乱码或反复更换解析器，不修改文件，不读取其他企业资料，不生成报告。',
  ])('does not promote an ordinary request into a professional workflow: %s', async text => {
    const { ctx, workspace, tools } = await bootProfessionalComposition()
    const agent = fixtureAgent(workspace, 'ordinary')
    const decision = await preStep(
      ctx,
      agent,
      [userMessage(text)],
    )
    if (decision.kind !== 'enter') throw new Error('ordinary task was unexpectedly rejected')
    const visible = decision.messages.flatMap(message => message.content ?? [])
      .map(block => block?.type === 'text' ? block.text : '')
      .join('\n')
    expect(visible).not.toContain('共创专业执行链已锁定技能包')
    const result = await tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('ordinary-ptc-mode'),
      rootCallId: ToolCallId('ordinary-ptc-mode'),
      name: 'run_code',
      arguments: {
        code: 'return "ordinary task reached the code transport"',
        description: 'Verify the ordinary PTC transport',
      },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ result: 'fixture code transport reached' })
  })

  it('keeps an explicitly scoped report question on the analysis contract through the real Loader', async () => {
    const { ctx, workspace, tools } = await bootProfessionalComposition()
    const agent = fixtureAgent(workspace, 'scoped-analysis')
    const decision = await preStep(ctx, agent, [
      userMessage('杭州测试企业，只分析可行性报告中的这一栏，不要展开完整报告。'),
      createUserMessage({
        content: [{ type: 'text', text: 'project-feasibility signed instructions' }],
        source: {
          kind: 'skill-invocation', name: 'project-feasibility', form: 'instructions',
        } satisfies SkillInvocationSource,
      }),
    ])
    if (decision.kind !== 'enter') throw new Error('scoped analysis was unexpectedly rejected')
    const visible = JSON.stringify(decision, (key, value) => key === 'id' ? '<id>' : value, 2)
    expect(visible).toMatchInlineSnapshot(`
      "{
        "kind": "enter",
        "messages": [
          {
            "content": [
              {
                "type": "text",
                "text": "杭州测试企业，只分析可行性报告中的这一栏，不要展开完整报告。"
              }
            ],
            "source": {
              "kind": "user"
            },
            "role": "user",
            "id": "<id>"
          },
          {
            "content": [
              {
                "type": "text",
                "text": "project-feasibility signed instructions"
              }
            ],
            "source": {
              "kind": "skill-invocation",
              "name": "project-feasibility",
              "form": "instructions"
            },
            "role": "user",
            "id": "<id>"
          },
          {
            "content": [
              {
                "type": "text",
                "text": "洞见专业执行链已锁定技能包 V1.6.15。\\n本任务必须激活并遵循：project-feasibility、project-task-router。第一步逐项调用 skill 激活这里列出的全部技能，确认全部成功后再读取资料、起草或校验；不得等校验器提示遗漏后补激活。\\n工具调用通道：以下 skill、ask_user_question、已签名技能操作和专业校验均使用当前工具目录。当前只开放 run_code 时，必须在其程序内 await tools.skill({name: \\"技能名\\"})，其余工具同样通过 tools 调用；不要直接调用未开放的根工具。run_code 不是 Node.js 模块，而是 V8 隔离程序：不得写 require(...)、import、process、fs 或网络访问，只能调用当前暴露的 tools；已签名输出操作会自行创建父目录，无需 mkdir。禁止探查运行环境、列目录或临时编写 Node/Python Office 生成脚本。run_code 最终只返回 null 或显式构造的字符串、数字、布尔值与纯 JSON 对象；不得返回原始工具结果或含 undefined 的字段。\\n本轮是局部分析：只展开用户明确提出的判断范围，不自动追加完整项目评估、企业画像、评分、材料清单或报告文件。\\n报告文件格式规则：每份报告正文只生成一次；用户未明确指定文件格式时只交付一份 DOCX，不同时生成同一正文的 PDF。只有用户明确要求 PDF 时才启用 PDF 渲染，HTML 只作为不发布的中间源；不同业务报告模式仍按主技能规则选择。Office 任务先用尚未写入文件的完整 candidateText 做 chat 预校验；预校验返回 formal 或明确允许待完善文件继续后才生成文件。禁止先生成 DOCX 再用 pandoc、解压 XML 或自编脚本回读作为 chat 预校验。\\n用户决策规则：专业 Skill 要求用户选择报告模式、版本或其他不可代答选项时，必须先调用 ask_user_question 并等待真实回答；不得只发一条普通提问后在同一轮继续，也不得自行采用推荐项或第一项。\\n这些技能的事实边界、计算口径、证据要求和质量门禁都是强制条件；正文结构只采用任务主技能：project-feasibility、project-task-router。支持依赖不得叠加第二套输出模板。证据不足时保留待核验或暂无法判断，不得回退为通用模型自由发挥。\\nproject-feasibility 没有自有签名交付画像；以该技能为主任务校验时省略 deliveryProfileId，不借用其他技能的 ID。\\n证据绑定规则：用户在对话中直接提供的事实标为 user-provided，values 逐字复制用户消息；通过 read/read_image、已签名客户文件提取操作或 PaddleOCR MCP 提取的客户文件事实也标为 user-provided，values 逐字复制读取结果。签名技能参考文件不是客户文件：其中列示的政府政策用于政策结论时，必须使用 kind=official-policy、status=verified，sourceUrl 使用该读取回执中的 gov.cn 原文网址，values 逐字复制同一回执内容；不得因为它由 read 读取就标为 user-provided。宿主会自动绑定唯一匹配的读取回执；只有多个读取结果含有相同取值时，才从洞见证据回执原样复制 toolCallId。已签名确定性计算或 run-preflight 操作只使用一条 calculated 证据，source 写准确操作 ID，values 省略或写空数组；宿主会直接绑定并生成全部数值，不得扫描成品全文、逐页枚举数字或手抄 calculations。回执 accessedAt 只填 evidence.asOf，不得放入 values。\\n技能脚本规则：gongchuang_skill_operation 是针对工作区内已有文件的受签名固定操作，不是每个对话任务的必经步骤；但主技能明确提供生成或计算操作时必须优先使用。禁止猜测操作 ID、禁止传入空路径。用户要求“只在对话中输出”或“不创建文件”，且工作区没有已有的结构化校验文件时，不得为调用该工具创建临时文件；直接使用 gongchuang_professional_validate 完成本轮必需的专业门禁。确需校验已有文件时，只能使用工具说明或已验签 client-runtime-operations.json 中逐字列出的操作 ID 与参数名。\\n最小充分执行规则：已成功取得的客户文件、网页原文、证据回执、计算结果和技能正文都是本轮检查点。除非调用失败、来源时点变化或新证据冲突，不得重复读取或检索；不得为了计算候选长度、确认内容或准备生成文件而再次读取同一输入，直接复用内存中的 candidateText。不要调用 Bash、wc 或脚本预先统计正文的字符数或字节数；text 长度由宿主按字符串 length 校验，直接提交一次并只在工具明确返回超限时修正。校验失败时保留 candidateText、evidence 与 calculations，只修复错误清单列出的缺口。\\nOffice 正式交付规则：当所选专业 Skill 声明 deliveryProfileId 时，生成 DOCX、XLSX 或 PPTX 前先以 chat 模式提交完整结构候选与该 deliveryProfileId 做专业预校验；预校验通过后才生成一个正式文件。主技能有专用模板或生成操作时必须使用；主技能没有专用 DOCX 模板或生成操作时，必须在同一个 run_code 中完成预校验后立即调用已签名操作 evidence-ledger.create-docx，content 传当前 candidateText 变量，output 传工作区内尚不存在的 .docx 路径。宿主会直接注入刚通过的正文检查点，不得在校验后重新拼接、转述或手抄正文。不得临时编写 Node/Python 生成脚本，不得使用 pandoc 或 OOXML 解压回读替代该操作。生成文件不添加客户端品牌页眉、标志或水印。随后以 artifact 模式对真实文件校验，并完成文档标识、正文、可打开性与适用的视觉检查。\\nPDF 正式交付规则：不得把 HTML 预稿冒充最终 PDF，也不得先用 artifact 模式绑定不属于交付画像的源格式。先以 chat 模式传入 candidateArtifactPath，让宿主从真实静态 HTML 源文件提取正文并完成专业预校验；不得由模型重新抄写整份源正文。再调用 gongchuang_render_pdf 生成同目录 PDF；该动作会使预校验回执失效。随后必须以 artifact 模式从真实 PDF 重新完成专业校验，再依次完成可打开性、正文一致性、文档标识与逐页视觉验收。Office 文件保持原生 OOXML，不作为 PDF 转换源。\\n最终输出规则：已锁定专业 Skill 且只在对话中交付正文的专业任务，在 gongchuang_professional_validate 通过后，下一条最终消息只能逐字输出本次 candidateText。正式文件流程必须继续完成生成、artifact 校验与全部交付回执，最终只返回已绑定的正式文件，不得添加校验状态、哈希或证据条数。"
              }
            ],
            "source": {
              "kind": "plugin",
              "plugin": "gongchuang-policy-gate",
              "form": "notice",
              "summary": "洞见专业执行链已锁定"
            },
            "role": "user",
            "id": "<id>"
          }
        ]
      }"
    `)

    const validation = await tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('scoped-analysis-validation'),
      rootCallId: ToolCallId('scoped-analysis-validation'),
      name: 'run_code',
      arguments: {
        code: 'return await tools.gongchuang_professional_validate({ taskType: "scoped-feasibility-analysis", deliveryMode: "chat", candidateText: "现有资料只支持判断指定栏位的技术方向，结论以用户提供的原始问题为限，不形成或补写完整报告。", evidence: [{ id: "E1", kind: "customer-file", status: "user-provided", source: "用户原始问题" }] })',
        description: 'Validate a scoped professional answer through PTC',
      },
      agent,
    })
    expect(validation.isError, JSON.stringify(validation)).toBe(false)
  })

  it('admits every route registered by the product model-connections runtime', async () => {
    const { ctx } = await bootProfessionalComposition()
    for (const route of Object.values(GONGCHUANG_MODEL_PROVIDER_ROUTES)) {
      await expect(providerReached(ctx, route)).resolves.toBe(true)
    }
    await expect(providerReached(ctx, 'unmanaged-provider')).rejects.toThrow(/不在签名策略允许范围/u)
  })

  it.each([
    ['投资核算，按用户给定规则复算 240 + 30，不是现实政策资格判断。', 'formal'],
    ['投资核算，按用户给定规则复算 240 + 30，并判断能否申报补贴。', 'repairable'],
  ])('keeps calculation scope Host-owned through the Loader: %s', async (text, status) => {
    const { ctx, workspace, tools } = await bootProfessionalComposition()
    const agent = fixtureAgent(workspace, `calculation-${status}`)
    const decision = await preStep(ctx, agent, [
      userMessage(text),
      createUserMessage({
        content: [{ type: 'text', text: 'investment-subsidy-projects signed instructions' }],
        source: { kind: 'skill-invocation', name: 'investment-subsidy-projects', form: 'instructions' } satisfies SkillInvocationSource,
      }),
      createUserMessage({
        content: [{ type: 'text', text: 'policy-retrieval signed instructions' }],
        source: { kind: 'skill-invocation', name: 'policy-retrieval', form: 'instructions' } satisfies SkillInvocationSource,
      }),
    ])
    expect(decision.kind).toBe('enter')
    expect(JSON.stringify(decision).includes('本轮只按用户给定规则核算')).toBe(status === 'formal')
    const result = await tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`calculation-${status}`), rootCallId: ToolCallId(`calculation-${status}`),
      name: 'run_code', arguments: { code: 'return await tools.gongchuang_professional_validate({}) // user-rule-calculation' }, agent,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ result: { status } })
    if (status === 'formal') {
      expect(result.value).toMatchObject({ result: { checks: [
        'public-delivery-sanitization', 'skill-marker-order', 'calculation-replay',
        'numeric-evidence-binding', 'user-rule-calculation-scope', 'source-classification',
      ] } })
    } else {
      expect(JSON.stringify(result.value)).toContain('政策结论缺少')
    }
  })

  it('returns binding and arithmetic gaps together so one repair can address both', async () => {
    const { ctx, workspace, tools } = await bootProfessionalComposition()
    const agent = fixtureAgent(workspace, 'combined-diagnostics')
    await preStep(ctx, agent, [
      userMessage('投资核算，按用户给定规则复算，合同 300，实付 240 和 30，不是现实政策资格判断。'),
      createUserMessage({
        content: [{ type: 'text', text: 'investment-subsidy-projects signed instructions' }],
        source: { kind: 'skill-invocation', name: 'investment-subsidy-projects', form: 'instructions' } satisfies SkillInvocationSource,
      }),
      createUserMessage({
        content: [{ type: 'text', text: 'policy-retrieval signed instructions' }],
        source: { kind: 'skill-invocation', name: 'policy-retrieval', form: 'instructions' } satisfies SkillInvocationSource,
      }),
    ])
    for (const repaired of [false, true]) {
      const result = await tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`combined-${String(repaired)}`), rootCallId: ToolCallId(`combined-${String(repaired)}`),
        name: 'run_code',
        arguments: { code: `return await tools.gongchuang_professional_validate({}) // combined-diagnostics ${repaired ? 'repaired' : 'initial'}` },
        agent,
      })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ result: { status: repaired ? 'formal' : 'repairable' } })
      if (!repaired) {
        const diagnostic = JSON.stringify(result.value)
        expect(diagnostic).toContain('取值未出现在绑定来源中')
        expect(diagnostic).toContain('复算')
        expect(diagnostic).toContain('数字 60 未绑定')
        expect((result.value as { result: { criticalIssues: string[] } }).result.criticalIssues).toMatchInlineSnapshot(`
          [
            "证据 E1 的取值未出现在绑定来源中：虚构来源取值。当前没有客户文件的受信任读取回执；如事实来自文件，请用 read 或已签名文档读取器读取该文件。Bash 打印内容不能代替读取回执。source 显示名称不是读取身份，修改名称不能修复取值不匹配。",
            "计算 C1 无法复算",
            "数字 270 未绑定证据或复算过程",
            "数字 60 未绑定证据或复算过程",
          ]
        `)
      }
    }
  })

  it.each([
    ['同行对标，仅依据用户提供的数据比较 1800 与 2400，在样本内部排序，不判断真实企业市场地位结论。', 'formal'],
    ['同行对标，仅依据用户提供的数据比较 1800 与 2400，并判断市场份额。', 'repairable'],
  ])('keeps supplied-record comparison scope Host-owned: %s', async (text, status) => {
    const { ctx, workspace, tools } = await bootProfessionalComposition()
    const agent = fixtureAgent(workspace, `comparison-${status}`)
    const decision = await preStep(ctx, agent, [
      userMessage(text),
      createUserMessage({
        content: [{ type: 'text', text: 'peer-benchmarking signed instructions' }],
        source: { kind: 'skill-invocation', name: 'peer-benchmarking', form: 'instructions' } satisfies SkillInvocationSource,
      }),
      createUserMessage({
        content: [{ type: 'text', text: 'policy-retrieval signed instructions' }],
        source: { kind: 'skill-invocation', name: 'policy-retrieval', form: 'instructions' } satisfies SkillInvocationSource,
      }),
    ])
    expect(decision.kind).toBe('enter')
    expect(JSON.stringify(decision).includes('本轮仅比较用户指定的输入样本')).toBe(status === 'formal')
    const result = await tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`comparison-${status}`), rootCallId: ToolCallId(`comparison-${status}`),
      name: 'run_code', arguments: { code: 'return await tools.gongchuang_professional_validate({}) // provided-data-comparison' }, agent,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ result: { status } })
  })
})
