import { describe, expect, it, vi } from 'vitest'
import type { SkillMarketplaceSnapshot, SkillSearchPage } from '@deepseek-ai/dsh-api-remotes/client'
import { MarketplaceController, marketplacePageItems } from '../src/client/marketplace.ts'

const SNAPSHOT: SkillMarketplaceSnapshot = Object.freeze({
  revision: 1,
  installed: Object.freeze([]),
  featured: Object.freeze([]),
  sources: Object.freeze(['modelscope', 'skillhub'] as const),
  repositories: Object.freeze([]),
})

const PAGE_THREE: SkillSearchPage = Object.freeze({
  source: 'modelscope', query: '政策', page: 3, pageSize: 18, total: 181,
  skills: Object.freeze([]),
})

function successfulRemote() {
  return {
    snapshot: vi.fn(async () => ({ ok: true as const, value: SNAPSHOT })),
    search: vi.fn(async () => ({ ok: true as const, value: PAGE_THREE })),
    installSkill: vi.fn(),
    setSkillEnabled: vi.fn(),
    removeSkill: vi.fn(),
    addRepository: vi.fn(),
    removeRepository: vi.fn(),
  }
}

describe('MarketplaceController pagination', () => {
  it('forwards the requested page to the Host marketplace', async () => {
    const remote = successfulRemote()
    const controller = new MarketplaceController(remote)
    await controller.search('modelscope', ' 政策 ', 3)

    expect(remote.search).toHaveBeenCalledWith({
      source: 'modelscope', query: '政策', page: 3, pageSize: 18,
    })
    expect(controller.store.getSnapshot().search.page).toBe(PAGE_THREE)
  })

  it('forwards a source-native category together with search and pagination', async () => {
    const remote = successfulRemote()
    const controller = new MarketplaceController(remote)
    await controller.search('skillhub', ' 文档 ', 2, 'office-efficiency')

    expect(remote.search).toHaveBeenCalledWith({
      source: 'skillhub', query: '文档', page: 2, pageSize: 18, category: 'office-efficiency',
    })
    expect(controller.store.getSnapshot().search.category).toBe('office-efficiency')
  })

  it('builds bounded page controls for a large market', () => {
    expect(marketplacePageItems(1, 11)).toEqual([1, 2, null, 11])
    expect(marketplacePageItems(6, 11)).toEqual([1, null, 5, 6, 7, null, 11])
    expect(marketplacePageItems(11, 11)).toEqual([1, null, 10, 11])
  })
})
