import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FLASH_ROUTING_GUIDANCE,
  isGongchuangFlashRoute,
  routingGuideFor,
// @ts-expect-error The deployment-owned prompt plugin is intentionally plain ESM.
} from '../config/agent-presets/gongchuang/flash-routing-guidance.mjs'

const matchesFlashRoute = isGongchuangFlashRoute as unknown as (
  options: { provider: string; model: string },
) => boolean
const routeGuide = routingGuideFor as unknown as (round: number, text: string) => string

describe('gongchuang DeepSeek Flash routing guidance', () => {
  it('keeps ordinary conversations outside professional validation', () => {
    expect(FLASH_ROUTING_GUIDANCE).toContain('不得把普通任务强行分类为企业专业任务')
    expect(FLASH_ROUTING_GUIDANCE).toContain('普通问答、检索、创作和个人兴趣任务保持开放')

    const preset = readFileSync(resolve(import.meta.dirname, '../config/agent-presets/gongchuang/agent.cordis.yml'), 'utf8')
    expect(preset).toContain('普通任务直接按用户要求完成')
    expect(preset).toContain('炒股、小说创作、学习、办公或其他领域的技能')
  })

  it('applies to every provider serving a DeepSeek V4 Flash or Pro route', () => {
    expect(matchesFlashRoute({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })).toBe(true)
    expect(matchesFlashRoute({ provider: 'opencode-go', model: 'deepseek-v4-flash' })).toBe(true)
    expect(matchesFlashRoute({ provider: 'opencode-go', model: 'deepseek-v4-flash-free' })).toBe(true)
    expect(matchesFlashRoute({ provider: 'opencode-go', model: 'deepseek-v4-flash-vision-exp' })).toBe(true)
    expect(matchesFlashRoute({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })).toBe(true)
    expect(matchesFlashRoute({ provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Flash' })).toBe(true)
    expect(matchesFlashRoute({ provider: 'opencode-go', model: 'other' })).toBe(false)
  })

  it('locks the reviewed routing anchors into every supported Flash request', () => {
    expect(FLASH_ROUTING_GUIDANCE).toContain('本增强固定生效')
    expect(FLASH_ROUTING_GUIDANCE).toContain('构建或创作、修复或诊断、检索或核验')
    expect(FLASH_ROUTING_GUIDANCE).toContain('不得重复已经完成的工作')
    expect(FLASH_ROUTING_GUIDANCE).toContain('不得为了显得在工作而执行 echo、whoami、uname')
    expect(FLASH_ROUTING_GUIDANCE).toContain('检查与当前任务相关的集成点和失败路径')
    expect(FLASH_ROUTING_GUIDANCE).toContain('只读、检索和解析操作应在同一工具调用中批量并发')
    expect(FLASH_ROUTING_GUIDANCE).toContain('在一个 run_code 中按依赖顺序连续执行')
    expect(FLASH_ROUTING_GUIDANCE).toContain('不得每成功一个命令就返回模型重新规划')
    expect(FLASH_ROUTING_GUIDANCE).toContain('第二次仍无进展就停止该路径')
    expect(FLASH_ROUTING_GUIDANCE).toContain('不得先尝试 skill、bash、read、write、edit、apply_patch 等未公开根工具')
    expect(FLASH_ROUTING_GUIDANCE).toContain('web_search、web_fetch 和专业校验器同样不得作为根工具调用')
    expect(FLASH_ROUTING_GUIDANCE).toContain('最终返回值必须可无损 JSON 序列化')
    expect(FLASH_ROUTING_GUIDANCE).toContain('禁止把 undefined 放进对象或数组')
    expect(FLASH_ROUTING_GUIDANCE).toContain('tools.read 的结构化结果使用 path、lines 和 totalLines')
    expect(FLASH_ROUTING_GUIDANCE).toContain('文本在 lines[].text，不在 content')
    expect(FLASH_ROUTING_GUIDANCE).toContain('把它作为本轮封闭读取集')
    expect(FLASH_ROUTING_GUIDANCE).toContain('首次工具步骤应同批加载主技能并读取点名输入')
    expect(FLASH_ROUTING_GUIDANCE).toContain('下一步必须生成首份候选成品')
    expect(FLASH_ROUTING_GUIDANCE).toContain('脚本名和命令是执行契约，不是源码阅读许可')
    expect(FLASH_ROUTING_GUIDANCE).toContain('首次执行前禁止读取 scripts、examples、tests、*.example.*、package.json')
    expect(FLASH_ROUTING_GUIDANCE).toContain('不得在单个推理步骤中长篇预演多套假设流程')
    expect(FLASH_ROUTING_GUIDANCE).toContain('收束为明确结论、下一项证据需求或下一步工具动作')
    expect(FLASH_ROUTING_GUIDANCE).toContain('专业文件首稿默认使用匹配技能的流程与模板')
    expect(routeGuide(3, '继续完成系统集成')).toContain('续接还是新任务')
    expect(routeGuide(3, '只读取 /tmp/input.csv')).toContain('禁止先试 skill、read、write、edit、apply_patch、bash 等未公开根工具')
    expect(routeGuide(3, '只读取 /tmp/input.csv')).toContain('web_search、web_fetch 和专业校验器同样不得作为根工具调用')
    expect(routeGuide(3, '只读取 /tmp/input.csv')).toContain('可选字段不得保留 undefined')
    expect(routeGuide(3, '只读取 /tmp/input.csv')).toContain('文本在 lines[].text 而不在 content')
    expect(routeGuide(3, '只读取 /tmp/input.csv')).toContain('不扫描同级目录或旧候选')
    expect(routeGuide(3, '读取 /tmp/input.csv 并输出 /tmp/report.pdf')).toContain('随后直接生成')
    expect(routeGuide(3, '读取 /tmp/input.csv 并输出 /tmp/report.pdf')).toContain('相邻校验、生成、导出和检查')
    expect(routeGuide(3, '读取 /tmp/input.csv 并输出 /tmp/report.pdf')).toContain('不读 scripts、examples、tests、*.example.*、package.json')
  })
})
