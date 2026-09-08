/** Client-safe model-connection requests and redacted verification receipts. */

import type { GongchuangModelProvider, GongchuangProviderProtocol } from './provider-registry.ts'

export type { GongchuangModelProvider } from './provider-registry.ts'
/** Redacted verification lifecycle exposed to the renderer. */
export type GongchuangModelConnectionPhase = 'missing' | 'checking' | 'candidate' | 'ready' | 'error'
/** Machine-readable refresh failure class used to decide whether the current model may still be tried. */
export type GongchuangModelDirectoryFailureKind = 'auth' | 'transient' | 'catalog'
/** Wire protocols the installed pi-ai adapter can construct for a configured endpoint. */
export type GongchuangCustomApiProtocol = GongchuangProviderProtocol

/** One provider connection state. No API key or credential reference is exposed. */
export interface GongchuangModelConnectionView {
  readonly provider: GongchuangModelProvider
  readonly route: string
  readonly phase: GongchuangModelConnectionPhase
  readonly configured: boolean
  readonly verifiedAt: string | null
  readonly modelCount: number
  readonly selectedModel: string | null
  readonly message: string
  readonly failureKind?: GongchuangModelDirectoryFailureKind
  /** Saved editable fields; secrets and credential references never reach the renderer. */
  readonly configuration?: {
    readonly displayName: string
    readonly baseURL: string
    readonly protocol: GongchuangProviderProtocol
    readonly modelId: string
  }
}

/** Complete redacted state of the product model choices. */
export interface GongchuangModelConnectionsSnapshot {
  readonly revision: number
  readonly providers: Readonly<Record<GongchuangModelProvider, GongchuangModelConnectionView>>
}

/** Configure one approved provider after its real endpoint or authorization probe. */
export interface GongchuangOfficialModelConfigureRequest {
  readonly provider: Exclude<GongchuangModelProvider, 'custom'>
  /** Optional only for registry entries that explicitly support a keyless local endpoint. */
  readonly apiKey?: string
  /** Required for user-owned endpoints and accepted only where the registry allows an override. */
  readonly baseURL?: string
  /** Exact id used when a provider does not expose a compatible models directory. */
  readonly modelId?: string
}

/** Configure the single OpenAI-compatible custom route. */
export interface GongchuangCustomModelConfigureRequest {
  readonly provider: 'custom'
  readonly apiKey?: string
  readonly displayName: string
  readonly baseURL: string
  readonly protocol: GongchuangCustomApiProtocol
  /** Optional exact id; required when the endpoint does not implement `GET /models`. */
  readonly modelId?: string
}

/** Closed configuration request union for product presets and one user route. */
export type GongchuangModelConfigureRequest =
  | GongchuangOfficialModelConfigureRequest
  | GongchuangCustomModelConfigureRequest

/** Request an authenticated re-check using the stored OS-keychain credential. */
export interface GongchuangModelRefreshRequest {
  readonly provider?: GongchuangModelProvider
}

/** Product choices for DeepSeek's provider-owned remote image lifetime. */
export type GongchuangDeepSeekFileRetentionSeconds = 3_600 | 604_800 | 2_592_000

/** Redacted DeepSeek Files settings shown only inside the model-connection entry. */
export interface GongchuangDeepSeekFilesView {
  readonly retentionSeconds: number
  readonly retentionOptions: readonly GongchuangDeepSeekFileRetentionSeconds[]
}

/** Change the lifetime assigned to future DeepSeek image uploads. */
export interface GongchuangDeepSeekFileRetentionRequest {
  readonly retentionSeconds: GongchuangDeepSeekFileRetentionSeconds
}

/** Receipt for an explicit remote-file and local-mapping cleanup. */
export interface GongchuangDeepSeekFilesCleanupReceipt {
  readonly deletedRemoteFiles: number
  readonly clearedAt: string
}
