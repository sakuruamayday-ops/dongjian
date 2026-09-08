/** Default Agent model settings layered over a real settings provider. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig, {
  AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE,
  type AgentDefaultModelSettings,
} from '../src/index.ts'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function boot(): Promise<{
  ctx: Context
  settingsFiber: Context['fiber']
  defaultModel: AgentDefaultModelConfig
}> {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  await ctx.plugin(AgentDefaultModelConfig, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  return { ctx, settingsFiber, defaultModel: ctx.agentDefaultModel }
}

describe('AgentDefaultModelConfig', () => {
  it('attaches to an already-mounted settings provider when settings is a hard dependency', async () => {
    class RequiredSettingsDefaultModel extends AgentDefaultModelConfig {
      static inject = ['settings']
    }
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(RequiredSettingsDefaultModel, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    expect(ctx.settings.describe().map(row => row.ns)).toContain(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE)
    await ctx.fiber.dispose()
  })

  it('registers synchronously when a product requires persistent default-model settings', async () => {
    class StoredSettings extends MemorySettings {
      override doc: Record<string, unknown> = {
        [AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE]: {
          provider: 'custom-api',
          model: 'deepseek-v4-flash',
        },
      }
    }
    const ctx = new Context()
    await ctx.plugin(StoredSettings)
    await ctx.plugin(AgentDefaultModelConfig, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      requireSettings: true,
    })
    expect(ctx.settings.describe().map(row => row.ns)).toContain(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE)
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({
      provider: 'custom-api',
      model: 'deepseek-v4-flash',
    })
    await ctx.fiber.dispose()
  })

  it('uses the composition reasoning effort on a clean first launch', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(AgentDefaultModelConfig, {
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
      requireSettings: true,
    })
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    })
    await ctx.fiber.dispose()
  })

  it('resolves the user layer over the composition entry', async () => {
    const bench = await boot()
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })

    await bench.defaultModel.saveSelection({
      provider: 'acme-gateway', model: 'acme-large', reasoningEffort: ReasoningEffortId('high'),
    })
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'acme-gateway', model: 'acme-large', reasoningEffort: 'high',
    })
    await bench.ctx.fiber.dispose()
  })

  it('clears a stored effort when the saved selection has none', async () => {
    const bench = await boot()
    await bench.defaultModel.saveSelection({
      provider: 'acme-gateway', model: 'acme-large', reasoningEffort: ReasoningEffortId('high'),
    })
    await bench.defaultModel.saveSelection({ provider: 'acme-gateway', model: 'acme-plain' })
    expect(bench.defaultModel.currentSelection()).toEqual({ provider: 'acme-gateway', model: 'acme-plain' })
    expect((bench.settingsFiber.ctx.settings.get(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE) as AgentDefaultModelSettings)
      .reasoningEffort).toBeNull()
    await bench.ctx.fiber.dispose()
  })

  it('layers a hand-written partial section over the entry', async () => {
    const bench = await boot()
    await bench.settingsFiber.ctx.settings.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
      model: 'deepseek-reasoner',
    })
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-reasoner',
    })
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await boot()
    await bench.defaultModel.saveSelection({ provider: 'acme-gateway', model: 'acme-large' })
    expect(bench.defaultModel.currentSelection().provider).toBe('acme-gateway')
    await bench.settingsFiber.dispose()
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    await bench.ctx.fiber.dispose()
  })

  it('keeps the composition entry when no settings provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'p', model: 'm' })
    await ctx.agentDefaultModel.saveSelection({ provider: 'other', model: 'other' })
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'p', model: 'm' })
    await ctx.fiber.dispose()
  })
})
