/** Trusted MCP and enterprise-data connector manager for 洞见. */

import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialInfo } from '@deepseek-ai/dsh-credentials'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { McpConnectionState } from '@deepseek-ai/dsh-mcp-client'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  GONGCHUANG_PADDLEOCR_MCP_VERSION,
  type GongchuangSkillRuntimeBinding,
} from '@gongchuang/signed-skill-runtime'
import type {
  GongchuangConnectorAuthorizationCompleteRequest,
  GongchuangConnectorAuthorizationStart,
  GongchuangConnectorAuthorizationStartRequest,
  GongchuangConnectorConfigureRequest,
  GongchuangConnectorEnableRequest,
  GongchuangConnectorId,
  GongchuangConnectorPhase,
  GongchuangConnectorSnapshot,
  GongchuangConnectorView,
  GongchuangCustomConnectorId,
  GongchuangCustomMcpAuthMode,
  GongchuangCustomMcpRemoveRequest,
  GongchuangCustomMcpTransport,
  GongchuangCustomMcpUpsertRequest,
  GongchuangRegionId,
  GongchuangRegionSetRequest,
} from './types.ts'
import { mergeLongScreenshotText, splitLongScreenshot } from './long-screenshot.ts'
import { normalizeOcrPages, selectOcrPdfPages } from './pdf-pages.ts'
import { QccOAuthCoordinator } from './qcc-oauth.ts'
import { TianyanchaOAuthCoordinator } from './tianyancha-oauth.ts'
import { GongchuangExaMcpSearchProvider } from './exa-mcp-search.ts'

export * from './exa-mcp-search.ts'

export type * from './types.ts'

interface CustomMcpConfig {
  id: GongchuangCustomConnectorId
  name: string
  serverName: string
  transport: GongchuangCustomMcpTransport
  url: string
  command: string
  args: string[]
  cwd: string
  authMode: GongchuangCustomMcpAuthMode
  credentialName: string
  credentialPrefix: string
}

interface ConnectorSettings {
  enabled: string[]
  knowledgeEndpoint: string
  region: GongchuangRegionId
  regionConfirmed: boolean
  custom: CustomMcpConfig[]
}

interface Config {
  /** Public User-Agent sent to official connector endpoints. */
  userAgent: string
}

interface ConnectorDefinition {
  id: GongchuangConnectorId
  name: string
  credentialRef?: string
  officialConfigUrl: string
  prefix: string
  verificationMethod: string
  custom?: CustomMcpConfig
}

interface OwnedMount {
  dispose(): Promise<void>
}

interface AuthorizationAttempt {
  readonly transactionId: string
  readonly controller: AbortController
  running: Promise<unknown>
  completion?: Promise<GongchuangConnectorSnapshot>
  verifying: boolean
  rollbackError?: Error
}

const NS = 'gongchuang-connectors'
const CUSTOM_MCP_ID_SCHEMA = s.transform(s.string().required(), (value) => {
  if (!CUSTOM_ID_PATTERN.test(value)) throw new Error('自定义 MCP 标识无效')
  return value
})
const CUSTOM_MCP_SCHEMA: s<CustomMcpConfig> = s.object({
  id: CUSTOM_MCP_ID_SCHEMA,
  name: s.string().required(),
  serverName: s.string().required(),
  transport: s.union(['streamable-http', 'stdio'] as const).required(),
  url: s.string().default(''),
  command: s.string().default(''),
  args: s.array(String).default([]),
  cwd: s.string().default(''),
  authMode: s.union(['none', 'bearer', 'header', 'env'] as const).default('none'),
  credentialName: s.string().default(''),
  credentialPrefix: s.string().default(''),
})
const CONFIG_SCHEMA: s<ConnectorSettings> = s.object({
  enabled: s.array(String)
    .default(['gongchuang-search']),
  knowledgeEndpoint: s.string().default(''),
  region: s.union(['all', 'hangzhou', 'shaoxing', 'jinhua', 'ningbo'] as const).default('all'),
  regionConfirmed: s.boolean().default(false),
  custom: s.array(CUSTOM_MCP_SCHEMA).default([]),
})
const DEFINITIONS: readonly ConnectorDefinition[] = [
  {
    id: 'qcc', name: '企查查 MCP', credentialRef: 'QCC_MCP_API_KEY',
    officialConfigUrl: 'https://agent.qcc.com/profile/api-key', prefix: 'mcp__qcc_',
    verificationMethod: '连接官方 MCP 并执行 tools/list；部分无权限服务会单独标明，不影响其他可用服务。',
  },
  {
    id: 'tianyancha', name: '天眼查数据连接器', credentialRef: 'TYC_API_TOKEN',
    officialConfigUrl: 'https://www.tianyancha.com/ai', prefix: 'mcp__tianyancha__',
    verificationMethod: '连接天眼查官方 Streamable HTTP MCP 并执行 tools/list；深层业务能力通过能力目录与代理工具按需调用。',
  },
  {
    id: 'paddle-ocr', name: 'PaddleOCR MCP', credentialRef: 'PADDLEOCR_AISTUDIO_ACCESS_TOKEN',
    officialConfigUrl: 'https://aistudio.baidu.com/account/accessToken', prefix: 'mcp__paddle_ocr__',
    verificationMethod: '先校验百度 AI Studio 官方 API 鉴权，再连接 PaddleOCR MCP 并执行 tools/list。',
  },
  {
    id: 'gongchuang-search', name: '联网检索 MCP',
    officialConfigUrl: '', prefix: 'mcp__gongchuang_search__',
    verificationMethod: '核验 web_search、web_fetch 与共创证据检索编排工具均已真实注册。',
  },
  {
    id: 'gongchuang-knowledge', name: '知识库 MCP', credentialRef: 'DONGJIAN_KNOWLEDGE_MCP_TOKEN',
    officialConfigUrl: '', prefix: 'mcp__gongchuang_knowledge__',
    verificationMethod: '使用单独配置的 MCP 地址与访问凭据连接知识库并执行 tools/list。',
  },
]

const CUSTOM_ID_PATTERN = /^custom-[a-f0-9]{12}$/u
const CUSTOM_SERVER_PATTERN = /^gc_[a-f0-9]{12}$/u
const CUSTOM_CREDENTIAL_PREFIX = 'GONGCHUANG_CUSTOM_MCP_'
const BUILT_IN_CONNECTOR_IDS = new Set<string>(DEFINITIONS.map(definition => definition.id))

function isCustomConnectorId(id: string): id is GongchuangCustomConnectorId {
  return CUSTOM_ID_PATTERN.test(id)
}

function isConnectorId(id: string): id is GongchuangConnectorId {
  return BUILT_IN_CONNECTOR_IDS.has(id) || isCustomConnectorId(id)
}

function customCredentialName(id: GongchuangCustomConnectorId): string {
  return `${CUSTOM_CREDENTIAL_PREFIX}${id.slice('custom-'.length).toUpperCase()}`
}

function customDefinition(config: CustomMcpConfig): ConnectorDefinition {
  return {
    id: config.id,
    name: config.name,
    ...(config.authMode === 'none' ? {} : { credentialRef: customCredentialName(config.id) }),
    officialConfigUrl: '',
    prefix: `mcp__${config.serverName}__`,
    verificationMethod: config.transport === 'streamable-http'
      ? '连接用户配置的 Streamable HTTP MCP 并执行 tools/list；至少发现一个工具才标记为已就绪。'
      : '启动用户配置的本机 stdio MCP 并执行 tools/list；至少发现一个工具才标记为已就绪。',
    custom: config,
  }
}

function cleanText(value: string | undefined, label: string, maximum: number): string {
  const normalized = value?.trim() ?? ''
  if (normalized.length > maximum || /[\0\r\n]/u.test(normalized)) throw new Error(`${label}格式无效`)
  return normalized
}

/**
 * Perform the normalize custom mcp request operation.
 * @param request - The request value.
 * @param current - The current value.
 * @returns The normalize custom mcp request result.
 */
export function normalizeCustomMcpRequest(
  request: GongchuangCustomMcpUpsertRequest,
  current?: CustomMcpConfig,
): CustomMcpConfig {
  const name = cleanText(request.name, 'MCP 名称', 60)
  if (name === '') throw new Error('MCP 名称不能为空')
  const id = request.id ?? `custom-${randomUUID().replaceAll('-', '').slice(0, 12)}`
  if (!isCustomConnectorId(id)) throw new Error('自定义 MCP 标识无效')
  const serverName = current?.serverName ?? `gc_${id.slice('custom-'.length)}`
  if (!CUSTOM_SERVER_PATTERN.test(serverName)) throw new Error('自定义 MCP 工具命名空间无效')
  const authMode = request.authMode
  const credentialPrefix = cleanText(request.credentialPrefix, '凭据前缀', 80)
  const args = [...(request.args ?? [])].map((argument) => {
    if (typeof argument !== 'string' || argument.length > 2_048 || argument.includes('\0')) throw new Error('MCP 启动参数格式无效')
    return argument
  })
  if (args.length > 64) throw new Error('MCP 启动参数不能超过 64 项')
  if (request.transport === 'streamable-http') {
    const url = cleanText(request.url, 'MCP 地址', 2_048)
    let parsed: URL
    try { parsed = new URL(url) } catch (error) { throw new Error('MCP 地址不是有效 URL', { cause: error }) }
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new Error('远程 MCP 必须使用 HTTPS；本机 localhost 可使用 HTTP')
    }
    if (authMode === 'env') throw new Error('Streamable HTTP MCP 不支持环境变量鉴权，请选择 Bearer 或自定义请求头')
    const credentialName = authMode === 'bearer'
      ? 'Authorization'
      : authMode === 'header'
        ? cleanText(request.credentialName, '请求头名称', 80)
        : ''
    if (authMode === 'header' && !/^[A-Za-z0-9-]+$/u.test(credentialName)) throw new Error('自定义请求头名称格式无效')
    return {
      id, name, serverName, transport: request.transport, url: parsed.toString(), command: '', args: [], cwd: '',
      authMode, credentialName, credentialPrefix: authMode === 'bearer' && credentialPrefix === '' ? 'Bearer ' : credentialPrefix,
    }
  }
  if (authMode === 'bearer' || authMode === 'header') throw new Error('stdio MCP 只能选择无鉴权或环境变量鉴权')
  const command = cleanText(request.command, 'MCP 启动命令', 2_048)
  if (command === '') throw new Error('stdio MCP 启动命令不能为空')
  const cwd = cleanText(request.cwd, 'MCP 工作目录', 4_096)
  const credentialName = authMode === 'env' ? cleanText(request.credentialName, '环境变量名', 80) : ''
  if (authMode === 'env' && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(credentialName)) throw new Error('凭据环境变量名格式无效')
  return {
    id, name, serverName, transport: request.transport, url: '', command, args, cwd,
    authMode, credentialName, credentialPrefix: '',
  }
}

const QCC_ENDPOINTS = [
  ['qcc_company', 'https://agent.qcc.com/mcp/company/stream'],
  ['qcc_risk', 'https://agent.qcc.com/mcp/risk/stream'],
  ['qcc_ipr', 'https://agent.qcc.com/mcp/ipr/stream'],
  ['qcc_operation', 'https://agent.qcc.com/mcp/operation/stream'],
  ['qcc_history', 'https://agent.qcc.com/mcp/history/stream'],
  ['qcc_executive', 'https://agent.qcc.com/mcp/executive/stream'],
  ['qcc_legal_regulation', 'https://agent.qcc.com/mcp/regulation/stream'],
  ['qcc_legal_case', 'https://agent.qcc.com/mcp/case/stream'],
  ['qcc_tender', 'https://agent.qcc.com/mcp/tender/stream'],
  ['qcc_document', 'https://agent.qcc.com/mcp/document/stream'],
] as const

const QCC_OPTIONAL_SERVERS = new Set(['qcc_history'])

const MAX_OCR_TEXT_CHARS = 120_000
const MAX_OCR_CHUNK_CACHE_ENTRIES = 64
const MAX_OCR_PDF_BYTES = 24 * 1024 * 1024
const OCR_LIMITATIONS = '文字识别由官方 PaddleOCR MCP 调用百度 AI Studio 云端接口完成，不是本地推理；客户端只在本机执行长图切片、结果去重与缓存。OCR 已完成，无需重新查找或读取工作区中的原图，除非用户明确要求二次核验。OCR 仅提取可见文字，不能可靠判断图表趋势、空间关系、颜色含义、物体状态或其他非文字视觉信息；长截图会先在本机按低内容区域切片，并仅删除完全相同的重叠文字，边界仍需结合原图复核；涉及非文字内容时请切换到支持图片的模型。'
const PADDLE_CREDENTIAL_CHECK_URL = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs/gongchuang-credential-check'
const PADDLE_CREDENTIAL_CHECK_TIMEOUT_MS = 10_000

interface ConnectorImageInput {
  readonly type: 'image'
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly data: string
  readonly name?: string
}

interface ConnectorImageFallback {
  readonly text: string
  readonly method: 'ocr'
  readonly limitations: string
}

/** Validated PDF copy loaded only from the current concrete enterprise workspace. */
export interface WorkspacePdfForOcr {
  readonly name: string
  readonly bytes: Uint8Array
  readonly sha256: string
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

/**
 * Load a bounded ordinary PDF beneath one already-authenticated workspace.
 * @param workspacePath - Absolute workspace path from the active Agent session.
 * @param documentPath - Workspace-relative path supplied to the model tool.
 * @returns Immutable bytes and identity safe to submit to the configured OCR service.
 */
export function loadWorkspacePdfForOcr(workspacePath: string, documentPath: string): WorkspacePdfForOcr {
  if (!isAbsolute(workspacePath) || documentPath.length === 0 || documentPath.length > 4_096
    || isAbsolute(documentPath) || documentPath.includes('\0')) {
    throw new Error('扫描 PDF 路径无效')
  }
  const rootInfo = lstatSync(workspacePath)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('当前企业空间必须是真实目录')
  const root = realpathSync(workspacePath)
  const candidate = resolve(root, documentPath)
  const fileInfo = lstatSync(candidate)
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) throw new Error('扫描 PDF 必须是普通文件且不能是链接')
  const canonical = realpathSync(candidate)
  if (!contained(root, canonical)) throw new Error('扫描 PDF 越出当前企业空间')
  if (extname(canonical).toLowerCase() !== '.pdf') throw new Error('扫描识别只接受 PDF 文件')
  const size = statSync(canonical).size
  if (size <= 0 || size > MAX_OCR_PDF_BYTES) {
    throw new Error(`扫描 PDF 必须大于 0 且不超过 ${String(MAX_OCR_PDF_BYTES / 1024 / 1024)} MB；请拆分后重试`)
  }
  const bytes = new Uint8Array(readFileSync(canonical))
  if (Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') throw new Error('文件扩展名为 PDF，但内容不是有效 PDF')
  return Object.freeze({
    name: basename(canonical),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}

function copyView(view: GongchuangConnectorView): GongchuangConnectorView {
  return Object.freeze({
    ...view,
    tools: Object.freeze(view.tools.map(tool => Object.freeze({ ...tool }))),
  })
}

function safeCredential(value: string, label: string): string {
  const normalized = value.trim().replace(/^['"]|['"]$/gu, '')
  if (normalized === '' || normalized.length > 8_192 || /[\0\r\n]/u.test(normalized)) {
    throw new Error(`${label}格式无效，请重新从官方平台复制`)
  }
  return normalized
}

function qccCredential(value: string): string {
  const raw = value.trim()
  if (raw.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error) {
      throw new Error('企查查配置 JSON 无法解析，请复制官方 API Key 或完整 MCP 配置', { cause: error })
    }
    const candidates = new Set<string>()
    const visit = (node: unknown): void => {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) return
      for (const [key, entry] of Object.entries(node)) {
        if (key.toLowerCase() === 'authorization' && typeof entry === 'string') {
          const hit = entry.match(/^\s*Bearer\s+(.+?)\s*$/iu)
          if (hit?.[1] !== undefined) candidates.add(safeCredential(hit[1], '企查查 API Key'))
        } else {
          visit(entry)
        }
      }
    }
    visit(parsed)
    if (candidates.size !== 1) {
      throw new Error(candidates.size === 0
        ? '完整配置中没有找到 Authorization: Bearer API Key'
        : '完整配置中包含多个不同的企查查 API Key，请只保留一个')
    }
    return [...candidates][0] as string
  }
  const header = raw.match(/^(?:Authorization\s*:\s*)?Bearer\s+(.+?)\s*$/iu)
  return safeCredential(header?.[1] ?? raw, '企查查 API Key')
}

/**
 * Normalize the official copy formats accepted by each connector setup form.
 * @param id - Connector whose credential syntax must be recognized.
 * @param value - User-pasted official credential or wrapper text.
 * @returns Normalized credential written only to the system credential service.
 */
export function normalizeConnectorCredential(id: GongchuangConnectorId, value: string): string {
  if (id === 'qcc') return qccCredential(value)
  if (id === 'tianyancha') {
    const raw = value.trim()
    const header = raw.match(/^(?:Authorization\s*:\s*)?(?:Bearer\s+)?(.+?)\s*$/iu)
    return safeCredential(header?.[1] ?? raw, '天眼查访问 Token')
  }
  if (id === 'paddle-ocr') return safeCredential(value, '百度 AI Studio Access Token')
  if (id === 'gongchuang-knowledge') return safeCredential(value, '知识库 MCP 访问凭据')
  throw new Error('该连接器不接受手动密钥')
}

/**
 * Convert opaque MCP transport failures into a stable, credential-free diagnosis.
 * @param errors - Connector startup failures with secrets already excluded.
 * @returns Stable user-facing failure message and product error code.
 */
export function qccConnectionFailureMessage(errors: readonly unknown[]): string {
  const diagnostic = errors.map(error => error instanceof Error ? `${error.name}: ${error.message}` : String(error)).join('\n')
  if (/\b401\b|invalid[_ -]?token|unauthori[sz]ed|身份凭证|鉴权失败/iu.test(diagnostic)) {
    return '企查查 API Key 未通过官方鉴权，请在个人中心复制最新 Key 后重试（错误代码：QCC_AUTH_FAILED）'
  }
  if (/\b403\b|forbidden|无权限|permission/iu.test(diagnostic)) {
    return '企查查已识别 API Key，但当前账号没有可用服务或积分权限（错误代码：QCC_PERMISSION_DENIED）'
  }
  if (/\b404\b|not found/iu.test(diagnostic)) {
    return '企查查官方 MCP 地址当前未返回服务，请稍后重试（错误代码：QCC_ENDPOINT_UNAVAILABLE）'
  }
  return '企查查核心 MCP 服务均连接失败，请检查网络、API Key 与平台服务状态（错误代码：QCC_CONNECTION_FAILED）'
}

function errorChainText(error: unknown): string {
  const messages: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) {
      messages.push(`${current.name}: ${current.message}`)
      current = current.cause
      continue
    }
    messages.push(typeof current === 'string' ? current : 'Unknown connector failure')
    break
  }
  return messages.join('\n')
}

/** Convert connector startup failures into stable Chinese, credential-free messages.
 * @param id - The id value.
 * @param error - The error value.
 * @returns The connector connection failure message result.
 */
export function connectorConnectionFailureMessage(id: GongchuangConnectorId, error: unknown): string {
  const diagnostic = errorChainText(error)
  if (/错误代码：[A-Z0-9_]+/u.test(diagnostic)) {
    return error instanceof Error ? error.message : String(error)
  }
  if (id === 'paddle-ocr') {
    if (/paddle_static|paddlepaddle[^\n]*not installed|failed to create paddleocr inference/iu.test(diagnostic)) {
      return 'PaddleOCR 云端 MCP 错误回退到了本地推理引擎；这属于客户端启动配置问题，不需要安装本地 Paddle 推理包，请重启或更新客户端后重试（错误代码：PADDLE_CLOUD_MODE_CONFIG_FAILED）'
    }
    if (/timeout|timed out|aborted|超时/iu.test(diagnostic)) {
      return 'PaddleOCR 本机 MCP 启动或工具调用超时；Access Token 鉴权会单独提示，请重试或查看连接详情（错误代码：PADDLE_MCP_TIMEOUT）'
    }
    return 'PaddleOCR Access Token 已完成单独验证，但本机 MCP 启动、工具发现或调用失败，请查看连接详情后重试（错误代码：PADDLE_MCP_CONNECTION_FAILED）'
  }
  if (id === 'tianyancha') {
    if (/quota_exceeded|\b429\b|额度(?:不足|耗尽|已用完)|rate.?limit/iu.test(diagnostic)) {
      return '天眼查账号调用额度已用完；MCP 与 CLI 共用额度，请等待额度重置或在官方页面查看权益（错误代码：TYC_QUOTA_EXCEEDED）'
    }
    if (/\b401\b|invalid[_ -]?token|unauthori[sz]ed|鉴权失败/iu.test(diagnostic)) {
      return '天眼查登录授权或 API Key 已失效，请重新登录授权（错误代码：TYC_AUTH_FAILED）'
    }
    return '天眼查连接验证失败，请检查访问 Token、网络与官方服务状态（错误代码：TYC_CONNECTION_FAILED）'
  }
  if (id === 'gongchuang-knowledge') {
    return '知识库连接失败，请检查 MCP 地址、访问凭据和服务状态（错误代码：DONGJIAN_KB_CONNECTION_FAILED）'
  }
  if (id === 'gongchuang-search') {
    return '联网检索未就绪，请检查内置搜索与网页读取能力（错误代码：GONGCHUANG_SEARCH_UNAVAILABLE）'
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Verify that AI Studio accepts a PaddleOCR token without creating an OCR job.
 * The intentionally unknown job id reaches the authenticated status endpoint;
 * 400/404 therefore mean the credential passed authentication, while 401/403
 * are an explicit credential rejection.
 * @param token - The token value.
 * @param fetchImpl - The fetch impl value.
 */
export async function verifyPaddleOfficialCredential(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let response: Response
  try {
    response = await fetchImpl(PADDLE_CREDENTIAL_CHECK_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(PADDLE_CREDENTIAL_CHECK_TIMEOUT_MS),
    })
  } catch (error) {
    if (/timeout|timed out|aborted/iu.test(errorChainText(error))) {
      throw new Error('PaddleOCR 官方鉴权验证超时，请检查网络后重试（错误代码：PADDLE_VERIFY_TIMEOUT）', { cause: error })
    }
    throw new Error('PaddleOCR 官方鉴权服务暂不可达，请检查网络后重试（错误代码：PADDLE_SERVICE_UNAVAILABLE）', { cause: error })
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('PaddleOCR Access Token 未通过百度 AI Studio 官方鉴权，请复制最新 Token 后重试（错误代码：PADDLE_AUTH_FAILED）')
  }
  if (response.status === 429) {
    throw new Error('PaddleOCR 官方服务已识别账号，但当前请求受额度或频率限制（错误代码：PADDLE_RATE_LIMITED）')
  }
  if (response.status >= 500) {
    throw new Error('PaddleOCR 官方服务暂不可用，请稍后重试（错误代码：PADDLE_SERVICE_UNAVAILABLE）')
  }
}

function textFromContent(content: readonly { type: string; text?: string }[]): string {
  return content.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text ?? '').join('\n')
}

/**
 * Fixed PaddleOCR subprocess contract over the already verified product
 * Python tree. First use never downloads or resolves an executable from PATH.
 * @param binding - Host-verified skill and embedded-runtime identity.
 * @returns Fixed stdio configuration for the reviewed PaddleOCR MCP module.
 */
export function paddleMcpConfig(binding: GongchuangSkillRuntimeBinding): McpClient.StdioConfig {
  if (binding.runtimeIntegrity !== 'signed'
    || binding.paddleOcrMcpVersion !== GONGCHUANG_PADDLEOCR_MCP_VERSION
    || !isAbsolute(binding.pythonExecutable)
    || !/^[0-9a-f]{64}$/u.test(binding.pythonExecutableSha256)
    || !/^[0-9a-f]{64}$/u.test(binding.runtimeIndexSha256)) {
    throw new Error('PaddleOCR MCP 未绑定到当前已签名产品运行时')
  }
  return {
    transport: 'stdio',
    serverName: 'paddle_ocr',
    command: binding.pythonExecutable,
    // Keep the cloud provider in argv as well as env. The upstream module
    // defaults to the local Paddle engine when the provider setting is absent;
    // that fallback requires paddlepaddle and must never be selected by the
    // desktop cloud connector. Explicit argv also survives hosts that sanitize
    // non-credential environment entries before spawning an MCP process.
    args: [
      '-B', '-E', '-s', '-m', 'paddleocr_mcp',
      '--model', 'PP-OCRv5',
      '--ppocr_source', 'aistudio',
    ],
    env: {
      PADDLEOCR_MCP_MODEL: 'PP-OCRv5',
      PADDLEOCR_MCP_PIPELINE: 'OCR',
      PADDLEOCR_MCP_PPOCR_SOURCE: 'aistudio',
    },
    envCredentials: { PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: 'PADDLEOCR_AISTUDIO_ACCESS_TOKEN' },
    cwd: dirname(binding.pythonExecutable),
    toolCallTimeoutMs: 120_000,
    failOnStartupError: true,
    reconnect: { enabled: true, initialDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5 },
  }
}

/** Build the authenticated knowledge MCP transport with its enforced default region.
 * @param portalUrl - The portal url value.
 * @param region - The region value.
 * @returns The gongchuang knowledge mcp config result.
 */
export function gongchuangKnowledgeMcpConfig(
  portalUrl: string,
  region: GongchuangRegionId,
): McpClient.StreamableHttpConfig {
  return {
    transport: 'streamable-http',
    serverName: 'gongchuang_knowledge',
    url: portalUrl,
    headers: { 'X-Jiaotang-Region': region },
    headerCredentials: {
      Authorization: { ref: 'DONGJIAN_KNOWLEDGE_MCP_TOKEN', prefix: 'Bearer ' },
    },
    toolCallTimeoutMs: 60_000,
    failOnStartupError: true,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
  }
}

/** Build the current official Tianyancha remote MCP transport.
 * @returns The tianyancha mcp config result.
 */
export function tianyanchaMcpConfig(): McpClient.StreamableHttpConfig {
  return {
    transport: 'streamable-http',
    serverName: 'tianyancha',
    url: 'https://mcp.tianyancha.com/mcp',
    headers: {},
    headerCredentials: {
      Authorization: { ref: 'TYC_API_TOKEN', prefix: '' },
    },
    toolCallTimeoutMs: 60_000,
    failOnStartupError: true,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
  }
}

/** Host service and generated Remote namespace `gongchuangConnectors`. */
export class GongchuangConnectorService extends TypertRemoteService {
  static inject = ['settings', 'credentials', 'tools', 'web']

  static Config: s<Config> = s.object({
    userAgent: s.string().default('gongchuang-enterprise-assistant'),
  })

  private settingsScope?: SettingsScope<ConnectorSettings>
  private readonly statuses = new Map<GongchuangConnectorId, GongchuangConnectorView>()
  private readonly mounts = new Map<GongchuangConnectorId, OwnedMount[]>()
  private readonly connectionNotes = new Map<GongchuangConnectorId, { message: string; partial: boolean }>()
  private readonly connectionHealth = new Map<string, McpConnectionState>()
  private readonly verifiedAt = new Map<GongchuangConnectorId, string>()
  private revision = 0
  private reconcileTail: Promise<void> = Promise.resolve()
  private closed = false
  private managedToolMutation = 0
  private managedCredentialMutation = 0
  /** Successful chunk text only; process-memory resume cache, never persisted. */
  private readonly ocrChunkCache = new Map<string, string>()
  private readonly qccOAuth = new QccOAuthCoordinator()
  private readonly tianyanchaOAuth = new TianyanchaOAuthCoordinator()
  private readonly authorizations = new Map<'qcc' | 'tianyancha', AuthorizationAttempt>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'gongchuangConnectors')
    for (const definition of DEFINITIONS) this.ensureStatus(definition)
  }

  protected [Service.init](): void {
    const stopSearchProvider = this.ctx.web.registerSearchProvider(new GongchuangExaMcpSearchProvider(this.config.userAgent))
    const stopPublishFiles = this.ctx.tools.register(defineTool({
      name: 'gongchuang_publish_files',
      description: '完成用户要求的文件后调用一次，把最终交付文件显示在对话底部。这只是本地文件打开入口，不上传文件、不发布软件或技能、不切换正式版本。只传最终文件，不传构建脚本、临时图片、缓存或中间文件。适用于普通和专业任务，不执行哈希、审计或专业校验。',
      parameters: {
        paths: {
          type: 'array', required: true, items: { type: 'string' },
          description: '一个或多个最终交付文件的绝对路径或当前企业空间相对路径，最多 20 个。',
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            files: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  bytes: { type: 'number', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `已生成 ${String(value.files.length)} 个文件，可在对话底部直接打开。` }],
      },
      isConcurrencySafe: () => true,
      execute: (args, exec) => {
        const paths = [...new Set(args.paths.map(path => path.trim()).filter(path => path !== ''))]
        if (paths.length === 0) throw new Error('请至少提供一个最终交付文件')
        if (paths.length > 20) throw new Error('一次最多发布 20 个最终交付文件')
        const files = paths.map((path) => {
          const workspace = exec.agent?.session.header.cwd
          // The desktop process cwd can be `/`; relative files belong to the
          // active session, just like reads and writes, never to that process.
          let absolute: string
          if (isAbsolute(path)) absolute = resolve(path)
          else {
            if (workspace === undefined) throw new Error('交付文件的相对路径需要当前企业空间')
            absolute = resolve(workspace, path)
          }
          let info: ReturnType<typeof statSync>
          try { info = statSync(absolute) } catch (error) {
            throw new Error(`无法打开交付文件：${absolute}`, { cause: error })
          }
          if (!info.isFile()) throw new Error(`交付路径不是文件：${absolute}`)
          return { path: absolute, name: basename(absolute), bytes: info.size }
        })
        return Promise.resolve({ files })
      },
      presentCall: args => ({
        card: 'generic', title: '生成的文件', kind: 'read',
        locations: args.paths.map(path => ({ path })),
      }),
    }))
    this.settingsScope = this.ctx.settings.register(NS, CONFIG_SCHEMA, {
      base: {
        enabled: ['gongchuang-search'],
        knowledgeEndpoint: '',
        region: 'all',
        regionConfirmed: false,
        custom: [],
      },
    })
    this.syncCustomStatuses()
    const stopWatching = this.settingsScope.watch(() => { void this.scheduleReconcile() })
    const stopCredentials = this.ctx.on('credentials/reference-updated', (ref) => {
      if (this.managedCredentialMutation === 0
        && this.allDefinitions().some(definition => definition.credentialRef === ref)) void this.scheduleReconcile()
    })
    const stopTools = this.ctx.on('tools/change', () => {
      if (this.managedToolMutation === 0) void this.scheduleReconcile()
    })
    const stopConnectionHealth = this.ctx.on('mcp/connection-state', (state) => {
      const id = this.connectorForServer(state.serverName)
      if (id === undefined) return
      if (state.phase === 'disposed') this.connectionHealth.delete(state.serverName)
      else this.connectionHealth.set(state.serverName, state)
      if (this.managedToolMutation > 0) return
      this.publishConnectionHealth(id)
    })
    this.ctx.effect(() => async () => {
      this.closed = true
      stopWatching()
      stopCredentials()
      stopTools()
      stopConnectionHealth()
      stopSearchProvider()
      stopPublishFiles()
      for (const attempt of this.authorizations.values()) attempt.controller.abort(new Error('客户端已关闭，授权已取消'))
      this.qccOAuth.dispose()
      this.tianyanchaOAuth.dispose()
      await Promise.allSettled([...this.authorizations.values()].map(attempt => attempt.running))
      this.authorizations.clear()
      await this.reconcileTail
      await this.disposeAll()
      this.ocrChunkCache.clear()
    }, 'gongchuang-connectors: quiesce')
    // Saved connector secrets can be temporarily unavailable while macOS
    // Keychain settles after an app update.  The product shell and ordinary
    // conversations must still start; reconcile this connector-only state in
    // the background and expose any failure on the corresponding MCP card.
    void this.scheduleReconcile().catch((error: unknown) => {
      this.ctx.logger.warn('gongchuang-connectors: startup reconciliation failed')
      this.ctx.logger.warn(error)
    })
  }

  /**
   * Read all connector states without exposing credentials.
   * @returns Current redacted connector states after reconciling registered tool counts.
   */
  @Remote('list')
  list(): GongchuangConnectorSnapshot {
    this.syncCustomStatuses()
    this.refreshToolCounts()
    const connectors = this.allDefinitions().map((definition) => {
      const status = this.statuses.get(definition.id)
      if (status === undefined) throw new Error(`连接器状态未初始化：${definition.id}`)
      return copyView(status)
    })
    return Object.freeze({
      revision: this.revision,
      region: this.requireSettings().get().region,
      regionConfirmed: this.requireSettings().get().regionConfirmed,
      connectors: Object.freeze(connectors),
    })
  }

  /** Persist the first-run or user-selected knowledge-search region.
   * @param request - The request value.
   * @returns The set region result.
   */
  @Remote('setRegion')
  async setRegion(request: GongchuangRegionSetRequest): Promise<GongchuangConnectorSnapshot> {
    const scope = this.requireSettings()
    const previous = scope.get()
    if (previous.region === request.region && previous.regionConfirmed === request.confirmed) return this.list()
    // The renderer starts with a placeholder snapshot while the saved section
    // loads. Refuse a delayed action from that placeholder instead of letting
    // its `all` draft replace the city restored during an application update.
    if (previous.region !== request.expectedRegion
      || previous.regionConfirmed !== request.expectedConfirmed) {
      throw new Error('所属地设置已变化，请重新打开选择器后再试')
    }
    await this.disposeConnector('gongchuang-knowledge')
    this.connectionNotes.delete('gongchuang-knowledge')
    this.verifiedAt.delete('gongchuang-knowledge')
    await scope.update({ region: request.region, regionConfirmed: request.confirmed })
    await this.scheduleReconcile()
    return this.list()
  }

  /**
   * Persist one connector's enabled state and reconcile its owned tool mounts.
   * @param request - Known connector id and desired enabled state.
   * @returns Updated redacted connector snapshot after reconciliation.
   */
  @Remote('setEnabled')
  async setEnabled(request: GongchuangConnectorEnableRequest): Promise<GongchuangConnectorSnapshot> {
    await this.cancelCurrentAuthorization(request.id)
    return await this.applyEnabled(request)
  }

  private async applyEnabled(request: GongchuangConnectorEnableRequest): Promise<GongchuangConnectorSnapshot> {
    this.requireDefinition(request.id)
    const scope = this.requireSettings()
    const enabled = new Set(scope.get().enabled)
    if (request.enabled) {
      if (enabled.has(request.id)) {
        await this.disposeConnector(request.id)
        this.connectionNotes.delete(request.id)
        this.verifiedAt.delete(request.id)
      }
      enabled.add(request.id)
    }
    else enabled.delete(request.id)
    await scope.update({ enabled: [...enabled] })
    await this.scheduleReconcile()
    return this.list()
  }

  /**
   * Store a connector secret through the credential service and enable it.
   * @param request - Credential-backed connector id and non-empty secret value.
   * @returns Updated connector snapshot; the secret is never included.
   */
  @Remote('configure')
  async configure(request: GongchuangConnectorConfigureRequest): Promise<GongchuangConnectorSnapshot> {
    if (isCustomConnectorId(request.id)) throw new Error('请通过自定义 MCP 编辑器更新该连接')
    await this.cancelCurrentAuthorization(request.id)
    if (request.id === 'gongchuang-knowledge') {
      const scope = this.requireSettings()
      const previousEndpoint = scope.get().knowledgeEndpoint
      const endpoint = new URL(request.endpoint ?? previousEndpoint)
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
        throw new Error('知识库 MCP 必须使用 HTTPS；本机 localhost 可使用 HTTP')
      }
      if (endpoint.username !== '' || endpoint.password !== '' || endpoint.hash !== '') {
        throw new Error('MCP 地址不能包含用户名、密码或片段；请单独填写访问凭据')
      }
      const previouslyEnabled = scope.get().enabled.includes(request.id)
      // Settings watchers must not send the old endpoint's credential to a
      // replacement endpoint before the user-supplied credential is stored.
      await this.applyEnabled({ id: request.id, enabled: false })
      await scope.update({ knowledgeEndpoint: endpoint.href })
      try {
        return await this.configureCredential(request, true)
      } catch (error) {
        await scope.update({ knowledgeEndpoint: previousEndpoint })
        await this.applyEnabled({ id: request.id, enabled: previouslyEnabled })
        throw error
      }
    }
    return await this.configureCredential(request, true)
  }

  /** Persist a user-owned MCP definition, keep its secret in the OS store, and test tools/list.
   * @param request - The request value.
   * @returns The upsert custom result.
   */
  @Remote('upsertCustom')
  async upsertCustom(request: GongchuangCustomMcpUpsertRequest): Promise<GongchuangConnectorSnapshot> {
    const scope = this.requireSettings()
    const previous = request.id === undefined
      ? undefined
      : scope.get().custom.find(item => item.id === request.id)
    if (request.id !== undefined && previous === undefined) throw new Error('要编辑的自定义 MCP 已不存在')
    const config = normalizeCustomMcpRequest(request, previous)
    const ref = credentialRef(customCredentialName(config.id))
    const hasCredential = config.authMode !== 'none'
    const replacement = request.credentialValue === undefined
      ? undefined
      : safeCredential(request.credentialValue, 'MCP 凭据')
    const existing = await this.ctx.credentials.resolve(ref)
    if (hasCredential && replacement === undefined && existing === undefined) {
      throw new Error('该 MCP 的鉴权方式需要填写凭据')
    }
    await this.disposeConnector(config.id)
    if (hasCredential) {
      if (replacement !== undefined) await this.replaceCredential(ref, replacement)
    } else if (existing !== undefined) {
      await this.replaceCredential(ref, undefined)
    }
    const current = scope.get()
    const custom = current.custom.filter(item => item.id !== config.id).concat(config)
    const enabled = [...new Set([...current.enabled, config.id])]
    await scope.update({ custom, enabled })
    this.statuses.delete(config.id)
    this.ensureStatus(customDefinition(config))
    this.connectionNotes.delete(config.id)
    this.verifiedAt.delete(config.id)
    await this.scheduleReconcile()
    return this.list()
  }

  /** Remove a user-owned MCP definition, its live tools, and its OS-stored secret.
   * @param request - The request value.
   * @returns The remove custom result.
   */
  @Remote('removeCustom')
  async removeCustom(request: GongchuangCustomMcpRemoveRequest): Promise<GongchuangConnectorSnapshot> {
    if (!isCustomConnectorId(request.id)) throw new Error('只能移除用户自行添加的 MCP')
    const scope = this.requireSettings()
    const current = scope.get()
    if (!current.custom.some(item => item.id === request.id)) throw new Error('要移除的自定义 MCP 已不存在')
    await this.disposeConnector(request.id)
    await this.replaceCredential(credentialRef(customCredentialName(request.id)), undefined)
    await scope.update({
      custom: current.custom.filter(item => item.id !== request.id),
      enabled: current.enabled.filter(id => id !== request.id),
    })
    this.statuses.delete(request.id)
    this.connectionNotes.delete(request.id)
    this.verifiedAt.delete(request.id)
    this.revision += 1
    this.ctx.emit('gongchuang-connectors/changed', this.revision)
    return this.list()
  }

  private async configureCredential(
    request: GongchuangConnectorConfigureRequest,
    clearOAuth: boolean,
    normalizedCredential?: string,
  ): Promise<GongchuangConnectorSnapshot> {
    const definition = this.requireDefinition(request.id)
    if (definition.credentialRef === undefined) {
      throw new Error(`${definition.name} 不需要外部密钥`)
    }
    const ref = credentialRef(definition.credentialRef)
    const previous = await this.ctx.credentials.resolve(ref)
    const previousEnabled = this.statuses.get(request.id)?.enabled ?? false
    const oauthPrefix = request.id === 'qcc' ? 'QCC_MCP' : request.id === 'tianyancha' ? 'TYC_MCP' : undefined
    const refreshRef = oauthPrefix === undefined ? undefined : credentialRef(`${oauthPrefix}_OAUTH_REFRESH_TOKEN`)
    const metadataRef = oauthPrefix === undefined ? undefined : credentialRef(`${oauthPrefix}_OAUTH_METADATA`)
    const previousRefresh = clearOAuth && refreshRef !== undefined
      ? await this.ctx.credentials.resolve(refreshRef)
      : undefined
    const previousMetadata = clearOAuth && metadataRef !== undefined
      ? await this.ctx.credentials.resolve(metadataRef)
      : undefined
    const normalized = normalizedCredential ?? (request.id === 'gongchuang-knowledge' && request.value.trim() === '' && previous !== undefined
      ? previous.value
      : normalizeConnectorCredential(request.id, request.value))
    await this.disposeConnector(request.id)
    this.connectionNotes.delete(request.id)
    this.verifiedAt.delete(request.id)
    try {
      await this.replaceCredential(ref, normalized)
      if (clearOAuth && refreshRef !== undefined && metadataRef !== undefined) {
        await this.replaceCredential(refreshRef, undefined)
        await this.replaceCredential(metadataRef, undefined)
      }
      const snapshot = await this.applyEnabled({ id: request.id, enabled: true })
      const connector = snapshot.connectors.find(row => row.id === request.id)
      if (connector?.phase !== 'ready' || connector.toolCount < 1) {
        throw new Error(`${definition.name} 未通过真实连接验证：${connector?.message ?? '没有发现可用工具'}`)
      }
      return snapshot
    } catch (error) {
      await this.disposeConnector(request.id)
      this.connectionNotes.delete(request.id)
      this.verifiedAt.delete(request.id)
      await this.restoreCredentials(request.id, [
        [ref, previous?.value],
        ...(clearOAuth && refreshRef !== undefined && metadataRef !== undefined
          ? [[refreshRef, previousRefresh?.value], [metadataRef, previousMetadata?.value]] as const : []),
      ])
      const attempt = request.id === 'qcc' || request.id === 'tianyancha' ? this.authorizations.get(request.id) : undefined
      if (attempt !== undefined) attempt.verifying = false
      await this.applyEnabled({ id: request.id, enabled: previousEnabled }).catch(() => undefined)
      throw error
    }
  }

  /** Begin an official QCC or Tianyancha browser authorization.
   * @param request - The request value.
   * @returns The begin authorization result.
   */
  @Remote('beginAuthorization')
  async beginAuthorization(request: GongchuangConnectorAuthorizationStartRequest): Promise<GongchuangConnectorAuthorizationStart> {
    if (this.authorizations.has(request.id)) await this.cancelCurrentAuthorization(request.id)
    const transactionId = request.transactionId ?? randomUUID()
    if (transactionId.trim() === '' || transactionId.length > 128) throw new Error('授权事务标识无效')
    const attempt: AuthorizationAttempt = {
      transactionId, controller: new AbortController(), running: Promise.resolve(), verifying: false,
    }
    this.authorizations.set(request.id, attempt)
    const start = request.id === 'qcc'
      ? this.qccOAuth.start(transactionId, attempt.controller)
      : this.tianyanchaOAuth.start(transactionId, attempt.controller)
    attempt.running = start
    try {
      const started = await start
      attempt.controller.signal.throwIfAborted()
      return Object.freeze({ id: request.id, ...started })
    } catch (error) {
      if (this.authorizations.get(request.id) === attempt) this.authorizations.delete(request.id)
      throw error
    }
  }

  /** Cancel one attempt and await its credential rollback before accepting a replacement.
   * @param request - Connector and exact attempt; a stale close cannot cancel a new attempt.
   * @returns The unchanged or restored connector snapshot.
   */
  @Remote('cancelAuthorization')
  async cancelAuthorization(request: GongchuangConnectorAuthorizationCompleteRequest): Promise<GongchuangConnectorSnapshot> {
    const attempt = this.authorizations.get(request.id)
    if (attempt === undefined || attempt.transactionId !== request.transactionId) return this.list()
    attempt.controller.abort(new Error('授权已取消'))
    if (request.id === 'qcc') this.qccOAuth.cancel(request.transactionId)
    else this.tianyanchaOAuth.cancel(request.transactionId)
    // 等待旧事务补偿结束，避免迟到回滚覆盖用户刚填入的新密钥。
    await attempt.running.catch(() => undefined)
    if (this.authorizations.get(request.id) === attempt) this.authorizations.delete(request.id)
    if (attempt.rollbackError !== undefined) throw attempt.rollbackError
    return this.list()
  }

  private async cancelCurrentAuthorization(id: GongchuangConnectorId): Promise<void> {
    if (id !== 'qcc' && id !== 'tianyancha') return
    const attempt = this.authorizations.get(id)
    if (attempt !== undefined) await this.cancelAuthorization({ id, transactionId: attempt.transactionId })
  }

  /** Exchange one official authorization, store tokens, and verify tools/list.
   * @param request - The request value.
   * @returns The complete authorization result.
   */
  @Remote('completeAuthorization')
  async completeAuthorization(request: GongchuangConnectorAuthorizationCompleteRequest): Promise<GongchuangConnectorSnapshot> {
    const attempt = this.authorizations.get(request.id)
    if (attempt === undefined || attempt.transactionId !== request.transactionId) throw new Error('授权事务不存在或已取消')
    if (attempt.completion !== undefined) return await attempt.completion
    const completion = request.id === 'qcc'
      ? this.completeQccAuthorization(attempt)
      : this.completeTianyanchaAuthorization(attempt)
    attempt.running = completion
    attempt.completion = completion
    try {
      return await completion
    } finally {
      if (request.id === 'tianyancha' && this.tianyanchaOAuth.hasPending(request.transactionId)
        && !attempt.controller.signal.aborted) {
        // 短轮询结束不等于整个设备授权失效，允许用户确认后主动再试。
        delete attempt.completion
        attempt.running = Promise.resolve()
      } else if (this.authorizations.get(request.id) === attempt) this.authorizations.delete(request.id)
    }
  }

  private async completeQccAuthorization(attempt: AuthorizationAttempt): Promise<GongchuangConnectorSnapshot> {
    const { signal } = attempt.controller
    const tokens = await this.qccOAuth.complete(attempt.transactionId)
    signal.throwIfAborted()
    const refreshRef = credentialRef('QCC_MCP_OAUTH_REFRESH_TOKEN')
    const metadataRef = credentialRef('QCC_MCP_OAUTH_METADATA')
    const previousRefresh = await this.ctx.credentials.resolve(refreshRef)
    const previousMetadata = await this.ctx.credentials.resolve(metadataRef)
    const accessRef = credentialRef('QCC_MCP_API_KEY')
    const previousAccess = await this.ctx.credentials.resolve(accessRef)
    const previousEnabled = this.statuses.get('qcc')?.enabled ?? false
    signal.throwIfAborted()
    let reconfigured = false
    try {
      await this.replaceCredential(refreshRef, tokens.refreshToken)
      signal.throwIfAborted()
      await this.replaceCredential(metadataRef, JSON.stringify({
        clientId: tokens.clientId,
        expiresAt: tokens.expiresAt ?? null,
      }))
      signal.throwIfAborted()
      attempt.verifying = true
      reconfigured = true
      const result = await this.configureCredential({ id: 'qcc', value: tokens.accessToken }, false)
      signal.throwIfAborted()
      return result
    } catch (error) {
      attempt.verifying = false
      if (reconfigured) await this.disposeConnector('qcc')
      await this.restoreCredentials('qcc', [
        [accessRef, previousAccess?.value], [refreshRef, previousRefresh?.value], [metadataRef, previousMetadata?.value],
      ])
      if (reconfigured) await this.applyEnabled({ id: 'qcc', enabled: previousEnabled }).catch(() => undefined)
      throw error
    }
  }

  private async completeTianyanchaAuthorization(attempt: AuthorizationAttempt): Promise<GongchuangConnectorSnapshot> {
    const { signal } = attempt.controller
    const tokens = await this.tianyanchaOAuth.complete(attempt.transactionId)
    signal.throwIfAborted()
    const refreshRef = credentialRef('TYC_MCP_OAUTH_REFRESH_TOKEN')
    const metadataRef = credentialRef('TYC_MCP_OAUTH_METADATA')
    const previousRefresh = await this.ctx.credentials.resolve(refreshRef)
    const previousMetadata = await this.ctx.credentials.resolve(metadataRef)
    const accessRef = credentialRef('TYC_API_TOKEN')
    const previousAccess = await this.ctx.credentials.resolve(accessRef)
    const previousEnabled = this.statuses.get('tianyancha')?.enabled ?? false
    signal.throwIfAborted()
    let reconfigured = false
    try {
      await this.replaceCredential(refreshRef, tokens.refreshToken)
      signal.throwIfAborted()
      await this.replaceCredential(metadataRef, JSON.stringify({
        clientId: tokens.clientId,
        clientSecret: tokens.clientSecret ?? null,
        expiresAt: tokens.expiresAt ?? null,
      }))
      signal.throwIfAborted()
      attempt.verifying = true
      reconfigured = true
      const result = await this.configureCredential(
        { id: 'tianyancha', value: tokens.accessToken },
        false,
        `Bearer ${tokens.accessToken}`,
      )
      signal.throwIfAborted()
      return result
    } catch (error) {
      attempt.verifying = false
      if (reconfigured) await this.disposeConnector('tianyancha')
      await this.restoreCredentials('tianyancha', [
        [accessRef, previousAccess?.value], [refreshRef, previousRefresh?.value], [metadataRef, previousMetadata?.value],
      ])
      if (reconfigured) await this.applyEnabled({ id: 'tianyancha', enabled: previousEnabled }).catch(() => undefined)
      throw error
    }
  }

  /**
   * Retry reconciliation for every enabled connector.
   * @returns Connector state after retrying all enabled connector mounts.
   */
  @Remote('refresh')
  async refresh(): Promise<GongchuangConnectorSnapshot> {
    const enabled = new Set(this.requireSettings().get().enabled.filter(isConnectorId))
    for (const id of enabled) {
      await this.disposeConnector(id)
      this.connectionNotes.delete(id)
      this.verifiedAt.delete(id)
    }
    await this.scheduleReconcile()
    return this.list()
  }

  /**
   * Preprocess browser image payloads for text-only model routes.
   * This host-only method is intentionally not a Remote endpoint: image bytes
   * already crossed the authenticated session RPC and never round-trip through
   * a second renderer API.
   * @param images - Bounded browser image payloads accepted by the Host request path.
   * @param signal - Cancellation signal shared with the pending model request.
   * @returns OCR text and limitations in the same order as the supplied images.
   * @param agent - The agent value.
   */
  async preprocessImages(
    images: readonly ConnectorImageInput[],
    signal: AbortSignal,
    agent?: ToolExecution['agent'],
  ): Promise<readonly ConnectorImageFallback[]> {
    const toolName = 'mcp__paddle_ocr__ocr'
    if (this.ctx.tools.get(toolName) === undefined) {
      throw new Error('当前模型不支持图片；请先在 MCP 中启用并完成 PaddleOCR 配置，或切换到支持图片的模型。')
    }
    const results: ConnectorImageFallback[] = []
    for (let index = 0; index < images.length; index++) {
      signal.throwIfAborted()
      const image = images[index]
      if (image === undefined) throw new Error('图片队列状态不一致')
      const bytes = new Uint8Array(Buffer.from(image.data, 'base64'))
      const chunks = await splitLongScreenshot(bytes)
      const chunkTexts: string[] = []
      let resumedChunks = 0
      for (const chunk of chunks) {
        signal.throwIfAborted()
        const payload = chunks.length === 1 ? bytes : chunk.data
        const mediaType = chunks.length === 1 ? image.mediaType : chunk.mediaType
        const cacheKey = `paddleocr:${GONGCHUANG_PADDLEOCR_MCP_VERSION}:${chunk.sha256}`
        const cached = this.ocrChunkCache.get(cacheKey)
        if (cached !== undefined) {
          resumedChunks += 1
          chunkTexts.push(cached)
          continue
        }
        const result = await this.ctx.tools.execute({
          signal,
          callId: ToolCallId(`vision-ocr-${randomUUID()}`),
          name: toolName,
          arguments: {
            input_data: `data:${mediaType};base64,${Buffer.from(payload).toString('base64')}`,
            output_mode: 'detailed',
            file_type: 'image',
            return_images: false,
          },
          ...(agent === undefined ? {} : { agent }),
        })
        const raw = textFromContent(result.content).trim()
        if (result.isError) {
          throw new Error(`第 ${String(index + 1)} 张图片第 ${String(chunk.index)}/${String(chunk.total)} 个切片 OCR 失败：${raw || 'PaddleOCR 未返回错误详情'}`)
        }
        let chunkText = raw
        try {
          const parsed = JSON.parse(raw) as { text?: unknown; error?: unknown }
          if (typeof parsed.error === 'string' && parsed.error.length > 0) throw new Error(parsed.error)
          if (typeof parsed.text === 'string') chunkText = parsed.text
        } catch (error: unknown) {
          if (!(error instanceof SyntaxError)) throw error
        }
        const normalized = chunkText.trim()
        this.ocrChunkCache.set(cacheKey, normalized)
        while (this.ocrChunkCache.size > MAX_OCR_CHUNK_CACHE_ENTRIES) {
          const oldest = this.ocrChunkCache.keys().next().value
          if (oldest === undefined) break
          this.ocrChunkCache.delete(oldest)
        }
        chunkTexts.push(normalized)
      }
      const text = mergeLongScreenshotText(chunkTexts).slice(0, MAX_OCR_TEXT_CHARS)
      if (text.length === 0 || text === 'No text detected') {
        throw new Error(
          `第 ${String(index + 1)} 张图片没有识别到可用文字；DeepSeek 无法可靠理解纯图片、照片或图表，请切换到支持图片的模型。`,
        )
      }
      const audit = `OCR 处理：切片 ${String(chunks.length)} 个；本次复用已完成切片 ${String(resumedChunks)} 个。`
      results.push({ text, method: 'ocr', limitations: `${OCR_LIMITATIONS} ${audit}` })
    }
    return Object.freeze(results.map(result => Object.freeze({ ...result })))
  }

  private async ocrWorkspacePdf(
    documentPath: string,
    exec: ToolExecution,
    requestedPages?: readonly number[],
  ): Promise<{ name: string; text: string; limitations: string }> {
    const workspace = exec.agent?.session.header.cwd
    if (workspace === undefined) throw new Error('扫描 PDF 缺少当前企业空间')
    const document = loadWorkspacePdfForOcr(workspace, documentPath)
    const pages = requestedPages === undefined ? undefined : normalizeOcrPages(requestedPages)
    const pageScope = pages === undefined ? '' : ` 原文件页码：${pages.join('、')}。`
    const cacheKey = `paddleocr:${GONGCHUANG_PADDLEOCR_MCP_VERSION}:pdf:${document.sha256}:${pages?.join(',') ?? 'all'}`
    const cached = this.ocrChunkCache.get(cacheKey)
    if (cached !== undefined) {
      return {
        name: document.name,
        text: cached,
        limitations: `${OCR_LIMITATIONS} OCR 处理：本次复用本机已完成识别结果。${pageScope}`,
      }
    }
    let bytes = document.bytes
    if (pages !== undefined) {
      const binding = this.ctx.get('gongchuangSkillRuntimeBinding')
      if (binding?.runtimeIntegrity !== 'signed') throw new Error('PDF 指定页读取需要已验证的客户端内置运行时')
      bytes = await selectOcrPdfPages(binding.pythonExecutable, bytes, pages, exec.signal)
    }
    const result = await this.ctx.tools.execute({
      signal: exec.signal,
      callId: ToolCallId(`${exec.callId}:paddle-pdf`),
      rootCallId: exec.rootCallId,
      name: 'mcp__paddle_ocr__ocr',
      arguments: {
        input_data: `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`,
        output_mode: 'detailed',
        file_type: 'pdf',
        return_images: false,
      },
      ...(exec.agent === undefined ? {} : { agent: exec.agent }),
      parent: exec.token,
    })
    const raw = textFromContent(result.content).trim()
    if (result.isError) throw new Error(`扫描 PDF OCR 失败：${raw || 'PaddleOCR 未返回错误详情'}`)
    let text = raw
    try {
      const parsed = JSON.parse(raw) as { text?: unknown; error?: unknown }
      if (typeof parsed.error === 'string' && parsed.error.length > 0) throw new Error(parsed.error)
      if (typeof parsed.text === 'string') text = parsed.text
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error
    }
    const normalized = text.trim().slice(0, MAX_OCR_TEXT_CHARS)
    if (normalized.length === 0 || normalized === 'No text detected') {
      throw new Error('扫描 PDF 没有识别到可用文字；请检查文件是否清晰、加密或为空白，并可拆分后重试')
    }
    this.ocrChunkCache.set(cacheKey, normalized)
    while (this.ocrChunkCache.size > MAX_OCR_CHUNK_CACHE_ENTRIES) {
      const oldest = this.ocrChunkCache.keys().next().value
      if (oldest === undefined) break
      this.ocrChunkCache.delete(oldest)
    }
    return {
      name: document.name,
      text: normalized,
      limitations: `${OCR_LIMITATIONS} OCR 处理已完成。${pageScope}`,
    }
  }

  private allDefinitions(): ConnectorDefinition[] {
    const custom = this.settingsScope?.get().custom ?? []
    return [...DEFINITIONS, ...custom.map(customDefinition)]
  }

  private ensureStatus(definition: ConnectorDefinition): void {
    if (this.statuses.has(definition.id)) return
    this.statuses.set(definition.id, {
      id: definition.id,
      name: definition.name,
      phase: 'disabled',
      enabled: false,
      credentialConfigured: definition.credentialRef === undefined,
      credentialWritable: definition.credentialRef !== undefined,
      officialConfigUrl: definition.officialConfigUrl,
      toolCount: 0,
      tools: Object.freeze([]),
      verificationMethod: definition.verificationMethod,
      lastVerifiedAt: null,
      partial: false,
      message: '尚未启用',
      custom: definition.custom !== undefined,
      transport: definition.custom?.transport ?? null,
      endpoint: definition.id === 'gongchuang-knowledge' ? this.settingsScope?.get().knowledgeEndpoint ?? '' : definition.custom?.transport === 'streamable-http'
        ? definition.custom.url
        : definition.custom?.command ?? '',
      arguments: Object.freeze([...(definition.custom?.args ?? [])]),
      cwd: definition.custom?.cwd ?? '',
      authMode: definition.custom?.authMode ?? null,
      credentialName: definition.custom?.credentialName ?? '',
      credentialPrefix: definition.custom?.credentialPrefix ?? '',
    })
  }

  private syncCustomStatuses(): void {
    const definitions = this.allDefinitions()
    const ids = new Set(definitions.map(definition => definition.id))
    for (const definition of definitions) this.ensureStatus(definition)
    for (const id of this.statuses.keys()) {
      if (isCustomConnectorId(id) && !ids.has(id)) this.statuses.delete(id)
    }
  }

  private requireSettings(): SettingsScope<ConnectorSettings> {
    if (this.settingsScope === undefined) throw new Error('共创连接器设置尚未就绪')
    return this.settingsScope
  }

  private async restoreCredentials(
    id: GongchuangConnectorId,
    values: ReadonlyArray<readonly [ReturnType<typeof credentialRef>, string | undefined]>,
  ): Promise<void> {
    // 各项独立恢复；单个存储错误不能跳过其余原凭据，也不能被取消请求吞成成功。
    const failures: unknown[] = []
    for (const [ref, value] of values) {
      try { await this.replaceCredential(ref, value) } catch (error) { failures.push(error) }
    }
    const attempt = id === 'qcc' || id === 'tianyancha' ? this.authorizations.get(id) : undefined
    if (failures.length === 0) {
      if (attempt !== undefined) delete attempt.rollbackError
      return
    }
    const error = new AggregateError(failures, '未能恢复原连接信息，请重新配置该连接器')
    if (attempt !== undefined) attempt.rollbackError = error
    await this.applyEnabled({ id, enabled: false }).catch(() => undefined)
    throw error
  }

  private async replaceCredential(ref: ReturnType<typeof credentialRef>, value: string | undefined): Promise<void> {
    this.managedCredentialMutation += 1
    try {
      if (value === undefined) await this.ctx.credentials.unset(ref)
      else await this.ctx.credentials.set(ref, value)
    } finally {
      this.managedCredentialMutation -= 1
    }
  }

  private requireDefinition(id: GongchuangConnectorId): ConnectorDefinition {
    const definition = this.allDefinitions().find(candidate => candidate.id === id)
    if (definition === undefined) throw new Error(`未知连接器 ${id}`)
    return definition
  }

  private connectorForServer(serverName: string): GongchuangConnectorId | undefined {
    if (serverName.startsWith('qcc_')) return 'qcc'
    if (serverName === 'tianyancha') return 'tianyancha'
    if (serverName === 'paddle_ocr') return 'paddle-ocr'
    if (serverName === 'gongchuang_knowledge') return 'gongchuang-knowledge'
    return this.allDefinitions().find(definition => definition.custom?.serverName === serverName)?.id
  }

  private publishConnectionHealth(id: GongchuangConnectorId): void {
    const definition = this.requireDefinition(id)
    const previous = this.statuses.get(id)
    if (previous === undefined || !previous.enabled || !this.mounts.has(id)) return
    const matching = [...this.connectionHealth.entries()]
      .filter(([serverName]) => this.connectorForServer(serverName) === id)
      .map(([, state]) => state)
    const ready = matching.filter(state => state.phase === 'ready').length
    const unhealthy = matching.filter(state => state.phase === 'reconnecting' || state.phase === 'failed')
    if (unhealthy.length === 0) {
      if (matching.length === 0 || ready === 0) return
      const count = this.toolCount(definition)
      this.verifiedAt.set(id, new Date().toISOString())
      const note = this.connectionNotes.get(id)
      this.publish(
        definition,
        count > 0 ? 'ready' : 'error',
        true,
        previous.credentialConfigured,
        previous.credentialWritable,
        count > 0 ? note?.message ?? `连接已恢复，共 ${String(count)} 个工具` : '连接已恢复，但没有发现可用工具',
        note?.partial ?? false,
      )
      return
    }
    const latest = unhealthy.at(-1)
    if (latest === undefined) return
    const qccStillReady = id === 'qcc' && ready > 0
    this.publish(
      definition,
      qccStillReady ? 'ready' : latest.phase === 'reconnecting' ? 'connecting' : 'error',
      true,
      previous.credentialConfigured,
      previous.credentialWritable,
      qccStillReady
        ? `企查查部分服务连接中断，仍有 ${String(ready)} 个服务可用；${latest.message}`
        : latest.message,
      qccStillReady,
    )
  }

  private scheduleReconcile(): Promise<void> {
    const task = this.reconcileTail.then(() => this.closed ? undefined : this.reconcile())
    this.reconcileTail = task.catch(() => undefined)
    return task
  }

  private async reconcile(): Promise<void> {
    const enabled = new Set(this.requireSettings().get().enabled)
    const definitions = this.allDefinitions()
    const currentIds = new Set(definitions.map(definition => definition.id))
    for (const id of this.mounts.keys()) {
      if (!currentIds.has(id)) await this.disposeConnector(id)
    }
    this.syncCustomStatuses()
    await Promise.all(definitions.map(definition => this.reconcileOne(definition, enabled.has(definition.id))))
  }

  private async reconcileOne(definition: ConnectorDefinition, enabled: boolean): Promise<void> {
    let credential: CredentialInfo
    try {
      credential = definition.credentialRef === undefined
        ? { configured: true, writable: false }
        : await this.ctx.credentials.describe(credentialRef(definition.credentialRef))
    } catch (error) {
      const previous = this.statuses.get(definition.id)
      if (previous === undefined) throw error
      this.publish(
        definition,
        'error',
        enabled,
        previous.credentialConfigured,
        previous.credentialWritable,
        '系统凭据暂不可用，请允许系统访问后重试（错误代码：MCP_CREDENTIAL_STORE_UNAVAILABLE）',
      )
      return
    }
    if (!enabled) {
      await this.disposeConnector(definition.id)
      this.connectionNotes.delete(definition.id)
      this.verifiedAt.delete(definition.id)
      this.publish(definition, 'disabled', false, credential.configured, credential.writable, '尚未启用')
      return
    }
    if (!credential.configured) {
      await this.disposeConnector(definition.id)
      this.publish(
        definition,
        'missing-credential',
        true,
        false,
        credential.writable,
        definition.id === 'gongchuang-knowledge' ? '请配置知识库 MCP 地址与访问凭据' : '请先粘贴官方平台密钥',
      )
      return
    }
    if (this.mounts.has(definition.id)) {
      const hasManagedConnection = [...this.connectionHealth.keys()]
        .some(serverName => this.connectorForServer(serverName) === definition.id)
      if (hasManagedConnection) {
        // An MCP-backed connector can retain product-owned helper tools after
        // its transport has failed (Paddle's workspace-PDF bridge is one).
        // Reconciliation must therefore derive phase from connection health,
        // not infer "ready" from a non-zero aggregate tool count.
        this.publishConnectionHealth(definition.id)
        return
      }
      const count = this.toolCount(definition)
      const note = this.connectionNotes.get(definition.id)
      this.publish(
        definition,
        count > 0 ? 'ready' : 'error',
        true,
        true,
        credential.writable,
        count > 0 ? note?.message ?? `真实连接已就绪，共 ${String(count)} 个工具` : '连接已装载，但没有发现可用工具',
        note?.partial ?? false,
      )
      return
    }
    this.publish(definition, 'connecting', true, true, credential.writable, '正在连接并发现工具')
    try {
      const fibers = await this.mount(definition.id)
      this.mounts.set(definition.id, fibers)
      const count = this.toolCount(definition)
      if (count === 0) throw new Error('连接完成但未发现任何工具')
      this.verifiedAt.set(definition.id, new Date().toISOString())
      const note = this.connectionNotes.get(definition.id)
      this.publish(definition, 'ready', true, true, credential.writable, note?.message ?? `真实连接已就绪，共 ${String(count)} 个工具`, note?.partial ?? false)
    } catch (error) {
      await this.disposeConnector(definition.id)
      this.publish(
        definition,
        definition.id === 'gongchuang-search' ? 'unavailable' : 'error',
        true,
        true,
        credential.writable,
        connectorConnectionFailureMessage(definition.id, error),
      )
    }
  }

  private async mount(id: GongchuangConnectorId): Promise<OwnedMount[]> {
    this.managedToolMutation += 1
    try {
      if (id === 'qcc') return await this.mountQcc()
      if (id === 'paddle-ocr') return await this.mountPaddle()
      if (id === 'gongchuang-knowledge') return await this.mountGongchuangKnowledge()
      if (id === 'tianyancha') return await this.mountTianyancha()
      if (isCustomConnectorId(id)) return await this.mountCustom(this.requireDefinition(id))
      const disposers = this.mountGongchuangSearchTool()
      return disposers.map(dispose => ({
        dispose: () => {
          dispose()
          return Promise.resolve()
        },
      }))
    } finally {
      this.managedToolMutation -= 1
    }
  }

  private async mountCustom(definition: ConnectorDefinition): Promise<Fiber[]> {
    const config = definition.custom
    if (config === undefined) throw new Error('自定义 MCP 配置缺失')
    const credential = customCredentialName(config.id)
    const common = {
      serverName: config.serverName,
      toolCallTimeoutMs: 60_000,
      failOnStartupError: true,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    } as const
    const mcpConfig: McpClient.Config = config.transport === 'streamable-http'
      ? {
        ...common,
        transport: 'streamable-http',
        url: config.url,
        headers: {},
        ...(config.authMode === 'none' ? {} : {
          headerCredentials: {
            [config.credentialName]: { ref: credential, prefix: config.credentialPrefix },
          },
        }),
      }
      : {
        ...common,
        transport: 'stdio',
        command: config.command,
        args: config.args,
        env: {},
        cwd: config.cwd,
        ...(config.authMode === 'env' ? {
          envCredentials: { [config.credentialName]: credential },
        } : {}),
      }
    const fiber = this.ctx.plugin(McpClient, mcpConfig)
    await fiber
    return [fiber]
  }

  private async mountQcc(): Promise<Fiber[]> {
    await this.ensureQccOAuthAccessToken()
    const fibers: Fiber[] = []
    const requiredFibers: Fiber[] = []
    const requiredFailed: string[] = []
    const failures: unknown[] = []
    const attempts = await Promise.all(QCC_ENDPOINTS.map(async ([serverName, url]) => {
      const fiber = this.ctx.plugin(McpClient, {
        transport: 'streamable-http', serverName, url, headers: {},
        headerCredentials: { Authorization: { ref: 'QCC_MCP_API_KEY', prefix: 'Bearer ' } },
        toolCallTimeoutMs: 60_000, failOnStartupError: true,
        reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
      })
      try {
        await this.awaitAuthorizationMount('qcc', fiber)
        return { serverName, fiber, error: undefined }
      } catch (error) {
        await fiber.dispose().catch(() => undefined)
        return { serverName, fiber: undefined, error }
      }
    }))
    for (const attempt of attempts) {
      if (attempt.fiber !== undefined) {
        fibers.push(attempt.fiber)
        if (!QCC_OPTIONAL_SERVERS.has(attempt.serverName)) requiredFibers.push(attempt.fiber)
        continue
      }
      if (!QCC_OPTIONAL_SERVERS.has(attempt.serverName)) requiredFailed.push(attempt.serverName.replace(/^qcc_/u, ''))
      failures.push(attempt.error)
    }
    if (requiredFibers.length === 0) {
      await Promise.allSettled(fibers.map(fiber => fiber.dispose()))
      throw new Error(qccConnectionFailureMessage(failures))
    }
    const count = this.toolCount(this.requireDefinition('qcc'))
    const coreReady = requiredFibers.length
    this.connectionNotes.set('qcc', requiredFailed.length === 0
      ? { message: `企查查已连接 9 项业务服务；${String(count)} 项底层接口按需调用`, partial: false }
      : { message: `企查查已连接 ${String(coreReady)}/9 项业务服务；${String(count)} 项底层接口按需调用；当前账号不可用：${requiredFailed.join('、')}`, partial: true })
    return fibers
  }

  private async ensureQccOAuthAccessToken(): Promise<void> {
    const refreshRef = credentialRef('QCC_MCP_OAUTH_REFRESH_TOKEN')
    const metadataRef = credentialRef('QCC_MCP_OAUTH_METADATA')
    const refresh = await this.ctx.credentials.resolve(refreshRef)
    const metadata = await this.ctx.credentials.resolve(metadataRef)
    if (refresh === undefined || metadata === undefined) return

    let parsed: { clientId?: unknown; expiresAt?: unknown }
    try {
      parsed = JSON.parse(metadata.value) as { clientId?: unknown; expiresAt?: unknown }
    } catch (error) {
      throw new Error('企查查登录授权记录损坏，请重新登录授权（错误代码：QCC_OAUTH_METADATA_INVALID）', { cause: error })
    }
    if (typeof parsed.clientId !== 'string' || parsed.clientId.trim() === '') {
      throw new Error('企查查登录授权记录缺少客户端信息，请重新登录授权（错误代码：QCC_OAUTH_METADATA_INVALID）')
    }
    if (parsed.expiresAt === null || parsed.expiresAt === undefined) return
    if (typeof parsed.expiresAt !== 'string' || !Number.isFinite(Date.parse(parsed.expiresAt))) {
      throw new Error('企查查登录授权记录的有效期无效，请重新登录授权（错误代码：QCC_OAUTH_METADATA_INVALID）')
    }
    if (Date.parse(parsed.expiresAt) > Date.now() + 60_000) return

    const accessRef = credentialRef('QCC_MCP_API_KEY')
    const previousAccess = await this.ctx.credentials.resolve(accessRef)
    const previousRefresh = refresh.value
    const previousMetadata = metadata.value
    try {
      const tokens = await this.qccOAuth.refresh(parsed.clientId, refresh.value)
      await this.replaceCredential(accessRef, tokens.accessToken)
      await this.replaceCredential(refreshRef, tokens.refreshToken ?? refresh.value)
      await this.replaceCredential(metadataRef, JSON.stringify({
        clientId: tokens.clientId,
        expiresAt: tokens.expiresAt ?? null,
      }))
    } catch (error) {
      await this.replaceCredential(accessRef, previousAccess?.value)
      await this.replaceCredential(refreshRef, previousRefresh)
      await this.replaceCredential(metadataRef, previousMetadata)
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`企查查登录凭据自动续期失败，请重新登录授权（错误代码：QCC_OAUTH_REFRESH_FAILED；${detail}）`, { cause: error })
    }
  }

  private async mountPaddle(): Promise<OwnedMount[]> {
    const binding = this.ctx.get('gongchuangSkillRuntimeBinding')
    if (binding === undefined) {
      throw new Error('PaddleOCR MCP 未获得客户端内置运行时，请重启或更新客户端后重试（错误代码：PADDLE_RUNTIME_BINDING_MISSING）')
    }
    const credential = await this.ctx.credentials.resolve(credentialRef('PADDLEOCR_AISTUDIO_ACCESS_TOKEN'))
    if (credential === undefined) throw new Error('PaddleOCR Access Token 尚未配置（错误代码：PADDLE_CREDENTIAL_MISSING）')
    await verifyPaddleOfficialCredential(credential.value)
    const fiber = this.ctx.plugin(McpClient, paddleMcpConfig(binding))
    try {
      await fiber
    } catch (error) {
      await fiber.dispose().catch(() => undefined)
      throw new Error('PaddleOCR Access Token 已通过官方鉴权，但本机 MCP 进程启动或工具发现失败（错误代码：PADDLE_MCP_START_FAILED）', { cause: error })
    }
    const unregister = this.ctx.tools.register(defineTool({
      name: 'mcp__paddle_ocr__workspace_pdf',
      description: '识别当前企业空间内已导入 PDF 的扫描页。仅接受企业空间相对路径；所选页面将提交至已配置的百度 AI Studio PaddleOCR 服务。先用已签名文档提取操作，返回 needs_ocr 时把原 document 和 ocr_pages 原样作为 pages 传入，无需手写拆页脚本或生成临时文件。',
      parameters: {
        document: { type: 'string', required: true, description: '当前企业空间内扫描 PDF 的相对路径，例如 共创导入资料/申请书.pdf。' },
        pages: { type: 'array', items: { type: 'integer' }, description: '从 1 开始的原 PDF 页码，直接使用读取器返回的 ocr_pages；省略时识别全部页。' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            text: { type: 'string', required: true },
            limitations: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: 125_000,
      isConcurrencySafe: () => false,
      execute: async (args, exec) => await this.ocrWorkspacePdf(args.document, exec, args.pages),
    }))
    return [fiber, { dispose: () => { unregister(); return Promise.resolve() } }]
  }

  private async mountGongchuangKnowledge(): Promise<Fiber[]> {
    const region = this.requireSettings().get().region
    const fiber = this.ctx.plugin(McpClient, gongchuangKnowledgeMcpConfig(
      this.requireSettings().get().knowledgeEndpoint,
      region,
    ))
    await fiber
    return [fiber]
  }

  private async mountTianyancha(): Promise<Fiber[]> {
    await this.ensureTianyanchaOAuthAccessToken()
    const fiber = this.ctx.plugin(McpClient, tianyanchaMcpConfig())
    await this.awaitAuthorizationMount('tianyancha', fiber)
    const count = this.toolCount(this.requireDefinition('tianyancha'))
    this.connectionNotes.set('tianyancha', {
      message: `天眼查官方 MCP 已连接，共 ${String(count)} 个入口工具；深层业务能力按能力目录调用`,
      partial: false,
    })
    return [fiber]
  }

  private async awaitAuthorizationMount(id: 'qcc' | 'tianyancha', fiber: Fiber & PromiseLike<Fiber>): Promise<void> {
    const attempt = this.authorizations.get(id)
    if (attempt?.verifying !== true) { await fiber; return }
    const { signal } = attempt.controller
    let abort: () => void = () => undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => { reject(new Error('授权已取消')) }
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      signal.throwIfAborted()
      await Promise.race([Promise.resolve(fiber), cancelled])
      signal.throwIfAborted()
    } finally {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) await fiber.dispose()
    }
  }

  private async ensureTianyanchaOAuthAccessToken(): Promise<void> {
    const refreshRef = credentialRef('TYC_MCP_OAUTH_REFRESH_TOKEN')
    const metadataRef = credentialRef('TYC_MCP_OAUTH_METADATA')
    const refresh = await this.ctx.credentials.resolve(refreshRef)
    const metadata = await this.ctx.credentials.resolve(metadataRef)
    if (refresh === undefined || metadata === undefined) return

    let parsed: { clientId?: unknown; clientSecret?: unknown; expiresAt?: unknown }
    try {
      parsed = JSON.parse(metadata.value) as { clientId?: unknown; clientSecret?: unknown; expiresAt?: unknown }
    } catch (error) {
      throw new Error('天眼查登录授权记录损坏，请重新登录授权（错误代码：TYC_OAUTH_METADATA_INVALID）', { cause: error })
    }
    if (typeof parsed.clientId !== 'string' || parsed.clientId.trim() === '') {
      throw new Error('天眼查登录授权记录缺少客户端信息，请重新登录授权（错误代码：TYC_OAUTH_METADATA_INVALID）')
    }
    const clientSecret = parsed.clientSecret === null || parsed.clientSecret === undefined
      ? undefined
      : typeof parsed.clientSecret === 'string' && parsed.clientSecret.trim() !== ''
        ? parsed.clientSecret
        : null
    if (clientSecret === null) {
      throw new Error('天眼查登录授权记录中的客户端密钥无效，请重新登录授权（错误代码：TYC_OAUTH_METADATA_INVALID）')
    }
    if (parsed.expiresAt === null || parsed.expiresAt === undefined) return
    if (typeof parsed.expiresAt !== 'string' || !Number.isFinite(Date.parse(parsed.expiresAt))) {
      throw new Error('天眼查登录授权记录的有效期无效，请重新登录授权（错误代码：TYC_OAUTH_METADATA_INVALID）')
    }
    if (Date.parse(parsed.expiresAt) > Date.now() + 60_000) return

    const accessRef = credentialRef('TYC_API_TOKEN')
    const previousAccess = await this.ctx.credentials.resolve(accessRef)
    const previousRefresh = refresh.value
    const previousMetadata = metadata.value
    try {
      const tokens = await this.tianyanchaOAuth.refresh(parsed.clientId, refresh.value, clientSecret)
      await this.replaceCredential(accessRef, `Bearer ${tokens.accessToken}`)
      await this.replaceCredential(refreshRef, tokens.refreshToken ?? refresh.value)
      await this.replaceCredential(metadataRef, JSON.stringify({
        clientId: tokens.clientId,
        clientSecret: tokens.clientSecret ?? null,
        expiresAt: tokens.expiresAt ?? null,
      }))
    } catch (error) {
      await this.replaceCredential(accessRef, previousAccess?.value)
      await this.replaceCredential(refreshRef, previousRefresh)
      await this.replaceCredential(metadataRef, previousMetadata)
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`天眼查登录凭据自动续期失败，请重新登录授权（错误代码：TYC_OAUTH_REFRESH_FAILED；${detail}）`, { cause: error })
    }
  }

  private mountGongchuangSearchTool(): Array<() => void> {
    if (this.ctx.tools.get('web_search') === undefined || this.ctx.tools.get('web_fetch') === undefined) {
      throw new Error('内置 web_search 或 web_fetch 尚未装载')
    }
    return [this.ctx.tools.register(defineTool({
      name: 'mcp__gongchuang_search__evidence_search',
      description: '按共创证据规则执行联网发现；返回检索结果，并要求后续用 web_fetch 核验原文。',
      parameters: { query: { type: 'string', required: true, description: '政策、企业、项目或行业检索问题' } },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            query: { type: 'string', required: true },
            result: { type: 'string', required: true },
            evidenceRule: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const query = (args).query
        const result = await this.ctx.tools.execute({
          signal: exec.signal,
          callId: ToolCallId(`${exec.callId}:gongchuang-search`),
          rootCallId: exec.rootCallId,
          name: 'web_search',
          arguments: { query },
          ...exec.agent === undefined ? {} : { agent: exec.agent },
          parent: exec.token,
        })
        if (result.isError) throw new Error(textFromContent(result.content))
        return {
          query,
          result: textFromContent(result.content),
          evidenceRule: '关键结论必须继续使用 web_fetch 读取原文，并保留来源链接、访问时间和证据边界。',
        }
      },
    }))]
  }

  private publish(
    definition: ConnectorDefinition,
    phase: GongchuangConnectorPhase,
    enabled: boolean,
    credentialConfigured: boolean,
    credentialWritable: boolean,
    message: string,
    partial = false,
  ): void {
    const tools = this.toolViews(definition)
    const next: GongchuangConnectorView = {
      id: definition.id, name: definition.name, phase, enabled,
      credentialConfigured, credentialWritable,
      officialConfigUrl: definition.officialConfigUrl,
      toolCount: tools.length,
      tools: Object.freeze(tools),
      verificationMethod: definition.verificationMethod,
      lastVerifiedAt: this.verifiedAt.get(definition.id) ?? null,
      partial,
      message,
      custom: definition.custom !== undefined,
      transport: definition.custom?.transport ?? null,
      endpoint: definition.id === 'gongchuang-knowledge' ? this.settingsScope?.get().knowledgeEndpoint ?? '' : definition.custom?.transport === 'streamable-http'
        ? definition.custom.url
        : definition.custom?.command ?? '',
      arguments: Object.freeze([...(definition.custom?.args ?? [])]),
      cwd: definition.custom?.cwd ?? '',
      authMode: definition.custom?.authMode ?? null,
      credentialName: definition.custom?.credentialName ?? '',
      credentialPrefix: definition.custom?.credentialPrefix ?? '',
    }
    const previous = this.statuses.get(definition.id)
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) return
    this.statuses.set(definition.id, next)
    this.revision += 1
    this.ctx.emit('gongchuang-connectors/changed', this.revision)
  }

  private refreshToolCounts(): void {
    for (const definition of DEFINITIONS) {
      const previous = this.statuses.get(definition.id)
      if (previous === undefined) throw new Error(`连接器状态未初始化：${definition.id}`)
      const tools = this.toolViews(definition)
      if (JSON.stringify(previous.tools) === JSON.stringify(tools)) continue
      this.statuses.set(definition.id, { ...previous, toolCount: tools.length, tools: Object.freeze(tools) })
      this.revision += 1
      this.ctx.emit('gongchuang-connectors/changed', this.revision)
    }
  }

  private toolViews(definition: ConnectorDefinition): Array<{ name: string; description: string }> {
    return this.ctx.tools.schemas().filter(schema =>
      schema.name.startsWith(definition.prefix)
      || (definition.id === 'gongchuang-search' && (schema.name === 'web_search' || schema.name === 'web_fetch')))
      .map(schema => ({ name: schema.name, description: schema.description }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  private toolCount(definition: ConnectorDefinition): number {
    return this.toolViews(definition).length
  }

  private async disposeConnector(id: GongchuangConnectorId): Promise<void> {
    const fibers = this.mounts.get(id)
    if (fibers === undefined) return
    this.mounts.delete(id)
    for (const serverName of this.connectionHealth.keys()) {
      if (this.connectorForServer(serverName) === id) this.connectionHealth.delete(serverName)
    }
    this.managedToolMutation += 1
    try {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    } finally {
      this.managedToolMutation -= 1
    }
  }

  private async disposeAll(): Promise<void> {
    for (const id of [...this.mounts.keys()].reverse()) await this.disposeConnector(id)
  }
}

export default GongchuangConnectorService
