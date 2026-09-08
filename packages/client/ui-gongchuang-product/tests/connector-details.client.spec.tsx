// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GongchuangConnectorView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectorState } from '../src/client/connectors.ts'
import { ProductOverlay, type ProductOverlayProps, type ProductUiState } from '../src/client/ProductShell.tsx'

afterEach(cleanup)

function hook<TState>(state: TState) {
  return <TSelected,>(selector: (value: TState) => TSelected): TSelected => selector(state)
}

function connector(overrides: Partial<GongchuangConnectorView> = {}): GongchuangConnectorView {
  return {
    id: 'gongchuang-search', name: '共创联网检索 MCP', phase: 'ready', enabled: true,
    credentialConfigured: true, credentialWritable: false, officialConfigUrl: '', toolCount: 3,
    tools: [
      { name: 'mcp__gongchuang_search__evidence_search', description: '执行共创证据检索编排。' },
      { name: 'web_search', description: '发现候选网页。' },
      { name: 'web_fetch', description: '读取网页原文。' },
    ],
    verificationMethod: '核验三个检索工具均已注册。', lastVerifiedAt: '2026-08-15T01:00:00.000Z',
    partial: false, message: '真实连接已就绪，共 3 个工具',
    custom: false, transport: null, endpoint: '', arguments: [], cwd: '', authMode: null,
    credentialName: '', credentialPrefix: '', ...overrides,
  }
}

function renderPage(page: 'mcp', connectors: readonly GongchuangConnectorView[]) {
  const product: ProductUiState = { page, provider: 'deepseek', accountDialogRevision: 0 }
  const state: ConnectorState = {
    status: 'ready', snapshot: { revision: 2, region: 'all', regionConfirmed: true, connectors }, error: null,
  }
  const props = {
    useProduct: hook(product),
    useWindowsClosePrompt: hook({ requestId: null }),
    useConnectivity: hook({ deepseekFiles: { retentionSeconds: 3_600 } }),
    useConnectors: hook(state), requestAccountLogin: vi.fn(),
    setMcpEnabled: vi.fn(() => Promise.resolve()), configureMcp: vi.fn(() => Promise.resolve()),
  }
  render(<ProductOverlay {...props as unknown as ProductOverlayProps} />)
  return props
}

describe('连接器与联网检索能力详情', () => {
  it('联网检索作为内部能力运行，不在 MCP 页面单独展示', () => {
    renderPage('mcp', [connector()])
    expect(screen.queryByText('共创联网检索 MCP')).toBeNull()
    expect(screen.queryByText('连接受门禁保护')).toBeNull()
  })

  it('MCP 卡片可打开真实验证方式和 tools/list 结果', () => {
    const qcc = connector({
      id: 'qcc', name: '企查查 MCP', officialConfigUrl: 'https://agent.qcc.com/profile/api-key',
      toolCount: 2, tools: [
        { name: 'mcp__qcc_company__search', description: '企业检索' },
        { name: 'mcp__qcc_risk__risk_scan', description: '风险检索' },
      ], verificationMethod: '连接官方 MCP 并执行 tools/list。',
    })
    renderPage('mcp', [qcc])
    const card = screen.getByRole('heading', { name: '企查查 MCP' }).closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: '查看详情' }))
    const dialog = screen.getByRole('dialog', { name: '企查查 MCP' })
    expect(within(dialog).getByText('连接官方 MCP 并执行 tools/list。')).toBeTruthy()
    expect(within(dialog).getByText('mcp__qcc_company__search')).toBeTruthy()
    expect(within(dialog).getByText('mcp__qcc_risk__risk_scan')).toBeTruthy()
  })
})
