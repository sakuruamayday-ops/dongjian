import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EnterpriseTrashJournal } from '../src/enterprise-trash-journal.ts'

describe('enterprise Trash journal', () => {
  it('persists conversation and workspace intents atomically across store instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-enterprise-trash-'))
    const filename = join(root, 'pending.json')
    const journal = new EnterpriseTrashJournal(filename)
    await journal.begin('session-one', join(root, 'sessions', 'session-one'))
    await journal.beginWorkspace({
      workspaceId: 'workspace-one',
      workspaceDirectory: join(root, 'enterprise-one'),
      sessionIds: ['session-one'],
      sessionDirectories: [join(root, 'sessions', 'session-one')],
    })

    const reloaded = new EnterpriseTrashJournal(filename)
    await expect(reloaded.list()).resolves.toEqual([{
      sessionId: 'session-one', artifactDirectory: join(root, 'sessions', 'session-one'),
    }])
    await expect(reloaded.listWorkspaces()).resolves.toEqual([{
      workspaceId: 'workspace-one',
      workspaceDirectory: join(root, 'enterprise-one'),
      sessionIds: ['session-one'],
      sessionDirectories: [join(root, 'sessions', 'session-one')],
    }])

    await reloaded.complete('session-one')
    await reloaded.completeWorkspace('workspace-one')
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({
      schemaVersion: 1, conversations: [], workspaces: [],
    })
  })

  it('does not let one workspace id switch to a different main-owned target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-enterprise-trash-'))
    const journal = new EnterpriseTrashJournal(join(root, 'pending.json'))
    await journal.beginWorkspace({
      workspaceId: 'workspace-one',
      workspaceDirectory: join(root, 'enterprise-one'),
      sessionIds: [],
      sessionDirectories: [],
    })
    await expect(journal.beginWorkspace({
      workspaceId: 'workspace-one',
      workspaceDirectory: join(root, 'enterprise-two'),
      sessionIds: [],
      sessionDirectories: [],
    })).rejects.toThrow('不同的删除事务目标')
  })
})
