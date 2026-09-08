import { describe, expect, it, vi } from 'vitest'
import type { GongchuangConnectorSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { ConnectorController } from '../src/client/connectors.ts'

const READY: GongchuangConnectorSnapshot = Object.freeze({
  revision: 4,
  region: 'hangzhou',
  regionConfirmed: true,
  connectors: Object.freeze([Object.freeze({
    id: 'gongchuang-search',
    name: '共创联网检索 MCP',
    phase: 'ready',
    enabled: true,
    credentialConfigured: true,
    credentialWritable: false,
    officialConfigUrl: '',
    toolCount: 3,
    tools: Object.freeze([
      { name: 'mcp__gongchuang_search__evidence_search', description: '证据检索' },
      { name: 'web_fetch', description: '原文读取' },
      { name: 'web_search', description: '网页发现' },
    ]),
    verificationMethod: '核验三个工具',
    lastVerifiedAt: '2026-08-15T08:00:00.000Z',
    partial: false,
    message: '真实连接已就绪，共 3 个工具',
    custom: false, transport: null, endpoint: '', arguments: Object.freeze([]), cwd: '',
    authMode: null, credentialName: '', credentialPrefix: '',
  })]),
})

const QCC_READY: GongchuangConnectorSnapshot = Object.freeze({
  revision: 5,
  region: 'hangzhou',
  regionConfirmed: true,
  connectors: Object.freeze([Object.freeze({
    id: 'qcc', name: '企查查 MCP', phase: 'ready', enabled: true,
    credentialConfigured: true, credentialWritable: true,
    officialConfigUrl: 'https://agent.qcc.com/profile/api-key',
    toolCount: 16, tools: Object.freeze([{ name: 'mcp__qcc_company__search', description: '企业检索' }]),
    verificationMethod: '连接官方 MCP 并执行 tools/list。', lastVerifiedAt: '2026-08-16T04:00:00.000Z',
    partial: false, message: '10 个官方 MCP 服务均已连接，共 16 个工具',
    custom: false, transport: null, endpoint: '', arguments: Object.freeze([]), cwd: '',
    authMode: null, credentialName: '', credentialPrefix: '',
  })]),
})

const TYC_READY: GongchuangConnectorSnapshot = Object.freeze({
  revision: 6,
  region: 'hangzhou',
  regionConfirmed: true,
  connectors: Object.freeze([Object.freeze({
    id: 'tianyancha', name: '天眼查数据连接器', phase: 'ready', enabled: true,
    credentialConfigured: true, credentialWritable: true,
    officialConfigUrl: 'https://www.tianyancha.com/ai',
    toolCount: 2, tools: Object.freeze([{ name: 'mcp__tianyancha__search', description: '企业检索' }]),
    verificationMethod: '连接官方 MCP 并执行 tools/list。', lastVerifiedAt: '2026-08-26T01:00:00.000Z',
    partial: false, message: '天眼查官方 MCP 已连接',
    custom: false, transport: null, endpoint: '', arguments: Object.freeze([]), cwd: '',
    authMode: null, credentialName: '', credentialPrefix: '',
  })]),
})

function successfulRemote() {
  return {
    list: vi.fn(async () => ({ ok: true as const, value: READY })),
    refresh: vi.fn(async () => ({ ok: true as const, value: READY })),
    setEnabled: vi.fn(async () => ({ ok: true as const, value: READY })),
    configure: vi.fn(async () => ({ ok: true as const, value: READY })),
    setRegion: vi.fn(async () => ({ ok: true as const, value: READY })),
    beginAuthorization: vi.fn(async (request: { id: 'qcc' | 'tianyancha'; transactionId?: string }) => ({
      ok: true as const,
      value: request.id === 'qcc'
        ? {
          id: 'qcc' as const, transactionId: request.transactionId ?? 'tx-1',
          authorizationUrl: 'https://agent.qcc.com/oauth/authorize?state=redacted',
        }
        : {
          id: 'tianyancha' as const, transactionId: request.transactionId ?? 'tyc-tx-default',
          authorizationUrl: 'https://capi.tianyancha.com/oauth/device', userCode: '123456',
        },
    })),
    completeAuthorization: vi.fn(async () => ({ ok: true as const, value: QCC_READY })),
    cancelAuthorization: vi.fn(async () => ({ ok: true as const, value: READY })),
    upsertCustom: vi.fn(async () => ({ ok: true as const, value: READY })),
    removeCustom: vi.fn(async () => ({ ok: true as const, value: READY })),
  }
}

describe('ConnectorController', () => {
  it('allows explicit device-flow completion retry without minting another transaction', async () => {
    const remote = successfulRemote()
    const controller = new ConnectorController(remote)
    const started = await controller.beginTianyanchaAuthorization(vi.fn())
    remote.completeAuthorization.mockRejectedValueOnce(new Error('请在官方页面确认后重试'))
    await expect(controller.completeTianyanchaAuthorization(started.transactionId)).rejects.toThrow('请在官方页面确认后重试')
    remote.completeAuthorization.mockResolvedValueOnce({ ok: true, value: TYC_READY })
    await controller.completeTianyanchaAuthorization(started.transactionId)
    expect(remote.completeAuthorization).toHaveBeenLastCalledWith({ id: 'tianyancha', transactionId: started.transactionId })
    expect(remote.beginAuthorization).toHaveBeenCalledOnce()
  })

  it('retries a lost cancellation acknowledgement before starting another authorization', async () => {
    const remote = successfulRemote()
    const controller = new ConnectorController(remote)
    await controller.beginTianyanchaAuthorization(vi.fn())
    remote.cancelAuthorization.mockRejectedValueOnce(new Error('connection interrupted'))
    await expect(controller.cancelAuthorization('tianyancha')).rejects.toThrow('connection interrupted')
    const oldTransaction = remote.beginAuthorization.mock.calls[0]![0].transactionId
    await controller.beginTianyanchaAuthorization(vi.fn())
    expect(remote.cancelAuthorization).toHaveBeenCalledTimes(2)
    expect(remote.cancelAuthorization).toHaveBeenLastCalledWith({ id: 'tianyancha', transactionId: oldTransaction })
    expect(remote.beginAuthorization.mock.calls[1]![0].transactionId).not.toBe(oldTransaction)
    await controller.cancelAuthorization('tianyancha')
  })

  it('publishes only the Host-returned connector snapshot', async () => {
    const remote = successfulRemote()
    const controller = new ConnectorController(remote)
    await controller.load()
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', snapshot: READY, error: null })
    expect(remote.list).toHaveBeenCalledOnce()
  })

  it('routes configuration and enablement through the trusted Remote service', async () => {
    const remote = successfulRemote()
    const controller = new ConnectorController(remote)
    await controller.configure({ id: 'gongchuang-search', value: 'secret' })
    await controller.setEnabled({ id: 'gongchuang-search', enabled: false })
    await controller.setRegion('hangzhou')
    expect(remote.configure).toHaveBeenCalledWith({ id: 'gongchuang-search', value: 'secret' })
    expect(remote.setEnabled).toHaveBeenCalledWith({ id: 'gongchuang-search', enabled: false })
    expect(remote.setRegion).toHaveBeenCalledWith({
      region: 'hangzhou', confirmed: true, expectedRegion: 'hangzhou', expectedConfirmed: true,
    })
  })

  it('does not convert a Remote failure into a ready UI status', async () => {
    const remote = successfulRemote()
    remote.list.mockResolvedValueOnce({
      ok: false as const,
      error: { code: 'REMOTE_ERROR', message: 'connector service unavailable', details: {} },
    } as never)
    const controller = new ConnectorController(remote)
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'error',
      error: '操作未完成，请稍后重试（诊断码：GC-UI-UNKNOWN）',
    })
  })

  it('opens the official authorization URL before completing QCC login', async () => {
    const remote = successfulRemote()
    const controller = new ConnectorController(remote)
    const openAuthorizationUrl = vi.fn()
    await controller.authorizeQcc(openAuthorizationUrl)
    expect(openAuthorizationUrl).toHaveBeenCalledWith('https://agent.qcc.com/oauth/authorize?state=redacted')
    expect(remote.completeAuthorization).toHaveBeenCalledWith({ id: 'qcc', transactionId: remote.beginAuthorization.mock.calls[0]![0].transactionId })
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', snapshot: QCC_READY, error: null })
  })

  it('keeps Tianyancha Device Flow pending until the user confirms authorization', async () => {
    const remote = successfulRemote()
    remote.completeAuthorization.mockResolvedValueOnce({ ok: true as const, value: TYC_READY })
    const controller = new ConnectorController(remote)
    await controller.load()
    const openAuthorizationUrl = vi.fn()

    const started = await controller.beginTianyanchaAuthorization(openAuthorizationUrl)
    expect(started).toMatchObject({ id: 'tianyancha', transactionId: remote.beginAuthorization.mock.calls[0]![0].transactionId, userCode: '123456' })
    expect(openAuthorizationUrl).toHaveBeenCalledWith('https://capi.tianyancha.com/oauth/device')
    expect(remote.completeAuthorization).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', snapshot: READY, error: null })

    await controller.completeTianyanchaAuthorization(started.transactionId)
    expect(remote.completeAuthorization).toHaveBeenCalledWith({ id: 'tianyancha', transactionId: started.transactionId })
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', snapshot: TYC_READY, error: null })
  })

  it.each(['qcc', 'tianyancha'] as const)('does not hold other connector writes while %s awaits approval', async (id) => {
    const remote = successfulRemote()
    let finish!: (value: Awaited<ReturnType<typeof remote.completeAuthorization>>) => void
    remote.completeAuthorization.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const controller = new ConnectorController(remote)
    await controller.load()
    const authorization = id === 'qcc'
      ? controller.authorizeQcc(vi.fn()) : controller.completeTianyanchaAuthorization('tyc-tx-1')
    await vi.waitFor(() => { expect(remote.completeAuthorization).toHaveBeenCalledOnce() })
    const changed = { ...READY, revision: 8, region: 'ningbo' as const }
    remote.setRegion.mockResolvedValueOnce({ ok: true, value: changed })
    try {
      await controller.setRegion('ningbo')
      expect(remote.setRegion).toHaveBeenCalledOnce()
      const duplicate = id === 'qcc'
        ? controller.authorizeQcc(vi.fn()) : controller.completeTianyanchaAuthorization('tyc-tx-1')
      await expect(duplicate).rejects.toThrow('请勿重复发起')
    } finally {
      finish({ ok: true, value: id === 'qcc' ? QCC_READY : TYC_READY })
      await authorization
    }
    expect(controller.store.getSnapshot().snapshot).toBe(changed)
  })

  it.each(['qcc', 'tianyancha'] as const)('cancels %s before manual configuration and discards its late success', async (id) => {
    const remote = successfulRemote()
    let finish!: (value: Awaited<ReturnType<typeof remote.completeAuthorization>>) => void
    remote.completeAuthorization.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const controller = new ConnectorController(remote)
    const authorization = id === 'qcc'
      ? controller.authorizeQcc(vi.fn()) : controller.completeTianyanchaAuthorization('tyc-cancel')
    const rejected = expect(authorization).rejects.toThrow('取消')
    await vi.waitFor(() => { expect(remote.completeAuthorization).toHaveBeenCalledOnce() })
    const ready = id === 'qcc' ? QCC_READY : TYC_READY
    remote.configure.mockResolvedValueOnce({ ok: true, value: ready })
    await controller.configure({ id, value: 'manual-key' })
    expect(remote.cancelAuthorization).toHaveBeenCalledOnce()
    expect(remote.configure).toHaveBeenCalledWith({ id, value: 'manual-key' })
    finish({ ok: true, value: { ...ready, revision: 999, region: 'jinhua' } })
    await rejected
    expect(controller.store.getSnapshot().snapshot).toBe(ready)
  })

  it('cancels before registration returns without opening the late browser URL', async () => {
    const remote = successfulRemote()
    let finish!: (value: Awaited<ReturnType<typeof remote.beginAuthorization>>) => void
    remote.beginAuthorization.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const controller = new ConnectorController(remote)
    const open = vi.fn()
    const first = controller.authorizeQcc(open)
    const rejected = expect(first).rejects.toThrow('取消')
    await vi.waitFor(() => { expect(remote.beginAuthorization).toHaveBeenCalledOnce() })
    const request = remote.beginAuthorization.mock.calls[0]![0]
    await controller.cancelAuthorization('qcc')
    expect(remote.cancelAuthorization).toHaveBeenCalledWith({ id: 'qcc', transactionId: request.transactionId })
    await controller.authorizeQcc(open)
    finish({ ok: true, value: { id: 'qcc', transactionId: request.transactionId!, authorizationUrl: 'https://agent.qcc.com/stale' } })
    await rejected
    expect(open).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalledWith('https://agent.qcc.com/stale')
  })
})
