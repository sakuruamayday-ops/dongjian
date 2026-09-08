import { GONGCHUANG_MODEL_PROVIDERS } from '@gongchuang/model-connections/registry'
import type { ConnectivityState } from '../src/client/connectivity.ts'

/** 测试状态必须由唯一提供商注册表生成，不能手写一个会随版本过期的子集。 */
export function providerConnections(
  overrides: Partial<ConnectivityState['providers']> = {},
): ConnectivityState['providers'] {
  const defaults = Object.fromEntries(GONGCHUANG_MODEL_PROVIDERS.map(provider => [provider.id, {
    status: 'missing' as const,
    configured: false,
    route: provider.route,
    message: '未配置',
  }])) as ConnectivityState['providers']
  return { ...defaults, ...overrides }
}
