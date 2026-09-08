/** Local preferences service for the independently installed desktop product. */
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { PersonalizationStore, personalizationTool } from './personalization.ts'
import type {
  GongchuangAccountDisconnectRequest, GongchuangAccountLoginRequest, GongchuangAccountSnapshot,
  GongchuangPersonalizationSaveRequest, GongchuangPersonalizationSnapshot,
} from './types.ts'

export type * from './types.ts'

/** Local-only service settings. No account endpoint or device admission is used. */
export interface Config {}

/** Retains the preferences Remote used by the product without a network account. */
export class GongchuangAccountService extends TypertRemoteService {
  static inject = ['tools']
  static Config: s<Config> = s.object({})
  private readonly preferences = new PersonalizationStore(join(resolveDshHome(), 'AGENTS.md'))
  private readonly current: GongchuangAccountSnapshot = Object.freeze({
    revision: 0, phase: 'local', portalUrl: '', username: null,
    message: '', hasSavedPassword: false, autoLoginBlocked: false,
    singleDevice: false, clientCompatibility: null, minimumSupportedVersion: null,
  })

  constructor(ctx: Context, public config: Config) { super(ctx, 'gongchuangAccount') }

  protected [Service.init](): void {
    this.ctx.effect(() => this.ctx.tools.register(personalizationTool(this.preferences)), 'local preferences tool')
    const ready = this.preferences.initialize()
    const stop = this.ctx.on('agent/pre-step', async (_payload, next) => {
      await ready
      return next()
    }, { prepend: true })
    this.ctx.effect(() => async () => {
      stop()
      await ready
      await this.preferences.settle()
    }, 'local preferences settlement')
  }

  /** Return local usage state without contacting an account service. */
  @Remote('snapshot')
  snapshot(): GongchuangAccountSnapshot { return this.current }

  /** Refresh the local usage projection without credential or network access. */
  @Remote('refresh')
  refresh(): Promise<GongchuangAccountSnapshot> { return Promise.resolve(this.current) }

  /** Reject obsolete login requests; this product has no account login. */
  @Remote('login')
  login(_request: GongchuangAccountLoginRequest): Promise<GongchuangAccountSnapshot> {
    return Promise.reject(new Error('本客户端无需登录，请在模型与连接中配置服务。'))
  }

  /** Local usage has no remote session or saved account credentials to revoke. */
  @Remote('disconnect')
  disconnect(_request: GongchuangAccountDisconnectRequest): Promise<GongchuangAccountSnapshot> {
    return Promise.resolve(this.current)
  }

  /** Read locally stored personalization text. */
  @Remote('personalization')
  personalization(): Promise<GongchuangPersonalizationSnapshot> { return this.preferences.read() }

  /** Persist the user's local personalization text. */
  @Remote('savePersonalization')
  savePersonalization(request: GongchuangPersonalizationSaveRequest): Promise<GongchuangPersonalizationSnapshot> {
    return this.preferences.save(request.instructions)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { gongchuangAccount: GongchuangAccountService }
}
export default GongchuangAccountService
