// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installProductShellStyleRecovery, PRODUCT_SHELL_STYLE_ID,
} from '../src/client/ProductShell.tsx'

afterEach(() => {
  for (const tag of document.querySelectorAll(`style[data-plugin-css="${PRODUCT_SHELL_STYLE_ID}"]`)) {
    tag.remove()
  }
})

describe('ProductShell stylesheet recovery', () => {
  it('reinjects the exact bundled stylesheet after a plugin reload removes its tag', async () => {
    const cssText = '.brandMark{width:40px;height:40px}.sidebar{display:flex}'
    const dispose = installProductShellStyleRecovery(document, cssText)
    const initial = document.querySelector<HTMLStyleElement>(
      `style[data-plugin-css="${PRODUCT_SHELL_STYLE_ID}"]`,
    )
    expect(initial?.dataset.plugin).toBe('@gongchuang/client-ui')
    expect(initial?.textContent).toBe(cssText)

    initial?.remove()
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLStyleElement>(
        `style[data-plugin-css="${PRODUCT_SHELL_STYLE_ID}"]`,
      )?.textContent).toBe(cssText)
    })

    dispose()
  })
})
