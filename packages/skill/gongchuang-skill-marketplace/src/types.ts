/** Client-safe marketplace vocabulary. */

export type SkillMarketplaceSource = 'modelscope' | 'skillhub' | 'custom'

/** Client-safe metadata for one installed HTTPS repository manifest. */
export interface MarketplaceRepositoryView {
  readonly id: string
  readonly name: string
  readonly manifestUrl: string
  readonly homepage: string
  readonly skillCount: number
  readonly addedAt: string
}

/** Basic installation state for one locally available skill. */
export interface InstalledSkillView {
  readonly id: string
  readonly name: string
  readonly description: string
  /** User-facing category used by the installed-skill filter. */
  readonly category: string
  /** Whether this skill is currently exposed to model and user invocation. */
  readonly enabled: boolean
  readonly source: 'bundled' | SkillMarketplaceSource
  readonly repositoryId?: string
  readonly coordinate: string
  readonly version: string
  readonly digest: string
  readonly installedAt: string
  readonly bundled: boolean
  readonly integrity: 'signed-bundle' | 'community-install' | 'platform-signature' | 'pinned-digest'
  /** Official/community detail page retained for provenance and later setup. */
  readonly detailUrl?: string
  readonly license?: string
  /** True only when the marketplace exposes an explicit auth/configuration marker. */
  readonly requiresConfiguration?: boolean
  /** Host-validated HTTPS destination for the post-install setup step. */
  readonly configurationUrl?: string
}

/** Search or featured-card metadata for one installable marketplace skill. */
export interface MarketplaceSkillView {
  readonly source: SkillMarketplaceSource
  readonly repositoryId?: string
  readonly coordinate: string
  readonly namespace: string
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly category: string
  readonly version: string
  readonly license: string
  readonly downloads: number
  readonly iconUrl: string
  readonly detailUrl: string
  readonly publisherVerified: boolean
  readonly platformSigned: boolean
  /** True only when the source exposes an explicit auth/configuration marker. */
  readonly requiresConfiguration: boolean
  /** Host-validated HTTPS destination for the post-install setup step. */
  readonly configurationUrl?: string
  readonly featured: boolean
  readonly installed: boolean
}

/** Revisioned installed, featured, source, and repository marketplace state. */
export interface SkillMarketplaceSnapshot {
  readonly revision: number
  readonly installed: readonly InstalledSkillView[]
  readonly featured: readonly MarketplaceSkillView[]
  readonly sources: readonly SkillMarketplaceSource[]
  readonly repositories: readonly MarketplaceRepositoryView[]
}

/** Paginated search request scoped to one marketplace source. */
export interface SkillSearchRequest {
  readonly source: SkillMarketplaceSource
  readonly query: string
  readonly page: number
  readonly pageSize: number
  /** Source-native category key. Empty or omitted means every category. */
  readonly category?: string
  readonly repositoryId?: string
}

/** One normalized page returned from an official or custom marketplace. */
export interface SkillSearchPage {
  readonly source: SkillMarketplaceSource
  readonly query: string
  readonly page: number
  readonly pageSize: number
  readonly total: number
  readonly skills: readonly MarketplaceSkillView[]
}

/** Immutable marketplace coordinate and version selected for installation. */
export interface SkillInstallRequest {
  readonly source: SkillMarketplaceSource
  readonly coordinate: string
  readonly namespace: string
  readonly slug: string
  readonly version: string
  readonly category?: string
  readonly repositoryId?: string
}

/** Installation result returned after the skill has been added locally. */
export interface SkillInstallReceipt {
  readonly installed: InstalledSkillView
  readonly reused: boolean
  readonly checks: readonly string[]
}

/** User request to remove one community-installed skill. Bundled skills are not removable here. */
export interface SkillRemoveRequest {
  readonly id: string
}

/** Recoverable removal receipt; the skill can be installed again from its original market. */
export interface SkillRemoveReceipt {
  readonly id: string
  readonly name: string
  readonly source: SkillMarketplaceSource
  readonly coordinate: string
}

/** User request to expose or hide an installed skill without deleting its files. */
export interface SkillEnabledSetRequest {
  readonly id: string
  readonly enabled: boolean
}

/** Updated installed-skill state after the model catalog has been invalidated. */
export interface SkillEnabledSetReceipt {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
}

/** HTTPS manifest URL submitted for custom repository registration. */
export interface SkillRepositoryAddRequest {
  readonly manifestUrl: string
}

/** Repository registration result returned after the catalog has been added. */
export interface SkillRepositoryAddReceipt {
  readonly repository: MarketplaceRepositoryView
  readonly updated: boolean
  readonly checks: readonly string[]
}

/** User request to remove a registered third-party repository. Installed skills remain on disk. */
export interface SkillRepositoryRemoveRequest {
  readonly id: string
}

/**
 * Data contract for skill repository remove receipt.
 */
export interface SkillRepositoryRemoveReceipt {
  readonly id: string
  readonly name: string
  readonly installedSkillCount: number
}
