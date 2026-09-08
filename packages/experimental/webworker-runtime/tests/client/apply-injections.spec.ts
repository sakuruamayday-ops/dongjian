// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { applyIndexInjections } from '../../src/client/apply-injections.ts'

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

it('ignores preload hints and executes readiness after every ordinary script source', async () => {
  const loadScript = vi.fn(async () => {})
  const preload = '/plugins/??app-a/client.js,app-b/client.js&rev=app'
  const bootstrap = '/plugins/??modules/client.js&rev=boot'
  const theme = '/theme-bootstrap.js?preference=dark&fontSize=16'
  const ready = '/plugins/bootstrap-ready.js'

  await applyIndexInjections([
    { kind: 'script-preload', src: preload },
    { kind: 'boot-ready', src: ready },
    { kind: 'script-src', placement: 'head', src: bootstrap },
    { kind: 'script-src', placement: 'body', src: theme },
  ], loadScript)

  expect(loadScript.mock.calls).toEqual([[bootstrap], [theme], [ready]])
  expect(document.querySelector('link[rel="preload"]')).toBeNull()
})
