/** Client-safe connector status and mutation vocabulary. */

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The redacted connector snapshot changed. Consumers must re-read the
     * snapshot rather than retaining a stale ready state.
     * @param revision Monotonic snapshot revision available after the change.
     * @mode emit
     */
    'gongchuang-connectors/changed'(revision: number): void
  }
}

/**
 * Type contract for gongchuang built in connector id.
 */
export type GongchuangBuiltInConnectorId =
  | 'gongchuang-search'
  | 'gongchuang-knowledge'
  | 'qcc'
  | 'tianyancha'
  | 'paddle-ocr'

/**
 * Stable identity assigned by the Host to a user-added MCP server.
 * The Remote wire type stays a plain string because Typert must emit a
 * concrete Zod codec; the Host enforces `custom-` plus twelve hexadecimal
 * characters before accepting or persisting it.
 */
export type GongchuangCustomConnectorId = string

/** Built-in and user-added MCP identities shown in one connection center. */
export type GongchuangConnectorId = string

/** Transport families the bundled MCP client can execute on both desktop platforms. */
export type GongchuangCustomMcpTransport = 'streamable-http' | 'stdio'

/** Credential placement for one user-added MCP. Secrets never enter settings or snapshots. */
export type GongchuangCustomMcpAuthMode = 'none' | 'bearer' | 'header' | 'env'

/** Default geographic scope applied by the trusted knowledge connector. */
export type GongchuangRegionId = 'all' | 'hangzhou' | 'shaoxing' | 'jinhua' | 'ningbo'

/** First-run or later region preference mutation based on the last Host snapshot shown to the user. */
export interface GongchuangRegionSetRequest {
  readonly region: GongchuangRegionId
  readonly confirmed: boolean
  readonly expectedRegion: GongchuangRegionId
  readonly expectedConfirmed: boolean
}

/** User-visible lifecycle state for one connector. */
export type GongchuangConnectorPhase =
  | 'disabled'
  | 'missing-credential'
  | 'connecting'
  | 'ready'
  | 'error'
  | 'unavailable'

/** One client-safe tool exposed by a connector, without arguments or secrets. */
export interface GongchuangConnectorToolView {
  readonly name: string
  readonly description: string
}

/** Redacted connector state safe to expose to an authenticated renderer. */
export interface GongchuangConnectorView {
  readonly id: GongchuangConnectorId
  readonly name: string
  readonly phase: GongchuangConnectorPhase
  readonly enabled: boolean
  readonly credentialConfigured: boolean
  readonly credentialWritable: boolean
  readonly officialConfigUrl: string
  readonly toolCount: number
  readonly tools: readonly GongchuangConnectorToolView[]
  readonly verificationMethod: string
  readonly lastVerifiedAt: string | null
  readonly partial: boolean
  readonly message: string
  readonly custom: boolean
  readonly transport: GongchuangCustomMcpTransport | null
  readonly endpoint: string
  readonly arguments: readonly string[]
  readonly cwd: string
  readonly authMode: GongchuangCustomMcpAuthMode | null
  readonly credentialName: string
  readonly credentialPrefix: string
}

/** Immutable revisioned connector list returned by the Host service. */
export interface GongchuangConnectorSnapshot {
  readonly revision: number
  readonly region: GongchuangRegionId
  readonly regionConfirmed: boolean
  readonly connectors: readonly GongchuangConnectorView[]
}

/** Request to enable or disable one known connector. */
export interface GongchuangConnectorEnableRequest {
  readonly id: GongchuangConnectorId
  readonly enabled: boolean
}

/** Secret value to store for one credential-backed connector. */
export interface GongchuangConnectorConfigureRequest {
  readonly id: GongchuangConnectorId
  readonly value: string
  /** Full Streamable HTTP endpoint for the independently configured knowledge MCP. */
  readonly endpoint?: string
}

/** Create or edit one user-owned MCP definition and immediately test it. */
export interface GongchuangCustomMcpUpsertRequest {
  readonly id?: GongchuangCustomConnectorId
  readonly name: string
  readonly transport: GongchuangCustomMcpTransport
  readonly url?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly authMode: GongchuangCustomMcpAuthMode
  readonly credentialName?: string
  readonly credentialPrefix?: string
  /** Optional replacement secret written only to the OS credential service. */
  readonly credentialValue?: string
}

/** Remove one user-added MCP definition and its OS-stored credential. */
export interface GongchuangCustomMcpRemoveRequest {
  readonly id: GongchuangCustomConnectorId
}

/** Begin an official browser authorization without exposing tokens to the renderer. */
export interface GongchuangConnectorAuthorizationStartRequest {
  readonly id: 'qcc' | 'tianyancha'
  /** Caller-known identity lets closing the dialog cancel discovery and registration. */
  readonly transactionId?: string
}

/** Public authorization URL plus opaque Host-owned transaction identity. */
export interface GongchuangConnectorAuthorizationStart {
  readonly id: 'qcc' | 'tianyancha'
  readonly transactionId: string
  readonly authorizationUrl: string
  /** Tianyancha Device Flow code entered on the official authorization page. */
  readonly userCode?: string
}

/** Complete an authorization transaction after the official browser callback. */
export interface GongchuangConnectorAuthorizationCompleteRequest {
  readonly id: 'qcc' | 'tianyancha'
  readonly transactionId: string
}
