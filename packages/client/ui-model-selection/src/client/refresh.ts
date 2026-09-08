/** Optional product-owned work that must finish before the shared catalog reloads. */
export interface ModelCatalogRefreshService {
  /** Refresh provider-owned catalogs without coupling this generic UI to a product package. */
  refresh: () => Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only when a product owns an explicit provider-refresh operation. */
    modelCatalogRefresh?: ModelCatalogRefreshService
  }
}
