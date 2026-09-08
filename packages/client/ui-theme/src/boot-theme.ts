/**
 * Theme bootstrap row for the browser's pre-plugin interval. Each index
 * render embeds the current durable built-in preference and content font size;
 * the browser resolves only `system`, then writes the same DOM fields
 * ui-layout's ThemePresenter owns after the client plugin tree activates.
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import {
  DEFAULT_FONT_SIZE, DEFAULT_PREFERENCE, FONT_SIZE_MAX, FONT_SIZE_MIN, type ThemePreference,
} from './theme-settings.ts'

/** Same-origin theme bootstrap route owned by the Host package. */
export const THEME_BOOTSTRAP_PATH = '/theme-bootstrap.js'

/** Response-invariant browser source; validated settings travel in its query string. */
export const THEME_BOOTSTRAP_SOURCE = `/* Apply the host-validated theme before the application shell mounts. */
const script = document.currentScript
const source = script instanceof HTMLScriptElement ? new URL(script.src, location.href) : undefined
const preference = source?.searchParams.get('preference') ?? 'system'
const requestedFontSize = Number(source?.searchParams.get('fontSize'))
const fontSize = Number.isInteger(requestedFontSize)
  && requestedFontSize >= ${FONT_SIZE_MIN}
  && requestedFontSize <= ${FONT_SIZE_MAX}
  ? requestedFontSize
  : ${DEFAULT_FONT_SIZE}
const systemDark = preference === 'system'
  && typeof matchMedia !== 'undefined'
  && matchMedia('(prefers-color-scheme: dark)').matches
const dark = preference === 'dark' || systemDark
document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
document.body.toggleAttribute('data-ds-dark-theme', dark)
document.body.style.setProperty('--dsh-content-font-size', String(fontSize) + 'px')
`

/** Build the external bootstrap URL for one schema-validated durable section. */
function bootThemeScript(preference: ThemePreference, fontSize: number): string {
  return `${THEME_BOOTSTRAP_PATH}?${new URLSearchParams({
    preference,
    fontSize: String(fontSize),
  }).toString()}`
}

/**
 * The theme bootstrap as an injection row: an external script immediately after
 * the opening body tag, before the shell mount and module script.
 * @param preference - Current Host-backed built-in preference.
 * @param fontSize - Current Host-backed content font size in px.
 * @returns the same-origin body script row.
 */
export function bootThemeInjection(
  preference: ThemePreference = DEFAULT_PREFERENCE,
  fontSize: number = DEFAULT_FONT_SIZE,
): IndexInjection {
  return { kind: 'script-src', placement: 'body', src: bootThemeScript(preference, fontSize) }
}
