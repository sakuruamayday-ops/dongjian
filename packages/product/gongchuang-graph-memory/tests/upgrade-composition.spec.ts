import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SessionId,
  SessionLogOffset,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
} from '@deepseek-ai/dsh-session-format'
import { sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import GongchuangGraphMemoryService from '../src/index.ts'
import { openDb } from '../src/store/db.ts'
import {
  getMessages,
  searchNodes,
  upsertNode,
} from '../src/store/store.ts'
import { describe, expect, it } from 'vitest'

function event(
  type: string,
  seq: number,
  data: SessionFormatEvent['data'],
): SessionFormatEvent {
  return {
    type,
    seq,
    time: 100 + seq,
    data,
    ...(type === 'user/message' ? { surfaceOp: 'append' } : {}),
  }
}

function userMessage(id: string, text: string) {
  return {
    id: MessageId(id),
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user' as const },
  }
}

function assistantMessage(id: string, text: string) {
  return {
    id: MessageId(id),
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'model' as const, provider: 'mock', model: 'mock' },
  }
}

function legacyArtifact(): SessionFormatArtifact {
  const answer = assistantMessage('a1', 'first answer')
  return {
    header: {
      version: 1,
      id: 'audit-v1',
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
    },
    inheritedEventCount: 0,
    events: [
      event('user/message', 0, userMessage('u1', 'first question')),
      event('turn/start', 1, { turn: 1 }),
      event('step/start', 2, { turn: 1, step: 1 }),
      event('assistant/chunk', 3, {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'first answer' },
      }),
      event('assistant/chunk', 4, {
        turn: 1,
        step: 1,
        chunk: { type: 'finish', reason: { kind: 'stop' } },
      }),
      {
        ...event('assistant/message', 5, { turn: 1, step: 1, message: answer }),
        sourceEventSeqs: [3, 4],
        surfaceOp: 'append',
      },
      event('step/end', 6, { turn: 1, step: 1 }),
      event('turn/end', 7, { turn: 1, reason: { kind: 'completed' } }),
      event('user/message', 8, userMessage('u2', 'second question')),
    ],
  }
}

function workspace(
  id: string,
  path: string,
  title: string,
  sessionIds: string[],
): Pick<Workspace, 'id' | 'path' | 'title' | 'sessionIds'> {
  return {
    id,
    path,
    title,
    sessionIds: sessionIds.map(SessionId),
  } as unknown as Pick<Workspace, 'id' | 'path' | 'title' | 'sessionIds'>
}

function enterpriseDbPath(root: string, workspaceId: string): string {
  const suffix = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24)
  return join(root, `enterprise-${suffix}.db`)
}

async function boot(
  root: string,
  workspaces: readonly Pick<Workspace, 'id' | 'path' | 'title' | 'sessionIds'>[],
): Promise<{
  ctx: Context
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const sessionFiber: Fiber = ctx.plugin(SessionStore)
  await sessionFiber.await()
  const systemFiber: Fiber = ctx.plugin(SystemPrompt)
  await systemFiber.await()
  const toolsFiber: Fiber = ctx.plugin(ToolRuntime)
  await toolsFiber.await()
  ctx.provide('llm', {} as never)
  ctx.provide('workspaceRegistry', { list: () => workspaces } as never)
  const graphFiber: Fiber = ctx.plugin(GongchuangGraphMemoryService, {
    rootDir: root,
    extractionEnabled: true,
    recallEnabled: true,
    maintenanceInterval: 100,
  })
  await graphFiber.await()
  return {
    ctx,
    dispose: async () => {
      await graphFiber.dispose()
      await toolsFiber.dispose()
      await systemFiber.dispose()
      await sessionFiber.dispose()
    },
  }
}

function restore(
  ctx: Context,
  artifact: SessionFormatArtifact,
): { session: Session; detach: () => void } {
  const id = SessionId(artifact.header.id)
  const session = ctx.sessions.prepare(id, {
    seedSource: 'persistence',
    seed: artifact.events as unknown as SessionEvent[],
    meta: { ...artifact.header, id } as unknown as SessionHeader,
    inheritedEventCount: SessionLogOffset(artifact.inheritedEventCount),
  })
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  return { session, detach }
}

function resumeGraph(ctx: Context, session: Session): void {
  const agent = { id: session.id, session } as Agent
  emitAgentEvent(ctx, agent, 'agent/session-start', { source: 'resume' })
}

function messageIds(path: string, sessionId: string): Array<{
  id: string
  turn: number
  extracted: number
}> {
  const db = openDb(path)
  try {
    return getMessages(db, `dsh:${sessionId}`).map(row => ({
      id: (JSON.parse(row.content) as { id: string }).id,
      turn: row.turn_index,
      extracted: row.extracted,
    }))
  } finally {
    db.close()
  }
}

describe('client graph-memory upgrade composition', () => {
  it('migrates old graph keys before official v1-to-v2 backfill and remains stable after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-graph-upgrade-composition-'))
    const firstWorkspace = workspace(
      'enterprise-upgrade',
      '/tmp/gongchuang-enterprise-upgrade',
      '升级企业',
      ['audit-v1'],
    )
    const secondWorkspace = workspace(
      'enterprise-isolated',
      '/tmp/gongchuang-enterprise-isolated',
      '隔离企业',
      ['audit-other'],
    )
    const workspaces = [firstWorkspace, secondWorkspace]
    const firstPath = enterpriseDbPath(root, String(firstWorkspace.id))
    const secondPath = enterpriseDbPath(root, String(secondWorkspace.id))
    const sessionKey = 'dsh:audit-v1'

    let db = openDb(firstPath)
    upsertNode(db, {
      type: 'TASK',
      name: '企业自定义节点',
      description: '升级前人工内容',
      content: '必须保留',
    }, sessionKey)
    db.prepare('DELETE FROM _migrations WHERE v=9').run()
    const insertLegacy = db.prepare(`
      INSERT INTO gm_messages
        (id, session_id, turn_index, role, content, extracted, created_at)
      VALUES (?,?,?,?,?,?,?)
    `)
    insertLegacy.run(`${sessionKey}:0`, sessionKey, 0, 'user', JSON.stringify(userMessage('u1', 'first question')), 1, 10)
    insertLegacy.run(`${sessionKey}:5`, sessionKey, 5, 'assistant', JSON.stringify(assistantMessage('a1', 'first answer')), 1, 20)
    insertLegacy.run(`${sessionKey}:8`, sessionKey, 8, 'user', JSON.stringify(userMessage('u2', 'second question')), 0, 30)
    db.close()

    const migrated = sessionFormatV1ToV2.migrate(legacyArtifact())
    expect(migrated.events.filter(row => row.type === 'assistant/message')[0]?.seq).toBe(3)
    expect(migrated.events.find(row => row.type === 'user/message' && (row.data as { id?: string }).id === 'u2')?.seq)
      .toBe(6)

    const first = await boot(root, workspaces)
    const restored = restore(first.ctx, migrated)
    resumeGraph(first.ctx, restored.session)
    expect(messageIds(firstPath, 'audit-v1')).toEqual([
      { id: 'u1', turn: 0, extracted: 1 },
      { id: 'a1', turn: 3, extracted: 1 },
      { id: 'u2', turn: 6, extracted: 0 },
    ])

    const appended = restored.session.append(
      'user/message',
      userMessage('u3', 'new message after upgrade'),
      { surfaceOp: 'append' },
    )
    expect(appended.seq).toBe(8)

    const otherSession = first.ctx.sessions.create(SessionId('audit-other'), {
      meta: { cwd: secondWorkspace.path },
    })
    otherSession.append('user/message', userMessage('other-u1', 'isolated company'), {
      surfaceOp: 'append',
    })
    resumeGraph(first.ctx, otherSession)
    expect(messageIds(firstPath, 'audit-v1').map(row => row.id)).toEqual(['u1', 'a1', 'u2', 'u3'])
    expect(messageIds(secondPath, 'audit-other').map(row => row.id)).toEqual(['other-u1'])

    const restartedEvents = restored.session.snapshotEvents()
    const restartedHeader = restored.session.header
    restored.detach()
    await first.dispose()

    const second = await boot(root, workspaces)
    const replayed = restore(second.ctx, {
      header: restartedHeader as unknown as SessionFormatArtifact['header'],
      inheritedEventCount: 0,
      events: restartedEvents as unknown as SessionFormatEvent[],
    })
    resumeGraph(second.ctx, replayed.session)
    expect(messageIds(firstPath, 'audit-v1')).toEqual([
      { id: 'u1', turn: 0, extracted: 1 },
      { id: 'a1', turn: 3, extracted: 1 },
      { id: 'u2', turn: 6, extracted: 0 },
      { id: 'u3', turn: 8, extracted: 0 },
    ])
    db = openDb(firstPath)
    expect(searchNodes(db, '企业自定义节点', 10).map(node => node.content)).toEqual(['必须保留'])
    db.close()
    expect(messageIds(secondPath, 'audit-other').map(row => row.id)).toEqual(['other-u1'])
    replayed.detach()
    await second.dispose()
  })
})
