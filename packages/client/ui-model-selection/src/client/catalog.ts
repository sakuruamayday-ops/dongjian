/** One Host-generation model catalog shared by every Session selector. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Observable lifecycle of the shared model catalog. */
export interface ModelCatalogState {
  value: ModelCatalog | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
}

/** Loads at most one model catalog for the current Host generation. */
export class ModelCatalogDirectory {
  /** Current shared catalog value and load lifecycle. */
  readonly store: SnapshotStore<ModelCatalogState> = createSnapshotStore({
    value: null,
    status: 'idle',
    error: null,
  })

  private generation = 0
  private inflight: Promise<ModelCatalog> | undefined
  private clearSelections = false

  /**
   * @param ctx - the providing plugin's context, whose `remote.session`
   * namespace carries the Host-generation catalog.
   */
  constructor(private readonly ctx: ClientContext) {}

  /**
   * Return the current generation's catalog, sharing its one in-flight load.
   * @returns the loaded global catalog.
   */
  load(): Promise<ModelCatalog> {
    const state = this.store.getSnapshot()
    if (state.status === 'ready' && state.value !== null) return Promise.resolve(state.value)
    if (this.inflight !== undefined) return this.inflight
    const generation = this.generation
    this.store.update((draft) => {
      draft.status = 'loading'
      draft.error = null
    })
    const operation = this.ctx.remote.session.modelCatalog().then((response) => {
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      if (generation === this.generation) {
        this.store.set({ value: response.value, status: 'ready', error: null })
      }
      return response.value
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.store.update((draft) => {
          draft.status = 'error'
          draft.error = error instanceof Error ? error.message : String(error)
        })
      }
      throw error
    }).finally(() => {
      if (generation === this.generation && this.inflight === operation) this.inflight = undefined
    })
    this.inflight = operation
    return operation
  }

  /**
   * Invalidate the loaded catalog; the next explicit menu read reloads it.
   * @param clear - whether values from the previous Host generation must be hidden.
   */
  private invalidate(clear = false): void {
    this.generation += 1
    this.inflight = undefined
    const value = clear ? null : this.store.getSnapshot().value
    this.store.set({ value, status: 'idle', error: null })
  }

  /**
   * Invalidate and await one replacement catalog read while retaining the last
   * complete value until the replacement settles.
   * @returns the replacement Host-generation catalog.
   */
  reload(): Promise<ModelCatalog> {
    this.invalidate()
    return this.load()
  }

  /** Start the destructive view of an explicit user refresh. */
  beginExplicitReload(): void {
    this.clearSelections = true
    this.invalidate(true)
  }

  /**
   * Whether Session directories must hide every previously advertised row.
   * @returns true while an explicit refresh result remains unavailable.
   */
  selectionsCleared(): boolean {
    return this.clearSelections
  }

  /**
   * Publish a recoverable explicit-refresh failure without restoring stale rows.
   * @param error - the provider refresh or replacement catalog read failure.
   */
  failExplicitReload(error: unknown): void {
    this.clearSelections = true
    this.generation += 1
    this.inflight = undefined
    this.store.set({
      value: null,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
  }

  /** Reveal the freshly validated catalog after an explicit reload succeeds. */
  completeExplicitReload(): void {
    this.clearSelections = false
    this.store.set({ ...this.store.getSnapshot() })
  }

  /** Invalidate and reload the catalog after a Host-side model input changes. */
  refresh(): void {
    // An explicit user refresh failure is authoritative until that action is
    // retried. Background change events must not repopulate the rows from a
    // catalog that the failed refresh could not validate.
    if (this.clearSelections) return
    void this.reload().catch(() => { /* the selector exposes the shared error */ })
  }

  /** Reset Host-generation requests without overriding an explicit-refresh result. */
  resetGeneration(): void {
    const clearedState = this.clearSelections ? this.store.getSnapshot() : undefined
    this.invalidate(true)
    if (clearedState !== undefined) {
      // A connection reset invalidates old requests, but cannot turn an
      // ordinary catalog read into the complete provider refresh the user retried.
      this.store.set({ value: null, status: clearedState.status, error: clearedState.error })
      return
    }
    void this.load().catch(() => { /* the selector exposes the shared error */ })
  }
}
