/** Durable product task checkpoints stored outside the model-visible session surface. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Finite lifecycle states persisted for one professional task. */
export type ProfessionalCheckpointPhase =
  | 'running'
  | 'paused'
  | 'waiting-user'
  | 'draft'
  | 'failed'
  | 'formal'

/** Versioned envelope around policy-owned checkpoint data. */
export interface ProfessionalCheckpointEnvelope {
  schemaVersion: 1
  sessionId: string
  contractVersion: string
  taskStartSeq: number
  phase: ProfessionalCheckpointPhase
  updatedAt: string
  payload: unknown
}

/** Result of reading one session's latest professional checkpoint. */
export type ProfessionalCheckpointRead =
  | { kind: 'missing' }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'found'; checkpoint: ProfessionalCheckpointEnvelope }

const PHASES: ReadonlySet<string> = new Set([
  'running', 'paused', 'waiting-user', 'draft', 'failed', 'formal',
])

function checkpointEnvelope(value: unknown, expectedSessionId: string): ProfessionalCheckpointEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('检查点不是 JSON 对象')
  }
  const row = value as Record<string, unknown>
  if (row.schemaVersion !== 1
    || row.sessionId !== expectedSessionId
    || typeof row.contractVersion !== 'string' || row.contractVersion.trim() === ''
    || typeof row.taskStartSeq !== 'number' || !Number.isSafeInteger(row.taskStartSeq) || row.taskStartSeq < 0
    || typeof row.phase !== 'string' || !PHASES.has(row.phase)
    || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))
    || !Object.hasOwn(row, 'payload')) {
    throw new Error('检查点身份或字段无效')
  }
  return {
    schemaVersion: 1,
    sessionId: expectedSessionId,
    contractVersion: row.contractVersion,
    taskStartSeq: row.taskStartSeq,
    phase: row.phase as ProfessionalCheckpointPhase,
    updatedAt: row.updatedAt,
    payload: row.payload,
  }
}

/**
 * Stores the latest professional task state for each durable DSH session.
 * Filenames use a digest so a session identifier can never escape the owned directory.
 */
export class ProfessionalTaskCheckpointStore {
  private readonly root: string

  /** @param root - Host-owned private directory under the desktop user-data root. */
  constructor(root: string) {
    this.root = resolve(root)
  }

  private filename(sessionId: string): string {
    const digest = createHash('sha256').update(sessionId).digest('hex')
    return join(this.root, `${digest}.json`)
  }

  /** Atomically replace one session checkpoint with owner-only permissions.
   * @param checkpoint - Validated state for one durable professional task.
   */
  async write(checkpoint: ProfessionalCheckpointEnvelope): Promise<void> {
    const accepted = checkpointEnvelope(checkpoint, checkpoint.sessionId)
    await writeFileAtomic(this.filename(accepted.sessionId), `${JSON.stringify(accepted)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  /** Read and validate one session checkpoint without treating absence as corruption.
   * @param sessionId - Durable Session identifier whose latest checkpoint is requested.
   * @returns A missing, corrupt, or validated checkpoint result.
   */
  async read(sessionId: string): Promise<ProfessionalCheckpointRead> {
    try {
      const text = await readFile(this.filename(sessionId), 'utf8')
      return { kind: 'found', checkpoint: checkpointEnvelope(JSON.parse(text), sessionId) }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { kind: 'missing' }
      return { kind: 'corrupt', reason: error instanceof Error ? error.message : String(error) }
    }
  }
}
