/** Redacted desktop projection of one professional-task checkpoint. */

import type { ProfessionalTaskCheckpointStore } from '@gongchuang/client-policy-gate'

export const PROFESSIONAL_TASK_STATUS_CHANNEL = 'gongchuang:professional-task:status'

export type ProfessionalTaskUiPhase =
  | 'none'
  | 'paused'
  | 'waiting-user'
  | 'draft'
  | 'failed'
  | 'formal'
  | 'unavailable'

/** Renderer-safe checkpoint metadata. Evidence, paths, diagnostics and prompts never cross IPC. */
export interface ProfessionalTaskUiStatus {
  readonly phase: ProfessionalTaskUiPhase
  readonly contractVersion: string | null
  readonly updatedAt: string | null
}

/** Read one checkpoint without exposing policy-owned payload data to the renderer. */
export async function professionalTaskUiStatus(
  store: ProfessionalTaskCheckpointStore,
  sessionId: unknown,
): Promise<ProfessionalTaskUiStatus> {
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 512) {
    throw new Error('专业任务会话标识无效')
  }
  const result = await store.read(sessionId)
  if (result.kind === 'missing') return { phase: 'none', contractVersion: null, updatedAt: null }
  if (result.kind === 'corrupt') return { phase: 'unavailable', contractVersion: null, updatedAt: null }
  // A checkpoint left as running belongs to the previous desktop process. The
  // new process must never continue it silently, so the UI projects it as paused.
  const phase = result.checkpoint.phase === 'running' ? 'paused' : result.checkpoint.phase
  return {
    phase,
    contractVersion: result.checkpoint.contractVersion,
    updatedAt: result.checkpoint.updatedAt,
  }
}
