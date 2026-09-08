/** Client-safe account state and password-login requests. */

export type GongchuangAccountPhase =
  | 'local'
  | 'checking'
  | 'disconnected'
  | 'authenticating'
  | 'connected'
  | 'upgrade-required'
  | 'offline'
  | 'superseded'
  | 'error'

/** Compatibility decision returned by the account service for the submitted client version. */
export type GongchuangClientCompatibility = 'supported' | 'upgrade-advised' | 'upgrade-required'

/** Password-login request sent from the renderer to the authenticated Host RPC. */
export interface GongchuangAccountLoginRequest {
  readonly username: string
  /** Empty when the renderer asks Host to reuse the OS-keychain password. */
  readonly password: string
  readonly useSavedPassword: boolean
  readonly rememberPassword: boolean
}

/** Explicit local sign-out request and saved-login retention choice. */
export interface GongchuangAccountDisconnectRequest {
  /** Explicit sign-out clears the saved username/password by default. */
  readonly forgetSavedLogin: boolean
}

/** Redacted account state safe to expose to the renderer. */
export interface GongchuangAccountSnapshot {
  readonly revision: number
  readonly phase: GongchuangAccountPhase
  readonly portalUrl: string
  readonly username: string | null
  readonly message: string
  readonly hasSavedPassword: boolean
  readonly autoLoginBlocked: boolean
  readonly singleDevice: boolean
  readonly clientCompatibility: GongchuangClientCompatibility | null
  readonly minimumSupportedVersion: string | null
}

/** Local model-visible preferences. The renderer never receives a filesystem path. */
export interface GongchuangPersonalizationSnapshot {
  readonly instructions: string
  readonly updatedAt: string | null
  readonly maxCharacters: number
  readonly defaultInstructions?: string
}

/** Complete replacement of the user-authored personalization text. */
export interface GongchuangPersonalizationSaveRequest {
  readonly instructions: string
}
