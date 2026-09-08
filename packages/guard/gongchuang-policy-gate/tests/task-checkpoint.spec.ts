import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProfessionalTaskCheckpointStore } from '../src/task-checkpoint.ts'

describe('professional task checkpoint store', () => {
  it('uses one digest filename and round-trips a versioned private checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-task-checkpoint-'))
    const store = new ProfessionalTaskCheckpointStore(root)
    const sessionId = '../session/with/path-separators'
    await store.write({
      schemaVersion: 1,
      sessionId,
      contractVersion: '1.6.14',
      taskStartSeq: 7,
      phase: 'paused',
      updatedAt: new Date().toISOString(),
      payload: { evidenceReceipts: [] },
    })

    const entries = await readdir(root)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/^[0-9a-f]{64}\.json$/u)
    expect((await stat(join(root, entries[0] as string))).mode & 0o777).toBe(0o600)
    expect(await store.read(sessionId)).toMatchObject({
      kind: 'found',
      checkpoint: { sessionId, contractVersion: '1.6.14', taskStartSeq: 7, phase: 'paused' },
    })
    await expect(store.read('another-session')).resolves.toEqual({ kind: 'missing' })
  })

  it('reports corrupt data without replacing or silently accepting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-task-checkpoint-corrupt-'))
    const store = new ProfessionalTaskCheckpointStore(root)
    const sessionId = 'corrupt-session'
    await store.write({
      schemaVersion: 1,
      sessionId,
      contractVersion: '1.6.14',
      taskStartSeq: 0,
      phase: 'running',
      updatedAt: new Date().toISOString(),
      payload: {},
    })
    const [filename] = await readdir(root)
    await writeFile(join(root, filename as string), '{not-json', { mode: 0o600 })
    const result = await store.read(sessionId)
    expect(result.kind).toBe('corrupt')
  })

  it('rejects an invalid envelope before any file is committed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-task-checkpoint-invalid-'))
    const store = new ProfessionalTaskCheckpointStore(root)
    await expect(store.write({
      schemaVersion: 1,
      sessionId: 'invalid-session',
      contractVersion: '',
      taskStartSeq: 0,
      phase: 'paused',
      updatedAt: new Date().toISOString(),
      payload: {},
    })).rejects.toThrow('检查点身份或字段无效')
    await expect(readdir(root)).resolves.toEqual([])
  })
})
