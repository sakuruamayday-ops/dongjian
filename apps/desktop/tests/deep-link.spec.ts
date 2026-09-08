import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSessionDeepLink, sessionDeepLinkFromArgv } from '../src/deep-link.ts'

describe('desktop product deep links', () => {
  it('accepts only the owned thread route with a bounded Session id', () => {
    const id = 'session-8047334b-7c23-4880-9e5a-add88992de30'
    expect(parseSessionDeepLink(`dongjian://threads/${id}`)).toBe(id)
    for (const value of [
      `codex://threads/${id}`,
      `dongjian://other/${id}`,
      `dongjian://threads/${id}/child`,
      `dongjian://threads/${id}?next=https://example.com`,
      'dongjian://threads/not-a-session',
    ]) expect(parseSessionDeepLink(value)).toBeUndefined()
  })

  it('selects a valid OS launch argument without interpreting unrelated values', () => {
    const id = 'session-8047334b-7c23-4880-9e5a-add88992de30'
    expect(sessionDeepLinkFromArgv(['Gongchuang.exe', '--flag', `dongjian://threads/${id}`])).toBe(id)
    expect(sessionDeepLinkFromArgv(['Gongchuang.exe', '--flag'])).toBeUndefined()
  })

  it('registers the same protocol in the packaged application metadata', () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      build?: { protocols?: Array<{ schemes?: string[] }> }
    }
    expect(pkg.build?.protocols?.some(entry => entry.schemes?.includes('dongjian'))).toBe(true)
  })
})
