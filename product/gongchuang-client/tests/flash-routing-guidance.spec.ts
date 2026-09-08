import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, vi } from 'vitest'
import {
  appendFlashRoutingGuidance,
  apply,
  classifyRoutingTask,
  FLASH_ROUTING_GUIDANCE,
  FLASH_ROUTING_SECTION,
  isComplexRoutingTask,
  isConversationalMessage,
  isGongchuangFlashRoute,
  routingGuideFor,
// @ts-expect-error The shipped preset plugin is intentionally plain ESM loaded by Cordis.
} from '../../../apps/cli/config/agent-presets/gongchuang/flash-routing-guidance.mjs'

const presetRoot = resolve(import.meta.dirname, '../../../apps/cli/config/agent-presets')

describe('DeepSeek Flash routing guidance', () => {
  it('activates for every provider that serves a DeepSeek V4 Flash or Pro model', () => {
    expect(isGongchuangFlashRoute({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })).toBe(true)
    expect(isGongchuangFlashRoute({ provider: 'opencode-go', model: 'deepseek-v4-flash' })).toBe(true)
    expect(isGongchuangFlashRoute({ provider: 'opencode-go', model: 'deepseek-v4-flash-free' })).toBe(true)
    expect(isGongchuangFlashRoute({ provider: 'opencode-go', model: 'deepseek-v4-flash-vision-exp' })).toBe(true)
    expect(isGongchuangFlashRoute({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })).toBe(true)
    expect(isGongchuangFlashRoute({ provider: 'custom-api', model: 'deepseek-v4-flash' })).toBe(true)
    expect(isGongchuangFlashRoute({ provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Flash' })).toBe(true)
    expect(isGongchuangFlashRoute({ provider: 'orgarid', model: 'other-model' })).toBe(false)
    expect(isGongchuangFlashRoute(undefined)).toBe(false)
  })

  it('appends guidance without replacing persona, complete sections, contexts, or tools', () => {
    const persona = { name: 'persona', text: '共创通用 persona' }
    const complete = { name: 'complete', text: '既有提示', complete: true }
    const tools = [{ name: 'skill' }, { name: 'web_search' }]
    const contexts = [{ source: 'ordinary-session' }]
    const assembled = { sections: [persona, complete], tools, contexts }
    const enhanced = appendFlashRoutingGuidance(assembled)
    expect(enhanced).not.toBe(assembled)
    expect(enhanced.sections.slice(0, 2)).toEqual([persona, complete])
    expect(enhanced.sections.at(-1)).toMatchObject({
      name: FLASH_ROUTING_SECTION,
      text: FLASH_ROUTING_GUIDANCE,
    })
    expect(enhanced.tools).toBe(tools)
    expect(enhanced.contexts).toBe(contexts)
    expect(appendFlashRoutingGuidance(enhanced)).toBe(enhanced)
    expect(FLASH_ROUTING_GUIDANCE).toContain('不得把普通任务强行分类为企业专业任务')
    expect(FLASH_ROUTING_GUIDANCE).toContain('所有会被客户端展示的 reasoning_content、Think 摘要')
    expect(FLASH_ROUTING_GUIDANCE).toContain('工具原始错误保持原样')
    expect(FLASH_ROUTING_GUIDANCE).toContain('本增强固定生效')
    expect(FLASH_ROUTING_GUIDANCE).toContain('不得为了显得在工作而执行 echo、whoami、uname')
    expect(FLASH_ROUTING_GUIDANCE).toContain('检查与当前任务相关的集成点和失败路径')
    expect(FLASH_ROUTING_GUIDANCE).toContain('只读、检索和解析操作应在同一工具调用中批量并发')
    expect(FLASH_ROUTING_GUIDANCE).toContain('在一个 run_code 中按依赖顺序连续执行')
    expect(FLASH_ROUTING_GUIDANCE).toContain('不得每成功一个命令就返回模型重新规划')
    expect(FLASH_ROUTING_GUIDANCE).toContain('第二次仍无进展就停止该路径')
    expect(FLASH_ROUTING_GUIDANCE).toContain('不得先尝试 skill、bash、read、write、edit、apply_patch 等未公开根工具')
    expect(FLASH_ROUTING_GUIDANCE).toContain('run_code 中不存在 require、process 或 fs')
    expect(FLASH_ROUTING_GUIDANCE).toContain('tools.read 的结构化结果使用 path、lines 和 totalLines')
    expect(FLASH_ROUTING_GUIDANCE).toContain('文本在 lines[].text，不在 content')
    expect(FLASH_ROUTING_GUIDANCE).toContain('把它作为本轮封闭读取集')
    expect(FLASH_ROUTING_GUIDANCE).toContain('首次工具步骤应同批加载主技能并读取点名输入')
    expect(FLASH_ROUTING_GUIDANCE).toContain('下一步必须生成首份候选成品')
    expect(FLASH_ROUTING_GUIDANCE).toContain('脚本名和命令是执行契约，不是源码阅读许可')
    expect(FLASH_ROUTING_GUIDANCE).toContain('首次执行前禁止读取 scripts、examples、tests、*.example.*、package.json')
    expect(FLASH_ROUTING_GUIDANCE).toContain('不得在单个推理步骤中长篇预演多套假设流程')
    expect(FLASH_ROUTING_GUIDANCE).toContain('gongchuang_render_pdf 是唯一渲染入口')
    expect(FLASH_ROUTING_GUIDANCE).toContain('不得运行技能内的 render_pdf_stdout.js')
    expect(FLASH_ROUTING_GUIDANCE).toContain('显式传 timeoutMs')
    expect(FLASH_ROUTING_GUIDANCE).toContain('不得改成无超时后台运行')
    expect(FLASH_ROUTING_GUIDANCE).toContain('不得删除、替换或绕过这些规则')
  })

  it('classifies ordinary task shapes without converting them into professional domains', () => {
    expect(classifyRoutingTask('请开发一个小说大纲工具')).toBe('构建或创作')
    expect(classifyRoutingTask('Windows 启动时报错，请排查根因并修复')).toBe('修复或诊断')
    expect(classifyRoutingTask('检索政策并核验企业申报条件')).toBe('检索或核验')
    expect(classifyRoutingTask('解释一下光合作用')).toBe('普通问答或组合任务')
    expect(isConversationalMessage('你好！')).toBe(true)
    expect(isConversationalMessage('帮我写一段小说')).toBe(false)
    expect(isComplexRoutingTask('请做一次跨平台端到端架构分析')).toBe(true)
  })

  it('creates continuity-aware near-field guidance that converges without weakening skills', () => {
    const first = routingGuideFor(1, '解释一下光合作用')
    expect(first).toContain('先确认任务类型与交付目标')
    expect(first).toContain('按普通任务直接完成')
    expect(first).toContain('信息足够时立即收束')
    expect(first).toContain('禁止先试 skill、read、write、edit、apply_patch、bash 等未公开根工具')

    const later = routingGuideFor(3, '继续完成跨平台客户端架构，并检查失败路径')
    expect(later).toContain('续接还是新任务')
    expect(later).toContain('复用已确认事实与完成进度')
    expect(later).toContain('边界条件、集成点和失败路径')
    expect(later).toContain('只读操作同批并发')
    expect(later).toContain('继续遵循已经加载的专业技能、证据边界和默认模板')
    expect(later).toContain('不扫描同级目录或旧候选')
    expect(later).toContain('不存在 require、process 或 fs')
    expect(later).toContain('文本在 lines[].text 而不在 content')
    expect(later).toContain('即使工具目录包含 glob')
    expect(later).toContain('随后直接生成')
    expect(later).toContain('脚本名表示执行，不表示读取源码')
    expect(later).toContain('相邻校验、生成、导出和检查')
    expect(later).toContain('客户端生成 PDF 只使用 gongchuang_render_pdf')
    expect(later).toContain('长驻风险命令显式传 timeoutMs')
  })

  it('adds the same non-destructive guidance to Pro and custom DeepSeek V4 routes', async () => {
    const listeners = new Map<string, (...args: any[]) => any>()
    apply({
      on: vi.fn((event: string, candidate: (...args: any[]) => any) => { listeners.set(event, candidate) }),
    })
    const listener = listeners.get('system-prompt/assemble')
    expect(listener).toBeTypeOf('function')
    const assembled = { sections: [{ name: 'persona', text: '共创通用 persona' }], tools: [{ name: 'skill' }] }
    const next = vi.fn(async () => assembled)
    await expect(listener?.({}, { agent: { options: {
      provider: 'deepseek-official', model: 'deepseek-v4-pro',
    } } }, next)).resolves.not.toBe(assembled)
    await expect(listener?.({}, { agent: { options: {
      provider: 'custom-api', model: 'deepseek-v4-flash',
    } } }, next)).resolves.not.toBe(assembled)
  })

  it.each([
    ['deepseek-official', 'deepseek-v4-flash'],
    ['opencode-go', 'deepseek-v4-flash'],
    ['opencode-go', 'deepseek-v4-flash-free'],
    ['opencode-go', 'deepseek-v4-flash-vision-exp'],
    ['deepseek-official', 'deepseek-v4-pro'],
    ['siliconflow', 'deepseek-ai/DeepSeek-V4-Flash'],
  ])('enters the real DSH system prompt for %s/%s', async (provider, model) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '共创通用 persona' })
    apply(ctx)

    const prompt = renderPrompt(await ctx.systemPrompt.assemble({
      agent: { options: { provider, model } } as never,
    }))

    expect(prompt).toContain('共创通用 persona')
    expect(prompt).toContain(FLASH_ROUTING_GUIDANCE)
  })

  it('does not enter the real DSH system prompt for unrelated custom models', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '共创通用 persona' })
    apply(ctx)

    const prompt = renderPrompt(await ctx.systemPrompt.assemble({
      agent: { options: { provider: 'custom-api', model: 'other-model' } } as never,
    }))

    expect(prompt).toContain('共创通用 persona')
    expect(prompt).not.toContain(FLASH_ROUTING_GUIDANCE)
  })

  it('appends one near-field guide to the current pre-step request without changing tools', async () => {
    const listeners = new Map<string, (...args: any[]) => any>()
    const userMessage = {
      id: 'user-3',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '继续修复跨平台客户端，并检查集成点。' }],
    }
    const agent = {
      options: { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    }
    const ctx = {
      on: vi.fn((event: string, listener: (...args: any[]) => any) => { listeners.set(event, listener) }),
    }
    apply(ctx)

    const assembled = { sections: [{ name: 'persona', text: '共创 persona' }], tools: [{ name: 'skill' }] }
    const routed = await listeners.get('system-prompt/assemble')?.({}, { agent }, async () => assembled)
    expect(routed.tools).toBe(assembled.tools)
    const next = vi.fn(async () => ({ kind: 'enter', messages: [userMessage] }))
    const decision = await listeners.get('agent/pre-step')?.({
      agent,
      messages: [userMessage],
      turn: 3,
      step: 1,
      signal: new AbortController().signal,
    }, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[0]).toBe(userMessage)
    expect(decision.messages[1]?.source).toMatchObject({
      kind: 'plugin', plugin: 'gongchuang-flash-routing-guidance',
    })
    expect(decision.messages[1]?.content[0]?.text).toContain('复用已确认事实与完成进度')
    expect(decision.messages[1]?.content[0]?.text).toContain('专业技能、证据边界和默认模板')
    expect([...listeners.keys()]).not.toContain('session/event')
  })

  it('does not add another guide to tool-continuation steps or conversational messages', async () => {
    const listeners = new Map<string, (...args: any[]) => any>()
    const agent = { options: { provider: 'opencode-go', model: 'deepseek-v4-flash' } }
    apply({
      on: vi.fn((event: string, listener: (...args: any[]) => any) => { listeners.set(event, listener) }),
    })
    const preStep = listeners.get('agent/pre-step')
    const continuation = { kind: 'enter', messages: [] }

    await expect(preStep?.({ agent, messages: [], turn: 2, step: 2 }, async () => continuation))
      .resolves.toBe(continuation)

    const hello = {
      id: 'hello', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }],
    }
    const conversational = { kind: 'enter', messages: [hello] }
    await expect(preStep?.({ agent, messages: [hello], turn: 3, step: 1 }, async () => conversational))
      .resolves.toBe(conversational)
  })

  it('ships inside the general gongchuang preset without hiding the skill or web catalogs', () => {
    const composition = readFileSync(resolve(presetRoot, 'gongchuang/agent.cordis.yml'), 'utf8')
    expect(composition).toContain('id: flash-routing-guidance')
    expect(composition).toContain('name: ./flash-routing-guidance.mjs')
    expect(composition).not.toContain('router-bootstrap')
    expect(composition).not.toContain('dsh-super-injector')
    expect(composition).not.toContain('dev_router_')
    expect(composition).not.toContain('dev_mode_')
    expect(composition).toContain('includeDefaultRoots: true')
    expect(composition).toContain('search: true')
    expect(composition).toContain('构造内容')
    expect(composition).toContain('不得绑定从知识库或企业数据工具命中的')
    expect(composition).toContain('capabilities.json 只是历史快照')
    expect(composition).toContain('不得因为它是检索结果第一条就自动选作构造数据的测试样例')
  })
})
