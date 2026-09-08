import type {
  ClientRemote,
  MarketplaceSkillView,
  SkillMarketplaceSnapshot,
  SkillMarketplaceSource,
  SkillSearchPage,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { gongchuangUserError } from '@gongchuang/user-errors'

function marketplaceError(error: unknown): string {
  return gongchuangUserError(error, 'product').text
}

/** Browser state for installed, featured, and searched skills. */
export interface MarketplaceState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot: SkillMarketplaceSnapshot
  search: {
    status: 'idle' | 'loading' | 'ready' | 'error'
    source: SkillMarketplaceSource
    query: string
    category: string
    page: SkillSearchPage | null
    error: string | null
  }
  installing: string[]
  removing: string[]
  toggling: string[]
  notice: string | null
  error: string | null
}

const EMPTY_SNAPSHOT: SkillMarketplaceSnapshot = Object.freeze({
  revision: 0,
  installed: Object.freeze([]),
  featured: Object.freeze([]),
  sources: Object.freeze(['modelscope', 'skillhub'] as const),
  repositories: Object.freeze([]),
})

function initialState(): MarketplaceState {
  return {
    status: 'idle', snapshot: EMPTY_SNAPSHOT,
    search: { status: 'idle', source: 'modelscope', query: '', category: '', page: null, error: null },
    installing: [], removing: [], toggling: [], notice: null, error: null,
  }
}

type MarketplaceRemote = ClientRemote['gongchuangSkillMarketplace']

/**
 * Stable browser key for one upstream skill coordinate.
 * @param skill - source identity fields for the marketplace skill.
 * @returns a collision-resistant key within the current marketplace snapshot.
 */
export function marketplaceInstallKey(
  skill: Pick<MarketplaceSkillView, 'source' | 'coordinate' | 'repositoryId'>,
): string {
  return `${skill.source}:${skill.repositoryId ?? ''}:${skill.coordinate}`
}

/**
 * Compact page-number model with null entries representing visual ellipses.
 * @param current - current one-based page.
 * @param totalPages - total available page count.
 * @returns ordered page labels with null gaps.
 */
export function marketplacePageItems(current: number, totalPages: number): readonly (number | null)[] {
  if (totalPages <= 1) return totalPages === 1 ? [1] : []
  const candidates = [...new Set([1, current - 1, current, current + 1, totalPages]
    .filter(page => page >= 1 && page <= totalPages))].sort((left, right) => left - right)
  const items: Array<number | null> = []
  for (const page of candidates) {
    const previous = items.at(-1)
    if (typeof previous === 'number' && page - previous > 1) items.push(null)
    items.push(page)
  }
  return items
}

/** Browser projection of the Host-only downloader, verifier, and skill registry. */
export class MarketplaceController {
  /** Observable marketplace state consumed by the Skills center. */
  readonly store: SnapshotStore<MarketplaceState> = createSnapshotStore(initialState())
  private loadGeneration = 0
  private searchGeneration = 0
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(private readonly remote: MarketplaceRemote) {}

  /**
   * Reload installed skills, featured rotation, and repository roster.
   * @returns once the Host snapshot is published.
   */
  async load(): Promise<void> {
    const generation = ++this.loadGeneration
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    try {
      const result = await this.remote.snapshot()
      if (!result.ok) throw new Error(result.error.message)
      if (generation !== this.loadGeneration) return
      this.store.update((state) => {
        state.status = 'ready'
        state.snapshot = result.value
        state.error = null
      })
    } catch (error) {
      if (generation !== this.loadGeneration) return
      this.store.update((state) => {
        state.status = 'error'
        state.error = marketplaceError(error)
      })
    }
  }

  /**
   * Search one upstream market or added repository with real pagination.
   * @param source - selected marketplace source.
   * @param query - user search text.
   * @param page - requested one-based page.
   * @returns once the matching page or failure is published.
   * @param category - The category value.
   */
  async search(source: SkillMarketplaceSource, query: string, page = 1, category = ''): Promise<void> {
    const generation = ++this.searchGeneration
    const normalized = query.trim()
    const requestedPage = Math.max(1, Math.trunc(page))
    this.store.update((state) => {
      state.search.status = 'loading'
      state.search.source = source
      state.search.query = normalized
      state.search.category = category
      state.search.error = null
    })
    try {
      const result = await this.remote.search({ source, query: normalized, page: requestedPage, pageSize: 18, ...(category === '' ? {} : { category }) })
      if (!result.ok) throw new Error(result.error.message)
      if (generation !== this.searchGeneration) return
      this.store.update((state) => {
        state.search.status = 'ready'
        state.search.page = result.value
        state.search.error = null
      })
    } catch (error) {
      if (generation !== this.searchGeneration) return
      this.store.update((state) => {
        state.search.status = 'error'
        state.search.page = null
        state.search.error = marketplaceError(error)
      })
      throw error
    }
  }

  /**
   * Install one selected skill through Host verification gates.
   * @param skill - exact upstream skill view selected by the user.
   * @returns once download, verification, installation, and refresh complete.
   */
  install(skill: MarketplaceSkillView): Promise<void> {
    const key = marketplaceInstallKey(skill)
    const task = this.mutationTail.then(async () => {
      this.store.update((state) => {
        if (!state.installing.includes(key)) state.installing.push(key)
        state.notice = null
        state.error = null
      })
      try {
        const result = await this.remote.installSkill({
          source: skill.source,
          coordinate: skill.coordinate,
          namespace: skill.namespace,
          slug: skill.slug,
          version: skill.version,
          category: skill.category,
          ...(skill.repositoryId === undefined ? {} : { repositoryId: skill.repositoryId }),
        })
        if (!result.ok) throw new Error(result.error.message)
        this.store.update((state) => {
          state.notice = `${result.value.installed.name} 已安装`
        })
        await this.load()
        const current = this.store.getSnapshot().search
        if (current.status === 'ready' && current.page !== null) await this.search(current.source, current.query, current.page.page, current.category)
      } finally {
        this.store.update((state) => {
          const index = state.installing.indexOf(key)
          if (index !== -1) state.installing.splice(index, 1)
        })
      }
    })
    this.mutationTail = task.catch((error: unknown) => {
      this.store.update((state) => {
        state.error = marketplaceError(error)
      })
    })
    return task
  }

  /** Remove one community skill from the active registry and refresh every affected view.
   * @param skill - The skill value.
   */
  remove(skill: { id: string; name: string }): Promise<void> {
    const task = this.mutationTail.then(async () => {
      this.store.update((state) => {
        if (!state.removing.includes(skill.id)) state.removing.push(skill.id)
        state.notice = null
        state.error = null
      })
      try {
        const result = await this.remote.removeSkill({ id: skill.id })
        if (!result.ok) throw new Error(result.error.message)
        this.store.update((state) => { state.notice = `${result.value.name} 已删除，可从技能市场重新安装` })
        await this.load()
        const current = this.store.getSnapshot().search
        if (current.status === 'ready' && current.page !== null) {
          await this.search(current.source, current.query, current.page.page, current.category)
        }
      } finally {
        this.store.update((state) => {
          const index = state.removing.indexOf(skill.id)
          if (index !== -1) state.removing.splice(index, 1)
        })
      }
    })
    this.mutationTail = task.catch((error: unknown) => {
      this.store.update((state) => { state.error = marketplaceError(error) })
    })
    return task
  }

  /** Enable or disable a skill in the live model catalog while retaining its installation.
   * @param skill - The skill value.
   * @param enabled - The enabled value.
   */
  setEnabled(skill: { id: string; name: string }, enabled: boolean): Promise<void> {
    const task = this.mutationTail.then(async () => {
      this.store.update((state) => {
        if (!state.toggling.includes(skill.id)) state.toggling.push(skill.id)
        state.notice = null
        state.error = null
      })
      try {
        const result = await this.remote.setSkillEnabled({ id: skill.id, enabled })
        if (!result.ok) throw new Error(result.error.message)
        this.store.update((state) => { state.notice = `${result.value.name} 已${result.value.enabled ? '启用' : '停用'}` })
        await this.load()
      } finally {
        this.store.update((state) => {
          const index = state.toggling.indexOf(skill.id)
          if (index !== -1) state.toggling.splice(index, 1)
        })
      }
    })
    this.mutationTail = task.catch((error: unknown) => {
      this.store.update((state) => { state.error = marketplaceError(error) })
    })
    return task
  }

  /**
   * Add or update one public HTTPS data-only skill repository.
   * @param manifestUrl - absolute public repository manifest URL.
   * @returns once the Host validates, stores, and reloads the repository.
   */
  addRepository(manifestUrl: string): Promise<void> {
    const task = this.mutationTail.then(async () => {
      this.store.update((state) => {
        state.notice = null
        state.error = null
      })
      const result = await this.remote.addRepository({ manifestUrl })
      if (!result.ok) throw new Error(result.error.message)
      this.store.update((state) => {
        state.notice = `${result.value.repository.name} 已${result.value.updated ? '更新' : '添加'}`
      })
      await this.load()
    })
    this.mutationTail = task.catch((error: unknown) => {
      this.store.update((state) => {
        state.error = marketplaceError(error)
      })
    })
    return task
  }

  /**
   * Remove a registered repository while preserving installed skills.
   * @param id - Repository identity from the current snapshot.
   * @returns once the Host registry is updated and the snapshot reloaded.
   */
  removeRepository(id: string): Promise<void> {
    const task = this.mutationTail.then(async () => {
      this.store.update((state) => { state.notice = null; state.error = null })
      const result = await this.remote.removeRepository({ id })
      if (!result.ok) throw new Error(result.error.message)
      this.store.update((state) => { state.notice = '第三方仓库已移除，已安装技能未受影响' })
      await this.load()
    })
    this.mutationTail = task.catch((error: unknown) => {
      this.store.update((state) => { state.error = marketplaceError(error) })
    })
    return task
  }
}
