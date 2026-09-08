import { describe, expect, it } from 'vitest'
import { GONGCHUANG_MODEL_PROVIDERS, isGongchuangModelProvider } from '../src/provider-registry.ts'

const APPROVED_LABELS = [
  'Fireworks AI',
  'OpenRouter',
  'Anthropic',
  'xAI',
  'DeepSeek',
  'MiniMax',
  'MiniMax (China)',
  'OpenCode Zen',
  'OpenCode Go',
  'NVIDIA NIM',
  'Ollama Cloud',
  'LM Studio',
  'Xiaomi MiMo',
  'Arcee AI',
  'GMI Cloud',
  'Azure Foundry',
  'Actual Computer',
  'Alibaba Cloud (Coding Plan)',
  'CommandCode',
  'DeepInfra',
  'Google AI Studio',
  'HuggingFace',
  'Kilo Code',
  'Kimi / Kimi Coding Plan',
  'Kimi / Moonshot (China)',
  'Meta Model API',
  'NovitaAI',
  'OpenAI API',
  'Qwen Cloud',
  'StepFun Step Plan',
  'Tencent TokenHub',
  'Upstage Solar',
  'Vercel AI Gateway',
  'Z.AI (GLM)',
  '本地 / 自定义端点',
] as const

describe('approved model-provider registry', () => {
  it('contains only the user-approved Hermes rows in screenshot order', () => {
    expect(GONGCHUANG_MODEL_PROVIDERS.map(provider => provider.label)).toEqual(APPROVED_LABELS)
    expect(new Set(GONGCHUANG_MODEL_PROVIDERS.map(provider => provider.id)).size).toBe(APPROVED_LABELS.length)
    expect(new Set(GONGCHUANG_MODEL_PROVIDERS.map(provider => provider.route)).size).toBe(APPROVED_LABELS.length)
    expect(GONGCHUANG_MODEL_PROVIDERS.map(provider => provider.id)).not.toEqual(
      expect.arrayContaining(['siliconflow', 'orgarid', 'opencode']),
    )
  })

  it('removes Copilot from both the renderer list and persisted provider selection', () => {
    expect(isGongchuangModelProvider('copilot')).toBe(false)
    expect(GONGCHUANG_MODEL_PROVIDERS.map(provider => provider.label)).not.toContain('GitHub Copilot')
  })
})
