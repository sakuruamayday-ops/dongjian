import type {
  ClientRemote, GongchuangGraphMemoryConfigureRequest, GongchuangGraphMemorySnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'

type GraphMemoryRemote = ClientRemote['gongchuangGraphMemory']

/** Renderer adapter for the Host-owned local graph-memory controls. */
export class GraphMemoryController {
  constructor(private readonly remote: GraphMemoryRemote) {}

  /** Read aggregate local-memory status without exposing stored content.
   * @returns The snapshot result.
   */
  async snapshot(): Promise<GongchuangGraphMemorySnapshot> {
    const result = await this.remote.snapshot()
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  /** Persist and immediately apply both user-controlled memory preferences.
   * @param request - The request value.
   * @returns The configure result.
   */
  async configure(request: GongchuangGraphMemoryConfigureRequest): Promise<GongchuangGraphMemorySnapshot> {
    const result = await this.remote.configure(request)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  /** Clear every personal and enterprise memory graph on this device.
   * @returns The clear all result.
   */
  async clearAll(): Promise<GongchuangGraphMemorySnapshot> {
    const result = await this.remote.clearAll()
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
}
