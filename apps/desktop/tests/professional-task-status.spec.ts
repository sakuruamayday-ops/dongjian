import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProfessionalTaskCheckpointStore } from '@gongchuang/client-policy-gate'
import { professionalTaskUiStatus } from '../src/professional-task-status.ts'

describe('professional task desktop status', () => {
  it('projects a previous running task as paused without exposing its payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-desktop-task-status-'))
    const store = new ProfessionalTaskCheckpointStore(root)
    await store.write({
      schemaVersion: 1,
      sessionId: 'session-1',
      contractVersion: '1.6.14',
      taskStartSeq: 4,
      phase: 'running',
      updatedAt: '2026-08-31T10:00:00.000Z',
      payload: { secretEvidence: 'must stay in the Host' },
    })
    const status = await professionalTaskUiStatus(store, 'session-1')
    expect(status).toEqual({
      phase: 'paused', contractVersion: '1.6.14', updatedAt: '2026-08-31T10:00:00.000Z',
    })
    expect(JSON.stringify(status)).not.toContain('secretEvidence')
  })

  it('returns unavailable for a corrupt checkpoint and validates the Session identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gongchuang-desktop-task-corrupt-'))
    const store = new ProfessionalTaskCheckpointStore(root)
    await store.write({
      schemaVersion: 1,
      sessionId: 'session-2',
      contractVersion: '1.6.14',
      taskStartSeq: 0,
      phase: 'paused',
      updatedAt: '2026-08-31T10:00:00.000Z',
      payload: {},
    })
    const [filename] = await readdir(root)
    if (filename === undefined) throw new Error('checkpoint fixture was not written')
    await writeFile(join(root, filename), 'invalid-json')
    await expect(professionalTaskUiStatus(store, 'session-2')).resolves.toEqual({
      phase: 'unavailable', contractVersion: null, updatedAt: null,
    })
    await expect(professionalTaskUiStatus(store, '')).rejects.toThrow('专业任务会话标识无效')
  })
})
