import { describe, expect, it, vi } from 'vitest'
import type { GongchuangAccountSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { AccountController } from '../src/client/account.ts'

const connected: GongchuangAccountSnapshot = {
  revision: 1, phase: 'connected', portalUrl: 'https://zshjiaotang.cn', username: 'owner',
  message: '已连接', hasSavedPassword: true, autoLoginBlocked: false, singleDevice: true,
  clientCompatibility: 'supported', minimumSupportedVersion: '0.1.4',
}

describe('账号单设备轮询', () => {
  it('后台发现旧设备被替换后立即更新为已退出且不自动抢回登录', async () => {
    const remote = {
      snapshot: vi.fn(async () => ({ ok: true as const, value: connected })),
      refresh: vi.fn()
        .mockResolvedValueOnce({ ok: true as const, value: connected })
        .mockResolvedValueOnce({ ok: true as const, value: {
          ...connected, revision: 2, phase: 'superseded' as const,
          message: '该账号已在另一台设备登录，本机已安全退出', autoLoginBlocked: true,
        } }),
    }
    const controller = new AccountController(remote as never, vi.fn())
    await controller.load()
    await controller.poll()
    expect(controller.store.getSnapshot().snapshot).toMatchObject({ phase: 'superseded', autoLoginBlocked: true })
    expect(remote.refresh).toHaveBeenCalledTimes(2)
    expect(remote.snapshot).not.toHaveBeenCalled()
  })

  it('首次加载等待 Host 完成系统凭据恢复，而不是保留瞬时 checking 快照', async () => {
    const remote = {
      snapshot: vi.fn(async () => ({ ok: true as const, value: { ...connected, phase: 'checking' as const } })),
      refresh: vi.fn(async () => ({ ok: true as const, value: connected })),
    }
    const onConnected = vi.fn()
    const controller = new AccountController(remote as never, onConnected)

    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', snapshot: { phase: 'connected' } })
    expect(remote.refresh).toHaveBeenCalledOnce()
    expect(remote.snapshot).not.toHaveBeenCalled()
    expect(onConnected).toHaveBeenCalledOnce()
  })

  it('账号 Remote 异常不会把服务端原文、路径或凭据带入客户端状态', async () => {
    const remote = {
      refresh: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'REMOTE_ERROR', message: 'failed /Users/alice/account.json token=secret-value' },
      })),
    }
    const controller = new AccountController(remote as never, vi.fn())
    await controller.load()
    const error = controller.store.getSnapshot().error
    expect(error).toBe('账号操作未完成，请稍后重试（诊断码：GC-ACCOUNT-UNKNOWN）')
    expect(error).not.toContain('/Users/')
    expect(error).not.toContain('secret-value')
  })

  it('显式登录的传输异常退出 loading 并只暴露受控错误', async () => {
    const remote = {
      login: vi.fn().mockRejectedValue(new Error('socket failed /Users/alice/account.json token=secret')),
    }
    const controller = new AccountController(remote as never, vi.fn())

    await expect(controller.login({
      username: 'owner', password: 'secret', useSavedPassword: false, rememberPassword: true,
    })).rejects.toThrow('账号操作未完成，请稍后重试（诊断码：GC-ACCOUNT-UNKNOWN）')
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'error', error: '账号操作未完成，请稍后重试（诊断码：GC-ACCOUNT-UNKNOWN）',
    })
  })

  it('手动刷新传输异常退出 loading 而不产生未处理拒绝', async () => {
    const remote = { refresh: vi.fn().mockRejectedValue(new Error('connection reset')) }
    const controller = new AccountController(remote as never, vi.fn())

    await expect(controller.refresh()).resolves.toBeUndefined()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error' })
  })

  it('后台轮询传输异常保留最后一次已连接快照', async () => {
    const remote = {
      refresh: vi.fn()
        .mockResolvedValueOnce({ ok: true as const, value: connected })
        .mockRejectedValueOnce(new Error('connection reset')),
    }
    const controller = new AccountController(remote as never, vi.fn())
    await controller.load()

    await expect(controller.poll()).resolves.toBeUndefined()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', snapshot: { phase: 'connected', revision: 1 }, error: null,
    })
  })

})
