/** Host registration for the browser theme preference and pre-plugin palette. */

import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import {
  bootThemeInjection, THEME_BOOTSTRAP_PATH, THEME_BOOTSTRAP_SOURCE,
} from './boot-theme.ts'
import {
  DEFAULT_FONT_SIZE, DEFAULT_PREFERENCE, THEME_SETTINGS_NAMESPACE, ThemeSettingsSchema,
  type ThemePreference, type ThemeSettings,
} from './theme-settings.ts'

export {
  DEFAULT_FONT_SIZE, DEFAULT_PREFERENCE, FONT_SIZE_FIELD, FONT_SIZE_MAX, FONT_SIZE_MIN,
  THEME_PREFERENCE_FIELD, THEME_PREFERENCES, THEME_SETTINGS_NAMESPACE,
  type ThemePreference, type ThemeSettings,
} from './theme-settings.ts'

const THEME_NAMESPACE = THEME_SETTINGS_NAMESPACE

/** Read the registered theme section or the schema defaults without a settings provider. */
function readSection(ctx: Context): { preference: ThemePreference; fontSize: number } {
  const fallback = { preference: DEFAULT_PREFERENCE, fontSize: DEFAULT_FONT_SIZE }
  const settings = ctx.get('settings')
  if (settings === undefined) return fallback
  const section = settings.get(THEME_NAMESPACE) as ThemeSettings | undefined
  if (section === undefined) return fallback
  return section
}

/** Serve the fixed external bootstrap; its validated values remain in the script URL. */
const serveThemeBootstrap: WebRoute['handler'] = (req, res): void => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-cache',
  })
  res.end(req.method === 'HEAD' ? undefined : THEME_BOOTSTRAP_SOURCE)
}

/**
 * Register the durable theme section when the optional settings service is
 * composed, and answer every index injection collection with the current
 * theme bootstrap row.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(THEME_NAMESPACE, ThemeSettingsSchema)
  })
  ctx.on('webserver/index-inject', (table) => {
    const section = readSection(ctx)
    table.push(bootThemeInjection(section.preference, section.fontSize))
  })
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact', path: THEME_BOOTSTRAP_PATH, handler: serveThemeBootstrap,
      }),
      'ui-theme: external bootstrap route',
    )
  })
}
