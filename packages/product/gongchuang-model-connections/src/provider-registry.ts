/** Audited V0.4.0 provider surface shared by the Host and product renderer. */

export type GongchuangProviderProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'

/** Credential flow exposed by one approved provider connection. */
export type GongchuangProviderAuthKind = 'api-key' | 'optional-key' | 'custom'

/** Whether the provider endpoint is fixed, editable, or required from the user. */
export type GongchuangProviderBaseUrlMode = 'fixed' | 'optional' | 'required'

/** Audited connection metadata shared by the Host and renderer. */
export interface GongchuangProviderDefinition {
  readonly id: string
  readonly route: string
  readonly label: string
  readonly baseURL: string
  readonly baseURLMode: GongchuangProviderBaseUrlMode
  readonly api: GongchuangProviderProtocol
  readonly authKind: GongchuangProviderAuthKind
  readonly credentialEnv?: string
  readonly legacyCredentialEnvs?: readonly string[]
  readonly officialUrl?: string
  readonly keyPlaceholder: string
  readonly streamIdleTimeoutMs?: number
}

/**
 * Exact provider list approved for V0.4.0. Endpoint and credential names follow
 * the audited Hermes provider definitions; capability metadata intentionally
 * does not live here and remains owned by installed model adapters.
 */
export const GONGCHUANG_MODEL_PROVIDERS = Object.freeze([
  {
    id: 'fireworks', route: 'fireworks', label: 'Fireworks AI',
    baseURL: 'https://api.fireworks.ai/inference/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'FIREWORKS_API_KEY',
    officialUrl: 'https://app.fireworks.ai/settings/users/api-keys', keyPlaceholder: '粘贴 Fireworks AI 密钥',
  },
  {
    id: 'openrouter', route: 'openrouter', label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'OPENROUTER_API_KEY',
    officialUrl: 'https://openrouter.ai/keys', keyPlaceholder: '粘贴 OpenRouter 密钥',
  },
  {
    id: 'anthropic', route: 'anthropic', label: 'Anthropic',
    baseURL: 'https://api.anthropic.com', baseURLMode: 'fixed',
    api: 'anthropic-messages', authKind: 'api-key', credentialEnv: 'ANTHROPIC_API_KEY',
    officialUrl: 'https://console.anthropic.com/settings/keys', keyPlaceholder: '粘贴 Anthropic API Key',
  },
  {
    id: 'xai', route: 'xai', label: 'xAI',
    baseURL: 'https://api.x.ai/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'XAI_API_KEY',
    officialUrl: 'https://console.x.ai/', keyPlaceholder: '粘贴 xAI API Key',
  },
  {
    id: 'deepseek', route: 'deepseek-official', label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'DEEPSEEK_API_KEY',
    officialUrl: 'https://platform.deepseek.com/api_keys', keyPlaceholder: '粘贴 DeepSeek API Key',
  },
  {
    id: 'minimax', route: 'minimax', label: 'MiniMax',
    baseURL: 'https://api.minimax.io/anthropic', baseURLMode: 'fixed',
    api: 'anthropic-messages', authKind: 'api-key', credentialEnv: 'MINIMAX_API_KEY',
    officialUrl: 'https://platform.minimax.io/', keyPlaceholder: '粘贴 MiniMax 密钥',
  },
  {
    id: 'minimax-cn', route: 'minimax-cn', label: 'MiniMax (China)',
    baseURL: 'https://api.minimaxi.com/anthropic', baseURLMode: 'fixed',
    api: 'anthropic-messages', authKind: 'api-key', credentialEnv: 'MINIMAX_CN_API_KEY',
    officialUrl: 'https://platform.minimaxi.com/', keyPlaceholder: '粘贴 MiniMax China 密钥',
  },
  {
    id: 'opencode-zen', route: 'opencode-zen', label: 'OpenCode Zen',
    baseURL: 'https://opencode.ai/zen/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'OPENCODE_ZEN_API_KEY',
    officialUrl: 'https://opencode.ai/zen', keyPlaceholder: '粘贴 OpenCode Zen 密钥',
  },
  {
    id: 'opencode-go', route: 'opencode-go', label: 'OpenCode Go',
    baseURL: 'https://opencode.ai/zen/go/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'OPENCODE_GO_API_KEY',
    legacyCredentialEnvs: ['OPENCODE_API_KEY'], officialUrl: 'https://opencode.ai/zh/go',
    keyPlaceholder: '粘贴 OpenCode Go 密钥', streamIdleTimeoutMs: 120_000,
  },
  {
    id: 'nvidia', route: 'nvidia', label: 'NVIDIA NIM',
    baseURL: 'https://integrate.api.nvidia.com/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'NVIDIA_API_KEY',
    officialUrl: 'https://build.nvidia.com/', keyPlaceholder: '粘贴 NVIDIA NIM 密钥',
  },
  {
    id: 'ollama-cloud', route: 'ollama-cloud', label: 'Ollama Cloud',
    baseURL: 'https://ollama.com/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'OLLAMA_API_KEY',
    officialUrl: 'https://ollama.com/settings/keys', keyPlaceholder: '粘贴 Ollama Cloud 密钥',
  },
  {
    id: 'lmstudio', route: 'lmstudio', label: 'LM Studio',
    baseURL: 'http://127.0.0.1:1234/v1', baseURLMode: 'optional',
    api: 'openai-completions', authKind: 'optional-key', credentialEnv: 'LM_API_KEY',
    officialUrl: 'https://lmstudio.ai/', keyPlaceholder: '可选：粘贴 LM Studio 密钥',
  },
  {
    id: 'xiaomi', route: 'xiaomi', label: 'Xiaomi MiMo',
    baseURL: 'https://api.xiaomimimo.com/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'XIAOMI_API_KEY',
    officialUrl: 'https://platform.xiaomimimo.com/', keyPlaceholder: '粘贴 Xiaomi MiMo 密钥',
  },
  {
    id: 'arcee', route: 'arcee', label: 'Arcee AI',
    baseURL: 'https://api.arcee.ai/api/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'ARCEEAI_API_KEY',
    officialUrl: 'https://app.arcee.ai/', keyPlaceholder: '粘贴 Arcee AI 密钥',
  },
  {
    id: 'gmi', route: 'gmi', label: 'GMI Cloud',
    baseURL: 'https://api.gmi-serving.com/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'GMI_API_KEY',
    officialUrl: 'https://www.gmicloud.ai/', keyPlaceholder: '粘贴 GMI Cloud 密钥',
  },
  {
    id: 'azure-foundry', route: 'azure-foundry', label: 'Azure Foundry',
    baseURL: '', baseURLMode: 'required', api: 'openai-completions',
    authKind: 'api-key', credentialEnv: 'AZURE_FOUNDRY_API_KEY',
    officialUrl: 'https://ai.azure.com/', keyPlaceholder: '粘贴 Azure Foundry 密钥',
  },
  {
    id: 'actual', route: 'actual', label: 'Actual Computer',
    baseURL: 'https://api.actual.inc/v1', baseURLMode: 'optional',
    api: 'openai-completions', authKind: 'optional-key', credentialEnv: 'ACTUAL_API_KEY',
    officialUrl: 'https://actual.inc/', keyPlaceholder: '本机端点可不填；托管端点粘贴密钥',
  },
  {
    id: 'alibaba-coding-plan', route: 'alibaba-coding-plan', label: 'Alibaba Cloud (Coding Plan)',
    baseURL: 'https://coding-intl.dashscope.aliyuncs.com/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'ALIBABA_CODING_PLAN_API_KEY',
    officialUrl: 'https://www.alibabacloud.com/help/en/model-studio/', keyPlaceholder: '粘贴 Coding Plan 密钥',
  },
  {
    id: 'commandcode', route: 'commandcode', label: 'CommandCode',
    baseURL: 'https://api.commandcode.ai/provider/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'COMMANDCODE_API_KEY',
    officialUrl: 'https://commandcode.ai/studio/', keyPlaceholder: '粘贴 CommandCode 密钥',
  },
  {
    id: 'deepinfra', route: 'deepinfra', label: 'DeepInfra',
    baseURL: 'https://api.deepinfra.com/v1/openai', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'DEEPINFRA_API_KEY',
    officialUrl: 'https://deepinfra.com/dash/api_keys', keyPlaceholder: '粘贴 DeepInfra 密钥',
  },
  {
    id: 'gemini', route: 'gemini', label: 'Google AI Studio',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'GOOGLE_API_KEY',
    officialUrl: 'https://aistudio.google.com/app/apikey', keyPlaceholder: '粘贴 Google AI Studio 密钥',
  },
  {
    id: 'huggingface', route: 'huggingface', label: 'HuggingFace',
    baseURL: 'https://router.huggingface.co/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'HF_TOKEN',
    officialUrl: 'https://huggingface.co/settings/tokens', keyPlaceholder: '粘贴 HuggingFace Token',
  },
  {
    id: 'kilocode', route: 'kilocode', label: 'Kilo Code',
    baseURL: 'https://api.kilo.ai/api/gateway', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'KILOCODE_API_KEY',
    officialUrl: 'https://app.kilo.ai/', keyPlaceholder: '粘贴 Kilo Code 密钥',
  },
  {
    id: 'kimi-coding', route: 'kimi-coding', label: 'Kimi / Kimi Coding Plan',
    baseURL: 'https://api.moonshot.ai/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'KIMI_API_KEY',
    officialUrl: 'https://platform.moonshot.ai/console/api-keys', keyPlaceholder: '粘贴 Kimi 或 Kimi Coding Plan 密钥',
  },
  {
    id: 'kimi-coding-cn', route: 'kimi-coding-cn', label: 'Kimi / Moonshot (China)',
    baseURL: 'https://api.moonshot.cn/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'KIMI_CN_API_KEY',
    officialUrl: 'https://platform.moonshot.cn/console/api-keys', keyPlaceholder: '粘贴 Moonshot China 密钥',
  },
  {
    id: 'meta-ai', route: 'meta-ai', label: 'Meta Model API',
    baseURL: 'https://api.meta.ai/v1', baseURLMode: 'fixed',
    api: 'openai-responses', authKind: 'api-key', credentialEnv: 'MODEL_API_KEY',
    officialUrl: 'https://developer.meta.com/ai/', keyPlaceholder: '粘贴 Meta Model API 密钥',
  },
  {
    id: 'novita', route: 'novita', label: 'NovitaAI',
    baseURL: 'https://api.novita.ai/openai/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'NOVITA_API_KEY',
    officialUrl: 'https://novita.ai/settings/key-management', keyPlaceholder: '粘贴 NovitaAI 密钥',
  },
  {
    id: 'openai-api', route: 'openai-api', label: 'OpenAI API',
    baseURL: 'https://api.openai.com/v1', baseURLMode: 'fixed',
    api: 'openai-responses', authKind: 'api-key', credentialEnv: 'OPENAI_API_KEY',
    officialUrl: 'https://platform.openai.com/api-keys', keyPlaceholder: '粘贴 OpenAI API Key',
  },
  {
    id: 'alibaba', route: 'alibaba', label: 'Qwen Cloud',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'DASHSCOPE_API_KEY',
    officialUrl: 'https://www.alibabacloud.com/help/en/model-studio/', keyPlaceholder: '粘贴 Qwen Cloud 密钥',
  },
  {
    id: 'stepfun', route: 'stepfun', label: 'StepFun Step Plan',
    baseURL: 'https://api.stepfun.ai/step_plan/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'STEPFUN_API_KEY',
    officialUrl: 'https://platform.stepfun.com/', keyPlaceholder: '粘贴 StepFun Step Plan 密钥',
  },
  {
    id: 'tencent-tokenhub', route: 'tencent-tokenhub', label: 'Tencent TokenHub',
    baseURL: 'https://tokenhub.tencentmaas.com/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'TOKENHUB_API_KEY',
    officialUrl: 'https://cloud.tencent.com/', keyPlaceholder: '粘贴 Tencent TokenHub 密钥',
  },
  {
    id: 'upstage', route: 'upstage', label: 'Upstage Solar',
    baseURL: 'https://api.upstage.ai/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'UPSTAGE_API_KEY',
    officialUrl: 'https://console.upstage.ai/api-keys', keyPlaceholder: '粘贴 Upstage Solar 密钥',
  },
  {
    id: 'ai-gateway', route: 'ai-gateway', label: 'Vercel AI Gateway',
    baseURL: 'https://ai-gateway.vercel.sh/v1', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'AI_GATEWAY_API_KEY',
    officialUrl: 'https://vercel.com/ai-gateway', keyPlaceholder: '粘贴 Vercel AI Gateway 密钥',
  },
  {
    id: 'zai', route: 'zai', label: 'Z.AI (GLM)',
    baseURL: 'https://api.z.ai/api/paas/v4', baseURLMode: 'fixed',
    api: 'openai-completions', authKind: 'api-key', credentialEnv: 'GLM_API_KEY',
    officialUrl: 'https://z.ai/manage-apikey/apikey-list', keyPlaceholder: '粘贴 Z.AI API Key',
  },
  {
    id: 'custom', route: 'custom-api', label: '本地 / 自定义端点',
    baseURL: '', baseURLMode: 'required', api: 'openai-completions',
    authKind: 'custom', keyPlaceholder: '可选：粘贴兼容服务密钥',
  },
] as const satisfies readonly GongchuangProviderDefinition[])

/** Provider identifiers in the exact V0.4.0 product surface. */
export type GongchuangModelProvider = typeof GONGCHUANG_MODEL_PROVIDERS[number]['id']

const PROVIDER_BY_ID = new Map<GongchuangModelProvider, GongchuangProviderDefinition>(
  GONGCHUANG_MODEL_PROVIDERS.map(provider => [provider.id, provider]),
)

/** Resolve one approved provider id without accepting arbitrary renderer input.
 * @param provider - Approved provider identifier.
 * @returns Immutable connection metadata for the provider.
 */
export function gongchuangProviderDefinition(provider: GongchuangModelProvider): GongchuangProviderDefinition {
  const definition = PROVIDER_BY_ID.get(provider)
  if (definition === undefined) throw new Error(`Unknown Gongchuang model provider: ${provider}`)
  return definition
}

/** Runtime guard used when reading persisted pre-V0.4.0 UI state.
 * @param value - Untrusted value loaded from device-local state.
 * @returns Whether the value is an approved provider identifier.
 */
export function isGongchuangModelProvider(value: unknown): value is GongchuangModelProvider {
  return typeof value === 'string' && PROVIDER_BY_ID.has(value as GongchuangModelProvider)
}
