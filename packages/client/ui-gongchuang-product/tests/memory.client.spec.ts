import { describe, expect, it, vi } from 'vitest'
import type { GongchuangGraphMemorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { GraphMemoryController } from '../src/client/memory.ts'

const enabled: GongchuangGraphMemorySnapshot = {
  enabled: true,
  includeToolResults: true,
  personalNodes: 2,
  enterpriseStores: 1,
  totalNodes: 5,
  totalEdges: 3,
  updatedAt: null,
}

describe('GraphMemoryController', () => {
  it('将宿主的设置、统计和清除回执原样交给界面', async () => {
    const disabled = { ...enabled, enabled: false, includeToolResults: false }
    const cleared = { ...disabled, personalNodes: 0, totalNodes: 0, totalEdges: 0 }
    const remote = {
      snapshot: vi.fn(async () => ({ ok: true as const, value: enabled })),
      configure: vi.fn(async () => ({ ok: true as const, value: disabled })),
      clearAll: vi.fn(async () => ({ ok: true as const, value: cleared })),
    }
    const controller = new GraphMemoryController(remote)
    await expect(controller.snapshot()).resolves.toEqual(enabled)
    await expect(controller.configure({ enabled: false, includeToolResults: false })).resolves.toEqual(disabled)
    await expect(controller.clearAll()).resolves.toEqual(cleared)
    expect(remote.configure).toHaveBeenCalledWith({ enabled: false, includeToolResults: false })
  })

  it('向用户显示宿主返回的可操作错误', async () => {
    const controller = new GraphMemoryController({
      snapshot: vi.fn(async () => ({ ok: false as const, error: { message: '本地记忆尚未启动' } })),
    } as never)
    await expect(controller.snapshot()).rejects.toThrow('本地记忆尚未启动')
  })
})
