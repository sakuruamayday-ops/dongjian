import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, open, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import sharp from 'sharp'
import { credentialRef, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo,
  CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import WebRuntime from '@deepseek-ai/dsh-web'
import GongchuangConnectorService, {
  connectorConnectionFailureMessage, gongchuangKnowledgeMcpConfig, normalizeConnectorCredential, paddleMcpConfig,
  normalizeCustomMcpRequest, qccConnectionFailureMessage, verifyPaddleOfficialCredential,
  loadWorkspacePdfForOcr, tianyanchaMcpConfig,
} from '../src/index.ts'
import type { GongchuangSkillRuntimeBinding } from '@gongchuang/signed-skill-runtime'
import { QccOAuthCoordinator } from '../src/qcc-oauth.ts'
import { TianyanchaOAuthCoordinator } from '../src/tianyancha-oauth.ts'

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function requestBody(init?: RequestInit): string {
  if (typeof init?.body === 'string') return init.body
  if (init?.body instanceof URLSearchParams) return init.body.toString()
  throw new Error('unexpected connector request body type')
}

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private readonly doc: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

abstract class ReferenceOnlyCredentials extends CredentialProvider {
  readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> { return Promise.resolve(undefined) }
  describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: false })
  }
  listRecords(): Promise<readonly CredentialRecordEntry[]> { return Promise.resolve([]) }
  modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> { return Promise.reject(new Error('credential records are disabled')) }
  deleteRecord(_key: CredentialKey): Promise<void> { return Promise.reject(new Error('credential records are disabled')) }
}

class MemoryCredentials extends ReferenceOnlyCredentials {
  private readonly values = new Map<string, string>()
  readonly describeFailures = new Set<string>()

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (this.describeFailures.has(ref)) {
      return Promise.reject(new Error('gongchuang-credentials-keychain: macOS Keychain is temporarily unavailable'))
    }
    const configured = this.values.has(ref)
    return Promise.resolve({ configured, writable: true, ...(configured ? { source: 'memory' } : {}) })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    if (this.values.delete(ref)) this.notifyUpdated(ref)
    return Promise.resolve()
  }
}

class DeferredCredentials extends ReferenceOnlyCredentials {
  private release!: () => void
  private readonly readable = new Promise<void>((resolve) => { this.release = resolve })

  allowReads(): void { this.release() }
  resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return this.readable.then(() => undefined)
  }
  describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return this.readable.then(() => ({ configured: false, writable: true }))
  }
  set(_ref: CredentialRef, _value: string): Promise<void> { return Promise.resolve() }
  unset(_ref: CredentialRef): Promise<void> { return Promise.resolve() }
}

async function boot(): Promise<{ ctx: Context; service: GongchuangConnectorService; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  fibers.push(await ctx.plugin(MemorySettings))
  fibers.push(await ctx.plugin(MemoryCredentials))
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(WebRuntime, { searchProvider: 'gongchuang-exa-mcp' }))
  for (const name of ['web_search', 'web_fetch']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `${name} test fixture`,
      parameters: { query: { type: 'string' }, url: { type: 'string' } },
      isConcurrencySafe: () => true,
      execute: async () => [{ type: 'text', text: `${name} result` }],
    }))
  }
  fibers.push(await ctx.plugin(GongchuangConnectorService))
  const service = ctx.get('gongchuangConnectors') as GongchuangConnectorService | undefined
  if (service === undefined) throw new Error('connector service did not mount')
  await service.refresh()
  return {
    ctx,
    service,
    dispose: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GongchuangConnectorService', () => {
  it('isolates an unavailable credential store per connector and recovers on refresh', async () => {
    const { ctx, service, dispose } = await boot()
    try {
      const credentials = ctx.credentials as MemoryCredentials
      credentials.describeFailures.add('QCC_MCP_API_KEY')
      const failed = await service.refresh()
      expect(failed.connectors.find(item => item.id === 'qcc')).toMatchObject({
        phase: 'error', enabled: false,
        message: '系统凭据暂不可用，请允许系统访问后重试（错误代码：MCP_CREDENTIAL_STORE_UNAVAILABLE）',
      })
      expect(failed.connectors.find(item => item.id === 'tianyancha')?.phase).not.toBe('error')
      credentials.describeFailures.clear()
      const recovered = await service.refresh()
      expect(recovered.connectors.find(item => item.id === 'qcc')).toMatchObject({
        phase: 'disabled', enabled: false,
      })
    } finally {
      await dispose()
    }
  })

  it('publishes only verified files as a structured successful result', async () => {
    const { ctx, dispose } = await boot()
    const paths = [join(process.cwd(), 'package.json'), join(process.cwd(), 'pnpm-workspace.yaml')]
    try {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('publish-files-test'),
        name: 'gongchuang_publish_files',
        arguments: { paths },
      })

      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected publication success')
      expect(result.value).toMatchObject({
        files: [
          { path: paths[0], name: 'package.json' },
          { path: paths[1], name: 'pnpm-workspace.yaml' },
        ],
      })
    } finally {
      await dispose()
    }
  })

  it('publishes relative files from the session workspace, never the desktop process cwd', async () => {
    const { ctx, dispose } = await boot()
    const workspace = await mkdtemp(join(tmpdir(), 'gongchuang-publish-relative-'))
    const path = join(workspace, 'report.md')
    await writeFile(path, 'Synthetic report')
    try {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('publish-relative'),
        name: 'gongchuang_publish_files',
        arguments: { paths: ['report.md'] },
        agent: { session: { header: { cwd: workspace } } } as never,
      })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected publication success')
      expect(result.value).toMatchObject({ files: [{ path, name: 'report.md', bytes: 16 }] })

      const withoutSession = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('publish-without-session'),
        name: 'gongchuang_publish_files',
        arguments: { paths: ['package.json'] },
      })
      expect(withoutSession.isError).toBe(true)
      expect(JSON.stringify(withoutSession.content)).toContain('相对路径需要当前企业空间')
    } finally {
      await dispose()
    }
  })

  it('mounts before macOS-style credential reads finish', async () => {
    const ctx = new Context()
    const fibers: Fiber[] = []
    fibers.push(await ctx.plugin(MemorySettings))
    fibers.push(await ctx.plugin(DeferredCredentials))
    fibers.push(await ctx.plugin(SystemPrompt))
    fibers.push(await ctx.plugin(ToolRuntime))
    fibers.push(await ctx.plugin(WebRuntime, { searchProvider: 'gongchuang-exa-mcp' }))
    const credentials = ctx.credentials as DeferredCredentials
    const pendingFiber = ctx.plugin(GongchuangConnectorService)
    const mountedBeforeCredential = await Promise.race([
      pendingFiber.then(() => true),
      new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false) }, 100) }),
    ])
    credentials.allowReads()
    fibers.push(await pendingFiber)
    try {
      const service = ctx.get('gongchuangConnectors') as GongchuangConnectorService | undefined
      if (!service) throw new Error('gongchuangConnectors service was not mounted')
      expect(mountedBeforeCredential).toBe(true)
      expect(service.list().connectors.length).toBeGreaterThan(0)
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  })

  it('accepts official copied credential formats without storing wrappers', () => {
    expect(normalizeConnectorCredential('qcc', 'Bearer qcc-secret')).toBe('qcc-secret')
    expect(normalizeConnectorCredential('qcc', JSON.stringify({
      mcpServers: { qcc: { headers: { Authorization: 'Bearer qcc-json-secret' } } },
    }))).toBe('qcc-json-secret')
    expect(normalizeConnectorCredential('tianyancha', 'Authorization: Bearer tyc-secret')).toBe('tyc-secret')
    expect(() => normalizeConnectorCredential('qcc', '{broken')).toThrow(/JSON/u)
  })

  it('turns QCC transport failures into copyable credential-free error codes', () => {
    expect(qccConnectionFailureMessage([new Error('HTTP 401 Unauthorized: invalid_token')]))
      .toContain('QCC_AUTH_FAILED')
    expect(qccConnectionFailureMessage([new Error('HTTP 403 Forbidden')]))
      .toContain('QCC_PERMISSION_DENIED')
    expect(qccConnectionFailureMessage([new Error('socket hang up')]))
      .toContain('QCC_CONNECTION_FAILED')
  })

  it('distinguishes Tianyancha shared-quota exhaustion from authentication failures', () => {
    expect(connectorConnectionFailureMessage('tianyancha', new Error('quota_exceeded HTTP 429')))
      .toContain('TYC_QUOTA_EXCEEDED')
    expect(connectorConnectionFailureMessage('tianyancha', new Error('HTTP 401 Unauthorized')))
      .toContain('TYC_AUTH_FAILED')
  })

  it('accepts user-added HTTP and stdio MCP definitions without persisting secrets', () => {
    const http = normalizeCustomMcpRequest({
      name: '企业自有 MCP', transport: 'streamable-http', url: 'https://mcp.example.test/service',
      authMode: 'bearer', credentialValue: 'never-persist-this-value',
    })
    expect(http).toMatchObject({
      transport: 'streamable-http', authMode: 'bearer', credentialName: 'Authorization', credentialPrefix: 'Bearer ',
    })
    expect(JSON.stringify(http)).not.toContain('never-persist-this-value')
    expect(normalizeCustomMcpRequest({
      name: '本机工具', transport: 'stdio', command: 'enterprise-mcp', args: ['--stdio'],
      authMode: 'env', credentialName: 'ENTERPRISE_MCP_TOKEN', credentialValue: 'also-not-persisted',
    })).toMatchObject({
      transport: 'stdio', command: 'enterprise-mcp', args: ['--stdio'], authMode: 'env', credentialName: 'ENTERPRISE_MCP_TOKEN',
    })
    expect(() => normalizeCustomMcpRequest({
      name: '不安全远程地址', transport: 'streamable-http', url: 'http://mcp.example.test/service', authMode: 'none',
    })).toThrow(/HTTPS/u)
  })

  it('maps connector startup failures to stable Chinese error codes', () => {
    expect(connectorConnectionFailureMessage(
      'paddle-ocr',
      new Error("Failed to create PaddleOCR inference: Engine 'paddle_static' unavailable because dependency paddlepaddle not installed"),
    )).toBe('PaddleOCR 云端 MCP 错误回退到了本地推理引擎；这属于客户端启动配置问题，不需要安装本地 Paddle 推理包，请重启或更新客户端后重试（错误代码：PADDLE_CLOUD_MODE_CONFIG_FAILED）')
    expect(connectorConnectionFailureMessage(
      'paddle-ocr',
      new Error('mcp startup failed', { cause: new DOMException('The operation was aborted due to timeout', 'TimeoutError') }),
    )).toBe('PaddleOCR 本机 MCP 启动或工具调用超时；Access Token 鉴权会单独提示，请重试或查看连接详情（错误代码：PADDLE_MCP_TIMEOUT）')
    expect(connectorConnectionFailureMessage('paddle-ocr', new Error("Error calling tool 'ocr'")))
      .toBe('PaddleOCR Access Token 已完成单独验证，但本机 MCP 启动、工具发现或调用失败，请查看连接详情后重试（错误代码：PADDLE_MCP_CONNECTION_FAILED）')
    expect(connectorConnectionFailureMessage(
      'paddle-ocr',
      new Error('PaddleOCR Access Token 已通过官方鉴权，但本机 MCP 进程启动或工具发现失败（错误代码：PADDLE_MCP_START_FAILED）'),
    )).toBe('PaddleOCR Access Token 已通过官方鉴权，但本机 MCP 进程启动或工具发现失败（错误代码：PADDLE_MCP_START_FAILED）')
    expect(connectorConnectionFailureMessage(
      'paddle-ocr',
      new Error('PaddleOCR MCP 未获得客户端内置运行时，请重启或更新客户端后重试（错误代码：PADDLE_RUNTIME_BINDING_MISSING）'),
    )).toBe('PaddleOCR MCP 未获得客户端内置运行时，请重启或更新客户端后重试（错误代码：PADDLE_RUNTIME_BINDING_MISSING）')
    expect(connectorConnectionFailureMessage('tianyancha', new Error('HTTP 401')))
      .toBe('天眼查登录授权或 API Key 已失效，请重新登录授权（错误代码：TYC_AUTH_FAILED）')
  })

  it('verifies Paddle credentials without creating an OCR job', async () => {
    const accepted = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }))
    await expect(verifyPaddleOfficialCredential('token', accepted)).resolves.toBeUndefined()
    expect(accepted).toHaveBeenCalledWith(
      'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs/gongchuang-credential-check',
      expect.objectContaining({ method: 'GET', cache: 'no-store', redirect: 'error' }),
    )
    const request = accepted.mock.calls[0]?.[1]
    expect(new Headers(request?.headers).get('authorization')).toBe('Bearer token')
    expect(request?.body).toBeUndefined()

    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 }))
    await expect(verifyPaddleOfficialCredential('expired', rejected)).rejects.toThrow('PADDLE_AUTH_FAILED')
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }))
    await expect(verifyPaddleOfficialCredential('token', unavailable)).rejects.toThrow('PADDLE_SERVICE_UNAVAILABLE')
  })

  it('starts PaddleOCR only through the pinned signed Python runtime', () => {
    const binding = {
      runtimeIntegrity: 'signed',
      paddleOcrMcpVersion: '0.8.5',
      pythonExecutable: process.platform === 'win32' ? 'C:\\signed\\python.exe' : '/signed/python3',
      pythonExecutableSha256: 'a'.repeat(64),
      runtimeIndexSha256: 'b'.repeat(64),
    } as GongchuangSkillRuntimeBinding

    const config = paddleMcpConfig(binding)
    expect(config).toMatchObject({
      command: binding.pythonExecutable,
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
    })
    expect(config.readinessProbe).toBeUndefined()
    expect(JSON.stringify(paddleMcpConfig(binding))).not.toContain('uvx')
    expect(() => paddleMcpConfig({ ...binding, runtimeIntegrity: 'development-external' }))
      .toThrow(/已签名产品运行时/u)
    expect(() => paddleMcpConfig({ ...binding, paddleOcrMcpVersion: '0.8.4' }))
      .toThrow(/已签名产品运行时/u)
  })

  it('loads OCR PDFs only from the current concrete enterprise workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-workspace-pdf-'))
    const workspace = join(root, '共创测试企业')
    await mkdir(join(workspace, '共创导入资料'), { recursive: true })
    const pdf = join(workspace, '共创导入资料', '扫描件.pdf')
    await writeFile(pdf, '%PDF-1.4\n%%EOF\n')
    const loaded = loadWorkspacePdfForOcr(workspace, '共创导入资料/扫描件.pdf')
    expect(loaded.name).toBe('扫描件.pdf')
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(Buffer.from(loaded.bytes).toString('utf8')).toContain('%PDF-')

    const outside = join(root, 'outside.pdf')
    await writeFile(outside, '%PDF-1.4\n%%EOF\n')
    await expect(Promise.resolve().then(() => loadWorkspacePdfForOcr(workspace, '../outside.pdf')))
      .rejects.toThrow('越出当前企业空间')
    const linked = join(workspace, '共创导入资料', '链接.pdf')
    await symlink(outside, linked)
    await expect(Promise.resolve().then(() => loadWorkspacePdfForOcr(workspace, '共创导入资料/链接.pdf')))
      .rejects.toThrow('不能是链接')

    const empty = join(workspace, '共创导入资料', '空白.pdf')
    await writeFile(empty, '')
    await expect(Promise.resolve().then(() => loadWorkspacePdfForOcr(workspace, '共创导入资料/空白.pdf')))
      .rejects.toThrow('必须大于 0')

    const invalid = join(workspace, '共创导入资料', '伪造.pdf')
    await writeFile(invalid, 'not a pdf')
    await expect(Promise.resolve().then(() => loadWorkspacePdfForOcr(workspace, '共创导入资料/伪造.pdf')))
      .rejects.toThrow('内容不是有效 PDF')

    const oversized = join(workspace, '共创导入资料', '超大.pdf')
    const oversizedHandle = await open(oversized, 'w')
    await oversizedHandle.truncate(24 * 1024 * 1024 + 1)
    await oversizedHandle.close()
    await expect(Promise.resolve().then(() => loadWorkspacePdfForOcr(workspace, '共创导入资料/超大.pdf')))
      .rejects.toThrow('不超过 24 MB；请拆分后重试')
  })

  it('carries the selected city on every knowledge MCP connection', () => {
    const config = gongchuangKnowledgeMcpConfig('https://knowledge.example.test/custom/mcp', 'shaoxing')
    expect(config.url).toBe('https://knowledge.example.test/custom/mcp')
    expect(config.headers).toMatchObject({ 'X-Jiaotang-Region': 'shaoxing' })
    expect(config.headerCredentials).toEqual({ Authorization: { ref: 'DONGJIAN_KNOWLEDGE_MCP_TOKEN', prefix: 'Bearer ' } })
  })

  it('uses the current Tianyancha MCP endpoint and a host-owned raw Authorization key', () => {
    expect(tianyanchaMcpConfig()).toEqual({
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
    })
    expect(JSON.stringify(tianyanchaMcpConfig())).not.toContain('open.api.tianyancha.com')
  })

  it('exports the connector and region Remote methods', async () => {
    const { service, dispose } = await boot()
    expect(service.typertRemote.namespace).toBe('gongchuangConnectors')
    expect(remoteMethods(service).map(method => method.method).sort())
      .toEqual(['beginAuthorization', 'cancelAuthorization', 'completeAuthorization', 'configure', 'list', 'refresh', 'removeCustom', 'setEnabled', 'setRegion', 'upsertCustom'])
    await dispose()
  })

  it('keeps Tianyancha device authorization available for explicit retry after a short polling window', async () => {
    vi.spyOn(TianyanchaOAuthCoordinator.prototype, 'start').mockImplementation(async (transactionId = '') => ({
      transactionId, authorizationUrl: 'https://capi.tianyancha.com/oauth/device', userCode: 'TEST',
    }))
    const complete = vi.spyOn(TianyanchaOAuthCoordinator.prototype, 'complete').mockRejectedValue(new Error('请在官方页面确认后重试'))
    vi.spyOn(TianyanchaOAuthCoordinator.prototype, 'hasPending').mockReturnValue(true)
    const { service, dispose } = await boot()
    try {
      const started = await service.beginAuthorization({ id: 'tianyancha' })
      const request = { id: 'tianyancha' as const, transactionId: started.transactionId }
      await expect(service.completeAuthorization(request)).rejects.toThrow('请在官方页面确认后重试')
      await expect(service.completeAuthorization(request)).rejects.toThrow('请在官方页面确认后重试')
      expect(complete).toHaveBeenCalledTimes(2)
      await service.cancelAuthorization(request)
      await expect(service.completeAuthorization(request)).rejects.toThrow('不存在或已取消')
    } finally {
      await dispose()
    }
  })

  it.each(['qcc', 'tianyancha'] as const)('cancels %s before a late token response can change saved credentials', async (id) => {
    const coordinator = id === 'qcc' ? QccOAuthCoordinator.prototype : TianyanchaOAuthCoordinator.prototype
    vi.spyOn(coordinator, 'start').mockImplementation(async (transactionId = '') => ({
      transactionId, authorizationUrl: 'https://authorization.example.test/', userCode: 'TEST',
    }))
    const tokens = Promise.withResolvers<{ accessToken: string; refreshToken: string; clientId: string }>()
    vi.spyOn(coordinator, 'complete').mockReturnValue(tokens.promise)
    const { ctx, service, dispose } = await boot()
    const accessRef = credentialRef(id === 'qcc' ? 'QCC_MCP_API_KEY' : 'TYC_API_TOKEN')
    await ctx.credentials.set(accessRef, 'saved-working-key')
    try {
      const started = await service.beginAuthorization({ id, transactionId: 'cancel-late-token' })
      const complete = service.completeAuthorization({ id, transactionId: started.transactionId })
      const rejected = expect(complete).rejects.toThrow('授权已取消')
      const cancelled = service.cancelAuthorization({ id, transactionId: started.transactionId })
      tokens.resolve({ accessToken: 'late-key', refreshToken: 'late-refresh', clientId: 'test-client' })
      await cancelled
      await rejected
      expect((await ctx.credentials.resolve(accessRef))?.value).toBe('saved-working-key')
      const next = await service.beginAuthorization({ id, transactionId: 'next-attempt' })
      await service.cancelAuthorization({ id, transactionId: started.transactionId })
      expect(next.transactionId).toBe('next-attempt')
      await service.cancelAuthorization({ id, transactionId: next.transactionId })
    } finally {
      await dispose()
    }
  })

  it.each((['qcc', 'tianyancha'] as const).flatMap(id => [
    { id, failRollback: false }, { id, failRollback: true },
  ]))('awaits $id rollback and reports restoration failure: $failRollback', async ({ id, failRollback }) => {
    const coordinator = id === 'qcc' ? QccOAuthCoordinator.prototype : TianyanchaOAuthCoordinator.prototype
    vi.spyOn(coordinator, 'start').mockImplementation(async (transactionId = '') => ({
      transactionId, authorizationUrl: 'https://authorization.example.test/', userCode: 'TEST',
    }))
    vi.spyOn(coordinator, 'complete').mockResolvedValue({
      accessToken: 'new-key', refreshToken: 'new-refresh', clientId: 'test-client',
    })
    const { ctx, service, dispose } = await boot()
    const accessRef = credentialRef(id === 'qcc' ? 'QCC_MCP_API_KEY' : 'TYC_API_TOKEN')
    const refreshRef = credentialRef(id === 'qcc' ? 'QCC_MCP_OAUTH_REFRESH_TOKEN' : 'TYC_MCP_OAUTH_REFRESH_TOKEN')
    const metadataRef = credentialRef(id === 'qcc' ? 'QCC_MCP_OAUTH_METADATA' : 'TYC_MCP_OAUTH_METADATA')
    await ctx.credentials.set(accessRef, 'saved-working-key')
    await ctx.credentials.set(refreshRef, 'saved-refresh')
    await ctx.credentials.set(metadataRef, 'saved-metadata')
    const writing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const set = ctx.credentials.set.bind(ctx.credentials)
    vi.spyOn(ctx.credentials, 'set').mockImplementation(async (ref, value) => {
      if (failRollback && ref === refreshRef && value === 'saved-refresh') throw new Error('credential store unavailable')
      await set(ref, value)
      if (ref === refreshRef && value === 'new-refresh') {
        writing.resolve(undefined)
        await release.promise
      }
    })
    try {
      const started = await service.beginAuthorization({ id, transactionId: 'cancel-during-write' })
      const complete = service.completeAuthorization({ id, transactionId: started.transactionId })
      const rejected = expect(complete).rejects.toThrow(failRollback ? '未能恢复原连接信息' : '授权已取消')
      await writing.promise
      let acknowledged = false
      const cancelled = service.cancelAuthorization({ id, transactionId: started.transactionId }).then(() => { acknowledged = true })
      const cancellation = failRollback ? expect(cancelled).rejects.toThrow('未能恢复原连接信息') : cancelled
      await Promise.resolve()
      expect(acknowledged).toBe(false)
      release.resolve(undefined)
      await cancellation
      await rejected
      expect((await ctx.credentials.resolve(accessRef))?.value).toBe('saved-working-key')
      expect((await ctx.credentials.resolve(refreshRef))?.value).toBe(failRollback ? 'new-refresh' : 'saved-refresh')
      expect((await ctx.credentials.resolve(metadataRef))?.value).toBe('saved-metadata')
      expect(service.list().connectors.find(row => row.id === id)?.enabled).toBe(false)
    } finally {
      release.resolve(undefined)
      await dispose()
    }
  })

  it('reports the built-in evidence search ready only when both web tools exist', async () => {
    const { ctx, service, dispose } = await boot()
    const connector = service.list().connectors.find(row => row.id === 'gongchuang-search')
    expect(connector).toMatchObject({
      phase: 'ready', enabled: true, credentialConfigured: true, toolCount: 3,
      partial: false,
      tools: [
        { name: 'mcp__gongchuang_search__evidence_search' },
        { name: 'web_fetch' },
        { name: 'web_search' },
      ],
    })
    expect(ctx.tools.get('mcp__gongchuang_search__evidence_search')).toBeDefined()
    await dispose()
  })

  it('keeps enterprise connectors disabled until explicit user configuration', async () => {
    const { service, dispose } = await boot()
    for (const id of ['qcc', 'tianyancha', 'paddle-ocr'] as const) {
      expect(service.list().connectors.find(row => row.id === id))
        .toMatchObject({ phase: 'disabled', enabled: false, credentialConfigured: false })
    }
    await dispose()
  })

  it('keeps knowledge optional and accepts independent configuration without an account', async () => {
    const { service, dispose } = await boot()
    expect(service.list().connectors.find(row => row.id === 'gongchuang-knowledge'))
      .toMatchObject({
        phase: 'disabled',
        enabled: false,
        credentialConfigured: false,
        credentialWritable: true,
        endpoint: '',
      })
    await dispose()
  })

  it('connects knowledge with its own endpoint and secret without leaking account credentials', async () => {
    const { ctx, service, dispose } = await boot()
    await ctx.credentials.set(credentialRef('GONGCHUANG_ACCOUNT_TOKEN'), 'obsolete-product-token')
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.url).toBe('https://knowledge.example.test/team/mcp')
      expect(request.headers.get('authorization')).toBe('Bearer knowledge-only-secret')
      expect(request.headers.has('X-Jiaotang-Device-Id')).toBe(false)
      const body = await request.json() as { id?: string | number; method: string }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'knowledge-fixture', version: '1.0.0' } }
        : { tools: [{ name: 'search', description: 'Search knowledge.', inputSchema: { type: 'object', properties: {} } }] }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const request = { id: 'gongchuang-knowledge' as const, endpoint: 'https://knowledge.example.test/team/mcp', value: 'knowledge-only-secret' }
      const snapshot = await service.configure(request)
      expect(snapshot.connectors.find(row => row.id === request.id)).toMatchObject({ phase: 'ready', endpoint: request.endpoint, toolCount: 1 })
      expect(JSON.stringify(snapshot)).not.toContain('knowledge-only-secret')
      expect(JSON.stringify(snapshot)).not.toContain('obsolete-product-token')
      await expect(service.configure({ ...request, value: '' })).resolves.toMatchObject({ connectors: expect.any(Array) })
      expect(fetchMock).toHaveBeenCalled()
    } finally { await dispose() }
  })

  it('rejects an insecure knowledge endpoint before saving secrets or making requests', async () => {
    const { ctx, service, dispose } = await boot()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(service.configure({ id: 'gongchuang-knowledge', endpoint: 'http://knowledge.example.test/mcp', value: 'secret' })).rejects.toThrow('HTTPS')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(await ctx.credentials.resolve(credentialRef('DONGJIAN_KNOWLEDGE_MCP_TOKEN'))).toBeUndefined()
      expect(service.list().connectors.find(row => row.id === 'gongchuang-knowledge')?.endpoint).toBe('')
    } finally { await dispose() }
  })

  it('persists first-run region selection in the trusted connector snapshot', async () => {
    const { service, dispose } = await boot()
    expect(service.list()).toMatchObject({ region: 'all', regionConfirmed: false })
    const snapshot = await service.setRegion({
      region: 'ningbo', confirmed: true, expectedRegion: 'all', expectedConfirmed: false,
    })
    expect(snapshot).toMatchObject({ region: 'ningbo', regionConfirmed: true })
    await dispose()
  })

  it('refuses a delayed region mutation composed from the startup placeholder', async () => {
    const { service, dispose } = await boot()
    await service.setRegion({
      region: 'hangzhou', confirmed: true, expectedRegion: 'all', expectedConfirmed: false,
    })
    await expect(service.setRegion({
      region: 'jinhua', confirmed: true, expectedRegion: 'all', expectedConfirmed: false,
    })).rejects.toThrow('所属地设置已变化，请重新打开选择器后再试')
    expect(service.list()).toMatchObject({ region: 'hangzhou', regionConfirmed: true })
    await dispose()
  })

  it('uses the mounted PaddleOCR tool as the text-only image preprocessor', async () => {
    const { ctx, service, dispose } = await boot()
    const attributedAgent = { id: 'ocr-preprocessor-agent' } as never
    const observedAgents: unknown[] = []
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'mcp__paddle_ocr__ocr') observedAgents.push(exec.agent)
      return next()
    })
    const execute = vi.fn(async (args: unknown) => {
      expect(JSON.stringify(args)).not.toContain('ocr-secret')
      return [{ type: 'text' as const, text: JSON.stringify({ text: '研发费用 123 万元', confidence: 0.98 }) }]
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'mcp__paddle_ocr__ocr',
      description: 'PaddleOCR test fixture',
      parameters: { input_data: { type: 'string' } },
      isConcurrencySafe: () => true,
      execute,
    }))
    const result = await service.preprocessImages([{
      type: 'image', mediaType: 'image/png', data: ONE_PIXEL_PNG, name: 'scan.png',
    }], new AbortController().signal, attributedAgent)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ text: '研发费用 123 万元', method: 'ocr' })
    expect(result[0]?.limitations).toContain('OCR 仅提取可见文字')
    expect(result[0]?.limitations).toContain('百度 AI Studio 云端接口')
    expect(result[0]?.limitations).toContain('不是本地推理')
    expect(result[0]?.limitations).toContain('无需重新查找或读取工作区中的原图')
    expect(result[0]?.limitations).toContain('OCR 处理：切片 1 个')
    expect(result[0]?.limitations).not.toMatch(/SHA[\s_-]*256|[0-9a-f]{64}/iu)
    expect(execute).toHaveBeenCalledOnce()
    expect(observedAgents).toEqual([attributedAgent])

    const retried = await service.preprocessImages([{
      type: 'image', mediaType: 'image/png', data: ONE_PIXEL_PNG, name: 'scan.png',
    }], new AbortController().signal, attributedAgent)
    expect(retried[0]?.limitations).toContain('本次复用已完成切片 1 个')
    expect(execute).toHaveBeenCalledOnce()
    await dispose()
  })

  it('splits a tall screenshot locally and removes only exact OCR boundary repeats', async () => {
    const { ctx, service, dispose } = await boot()
    const replies = [
      '企业名称：共创测试企业\n研发费用：120万元',
      '研发费用：120万元\n知识产权：8件',
      '知识产权：9件\n结论：待核验',
    ]
    let cursor = 0
    const execute = vi.fn(async (args: unknown) => {
      const payload = JSON.parse(JSON.stringify(args)) as { input_data?: string }
      expect(payload.input_data).toMatch(/^data:image\/png;base64,/u)
      const text = replies[Math.min(cursor, replies.length - 1)] ?? ''
      cursor += 1
      return [{ type: 'text' as const, text: JSON.stringify({ text }) }]
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'mcp__paddle_ocr__ocr',
      description: 'PaddleOCR long screenshot fixture',
      parameters: { input_data: { type: 'string' } },
      isConcurrencySafe: () => true,
      execute,
    }))
    const image = await sharp({
      create: { width: 1_000, height: 8_000, channels: 3, background: '#ffffff' },
    }).png().toBuffer()
    const result = await service.preprocessImages([{
      type: 'image', mediaType: 'image/png', data: image.toString('base64'), name: 'long.png',
    }], new AbortController().signal)
    expect(execute.mock.calls.length).toBeGreaterThan(2)
    expect(result[0]?.text).toContain('研发费用：120万元\n\n知识产权：8件')
    expect(result[0]?.text).toContain('知识产权：9件')
    expect(result[0]?.limitations).toContain('长截图会先在本机')
    await dispose()
  })

  it('stores a Tianyancha key, registers MCP entry tools, and sends the raw Authorization header', async () => {
    const { ctx, service, dispose } = await boot()
    const changedRevisions: number[] = []
    ctx.on('gongchuang-connectors/changed', (revision) => { changedRevisions.push(revision) })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.url).toBe('https://mcp.tianyancha.com/mcp')
      expect(request.headers.get('Authorization')).toBe('tyc-secret')
      const body = await request.json() as { id?: string | number; method: string }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      const result = body.method === 'initialize'
        ? {
          protocolVersion: '2025-03-26', capabilities: { tools: {} },
          serverInfo: { name: 'tianyancha-fixture', version: '1.0.0' },
        }
        : body.method === 'tools/list'
          ? {
            tools: [{
              name: 'search_companies', description: 'Search companies.',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
            }],
          }
          : { content: [{ type: 'text', text: JSON.stringify({ items: [{ name: '共创测试企业' }] }) }] }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))

    await ctx.credentials.set(credentialRef('TYC_MCP_OAUTH_REFRESH_TOKEN'), 'stale-oauth-refresh')
    await ctx.credentials.set(credentialRef('TYC_MCP_OAUTH_METADATA'), '{"clientId":"stale-oauth-client"}')
    const snapshot = await service.configure({ id: 'tianyancha', value: 'Authorization: Bearer tyc-secret' })
    await expect(ctx.credentials.resolve(credentialRef('TYC_MCP_OAUTH_REFRESH_TOKEN'))).resolves.toBeUndefined()
    await expect(ctx.credentials.resolve(credentialRef('TYC_MCP_OAUTH_METADATA'))).resolves.toBeUndefined()
    expect(snapshot.connectors.find(row => row.id === 'tianyancha'))
      .toMatchObject({
        phase: 'ready', enabled: true, credentialConfigured: true, toolCount: 1,
        partial: false,
        message: '天眼查官方 MCP 已连接，共 1 个入口工具；深层业务能力按能力目录调用',
      })
    expect(snapshot.connectors.find(row => row.id === 'tianyancha')?.lastVerifiedAt).toMatch(/^\d{4}-/u)

    ctx.emit('mcp/connection-state', {
      serverName: 'tianyancha', phase: 'reconnecting',
      message: '连接已中断，500 毫秒后自动重连（第 1/10 次）', attempt: 1, maxAttempts: 10,
    })
    const reconnecting = service.list().connectors.find(row => row.id === 'tianyancha')
    expect(reconnecting).toMatchObject({ phase: 'connecting' })
    expect(reconnecting?.message).toContain('自动重连')
    expect(changedRevisions.at(-1)).toBe(service.list().revision)

    ctx.emit('mcp/connection-state', {
      serverName: 'tianyancha', phase: 'ready',
      message: '连接已恢复并重新发现工具', attempt: null, maxAttempts: 10,
    })
    expect(service.list().connectors.find(row => row.id === 'tianyancha'))
      .toMatchObject({ phase: 'ready', toolCount: 1 })
    expect(changedRevisions.at(-1)).toBe(service.list().revision)

    ctx.emit('mcp/connection-state', {
      serverName: 'tianyancha', phase: 'failed',
      message: '连接已中断，请检查网络或凭据后手动刷新', attempt: 10, maxAttempts: 10,
    })
    const failed = service.list().connectors.find(row => row.id === 'tianyancha')
    expect(failed).toMatchObject({ phase: 'error' })
    expect(failed?.message).toContain('请检查网络或凭据')
    expect(changedRevisions.at(-1)).toBe(service.list().revision)

    // A later tool-registry reconciliation must not infer green readiness
    // from a surviving product helper tool while the MCP transport is failed.
    const unregisterHelper = ctx.tools.register(defineContentToolFixture({
      name: 'mcp__tianyancha__product_helper',
      description: 'Product helper that survives an MCP transport outage.',
      parameters: {},
      isConcurrencySafe: () => true,
      execute: async () => [{ type: 'text', text: 'helper' }],
    }))
    unregisterHelper()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(service.list().connectors.find(row => row.id === 'tianyancha'))
      .toMatchObject({ phase: 'error', toolCount: 1 })

    ctx.emit('mcp/connection-state', {
      serverName: 'tianyancha', phase: 'ready',
      message: '连接已恢复并重新发现工具', attempt: null, maxAttempts: 10,
    })
    expect(service.list().connectors.find(row => row.id === 'tianyancha'))
      .toMatchObject({ phase: 'ready', toolCount: 1 })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('tyc-search-test'),
      name: 'mcp__tianyancha__search_companies',
      arguments: { query: '共创' },
    })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('共创测试企业')
    expect(JSON.stringify(result.content)).not.toContain('tyc-secret')
    await dispose()
  })

  it('stores Tianyancha Device Flow tokens in Host credentials and verifies tools/list', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url.endsWith('/.well-known/oauth-protected-resource/mcp')) {
        return new Response(JSON.stringify({
          resource: 'https://mcp.tianyancha.com/mcp',
          authorization_servers: ['https://capi.tianyancha.com/oauth'],
          scopes_supported: ['mcp:tools.call', 'mcp:quota.read'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (request.url.endsWith('/.well-known/oauth-authorization-server/oauth')) {
        return new Response(JSON.stringify({
          issuer: 'https://capi.tianyancha.com/oauth',
          registration_endpoint: 'https://capi.tianyancha.com/oauth/register',
          device_authorization_endpoint: 'https://capi.tianyancha.com/oauth/device_authorization',
          token_endpoint: 'https://capi.tianyancha.com/oauth/token',
          grant_types_supported: ['refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
          scopes_supported: ['mcp:tools.call'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (request.url.endsWith('/oauth/register')) {
        return new Response(JSON.stringify({ client_id: 'tyc-device-client', client_secret: 'tyc-device-secret' }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (request.url.endsWith('/oauth/device_authorization')) {
        return new Response(JSON.stringify({
          device_code: 'tyc-device-code', user_code: '246810',
          verification_uri: 'https://capi.tianyancha.com/oauth/device', expires_in: 600, interval: 5,
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (request.url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: 'tyc-device-access', refresh_token: 'tyc-device-refresh', expires_in: 3_600,
        }), { headers: { 'content-type': 'application/json' } })
      }
      expect(request.url).toBe('https://mcp.tianyancha.com/mcp')
      expect(request.headers.get('Authorization')).toBe('Bearer tyc-device-access')
      const body = await request.json() as { id?: string | number; method: string }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      const result = body.method === 'initialize'
        ? {
          protocolVersion: '2025-03-26', capabilities: { tools: {} },
          serverInfo: { name: 'tianyancha-device-flow-fixture', version: '1.0.0' },
        }
        : {
          tools: [{
            name: 'search_companies', description: 'Search companies.',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          }],
        }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        headers: { 'content-type': 'application/json' },
      })
    }))
    const { ctx, service, dispose } = await boot()
    try {
      const started = await service.beginAuthorization({ id: 'tianyancha' })
      expect(started).toMatchObject({ id: 'tianyancha', userCode: '246810' })
      expect(JSON.stringify(started)).not.toContain('tyc-device-access')

      const snapshot = await service.completeAuthorization({
        id: 'tianyancha', transactionId: started.transactionId,
      })
      expect(snapshot.connectors.find(row => row.id === 'tianyancha'))
        .toMatchObject({ phase: 'ready', enabled: true, toolCount: 1 })
      await expect(ctx.credentials.resolve(credentialRef('TYC_API_TOKEN')))
        .resolves.toMatchObject({ value: 'Bearer tyc-device-access' })
      await expect(ctx.credentials.resolve(credentialRef('TYC_MCP_OAUTH_REFRESH_TOKEN')))
        .resolves.toMatchObject({ value: 'tyc-device-refresh' })
      const metadata = await ctx.credentials.resolve(credentialRef('TYC_MCP_OAUTH_METADATA'))
      expect(metadata?.value).toContain('tyc-device-client')
      expect(metadata?.value).toContain('tyc-device-secret')
    } finally {
      await dispose()
    }
  })

  it('fails closed when a QCC OAuth token is expired and refresh is rejected', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === 'https://agent.qcc.com/oauth/token') {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 401, headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected request after rejected refresh: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, service, dispose } = await boot()
    try {
      await ctx.credentials.set(credentialRef('QCC_MCP_API_KEY'), 'expired-access-token')
      await ctx.credentials.set(credentialRef('QCC_MCP_OAUTH_REFRESH_TOKEN'), 'expired-refresh-token')
      await ctx.credentials.set(credentialRef('QCC_MCP_OAUTH_METADATA'), JSON.stringify({
        clientId: 'qcc-expiry-test-client',
        expiresAt: '2026-08-16T00:00:00.000Z',
      }))

      const snapshot = await service.setEnabled({ id: 'qcc', enabled: true })
      const qcc = snapshot.connectors.find(row => row.id === 'qcc')
      expect(fetchMock).toHaveBeenCalled()
      expect(qcc).toMatchObject({ phase: 'error', enabled: true, credentialConfigured: true })
      expect(qcc?.message).toContain('QCC_OAUTH_REFRESH_FAILED')
      await expect(ctx.credentials.resolve(credentialRef('QCC_MCP_API_KEY')))
        .resolves.toMatchObject({ value: 'expired-access-token' })
      await expect(ctx.credentials.resolve(credentialRef('QCC_MCP_OAUTH_REFRESH_TOKEN')))
        .resolves.toMatchObject({ value: 'expired-refresh-token' })
    } finally {
      await dispose()
    }
  })

  it('fails closed and restores Tianyancha OAuth credentials when refresh is rejected', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === 'https://capi.tianyancha.com/oauth/token') {
        const body = requestBody(init)
        expect(body).toContain('grant_type=refresh_token')
        expect(body).toContain('client_secret=tyc-client-secret')
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 401, headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected request after rejected refresh: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, service, dispose } = await boot()
    try {
      await ctx.credentials.set(credentialRef('TYC_API_TOKEN'), 'Bearer expired-access-token')
      await ctx.credentials.set(credentialRef('TYC_MCP_OAUTH_REFRESH_TOKEN'), 'expired-refresh-token')
      const metadata = JSON.stringify({
        clientId: 'tyc-expiry-test-client',
        clientSecret: 'tyc-client-secret',
        expiresAt: '2026-08-16T00:00:00.000Z',
      })
      await ctx.credentials.set(credentialRef('TYC_MCP_OAUTH_METADATA'), metadata)

      const snapshot = await service.setEnabled({ id: 'tianyancha', enabled: true })
      const tianyancha = snapshot.connectors.find(row => row.id === 'tianyancha')
      expect(fetchMock).toHaveBeenCalled()
      expect(tianyancha).toMatchObject({ phase: 'error', enabled: true, credentialConfigured: true })
      expect(tianyancha?.message).toContain('TYC_OAUTH_REFRESH_FAILED')
      await expect(ctx.credentials.resolve(credentialRef('TYC_API_TOKEN')))
        .resolves.toMatchObject({ value: 'Bearer expired-access-token' })
      await expect(ctx.credentials.resolve(credentialRef('TYC_MCP_OAUTH_REFRESH_TOKEN')))
        .resolves.toMatchObject({ value: 'expired-refresh-token' })
      await expect(ctx.credentials.resolve(credentialRef('TYC_MCP_OAUTH_METADATA')))
        .resolves.toMatchObject({ value: metadata })
    } finally {
      await dispose()
    }
  })

  it('connects the independent QCC MCP services concurrently', async () => {
    let initializeInFlight = 0
    let maxInitializeInFlight = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.url).toMatch(/^https:\/\/agent\.qcc\.com\/mcp\//u)
      expect(request.headers.get('Authorization')).toBe('Bearer qcc-parallel-secret')
      const body = await request.json() as { id?: string | number; method: string }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (body.method === 'initialize') {
        initializeInFlight += 1
        maxInitializeInFlight = Math.max(maxInitializeInFlight, initializeInFlight)
        await new Promise(resolve => setTimeout(resolve, 20))
        initializeInFlight -= 1
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: body.id,
          result: {
            protocolVersion: '2025-03-26', capabilities: { tools: {} },
            serverInfo: { name: 'qcc-parallel-fixture', version: '1.0.0' },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: body.id,
        result: {
          tools: [{
            name: 'lookup', description: 'QCC lookup fixture.',
            inputSchema: { type: 'object', properties: {} },
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const { service, dispose } = await boot()
    try {
      const snapshot = await service.configure({ id: 'qcc', value: 'qcc-parallel-secret' })
      expect(maxInitializeInFlight).toBeGreaterThan(1)
      expect(snapshot.connectors.find(row => row.id === 'qcc')).toMatchObject({
        phase: 'ready', toolCount: 10, partial: false,
      })
    } finally {
      await dispose()
    }
  })

  it('restores the previous Tianyancha credential and tool mount when a replacement fails', async () => {
    const { ctx, service, dispose } = await boot()
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.url).toBe('https://mcp.tianyancha.com/mcp')
      if (request.headers.get('Authorization') === 'rejected-tyc-key') {
        return new Response(JSON.stringify({ error: 'invalid credential' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      expect(request.headers.get('Authorization')).toBe('retained-tyc-key')
      const body = await request.json() as { id?: string | number; method: string }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      const result = body.method === 'initialize'
        ? {
          protocolVersion: '2025-03-26', capabilities: { tools: {} },
          serverInfo: { name: 'tianyancha-rollback-fixture', version: '1.0.0' },
        }
        : body.method === 'tools/list'
          ? {
            tools: [{
              name: 'search_companies', description: 'Search companies.',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
            }],
          }
          : { content: [{ type: 'text', text: JSON.stringify({ items: [{ name: '恢复后的企业结果' }] }) }] }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))

    try {
      await service.configure({ id: 'tianyancha', value: 'retained-tyc-key' })
      await expect(service.configure({ id: 'tianyancha', value: 'rejected-tyc-key' })).rejects.toThrow()
      await expect(ctx.credentials.resolve(credentialRef('TYC_API_TOKEN')))
        .resolves.toMatchObject({ value: 'retained-tyc-key' })
      expect(service.list().connectors.find(row => row.id === 'tianyancha'))
        .toMatchObject({ phase: 'ready', enabled: true, toolCount: 1 })

      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('tyc-rollback-test'),
        name: 'mcp__tianyancha__search_companies',
        arguments: { query: '恢复验证' },
      })
      expect(result.isError).toBe(false)
      expect(JSON.stringify(result.content)).toContain('恢复后的企业结果')
    } finally {
      await dispose()
    }
  })
})
