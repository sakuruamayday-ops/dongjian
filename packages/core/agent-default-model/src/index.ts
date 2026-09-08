/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Settings namespace carrying the default model selection for future Agents. */
export const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = 'agent-default-model'

/** Stored and composed default model selection. */
export interface AgentDefaultModelSettings {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string | null
}

/** Schema of the default Agent model settings section. */
export const AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA: z<AgentDefaultModelSettings> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.union([z.string(), z.const(null)]),
})

/** Composition entry for the default model selection. */
export interface Config {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort used on a clean first launch. */
  reasoningEffort?: string
  /** Fail startup unless the settings namespace can be registered synchronously. */
  requireSettings?: boolean
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: AgentDefaultModelSettings): ModelSelection {
  return {
    provider: settings.provider,
    model: settings.model,
    ...typeof settings.reasoningEffort !== 'string'
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

/**
 * Owns the default model selection independently of any Host or transport.
 * The composition entry remains usable without a settings provider; when one
 * is mounted, its user layer is read live.
 */
export class AgentDefaultModelConfig extends Service {
  static Config: z<Config> = z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
    requireSettings: z.boolean().default(false),
  })

  private source: () => AgentDefaultModelSettings
  private readonly entry: AgentDefaultModelSettings
  private readonly requireSettings: boolean

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentDefaultModel')
    this.entry = {
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    }
    this.requireSettings = config.requireSettings === true
    this.source = () => this.entry
    if (this.requireSettings) return
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA, this.entry, {
        setSource: (current) => { this.source = current },
        // Every consumer reads through currentSelection(), so no registration-level fact
        // needs rebuilding when the settings document changes.
        onChange: () => {},
      })
    })
  }

  protected [Service.init](): void {
    if (!this.requireSettings) return
    const settings = this.ctx.get('settings')
    if (settings === undefined) {
      throw new Error('agent-default-model: required settings service is unavailable')
    }
    const scope = settings.register(
      AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE,
      AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA,
      { base: this.entry, owner: this.ctx },
    )
    this.source = () => scope.get()
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(): ModelSelection {
    return selection(this.source())
  }

  /**
   * Save the complete default model selection. A deployment without a settings
   * provider keeps its composition entry.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional settings write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    await this.ctx.get('settings')?.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
      provider: next.provider,
      model: next.model,
      reasoningEffort: next.reasoningEffort === undefined ? null : String(next.reasoningEffort),
    })
  }
}

export default AgentDefaultModelConfig
