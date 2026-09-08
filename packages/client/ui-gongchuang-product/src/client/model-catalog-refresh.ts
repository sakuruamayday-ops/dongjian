import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelCatalogRefreshService } from '@deepseek-ai/dsh-client-ui-model-selection/client'

type ModelConnectionsRemote = Pick<ClientRemote['gongchuangModelConnections'], 'refresh'>

/**
 * Provide the product-owned provider refresh behind the generic selector's
 * optional contract. Registration itself performs no network request.
 * @param ctx - product plugin context.
 * @param remote - trusted Host model-connections remote.
 */
export function installModelCatalogRefresh(ctx: Context, remote: ModelConnectionsRemote): void {
  const service: ModelCatalogRefreshService = {
    refresh: async () => {
      const result = await remote.refresh({})
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      const providers = Object.values(result.value.providers)
      // Host 已按提供方隔离刷新；单一供应商错误不能升级为全目录失败。
      const usable = providers.some(provider => provider.configured
        && (provider.phase === 'ready' || provider.phase === 'candidate')
        && provider.modelCount > 0)
      if (!usable) {
        const failed = providers.find(provider => provider.configured && provider.phase === 'error')
        throw new Error(failed?.message ?? '刷新后没有可用模型')
      }
    },
  }
  ctx.provide('modelCatalogRefresh', service)
}
