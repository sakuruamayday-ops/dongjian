/** Product-owned generated Remote contributions selected by the Gongchuang Client. */

import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import gongchuangConnectorsRemote from '@gongchuang/connectors/remote'
import gongchuangSkillMarketplaceRemote from '@gongchuang/skill-marketplace/remote'
import gongchuangLocalAutomationRemote from '@gongchuang/local-automation/remote'
import gongchuangGraphMemoryRemote from '@gongchuang/graph-memory/remote'
import gongchuangAccountRemote from '@gongchuang/account/remote'
import gongchuangModelConnectionsRemote from '@gongchuang/model-connections/remote'

/** The exact product Remote set mounted by the application-selected facade. */
export const GONGCHUANG_REMOTE_CONTRIBUTIONS = [
  gongchuangConnectorsRemote,
  gongchuangSkillMarketplaceRemote,
  gongchuangLocalAutomationRemote,
  gongchuangGraphMemoryRemote,
  gongchuangAccountRemote,
  gongchuangModelConnectionsRemote,
] as const satisfies readonly TypertRemoteContribution[]
