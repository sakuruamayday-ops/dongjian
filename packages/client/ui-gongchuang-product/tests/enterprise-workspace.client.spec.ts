import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isConcreteEnterpriseWorkspacePath } from '../src/client/enterprise-workspace.ts'
import { workspaceSessionIdsForDeletion } from '../src/client/index.ts'

const productClientSource = readFileSync(resolve(import.meta.dirname, '../src/client/index.ts'), 'utf8')

describe('企业空间目录准入', () => {
  it.each([
    '/', '/Users/example', '/Users/example/Documents', '/home/example', '/home/example/Downloads',
    'C:\\', 'C:\\Users\\example', 'C:\\Users\\example\\Desktop',
  ])('拒绝宽目录 %s', (path) => {
    expect(isConcreteEnterpriseWorkspacePath(path)).toBe(false)
  })

  it.each([
    '/Users/example/Documents/杭州示例企业',
    '/home/example/projects/company-a',
    'C:\\Users\\example\\Documents\\杭州示例企业',
  ])('接受具体企业目录 %s', (path) => {
    expect(isConcreteEnterpriseWorkspacePath(path)).toBe(true)
  })

  it('routes product deletion through the desktop id-only Trash bridge', () => {
    expect(productClientSource).toMatch(
      /await desktop\.trashEnterpriseWorkspace\(workspaceId\)/u,
    )
    expect(productClientSource).toMatch(/await desktop\.trashEnterpriseConversation\(sessionId\)/u)
    expect(productClientSource).not.toMatch(/trashEnterpriseWorkspace\([^)]*path/u)
    expect(productClientSource).toMatch(
      new RegExp([
        'for \\(const sessionId of sessionIds\\) \\{',
        'documentDrafts\\.clear\\(sessionId\\)',
        'annotationDrafts\\.clear\\(sessionId\\)',
        'await composerDraftPersistence\\?\\.clear\\(sessionId\\)',
        '\\}',
      ].join('\\s+'), 'u'),
    )
  })

  it('collects attachment drafts from an archived workspace before desktop deletion', () => {
    expect(workspaceSessionIdsForDeletion({
      items: [],
      archivedItems: [{ workspaceId: 'archived', sessionIds: ['session-one', 'session-two'] as never }],
    }, 'archived')).toEqual(['session-one', 'session-two'])
  })
})
