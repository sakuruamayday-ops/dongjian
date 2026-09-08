import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Resolve the package anchor shared by preset health checks and preset mounts.
 *
 * Packaged applications keep the mutable profile outside the application
 * archive, so `ctx.baseUrl` points at a directory that cannot see the plugins
 * bundled inside the host. The boot layer publishes `hostModuleBaseUrl` for
 * exactly that layout. Discovery and mounting must select the same anchor or a
 * healthy shipped preset is rejected before any of its existing packages can
 * be imported.
 * @param ctx - roster or agent context participating in preset composition.
 * @returns the packaged-host anchor when present, otherwise the config base.
 */
export function presetModuleBase(ctx: Context): string | undefined {
  const hostBase: unknown = ctx.get('hostModuleBaseUrl')
  const base = typeof hostBase === 'string' && hostBase !== '' ? hostBase : ctx.baseUrl
  // Desktop hosts publish their package.json as an absolute filename because
  // createRequire accepts that form. Preset health uses fileURLToPath and the
  // nested Loader uses URL resolution, so handing the filename through causes
  // every new session to fail with `TypeError: Invalid URL`. Normalize once at
  // the shared health/mount boundary so those two paths cannot drift again.
  return base !== undefined && isAbsolute(base) ? pathToFileURL(base).href : base
}
