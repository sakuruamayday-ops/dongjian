import type {
  AutomationClaim, AutomationCreateRequest, AutomationSnapshot, AutomationTaskId, AutomationUpdateRequest, ClientRemote,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { gongchuangUserError } from '@gongchuang/user-errors'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'

function automationError(error: unknown): string {
  if (error instanceof AutomationProjectedError) return error.message
  return gongchuangUserError(error, 'product').text
}

class AutomationProjectedError extends Error {}

function receiptSubmissionError(error: unknown): AutomationProjectedError {
  return new AutomationProjectedError(`自动任务运行回执未提交：${automationError(error)}`)
}

/** Browser state for the local automation registry and active dispatches. */
export interface AutomationState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot: AutomationSnapshot
  executing: AutomationTaskId[]
  notice: string | null
  error: string | null
}

const EMPTY_SNAPSHOT: AutomationSnapshot = Object.freeze({
  revision: 0, tasks: Object.freeze([]), running: 0, dispatched: 0, failed: 0,
})

type AutomationRemote = ClientRemote['gongchuangLocalAutomation']

/** Successful normal-session dispatch retained in the Host run receipt. */
export interface AutomationDispatchReceipt {
  message: string
  sessionId: string
}

/** Failure raised after a run has already obtained and durably bound its conversation. */
export class AutomationDispatchError extends Error {
  /**
   * @param cause - Underlying prompt or model-run failure.
   * @param sessionId - Durable task conversation that contains any admitted work.
   */
  constructor(cause: unknown, readonly sessionId: string) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AutomationDispatchError'
  }
}

/** Persist one task's dedicated conversation before its prompt is admitted. */
export type AutomationSessionBinder = (sessionId: string, previousSessionId?: string) => Promise<void>

/** Admit the bound run through the Host's task mutation queue. */
export type AutomationMessageDispatcher = (content: string) => Promise<SessionRequestId>

/** Execute one claimed task through its ordinary product conversation. */
export type AutomationDispatcher = (
  claim: AutomationClaim,
  bindSession: AutomationSessionBinder,
  admitMessage: AutomationMessageDispatcher,
) => Promise<AutomationDispatchReceipt>

/** Browser projection of the Host-owned local task registry and claim broker. */
export class AutomationController {
  /** Observable automation state consumed by the product shell. */
  readonly store: SnapshotStore<AutomationState> = createSnapshotStore({
    status: 'idle', snapshot: EMPTY_SNAPSHOT, executing: [], notice: null, error: null,
  })
  private loadGeneration = 0
  private mutationTail: Promise<void> = Promise.resolve()
  private pollError: string | null = null

  constructor(
    private readonly remote: AutomationRemote,
    private readonly dispatch: AutomationDispatcher,
  ) {}

  /**
   * Reload task definitions and durable run counters from the Host.
   * @returns once the latest registry snapshot is published.
   */
  async load(): Promise<void> {
    const generation = ++this.loadGeneration
    this.pollError = null
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    try {
      const result = await this.remote.snapshot()
      if (!result.ok) throw new Error(result.error.message)
      if (generation !== this.loadGeneration) return
      this.store.update((state) => {
        state.status = 'ready'; state.snapshot = result.value; state.error = null
      })
    } catch (error) {
      if (generation !== this.loadGeneration) return
      this.store.update((state) => {
        state.status = 'error'; state.error = automationError(error)
      })
    }
  }

  /**
   * Create one local recurring task and refresh the registry.
   * @param request - validated task definition supplied by the product form.
   * @returns once the mutation and following reload complete.
   */
  create(request: AutomationCreateRequest): Promise<void> {
    return this.mutate(async () => {
      const result = await this.remote.createTask(request)
      if (!result.ok) throw new Error(result.error.message)
      this.store.update((state) => { state.notice = `${result.value.name} 已保存到本机任务注册表` })
    })
  }

  /**
   * Edit a task definition while preserving its durable id and run history.
   * @param request - Complete editable task definition and durable identity.
   */
  update(request: AutomationUpdateRequest): Promise<void> {
    return this.mutate(async () => {
      const result = await this.remote.updateTask(request)
      if (!result.ok) throw new Error(result.error.message)
      this.store.update((state) => { state.notice = `${result.value.name} 已更新，下次运行时间已重新计算` })
    })
  }

  /**
   * Enable or disable one local task.
   * @param id - durable task identity.
   * @param enabled - desired local scheduling state.
   * @returns once the Host mutation and following reload complete.
   */
  setEnabled(id: AutomationTaskId, enabled: boolean): Promise<void> {
    return this.mutate(async () => {
      const result = await this.remote.setTaskEnabled({ id, enabled })
      if (!result.ok) throw new Error(result.error.message)
      this.store.update((state) => { state.notice = `${result.value.name} 已${enabled ? '启用' : '停用'}` })
    })
  }

  /**
   * Delete one local task after the product shell has obtained user confirmation.
   * @param id - Durable task identity.
   */
  remove(id: AutomationTaskId): Promise<void> {
    return this.mutate(async () => {
      const result = await this.remote.deleteTask({ id })
      if (!result.ok) throw new Error(result.error.message)
      this.store.update((state) => { state.notice = '任务已删除' })
    })
  }

  /**
   * Claim and dispatch one task immediately through the normal session path.
   * @param id - durable task identity.
   * @returns once dispatch and receipt settlement complete.
   */
  async runNow(id: AutomationTaskId): Promise<void> {
    if (this.store.getSnapshot().executing.includes(id)) throw new Error('该任务已有一次运行正在执行')
    this.store.update((state) => { state.executing.push(id) })
    try {
      // Serialize only the registry mutation, not the potentially long model run.
      const claim = await this.mutate(async () => {
        const result = await this.remote.runTaskNow({ id })
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      })
      const dispatchError = await this.dispatchClaim(claim)
      await this.load()
      if (dispatchError !== null) throw dispatchError
    } catch (error) {
      this.store.update((state) => { state.error = automationError(error) })
      throw error
    } finally {
      this.store.update((state) => { state.executing = state.executing.filter(taskId => taskId !== id) })
    }
  }

  /**
   * Claim at most one due task and dispatch it when the mutation queue is idle.
   * @returns once the due-task check and optional dispatch complete.
   */
  async poll(): Promise<void> {
    await this.mutationTail
    let result: Awaited<ReturnType<AutomationRemote['claimDue']>>
    try {
      result = await this.remote.claimDue()
      if (!result.ok) throw new Error(result.error.message)
    } catch (error) {
      this.pollError = automationError(error)
      this.store.update((state) => { state.error = this.pollError })
      return
    }
    const previousError = this.pollError
    this.pollError = null
    if (previousError !== null) this.store.update((state) => {
      if (state.error === previousError) state.error = null
    })
    if (result.value === null) return
    const dispatchError = await this.dispatchClaim(result.value)
    await this.load()
    if (dispatchError !== null) {
      this.store.update((state) => { state.error = dispatchError.message })
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutationTail.then(async () => {
      this.pollError = null
      this.store.update((state) => { state.error = null; state.notice = null })
      try {
        return await operation()
      } finally {
        // Reload even on failure: the Host may already have committed a receipt.
        await this.load()
      }
    })
    this.mutationTail = task.then(() => undefined, (error: unknown) => {
      this.store.update((state) => { state.error = automationError(error) })
    })
    return task
  }

  private async dispatchClaim(claim: AutomationClaim): Promise<AutomationProjectedError | null> {
    this.store.update((state) => {
      if (!state.executing.includes(claim.taskId)) state.executing.push(claim.taskId)
    })
    let status: 'dispatched' | 'failed' = 'dispatched'
    let message: string
    let sessionId: string | undefined
    try {
      const receipt = await this.dispatch(claim, async (candidate, previousSessionId) => {
        const bound = await this.remote.bindRunSession({
          runId: claim.runId, runToken: claim.runToken, sessionId: candidate,
          ...(previousSessionId === undefined ? {} : { previousSessionId }),
        })
        if (!bound.ok) throw new Error(bound.error.message)
      }, async (content) => {
        const sent = await this.remote.dispatchRun({ runId: claim.runId, runToken: claim.runToken, content })
        if (!sent.ok) throw new Error(sent.error.message)
        return sent.value.requestId
      })
      message = receipt.message
      sessionId = receipt.sessionId
    } catch (error) {
      status = 'failed'
      if (error instanceof AutomationDispatchError) sessionId = error.sessionId
      message = automationError(error)
    }
    let receiptAccepted = false
    let receiptError: AutomationProjectedError | null = null
    try {
      const completed = await this.remote.completeRun({
        runId: claim.runId, runToken: claim.runToken, status, message,
        ...(sessionId === undefined ? {} : { sessionId }),
      })
      if (completed.ok && completed.value === null) return null
      receiptAccepted = completed.ok
      if (!completed.ok) receiptError = receiptSubmissionError(new Error(completed.error.message))
    } catch (error) {
      receiptError = receiptSubmissionError(error)
    } finally {
      this.store.update((state) => {
        const index = state.executing.indexOf(claim.taskId)
        if (index !== -1) state.executing.splice(index, 1)
      })
    }
    const dispatchError = receiptError ?? (status === 'failed' ? new AutomationProjectedError(message) : null)
    this.pollError = null
    this.store.update((state) => {
      state.notice = status === 'dispatched' && receiptAccepted
        ? `${claim.taskName} 已完成，结果已保存到企业空间`
        : null
      state.error = dispatchError?.message ?? null
    })
    return dispatchError
  }
}
