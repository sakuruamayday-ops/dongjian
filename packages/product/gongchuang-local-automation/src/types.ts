/** Client-safe local automation values. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identifier for one locally persisted automation task. */
export type AutomationTaskId = Branded<'GongchuangAutomationTaskId'>
/** Opaque identifier for one claimed automation run. */
export type AutomationRunId = Branded<'GongchuangAutomationRunId'>

/** Redacted last-run state attached to a task view. */
export interface AutomationRunView {
  readonly runId: AutomationRunId
  readonly status: 'running' | 'dispatched' | 'failed'
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly scheduledAt: string
  readonly manual: boolean
  readonly message: string
  /** Durable local session containing this run's prompt, tools and final answer. */
  readonly sessionId: string | null
}

/** Backward-compatible name for the latest item in recentRuns. */
export type AutomationLastRunView = AutomationRunView

/** Client-safe local automation task including schedule and last-run state. */
export interface AutomationTaskView {
  readonly id: AutomationTaskId
  readonly templateId: string | null
  readonly name: string
  readonly prompt: string
  readonly workspaceId: string
  /** Dedicated conversation reused by every run after its first materialization. */
  readonly conversationSessionId: string | null
  readonly everySeconds: number
  readonly cadenceLabel: string
  readonly enabled: boolean
  /** User-selected schedule anchor retained while the task is disabled. */
  readonly scheduleAnchorAt: string
  readonly nextRunAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastRun: AutomationLastRunView | null
  readonly recentRuns: readonly AutomationRunView[]
}

/** Revisioned task list with aggregate run counts. */
export interface AutomationSnapshot {
  readonly revision: number
  readonly tasks: readonly AutomationTaskView[]
  readonly running: number
  readonly dispatched: number
  readonly failed: number
}

/** Validated fields required to create or replace a template-backed task. */
export interface AutomationCreateRequest {
  readonly templateId?: string
  readonly name: string
  readonly prompt: string
  readonly workspaceId: string
  readonly everySeconds: number
  readonly cadenceLabel: string
  readonly enabled: boolean
  /** First local execution time. Omission uses now + everySeconds. */
  readonly firstRunAt?: string
}

/** Editable fields for an existing task. Template identity remains stable. */
export interface AutomationUpdateRequest extends AutomationCreateRequest {
  readonly id: AutomationTaskId
}

/** Request to change whether one task participates in local scheduling. */
export interface AutomationEnableRequest {
  readonly id: AutomationTaskId
  readonly enabled: boolean
}

/** Request to permanently remove one local task and its retained run history. */
export interface AutomationDeleteRequest {
  readonly id: AutomationTaskId
}

/** Request to claim one task immediately. */
export interface AutomationRunRequest {
  readonly id: AutomationTaskId
}

/** One-time execution claim returned to the desktop scheduler. */
export interface AutomationClaim {
  readonly runId: AutomationRunId
  readonly runToken: string
  readonly taskId: AutomationTaskId
  readonly taskName: string
  readonly prompt: string
  readonly workspaceId: string
  /** Existing dedicated conversation, or `null` before the task's first run. */
  readonly conversationSessionId: string | null
  readonly scheduledAt: string
  readonly manual: boolean
}

/** Authenticated terminal status for a previously issued execution claim. */
export interface AutomationCompleteRequest {
  readonly runId: AutomationRunId
  readonly runToken: string
  readonly status: 'dispatched' | 'failed'
  readonly message: string
  /** Session created or reused for this run; absent when dispatch failed before session creation. */
  readonly sessionId?: string
}

/** Authenticated request to bind an active run and its task to one durable conversation. */
export interface AutomationBindSessionRequest {
  readonly runId: AutomationRunId
  readonly runToken: string
  readonly sessionId: string
  /** Compare-and-replace guard used only after the prior conversation was deleted or disappeared. */
  readonly previousSessionId?: string
}

/** Admit one claimed run to its bound conversation without racing task deletion. */
export interface AutomationDispatchRequest {
  readonly runId: AutomationRunId
  readonly runToken: string
  readonly content: string
}
