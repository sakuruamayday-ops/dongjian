import type {
  ClientRemote,
  GongchuangConnectorConfigureRequest,
  GongchuangConnectorEnableRequest,
  GongchuangConnectorAuthorizationStart,
  GongchuangConnectorSnapshot,
  GongchuangCustomMcpRemoveRequest,
  GongchuangCustomMcpUpsertRequest,
  GongchuangRegionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { gongchuangUserError } from '@gongchuang/user-errors'

/** Browser state for fixed trusted connector snapshots. */
export interface ConnectorState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot: GongchuangConnectorSnapshot
  error: string | null
}

/** Public Tianyancha Device Flow fields safe for the renderer. */
export type TianyanchaAuthorizationStart = GongchuangConnectorAuthorizationStart & {
  readonly id: 'tianyancha'
  readonly userCode: string
}

const EMPTY_SNAPSHOT: GongchuangConnectorSnapshot = Object.freeze({
  revision: 0,
  region: 'all',
  regionConfirmed: false,
  connectors: Object.freeze([]),
})

function initialState(): ConnectorState {
  return { status: 'idle', snapshot: EMPTY_SNAPSHOT, error: null }
}

type ConnectorRemote = ClientRemote['gongchuangConnectors']

interface AuthorizationAttempt {
  readonly transactionId: string
  readonly controller: AbortController
  busy: boolean
  cancellation?: Promise<void>
}

/** Browser-side projection of the trusted Host connector manager. */
export class ConnectorController {
  /** Observable connector state consumed by the Skills center. */
  readonly store: SnapshotStore<ConnectorState> = createSnapshotStore(initialState())
  private generation = 0
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly authorizing = new Map<'qcc' | 'tianyancha', AuthorizationAttempt>()

  constructor(private readonly remote: ConnectorRemote) {}

  /**
   * Reload every fixed connector from the trusted Host.
   * @returns once the latest snapshot or failure is published.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    try {
      const result = await this.remote.list()
      if (!result.ok) throw new Error(result.error.message)
      if (generation !== this.generation) return
      this.publish(result.value)
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'error'
        state.error = gongchuangUserError(error, 'product').text
      })
    }
  }

  /**
   * Enable or disable one connector and verify readiness when enabling.
   * @param request - connector identity and desired state.
   * @returns once the serialized mutation completes.
   */
  async setEnabled(request: GongchuangConnectorEnableRequest): Promise<void> {
    if (request.id === 'qcc' || request.id === 'tianyancha') await this.cancelAuthorization(request.id)
    await this.mutate(() => this.remote.setEnabled(request), request.enabled ? request.id : undefined, request.id)
  }

  /**
   * Store one connector credential and require a verified ready result.
   * @param request - connector identity and secret value.
   * @returns once configuration and connection verification complete.
   */
  async configure(request: GongchuangConnectorConfigureRequest): Promise<void> {
    if (request.id === 'qcc' || request.id === 'tianyancha') await this.cancelAuthorization(request.id)
    await this.mutate(() => this.remote.configure(request), request.id)
  }

  /** Create or edit a user-owned MCP and publish its real connection result.
   * @param request - The request value.
   */
  upsertCustom(request: GongchuangCustomMcpUpsertRequest): Promise<void> {
    return this.mutate(() => this.remote.upsertCustom(request))
  }

  /** Remove a user-owned MCP and its Host-owned credential.
   * @param request - The request value.
   */
  removeCustom(request: GongchuangCustomMcpRemoveRequest): Promise<void> {
    return this.mutate(() => this.remote.removeCustom(request))
  }

  /** Complete an official browser authorization while all tokens remain Host-owned.
   * @param openAuthorizationUrl - The open authorization url value.
   */
  authorizeQcc(openAuthorizationUrl: (url: string) => void): Promise<void> {
    return this.authorization('qcc', async (attempt) => {
      this.store.update((state) => {
        state.status = 'loading'
        state.error = null
      })
      const started = await this.remote.beginAuthorization({ id: 'qcc', transactionId: attempt.transactionId })
      attempt.controller.signal.throwIfAborted()
      if (!started.ok) throw new Error(started.error.message)
      openAuthorizationUrl(started.value.authorizationUrl)
      const result = await this.remote.completeAuthorization({
        id: 'qcc', transactionId: started.value.transactionId,
      })
      attempt.controller.signal.throwIfAborted()
      if (!result.ok) throw new Error(result.error.message)
      this.generation += 1
      this.publish(result.value)
      const connector = result.value.connectors.find(row => row.id === 'qcc')
      if (connector?.phase !== 'ready' || connector.toolCount < 1) {
        throw new Error(`企查查 MCP 未通过连接验证：${connector?.message ?? '没有发现可用工具'}`)
      }
    })
  }

  /** Start Tianyancha Device Flow and open its official authorization page.
   * @param openAuthorizationUrl - Opens the official browser page.
   * @returns Public device-code fields; tokens stay in the Host.
   */
  beginTianyanchaAuthorization(
    openAuthorizationUrl: (url: string) => void,
  ): Promise<TianyanchaAuthorizationStart> {
    return this.authorization('tianyancha', async (attempt) => {
      this.store.update((state) => {
        state.status = 'loading'
        state.error = null
      })
      const started = await this.remote.beginAuthorization({ id: 'tianyancha', transactionId: attempt.transactionId })
      attempt.controller.signal.throwIfAborted()
      if (!started.ok) throw new Error(started.error.message)
      if (started.value.id !== 'tianyancha' || started.value.userCode === undefined) {
        throw new Error('天眼查设备授权未返回授权码，请重新发起')
      }
      openAuthorizationUrl(started.value.authorizationUrl)
      this.store.update((state) => {
        state.status = 'ready'
        state.error = null
      })
      return Object.freeze({ ...started.value, id: 'tianyancha' as const, userCode: started.value.userCode })
    }, { keepPending: true })
  }

  /** Complete Tianyancha Device Flow after the user confirms the official page.
   * @param transactionId - Opaque Host transaction returned by the start call.
   * @returns once Host token storage and tools/list verification finish.
   */
  completeTianyanchaAuthorization(transactionId: string): Promise<void> {
    return this.authorization('tianyancha', async (attempt) => {
      const result = await this.remote.completeAuthorization({ id: 'tianyancha', transactionId })
      attempt.controller.signal.throwIfAborted()
      if (!result.ok) throw new Error(result.error.message)
      this.generation += 1
      this.publish(result.value)
      const connector = result.value.connectors.find(row => row.id === 'tianyancha')
      if (connector?.phase !== 'ready' || connector.toolCount < 1) {
        throw new Error(`天眼查 MCP 未通过连接验证：${connector?.message ?? '没有发现可用工具'}`)
      }
    }, { transactionId })
  }

  /** Stop this attempt, preserve saved credentials, and ignore its late responses.
   * @param id - The connector whose authorization dialog is closing.
   * @returns once the Host has cancelled the attempt and restored any pending writes.
   */
  async cancelAuthorization(id: 'qcc' | 'tianyancha'): Promise<void> {
    const attempt = this.authorizing.get(id)
    if (attempt === undefined) return
    if (attempt.cancellation !== undefined) {
      await attempt.cancellation
      return
    }
    attempt.controller.abort(new Error('授权已取消'))
    attempt.cancellation = (async () => {
      const result = await this.remote.cancelAuthorization({ id, transactionId: attempt.transactionId })
      if (!result.ok) throw new Error(result.error.message)
      this.publish(result.value)
      if (this.authorizing.get(id) === attempt) this.authorizing.delete(id)
    })()
    try {
      await attempt.cancellation
    } catch (error) {
      // 未收到取消回执时保留事务，但允许重试同一取消请求，不能永久锁住连接器。
      delete attempt.cancellation
      this.store.update((state) => {
        state.status = 'error'
        state.error = gongchuangUserError(error, 'product').text
      })
      throw error
    }
  }

  /** Persist and immediately apply the default knowledge-search region.
   * @param region - The region selected from the current Host snapshot.
   */
  setRegion(region: GongchuangRegionId): Promise<void> {
    const expected = this.store.getSnapshot().snapshot
    return this.mutate(() => this.remote.setRegion({
      region,
      confirmed: true,
      expectedRegion: expected.region,
      expectedConfirmed: expected.regionConfirmed,
    }))
  }

  /**
   * Reconnect and rediscover all enabled connectors.
   * @returns once the serialized refresh completes.
   */
  refresh(): Promise<void> {
    return this.mutate(() => this.remote.refresh())
  }

  private mutate(
    operation: () => ReturnType<ConnectorRemote['list']>,
    expectedReady?: GongchuangConnectorEnableRequest['id'],
    connectorId = expectedReady,
  ): Promise<void> {
    if ((connectorId === 'qcc' || connectorId === 'tianyancha') && this.authorizing.has(connectorId)) {
      return Promise.reject(new Error('该连接器正在授权，请等待本次授权结束'))
    }
    const task = this.mutationTail.then(async () => {
      this.store.update((state) => {
        state.status = 'loading'
        state.error = null
      })
      const result = await operation()
      if (!result.ok) throw new Error(result.error.message)
      this.generation += 1
      this.publish(result.value)
      if (expectedReady !== undefined) {
        const connector = result.value.connectors.find(row => row.id === expectedReady)
        if (connector?.phase !== 'ready' || connector.toolCount < 1) {
          throw new Error(`${connector?.name ?? expectedReady} 未通过连接验证：${connector?.message ?? '没有发现可用工具'}`)
        }
      }
    })
    this.mutationTail = task.catch((error: unknown) => {
      this.store.update((state) => {
        state.status = 'error'
        state.error = gongchuangUserError(error, 'product').text
      })
    })
    return task
  }

  private async authorization<T>(
    id: 'qcc' | 'tianyancha',
    operation: (attempt: AuthorizationAttempt) => Promise<T>,
    options: { transactionId?: string; keepPending?: boolean } = {},
  ): Promise<T> {
    const previous = this.authorizing.get(id)
    if (previous !== undefined && (previous.controller.signal.aborted
      || (!previous.busy && options.transactionId === undefined))) await this.cancelAuthorization(id)
    const pending = this.authorizing.get(id)
    if (pending !== undefined && (pending.busy || pending.transactionId !== options.transactionId)) {
      throw new Error('该连接器正在授权，请勿重复发起')
    }
    const attempt = pending ?? {
      transactionId: options.transactionId ?? randomUUID(), controller: new AbortController(), busy: false,
    }
    attempt.busy = true
    this.authorizing.set(id, attempt)
    let succeeded = false
    try {
      // Browser approval can take minutes; only earlier writes are awaited.
      // Other connectors must not queue behind a human authorization decision.
      await this.mutationTail
      attempt.controller.signal.throwIfAborted()
      const result = await operation(attempt)
      succeeded = true
      return result
    } catch (error) {
      if (!attempt.controller.signal.aborted) {
        this.store.update((state) => {
          state.status = 'error'
          state.error = gongchuangUserError(error, 'product').text
        })
      }
      throw error
    } finally {
      attempt.busy = false
      const retain = succeeded ? options.keepPending : options.transactionId !== undefined
      if (!attempt.controller.signal.aborted && attempt.cancellation === undefined && !retain
        && this.authorizing.get(id) === attempt) this.authorizing.delete(id)
    }
  }

  private publish(snapshot: GongchuangConnectorSnapshot): void {
    this.store.update((state) => {
      if (snapshot.revision < state.snapshot.revision) return
      state.status = 'ready'
      state.snapshot = snapshot
      state.error = null
    })
  }
}
