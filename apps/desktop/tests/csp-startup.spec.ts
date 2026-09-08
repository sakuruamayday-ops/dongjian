import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const main = readFileSync(resolve(import.meta.dirname, '../src/main.ts'), 'utf8')

describe('desktop CSP startup acceptance', () => {
  test('keeps executable scripts same-origin and probes the packaged RC.8 handoff', () => {
    expect(main).toContain('"script-src \'self\'"')
    expect(main).not.toContain('"script-src \'self\' \'unsafe-inline\'"')
    expect(main).toContain("document.getElementById('dsh-boot-manifest')")
    expect(main).toContain("script.type !== 'application/json'")
    expect(main).toContain("document.querySelector('[data-dsh-boot]')")
    expect(main).toContain("bootPage?.textContent?.includes('Failed to load plugins')")
    expect(main).toContain('document.body.dataset.gongchuangProduct ?? null')
    expect(main).toContain("document.querySelector('[data-gongchuang-product-root=\"sidebar\"]')")
    expect(main).toContain('probe.productRootVisible')
    expect(main).toContain("probe.loaderMode !== 'live'")
    expect(main).toContain('probe.bootFailureVisible !== false')
    expect(main).toContain('probe.bootPagePresent !== false')
    expect(main).toContain("probe.productUiMarker !== 'v0.1'")
    expect(main).toContain("acceptanceUserDataRoot !== undefined || macUpdateLaunch?.status === 'attempting'")
    expect(main).toContain('await verifyProductRendererStartup(window)')
    expect(main.indexOf('await verifyProductRendererStartup(window)'))
      .toBeLessThan(main.indexOf('commitMacUpdateLaunch(macUpdateLaunch)'))
    expect(main.indexOf('app.requestSingleInstanceLock()'))
      .toBeLessThan(main.indexOf('beginMacUpdateLaunch('))
  })
})
