// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  InstalledSkillView, MarketplaceSkillView, SkillMarketplaceSnapshot, SkillMarketplaceSource,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectivityState } from '../src/client/connectivity.ts'
import { providerConnections } from './provider-connections.client.ts'
import type { MarketplaceState } from '../src/client/marketplace.ts'
import { ProductOverlay, type ProductOverlayProps, type ProductUiState } from '../src/client/ProductShell.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => { callback(0); return 1 },
  })
  Element.prototype.scrollIntoView = vi.fn()
})

function hook<TState>(state: TState) {
  return <TSelected,>(selector: (value: TState) => TSelected): TSelected => selector(state)
}

const featured: MarketplaceSkillView = Object.freeze({
  source: 'modelscope', coordinate: 'hu1230/cn-policy-search', namespace: 'hu1230',
  slug: 'cn-policy-search', name: '政策原文检索', description: '检索并核验政策原文。',
  category: '政策检索', version: '1.2.0', license: 'MIT', downloads: 3210,
  iconUrl: '', detailUrl: 'https://modelscope.cn/skills/hu1230/cn-policy-search',
  publisherVerified: true, platformSigned: false, requiresConfiguration: false,
  featured: true, installed: true,
})

const installed: InstalledSkillView = Object.freeze({
  id: 'modelscope-cn-policy-search-abc', name: featured.name, description: featured.description,
  category: featured.category, enabled: true,
  source: 'modelscope', coordinate: featured.coordinate, version: featured.version,
  digest: 'a'.repeat(64), installedAt: '2026-08-15T00:00:00.000Z', bundled: false,
  integrity: 'pinned-digest', detailUrl: featured.detailUrl, license: featured.license,
})

function renderSkills(
  featuredSkill: MarketplaceSkillView = featured,
  installedSkills: readonly InstalledSkillView[] = [installed],
) {
  const snapshot: SkillMarketplaceSnapshot = Object.freeze({
    revision: 3, installed: Object.freeze([...installedSkills]), featured: Object.freeze([featuredSkill]),
    sources: Object.freeze<SkillMarketplaceSource[]>(['modelscope', 'skillhub', 'custom']),
    repositories: Object.freeze([]),
  })
  const marketplace: MarketplaceState = {
    status: 'ready', snapshot, error: null, notice: null, installing: [], removing: [], toggling: [],
    search: {
      status: 'ready', source: 'modelscope', query: '', category: '', error: null,
      page: Object.freeze({
        source: 'modelscope', query: '', page: 1, pageSize: 18, total: 37,
        skills: Object.freeze([featuredSkill]),
      }),
    },
  }
  const product: ProductUiState = { page: 'skills', provider: 'deepseek', accountDialogRevision: 0 }
  const connectivity: ConnectivityState = {
    status: 'ready', activeProvider: 'deepseek', selection: 'ready', selectionError: null,
    deepseekFiles: { status: 'ready', retentionSeconds: 3_600, retentionOptions: [3_600, 604_800, 2_592_000], message: null },
    providers: providerConnections({
      deepseek: { status: 'ready', configured: true, message: '已连接' },
      'opencode-go': { status: 'missing', configured: false, message: '未配置' },
      openrouter: { status: 'missing', configured: false, message: '未配置' },
      fireworks: { status: 'missing', configured: false, message: '未配置' },
      custom: { status: 'missing', configured: false, message: '未配置' },
    }),
  }
  const actions = {
    useProduct: hook(product), useWindowsClosePrompt: hook({ requestId: null }),
    useConnectivity: hook(connectivity), useMarketplace: hook(marketplace),
    refreshSkills: vi.fn(() => Promise.resolve()), searchSkills: vi.fn(() => Promise.resolve()),
    installSkill: vi.fn(() => Promise.resolve()), setSkillEnabled: vi.fn(() => Promise.resolve()),
    removeSkill: vi.fn(() => Promise.resolve()),
    addSkillRepository: vi.fn(() => Promise.resolve()),
    removeSkillRepository: vi.fn(() => Promise.resolve()),
  }
  render(<ProductOverlay {...actions as unknown as ProductOverlayProps} />)
  return actions
}

describe('技能中心真实操作导航', () => {
  it('把四个市场入口放在同一级并切换到对应目录', () => {
    const actions = renderSkills()
    for (const removedDescription of [
      '精选、魔搭与 SkillHub',
      '已进入模型能力范围',
      '按业务价值每日轮换推荐',
      '在客户端内检索、翻页和安装',
      '目录、下载与平台签名校验已接入',
      '添加 HTTPS 兼容清单并安装',
    ]) {
      expect(screen.queryByText(removedDescription)).toBeNull()
    }
    const names = ['精选', '魔搭 ModelScope', '腾讯 SkillHub', '第三方仓库']
    const buttons = names.map(name => screen.getByText(name, { selector: 'strong' }).closest('button')!)
    buttons.forEach((button, index) => { expect(button.textContent).toContain(names[index]) })

    fireEvent.click(buttons[1]!)
    expect(actions.searchSkills).toHaveBeenCalledWith('modelscope', '', 1, '')
    expect(screen.getByRole('textbox', { name: '在魔搭中搜索技能' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: '技能市场翻页' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '下一页' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '开发工具' }))
    expect(actions.searchSkills).toHaveBeenLastCalledWith('modelscope', '', 1, 'developer-tools')

    fireEvent.click(buttons[2]!)
    expect(actions.searchSkills).toHaveBeenCalledWith('skillhub', '', 1, '')
    expect(screen.getByRole('textbox', { name: '在腾讯 SkillHub中搜索技能' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '办公效率' }))
    expect(actions.searchSkills).toHaveBeenLastCalledWith('skillhub', '', 1, 'office-efficiency')
    fireEvent.click(buttons[3]!)
    expect(screen.getByRole('button', { name: '添加第三方仓库' })).toBeTruthy()
  })

  it('技能安装后仍保留在精选卡片中并可查看详情', () => {
    const actions = renderSkills()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '已安装' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('heading', { name: featured.name }).closest('button')!)
    expect(screen.getByRole('dialog', { name: featured.name })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '已安装' }).every(button => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(screen.getAllByText(featured.coordinate).length).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.click(screen.getByRole('button', { name: /已安装技能/u }))
    expect(screen.getByRole('heading', { name: '已安装' })).toBeTruthy()
    expect(screen.getByText(featured.name)).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: `停用技能 ${featured.name}` }))
    expect(actions.setSkillEnabled).toHaveBeenCalledWith(installed, false)
    fireEvent.click(screen.getByRole('button', { name: `删除技能 ${featured.name}` }))
    const confirm = screen.getByRole('dialog', { name: `删除技能 ${featured.name}` })
    expect(confirm.textContent).toContain('回到技能市场的未安装状态')
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(actions.removeSkill).toHaveBeenCalledWith(installed)
  })

  it('内置技能保持稳定且不显示物理删除入口', () => {
    const bundled: InstalledSkillView = Object.freeze({
      ...installed, id: 'bundled-deep-clarification', name: '深度澄清',
      description: '分轮确认复杂任务的目标、范围、依赖、风险与验收边界',
      source: 'bundled', coordinate: 'deep-clarification', version: '1.6.12',
      bundled: true, integrity: 'signed-bundle', license: 'MIT',
    })
    renderSkills(featured, [bundled])
    fireEvent.click(screen.getByRole('button', { name: /已安装技能/u }))
    expect(screen.queryByRole('button', { name: /删除技能 深度澄清/u })).toBeNull()
    expect(screen.queryByRole('switch', { name: '停用技能 深度澄清' })).toBeNull()
    expect(screen.getByLabelText('内置技能固定启用').textContent).toBe('内置')
    fireEvent.click(screen.getByText('深度澄清').closest('button')!)
    const detail = screen.getByRole('dialog', { name: '深度澄清' })
    expect(detail.textContent).toContain('已启用')
    expect(detail.textContent).toContain(`内置 V${bundled.version}`)
    expect(detail.textContent).toContain('MIT')
    expect(detail.textContent).not.toContain('deep-clarification')
    expect(screen.queryByRole('button', { name: '停用技能' })).toBeNull()
  })

  it('存在明确的厂商配置地址时安装后打开官方配置', async () => {
    const patseek: MarketplaceSkillView = Object.freeze({
      ...featured,
      source: 'skillhub', coordinate: '@user_0b65fce7/patseek-patent-search',
      namespace: 'user_0b65fce7', slug: 'patseek-patent-search', name: 'PatSeek 专利检索',
      detailUrl: 'https://skillhub.cn/skills/user_0b65fce7/patseek-patent-search',
      configurationUrl: 'https://patseek.cn/', requiresConfiguration: true, installed: false,
    })
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const actions = renderSkills(patseek, [])

    expect(screen.getByText(/安装后进入官方配置/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '安装并配置' }))
    await waitFor(() => { expect(actions.installSkill).toHaveBeenCalledWith(patseek) })
    await waitFor(() => { expect(open).toHaveBeenCalledWith('https://patseek.cn/', '_blank', 'noopener,noreferrer') })
  })

  it('已安装的市场技能仍可从详情重新打开官方配置', () => {
    const patseek: MarketplaceSkillView = Object.freeze({
      ...featured,
      source: 'skillhub', coordinate: '@user_0b65fce7/patseek-patent-search',
      namespace: 'user_0b65fce7', slug: 'patseek-patent-search', name: 'PatSeek 专利检索',
      detailUrl: 'https://skillhub.cn/skills/user_0b65fce7/patseek-patent-search',
      configurationUrl: 'https://patseek.cn/', requiresConfiguration: true, installed: true,
    })
    const installedPatseek: InstalledSkillView = Object.freeze({
      ...installed,
      id: 'skillhub-patseek-abc', source: 'skillhub', coordinate: patseek.coordinate,
      name: patseek.name, description: patseek.description, detailUrl: patseek.detailUrl,
      configurationUrl: 'https://patseek.cn/', requiresConfiguration: true,
    })
    renderSkills(patseek, [installedPatseek])

    fireEvent.click(screen.getByRole('heading', { name: patseek.name }).closest('button')!)
    const link = screen.getByRole<HTMLAnchorElement>('link', { name: '打开官方配置' })
    expect(link.href).toBe('https://patseek.cn/')
  })

  it('平台只标记需要配置但没有可信地址时安装不打开社区原页', async () => {
    const tencentDocs: MarketplaceSkillView = Object.freeze({
      ...featured,
      source: 'skillhub', coordinate: '@tencent-adm/tencent-docs', namespace: 'tencent-adm',
      slug: 'tencent-docs', name: '腾讯文档',
      detailUrl: 'https://skillhub.cn/skills/tencent-adm/tencent-docs',
      requiresConfiguration: true, installed: false,
    })
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const actions = renderSkills(tencentDocs, [])

    expect(screen.getByText(/安装后需自行配置/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '一键安装' }))
    await waitFor(() => { expect(actions.installSkill).toHaveBeenCalledWith(tencentDocs) })
    expect(open).not.toHaveBeenCalled()
  })
})
