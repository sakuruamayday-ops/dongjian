/**
 * Browser half of the native directory-picker backend: fills ui-workspace's
 * two directory-flow holes with a renderless occupant that answers each
 * `open` by driving `directoryPicker/pick` (the node half's OS chooser) and
 * reporting the one outcome — picked path, cancellation, or failure — back
 * through the owner conversation. Mounting this package therefore composes
 * both sides of the native interaction with one cordis.yml row; no client
 * code branches on a capability kind.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotMap merge declaring the directory-flow holes.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { NativeFlowInjected } from './flow.ts'
import { NativeDirectoryFlow } from './flow.ts'


/** Required services (cordis fiber inject): the slot registry and workspace UI service. */
export const inject = ['slots', 'uiWorkspace']

/**
 * Client plugin body: register the renderless native flow into both
 * directory-flow holes through `slots.inject()` because the ui-workspace
 * entries may activate later or replace their declarations.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const injected = (): NativeFlowInjected => ({ pick: () => ctx.uiWorkspace.pickDirectory() })
  // Product shells may replace the stock sidebar while retaining the
  // conversation picker, so each surface follows its own declaration lifetime.
  for (const name of [
    'conversation.hero.workspace.directoryFlow',
    'sidebar.workspaces.directoryFlow',
  ] as const) {
    ctx.slots.inject(name, () => ctx.slots.register({ name, inject: injected }, NativeDirectoryFlow))
  }
}
