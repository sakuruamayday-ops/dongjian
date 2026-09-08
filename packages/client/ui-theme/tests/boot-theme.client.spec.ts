// @vitest-environment jsdom
/** The theme bootstrap injection row and the resulting pre-plugin browser theme. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootThemeInjection, THEME_BOOTSTRAP_SOURCE } from '../src/boot-theme.ts'
import type { ThemePreference } from '../src/theme-settings.ts'

const DARK_ATTRIBUTE = 'data-ds-dark-theme'
const BOOTSTRAP_SOURCE = readFileSync(resolve(process.cwd(), 'apps/web/public/theme-bootstrap.js'), 'utf8')

function mockSystemDark(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches }) as MediaQueryList))
}

function executeBootstrap(preference?: ThemePreference, fontSize?: number): void {
  const row = bootThemeInjection(preference, fontSize)
  if (row.kind !== 'script-src') throw new Error('theme bootstrap row is not an external script')
  const script = document.createElement('script')
  script.src = row.src
  Object.defineProperty(document, 'currentScript', { value: script, configurable: true })
  runInNewContext(BOOTSTRAP_SOURCE, {
    document,
    HTMLScriptElement,
    location,
    matchMedia: globalThis.matchMedia,
    Number,
    URL,
  })
  Reflect.deleteProperty(document, 'currentScript')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.style.removeProperty('color-scheme')
  document.body.removeAttribute(DARK_ATTRIBUTE)
  document.body.style.removeProperty('--dsh-content-font-size')
})

describe('theme bootstrap row', () => {
  it('keeps the Host route source byte-identical to the static web fallback', () => {
    expect(THEME_BOOTSTRAP_SOURCE).toBe(BOOTSTRAP_SOURCE)
  })

  it('is a body script row, so it runs before the shell mount', () => {
    mockSystemDark(false)
    const row = bootThemeInjection('dark')
    expect(row).toMatchObject({
      kind: 'script-src', placement: 'body', src: '/theme-bootstrap.js?preference=dark&fontSize=14',
    })
    executeBootstrap('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
  })

  it('lets durable light override a dark OS and clears stale dark state', () => {
    document.body.setAttribute(DARK_ATTRIBUTE, '')
    mockSystemDark(true)
    executeBootstrap('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it.each([
    [true, 'dark', true],
    [false, 'light', false],
  ] as const)('resolves system=%s to %s', (matches, colorScheme, dark) => {
    mockSystemDark(matches)
    executeBootstrap('system')
    expect(document.documentElement.style.colorScheme).toBe(colorScheme)
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(dark)
  })

  it('defaults to system and falls back to light when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    executeBootstrap()
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it('writes the durable content font size and defaults it to 14px', () => {
    mockSystemDark(false)
    executeBootstrap('light', 17)
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('17px')
    executeBootstrap('light')
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('14px')
  })
})
