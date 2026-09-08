import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it } from 'vitest'
import GongchuangGraphMemoryService, { resolveMemoryScope } from '../src/index.ts'
import { openDb } from '../src/store/db.ts'
import { getMessages, saveMessageOnce, searchNodes, upsertNode } from '../src/store/store.ts'

function session(id: string, cwd?: string) {
  const sessionId = SessionId(id)
  return {
    id: sessionId,
    header: {
      version: 2 as const,
      id: sessionId,
      createdAt: 1,
      isSeeded: false,
      ...(cwd === undefined ? {} : { cwd }),
    },
  }
}

function workspace(id: string, path: string, title: string, sessions: string[] = []) {
  return {
    id,
    path,
    title,
    sessionIds: sessions.map(SessionId),
  } as unknown as Pick<Workspace, 'id' | 'path' | 'title' | 'sessionIds'>
}

async function bootService(root: string): Promise<{
  service: GongchuangGraphMemoryService
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  ctx.provide('llm', {} as never)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  const fiber: Fiber = ctx.plugin(GongchuangGraphMemoryService, {
    rootDir: root,
    extractionEnabled: true,
    recallEnabled: true,
    recallMaxNodes: 6,
    recallMaxDepth: 2,
    maintenanceInterval: 6,
    llmMaxTokens: 4_096,
  })
  await fiber.await()
  const service = ctx.get('gongchuangGraphMemory')
  if (service === undefined) throw new Error('graph memory service did not mount')
  return { service, dispose: () => fiber.dispose() }
}

describe('共创 Graph Memory 分区', () => {
  it('普通会话使用个人记忆，企业会话按成员关系或目录进入该企业记忆', () => {
    const rows = [workspace('enterprise-a', '/work/a', '甲公司', ['session-a'])]
    expect(resolveMemoryScope(rows, session('general', '/other'))).toEqual({
      kind: 'personal', key: 'personal', label: '个人记忆',
    })
    expect(resolveMemoryScope(rows, session('session-a', '/work/a'))).toEqual({
      kind: 'enterprise', key: 'enterprise-a', label: '甲公司企业记忆',
    })
    expect(resolveMemoryScope(rows, session('new-session', '/work/a'))).toEqual({
      kind: 'enterprise', key: 'enterprise-a', label: '甲公司企业记忆',
    })
  })

  it('拒绝一个会话同时属于两个企业空间，避免跨企业召回', () => {
    const rows = [
      workspace('enterprise-a', '/work/a', '甲公司', ['shared']),
      workspace('enterprise-b', '/work/b', '乙公司', ['shared']),
    ]
    expect(() => resolveMemoryScope(rows, session('shared'))).toThrow('同时属于多个企业空间')
  })

  it('两个 SQLite 图谱不会检索到对方节点', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-graph-memory-'))
    const first = openDb(join(root, 'enterprise-a.db'))
    const second = openDb(join(root, 'enterprise-b.db'))
    upsertNode(first, {
      type: 'TASK', name: '甲公司高企规划', description: '甲公司专属任务', content: '只属于甲公司',
    }, 'dsh:a')
    upsertNode(second, {
      type: 'TASK', name: '乙公司专精特新规划', description: '乙公司专属任务', content: '只属于乙公司',
    }, 'dsh:b')
    expect(searchNodes(first, '甲公司', 10).map(node => node.name)).toEqual(['甲公司高企规划'])
    expect(searchNodes(first, '乙公司', 10)).toEqual([])
    expect(searchNodes(second, '乙公司', 10).map(node => node.name)).toEqual(['乙公司专精特新规划'])
    expect(searchNodes(second, '甲公司', 10)).toEqual([])
    first.close()
    second.close()
  })

  it('v1 序号键迁移后按 message.id 去重且不会漏掉碰撞序号的新消息', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-graph-memory-upgrade-'))
    const path = join(root, 'enterprise-upgrade.db')
    const sessionId = 'dsh:audit-v1'
    let db = openDb(path)
    upsertNode(db, {
      type: 'TASK', name: '企业自定义节点', description: '升级前人工内容', content: '必须保留',
    }, sessionId)
    db.prepare('DELETE FROM _migrations WHERE v=9').run()
    const insertLegacy = db.prepare(`
      INSERT INTO gm_messages
        (id, session_id, turn_index, role, content, extracted, created_at)
      VALUES (?,?,?,?,?,?,?)
    `)
    insertLegacy.run(`${sessionId}:0`, sessionId, 0, 'user', JSON.stringify({ id: 'u1' }), 1, 10)
    insertLegacy.run(`${sessionId}:5`, sessionId, 5, 'assistant', JSON.stringify({ id: 'a1' }), 0, 20)
    insertLegacy.run(`${sessionId}:8`, sessionId, 8, 'user', JSON.stringify({ id: 'u2' }), 0, 30)
    // Simulate an interrupted first upgrade: reconciliation must merge state,
    // not re-extract the same message or discard the earlier timestamp.
    insertLegacy.run(
      `${sessionId}:message:assistant:a1`,
      sessionId,
      3,
      'assistant',
      JSON.stringify({ id: 'a1' }),
      1,
      25,
    )
    db.close()

    db = openDb(path)
    expect(saveMessageOnce(db, `${sessionId}:3`, sessionId, 3, 'assistant', { id: 'a1' })).toBe(false)
    expect(saveMessageOnce(db, `${sessionId}:6`, sessionId, 6, 'user', { id: 'u2' })).toBe(false)
    expect(saveMessageOnce(db, `${sessionId}:8`, sessionId, 8, 'user', { id: 'u3' })).toBe(true)
    expect(saveMessageOnce(db, `${sessionId}:0`, sessionId, 0, 'user', { id: 'u1' })).toBe(false)
    db.close()

    db = openDb(path)
    expect(saveMessageOnce(db, `${sessionId}:8`, sessionId, 8, 'user', { id: 'u3' })).toBe(false)
    const rows = getMessages(db, sessionId)
    expect(rows.map(row => (JSON.parse(row.content) as { id: string }).id)).toEqual([
      'u1', 'a1', 'u2', 'u3',
    ])
    expect(rows.map(row => row.id)).toEqual([
      `${sessionId}:message:user:u1`,
      `${sessionId}:message:assistant:a1`,
      `${sessionId}:message:user:u2`,
      `${sessionId}:message:user:u3`,
    ])
    expect(rows.find(row => row.id.endsWith(':a1'))?.extracted).toBe(1)
    expect(searchNodes(db, '企业自定义节点', 10).map(node => node.content)).toEqual(['必须保留'])
    db.close()
  })

  it('向客户端暴露可执行的设置、统计与清除操作', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-graph-memory-service-'))
    const first = await bootService(root)
    expect(remoteMethods(first.service).map(method => method.exportName ?? method.method).sort()).toEqual([
      'clearAll', 'configure', 'snapshot',
    ])
    const enterprise = openDb(join(root, 'enterprise-0123456789abcdef01234567.db'))
    upsertNode(enterprise, {
      type: 'SKILL', name: '企业申报首稿默认', description: '企业专属方法', content: '默认使用专业模板',
    }, 'dsh:enterprise')
    enterprise.close()
    await expect(first.service.snapshot()).resolves.toMatchObject({
      enabled: true, includeToolResults: true, enterpriseStores: 1, totalNodes: 1,
    })
    await expect(first.service.configure({ enabled: false, includeToolResults: false })).resolves.toMatchObject({
      enabled: false, includeToolResults: false, totalNodes: 1,
    })
    await expect(first.service.clearAll()).resolves.toMatchObject({ totalNodes: 0, totalEdges: 0 })
    await first.dispose()

    const second = await bootService(root)
    await expect(second.service.snapshot()).resolves.toMatchObject({
      enabled: false, includeToolResults: false, enterpriseStores: 1, totalNodes: 0,
    })
    await second.dispose()
  })
})
