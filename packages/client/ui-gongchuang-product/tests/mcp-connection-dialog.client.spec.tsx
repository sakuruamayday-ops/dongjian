// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GongchuangConnectorView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectorState } from '../src/client/connectors.ts'
import { zh, type ProductKey } from '../src/client/locales.ts'
import { ProductOverlay, type ProductOverlayProps, type ProductUiState } from '../src/client/ProductShell.tsx'

afterEach(cleanup)

function hook<TState>(state: TState) {
  return <TSelected,>(selector: (value: TState) => TSelected): TSelected => selector(state)
}

function paddleConnector(overrides: Partial<GongchuangConnectorView> = {}): GongchuangConnectorView {
  return {
    id: 'paddle-ocr',
    name: 'PaddleOCR MCP',
    phase: 'missing-credential',
    enabled: true,
    credentialConfigured: false,
    credentialWritable: true,
    officialConfigUrl: 'https://aistudio.baidu.com/account/accessToken',
    toolCount: 0,
    tools: [],
    verificationMethod: '保存后连接并发现 MCP 工具',
    lastVerifiedAt: null,
    partial: false,
    message: '缺少百度 AI Studio Access Token',
    custom: false,
    transport: null,
    endpoint: '',
    arguments: [],
    cwd: '',
    authMode: null,
    credentialName: '',
    credentialPrefix: '',
    ...overrides,
  }
}

function renderPaddle(
  configureMcp = vi.fn(() => Promise.resolve()),
  connector = paddleConnector(),
) {
  const product: ProductUiState = { page: 'mcp', provider: 'deepseek', accountDialogRevision: 0 }
  const connectors: ConnectorState = {
    status: 'ready',
    snapshot: { revision: 2, region: 'all', regionConfirmed: true, connectors: [connector] },
    error: null,
  }
  const props = {
    t: (key: ProductKey) => zh[key],
    useProduct: hook(product),
    useWindowsClosePrompt: hook({ requestId: null }),
    useConnectivity: hook({ deepseekFiles: { retentionSeconds: 3_600 } }),
    useConnectors: hook(connectors),
    configureMcp,
    setMcpEnabled: vi.fn(() => Promise.resolve()),
    requestAccountLogin: vi.fn(),
  }
  render(<ProductOverlay {...props as unknown as ProductOverlayProps} />)
  return { configureMcp }
}

describe('PaddleOCR connection dialog', () => {
  it('keeps knowledge MCP setup independent of any product login page', async () => {
    const { configureMcp } = renderPaddle(undefined, paddleConnector({ id: 'gongchuang-knowledge', name: '知识库 MCP', officialConfigUrl: '', enabled: false }))
    fireEvent.click(screen.getByRole('button', { name: '配置并连接' }))
    const dialog = screen.getByRole('dialog', { name: '连接知识库' })
    expect(within(dialog).queryByRole('link')).toBeNull()
    expect(within(dialog).getByLabelText('知识库连接地址')).toBeTruthy()
    expect(within(dialog).getByText('添加微信，连接知识库')).toBeTruthy()
    expect(within(dialog).getByRole('img', { name: '微信联系二维码' }).getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/u)
    expect(within(dialog).queryByText('登录官方平台')).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('知识库连接地址'), { target: { value: 'https://knowledge.example/mcp/' } })
    fireEvent.change(within(dialog).getByLabelText('知识库访问密钥'), { target: { value: 'contact-flow-fixture' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '连接并验证' }))
    await waitFor(() => { expect(configureMcp).toHaveBeenCalledWith('gongchuang-knowledge', 'contact-flow-fixture', 'https://knowledge.example/mcp/') })
  })

  it('discloses the remote data recipient and requires consent before Host verification', async () => {
    const { configureMcp } = renderPaddle()
    expect(screen.getByText(/所选图片或扫描 PDF 会上传到该服务/u)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '配置并连接' }))
    expect(screen.getByRole('dialog', { name: '连接PaddleOCR MCP' })).toBeTruthy()
    expect(screen.getByText('先确认数据去向')).toBeTruthy()
    expect(screen.getByText(/不是本地离线识别/u)).toBeTruthy()
    expect(screen.getByText(/校验 Token，不上传任何文件/u)).toBeTruthy()
    expect(screen.queryByText(/测试图/u)).toBeNull()
    expect(screen.getByRole('link', { name: /打开 AI Studio Access Token 页面/u }).getAttribute('href'))
      .toBe('https://aistudio.baidu.com/account/accessToken')

    const submit = screen.getByRole('button', { name: '授权并连接' }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText('百度 AI Studio Access Token'), { target: { value: 'renderer-only-test-token' } })
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /我已知晓/u }))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)

    await waitFor(() => {
      expect(configureMcp).toHaveBeenCalledWith('paddle-ocr', 'renderer-only-test-token')
    })
  })

  it('keeps the dialog open and never presents ready after failed tool discovery', async () => {
    const configureMcp = vi.fn(() => Promise.reject(new Error('PaddleOCR MCP 未发现可用工具')))
    renderPaddle(configureMcp)
    fireEvent.click(screen.getByRole('button', { name: '配置并连接' }))
    fireEvent.change(screen.getByLabelText('百度 AI Studio Access Token'), { target: { value: 'invalid-test-token' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /我已知晓/u }))
    fireEvent.click(screen.getByRole('button', { name: '授权并连接' }))

    expect((await screen.findByRole('alert')).textContent).toContain('未发现可用工具')
    expect(screen.getByRole('dialog', { name: '连接PaddleOCR MCP' })).toBeTruthy()
    expect(screen.queryByText('已就绪')).toBeNull()
  })

  it('copies the complete connector failure for support diagnosis', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const failure = '企查查 API Key 未通过官方鉴权（错误代码：QCC_AUTH_FAILED）'
    const configureMcp = vi.fn(() => Promise.reject(new Error(failure)))
    renderPaddle(configureMcp)
    fireEvent.click(screen.getByRole('button', { name: '配置并连接' }))
    fireEvent.change(screen.getByLabelText('百度 AI Studio Access Token'), { target: { value: 'invalid-test-token' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /我已知晓/u }))
    fireEvent.click(screen.getByRole('button', { name: '授权并连接' }))

    const alert = await screen.findByRole('alert')
    fireEvent.click(within(alert).getByRole('button', { name: '复制连接错误代码和详情' }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(failure)
      expect(within(alert).getByRole('button', { name: '复制连接错误代码和详情' }).textContent).toBe('已复制')
    })
  })

  it('copies a restored connector failure after relaunch', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const failure = 'PaddleOCR Access Token 未通过官方鉴权（错误代码：PADDLE_AUTH_FAILED）'
    renderPaddle(vi.fn(() => Promise.resolve()), paddleConnector({
      phase: 'error',
      credentialConfigured: true,
      message: failure,
    }))

    const copyButton = screen.getByRole('button', { name: '复制PaddleOCR MCP连接错误代码和详情' })
    fireEvent.click(copyButton)
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(failure)
      expect(copyButton.textContent).toBe('已复制')
    })
  })

  it('closes connector details and idle configuration with Escape', () => {
    renderPaddle()

    const detailButtons = screen.getAllByRole('button', { name: '查看详情' })
    fireEvent.click(detailButtons[detailButtons.length - 1]!)
    expect(screen.getByRole('dialog', { name: 'PaddleOCR MCP' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'PaddleOCR MCP' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '配置并连接' }))
    expect(screen.getByRole('dialog', { name: '连接PaddleOCR MCP' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '连接PaddleOCR MCP' })).toBeNull()
  })
})

describe('企查查官方授权', () => {
  it('offers browser authorization first and keeps API Key paste as a fallback', async () => {
    const authorizeQcc = vi.fn(() => Promise.resolve())
    const qcc = paddleConnector({
      id: 'qcc', name: '企查查 MCP', officialConfigUrl: 'https://agent.qcc.com/profile/api-key',
      message: '请先登录企查查或粘贴官方平台密钥',
    })
    const product: ProductUiState = { page: 'mcp', provider: 'opencode-go', accountDialogRevision: 0 }
    const connectors: ConnectorState = {
      status: 'ready', snapshot: { revision: 3, region: 'all', regionConfirmed: true, connectors: [qcc] }, error: null,
    }
    render(<ProductOverlay {...{
      useProduct: hook(product),
      useWindowsClosePrompt: hook({ requestId: null }),
      useConnectivity: hook({ deepseekFiles: { retentionSeconds: 3_600 } }),
      useConnectors: hook(connectors), authorizeQcc,
      configureMcp: vi.fn(() => Promise.resolve()), setMcpEnabled: vi.fn(() => Promise.resolve()),
      requestAccountLogin: vi.fn(),
    } as unknown as ProductOverlayProps} />)
    fireEvent.click(screen.getByRole('button', { name: '配置并连接' }))
    expect(screen.getByText('推荐：登录企查查并授权')).toBeTruthy()
    expect(screen.getByLabelText('企查查 API Key')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '登录企查查并授权' }))
    await waitFor(() => { expect(authorizeQcc).toHaveBeenCalledOnce() })
  })
})

describe('official authorization wait', () => {
  it.each(['qcc', 'tianyancha'] as const)('cancels %s approval without closing a later dialog', async (id) => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const cancelMcpAuthorization = vi.fn(async () => undefined)
    const connector = paddleConnector({ id, name: id === 'qcc' ? '企查查 MCP' : '天眼查数据连接器' })
    const connectors: ConnectorState = {
      status: 'ready', snapshot: { revision: 3, region: 'all', regionConfirmed: true, connectors: [connector, paddleConnector()] }, error: null,
    }
    render(<ProductOverlay {...{
      useProduct: hook<ProductUiState>({ page: 'mcp', provider: 'opencode-go', accountDialogRevision: 0 }),
      useWindowsClosePrompt: hook({ requestId: null }),
      useConnectivity: hook({ deepseekFiles: { retentionSeconds: 3_600 } }),
      useConnectors: hook(connectors),
      authorizeQcc: () => pending,
      beginTianyanchaAuthorization: async () => ({
        id: 'tianyancha', transactionId: 'tyc-ui-wait', authorizationUrl: 'https://capi.tianyancha.com/oauth/device', userCode: '654321',
      }),
      completeTianyanchaAuthorization: () => pending,
      cancelMcpAuthorization,
      configureMcp: vi.fn(async () => undefined), setMcpEnabled: vi.fn(async () => undefined),
      requestAccountLogin: vi.fn(),
    } as unknown as ProductOverlayProps} />)
    const card = screen.getByRole('heading', { name: id === 'qcc' ? '企查查 MCP' : '天眼查 MCP' }).closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: '配置并连接' }))
    if (id === 'qcc') fireEvent.click(screen.getByRole('button', { name: '登录企查查并授权' }))
    else {
      fireEvent.click(screen.getByRole('button', { name: '登录并授权' }))
      fireEvent.click(await screen.findByRole('button', { name: '我已完成授权' }))
    }
    const back = await screen.findByRole('button', { name: /^取消$/ }) as HTMLButtonElement
    expect(back.disabled).toBe(false)
    fireEvent.click(back)
    expect(cancelMcpAuthorization).toHaveBeenCalledWith(id)
    const otherCard = screen.getByRole('heading', { name: 'PaddleOCR MCP' }).closest('article')!
    fireEvent.click(within(otherCard).getByRole('button', { name: '配置并连接' }))
    fireEvent.change(screen.getByLabelText('百度 AI Studio Access Token'), { target: { value: 'keep-pending-input' } })
    await act(async () => { finish(); await pending })
    expect(screen.getByRole('dialog', { name: '连接PaddleOCR MCP' })).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>('百度 AI Studio Access Token').value).toBe('keep-pending-input')
  })
})

describe('天眼查官方授权', () => {
  it('shows the Device Flow code and completes only after explicit confirmation', async () => {
    const beginTianyanchaAuthorization = vi.fn(() => Promise.resolve({
      id: 'tianyancha' as const,
      transactionId: 'tyc-ui-transaction',
      authorizationUrl: 'https://capi.tianyancha.com/oauth/device',
      userCode: '654321',
    }))
    const completeTianyanchaAuthorization = vi.fn(() => Promise.resolve())
    const tianyancha = paddleConnector({
      id: 'tianyancha', name: '天眼查数据连接器', officialConfigUrl: 'https://www.tianyancha.com/ai',
      message: '请先登录天眼查或粘贴官方平台密钥',
    })
    const product: ProductUiState = { page: 'mcp', provider: 'opencode-go', accountDialogRevision: 0 }
    const connectors: ConnectorState = {
      status: 'ready', snapshot: {
        revision: 4, region: 'all', regionConfirmed: true, connectors: [tianyancha],
      }, error: null,
    }
    render(<ProductOverlay {...{
      useProduct: hook(product),
      useWindowsClosePrompt: hook({ requestId: null }),
      useConnectivity: hook({ deepseekFiles: { retentionSeconds: 3_600 } }),
      useConnectors: hook(connectors), beginTianyanchaAuthorization, completeTianyanchaAuthorization,
      configureMcp: vi.fn(() => Promise.resolve()), setMcpEnabled: vi.fn(() => Promise.resolve()),
      requestAccountLogin: vi.fn(),
    } as unknown as ProductOverlayProps} />)

    fireEvent.click(screen.getByRole('button', { name: '配置并连接' }))
    fireEvent.click(screen.getByRole('button', { name: '登录并授权' }))
    await waitFor(() => { expect(screen.getByText('654321')).toBeTruthy() })
    expect(completeTianyanchaAuthorization).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '我已完成授权' }))
    await waitFor(() => {
      expect(completeTianyanchaAuthorization).toHaveBeenCalledWith('tyc-ui-transaction')
    })
  })
})
