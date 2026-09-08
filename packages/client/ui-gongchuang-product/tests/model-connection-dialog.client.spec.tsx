// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectivityState } from '../src/client/connectivity.ts'
import type { ImageTransferConsentState } from '../src/client/image-transfer-consent.ts'
import {
  ImageTransferProviderNotice, ProductOverlay, providerHealthLabel,
  type ImageTransferProviderNoticeProps, type ProductOverlayProps, type ProductUiState,
  type ProfessionalTaskStatusState,
} from '../src/client/ProductShell.tsx'
import { providerConnections } from './provider-connections.client.ts'
import { zh, type ProductKey } from '../src/client/locales.ts'

afterEach(cleanup)

function hook<TState>(state: TState) {
  return <TSelected,>(selector: (value: TState) => TSelected): TSelected => selector(state)
}

function renderAssistant(
  connectivity: ConnectivityState,
  configureProvider: ProductOverlayProps['configureProvider'] = vi.fn(() => Promise.resolve()),
  imageConsent: ImageTransferConsentState = {
    phase: 'idle', provider: null, imageCount: 0, revision: 0,
  },
  professionalTask: ProfessionalTaskStatusState = { sessionId: null, phase: 'none', busy: false, error: null },
  resumeProfessionalTask = vi.fn(() => Promise.resolve()),
) {
  const product: ProductUiState = { page: 'assistant', provider: connectivity.activeProvider ?? 'deepseek', accountDialogRevision: 0 }
  const props = {
    t: (key: ProductKey) => zh[key],
    useProduct: hook(product),
    useWindowsClosePrompt: hook({ requestId: null }),
    useConnectivity: hook(connectivity),
    useImageTransferConsent: hook(imageConsent),
    useProfessionalTaskStatus: hook(professionalTask),
    selectProvider: vi.fn(() => Promise.resolve()),
    configureProvider,
    refreshProviderConnection: vi.fn(() => Promise.resolve()),
    setDeepSeekFileRetention: vi.fn(() => Promise.resolve()),
    clearDeepSeekFiles: vi.fn(() => Promise.resolve(0)),
    approveImageTransfer: vi.fn(),
    rejectImageTransfer: vi.fn(),
    resumeProfessionalTask,
  }
  render(<ProductOverlay {...props as unknown as ProductOverlayProps} />)
  return { props, configureProvider }
}

function missingState(): ConnectivityState {
  return {
    status: 'ready', activeProvider: 'deepseek', selection: 'idle', selectionError: null,
    deepseekFiles: {
      status: 'ready', retentionSeconds: 3_600,
      retentionOptions: [3_600, 604_800, 2_592_000], message: null,
    },
    providers: providerConnections({
      deepseek: { status: 'missing', configured: false, route: 'deepseek-official', message: '尚未配置 API Key' },
      'opencode-go': { status: 'missing', configured: false, route: 'opencode-go', message: '尚未配置 API Key' },
      openrouter: { status: 'missing', configured: false, route: 'openrouter', message: '尚未配置 API Key' },
      fireworks: { status: 'missing', configured: false, route: 'fireworks', message: '尚未配置 API Key' },
      custom: { status: 'missing', configured: false, route: 'custom-api', message: '尚未配置 API Key' },
    }),
  }
}

describe('model connection dialog', () => {
  it('rechecks an unreadable saved credential without requiring or replacing a key', async () => {
    const state = missingState()
    state.providers.deepseek = {
      status: 'error', configured: false, route: 'deepseek-official',
      message: '系统凭据暂不可用，请允许系统访问后重试（诊断码：GC-MODEL-KEYCHAIN）',
    }
    const { props, configureProvider } = renderAssistant(state)
    fireEvent.click(screen.getByRole('button', { name: '配置' }))
    expect(screen.getByRole('dialog', { name: '连接 DeepSeek' }).textContent).toContain('系统凭据暂不可用')
    fireEvent.click(screen.getByRole('button', { name: '重新检查连接' }))
    await waitFor(() => { expect(props.refreshProviderConnection).toHaveBeenCalledWith('deepseek') })
    expect(configureProvider).not.toHaveBeenCalled()
    expect(screen.getByLabelText<HTMLInputElement>('API Key').value).toBe('')
  })

  it('does not offer a saved-connection retry for a genuinely missing credential', () => {
    renderAssistant(missingState())
    fireEvent.click(screen.getByRole('button', { name: '配置' }))
    expect(screen.queryByRole('button', { name: '重新检查连接' })).toBeNull()
  })

  it.each(['custom', 'lmstudio'] as const)('restores saved editable fields for %s without filling its key', async (provider) => {
    const state = missingState()
    state.activeProvider = provider
    state.providers[provider] = {
      status: 'ready', configured: true, message: '连接已验证',
      configuration: {
        displayName: 'Local test model', baseURL: 'http://127.0.0.1:1234/v1',
        protocol: 'openai-responses', modelId: 'saved-model',
      },
    }
    const { configureProvider } = renderAssistant(state)
    fireEvent.click(screen.getByRole('button', { name: '管理' }))
    expect(screen.getByLabelText<HTMLInputElement>('API 基础地址').value).toBe('http://127.0.0.1:1234/v1')
    expect(screen.getByLabelText<HTMLInputElement>(/模型 ID，目录不可用时/u).value).toBe('saved-model')
    const key = screen.getByLabelText<HTMLInputElement>(/API Key/u)
    expect(key.value).toBe('')
    if (provider === 'custom') {
      expect(screen.getByLabelText<HTMLInputElement>('显示名称').value).toBe('Local test model')
      expect(screen.getByLabelText<HTMLSelectElement>('兼容协议').value).toBe('openai-responses')
    }
    fireEvent.change(key, { target: { value: 'replacement-test-key' } })
    fireEvent.click(screen.getByRole('button', { name: '验证并替换' }))
    await waitFor(() => {
      expect(configureProvider).toHaveBeenCalledWith({
        provider, baseURL: 'http://127.0.0.1:1234/v1', modelId: 'saved-model',
        apiKey: 'replacement-test-key',
        ...(provider === 'custom' ? { displayName: 'Local test model', protocol: 'openai-responses' } : {}),
      })
    })
  })

  it('shows one compact resume action for the current paused task', async () => {
    const resume = vi.fn(() => Promise.resolve())
    renderAssistant(
      missingState(),
      vi.fn(() => Promise.resolve()),
      { phase: 'idle', provider: null, imageCount: 0, revision: 0 },
      { sessionId: 'session-1' as never, phase: 'paused', busy: false, error: null },
      resume,
    )
    expect(screen.getByText('任务已暂停')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() => { expect(resume).toHaveBeenCalledTimes(1) })
  })

  it('把供应商回执归类为连接正常、余额不足或模型不可用', () => {
    expect(providerHealthLabel({ status: 'ready', configured: true, message: '连接已验证' })).toBe('连接正常')
    expect(providerHealthLabel({ status: 'error', configured: true, message: 'HTTP 402：账户余额不足' })).toBe('余额不足')
    expect(providerHealthLabel({ status: 'error', configured: true, message: '模型目录中未找到 deepseek-v4-flash' })).toBe('模型不可用')
  })

  it('opens official guidance and submits the key to Host verification without showing fake success', async () => {
    const { configureProvider } = renderAssistant(missingState())
    fireEvent.click(screen.getByRole('button', { name: '配置' }))
    expect(screen.getByRole('dialog', { name: '连接 DeepSeek' })).toBeTruthy()
    expect(screen.getByRole('link', { name: /打开 DeepSeek 官方页面/u }).getAttribute('href'))
      .toBe('https://platform.deepseek.com/api_keys')
    expect(screen.queryByText('连接已经过真实验证')).toBeNull()
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'test-key-never-persisted-in-renderer' } })
    fireEvent.click(screen.getByRole('button', { name: '连接并验证' }))
    await waitFor(() => {
      expect(configureProvider).toHaveBeenCalledWith({
        provider: 'deepseek', apiKey: 'test-key-never-persisted-in-renderer',
      })
    })
    expect(screen.queryByText('连接已经过真实验证')).toBeNull()
  })

  it('renders a failed online probe as an actionable error', async () => {
    const configure = vi.fn(() => Promise.reject(new Error('模型服务连接检查失败，HTTP 401，请检查 API Key')))
    renderAssistant(missingState(), configure)
    fireEvent.click(screen.getByRole('button', { name: '配置' }))
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'wrong-key' } })
    fireEvent.click(screen.getByRole('button', { name: '连接并验证' }))
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 401')
    expect(screen.queryByText('连接已经过真实验证')).toBeNull()
  })

  it('shows partial success and clears the key after the connection was saved', async () => {
    const configure = vi.fn(() => Promise.resolve({
      connectionSaved: true as const,
      autoSelected: false,
      message: '连接已保存，自动切换失败：请手动选择该模型',
    }))
    renderAssistant(missingState(), configure)
    fireEvent.click(screen.getByRole('button', { name: '配置' }))
    const key = screen.getByLabelText('API Key') as HTMLInputElement
    fireEvent.change(key, { target: { value: 'saved-key' } })
    fireEvent.click(screen.getByRole('button', { name: '连接并验证' }))

    expect((await screen.findByRole('status')).textContent)
      .toContain('连接已保存，自动切换失败')
    expect(key.value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('余额不足时在模型连接窗口直接显示余额不足', () => {
    const state = missingState()
    state.providers.deepseek = { status: 'error', configured: true, route: 'deepseek-official', message: 'HTTP 402：账户余额不足' }
    renderAssistant(state)
    fireEvent.click(screen.getByRole('button', { name: '配置' }))
    expect(screen.getByRole('dialog', { name: '连接 DeepSeek' }).querySelector('strong')?.textContent).toBe('余额不足')
  })

  it('changes DeepSeek image retention and clears provider-owned files from the same connection entry', async () => {
    const state = missingState()
    state.providers.deepseek = {
      status: 'ready', configured: true, route: 'deepseek-official', message: '连接已验证',
    }
    const { props } = renderAssistant(state)
    fireEvent.click(screen.getByRole('button', { name: '管理' }))

    fireEvent.click(screen.getByRole('button', { name: '7 天' }))
    await waitFor(() => {
      expect(props.setDeepSeekFileRetention).toHaveBeenCalledWith(604_800)
    })
    expect(await screen.findByText('新的图片保留期已应用到后续上传')).toBeTruthy()

    props.clearDeepSeekFiles.mockResolvedValueOnce(3)
    fireEvent.click(screen.getByRole('button', { name: '删除远端文件并清理本地映射' }))
    await waitFor(() => { expect(props.clearDeepSeekFiles).toHaveBeenCalledTimes(1) })
    expect(await screen.findByText('已删除 3 个远端文件并清理本地映射')).toBeTruthy()
  })

  it('names the receiving provider on every image draft and requires first-send consent', () => {
    const { props } = renderAssistant(missingState(), undefined, {
      phase: 'pending', provider: 'deepseek', imageCount: 2, revision: 1,
    })
    const dialog = screen.getByRole('dialog', { name: '确认图片传输' })
    expect(dialog.textContent).toContain('本次 2 张图片将发送至 DeepSeek')
    expect(dialog.textContent).toContain('当前保留期为 1 小时')
    fireEvent.click(screen.getByRole('button', { name: '同意并发送' }))
    expect(props.approveImageTransfer).toHaveBeenCalledTimes(1)

    const noticeProps = {
      useInput: (selector: (state: { attachmentIds: readonly string[] }) => unknown) => selector({ attachmentIds: ['draft-image'] }),
      useProduct: hook({ page: 'assistant', provider: 'opencode-go', accountDialogRevision: 0 } satisfies ProductUiState),
      resolveDraftAttachments: () => [{
        kind: 'image', id: 'draft-image', file: new File(['image'], 'image.png', { type: 'image/png' }), previewUrl: 'blob:image',
      }],
    } as unknown as ImageTransferProviderNoticeProps
    const notice = render(<ImageTransferProviderNotice {...noticeProps} />)
    expect(notice.container.querySelector('[role="status"]')?.textContent).toContain('本次图片将发送至 OpenCode Go')
  })

  it('does not render a first-use model validation dialog', () => {
    renderAssistant(missingState())
    expect(screen.queryByRole('dialog', { name: '验证首次使用的模型' })).toBeNull()
    expect(screen.queryByText(/1 token/u)).toBeNull()
  })
})
