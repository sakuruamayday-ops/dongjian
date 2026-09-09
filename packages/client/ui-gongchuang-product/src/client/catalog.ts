import type { GongchuangConnectorId } from '@deepseek-ai/dsh-api-remotes/client'

/** One static bundled-skill card shown before Host marketplace data loads. */
export interface SkillCard {
  id: string
  name: string
  description: string
  category: string
  bundled: boolean
}

/** Formal skill-suite version bundled with this client build. */
export const BUNDLED_SKILL_VERSION = '0.1.0'

/** Business-focused skills bundled with the formal suite. */
export const CURATED_SKILLS: readonly SkillCard[] = [
  { id: 'policy-retrieval', name: '政策检索与版本核验', description: '锁定管理办法、申报通知、指南和附件，避免使用过期口径。', category: '政策申报', bundled: true },
  { id: 'enterprise-panorama', name: '企业全景画像', description: '整合工商、知识产权、经营风险和公开信息，形成可追溯企业底稿。', category: '企业服务', bundled: true },
  { id: 'project-matching', name: '项目匹配与可行性', description: '按企业条件匹配可申报方向，并给出差距、证据和行动路径。', category: '政策申报', bundled: true },
  { id: 'high-tech-drafting', name: '高企申请书', description: '按证据边界完成高新技术企业申请书扩表、回填和创新能力撰写。', category: '政策申报', bundled: true },
  { id: 'sme-preassessment', name: '专精特新预评估', description: '执行专精特新与小巨人指标预评估、差距测算和培育规划。', category: '政策申报', bundled: true },
  { id: 'ip-assessment', name: '知识产权评估', description: '区分授权、审中和转让取得，核对权利稳定性与项目关联。', category: '知识产权', bundled: true },
  { id: 'financial-verification', name: '财务指标复核', description: '复算营收、研发投入和专项指标，保留公式、口径和来源。', category: '财税核验', bundled: true },
  { id: 'consistency-check', name: '申报一致性检查', description: '检查数字、时间线、产品、知识产权与附件之间的跨表一致性。', category: '质量检查', bundled: true },
  { id: 'patent-review', name: '中国专利核稿', description: '检查专利申请文件的技术逻辑、权利要求和格式问题。', category: '知识产权', bundled: true },
  { id: 'evidence-ledger', name: '证据台账', description: '把事实、计算、推断和待核验事项拆分管理，降低材料漂移。', category: '质量检查', bundled: true },
  { id: 'document-delivery', name: '文档与表格交付', description: '生成并逐页验收 Word、Excel、PPT 和 PDF 正式文件。', category: '办公交付', bundled: true },
  { id: 'policy-monitor', name: '政策监测', description: '按地区和项目方向跟踪新通知、转正和截止日期变化。', category: '政策申报', bundled: true },
]

/** Built-in domestic community-market entry points. */
export const COMMUNITY_REPOSITORIES = [
  { id: 'modelscope', name: '魔搭 ModelScope', description: '国内可访问的模型与智能体社区，支持浏览后添加兼容技能。', url: 'https://modelscope.cn/' },
  { id: 'skillhub', name: '腾讯 SkillHub', description: '腾讯技能社区入口，可在客户端内直接浏览和安装。', url: 'https://skillhub.cn/' },
] as const

interface McpCard {
  readonly id: GongchuangConnectorId
  readonly name: string
  readonly description: string
  readonly status: string
  readonly url: string
  readonly dataBoundary?: string
}

interface ConnectorSetup {
  readonly platform: string
  readonly guide: string
  readonly officialLinkLabel: string
  readonly credentialLabel: string
  readonly credentialPlaceholder: string
  readonly verification: string
  readonly remoteDataConsent?: string
  readonly submitLabel?: string
}

/** Fixed connector cards and their official configuration destinations. */
export const MCP_CARDS: readonly McpCard[] = [
  { id: 'gongchuang-search', name: '联网检索 MCP', description: '统一编排检索、网页读取、来源记录和政策证据链。', status: '内置', url: '' },
  { id: 'gongchuang-knowledge', name: '知识库', description: '检索政策、资料与业务知识。添加微信获取知识库接入信息。', status: '需配置', url: '' },
  { id: 'tianyancha', name: '天眼查 MCP', description: '连接天眼查官方 MCP；入口工具负责主体锚定，162 项业务能力按需下钻。', status: '需配置', url: 'https://www.tianyancha.com/ai' },
  { id: 'qcc', name: '企查查 MCP', description: '连接企查查官方核心 MCP 服务，覆盖企业、风险、知识产权、经营、人员、法规、案例、招投标与文档。', status: '需配置', url: 'https://agent.qcc.com' },
  {
    id: 'paddle-ocr',
    name: 'PaddleOCR MCP',
    description: '连接可用的 PaddleOCR MCP，识别扫描件、图片与复杂 PDF。',
    status: '需配置',
    url: 'https://aistudio.baidu.com/account/accessToken',
    dataBoundary: '当前使用百度 AI Studio 官方 API；执行 OCR 时，所选图片或扫描 PDF 会上传到该服务。',
  },
]

/** Credential labels, verification rules, and data disclosures for fixed connectors. */
export const CONNECTOR_SETUPS: Readonly<Partial<Record<GongchuangConnectorId, ConnectorSetup>>> = {
  qcc: {
    platform: '企查查 MCP',
    guide: '推荐直接登录企查查并授权；如果官方授权页暂时不可用，也可以在这里粘贴 API Key 或完整 MCP 配置。',
    officialLinkLabel: '打开企查查 MCP',
    credentialLabel: '企查查 API Key',
    credentialPlaceholder: '粘贴企查查 MCP 提供的 API Key',
    verification: '客户端会连接企查查官方 MCP。只有凭据校验成功并发现至少一个工具，状态才会变为“已就绪”。',
  },
  tianyancha: {
    platform: '天眼 AI',
    guide: '推荐登录天眼 AI 完成官方设备授权；API Key 仅作为兼容入口。免费接入按账号额度计次。',
    officialLinkLabel: '打开天眼 AI',
    credentialLabel: '天眼 AI API Key',
    credentialPlaceholder: '粘贴天眼 AI 提供的 API Key',
    verification: '客户端会连接天眼查官方 Streamable HTTP MCP。只有鉴权成功并发现入口工具，状态才会变为“已就绪”。',
  },
  'paddle-ocr': {
    platform: '百度 AI Studio',
    guide: '登录百度 AI Studio，在账户页面创建 Access Token。客户端不会通过网页自动读取账号或 Token。',
    officialLinkLabel: '打开 AI Studio Access Token 页面',
    credentialLabel: '百度 AI Studio Access Token',
    credentialPlaceholder: '粘贴 AI Studio Access Token',
    verification: '客户端先向百度 AI Studio 官方 API 校验 Token，不上传任何文件；随后连接 PaddleOCR MCP 并执行 tools/list。只有凭据有效且发现 OCR 工具，状态才会变为“已就绪”。',
    remoteDataConsent: '我已知晓：启用后，只有我明确提交给 OCR 的图片或扫描 PDF 会上传到百度 AI Studio 官方 API；企业资料不会因连接验证而自动上传。',
    submitLabel: '授权并连接',
  },
}

/** Reversible starter definitions for local recurring tasks. */
export const AUTOMATION_TEMPLATES = [
  {
    id: 'policy-watch', name: '政策更新监测', description: '检查企业所在地区与重点项目类别的通知变化。',
    cadence: '每 24 小时', everySeconds: 86_400,
    prompt: '检查本企业空间已记录的地区与重点项目类别是否出现新通知、更正、延期或申报状态变化。优先核验政府官方原文，输出变化摘要、来源链接、访问时间和待办事项。',
  },
  {
    id: 'enterprise-risk', name: '企业风险复查', description: '复核工商、司法和知识产权风险变化。',
    cadence: '每 7 天', everySeconds: 604_800,
    prompt: '依据本企业空间的主体身份，复核工商、司法、经营异常和知识产权风险是否变化。只报告可追溯的新变化，记录数据来源与核验时间，不用历史快照冒充当前结论。',
  },
  {
    id: 'material-check', name: '材料一致性巡检', description: '巡检项目目录中的数字、名称、附件和版本。',
    cadence: '每 12 小时', everySeconds: 43_200,
    prompt: '检查本企业空间当前项目材料的数字、主体名称、项目版本、知识产权状态、时间线和附件引用是否一致。只列出新发现或仍未关闭的问题，并给出文件定位。',
  },
] as const
