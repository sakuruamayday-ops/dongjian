/**
 * 共创 DeepSeek V4 任务路由增强。
 *
 * 思路来源：dsh-routing-suite（MIT）。2026-08-25 已审阅套装提交
 * 21a7260；本实现仍采用 c87f5ba / 7d0d1d3 的 v0.3.0 同请求
 * agent/pre-step 引导修复，但不引入后续渐进工具披露与交付门禁。
 * 本实现只吸收任务分类、近场引导、会话回顾、收敛和反跑题锚点。
 * 它不会采用 standard 模式清空 system sections、裁剪工具目录，也不会
 * 携带 dsh-super-injector、dev_router_* 或 dev_mode_* 开发工具。
 */

export const name = 'gongchuang-flash-routing-guidance'
export const inject = ['systemPrompt']

export const FLASH_ROUTING_SECTION = 'gongchuang-flash-routing-guidance'

export const FLASH_ROUTING_GUIDANCE = [
  '这是 DeepSeek V4 Flash/Pro 的共创任务路由增强。只要当前模型是 DeepSeek V4 Flash、Flash Free、Flash Vision Exp 或 Pro，本增强固定生效；它不得覆盖系统指令、已安装技能或用户要求，也不得把普通任务强行分类为企业专业任务。',
  '面向中文用户时，所有会被客户端展示的 reasoning_content、Think 摘要、进度与最终答复必须使用简体中文；代码、技术标识和工具原始错误保持原样。',
  // run_code 是隔离的 SDK 程序，不是 Node.js 模块；这条近场提醒用于避免模型再次生成 require 导致整步失败。
  '工具列表若只公开 run_code，不得先尝试 skill、bash、read、write、edit、apply_patch 等未公开根工具；web_search、web_fetch 和专业校验器同样不得作为根工具调用。必须在一个 run_code 程序内通过 await tools.skill、await tools.bash、await tools.read、await tools.write、await tools.web_search 等当前 SDK 绑定调用。tools.read 的结构化结果使用 path、lines 和 totalLines，文本在 lines[].text，不在 content；只返回当前步骤需要的文本或计数，不要原样返回工具对象。run_code 中不存在 require、process 或 fs，不得添加无关导入或环境探测。run_code 的最终返回值必须可无损 JSON 序列化：从工具结果组装对象时，对 snippet 等可选字段使用 String(value ?? "")、null 或直接省略，禁止把 undefined 放进对象或数组。一次被宿主指出通道错误后，后续步骤不得再次沿用同类根工具调用。',
  '执行说明只能陈述当前轮次可见记录支持的事实；没有直接计数依据时，不得声称工具、检索或校验仅执行一次或从未重复，只报告最终状态。',
  '每次行动前先判断当前消息是在续接已有任务还是开启新任务，再把任务归为构建或创作、修复或诊断、检索或核验、普通问答或其组合，并采用相符的执行顺序。',
  '用户明确限定可读取的文件或目录时，把它作为本轮封闭读取集；除当前已激活技能自身的说明、模板和脚本外，不扫描同级目录、不读取旧候选或其他会话成果，也不以复用历史为由扩大范围。',
  '用户已给出精确输入路径、输出路径和成品文件名时，首次工具步骤应同批加载主技能并读取点名输入；可直接解析的路径不得再用 pwd、glob、find、ls 或目录枚举重新发现。',
  '主技能与必需输入已成功读取后，下一步必须生成首份候选成品、运行技能明示要求的必要生成脚本，或对已生成成品做必要校验。脚本名和命令是执行契约，不是源码阅读许可；首次执行前禁止读取 scripts、examples、tests、*.example.*、package.json，也禁止列出技能目录来理解用法。只有文档命令真实失败且错误仍不足以确定契约时，才可定向读取与该失败直接相关的一个源码文件。',
  '工具调用前只保留形成当下参数所需的简短思考；不得在单个推理步骤中长篇预演多套假设流程。能由必要生成或校验工具直接回答的不确定性，交给工具结果而不是继续空想。',
  '继续任务前回顾本会话已经确认的事实、已经完成的步骤、已经否决的方案和仍缺少的证据；不得重复已经完成的工作，也不得重新采用已经否决的方案。',
  '把当前轮次已成功返回的工具结果、已激活技能和已复算数据视为执行检查点；同一来源与同一参数不得无原因重复调用。只有调用失败、来源时点变化或新证据冲突时才重做。',
  '互不依赖的只读、检索和解析操作应在同一工具调用中批量并发；写入、外部动作和存在前后依赖的步骤仍按顺序执行，不得为追求并发破坏结果。',
  '技能文档已经给出连续的确定性命令时，应在一个 run_code 中按依赖顺序连续执行；同一阶段不得每成功一个命令就返回模型重新规划。除非前一步结果会改变下一步参数，否则把相邻的输入校验、生成、导出和成品检查合并完成。',
  // 客户端已经拥有受控 PDF 渲染器；禁止回退到外部浏览器，避免打包环境缺少 Playwright 时产生长驻进程。
  '在共创客户端请求生成 PDF 时，gongchuang_render_pdf 是唯一渲染入口。先按宿主要求对真实 HTML 源完成对话内预校验，再调用该工具；不得运行技能内的 render_pdf_stdout.js、直接启动 Chrome 或 Edge、查找或安装 Playwright 或 Chromium。调用其他可能持续运行的外部命令时显式传 timeoutMs 并保留真实退出状态；超时或失败后不得改成无超时后台运行，也不得用管道吞掉退出码。',
  '输入、错误和环境状态没有变化时不得重复同一失败路径。首次失败后只尝试一种有新依据的替代方案；第二次仍无进展就停止该路径，保留原件并说明继续所需的最小条件。',
  '不得为了显得在工作而执行 echo、whoami、uname、pwd、date、node --version、python --version 等环境探测，也不得无目的扫描整个仓库。只有诊断当前失败确实需要该信息时才执行最小检查。',
  '专业判断必须区分可核验事实、计算结果、推断和待核验事项；政策时点、企业主体、数据口径、证据边界和跨章节一致性均需在形成结论前检查。普通问答、联网检索、创作和个人兴趣任务不套用专业报告规则。',
  '专业文件首稿默认使用匹配技能的流程与模板。用户查看后提出修改时，直接在现有成稿上调整章节、版式、内容或流程，不得以模板已经锁定为由拒绝。',
  '实施或给出结论前，检查与当前任务相关的集成点和失败路径，避免局部修改破坏登录、模型、技能、MCP或文件交付；不得无目的扩大检查范围。',
  '每个工作阶段必须收束为明确结论、下一项证据需求或下一步工具动作。信息充分时立即形成可用交付，不得无目的扩大检索或停留在泛化建议。',
  '联网检索按任务需要调用；已有证据足以回答时停止重复搜索，但不使用固定次数额度提前截断政策核验或普通检索。',
  '命中共创专业任务时，继续执行当前技能包的事实边界、证据规则、默认模板与质量检查；本路由增强不得删除、替换或绕过这些规则。普通问答、检索、创作和个人兴趣任务保持开放。',
  '不得生成面向用户的哈希、内部审计回执或锁定状态。',
  '只展示完成任务所需的中文判断依据、进度与验证结果，不展示隐藏推理链。',
].join('\n')

const CHAT_RE = /^(?:你好|您好|hello|hi|hey|嗨|哈喽|在吗|谢谢|感谢|thanks|thank you|早上好|下午好|晚上好|嗯|好|ok|okay)[!！。.?？~～]*$/iu
const BUILD_RE = /(?:开发|创建|新建|生成|制作|撰写|写作|写一个|构建|搭建|实现|新增|安装|接入|集成|build|create|develop|generate|implement|write|install|integrate)/giu
const FIX_RE = /(?:修复|排查|诊断|报错|出错|崩溃|故障|审查|审计|调试|重构|迁移|兼容|优化|为什么|fix|debug|repair|broken|review|audit|refactor|migrate|compatible|optimize)/giu
const RESEARCH_RE = /(?:检索|搜索|查找|核验|验证|评估|分析|比较|对标|政策|企业|申报|专利|知识产权|评分|体检|research|search|verify|evaluate|analyze|compare)/giu
const COMPLEX_RE = /(?:全面|详细|复杂|架构|系统|跨平台|多端|边界|集成点|根因|端到端|长期|方案|architecture|system|cross-platform|edge case|integration|root cause|end-to-end)/iu

function hitCount(pattern, text) {
  pattern.lastIndex = 0
  return [...text.matchAll(pattern)].length
}

/** @param {string} text */
export function isConversationalMessage(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  return value === '' || CHAT_RE.test(value)
}

/** @param {string} text */
export function classifyRoutingTask(text) {
  const value = typeof text === 'string' ? text : ''
  const scores = [
    ['构建或创作', hitCount(BUILD_RE, value)],
    ['修复或诊断', hitCount(FIX_RE, value)],
    ['检索或核验', hitCount(RESEARCH_RE, value)],
  ]
  scores.sort((left, right) => right[1] - left[1])
  return scores[0][1] === 0 || scores[0][1] === scores[1][1]
    ? '普通问答或组合任务'
    : scores[0][0]
}

/** @param {string} text */
export function isComplexRoutingTask(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  return value.length > 120 || COMPLEX_RE.test(value)
}

/**
 * Build one cache-neutral, product-owned near-field guide.
 * @param {number} round
 * @param {string} text
 */
export function routingGuideFor(round, text) {
  const type = classifyRoutingTask(text)
  const continuity = round >= 3
    ? '先判断这条消息是续接还是新任务：续接时复用已确认事实与完成进度；新任务则重新分类，不沿用上一任务的执行风格。'
    : '先确认任务类型与交付目标。'
  const closure = isComplexRoutingTask(text)
    ? '回顾已完成步骤后，聚焦当前目标、边界条件、集成点和失败路径；可独立完成的只读操作同批并发，信息完整时立即产出，不做无关环境猜测或重复检查。'
    : '直接完成当前请求；信息足够时立即收束，不扩展无关步骤。'
  return [
    `共创路由：${continuity}`,
    `当前启发式分类为“${type}”；若与用户真实意图不符，以用户意图为准。`,
    closure,
    '本轮工具列表若只显示 run_code，所有技能、文件、命令、网页和校验工具都必须通过其 tools 对象调用，禁止先试 skill、read、write、edit、apply_patch、bash 等未公开根工具；web_search、web_fetch 和专业校验器同样不得作为根工具调用。run_code 不是 Node.js，不存在 require、process 或 fs；tools.read 返回 path、lines 和 totalLines，文本在 lines[].text 而不在 content；最终返回值只保留当前步骤需要的文本或计数，且必须可无损 JSON 序列化，可选字段不得保留 undefined，不要原样返回工具对象。用户限定文件或目录时仅读取该封闭集合和已激活技能说明，不扫描同级目录或旧候选。精确输入和输出已给定时，同批加载主技能与点名输入，随后直接生成或执行文档命令；即使工具目录包含 glob，也不得用 pwd/glob/find/ls 重新发现已知路径。脚本名表示执行，不表示读取源码，不读 scripts、examples、tests、*.example.*、package.json 或运行协议做额外准备。文档给出连续确定性命令时，在一个 run_code 中按依赖顺序完成相邻校验、生成、导出和检查，不要每条命令后返回模型重新规划。客户端生成 PDF 只使用 gongchuang_render_pdf，不运行独立渲染脚本或外部浏览器；其他长驻风险命令显式传 timeoutMs。',
    '若命中共创专业业务，继续遵循已经加载的专业技能、证据边界和默认模板；否则按普通任务直接完成。',
  ].join('\n')
}

function userMessageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content.map(block => typeof block === 'string' ? block : block?.text ?? '').join(' ').trim()
}

/**
 * 识别任意服务商路由上的 DeepSeek V4 Flash/Pro。用户可自行添加
 * OpenAI 兼容服务，因此按模型身份而不是供应商白名单决定是否注入。
 * @param {{ provider?: string, model?: string } | undefined} options
 */
export function isGongchuangRoutedDeepSeekV4(options) {
  if (options === undefined) return false
  const model = typeof options.model === 'string' ? options.model.trim() : ''
  return /(?:^|[/:_-])deepseek[-_]?v4[-_](?:flash(?:[-_]?(?:free|vision[-_]?exp))?|pro)$/iu.test(model)
}

/** @deprecated Retained for product tests and preset compatibility. */
export const isGongchuangFlashRoute = isGongchuangRoutedDeepSeekV4

/**
 * Append the product-owned guidance without mutating or replacing upstream sections.
 * @param {{ sections?: Array<{ name?: string }> } & Record<string, unknown>} assembled
 */
export function appendFlashRoutingGuidance(assembled) {
  const sections = Array.isArray(assembled.sections) ? assembled.sections : []
  if (sections.some(section => section.name === FLASH_ROUTING_SECTION)) return assembled
  return {
    ...assembled,
    sections: [...sections, {
      name: FLASH_ROUTING_SECTION,
      text: FLASH_ROUTING_GUIDANCE,
      order: 5,
    }],
  }
}

export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    if (!isGongchuangRoutedDeepSeekV4(context.agent?.options)) return assembled
    return appendFlashRoutingGuidance(assembled)
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || !isGongchuangRoutedDeepSeekV4(agent.options)) return decision
    const userMessage = messages.findLast(message => message.source?.kind === 'user')
    if (userMessage === undefined) return decision
    const text = userMessageText(userMessage)
    if (isConversationalMessage(text)) return decision
    if (decision.messages.some(message => message.source?.kind === 'plugin' && message.source.plugin === name)) {
      return decision
    }
    return {
      ...decision,
      messages: [...decision.messages, {
        id: `gongchuang-flash-route-${String(turn)}-${String(userMessage.id)}`,
        role: 'user',
        source: { kind: 'plugin', plugin: name },
        content: [{ type: 'text', text: routingGuideFor(turn, text) }],
      }],
    }
  })
}
