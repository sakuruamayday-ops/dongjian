import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import type { PropsLocale, PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  AutomationCreateRequest, AutomationRunView, AutomationTaskId, AutomationTaskView, AutomationUpdateRequest, GongchuangAccountLoginRequest,
  GongchuangGraphMemoryConfigureRequest, GongchuangGraphMemorySnapshot,
  GongchuangDeepSeekFileRetentionSeconds,
  GongchuangPersonalizationSnapshot,
  GongchuangModelConfigureRequest, GongchuangModelProvider,
  GongchuangConnectorId, GongchuangConnectorView, InstalledSkillView,
  GongchuangCustomConnectorId, GongchuangCustomMcpAuthMode, GongchuangCustomMcpTransport, GongchuangCustomMcpUpsertRequest,
  GongchuangRegionId,
  MarketplaceRepositoryView, MarketplaceSkillView, SessionId, SkillMarketplaceSource,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { EnterpriseCreationOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ComposerAttachment, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  IconArchiveOutline20, IconEllipsisOutline16, IconPinOutline16, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  GONGCHUANG_MODEL_PROVIDERS,
  gongchuangProviderDefinition,
  type GongchuangProviderProtocol,
} from '@gongchuang/model-connections/registry'
import { gongchuangUserError, type GongchuangProductErrorAction } from '@gongchuang/user-errors'
import { sessionDeepLink } from './session-deep-link.ts'
import { BRAND_MARK_DATA_URL } from './brand-data.ts'
import { WECHAT_QR_DATA_URL } from './contact-data.ts'
import { AUTOMATION_TEMPLATES, CONNECTOR_SETUPS, MCP_CARDS } from './catalog.ts'
import type { ConnectorState, TianyanchaAuthorizationStart } from './connectors.ts'
import type { ConnectivityState, ProviderConnection } from './connectivity.ts'
import { marketplaceInstallKey, marketplacePageItems, type MarketplaceState } from './marketplace.ts'
import type { AutomationState } from './automations.ts'
import {
  customCadenceLabel, customCadenceSeconds, editableCustomCadence, localInputTime,
  minimumLocalMinute, nextLocalHour, parseNaturalSchedule, validAutomationInterval,
  type CustomCadenceUnit,
} from './automation-schedule.ts'
import type { AccountState } from './account.ts'
import { enterpriseCacheUsage, formatEnterpriseTokens } from './enterprise-cache.ts'
import { isConcreteEnterpriseWorkspacePath } from './enterprise-workspace.ts'
import type { ImageTransferConsentState } from './image-transfer-consent.ts'
import type { NS } from './locales.ts'
import { UpdateNotification } from './UpdateNotification.tsx'
import css from './ProductShell.module.css'

export const PRODUCT_SHELL_STYLE_ID = '@gongchuang/client-ui/ProductShell.module.css'
const PLUGIN_CSS_REGISTRY_KEY = '__DSH_PLUGIN_CSS_REGISTRY__'

function productError(error: unknown, action: GongchuangProductErrorAction = 'generic'): string {
  return gongchuangUserError(error, 'product', action).text
}

interface PluginCssRegistryHost {
  readonly __DSH_PLUGIN_CSS_REGISTRY__?: Map<string, string>
}

const productShellCssText = typeof document === 'undefined'
  ? null
  : document.querySelector<HTMLStyleElement>(
    `style[data-plugin-css="${PRODUCT_SHELL_STYLE_ID}"]`,
  )?.textContent
    ?? (globalThis as PluginCssRegistryHost)[PLUGIN_CSS_REGISTRY_KEY]?.get(PRODUCT_SHELL_STYLE_ID)
    ?? null

/**
 * Keep the product stylesheet present while its client plugin is mounted.
 * @param doc - Renderer document that owns the plugin stylesheet.
 * @param cssText - Exact bundled ProductShell stylesheet captured at module evaluation.
 * @returns Disposer that stops recovery observations.
 */
export function installProductShellStyleRecovery(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
  cssText: string | null = productShellCssText,
): () => void {
  if (doc === undefined || cssText === null) return () => undefined
  const selector = `style[data-plugin-css="${PRODUCT_SHELL_STYLE_ID}"]`
  const ensure = (): void => {
    if (doc.querySelector(selector) !== null) return
    const tag = doc.createElement('style')
    tag.dataset.plugin = '@gongchuang/client-ui'
    tag.dataset.pluginCss = PRODUCT_SHELL_STYLE_ID
    tag.textContent = cssText
    doc.head.appendChild(tag)
  }
  ensure()
  const Observer = doc.defaultView?.MutationObserver
  if (Observer === undefined) return () => undefined
  const observer = new Observer(ensure)
  observer.observe(doc.head, { childList: true })
  return () => { observer.disconnect() }
}

export type ProductPage = 'assistant' | 'enterprise' | 'skills' | 'mcp' | 'automation'
export type ProductProvider = GongchuangModelProvider

export interface ProductUiState {
  page: ProductPage
  provider: ProductProvider
  accountDialogRevision: number
  avatarDataUrl?: string | null
  /** One-shot handoff from an empty "new chat" action to the enterprise page. */
  enterpriseCreateRequested?: boolean
  navigationError?: string | null
}

export interface WindowsClosePromptState {
  requestId: string | null
}

export interface ProfessionalTaskStatusState {
  sessionId: SessionId | null
  phase: 'none' | 'paused' | 'waiting-user' | 'draft' | 'failed' | 'formal' | 'unavailable'
  busy: boolean
  error: string | null
}

export interface ProductUpdateSnapshot {
  readonly status: 'unconfigured' | 'current' | 'available' | 'downloaded' | 'error'
  readonly currentVersion: string
  readonly latestVersion: string | null
  readonly message: string
  readonly resumableBytes?: number
  readonly releaseNotes?: string
}

export interface ProductUpdateProgress {
  readonly phase: 'downloading' | 'verifying'
  readonly latestVersion: string
  readonly receivedBytes: number
  readonly totalBytes: number
  readonly percent: number
  readonly remainingSeconds: number | null
  readonly resumedFromBytes: number
}

export interface ProductSkillUpdateSnapshot {
  readonly status: 'current' | 'available' | 'downloaded' | 'error'
  readonly currentVersion: string
  readonly latestVersion: string | null
  readonly message: string
  readonly releaseNotes: string | null
}

/** Renderer-visible status for the device-local enterprise root. */
export interface ProductWorkspaceRootState {
  readonly rootPath: string
  readonly isDefault: boolean
  readonly needsInitialSetup: boolean
}

/** Redacted enterprise directory receipt returned by the desktop Host. */
export interface ProductEnterpriseWorkspaceDirectory {
  readonly name: string
  readonly path: string
  readonly created: boolean
  readonly imported: boolean
}

const unavailableSkillUpdate = (): Promise<ProductSkillUpdateSnapshot> => Promise.resolve({
  status: 'error', currentVersion: '未知', latestVersion: null,
  message: '当前环境不提供技能包更新', releaseNotes: null,
})
const UPDATE_CURRENT_FEEDBACK_MS = 5_000

/**
 * Pick the latest enterprise without importing another client plugin at runtime.
 * Stable ties follow the Host Workspace order, matching the native Workspace UI.
 */
function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionListState['byId'],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

export interface ProductUiActions {
  navigate: (page: ProductPage) => void
  startSession: () => void
  requestEnterpriseCreation: () => void
  consumeEnterpriseCreationRequest: () => void
  selectProvider: (provider: ProductProvider) => Promise<void>
  configureProvider: (
    request: GongchuangModelConfigureRequest,
  ) => Promise<ProviderConfigurationResult | void>
  refreshProviderConnection: (provider: GongchuangModelProvider) => Promise<void>
  setDeepSeekFileRetention: (retentionSeconds: GongchuangDeepSeekFileRetentionSeconds) => Promise<void>
  clearDeepSeekFiles: () => Promise<number>
  approveImageTransfer: () => void
  rejectImageTransfer: () => void
  listWorkspaceDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  createWorkspaceDirectory: (path: string, name: string) => Promise<string>
  pickAndCreateWorkspace: (path: string) => Promise<void>
  openWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  openWorkspaceSession: (workspaceId: WorkspaceId, sessionId: SessionId) => Promise<void>
  renameWorkspaceSession: (workspaceId: WorkspaceId, sessionId: SessionId, title: string) => Promise<void>
  copyWorkspaceSession: (workspaceId: WorkspaceId, sessionId: SessionId) => Promise<void>
  moveWorkspaceSession: (sessionId: SessionId, workspaceId: WorkspaceId) => Promise<void>
  reorderWorkspace: (workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId) => Promise<void>
  reorderWorkspaceSession: (
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ) => Promise<void>
  setWorkspaceSessionPinned: (workspaceId: WorkspaceId, sessionId: SessionId, pinned: boolean) => Promise<void>
  renameWorkspace: (workspaceId: WorkspaceId, title: string) => Promise<void>
  archiveWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  deleteWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  restoreWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  archiveWorkspaceSession: (workspaceId: WorkspaceId, sessionId: SessionId) => Promise<void>
  restoreWorkspaceSession: (sessionId: SessionId) => Promise<void>
  deleteWorkspaceSession: (sessionId: SessionId) => Promise<void>
  refreshSkills: () => Promise<void>
  searchSkills: (source: SkillMarketplaceSource, query: string, page?: number, category?: string) => Promise<void>
  installSkill: (skill: MarketplaceSkillView) => Promise<void>
  setSkillEnabled: (skill: InstalledSkillView, enabled: boolean) => Promise<void>
  removeSkill: (skill: InstalledSkillView) => Promise<void>
  addSkillRepository: (manifestUrl: string) => Promise<void>
  removeSkillRepository: (id: string) => Promise<void>
  setMcpEnabled: (id: GongchuangConnectorId, enabled: boolean) => Promise<void>
  configureMcp: (id: GongchuangConnectorId, value: string, endpoint?: string) => Promise<void>
  upsertCustomMcp: (request: GongchuangCustomMcpUpsertRequest) => Promise<void>
  removeCustomMcp: (id: GongchuangCustomConnectorId) => Promise<void>
  authorizeQcc: () => Promise<void>
  beginTianyanchaAuthorization: () => Promise<TianyanchaAuthorizationStart>
  completeTianyanchaAuthorization: (transactionId: string) => Promise<void>
  cancelMcpAuthorization: (id: 'qcc' | 'tianyancha') => Promise<void>
  refreshMcps: () => Promise<void>
  setRegion: (region: GongchuangRegionId) => Promise<void>
  createAutomation: (request: AutomationCreateRequest) => Promise<void>
  updateAutomation: (request: AutomationUpdateRequest) => Promise<void>
  setAutomationEnabled: (id: AutomationTaskId, enabled: boolean) => Promise<void>
  removeAutomation: (id: AutomationTaskId) => Promise<void>
  runAutomationNow: (id: AutomationTaskId) => Promise<void>
  openAutomationResult: (sessionId: string) => Promise<void>
  loginAccount: (request: GongchuangAccountLoginRequest) => Promise<void>
  requestAccountLogin: () => void
  refreshAccount: () => Promise<void>
  disconnectAccount: () => Promise<void>
  loadPersonalization: () => Promise<GongchuangPersonalizationSnapshot>
  savePersonalization: (instructions: string) => Promise<GongchuangPersonalizationSnapshot>
  loadMemory: () => Promise<GongchuangGraphMemorySnapshot>
  configureMemory: (request: GongchuangGraphMemoryConfigureRequest) => Promise<GongchuangGraphMemorySnapshot>
  clearMemory: () => Promise<GongchuangGraphMemorySnapshot>
  setAvatar: (value: string | null) => Promise<void>
  checkForUpdates: () => Promise<ProductUpdateSnapshot>
  downloadUpdate: () => Promise<ProductUpdateSnapshot>
  installUpdate: () => Promise<ProductUpdateSnapshot>
  onUpdateProgress?: (listener: (progress: ProductUpdateProgress) => void) => () => void
  readSkillUpdateState?: () => Promise<ProductSkillUpdateSnapshot>
  checkSkillUpdates?: () => Promise<ProductSkillUpdateSnapshot>
  downloadSkillUpdate?: () => Promise<ProductSkillUpdateSnapshot>
  installSkillUpdate?: () => Promise<ProductSkillUpdateSnapshot>
  workspaceRootState?: () => Promise<ProductWorkspaceRootState>
  chooseWorkspaceRoot?: () => Promise<ProductWorkspaceRootState | null>
  useDefaultWorkspaceRoot?: () => Promise<ProductWorkspaceRootState>
  createEnterpriseWorkspace?: (name: string) => Promise<ProductEnterpriseWorkspaceDirectory>
  importEnterpriseWorkspace?: () => Promise<ProductEnterpriseWorkspaceDirectory | null>
  readWindowsCloseBehavior?: () => Promise<WindowsCloseBehavior>
  writeWindowsCloseBehavior?: (value: WindowsCloseBehavior) => Promise<WindowsCloseBehavior>
  respondWindowsCloseRequest: (
    requestId: string,
    decision: Exclude<WindowsCloseBehavior, 'ask'> | null,
    remember: boolean,
  ) => Promise<void>
  resumeProfessionalTask?: () => Promise<void>
}

/** Result after a model connection has already been committed by the Host. */
export interface ProviderConfigurationResult {
  readonly connectionSaved: true
  readonly autoSelected: boolean
  readonly message?: string
}

export type WindowsCloseBehavior = 'ask' | 'tray' | 'quit'

type ProductHook = SnapshotSelectorHook<ProductUiState>
type ConnectivityHook = SnapshotSelectorHook<ConnectivityState>
type ImageTransferConsentHook = SnapshotSelectorHook<ImageTransferConsentState>
type ConnectorsHook = SnapshotSelectorHook<ConnectorState>
type MarketplaceHook = SnapshotSelectorHook<MarketplaceState>
type AutomationHook = SnapshotSelectorHook<AutomationState>
type AccountHook = SnapshotSelectorHook<AccountState>
type WindowsClosePromptHook = SnapshotSelectorHook<WindowsClosePromptState>
type ProfessionalTaskStatusHook = SnapshotSelectorHook<ProfessionalTaskStatusState>
type ProductInjected = ProductUiActions & {
  useProduct: ProductHook
  useConnectivity: ConnectivityHook
  useImageTransferConsent?: ImageTransferConsentHook
  useConnectors: ConnectorsHook
  useMarketplace: MarketplaceHook
  useAutomations: AutomationHook
  useAccount: AccountHook
  useWindowsClosePrompt: WindowsClosePromptHook
  useProfessionalTaskStatus?: ProfessionalTaskStatusHook
}

export type ProductSidebarProps = PropsRuntime<'sidebar'> & ProductInjected & PropsLocale<typeof NS>
export type ProductOverlayProps = PropsRuntime<'shell.overlay'> & ProductInjected & PropsLocale<typeof NS>

export type ImageTransferProviderNoticeProps = PropsRuntime<'conversation.composer.dock'> & {
  useProduct: ProductHook
  resolveDraftAttachments: (ids: readonly DraftAttachmentId[]) => readonly ComposerAttachment[]
}

const NAV: readonly { id: ProductPage; label: string; caption: string; icon: IconName }[] = [
  { id: 'assistant', label: '新对话', caption: '开始一项专业任务', icon: 'plus' },
  { id: 'enterprise', label: '企业空间', caption: '企业与项目资料', icon: 'building' },
  { id: 'skills', label: '技能中心', caption: '专业能力插件', icon: 'blocks' },
  { id: 'mcp', label: 'MCP 连接', caption: '企业数据与工具', icon: 'plug' },
  { id: 'automation', label: '自动化任务', caption: '定时监测与巡检', icon: 'clock' },
]

type IconName = 'spark' | 'building' | 'blocks' | 'plug' | 'search' | 'clock' | 'plus' | 'shield' | 'chevron' | 'external' | 'folder' | 'user' | 'settings' | 'download' | 'location'

function Icon({ name, size = 19 }: { name: IconName; size?: number }) {
  const common = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const, 'aria-hidden': true,
  }
  switch (name) {
    case 'spark': return <svg {...common}><path d="m12 3 1.2 4.1L17 9l-3.8 1.9L12 15l-1.2-4.1L7 9l3.8-1.9L12 3Z" /><path d="m18 15 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z" /></svg>
    case 'building': return <svg {...common}><path d="M4 21V6l8-3v18M12 8h8v13M2 21h20" /><path d="M7 8h2M7 12h2M7 16h2M15 11h2M15 15h2" /></svg>
    case 'blocks': return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M17.5 14v7M14 17.5h7" /></svg>
    case 'plug': return <svg {...common}><path d="M8 3v5M16 3v5M6 8h12v2a6 6 0 0 1-6 6v5M9 21h6" /></svg>
    case 'search': return <svg {...common}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>
    case 'clock': return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
    case 'plus': return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>
    case 'shield': return <svg {...common}><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg>
    case 'chevron': return <svg {...common}><path d="m9 18 6-6-6-6" /></svg>
    case 'external': return <svg {...common}><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></svg>
    case 'folder': return <svg {...common}><path d="M3 6h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" /></svg>
    case 'user': return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></svg>
    case 'settings': return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></svg>
    case 'download': return <svg {...common}><path d="M12 3v12M7 10l5 5 5-5M4 21h16" /></svg>
    case 'location': return <svg {...common}><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></svg>
  }
}

function updateProgressText(progress: ProductUpdateProgress): string {
  if (progress.phase === 'verifying') return '下载完成，正在验证更新'
  if (progress.remainingSeconds === null) return `已下载 ${String(progress.percent)}%`
  const minutes = Math.max(1, Math.ceil(progress.remainingSeconds / 60))
  const resumed = progress.resumedFromBytes > 0 ? '，已从上次进度继续' : ''
  return `已下载 ${String(progress.percent)}%，预计还需 ${String(minutes)} 分钟${resumed}`
}

/** Props for the product action composed into the new-conversation Workspace picker. */
export type EnterpriseCreationMenuItemProps = EnterpriseCreationOwnerProps
  & Pick<ProductUiActions, 'requestEnterpriseCreation'>

/** Open the same named-enterprise flow used by the Enterprise Space page. */
export function EnterpriseCreationMenuItem({
  onClose,
  requestEnterpriseCreation,
}: EnterpriseCreationMenuItemProps) {
  return <button
    type="button"
    role="menuitem"
    className={css.workspacePickerCreateAction}
    onClick={() => {
      onClose()
      requestEnterpriseCreation()
    }}
  ><Icon name="plus" size={16} /><span>新建企业</span></button>
}

type SidebarDragState =
  | { kind: 'workspace'; workspaceId: WorkspaceId }
  | { kind: 'session'; workspaceId: WorkspaceId; sessionId: SessionId }

type SidebarDropState =
  | { kind: 'workspace'; workspaceId: WorkspaceId; edge: 'before' | 'after' }
  | { kind: 'session'; workspaceId: WorkspaceId; sessionId?: SessionId; edge: 'before' | 'after' | 'end' }

const SIDEBAR_DRAG_HOLD_MS = 180

function sameSidebarDrag(left: SidebarDragState | null, right: SidebarDragState | null): boolean {
  if (left === null || right === null || left.kind !== right.kind) return left === right
  if (left.kind === 'workspace' && right.kind === 'workspace') {
    return left.workspaceId === right.workspaceId
  }
  if (left.kind === 'session' && right.kind === 'session') {
    return left.workspaceId === right.workspaceId && left.sessionId === right.sessionId
  }
  return false
}

function sameSidebarDrop(left: SidebarDropState | null, right: SidebarDropState): boolean {
  return left?.kind === right.kind
    && left.workspaceId === right.workspaceId
    && left.edge === right.edge
    && (left.kind !== 'session' || right.kind !== 'session' || left.sessionId === right.sessionId)
}

/** Resolve an HTML drag target to the Host's insert-before anchor without mutating local order. */
export function sidebarInsertBeforeAnchor<T extends string>(
  orderedIds: readonly T[],
  movingId: T,
  targetId: T,
  edge: 'before' | 'after',
): T | undefined {
  const remaining = orderedIds.filter(id => id !== movingId)
  const targetIndex = remaining.indexOf(targetId)
  if (targetIndex < 0) return undefined
  return edge === 'before' ? remaining[targetIndex] : remaining[targetIndex + 1]
}

const REGIONS: readonly { id: GongchuangRegionId; label: string; caption: string }[] = [
  { id: 'all', label: '全部', caption: '不限定城市；省级、国家级内容始终共享' },
  { id: 'hangzhou', label: '杭州', caption: '杭州市本地内容＋省级、国家级共享内容' },
  { id: 'shaoxing', label: '绍兴', caption: '绍兴市本地内容＋省级、国家级共享内容' },
  { id: 'jinhua', label: '金华', caption: '金华市本地内容＋省级、国家级共享内容' },
  { id: 'ningbo', label: '宁波', caption: '宁波市本地内容＋省级、国家级共享内容' },
]

function automationRunLabel(run: Pick<AutomationRunView, 'message' | 'status'>): '已完成' | '已提交' | '失败' | '执行中' {
  if (run.status === 'failed') return '失败'
  if (run.status === 'running') return '执行中'
  return /^已完成(?:[，。]|$)/u.test(run.message.trim()) ? '已完成' : '已提交'
}

const PROVIDERS: readonly { id: ProductProvider; label: string }[] = GONGCHUANG_MODEL_PROVIDERS
  .map(provider => ({ id: provider.id, label: provider.label }))

const PROVIDER_SETUP: Readonly<Record<ProductProvider, {
  title: string
  eyebrow: string
  officialUrl?: string
  officialLabel?: string
  keyPlaceholder: string
}>> = {
  ...Object.fromEntries(GONGCHUANG_MODEL_PROVIDERS.map((provider) => {
    const definition = gongchuangProviderDefinition(provider.id)
    return [provider.id, {
      title: `连接 ${definition.label}`,
      eyebrow: definition.id === 'custom' ? 'OpenAI 兼容服务' : definition.label,
      ...definition.officialUrl === undefined ? {} : {
        officialUrl: definition.officialUrl,
        officialLabel: `打开 ${definition.label} 官方页面`,
      },
      keyPlaceholder: definition.keyPlaceholder,
    }]
  })) as Readonly<Record<ProductProvider, {
    title: string
    eyebrow: string
    officialUrl?: string
    officialLabel?: string
    keyPlaceholder: string
  }>>,
}

const AVATAR_BYTES_LIMIT = 5 * 1024 * 1024
const AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function dialogFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR))
    .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
}

function useDialogFocusTrap<TElement extends HTMLElement = HTMLElement>(active: boolean, scopeKey: string | null) {
  const dialogRef = useRef<TElement>(null)
  useEffect(() => {
    if (!active || scopeKey === null) return
    const dialog = dialogRef.current
    if (dialog === null) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusInitial = () => {
      const target = dialog.querySelector<HTMLElement>('[autofocus]')
        ?? dialogFocusableElements(dialog)[0]
        ?? dialog
      if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1
      target.focus()
    }
    focusInitial()
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = dialogFocusableElements(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const current = document.activeElement
      if (!dialog.contains(current)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first)?.focus()
      } else if (event.shiftKey && current === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && current === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', trapFocus, true)
    return () => {
      document.removeEventListener('keydown', trapFocus, true)
      if (previousFocus?.isConnected === true) previousFocus.focus()
    }
  }, [active, scopeKey])
  return dialogRef
}

async function normalizedAvatarDataUrl(file: File): Promise<string> {
  if (!AVATAR_TYPES.has(file.type)) throw new Error('头像仅支持 JPG、PNG 或 WebP 图片')
  if (file.size <= 0 || file.size > AVATAR_BYTES_LIMIT) throw new Error('头像文件需小于 5 MB')
  const bitmap = await createImageBitmap(file)
  try {
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('当前设备无法处理头像图片')
    const scale = Math.max(size / bitmap.width, size / bitmap.height)
    const width = bitmap.width * scale
    const height = bitmap.height * scale
    context.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height)
    return canvas.toDataURL('image/webp', .88)
  } finally {
    bitmap.close()
  }
}

export function ProductSidebar({
  collapsed, width, useProduct, useConnectivity, useConnectors, useWorkspaces,
  useSessions, useSessionPendingInteraction, navigate, startSession, openWorkspaceSession, renameWorkspaceSession,
  copyWorkspaceSession, moveWorkspaceSession, reorderWorkspace, reorderWorkspaceSession,
  setWorkspaceSessionPinned,
  renameWorkspace, archiveWorkspace, deleteWorkspace,
  archiveWorkspaceSession, deleteWorkspaceSession,
  restoreWorkspace, restoreWorkspaceSession,
  loadPersonalization, savePersonalization,
  loadMemory, configureMemory, clearMemory,
  setAvatar, setRegion, checkForUpdates, downloadUpdate, installUpdate, onUpdateProgress, t,
  configureProvider, refreshProviderConnection, setDeepSeekFileRetention, clearDeepSeekFiles,
  readSkillUpdateState,
  checkSkillUpdates = unavailableSkillUpdate,
  downloadSkillUpdate = unavailableSkillUpdate,
  installSkillUpdate = unavailableSkillUpdate,
  workspaceRootState, chooseWorkspaceRoot, useDefaultWorkspaceRoot,
  readWindowsCloseBehavior, writeWindowsCloseBehavior,
}: ProductSidebarProps) {
  const page = useProduct(state => state.page)
  const provider = useProduct(state => state.provider)
  const connectivity = useConnectivity(state => state)
  const providerStatus = connectivity.providers[provider]
  const workspaceState = useWorkspaces(state => state)
  const sessionState = useSessions(state => state)
  const pendingInteractions = useSessionPendingInteraction(state => state)
  const recentWorkspaceId = recentWorkspace(workspaceState.items, sessionState.byId)
  const workspaceCount = workspaceState.items.length
  const connectors = useConnectors(state => state)
  const avatarDataUrl = useProduct(state => state.avatarDataUrl ?? null)
  const navigationError = useProduct(state => state.navigationError ?? null)
  const [profileOpen, setProfileOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsModelConfiguration, setSettingsModelConfiguration] = useState<ProductProvider | null>(null)
  const [regionOpen, setRegionOpen] = useState(false)
  const [regionDraft, setRegionDraft] = useState<GongchuangRegionId>('all')
  const [regionBusy, setRegionBusy] = useState(false)
  const [regionError, setRegionError] = useState<string | null>(null)
  const [rootState, setRootState] = useState<ProductWorkspaceRootState | null>(null)
  const [rootLoading, setRootLoading] = useState(workspaceRootState !== undefined)
  const [rootBusy, setRootBusy] = useState(false)
  const [rootError, setRootError] = useState<string | null>(null)
  const [settingsSection, setSettingsSection] = useState<'general' | 'personalization' | 'memory' | 'archived' | 'models' | 'privacy' | 'updates'>('general')
  const [windowsCloseBehavior, setWindowsCloseBehavior] = useState<WindowsCloseBehavior | null>(null)
  const [closeBehaviorBusy, setCloseBehaviorBusy] = useState(false)
  const [closeBehaviorError, setCloseBehaviorError] = useState<string | null>(null)
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [expandedWorkspace, setExpandedWorkspace] = useState<WorkspaceId | null>(null)
  const [showAllWorkspace, setShowAllWorkspace] = useState<WorkspaceId | null>(null)
  const [workspaceNavigationError, setWorkspaceNavigationError] = useState<string | null>(null)
  const [sidebarDrag, setSidebarDrag] = useState<SidebarDragState | null>(null)
  const [sidebarDragReady, setSidebarDragReady] = useState<SidebarDragState | null>(null)
  const [sidebarDragPoint, setSidebarDragPoint] = useState<{ x: number; y: number } | null>(null)
  const [sidebarDrop, setSidebarDrop] = useState<SidebarDropState | null>(null)
  const sidebarDragRef = useRef<SidebarDragState | null>(null)
  const sidebarDragReadyRef = useRef<SidebarDragState | null>(null)
  const sidebarDropRef = useRef<SidebarDropState | null>(null)
  const sidebarDragPreviewRef = useRef<HTMLDivElement | null>(null)
  const sidebarDragPointerIdRef = useRef<number | null>(null)
  const sidebarSuppressClickRef = useRef(false)
  const sidebarDragHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [sessionMenu, setSessionMenu] = useState<{
    workspaceId: WorkspaceId
    sessionId: SessionId
    x: number
    y: number
  } | null>(null)
  const [sessionSubmenu, setSessionSubmenu] = useState<'copy' | 'workspace' | null>(null)
  const [workspaceMenu, setWorkspaceMenu] = useState<{
    workspaceId: WorkspaceId
    x: number
    y: number
  } | null>(null)
  const [renameWorkspaceTarget, setRenameWorkspaceTarget] = useState<WorkspaceId | null>(null)
  const [renameWorkspaceValue, setRenameWorkspaceValue] = useState('')
  const [deleteWorkspaceTarget, setDeleteWorkspaceTarget] = useState<WorkspaceId | null>(null)
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<SessionId | null>(null)
  const [renameSessionTarget, setRenameSessionTarget] = useState<{
    workspaceId: WorkspaceId
    sessionId: SessionId
  } | null>(null)
  const [renameSessionValue, setRenameSessionValue] = useState('')
  const sessionMenuRef = useRef<HTMLDivElement>(null)
  const sessionMenuTriggerRef = useRef<HTMLElement | null>(null)
  const workspaceMenuRef = useRef<HTMLDivElement>(null)
  const workspaceMenuTriggerRef = useRef<HTMLElement | null>(null)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [updateBusy, setUpdateBusy] = useState<'check' | 'download' | 'install' | null>(null)
  const [updateSnapshot, setUpdateSnapshot] = useState<ProductUpdateSnapshot | null>(null)
  const [updateProgress, setUpdateProgress] = useState<ProductUpdateProgress | null>(null)
  const [updateConfirmedCurrent, setUpdateConfirmedCurrent] = useState(false)
  const [skillUpdateBusy, setSkillUpdateBusy] = useState<'check' | 'download' | 'install' | null>(null)
  const [skillUpdateSnapshot, setSkillUpdateSnapshot] = useState<ProductSkillUpdateSnapshot | null>(null)
  const [skillUpdateConfirmedCurrent, setSkillUpdateConfirmedCurrent] = useState(false)
  const [personalizationDraft, setPersonalizationDraft] = useState('')
  const [personalizationDefault, setPersonalizationDefault] = useState('')
  const [personalizationLimit, setPersonalizationLimit] = useState(6_000)
  const [personalizationBusy, setPersonalizationBusy] = useState(false)
  const [personalizationNotice, setPersonalizationNotice] = useState<string | null>(null)
  const [personalizationError, setPersonalizationError] = useState<string | null>(null)
  const [memorySnapshot, setMemorySnapshot] = useState<GongchuangGraphMemorySnapshot | null>(null)
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [archiveBusyId, setArchiveBusyId] = useState<string | null>(null)
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const initializedWorkspaceBrowser = useRef(false)
  const automaticUpdateCheckStarted = useRef(false)
  const wide = !collapsed
  const selectedRegion = REGIONS.find(item => item.id === connectors.snapshot.region)
    ?? { id: 'all' as const, label: '全部', caption: '同时检索四地市' }
  const firstRunRegion = !connectors.snapshot.regionConfirmed
  const rootSetupLoading = workspaceRootState !== undefined && rootState === null
  const firstRunWorkspace = rootState?.needsInitialSetup === true
  const firstRunSetup = firstRunRegion || firstRunWorkspace || rootSetupLoading
  const sidebarDialogKey = firstRunSetup ? 'first-run-setup'
    : regionOpen ? 'region'
      : settingsOpen ? 'settings'
        : profileOpen ? 'profile'
          : null
  const sidebarDialogRef = useDialogFocusTrap(sidebarDialogKey !== null, sidebarDialogKey)
  const sidebarDeleteDialogRef = useDialogFocusTrap(
    deleteSessionTarget !== null,
    deleteSessionTarget === null ? null : `delete-session-${deleteSessionTarget}`,
  )
  const sidebarRenameDialogRef = useDialogFocusTrap(
    renameSessionTarget !== null,
    renameSessionTarget === null ? null : `rename-session-${renameSessionTarget.sessionId}`,
  )
  const workspaceRenameDialogRef = useDialogFocusTrap(
    renameWorkspaceTarget !== null,
    renameWorkspaceTarget === null ? null : `rename-workspace-${renameWorkspaceTarget}`,
  )
  const workspaceDeleteDialogRef = useDialogFocusTrap(
    deleteWorkspaceTarget !== null,
    deleteWorkspaceTarget === null ? null : `delete-workspace-${deleteWorkspaceTarget}`,
  )
  useEffect(() => {
    document.body.style.setProperty('--gc-sidebar-width', `${width}px`)
    return () => { document.body.style.removeProperty('--gc-sidebar-width') }
  }, [width])

  useEffect(() => () => {
    if (sidebarDragHoldTimer.current !== null) clearTimeout(sidebarDragHoldTimer.current)
  }, [])

  useEffect(() => {
    const closeOverlay = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (deleteSessionTarget !== null && archiveBusyId === null) setDeleteSessionTarget(null)
      else if (renameSessionTarget !== null && archiveBusyId === null) setRenameSessionTarget(null)
      else if (deleteWorkspaceTarget !== null && archiveBusyId === null) setDeleteWorkspaceTarget(null)
      else if (renameWorkspaceTarget !== null && archiveBusyId === null) setRenameWorkspaceTarget(null)
      else if (regionOpen && !firstRunSetup && !regionBusy && !rootBusy) setRegionOpen(false)
      else if (settingsOpen && updateBusy === null && !personalizationBusy && !memoryBusy) setSettingsOpen(false)
      else if (profileOpen && !avatarBusy) setProfileOpen(false)
      else return
      event.preventDefault()
    }
    document.addEventListener('keydown', closeOverlay)
    return () => { document.removeEventListener('keydown', closeOverlay) }
  }, [
    archiveBusyId,
    avatarBusy,
    firstRunRegion,
    firstRunSetup,
    personalizationBusy,
    memoryBusy,
    deleteSessionTarget,
    deleteWorkspaceTarget,
    profileOpen,
    renameSessionTarget,
    renameWorkspaceTarget,
    regionBusy,
    regionOpen,
    rootBusy,
    settingsOpen,
    updateBusy,
  ])

  useEffect(() => {
    if (sessionMenu === null) return
    const closeMenu = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && sessionMenuRef.current?.contains(event.target as Node) === true) return
      setSessionMenu(null)
      setSessionSubmenu(null)
      if (event instanceof KeyboardEvent) {
        window.queueMicrotask(() => { sessionMenuTriggerRef.current?.focus() })
        event.preventDefault()
      }
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeMenu)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeMenu)
    }
  }, [sessionMenu])

  useEffect(() => {
    if (workspaceMenu === null) return
    const closeMenu = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && workspaceMenuRef.current?.contains(event.target as Node) === true) return
      setWorkspaceMenu(null)
      if (event instanceof KeyboardEvent) {
        window.queueMicrotask(() => { workspaceMenuTriggerRef.current?.focus() })
        event.preventDefault()
      }
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeMenu)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeMenu)
    }
  }, [workspaceMenu])

  useEffect(() => {
    // Keep the closed draft aligned with the late Host snapshot. An explicitly
    // opened selector owns its draft until Save, while first-run follows Host
    // changes because no user edit exists before the initial choice.
    if (regionOpen && !firstRunSetup) return
    setRegionDraft(connectors.snapshot.region)
  }, [connectors.snapshot.region, firstRunSetup, regionOpen])

  const refreshWorkspaceRoot = () => {
    if (workspaceRootState === undefined) return
    setRootLoading(true)
    setRootError(null)
    void workspaceRootState()
      .then(setRootState)
      .catch((cause: unknown) => { setRootError(productError(cause, 'workspace')) })
      .finally(() => { setRootLoading(false) })
  }

  useEffect(() => {
    refreshWorkspaceRoot()
  }, [workspaceRootState])

  useEffect(() => {
    if (initializedWorkspaceBrowser.current || workspaceState.items.length === 0) return
    initializedWorkspaceBrowser.current = true
    setExpandedWorkspace(recentWorkspaceId ?? workspaceState.items[0]?.workspaceId ?? null)
  }, [workspaceState.items, recentWorkspaceId])

  // Check once after startup.  The result stays non-modal and is surfaced in
  // the sidebar/settings instead of interrupting the current conversation.
  useEffect(() => {
    if (automaticUpdateCheckStarted.current) return
    automaticUpdateCheckStarted.current = true
    const checkAll = () => {
      void checkForUpdates()
        .then((snapshot) => {
          setUpdateSnapshot(snapshot)
          if (snapshot.status !== 'current') setUpdateConfirmedCurrent(false)
        })
        .catch(() => {
          setUpdateSnapshot(current => ({
            status: 'error', currentVersion: current?.currentVersion ?? '未知', latestVersion: null,
            message: '自动检查更新失败，可稍后手动重试',
          }))
        })
      void checkSkillUpdates()
        .then((snapshot) => {
          setSkillUpdateSnapshot(snapshot)
          if (snapshot.status !== 'current') setSkillUpdateConfirmedCurrent(false)
        })
        .catch(() => {
          setSkillUpdateConfirmedCurrent(false)
          setSkillUpdateSnapshot(current => ({
            status: 'error', currentVersion: current?.currentVersion ?? '未知', latestVersion: null,
            message: '自动检查技能包更新失败，可稍后手动重试', releaseNotes: null,
          }))
        })
    }
    checkAll()
    const timer = window.setInterval(checkAll, 6 * 60 * 60 * 1_000)
    return () => { window.clearInterval(timer) }
  }, [checkForUpdates, checkSkillUpdates])

  useEffect(() => {
    if (readSkillUpdateState === undefined) return
    let disposed = false
    // Local activation stays authoritative while the network check is pending
    // or unavailable; compile-time bundle metadata is not the active version.
    void readSkillUpdateState().then((local) => {
      if (disposed) return
      setSkillUpdateSnapshot(current => current === null ? local : { ...current, currentVersion: local.currentVersion })
    }).catch(() => { /* The online check can still supply the active version. */ })
    return () => { disposed = true }
  }, [readSkillUpdateState])

  useEffect(() => onUpdateProgress?.((progress) => { setUpdateProgress(progress) }), [onUpdateProgress])

  useEffect(() => {
    if (!updateConfirmedCurrent) return
    const timer = window.setTimeout(() => { setUpdateConfirmedCurrent(false) }, UPDATE_CURRENT_FEEDBACK_MS)
    return () => { window.clearTimeout(timer) }
  }, [updateConfirmedCurrent])

  useEffect(() => {
    if (!skillUpdateConfirmedCurrent) return
    const timer = window.setTimeout(() => { setSkillUpdateConfirmedCurrent(false) }, UPDATE_CURRENT_FEEDBACK_MS)
    return () => { window.clearTimeout(timer) }
  }, [skillUpdateConfirmedCurrent])

  const openSettings = () => {
    setSettingsOpen(true)
    setPersonalizationBusy(true)
    setMemoryBusy(true)
    setPersonalizationError(null)
    setMemoryError(null)
    setMemoryNotice(null)
    setCloseBehaviorError(null)
    void loadPersonalization()
      .then((snapshot) => {
        setPersonalizationDraft(snapshot.instructions)
        setPersonalizationDefault(snapshot.defaultInstructions ?? '')
        setPersonalizationLimit(snapshot.maxCharacters)
      })
      .catch((cause: unknown) => { setPersonalizationError(productError(cause, 'personalization')) })
      .finally(() => { setPersonalizationBusy(false) })
    void loadMemory()
      .then(setMemorySnapshot)
      .catch((cause: unknown) => { setMemoryError(productError(cause, 'memory')) })
      .finally(() => { setMemoryBusy(false) })
    if (readWindowsCloseBehavior !== undefined) {
      setCloseBehaviorBusy(true)
      void readWindowsCloseBehavior()
        .then(setWindowsCloseBehavior)
        .catch((cause: unknown) => { setCloseBehaviorError(productError(cause)) })
        .finally(() => { setCloseBehaviorBusy(false) })
    }
  }
  const saveWindowsCloseBehavior = (value: WindowsCloseBehavior) => {
    if (writeWindowsCloseBehavior === undefined) return
    setCloseBehaviorBusy(true)
    setCloseBehaviorError(null)
    void writeWindowsCloseBehavior(value)
      .then(setWindowsCloseBehavior)
      .catch((cause: unknown) => { setCloseBehaviorError(productError(cause)) })
      .finally(() => { setCloseBehaviorBusy(false) })
  }
  const restoreArchived = (
    kind: 'workspace' | 'session',
    id: WorkspaceId | SessionId,
  ) => {
    setArchiveBusyId(id)
    setArchiveNotice(null)
    setArchiveError(null)
    const operation = kind === 'workspace'
      ? restoreWorkspace(id as WorkspaceId)
      : restoreWorkspaceSession(id as SessionId)
    void operation
      .then(() => { setArchiveNotice(kind === 'workspace' ? '企业空间已恢复' : '对话已恢复') })
      .catch((cause: unknown) => { setArchiveError(productError(cause, 'archive')) })
      .finally(() => { setArchiveBusyId(null) })
  }
  const deleteArchived = (
    kind: 'workspace' | 'session',
    id: WorkspaceId | SessionId,
  ) => {
    setArchiveBusyId(id)
    setArchiveNotice(null)
    setArchiveError(null)
    const operation = kind === 'workspace'
      ? deleteWorkspace(id as WorkspaceId)
      : deleteWorkspaceSession(id as SessionId)
    void operation
      .then(() => { setArchiveNotice(kind === 'workspace' ? '企业空间已删除' : '对话已删除') })
      .catch((cause: unknown) => { setArchiveError(productError(cause, 'archive')) })
      .finally(() => { setArchiveBusyId(null) })
  }
  const chooseRoot = () => {
    if (chooseWorkspaceRoot === undefined) return
    setRootBusy(true)
    setRootError(null)
    void chooseWorkspaceRoot()
      .then((snapshot) => { if (snapshot !== null) setRootState(snapshot) })
      .catch((cause: unknown) => { setRootError(productError(cause, 'workspace')) })
      .finally(() => { setRootBusy(false) })
  }
  const restoreDefaultRoot = () => {
    if (useDefaultWorkspaceRoot === undefined) return
    setRootBusy(true)
    setRootError(null)
    void useDefaultWorkspaceRoot()
      .then(setRootState)
      .catch((cause: unknown) => { setRootError(productError(cause, 'workspace')) })
      .finally(() => { setRootBusy(false) })
  }
  const saveRegion = () => {
    setRegionBusy(true)
    setRegionError(null)
    setRootError(null)
    let acceptingRoot = rootState?.needsInitialSetup === true
    void (async () => {
      if (acceptingRoot) {
        if (useDefaultWorkspaceRoot === undefined) throw new Error('当前客户端无法确认企业空间根目录')
        setRootState(await useDefaultWorkspaceRoot())
      }
      acceptingRoot = false
      await setRegion(regionDraft)
      setRegionOpen(false)
    })()
      .catch((cause: unknown) => {
        const message = productError(cause, acceptingRoot ? 'workspace' : 'region')
        if (acceptingRoot) setRootError(message)
        else setRegionError(message)
      })
      .finally(() => { setRegionBusy(false) })
  }
  const persistPersonalization = () => {
    setPersonalizationBusy(true)
    setPersonalizationError(null)
    setPersonalizationNotice(null)
    void savePersonalization(personalizationDraft)
      .then((snapshot) => {
        setPersonalizationDraft(snapshot.instructions)
        setPersonalizationLimit(snapshot.maxCharacters)
        setPersonalizationNotice('已保存，将从下一次回复开始生效')
      })
      .catch((cause: unknown) => { setPersonalizationError(productError(cause, 'personalization')) })
      .finally(() => { setPersonalizationBusy(false) })
  }
  const resetPersonalization = () => {
    setPersonalizationBusy(true)
    setPersonalizationError(null)
    setPersonalizationNotice(null)
    void savePersonalization(personalizationDefault)
      .then((snapshot) => { setPersonalizationDraft(snapshot.instructions); setPersonalizationNotice('已恢复默认，将从下一次回复开始生效') })
      .catch((cause: unknown) => { setPersonalizationError(productError(cause, 'personalization')) })
      .finally(() => { setPersonalizationBusy(false) })
  }
  const updateMemory = (patch: Partial<GongchuangGraphMemoryConfigureRequest>) => {
    if (memorySnapshot === null) return
    setMemoryBusy(true)
    setMemoryError(null)
    setMemoryNotice(null)
    void configureMemory({
      enabled: patch.enabled ?? memorySnapshot.enabled,
      includeToolResults: patch.includeToolResults ?? memorySnapshot.includeToolResults,
    })
      .then((snapshot) => { setMemorySnapshot(snapshot); setMemoryNotice('已立即应用到本机会话') })
      .catch((cause: unknown) => { setMemoryError(productError(cause, 'memory')) })
      .finally(() => { setMemoryBusy(false) })
  }
  const clearAllMemory = () => {
    if (!window.confirm('确定清除本机的个人记忆和所有企业记忆吗？原会话和企业文件不会被删除。')) return
    setMemoryBusy(true)
    setMemoryError(null)
    setMemoryNotice(null)
    void clearMemory()
      .then((snapshot) => { setMemorySnapshot(snapshot); setMemoryNotice('本机长期记忆已清除') })
      .catch((cause: unknown) => { setMemoryError(productError(cause, 'memory')) })
      .finally(() => { setMemoryBusy(false) })
  }
  const chooseAvatar = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file === undefined) return
    setAvatarError(null)
    setAvatarBusy(true)
    void normalizedAvatarDataUrl(file)
      .then(setAvatar)
      .catch((cause: unknown) => { setAvatarError(productError(cause, 'avatar')) })
      .finally(() => { setAvatarBusy(false) })
  }
  const resetAvatar = () => {
    setAvatarError(null)
    setAvatarBusy(true)
    void setAvatar(null)
      .catch((cause: unknown) => { setAvatarError(productError(cause, 'avatar')) })
      .finally(() => { setAvatarBusy(false) })
  }
  const checkUpdates = () => {
    setUpdateBusy('check')
    void checkForUpdates()
      .then((snapshot) => {
        setUpdateSnapshot(snapshot)
        setUpdateConfirmedCurrent(snapshot.status === 'current')
      })
      .catch(() => {
        setUpdateConfirmedCurrent(false)
        setUpdateSnapshot(current => ({ status: 'error', currentVersion: current?.currentVersion ?? '未知', latestVersion: null, message: '检查更新失败，请稍后重试' }))
      })
      .finally(() => { setUpdateBusy(null) })
  }
  const downloadAvailableUpdate = () => {
    setUpdateBusy('download')
    setUpdateProgress(null)
    void downloadUpdate().then(setUpdateSnapshot)
      .catch(() => { setUpdateSnapshot(current => ({ status: 'error', currentVersion: current?.currentVersion ?? '未知', latestVersion: null, message: '更新未能完成，请稍后重试' })) })
      .finally(() => { setUpdateBusy(null); setUpdateProgress(null) })
  }
  const restartAndInstallUpdate = () => {
    setUpdateBusy('install')
    void installUpdate().then(setUpdateSnapshot)
      .catch(() => { setUpdateSnapshot(current => ({ status: 'error', currentVersion: current?.currentVersion ?? '未知', latestVersion: current?.latestVersion ?? null, message: '更新安装未完成，已保留当前版本，请重试' })) })
      .finally(() => { setUpdateBusy(null) })
  }
  const checkSkillPackageUpdates = () => {
    setSkillUpdateBusy('check')
    void checkSkillUpdates()
      .then((snapshot) => {
        setSkillUpdateSnapshot(snapshot)
        setSkillUpdateConfirmedCurrent(snapshot.status === 'current')
      })
      .catch(() => {
        setSkillUpdateConfirmedCurrent(false)
        setSkillUpdateSnapshot(current => ({ status: 'error', currentVersion: current?.currentVersion ?? '未知', latestVersion: null, message: '检查技能包更新失败，请稍后重试', releaseNotes: null }))
      })
      .finally(() => { setSkillUpdateBusy(null) })
  }
  const downloadAvailableSkillPackage = () => {
    setSkillUpdateBusy('download')
    void downloadSkillUpdate().then(setSkillUpdateSnapshot)
      .catch(() => { setSkillUpdateSnapshot(current => ({ status: 'error', currentVersion: current?.currentVersion ?? '未知', latestVersion: null, message: '技能包下载失败，请稍后重试', releaseNotes: null })) })
      .finally(() => { setSkillUpdateBusy(null) })
  }
  const restartAndInstallSkillPackage = () => {
    setSkillUpdateBusy('install')
    void installSkillUpdate().then(setSkillUpdateSnapshot)
      .catch(() => { setSkillUpdateSnapshot(current => ({ status: 'error', currentVersion: current?.currentVersion ?? '未知', latestVersion: null, message: '技能包更新未能启用，请稍后重试', releaseNotes: null })) })
      .finally(() => { setSkillUpdateBusy(null) })
  }
  const activeSkillVersion = skillUpdateSnapshot?.currentVersion
  const activeSkillVersionLabel = activeSkillVersion === undefined || activeSkillVersion === '未知'
    ? '未知' : `V${activeSkillVersion}`
  const normalizedWorkspaceQuery = workspaceQuery.trim().toLocaleLowerCase('zh-CN')
  const archivedSessions = new Set(workspaceState.archivedSessionIds)
  // A deleted conversation uses a durable tombstone so stale session scans
  // cannot resurrect it. It is not an archive and has no restore surface.
  const deletedSessions = new Set(workspaceState.deletedSessionIds)
  const workspaceRows = workspaceState.items
    .map((workspace) => {
      const pinnedSessions = new Set(workspace.pinnedSessionIds)
      const orderedSessionIds = [
        ...workspace.sessionIds.filter(sessionId => pinnedSessions.has(sessionId)),
        ...workspace.sessionIds.filter(sessionId => !pinnedSessions.has(sessionId)),
      ]
      const sessions = orderedSessionIds
        .flatMap((sessionId) => {
          const session = sessionState.byId[sessionId]
          return session === undefined || session.blank || archivedSessions.has(sessionId)
            || deletedSessions.has(sessionId) ? [] : [session]
        })
      const workspaceMatches = normalizedWorkspaceQuery !== ''
        && `${workspace.title} ${workspace.path}`.toLocaleLowerCase('zh-CN').includes(normalizedWorkspaceQuery)
      const matchingSessions = normalizedWorkspaceQuery === '' || workspaceMatches
        ? sessions
        : sessions.filter(session => session.displayTitle.toLocaleLowerCase('zh-CN').includes(normalizedWorkspaceQuery))
      return {
        workspace,
        sessions: matchingSessions,
        matches: normalizedWorkspaceQuery === '' || workspaceMatches || matchingSessions.length > 0,
      }
    })
    .filter(row => row.matches)
  const sessionWorkspaceMoveTargets = sessionMenu === null
    ? []
    : workspaceState.items.filter(
      item => item.workspaceId !== sessionMenu.workspaceId && isConcreteEnterpriseWorkspacePath(item.path),
    )
  const openSidebarSession = (workspaceId: WorkspaceId, sessionId: SessionId) => {
    setWorkspaceNavigationError(null)
    void openWorkspaceSession(workspaceId, sessionId).catch((cause: unknown) => {
      setWorkspaceNavigationError(productError(cause, 'navigation'))
    })
  }
  const archiveSidebarSession = (workspaceId: WorkspaceId, sessionId: SessionId) => {
    setSessionMenu(null)
    setSessionSubmenu(null)
    setArchiveBusyId(sessionId)
    setWorkspaceNavigationError(null)
    void archiveWorkspaceSession(workspaceId, sessionId)
      .catch((cause: unknown) => { setWorkspaceNavigationError(productError(cause, 'navigation')) })
      .finally(() => { setArchiveBusyId(null) })
  }
  const copySidebarSession = (workspaceId: WorkspaceId, sessionId: SessionId) => {
    setSessionMenu(null)
    setSessionSubmenu(null)
    setArchiveBusyId(sessionId)
    setWorkspaceNavigationError(null)
    void copyWorkspaceSession(workspaceId, sessionId)
      .catch((cause: unknown) => { setWorkspaceNavigationError(productError(cause, 'navigation')) })
      .finally(() => { setArchiveBusyId(null) })
  }
  const beginRenameSidebarSession = (workspaceId: WorkspaceId, sessionId: SessionId) => {
    const title = sessionState.byId[sessionId]?.displayTitle ?? ''
    setSessionMenu(null)
    setSessionSubmenu(null)
    setRenameSessionValue(title)
    setRenameSessionTarget({ workspaceId, sessionId })
  }
  const renameSidebarSession = () => {
    if (renameSessionTarget === null) return
    const { workspaceId, sessionId } = renameSessionTarget
    setArchiveBusyId(sessionId)
    setWorkspaceNavigationError(null)
    void renameWorkspaceSession(workspaceId, sessionId, renameSessionValue)
      .then(() => { setRenameSessionTarget(null); setRenameSessionValue('') })
      .catch((cause: unknown) => { setWorkspaceNavigationError(productError(cause, 'navigation')) })
      .finally(() => { setArchiveBusyId(null) })
  }
  const deleteSidebarSession = () => {
    if (deleteSessionTarget === null) return
    const sessionId = deleteSessionTarget
    setArchiveBusyId(sessionId)
    setWorkspaceNavigationError(null)
    void deleteWorkspaceSession(sessionId)
      .then(() => { setDeleteSessionTarget(null) })
      .catch((cause: unknown) => { setWorkspaceNavigationError(productError(cause, 'navigation')) })
      .finally(() => { setArchiveBusyId(null) })
  }
  const openSessionMenu = (
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    x: number,
    y: number,
    trigger?: HTMLElement | null,
  ) => {
    sessionMenuTriggerRef.current = trigger ?? null
    setWorkspaceMenu(null)
    setSessionSubmenu(null)
    setSessionMenu({
      workspaceId,
      sessionId,
      x: Math.max(8, Math.min(x, window.innerWidth - 204)),
      y: Math.max(8, Math.min(y, window.innerHeight - 238)),
    })
  }
  const copySessionValue = async (label: string, value: string) => {
    setSessionMenu(null)
    setSessionSubmenu(null)
    const accepted = await writeClipboard(value)
    setWorkspaceNavigationError(accepted ? `${label}已复制` : `${label}复制失败，请改用手动复制`)
  }
  const moveSessionToWorkspaceTarget = (target: WorkspaceId | null) => {
    if (sessionMenu === null || target === null || target === sessionMenu.workspaceId) return
    const { sessionId } = sessionMenu
    setSessionMenu(null)
    setSessionSubmenu(null)
    setArchiveBusyId(sessionId)
    setWorkspaceNavigationError(null)
    void moveWorkspaceSession(sessionId, target)
      .catch((cause: unknown) => { setWorkspaceNavigationError(productError(cause, 'navigation')) })
      .finally(() => { setArchiveBusyId(null) })
  }
  const setSidebarSessionPinned = (
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    pinned: boolean,
  ) => {
    setSessionMenu(null)
    setSessionSubmenu(null)
    setArchiveBusyId(sessionId)
    setWorkspaceNavigationError(null)
    void setWorkspaceSessionPinned(workspaceId, sessionId, pinned)
      .catch((cause: unknown) => { setWorkspaceNavigationError(productError(cause, 'navigation')) })
      .finally(() => { setArchiveBusyId(null) })
  }
  const openWorkspaceMenu = (
    workspaceId: WorkspaceId,
    x: number,
    y: number,
    trigger?: HTMLElement | null,
  ) => {
    workspaceMenuTriggerRef.current = trigger ?? null
    setSessionMenu(null)
    setSessionSubmenu(null)
    setWorkspaceMenu({
      workspaceId,
      x: Math.max(8, Math.min(x, window.innerWidth - 204)),
      y: Math.max(8, Math.min(y, window.innerHeight - 150)),
    })
  }
  const beginRenameSidebarWorkspace = (workspaceId: WorkspaceId) => {
    const title = workspaceState.items.find(item => item.workspaceId === workspaceId)?.title ?? ''
    setWorkspaceMenu(null)
    setRenameWorkspaceValue(title)
    setRenameWorkspaceTarget(workspaceId)
  }
  const renameSidebarWorkspace = () => {
    if (renameWorkspaceTarget === null) return
    const workspaceId = renameWorkspaceTarget
    setArchiveBusyId(workspaceId)
    setWorkspaceNavigationError(null)
    void renameWorkspace(workspaceId, renameWorkspaceValue.trim())
      .then(() => { setRenameWorkspaceTarget(null); setRenameWorkspaceValue('') })
      .catch((cause: unknown) => { setWorkspaceNavigationError(productError(cause, 'navigation')) })
      .finally(() => { setArchiveBusyId(null) })
  }
  const archiveSidebarWorkspace = (workspaceId: WorkspaceId) => {
    setWorkspaceMenu(null)
    setArchiveBusyId(workspaceId)
    setWorkspaceNavigationError(null)
    void archiveWorkspace(workspaceId)
      .catch((cause: unknown) => { setWorkspaceNavigationError(productError(cause, 'navigation')) })
      .finally(() => { setArchiveBusyId(null) })
  }
  const deleteSidebarWorkspace = () => {
    if (deleteWorkspaceTarget === null) return
    const workspaceId = deleteWorkspaceTarget
    setArchiveBusyId(workspaceId)
    setWorkspaceNavigationError(null)
    void deleteWorkspace(workspaceId)
      .then(() => { setDeleteWorkspaceTarget(null) })
      .catch((cause: unknown) => { setWorkspaceNavigationError(productError(cause, 'navigation')) })
      .finally(() => { setArchiveBusyId(null) })
  }
  const clearSidebarDrag = () => {
    if (sidebarDragHoldTimer.current !== null) clearTimeout(sidebarDragHoldTimer.current)
    sidebarDragHoldTimer.current = null
    sidebarDragReadyRef.current = null
    sidebarDragRef.current = null
    sidebarDropRef.current = null
    sidebarDragPointerIdRef.current = null
    setSidebarDragReady(null)
    setSidebarDrag(null)
    setSidebarDragPoint(null)
    setSidebarDrop(null)
  }
  const cancelSidebarDragHold = () => {
    if (sidebarDragRef.current !== null) return
    if (sidebarDragHoldTimer.current !== null) clearTimeout(sidebarDragHoldTimer.current)
    sidebarDragHoldTimer.current = null
    sidebarDragReadyRef.current = null
    sidebarDragPointerIdRef.current = null
    setSidebarDragReady(null)
  }
  const prepareSidebarDrag = (
    event: PointerEvent<HTMLElement>,
    drag: SidebarDragState,
    disabled: boolean,
  ) => {
    if (disabled || event.button !== 0 || !event.isPrimary) return
    cancelSidebarDragHold()
    const target = event.currentTarget
    const pointerId = event.pointerId
    const point = { x: event.clientX, y: event.clientY }
    sidebarDragPointerIdRef.current = pointerId
    sidebarDragHoldTimer.current = setTimeout(() => {
      sidebarDragHoldTimer.current = null
      sidebarDragReadyRef.current = drag
      sidebarDragRef.current = drag
      setSidebarDragReady(drag)
      setSidebarDrag(drag)
      setSidebarDragPoint(point)
      try { target.setPointerCapture(pointerId) } catch { /* pointer may already be captured by the platform */ }
    }, SIDEBAR_DRAG_HOLD_MS)
  }
  const updateSidebarDrop = (next: SidebarDropState) => {
    sidebarDropRef.current = next
    setSidebarDrop(previous => sameSidebarDrop(previous, next) ? previous : next)
  }
  const moveSidebarDragPreview = (x: number, y: number) => {
    const preview = sidebarDragPreviewRef.current
    if (preview === null) return
    preview.style.left = `${Math.max(8, Math.min(x + 12, Math.max(8, window.innerWidth - 228)))}px`
    preview.style.top = `${Math.max(8, Math.min(y + 12, Math.max(8, window.innerHeight - 48)))}px`
  }
  const runSidebarDrop = (operation: () => Promise<void>) => {
    setWorkspaceNavigationError(null)
    void Promise.resolve()
      .then(operation)
      .catch((cause: unknown) => { setWorkspaceNavigationError(productError(cause, 'navigation')) })
      .finally(clearSidebarDrag)
  }
  const movePointerSidebarDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = sidebarDragRef.current
    if (drag === null || sidebarDragPointerIdRef.current !== event.pointerId) return
    moveSidebarDragPreview(event.clientX, event.clientY)
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    if (!(hit instanceof HTMLElement)) {
      sidebarDropRef.current = null
      setSidebarDrop(null)
      return
    }
    const sessionTarget = hit.closest<HTMLElement>('[data-sidebar-session-id][data-sidebar-workspace-id]')
    if (drag.kind === 'session' && sessionTarget !== null) {
      const workspaceId = sessionTarget.dataset.sidebarWorkspaceId as WorkspaceId | undefined
      const sessionId = sessionTarget.dataset.sidebarSessionId as SessionId | undefined
      if (workspaceId !== undefined && sessionId !== undefined) {
        const rect = sessionTarget.getBoundingClientRect()
        updateSidebarDrop({
          kind: 'session', workspaceId, sessionId,
          edge: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
        })
        return
      }
    }
    const workspaceTarget = hit.closest<HTMLElement>('[data-sidebar-workspace-id]')
    const workspaceId = workspaceTarget?.dataset.sidebarWorkspaceId as WorkspaceId | undefined
    if (workspaceTarget === null || workspaceId === undefined) {
      sidebarDropRef.current = null
      setSidebarDrop(null)
      return
    }
    if (drag.kind === 'session') {
      updateSidebarDrop({ kind: 'session', workspaceId, edge: 'end' })
      return
    }
    const toggle = workspaceTarget.querySelector<HTMLElement>('[data-sidebar-workspace-toggle]')
      ?? workspaceTarget
    const rect = toggle.getBoundingClientRect()
    updateSidebarDrop({
      kind: 'workspace', workspaceId,
      edge: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
    })
  }
  const finishPointerSidebarDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = sidebarDragRef.current
    if (drag === null || sidebarDragPointerIdRef.current !== event.pointerId) {
      cancelSidebarDragHold()
      return
    }
    sidebarSuppressClickRef.current = true
    const drop = sidebarDropRef.current
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* capture may already be released */ }
    if (drop === null) {
      clearSidebarDrag()
      return
    }
    if (drag.kind === 'workspace') {
      if (drop.kind !== 'workspace' || drag.workspaceId === drop.workspaceId) {
        clearSidebarDrag()
        return
      }
      const anchor = sidebarInsertBeforeAnchor(
        workspaceState.items.map(item => item.workspaceId),
        drag.workspaceId,
        drop.workspaceId,
        drop.edge,
      )
      runSidebarDrop(() => reorderWorkspace(drag.workspaceId, anchor))
      return
    }
    if (drop.kind !== 'session') {
      clearSidebarDrag()
      return
    }
    if (drag.workspaceId !== drop.workspaceId) {
      runSidebarDrop(() => moveWorkspaceSession(drag.sessionId, drop.workspaceId))
      return
    }
    if (drop.sessionId === drag.sessionId) {
      clearSidebarDrag()
      return
    }
    const workspace = workspaceState.items.find(item => item.workspaceId === drop.workspaceId)
    if (workspace === undefined) {
      clearSidebarDrag()
      return
    }
    const anchor = drop.sessionId === undefined
      ? undefined
      : sidebarInsertBeforeAnchor(workspace.sessionIds, drag.sessionId, drop.sessionId, drop.edge === 'end' ? 'after' : drop.edge)
    runSidebarDrop(() => reorderWorkspaceSession(drop.workspaceId, drag.sessionId, anchor))
  }
  const sessionMenuPinned = sessionMenu === null
    ? false
    : workspaceState.items
      .find(item => item.workspaceId === sessionMenu.workspaceId)
      ?.pinnedSessionIds.includes(sessionMenu.sessionId) === true
  const sidebarDragLabel = sidebarDrag === null
    ? null
    : sidebarDrag.kind === 'workspace'
      ? workspaceState.items.find(item => item.workspaceId === sidebarDrag.workspaceId)?.title ?? '企业空间'
      : sessionState.byId[sidebarDrag.sessionId]?.blank
        ? '新任务（未开始）'
        : sessionState.byId[sidebarDrag.sessionId]?.displayTitle ?? '对话'
  const sidebarDragPreviewPosition = sidebarDragPoint === null
    ? null
    : {
      left: Math.max(8, Math.min(sidebarDragPoint.x + 12, Math.max(8, window.innerWidth - 228))),
      top: Math.max(8, Math.min(sidebarDragPoint.y + 12, Math.max(8, window.innerHeight - 48))),
    }

  return (
    <aside
      className={css.sidebar}
      data-gongchuang-product-root="sidebar"
      data-collapsed={collapsed || undefined}
      style={{ width }}
    >
      <div className={css.brandBlock}>
        <img
          className={css.brandMark}
          src={BRAND_MARK_DATA_URL}
          alt="洞见"
          title="洞见"
        />
        {wide && <div className={css.brandCopy}>
          <strong>洞见</strong>
          <button type="button" className={css.regionPill} aria-label={`切换城市，当前${selectedRegion.label}`} onClick={() => { setRegionDraft(connectors.snapshot.region); setRegionError(null); setRegionOpen(true) }}>
            <Icon name="location" size={13} /><span>{selectedRegion.id === 'all' ? '全部' : selectedRegion.label}</span>
          </button>
        </div>}
      </div>

      <nav className={css.nav} aria-label="主导航">
        {NAV.map(item => (
          <button
            type="button"
            key={item.id}
            className={css.navItem}
            data-active={page === item.id || undefined}
            aria-label={item.label}
            aria-current={page === item.id ? 'page' : undefined}
            onClick={() => {
              navigate(item.id)
              if (item.id === 'assistant') startSession()
            }}
          >
            <span className={css.navIcon}><Icon name={item.icon} /></span>
            {wide && <span className={css.navCopy}><strong>{item.label}</strong><small>{item.id === 'enterprise' ? `${workspaceCount} 个空间` : item.caption}</small></span>}
          </button>
        ))}
      </nav>

      {wide && <section className={css.workspaceBrowser} aria-label="最近对话">
        <div className={css.workspaceBrowserTitle}><strong>最近对话</strong><span>{workspaceCount === 0 ? '无' : `${workspaceCount} 个空间`}</span></div>
        <label className={css.workspaceFilter}>
          <Icon name="search" size={15} />
          <input
            aria-label="筛选企业空间和会话"
            value={workspaceQuery}
            onChange={(event) => { setWorkspaceQuery(event.currentTarget.value) }}
            placeholder="搜索企业或最近对话"
          />
        </label>
        <div className={css.workspaceTree}>
          {workspaceRows.length === 0
            ? <p className={css.workspaceTreeEmpty}>{workspaceCount === 0 ? '无' : '没有匹配的企业或会话'}</p>
            : workspaceRows.map(({ workspace, sessions }) => {
              const open = normalizedWorkspaceQuery !== '' || expandedWorkspace === workspace.workspaceId
              const all = normalizedWorkspaceQuery !== '' || showAllWorkspace === workspace.workspaceId
              const visibleSessions = all ? sessions.slice(0, 20) : sessions.slice(0, 5)
              const remainingSessions = Math.max(0, sessions.length - visibleSessions.length)
              const workspaceDragIdentity: SidebarDragState = {
                kind: 'workspace', workspaceId: workspace.workspaceId,
              }
              const workspaceDragReady = sameSidebarDrag(sidebarDragReady, workspaceDragIdentity)
              return <div
                className={css.workspaceTreeGroup}
                key={workspace.workspaceId}
                data-sidebar-workspace-id={workspace.workspaceId}
                data-open={open || undefined}
                data-drag-ready={workspaceDragReady || undefined}
                data-dragging={sidebarDrag?.kind === 'workspace' && sidebarDrag.workspaceId === workspace.workspaceId || undefined}
                data-drop-edge={sidebarDrop?.kind === 'workspace' && sidebarDrop.workspaceId === workspace.workspaceId
                  ? sidebarDrop.edge
                  : sidebarDrop?.kind === 'session' && sidebarDrop.workspaceId === workspace.workspaceId && sidebarDrop.sessionId === undefined
                    ? 'inside'
                    : undefined}
              >
                <button
                  type="button"
                  className={css.workspaceTreeToggle}
                  draggable={false}
                  data-sidebar-workspace-toggle=""
                  aria-expanded={open}
                  aria-label={normalizedWorkspaceQuery !== ''
                    ? `${workspace.title} 搜索结果，${sessions.length === 0 ? '无对话' : `共 ${sessions.length} 个对话`}`
                    : `${open ? '收起' : '展开'} ${workspace.title}，${sessions.length === 0 ? '无对话' : `共 ${sessions.length} 个对话`}`}
                  onClick={(event) => {
                    if (sidebarSuppressClickRef.current) {
                      sidebarSuppressClickRef.current = false
                      event.preventDefault()
                      return
                    }
                    if (normalizedWorkspaceQuery !== '') return
                    setExpandedWorkspace(open ? null : workspace.workspaceId)
                    setShowAllWorkspace(null)
                  }}
                  aria-disabled={normalizedWorkspaceQuery !== '' || undefined}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    openWorkspaceMenu(
                      workspace.workspaceId,
                      event.clientX,
                      event.clientY,
                      event.currentTarget,
                    )
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                    event.preventDefault()
                    const rect = event.currentTarget.getBoundingClientRect()
                    openWorkspaceMenu(
                      workspace.workspaceId,
                      rect.left + 18,
                      rect.bottom,
                      event.currentTarget,
                    )
                  }}
                  onPointerDown={(event) => {
                    prepareSidebarDrag(event, workspaceDragIdentity, normalizedWorkspaceQuery !== '')
                  }}
                  onPointerMove={movePointerSidebarDrag}
                  onPointerUp={finishPointerSidebarDrag}
                  onPointerCancel={clearSidebarDrag}
                  onLostPointerCapture={() => { if (sidebarDragRef.current !== null) clearSidebarDrag() }}
                >
                  <Icon name="folder" size={16} />
                  <span>{workspace.title}</span>
                  <small>{sessions.length === 0 ? '无' : sessions.length}</small>
                  <span className={css.workspaceTreeChevron}>⌄</span>
                </button>
                <button
                  type="button"
                  className={css.workspaceTreeAction}
                  aria-label={`更多操作：${workspace.title}`}
                  aria-haspopup="menu"
                  aria-expanded={workspaceMenu?.workspaceId === workspace.workspaceId || undefined}
                  onClick={(event) => {
                    event.stopPropagation()
                    const rect = event.currentTarget.getBoundingClientRect()
                    openWorkspaceMenu(
                      workspace.workspaceId,
                      rect.right - 180,
                      rect.bottom,
                      event.currentTarget,
                    )
                  }}
                ><IconEllipsisOutline16 size={15} /></button>
                {open && <div className={css.workspaceSessionList}>
                  {visibleSessions.length === 0
                    ? <p>无</p>
                    : visibleSessions.map((session) => {
                      const sessionDragIdentity: SidebarDragState = {
                        kind: 'session', workspaceId: workspace.workspaceId, sessionId: session.id,
                      }
                      const sessionDragReady = sameSidebarDrag(sidebarDragReady, sessionDragIdentity)
                      return <div
                        className={css.workspaceSessionRow}
                        key={session.id}
                        data-sidebar-workspace-id={workspace.workspaceId}
                        data-sidebar-session-id={session.id}
                        data-active={page === 'assistant' && sessionState.current === session.id || undefined}
                        data-drag-ready={sessionDragReady || undefined}
                        data-dragging={sidebarDrag?.kind === 'session' && sidebarDrag.sessionId === session.id || undefined}
                        data-drop-edge={sidebarDrop?.kind === 'session'
                          && sidebarDrop.workspaceId === workspace.workspaceId
                          && sidebarDrop.sessionId === session.id
                          ? sidebarDrop.edge
                          : undefined}
                      >
                        <button
                          type="button"
                          className={css.workspaceSessionButton}
                          draggable={false}
                          aria-label={session.blank ? '新任务（未开始）' : session.displayTitle}
                          aria-describedby={`recent-session-meta-${session.id}`}
                          data-active={page === 'assistant' && sessionState.current === session.id || undefined}
                          aria-current={page === 'assistant' && sessionState.current === session.id ? 'page' : undefined}
                          onClick={(event) => {
                            if (sidebarSuppressClickRef.current) {
                              sidebarSuppressClickRef.current = false
                              event.preventDefault()
                              return
                            }
                            openSidebarSession(workspace.workspaceId, session.id)
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault()
                            openSessionMenu(workspace.workspaceId, session.id, event.clientX, event.clientY, event.currentTarget)
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                            event.preventDefault()
                            const rect = event.currentTarget.getBoundingClientRect()
                            openSessionMenu(workspace.workspaceId, session.id, rect.left + 18, rect.bottom, event.currentTarget)
                          }}
                          onPointerDown={(event) => {
                            prepareSidebarDrag(
                              event,
                              sessionDragIdentity,
                              normalizedWorkspaceQuery !== '' || session.running,
                            )
                          }}
                          onPointerMove={movePointerSidebarDrag}
                          onPointerUp={finishPointerSidebarDrag}
                          onPointerCancel={clearSidebarDrag}
                          onLostPointerCapture={() => { if (sidebarDragRef.current !== null) clearSidebarDrag() }}
                          title={session.displayTitle}
                        >
                          <span>{session.blank ? '新任务（未开始）' : session.displayTitle}</span>
                          <small id={`recent-session-meta-${session.id}`}>{sidebarSessionTime(session.updatedAt)}{pendingInteractions.has(session.id) ? ` · ${t('session.waiting')}` : session.running ? ' · 运行中' : ''}</small>
                        </button>
                        {!session.blank && <div className={css.workspaceSessionActions} aria-label={`对话操作：${session.displayTitle}`}>
                          <Tooltip label="更多" side="top" delayMs={400}>
                            <button
                              type="button"
                              className={css.workspaceSessionAction}
                              aria-label={`更多操作：${session.displayTitle}`}
                              aria-haspopup="menu"
                              aria-expanded={sessionMenu?.sessionId === session.id || undefined}
                              onClick={(event) => {
                                event.stopPropagation()
                                const rect = event.currentTarget.getBoundingClientRect()
                                openSessionMenu(workspace.workspaceId, session.id, rect.right - 192, rect.bottom, event.currentTarget)
                              }}
                            ><IconEllipsisOutline16 size={15} /></button>
                          </Tooltip>
                          <Tooltip label="归档" side="top" delayMs={400}>
                            <button
                              type="button"
                              className={css.workspaceSessionAction}
                              aria-label={`归档对话：${session.displayTitle}`}
                              disabled={archiveBusyId !== null}
                              onClick={() => { archiveSidebarSession(workspace.workspaceId, session.id) }}
                            ><IconArchiveOutline20 size={15} /></button>
                          </Tooltip>
                          <Tooltip label={workspace.pinnedSessionIds.includes(session.id) ? '取消固定' : '固定'} side="top" delayMs={400}>
                            <button
                              type="button"
                              className={css.workspaceSessionAction}
                              aria-label={`${workspace.pinnedSessionIds.includes(session.id) ? '取消固定' : '固定'}对话：${session.displayTitle}`}
                              aria-pressed={workspace.pinnedSessionIds.includes(session.id)}
                              disabled={archiveBusyId !== null}
                              onClick={() => {
                                setSidebarSessionPinned(
                                  workspace.workspaceId,
                                  session.id,
                                  !workspace.pinnedSessionIds.includes(session.id),
                                )
                              }}
                            ><IconPinOutline16 size={15} /></button>
                          </Tooltip>
                        </div>}
                      </div>})}
                  {normalizedWorkspaceQuery === '' && sessions.length > 5 && <button
                    type="button"
                    className={css.workspaceShowMore}
                    onClick={() => { setShowAllWorkspace(all ? null : workspace.workspaceId) }}
                  >{all ? sessions.length > 20 ? '收起至 5 项（当前最多显示 20 项）' : '收起显示' : `展开显示其余 ${Math.min(remainingSessions, 15)} 项`}</button>}
                </div>}
              </div>
            })}
        </div>
        {(workspaceNavigationError ?? navigationError) !== null && <p className={css.workspaceBrowserError} role="alert">{workspaceNavigationError ?? navigationError}</p>}
        <button type="button" className={css.workspaceOverviewLink} onClick={() => { navigate('enterprise') }}>打开企业空间总览</button>
      </section>}

      {sidebarDrag !== null && sidebarDragLabel !== null && sidebarDragPreviewPosition !== null && <div
        ref={sidebarDragPreviewRef}
        className={css.sidebarDragPreview}
        data-sidebar-drag-preview=""
        aria-hidden="true"
        style={sidebarDragPreviewPosition}
      >
        <Icon name={sidebarDrag.kind === 'workspace' ? 'folder' : 'spark'} size={14} />
        <span>{sidebarDragLabel}</span>
      </div>}

      {workspaceMenu !== null && <div
        ref={workspaceMenuRef}
        className={css.sessionContextMenu}
        role="menu"
        aria-label="企业空间操作"
        style={{ left: workspaceMenu.x, top: workspaceMenu.y }}
        onKeyDown={(event) => {
          const items = Array.from(workspaceMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length
            items[next]?.focus()
          } else if (event.key === 'Home') {
            event.preventDefault(); items[0]?.focus()
          } else if (event.key === 'End') {
            event.preventDefault(); items.at(-1)?.focus()
          }
        }}
      >
        <button type="button" role="menuitem" autoFocus disabled={archiveBusyId !== null} onClick={() => {
          beginRenameSidebarWorkspace(workspaceMenu.workspaceId)
        }}>编辑企业名称</button>
        <button type="button" role="menuitem" disabled={archiveBusyId !== null} onClick={() => {
          archiveSidebarWorkspace(workspaceMenu.workspaceId)
        }}>归档企业空间</button>
        <button type="button" role="menuitem" className={css.contextDanger} disabled={archiveBusyId !== null} onClick={() => {
          setDeleteWorkspaceTarget(workspaceMenu.workspaceId)
          setWorkspaceMenu(null)
        }}>删除企业空间</button>
      </div>}

      {sessionMenu !== null && <div
        ref={sessionMenuRef}
        className={css.sessionContextMenu}
        role="menu"
        aria-label="对话操作"
        onKeyDown={(event) => {
          const items = Array.from(sessionMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length
            items[next]?.focus()
          } else if (event.key === 'Home') {
            event.preventDefault(); items[0]?.focus()
          } else if (event.key === 'End') {
            event.preventDefault(); items.at(-1)?.focus()
          }
        }}
        style={{ left: sessionMenu.x, top: sessionMenu.y }}
        onMouseLeave={() => { setSessionSubmenu(null) }}
      >
        <button type="button" role="menuitem" autoFocus onMouseEnter={() => { setSessionSubmenu(null) }} onFocus={() => { setSessionSubmenu(null) }} onClick={() => { setSessionMenu(null); openSidebarSession(sessionMenu.workspaceId, sessionMenu.sessionId) }}>打开对话</button>
        <button type="button" role="menuitem" disabled={archiveBusyId !== null} onMouseEnter={() => { setSessionSubmenu(null) }} onFocus={() => { setSessionSubmenu(null) }} onClick={() => { copySidebarSession(sessionMenu.workspaceId, sessionMenu.sessionId) }}>复制对话</button>
        <div className={css.sessionMenuGroup} onMouseEnter={() => { setSessionSubmenu('copy') }}>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={sessionSubmenu === 'copy'}
            data-session-copy-submenu-trigger=""
            onClick={() => { setSessionSubmenu('copy') }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight') return
              event.preventDefault()
              setSessionSubmenu('copy')
              window.queueMicrotask(() => {
                sessionMenuRef.current?.querySelector<HTMLButtonElement>('[aria-label="复制"] [role="menuitem"]')?.focus()
              })
            }}
          >复制<span aria-hidden="true">›</span></button>
          {sessionSubmenu === 'copy' && <div
            className={css.sessionSubmenu}
            role="menu"
            aria-label="复制"
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              setSessionSubmenu(null)
              sessionMenuRef.current?.querySelector<HTMLButtonElement>('[data-session-copy-submenu-trigger]')?.focus()
            }}
          >
            <button type="button" role="menuitem" onClick={() => {
              const session = sessionState.byId[sessionMenu.sessionId]
              void copySessionValue('工作目录', session?.cwd ?? '')
            }}>复制工作目录</button>
            <button type="button" role="menuitem" onClick={() => {
              void copySessionValue('深链接', sessionDeepLink(sessionMenu.sessionId))
            }}>复制深链接</button>
          </div>}
        </div>
        <button type="button" role="menuitem" disabled={archiveBusyId !== null} onMouseEnter={() => { setSessionSubmenu(null) }} onFocus={() => { setSessionSubmenu(null) }} onClick={() => { beginRenameSidebarSession(sessionMenu.workspaceId, sessionMenu.sessionId) }}>重命名</button>
        <button
          type="button"
          role="menuitem"
          aria-pressed={sessionMenuPinned}
          disabled={archiveBusyId !== null}
          onMouseEnter={() => { setSessionSubmenu(null) }}
          onFocus={() => { setSessionSubmenu(null) }}
          onClick={() => {
            setSidebarSessionPinned(sessionMenu.workspaceId, sessionMenu.sessionId, !sessionMenuPinned)
          }}
        >{sessionMenuPinned ? '取消固定' : '固定对话'}</button>
        <div className={css.sessionMenuGroup} onMouseEnter={() => { setSessionSubmenu('workspace') }}>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={sessionSubmenu === 'workspace'}
            disabled={archiveBusyId !== null}
            data-session-workspace-submenu-trigger=""
            onClick={() => { setSessionSubmenu('workspace') }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight') return
              event.preventDefault()
              setSessionSubmenu('workspace')
              window.queueMicrotask(() => {
                sessionMenuRef.current?.querySelector<HTMLButtonElement>('[aria-label="移动到企业空间"] [role="menuitem"]')?.focus()
              })
            }}
          >移动到企业空间<span aria-hidden="true">›</span></button>
          {sessionSubmenu === 'workspace' && <div
            className={css.sessionSubmenu}
            role="menu"
            aria-label="移动到企业空间"
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              setSessionSubmenu(null)
              sessionMenuRef.current?.querySelector<HTMLButtonElement>('[data-session-workspace-submenu-trigger]')?.focus()
            }}
          >
            {sessionWorkspaceMoveTargets.length === 0
              ? <p className={css.sessionSubmenuEmpty} role="status" aria-label="无可移动的企业空间">无</p>
              : sessionWorkspaceMoveTargets.map(target => <button
                key={target.workspaceId}
                type="button"
                role="menuitem"
                disabled={archiveBusyId !== null}
                onClick={() => { moveSessionToWorkspaceTarget(target.workspaceId) }}
              >{target.title}</button>)}
          </div>}
        </div>
        <button type="button" role="menuitem" disabled={archiveBusyId !== null} onMouseEnter={() => { setSessionSubmenu(null) }} onFocus={() => { setSessionSubmenu(null) }} onClick={() => { archiveSidebarSession(sessionMenu.workspaceId, sessionMenu.sessionId) }}>归档对话</button>
        <button type="button" role="menuitem" className={css.contextDanger} disabled={archiveBusyId !== null} onMouseEnter={() => { setSessionSubmenu(null) }} onFocus={() => { setSessionSubmenu(null) }} onClick={() => {
          setDeleteSessionTarget(sessionMenu.sessionId)
          setSessionMenu(null)
        }}>删除对话</button>
      </div>}

      {renameWorkspaceTarget !== null && <div className={css.dialogBackdrop} role="presentation" onMouseDown={() => { if (archiveBusyId === null) setRenameWorkspaceTarget(null) }}>
        <section ref={workspaceRenameDialogRef} className={css.confirmDialog} role="dialog" aria-modal="true" aria-label="编辑企业名称" aria-describedby="rename-workspace-description" onMouseDown={(event) => { event.stopPropagation() }}>
          <h2>编辑企业名称</h2>
          <p id="rename-workspace-description">只修改企业空间在客户端中的显示名称，不会重命名本地目录。</p>
          <form onSubmit={(event) => { event.preventDefault(); renameSidebarWorkspace() }}>
            <label className={css.accountField}><span>企业名称</span><input aria-label="企业名称" autoFocus value={renameWorkspaceValue} onChange={(event) => { setRenameWorkspaceValue(event.currentTarget.value) }} required /></label>
            <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={archiveBusyId !== null} onClick={() => { setRenameWorkspaceTarget(null) }}>取消</button><button type="submit" className={css.solidButton} disabled={archiveBusyId !== null || renameWorkspaceValue.trim() === ''}>{archiveBusyId === renameWorkspaceTarget ? '正在保存…' : '保存'}</button></div>
          </form>
        </section>
      </div>}

      {deleteWorkspaceTarget !== null && <div className={css.dialogBackdrop} role="presentation" onMouseDown={() => { if (archiveBusyId === null) setDeleteWorkspaceTarget(null) }}>
        <section ref={workspaceDeleteDialogRef} className={css.confirmDialog} role="dialog" aria-modal="true" aria-label="删除企业空间" aria-describedby="delete-workspace-description" onMouseDown={(event) => { event.stopPropagation() }}>
          <h2>删除企业空间</h2>
          <p id="delete-workspace-description">企业目录、文件和会话记录会移入系统废纸篓或回收站，并从客户端全部列表中删除；客户端不提供恢复入口。</p>
          <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={archiveBusyId !== null} onClick={() => { setDeleteWorkspaceTarget(null) }}>取消</button><button type="button" className={css.dangerButton} disabled={archiveBusyId !== null} onClick={deleteSidebarWorkspace}>{archiveBusyId === deleteWorkspaceTarget ? '正在删除…' : '确认删除'}</button></div>
        </section>
      </div>}

      {renameSessionTarget !== null && <div className={css.dialogBackdrop} role="presentation" onMouseDown={() => { if (archiveBusyId === null) setRenameSessionTarget(null) }}>
        <section ref={sidebarRenameDialogRef} className={css.confirmDialog} role="dialog" aria-modal="true" aria-label="重命名对话" aria-describedby="rename-session-description" onMouseDown={(event) => { event.stopPropagation() }}>
          <h2>重命名对话</h2>
          <p id="rename-session-description">标题只影响最近对话显示，不会修改对话内容。</p>
          <form onSubmit={(event) => { event.preventDefault(); renameSidebarSession() }}>
            <label className={css.accountField}><span>对话名称</span><input aria-label="对话名称" autoFocus value={renameSessionValue} onChange={(event) => { setRenameSessionValue(event.currentTarget.value) }} required /></label>
            <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={archiveBusyId !== null} onClick={() => { setRenameSessionTarget(null) }}>取消</button><button type="submit" className={css.solidButton} disabled={archiveBusyId !== null || renameSessionValue.trim() === ''}>{archiveBusyId === renameSessionTarget.sessionId ? '正在保存…' : '保存'}</button></div>
          </form>
        </section>
      </div>}

      {deleteSessionTarget !== null && <div className={css.dialogBackdrop} role="presentation" onMouseDown={() => { if (archiveBusyId === null) setDeleteSessionTarget(null) }}>
        <section ref={sidebarDeleteDialogRef} className={css.confirmDialog} role="dialog" aria-modal="true" aria-label="删除对话" aria-describedby="delete-session-description" onMouseDown={(event) => { event.stopPropagation() }}>
          <h2>删除对话</h2>
          <p id="delete-session-description">该对话记录会移入系统废纸篓或回收站，并从最近对话和企业空间列表删除；不进入已归档列表，也不能从客户端恢复。企业目录和文件不受影响。</p>
          <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={archiveBusyId !== null} onClick={() => { setDeleteSessionTarget(null) }}>取消</button><button type="button" className={css.dangerButton} disabled={archiveBusyId !== null} onClick={deleteSidebarSession}>{archiveBusyId === deleteSessionTarget ? '正在删除…' : '确认删除'}</button></div>
        </section>
      </div>}

      <div className={css.sidebarFoot}>
        <UpdateNotification snapshot={updateSnapshot} progress={updateProgress} busy={updateBusy} compact={!wide}
          download={downloadAvailableUpdate} install={restartAndInstallUpdate} t={t} />
        <button type="button" className={css.accountCard} aria-label={t('local.profile')} onClick={() => { setProfileOpen(true) }}>
          <span className={css.avatar}>{avatarDataUrl === null ? <Icon name="user" size={17} /> : <img src={avatarDataUrl} alt="" />}</span>
          {wide && <span className={css.accountCopy}><strong>{t('local.name')}</strong><small>{PROVIDERS.find(item => item.id === provider)?.label} · {providerStatus.status === 'ready' ? t('local.modelReady') : t('local.modelSetup')}</small></span>}
          {wide && <Icon name="chevron" size={16} />}
        </button>
        <div className={css.sidebarUtilities}>
          <button type="button" aria-label="个人资料" onClick={() => { setProfileOpen(true) }}><Icon name="user" size={16} />{wide && <span>个人资料</span>}</button>
          <button type="button" aria-label="设置" onClick={openSettings}><Icon name="settings" size={16} />{wide && <span>设置</span>}</button>
        </div>
      </div>
      {profileOpen && <div className={css.dialogBackdrop} role="presentation" onMouseDown={() => { setProfileOpen(false) }}>
        <section ref={sidebarDialogRef} className={css.accountDialog} role="dialog" aria-modal="true" aria-labelledby="gongchuang-profile-title" onMouseDown={(event) => { event.stopPropagation() }}>
          <div className={css.dialogHead}><div><span className={css.eyebrow}>个人资料</span><h2 id="gongchuang-profile-title">{t('local.profile')}</h2></div><button type="button" className={css.iconButton} aria-label="关闭" onClick={() => { setProfileOpen(false) }}>×</button></div>
          <div className={css.profileEditor}>
            <span className={css.profileAvatar}>{avatarDataUrl === null ? <Icon name="user" size={24} /> : <img src={avatarDataUrl} alt={t('local.avatar')} />}</span>
            <div><strong>{t('local.name')}</strong><span>{t('local.avatarStorage')}</span></div>
          </div>
          <div className={css.dialogActions}>
            <label className={css.solidButton} data-disabled={avatarBusy || undefined}>{avatarBusy ? '正在处理…' : '选择新头像'}<input className={css.hiddenFileInput} type="file" accept="image/png,image/jpeg,image/webp" disabled={avatarBusy} onChange={chooseAvatar} /></label>
            <button type="button" className={css.outlineButton} disabled={avatarDataUrl === null || avatarBusy} onClick={resetAvatar}>恢复默认</button>
          </div>
          {avatarError !== null && <p className={css.dialogError} role="alert">{avatarError}</p>}
        </section>
      </div>}
      {settingsOpen && <div className={css.dialogBackdrop} role="presentation" onMouseDown={() => { setSettingsOpen(false) }}>
        <section ref={sidebarDialogRef} className={css.settingsDialog} role="dialog" aria-modal="true" aria-labelledby="gongchuang-settings-title" onMouseDown={(event) => { event.stopPropagation() }}>
          <div className={css.dialogHead}><div><span className={css.eyebrow}>客户端设置</span><h2 id="gongchuang-settings-title">设置</h2></div><button type="button" className={css.iconButton} aria-label="关闭" onClick={() => { setSettingsOpen(false) }}>×</button></div>
          <div className={css.settingsLayout}>
            <nav className={css.settingsNavigation} aria-label="设置分类">
              <button type="button" data-active={settingsSection === 'general' || undefined} onClick={() => { setSettingsSection('general') }}>常规</button>
              <button type="button" data-active={settingsSection === 'personalization' || undefined} onClick={() => { setSettingsSection('personalization') }}>个性化</button>
              <button type="button" data-active={settingsSection === 'memory' || undefined} onClick={() => { setSettingsSection('memory') }}>记忆</button>
              <button type="button" data-active={settingsSection === 'archived' || undefined} onClick={() => { setSettingsSection('archived') }}>已归档</button>
              <button type="button" data-active={settingsSection === 'models' || undefined} onClick={() => { setSettingsSection('models') }}>模型与连接</button>
              <button type="button" data-active={settingsSection === 'privacy' || undefined} onClick={() => { setSettingsSection('privacy') }}>数据与隐私</button>
              <button type="button" data-active={settingsSection === 'updates' || undefined} onClick={() => { setSettingsSection('updates') }}>更新与版本</button>
            </nav>
            <div className={css.settingsContent}>
              {settingsSection === 'general' && <section aria-labelledby="settings-general-title">
                <div className={css.settingsSectionHead}><h3 id="settings-general-title">常规</h3></div>
                {workspaceRootState !== undefined && <div className={css.workspaceRootSetting}>
                  <div>
                    <span className={css.workspaceRootIcon}><Icon name="folder" size={20} /></span>
                    <div><strong>企业空间根目录</strong><span title={rootState?.rootPath}>{rootLoading ? '正在读取…' : rootState?.rootPath ?? '暂时无法读取'}</span><small>切换后新建企业会放入新根目录，已连接空间及其原文件不会移动。</small></div>
                  </div>
                  <div className={css.workspaceRootActions}>
                    <button type="button" className={css.outlineButton} disabled={rootBusy || rootLoading} onClick={chooseRoot}>{rootBusy ? '正在选择…' : '更改目录'}</button>
                    <button type="button" className={css.outlineButton} disabled={rootBusy || rootLoading || rootState?.isDefault === true} onClick={restoreDefaultRoot}>恢复文稿默认目录</button>
                  </div>
                  {rootError !== null && <p className={css.dialogError} role="alert">{rootError}</p>}
                </div>}
                {readWindowsCloseBehavior !== undefined && <label className={css.closeBehaviorSetting}>
                  <strong>关闭主窗口时</strong>
                  <select
                    aria-label="关闭主窗口时"
                    value={windowsCloseBehavior ?? 'ask'}
                    disabled={closeBehaviorBusy}
                    onChange={(event) => { saveWindowsCloseBehavior(event.currentTarget.value as WindowsCloseBehavior) }}
                  >
                    <option value="ask">每次询问</option>
                    <option value="tray">最小化到托盘</option>
                    <option value="quit">退出主程序</option>
                  </select>
                  {closeBehaviorError !== null && <p className={css.dialogError} role="alert">{closeBehaviorError}</p>}
                </label>}
              </section>}
              {settingsSection === 'personalization' && <section aria-labelledby="settings-personalization-title">
                <div className={css.settingsSectionHead}><h3 id="settings-personalization-title">个性化</h3></div>
                <label className={css.personalizationEditor}>
                  <span>自定义指令</span>
                  <textarea
                    aria-label="自定义指令"
                    value={personalizationDraft}
                    maxLength={personalizationLimit}
                    disabled={personalizationBusy}
                    onChange={(event) => { setPersonalizationDraft(event.currentTarget.value); setPersonalizationNotice(null) }}
                    placeholder="例如：默认使用中文；报告先给结论再给依据；表格中的金额统一保留两位小数。"
                  />
                </label>
                <div className={css.personalizationMeta}>
                  <span>{personalizationDraft.length} / {personalizationLimit}</span>
                </div>
                {personalizationError !== null && <p className={css.dialogError} role="alert">{personalizationError}</p>}
                {personalizationNotice !== null && <p className={css.dialogSuccess} role="status">{personalizationNotice}</p>}
                <div className={css.dialogActions}>
                  <button type="button" className={css.outlineButton} disabled={personalizationBusy || personalizationDraft === personalizationDefault} onClick={resetPersonalization}>恢复默认</button>
                  <button type="button" className={css.solidButton} disabled={personalizationBusy} onClick={persistPersonalization}>{personalizationBusy ? '正在保存…' : '保存'}</button>
                </div>
              </section>}
              {settingsSection === 'memory' && <section aria-labelledby="settings-memory-title">
                <div className={css.settingsSectionHead}><h3 id="settings-memory-title">本地长期记忆</h3></div>
                {memorySnapshot === null ? <p className={css.dialogHint}>{memoryBusy ? '正在读取本机记忆…' : '暂时无法读取本机记忆。'}</p> : <>
                  <label className={css.loginOption}>
                    <input type="checkbox" checked={memorySnapshot.enabled} disabled={memoryBusy} onChange={(event) => { updateMemory({ enabled: event.currentTarget.checked }) }} />
                    <span><strong>启用本地长期记忆</strong><small>关闭后不再提取或召回，已有记忆保留，不影响普通对话。</small></span>
                  </label>
                  <label className={css.loginOption}>
                    <input type="checkbox" checked={memorySnapshot.includeToolResults} disabled={memoryBusy || !memorySnapshot.enabled} onChange={(event) => { updateMemory({ includeToolResults: event.currentTarget.checked }) }} />
                    <span><strong>允许工具返回结果参与记忆提取</strong><small>适合企业查询、文件处理和检索型任务；关闭后只从用户与助手正文提取。</small></span>
                  </label>
                  <div className={css.settingsFacts}>
                    <div><strong>个人记忆</strong><span>{memorySnapshot.personalNodes} 项</span></div>
                    <div><strong>企业记忆</strong><span>{memorySnapshot.enterpriseStores} 个独立空间</span></div>
                    <div><strong>累计内容</strong><span>{memorySnapshot.totalNodes} 项记忆 · {memorySnapshot.totalEdges} 条关系</span></div>
                  </div>
                  <div className={css.dialogActions}><button type="button" className={css.dangerButton} disabled={memoryBusy || memorySnapshot.totalNodes === 0} onClick={clearAllMemory}>{memoryBusy ? '正在处理…' : '清除全部本地记忆'}</button></div>
                </>}
                {memoryError !== null && <p className={css.dialogError} role="alert">{memoryError}</p>}
                {memoryNotice !== null && <p className={css.dialogSuccess} role="status">{memoryNotice}</p>}
              </section>}
              {settingsSection === 'archived' && <section aria-labelledby="settings-archived-title">
                <div className={css.settingsSectionHead}><h3 id="settings-archived-title">已归档</h3></div>
                <div className={css.archiveSettingsList}>
                  <h4>企业空间</h4>
                  {workspaceState.archivedItems.length === 0
                    ? <p className={css.settingsEmpty}>没有已归档的企业空间</p>
                    : workspaceState.archivedItems.map(workspace => <article key={workspace.workspaceId}>
                      <span><strong>{workspace.title}</strong><small>{workspace.path}</small></span>
                      <div className={css.archiveSettingsActions}>
                        <button type="button" className={css.outlineButton} disabled={archiveBusyId !== null} onClick={() => { restoreArchived('workspace', workspace.workspaceId) }}>{archiveBusyId === workspace.workspaceId ? '正在恢复…' : '恢复'}</button>
                        <button type="button" className={css.dangerButton} aria-label={`删除已归档企业空间：${workspace.title}`} disabled={archiveBusyId !== null} onClick={() => { deleteArchived('workspace', workspace.workspaceId) }}>{archiveBusyId === workspace.workspaceId ? '正在删除…' : '删除'}</button>
                      </div>
                    </article>)}
                  <h4>对话</h4>
                  {workspaceState.archivedSessionIds.length === 0
                    ? <p className={css.settingsEmpty}>没有已归档的对话</p>
                    : workspaceState.archivedSessionIds.map(sessionId => <article key={sessionId}>
                      <span><strong>{sessionState.byId[sessionId]?.displayTitle ?? '已归档对话'}</strong><small>会话记录仍保留在本机</small></span>
                      <div className={css.archiveSettingsActions}>
                        <button type="button" className={css.outlineButton} disabled={archiveBusyId !== null} onClick={() => { restoreArchived('session', sessionId) }}>{archiveBusyId === sessionId ? '正在恢复…' : '恢复'}</button>
                        <button type="button" className={css.dangerButton} aria-label={`删除已归档对话：${sessionState.byId[sessionId]?.displayTitle ?? '已归档对话'}`} disabled={archiveBusyId !== null} onClick={() => { deleteArchived('session', sessionId) }}>{archiveBusyId === sessionId ? '正在删除…' : '删除'}</button>
                      </div>
                    </article>)}
                </div>
                {archiveError !== null && <p className={css.dialogError} role="alert">{archiveError}</p>}
                {archiveNotice !== null && <p className={css.dialogSuccess} role="status">{archiveNotice}</p>}
              </section>}
              {settingsSection === 'models' && <section aria-labelledby="settings-models-title">
                <div className={css.settingsSectionHead}><h3 id="settings-models-title">模型与连接</h3></div>
                <div className={css.settingsModelList}>
                  {PROVIDERS.map((item) => {
                    const connection = connectivity.providers[item.id]
                    return <button type="button" key={item.id} onClick={() => {
                      setSettingsOpen(false)
                      setSettingsModelConfiguration(item.id)
                    }}><StatusDot active={connection.status === 'ready'} /><strong>{item.label}</strong><span>{connection.configured ? providerHealthLabel(connection) : gongchuangProviderDefinition(item.id).keyPlaceholder}</span></button>
                  })}
                </div>
              </section>}
              {settingsSection === 'privacy' && <section aria-labelledby="settings-privacy-title">
                <div className={css.settingsSectionHead}><h3 id="settings-privacy-title">数据与隐私</h3></div>
                <div className={css.settingsFacts}>
                  <div><strong>模型密钥</strong><span>由 macOS 钥匙串或 Windows 凭据管理器保护</span></div>
                  <div><strong>个性化指令</strong><span>仅保存在本机客户端专用目录</span></div>
                  <div><strong>企业资料与会话</strong><span>保存在本机企业空间，不随账号上传</span></div>
                  <div><strong>长期记忆</strong><span>仅保存在本机，个人与不同企业空间分库隔离</span></div>
                  <div><strong>{t('privacy.connections')}</strong><span>{t('privacy.connectionsDescription')}</span></div>
                </div>
              </section>}
              {settingsSection === 'updates' && <section aria-labelledby="settings-updates-title">
                <div className={css.settingsSectionHead}><h3 id="settings-updates-title">更新与版本</h3></div>
                <div className={css.updatePanel}>
                  <span className={css.updateIcon}><Icon name="download" size={21} /></span>
                  <div><strong>客户端更新</strong><span role="status" aria-live="polite" aria-atomic="true">{updateBusy === 'download' && updateProgress !== null ? updateProgressText(updateProgress) : updateSnapshot?.status === 'current' ? `当前 V${updateSnapshot.currentVersion}` : updateSnapshot?.message ?? '正在读取当前客户端版本，可手动检查正式更新'}</span></div>
                  {updateSnapshot?.status === 'available'
                    ? <button type="button" className={css.solidButton} disabled={updateBusy !== null} onClick={downloadAvailableUpdate}>{updateBusy === 'download' ? updateProgress === null ? '正在连接…' : updateProgress.phase === 'verifying' ? '正在验证更新' : `下载 ${String(updateProgress.percent)}%` : (updateSnapshot.resumableBytes ?? 0) > 0 ? '继续更新' : '立即更新'}</button>
                    : updateSnapshot?.status === 'downloaded'
                      ? <button type="button" className={css.solidButton} disabled={updateBusy !== null} onClick={restartAndInstallUpdate}>{t(updateBusy === 'install' ? 'update.installing' : 'update.restart')}</button>
                      : updateConfirmedCurrent
                        ? <button type="button" className={css.updateCurrentButton} disabled aria-live="polite">当前已是最新版</button>
                        : <button type="button" className={css.outlineButton} disabled={updateBusy !== null} onClick={checkUpdates}>{updateBusy === 'check' ? '正在检查…' : '检查更新'}</button>}
                </div>
                <div className={css.updatePanel}>
                  <span className={css.updateIcon}><Icon name="blocks" size={21} /></span>
                  <div><strong>技能包更新</strong><span>{skillUpdateSnapshot?.status === 'current' ? `当前 ${activeSkillVersionLabel}` : skillUpdateSnapshot?.message ?? activeSkillVersionLabel}</span></div>
                  {skillUpdateSnapshot?.status === 'available'
                    ? <button type="button" className={css.solidButton} disabled={skillUpdateBusy !== null} onClick={downloadAvailableSkillPackage}>{skillUpdateBusy === 'download' ? '正在下载…' : '下载技能包'}</button>
                    : skillUpdateSnapshot?.status === 'downloaded'
                      ? <button type="button" className={css.solidButton} disabled={skillUpdateBusy !== null} onClick={restartAndInstallSkillPackage}>{skillUpdateBusy === 'install' ? '正在重启…' : '重启并启用'}</button>
                      : skillUpdateConfirmedCurrent
                        ? <button type="button" className={css.updateCurrentButton} disabled aria-live="polite">当前已是最新版</button>
                        : <button type="button" className={css.outlineButton} disabled={skillUpdateBusy !== null} onClick={checkSkillPackageUpdates}>{skillUpdateBusy === 'check' ? '正在检查…' : '检查技能包更新'}</button>}
                </div>
                <div className={css.settingsFacts}>
                  <div><strong>客户端版本</strong><span>{updateSnapshot === null ? '正在读取' : updateSnapshot.currentVersion === '未知' ? '未知' : `V${updateSnapshot.currentVersion}`}</span></div>
                  <div><strong>技能包版本</strong><span>{activeSkillVersionLabel}</span></div>
                </div>
              </section>}
            </div>
          </div>
        </section>
      </div>}
      {(regionOpen || firstRunSetup) && <div className={css.dialogBackdrop} role="presentation" onMouseDown={() => { if (!firstRunSetup) setRegionOpen(false) }}>
        <section ref={sidebarDialogRef} className={css.regionDialog} role="dialog" aria-modal="true" aria-labelledby="gongchuang-region-title" onMouseDown={(event) => { event.stopPropagation() }}>
          <div className={css.dialogHead}>
            <div><span className={css.eyebrow}>{firstRunSetup ? '首次使用' : '知识库检索范围'}</span><h2 id="gongchuang-region-title">{firstRunSetup && workspaceRootState !== undefined ? '设置所属地与企业空间' : '选择所属地'}</h2></div>
            {!firstRunSetup && <button type="button" className={css.iconButton} aria-label="关闭" onClick={() => { setRegionOpen(false) }}>×</button>}
          </div>
          <p className={css.regionIntro}>后续调用知识库时，市级和区县级内容按这里选择的地区检索；浙江省级、国家级项目与通知始终共享。具体任务明确指定其他地区时，以任务要求为准。</p>
          <div className={css.regionChoices} role="radiogroup" aria-label="所属地">
            {REGIONS.map(region => <button
              type="button"
              key={region.id}
              role="radio"
              aria-checked={regionDraft === region.id}
              data-active={regionDraft === region.id || undefined}
              onClick={() => { setRegionDraft(region.id); setRegionError(null) }}
            ><span className={css.regionChoiceMark}>{regionDraft === region.id ? '✓' : ''}</span><span><strong>{region.label}</strong><small>{region.caption}</small></span></button>)}
          </div>
          {workspaceRootState !== undefined && <section className={css.workspaceRootSetup} aria-labelledby="gongchuang-workspace-root-title">
            <div>
              <span className={css.workspaceRootIcon}><Icon name="folder" size={20} /></span>
              <div><strong id="gongchuang-workspace-root-title">企业空间根目录</strong><span>{rootLoading ? '正在准备文稿目录…' : rootState?.isDefault === true ? '默认保存到系统文稿目录' : '使用自定义目录'}</span></div>
              <button type="button" className={css.outlineButton} disabled={rootBusy || rootLoading} onClick={chooseRoot}>{rootBusy ? '正在选择…' : '更改'}</button>
            </div>
            <p title={rootState?.rootPath}>{rootState?.rootPath ?? '尚未读取到根目录'}</p>
            <small>新建企业时只需输入名称，客户端会在此目录下创建同名直属子目录。以后可在设置中切换，已有企业资料不会被搬动。</small>
            {rootError !== null && <div className={css.workspaceRootRetry}><p className={css.dialogError} role="alert">{rootError}</p><button type="button" onClick={refreshWorkspaceRoot}>重试</button></div>}
          </section>}
          {regionError !== null && <p className={css.dialogError} role="alert">{regionError}</p>}
          <div className={css.dialogActions}>
            {!firstRunSetup && <button type="button" className={css.outlineButton} disabled={regionBusy || rootBusy} onClick={() => { setRegionOpen(false) }}>取消</button>}
            <button type="button" className={css.solidButton} disabled={regionBusy || rootBusy || rootLoading || (workspaceRootState !== undefined && rootState === null)} onClick={saveRegion}>{regionBusy ? '正在应用…' : firstRunSetup ? workspaceRootState === undefined ? '进入洞见' : '保存并进入洞见' : '应用并切换'}</button>
          </div>
        </section>
      </div>}
      {settingsModelConfiguration !== null && <ModelConnectionDialog
        key={`settings-${settingsModelConfiguration}`}
        retryLabel={t('model.retry')}
        retryingLabel={t('model.retrying')}
        provider={settingsModelConfiguration}
        connection={connectivity.providers[settingsModelConfiguration]}
        deepseekFiles={connectivity.deepseekFiles}
        configureProvider={configureProvider}
        refreshProviderConnection={refreshProviderConnection}
        setDeepSeekFileRetention={setDeepSeekFileRetention}
        clearDeepSeekFiles={clearDeepSeekFiles}
        close={() => { setSettingsModelConfiguration(null); setSettingsOpen(true) }}
      />}
    </aside>
  )
}

function Header({ eyebrow, title, description, children }: {
  eyebrow: string
  title: string
  description?: string
  children?: React.ReactNode
}) {
  return (
    <header className={css.pageHeader}>
      <div><span className={css.eyebrow}>{eyebrow}</span><h1>{title}</h1>{description !== undefined && <p>{description}</p>}</div>
      {children !== undefined && <div className={css.headerActions}>{children}</div>}
    </header>
  )
}

function StatusDot({ active = true }: { active?: boolean }) {
  return <span className={css.statusDot} data-active={active || undefined} />
}

function sidebarSessionTime(updatedAt: number): string {
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) return '时间未知'
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function ProviderSelector({
  provider, connection, selection, selectionError, selectProvider, openConfiguration,
}: {
  provider: ProductProvider
  connection: ProviderConnection
  selection: ConnectivityState['selection']
  selectionError: string | null
  selectProvider: (provider: ProductProvider) => Promise<void>
  openConfiguration: (provider: ProductProvider) => void
}) {
  const active = connection.status === 'ready'
  const status = selection === 'selecting'
    ? '正在切换'
    : selectionError ?? connection.message
  const health = selection === 'selecting' ? '正在切换' : providerHealthLabel(connection)
  return (
    <div className={css.providerSelect} title={status}>
      <StatusDot active={active} />
      <label htmlFor="gongchuang-provider-select">模型</label>
      <select id="gongchuang-provider-select" value={provider} onChange={(event) => {
        const next = event.target.value as ProductProvider
        void selectProvider(next)
        openConfiguration(next)
      }}>
        {PROVIDERS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      <small>{health}</small>
      <button type="button" onClick={() => { openConfiguration(provider) }}>{active ? '管理' : '配置'}</button>
    </div>
  )
}

function verifiedTime(value: string | undefined): string {
  if (value === undefined) return '尚无验证回执'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

type ProviderHealthLabel = '连接正常' | '余额不足' | '模型不可用' | '检查中' | '未配置' | '连接失败'

/** Convert a redacted Host receipt into a short user-facing connection state. */
export function providerHealthLabel(connection: ProviderConnection): ProviderHealthLabel {
  if (connection.status === 'ready') return '连接正常'
  if (connection.status === 'loading') return '检查中'
  if (connection.status === 'missing') return '未配置'
  const detail = connection.message
  if (/(?:余额|欠费|额度|积分不足|balance|credit|quota|insufficient|402)/iu.test(detail)) return '余额不足'
  if (/(?:模型不可用|模型目录.*(?:没有|未找到|不可用)|未返回.*模型|model(?:[- _]?unavailable|[- _]?not[- _]?found)|no available model|model.*not found)/iu.test(detail)) return '模型不可用'
  return '连接失败'
}

function ModelConnectionDialog({
  provider, connection, deepseekFiles, configureProvider, refreshProviderConnection,
  setDeepSeekFileRetention, clearDeepSeekFiles, close, retryLabel, retryingLabel,
}: {
  retryLabel: string
  retryingLabel: string
  provider: ProductProvider
  connection: ProviderConnection
  deepseekFiles: ConnectivityState['deepseekFiles']
  configureProvider: (
    request: GongchuangModelConfigureRequest,
  ) => Promise<ProviderConfigurationResult | void>
  refreshProviderConnection: (provider: GongchuangModelProvider) => Promise<void>
  setDeepSeekFileRetention: (retentionSeconds: GongchuangDeepSeekFileRetentionSeconds) => Promise<void>
  clearDeepSeekFiles: () => Promise<number>
  close: () => void
}) {
  const setup = PROVIDER_SETUP[provider]
  const definition = gongchuangProviderDefinition(provider)
  const apiKeyRequired = definition.authKind === 'api-key'
  const baseURLVisible = provider === 'custom' || definition.baseURLMode !== 'fixed'
  const baseURLRequired = provider === 'custom' || definition.baseURLMode === 'required'
  const [apiKey, setApiKey] = useState('')
  const [displayName, setDisplayName] = useState(connection.configuration?.displayName ?? definition.label)
  const [baseURL, setBaseURL] = useState(connection.configuration?.baseURL
    ?? (definition.baseURLMode === 'optional' ? definition.baseURL : ''))
  const [protocol, setProtocol] = useState<GongchuangProviderProtocol>(connection.configuration?.protocol ?? 'openai-completions')
  const [modelId, setModelId] = useState(connection.configuration?.modelId ?? '')
  const [busy, setBusy] = useState<'configure' | 'refresh' | 'retention' | 'clear-files' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [filesMessage, setFilesMessage] = useState('')
  const dialogRef = useDialogFocusTrap(true, `model-${provider}`)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && busy === null) close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [busy, close])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy('configure')
    setError('')
    setNotice('')
    try {
      let result: ProviderConfigurationResult | void
      if (provider === 'custom') {
        result = await configureProvider({
          provider, displayName, baseURL, protocol,
          ...(apiKey.trim() === '' ? {} : { apiKey }),
          ...(modelId.trim() === '' ? {} : { modelId }),
        })
      } else {
        result = await configureProvider({
          provider,
          ...(apiKey.trim() === '' ? {} : { apiKey }),
          ...(baseURL.trim() === '' ? {} : { baseURL }),
          ...(modelId.trim() === '' ? {} : { modelId }),
        })
      }
      setApiKey('')
      if (result?.autoSelected === false && result.message !== undefined) setNotice(result.message)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const refresh = async () => {
    setBusy('refresh')
    setError('')
    try {
      await refreshProviderConnection(provider)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const setRetention = async (retentionSeconds: GongchuangDeepSeekFileRetentionSeconds) => {
    setBusy('retention')
    setError('')
    setFilesMessage('')
    try {
      await setDeepSeekFileRetention(retentionSeconds)
      setFilesMessage('新的图片保留期已应用到后续上传')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const clearFiles = async () => {
    setBusy('clear-files')
    setError('')
    setFilesMessage('')
    try {
      const deleted = await clearDeepSeekFiles()
      setFilesMessage(`已删除 ${String(deleted)} 个远端文件并清理本地映射`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && busy === null) close()
    }}>
      <section ref={dialogRef} className={`${css.connectionModal} ${css.modelConnectionModal}`} role="dialog" aria-modal="true" aria-labelledby="model-connection-title">
        <div className={css.modalHead}>
          <div><span>{setup.eyebrow}</span><h2 id="model-connection-title">{setup.title}</h2></div>
          <button type="button" disabled={busy !== null} aria-label="关闭" onClick={close}>×</button>
        </div>

        <div className={css.modelReceipt} data-state={connection.status}>
          <StatusDot active={connection.status === 'ready'} />
          <div>
            <strong>{providerHealthLabel(connection)}</strong>
            <span>{connection.message}</span>
          </div>
          {connection.status === 'ready' && <dl>
            <div><dt>最近验证</dt><dd>{verifiedTime(connection.verifiedAt)}</dd></div>
            <div><dt>可用模型</dt><dd>{connection.modelCount ?? 0} 个</dd></div>
            <div><dt>当前模型</dt><dd>{connection.selectedModel ?? '由服务目录选择'}</dd></div>
          </dl>}
        </div>

        {provider === 'deepseek' && <section className={css.deepseekFilesControls} aria-label="DeepSeek 图片远端传输">
          <div>
            <strong>图片远端传输</strong>
            <p>使用图片模型时，DeepSeek 会在当前 API Key 的独立作用域保存上传内容。客户端不展示或复用远端文件身份。</p>
          </div>
          <div className={css.retentionSegments} role="group" aria-label="图片保留期">
            {deepseekFiles.retentionOptions.map(seconds => <button
              key={seconds}
              type="button"
              aria-pressed={deepseekFiles.retentionSeconds === seconds}
              disabled={busy !== null || deepseekFiles.status === 'loading'}
              onClick={() => { void setRetention(seconds) }}
            >{seconds === 3_600 ? '1 小时' : seconds === 604_800 ? '7 天' : '30 天'}</button>)}
          </div>
          <button type="button" className={css.outlineButton} disabled={busy !== null || !connection.configured} onClick={() => { void clearFiles() }}>
            {busy === 'clear-files' ? '正在清理…' : '删除远端文件并清理本地映射'}
          </button>
          {(filesMessage !== '' || deepseekFiles.message !== null) && <p className={css.filesControlMessage} role="status">{filesMessage || deepseekFiles.message}</p>}
        </section>}

        <form className={css.modelSetupForm} onSubmit={(event) => { void submit(event) }}>
          <ol className={css.guideSteps}>
            <li><span>1</span><div><strong>{provider === 'custom' ? '填写兼容服务信息' : '注册并获取 API Key'}</strong>
              {provider === 'custom'
                ? <p>支持 OpenAI Chat Completions 或 Responses 协议的服务，并优先读取标准模型目录。地址必须为 HTTPS，本机服务可使用 localhost。</p>
                : <><p>客户端不会代替您注册或购买服务。请在官方页面完成账号、订阅或余额准备。</p>{setup.officialUrl !== undefined && setup.officialLabel !== undefined && <a href={setup.officialUrl} target="_blank" rel="noreferrer">{setup.officialLabel}<Icon name="external" size={14} /></a>}</>}
            </div></li>
            {provider === 'custom' && <li><span>2</span><div className={css.modelFields}>
              <strong>配置服务地址与协议</strong>
              <label><span>显示名称</span><input
                value={displayName}
                onChange={(event) => { setDisplayName(event.currentTarget.value) }}
                maxLength={80}
                required
              /></label>
              <label><span>API 基础地址</span><input type="url" value={baseURL} onChange={(event) => { setBaseURL(event.currentTarget.value) }} placeholder="https://api.example.com/v1" required /></label>
              <label><span>兼容协议</span><select value={protocol} onChange={(event) => { setProtocol(event.currentTarget.value as typeof protocol) }}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
              <label><span>模型 ID，目录不可用时必填</span><input value={modelId} onChange={(event) => { setModelId(event.currentTarget.value) }} placeholder="留空则采用目录中的首个模型" maxLength={200} /></label>
            </div></li>}
            {provider !== 'custom' && (baseURLVisible || definition.id !== 'deepseek') && <li><span>2</span><div className={css.modelFields}>
              <strong>连接参数</strong>
              {baseURLVisible && <label><span>API 基础地址</span><input type="url" value={baseURL} onChange={(event) => { setBaseURL(event.currentTarget.value) }} placeholder={definition.baseURL || 'https://resource.example.com/v1'} required={baseURLRequired} /></label>}
              <label><span>模型 ID，目录不可用时填写</span><input value={modelId} onChange={(event) => { setModelId(event.currentTarget.value) }} placeholder="留空则采用服务目录" maxLength={200} /></label>
            </div></li>}
            <li><span>{provider === 'custom' ? '3' : '2'}</span><div className={css.modelFields}>
              <strong>{connection.status === 'ready' ? '替换本机 API Key' : '输入 API Key'}</strong>
              <p>密钥只会提交给本机宿主，验证成功后由 macOS 钥匙串或 Windows 凭据管理器保护；页面、日志和普通配置不会保存密钥。</p>
              <label><span>API Key{apiKeyRequired ? '' : '，可选'}</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => { setApiKey(event.currentTarget.value) }} placeholder={setup.keyPlaceholder} required={apiKeyRequired} /></label>
            </div></li>
            <li><span>{provider === 'custom' ? '4' : '3'}</span><div><strong>取得模型目录</strong><p>{provider === 'custom'
              ? '客户端优先读取服务的模型目录；端点不支持目录时，使用手动填写的精确模型 ID。选择或切换模型不会发送额外验证请求。'
              : '客户端使用该密钥读取服务商模型目录，并在首次启动或用户手动刷新时更新可选列表。'}</p></div></li>
          </ol>
          {notice !== '' && <p className={css.modalNotice} role="status">{notice}</p>}
          {error !== '' && <p className={css.modalError} role="alert">{error}</p>}
          <div className={css.modalActions}>
            <button type="button" className={css.outlineButton} disabled={busy !== null} onClick={close}>{connection.status === 'ready' ? '完成' : '取消'}</button>
            {(connection.configured || connection.status === 'error') && <button type="button" className={css.outlineButton} disabled={busy !== null} onClick={() => { void refresh() }}>{busy === 'refresh' ? retryingLabel : retryLabel}</button>}
            <button type="submit" className={css.solidButton} disabled={busy !== null || (apiKeyRequired && apiKey.trim() === '') || (baseURLRequired && baseURL.trim() === '')}>{busy === 'configure' ? '正在连接并验证…' : connection.status === 'ready' ? '验证并替换' : '连接并验证'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function AssistantFloater({ props }: { props: ProductOverlayProps }) {
  const provider = props.useProduct(state => state.provider)
  const connections = props.useConnectivity(state => state.providers)
  const connection = connections[provider]
  const selection = props.useConnectivity(state => state.selection)
  const selectionError = props.useConnectivity(state => state.selectionError)
  const deepseekFiles = props.useConnectivity(state => state.deepseekFiles)
  const professionalTask = (props.useProfessionalTaskStatus ?? (selector => selector({
    sessionId: null, phase: 'none', busy: false, error: null,
  })))(state => state)
  const [configuring, setConfiguring] = useState<ProductProvider | null>(null)
  const openConfiguration = (next: ProductProvider) => {
    if (connections[next].status !== 'ready' || next === provider) setConfiguring(next)
  }
  return (
    <>
      <div className={css.assistantFloater}>
        {professionalTask.phase === 'paused' && props.resumeProfessionalTask !== undefined && <div className={css.pausedTaskStatus} role="status">
          <span>{professionalTask.error ?? '任务已暂停'}</span>
          <button type="button" disabled={professionalTask.busy} onClick={() => { void props.resumeProfessionalTask?.() }}>
            {professionalTask.busy ? '继续中…' : '继续'}
          </button>
        </div>}
        <ProviderSelector
          provider={provider}
          connection={connection}
          selection={selection}
          selectionError={selectionError}
          selectProvider={props.selectProvider}
          openConfiguration={openConfiguration}
        />
      </div>
      {configuring !== null && <ModelConnectionDialog
        key={configuring}
        retryLabel={props.t('model.retry')}
        retryingLabel={props.t('model.retrying')}
        provider={configuring}
        connection={connections[configuring]}
        deepseekFiles={deepseekFiles}
        configureProvider={props.configureProvider}
        refreshProviderConnection={props.refreshProviderConnection}
        setDeepSeekFileRetention={props.setDeepSeekFileRetention}
        clearDeepSeekFiles={props.clearDeepSeekFiles}
        close={() => { setConfiguring(null) }}
      />}
    </>
  )
}

const EMPTY_IMAGE_TRANSFER_CONSENT: ImageTransferConsentState = {
  phase: 'idle', provider: null, imageCount: 0, revision: 0,
}

function providerLabel(provider: ProductProvider): string {
  return PROVIDERS.find(item => item.id === provider)?.label ?? provider
}

function imageRetentionLabel(seconds: number): string {
  if (seconds === 3_600) return '1 小时'
  if (seconds === 604_800) return '7 天'
  if (seconds === 2_592_000) return '30 天'
  return `${String(seconds)} 秒`
}

function ImageTransferConsentDialog({
  state, retentionSeconds, approve, reject,
}: {
  state: ImageTransferConsentState
  retentionSeconds: number
  approve: () => void
  reject: () => void
}) {
  const open = state.phase === 'pending' && state.provider !== null
  const dialogRef = useDialogFocusTrap(open, open ? `image-transfer-${String(state.revision)}` : null)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      reject()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, reject, state.revision])
  if (!open || state.provider === null) return null
  const label = providerLabel(state.provider)
  return <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) reject()
  }}>
    <section
      ref={dialogRef}
      className={`${css.confirmDialog} ${css.imageTransferConsentDialog}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="gongchuang-image-transfer-title"
      onMouseDown={(event) => { event.stopPropagation() }}
    >
      <div className={css.consentDialogHead}><Icon name="shield" size={20} /><div>
        <h2 id="gongchuang-image-transfer-title">确认图片传输</h2>
        <p>本次 {String(state.imageCount)} 张图片将发送至 <strong>{label}</strong>。</p>
      </div></div>
      <div className={css.imageTransferConsentBody}>
        {state.provider === 'deepseek'
          ? <p>图片将上传至 DeepSeek Files，在当前 API Key 的独立作用域保存；当前保留期为 {imageRetentionLabel(retentionSeconds)}，可在“模型连接”中调整或立即清理。</p>
          : <p>图片将由 {label} 的远端模型服务处理。保存期限及处理规则由该服务商管理；客户端不会把 API Key 或远端文件标识写入对话。</p>}
        <p>同意后，客户端会记住对该服务商的选择，后续发送图片不再重复询问。切换到其他服务商时会重新确认。</p>
      </div>
      <div className={css.modalActions}>
        <button type="button" className={css.outlineButton} onClick={reject}>取消发送</button>
        <button type="button" className={css.solidButton} onClick={approve}>同意并发送</button>
      </div>
    </section>
  </div>
}

/** Per-send identity shown whenever the current composer carries draft images. */
export function ImageTransferProviderNotice({ useInput, useProduct, resolveDraftAttachments }: ImageTransferProviderNoticeProps) {
  const attachmentIds = useInput(state => state.attachmentIds)
  const imageCount = resolveDraftAttachments(attachmentIds).filter(attachment => attachment.kind === 'image').length
  const provider = useProduct(state => state.provider)
  if (imageCount === 0) return null
  return <span className={css.imageProviderNotice} role="status">
    本次图片将发送至 <strong>{providerLabel(provider)}</strong>
  </span>
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className={css.emptyState}><Icon name="folder" size={28} /><strong>{title}</strong><span>{text}</span></div>
}

function EnterpriseDirectoryPicker({
  open, busy, listDirectory, createDirectory, onPick, onClose,
}: {
  open: boolean
  busy: boolean
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  createDirectory: (path: string, name: string) => Promise<string>
  onPick: (path: string) => void
  onClose: () => void
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [pathDraft, setPathDraft] = useState('')
  const [folderDraft, setFolderDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useDialogFocusTrap(open, open ? 'enterprise-directory-picker' : null)

  const navigate = async (path?: string, signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const next = await listDirectory(path, signal)
      setListing(next)
      setPathDraft(next.path)
    } catch (cause) {
      if (!signal?.aborted) setError(productError(cause, 'workspace'))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setListing(null)
    setFolderDraft('')
    void navigate(undefined, controller.signal)
    return () => { controller.abort() }
  }, [open])

  if (!open) return null
  const createFolder = async () => {
    if (listing === null || folderDraft.trim() === '') return
    setCreating(true)
    setError('')
    try {
      const path = await createDirectory(listing.path, folderDraft.trim())
      setFolderDraft('')
      await navigate(path)
    } catch (cause) {
      setError(productError(cause, 'workspace'))
    } finally {
      setCreating(false)
    }
  }
  const directoryContent = loading && listing === null
    ? <p>正在读取目录…</p>
    : (listing?.entries.length ?? 0) === 0
      ? <p>当前目录没有子文件夹。</p>
      : listing?.entries.map(entry => <article key={entry.path}>
        <span><Icon name="folder" size={19} /><strong>{entry.name}</strong></span>
        <button type="button" disabled={loading} onClick={() => { void navigate(entry.path) }}>进入</button>
      </article>)
  return <div className={css.directoryPickerBackdrop} role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target && !busy && !creating) onClose()
  }}>
    <section ref={dialogRef} className={css.directoryPicker} role="dialog" aria-modal="true" aria-label="选择企业资料目录">
      <header><div><span className={css.eyebrow}>本机企业资料</span><h2>选择企业资料目录</h2></div><button type="button" aria-label="关闭" disabled={busy || creating} onClick={onClose}>×</button></header>
      <form className={css.directoryPath} onSubmit={(event) => { event.preventDefault(); void navigate(pathDraft.trim()) }}>
        <input aria-label="目录路径" value={pathDraft} onChange={(event) => { setPathDraft(event.currentTarget.value) }} placeholder="输入完整目录路径" />
        <button type="submit" disabled={loading || pathDraft.trim() === ''}>前往</button>
      </form>
      <nav className={css.directoryCrumbs} aria-label="目录层级">
        {(listing?.crumbs ?? []).map(crumb => <button type="button" key={crumb.path} disabled={loading} onClick={() => { void navigate(crumb.path) }}>{crumb.path === listing?.home ? '主目录' : crumb.name}</button>)}
      </nav>
      <div className={css.directoryList} aria-busy={loading}>
        {directoryContent}
      </div>
      {listing?.truncated === true && <p className={css.directoryHint}>文件夹过多，仅显示按名称排序后的前 1000 项；可直接输入完整路径。</p>}
      {error !== '' && <p className={css.directoryError} role="alert">{error}</p>}
      <form className={css.directoryCreate} onSubmit={(event) => { event.preventDefault(); void createFolder() }}>
        <input aria-label="新文件夹名称" value={folderDraft} onChange={(event) => { setFolderDraft(event.currentTarget.value) }} placeholder="在当前目录中新建文件夹" />
        <button type="submit" disabled={listing === null || creating || folderDraft.trim() === ''}>{creating ? '正在创建…' : '新建文件夹'}</button>
      </form>
      <footer><small>{listing === null ? '请选择目录' : `当前目录：${listing.path}`}</small><div><button type="button" className={css.outlineButton} disabled={busy || creating} onClick={onClose}>取消</button><button type="button" className={css.solidButton} disabled={listing === null || busy || creating} onClick={() => { if (listing !== null) onPick(listing.path) }}>{busy ? '正在创建空间…' : '选择当前目录'}</button></div></footer>
    </section>
  </div>
}

type SkillDetail =
  | { kind: 'marketplace'; skill: MarketplaceSkillView }
  | { kind: 'installed'; skill: InstalledSkillView }

function skillSourceLabel(source: InstalledSkillView['source'] | SkillMarketplaceSource, version?: string): string {
  if (source === 'bundled') return version === undefined || version.trim() === '' ? '内置' : `内置 V${version}`
  if (source === 'modelscope') return '魔搭 ModelScope'
  if (source === 'skillhub') return '腾讯 SkillHub'
  return '第三方仓库'
}

function RequestedEnterpriseCreation({ props }: { props: ProductOverlayProps }) {
  const requested = props.useProduct(state => state.enterpriseCreateRequested === true)
  const [busy, setBusy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false)
  const [enterpriseName, setEnterpriseName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useDialogFocusTrap<HTMLFormElement>(
    dialogOpen,
    dialogOpen ? 'requested-create-enterprise' : null,
  )
  useEffect(() => {
    if (!requested) return
    props.consumeEnterpriseCreationRequest()
    setError(null)
    if (props.createEnterpriseWorkspace === undefined) setDirectoryPickerOpen(true)
    else {
      setEnterpriseName('')
      setDialogOpen(true)
    }
  }, [props.consumeEnterpriseCreationRequest, props.createEnterpriseWorkspace, requested])
  useEffect(() => {
    if (!dialogOpen && !directoryPickerOpen) return
    const closeOverlay = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      setDialogOpen(false)
      setDirectoryPickerOpen(false)
      event.preventDefault()
    }
    document.addEventListener('keydown', closeOverlay)
    return () => { document.removeEventListener('keydown', closeOverlay) }
  }, [busy, dialogOpen, directoryPickerOpen])
  const createNamedEnterprise = async () => {
    if (props.createEnterpriseWorkspace === undefined || enterpriseName.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const directory = await props.createEnterpriseWorkspace(enterpriseName)
      await props.pickAndCreateWorkspace(directory.path)
      setEnterpriseName('')
      setDialogOpen(false)
    } catch (cause) {
      setError(productError(cause, 'workspace'))
    } finally {
      setBusy(false)
    }
  }
  const connectDirectory = (path: string) => {
    setBusy(true)
    setError(null)
    void props.pickAndCreateWorkspace(path)
      .then(() => { setDirectoryPickerOpen(false) })
      .catch((cause: unknown) => { setError(productError(cause, 'workspace')) })
      .finally(() => { setBusy(false) })
  }
  return <>
    {dialogOpen && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !busy) setDialogOpen(false)
    }}>
      <form
        ref={dialogRef}
        className={`${css.confirmDialog} ${css.enterpriseCreateDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="requested-create-enterprise-title"
        onSubmit={(event) => { event.preventDefault(); void createNamedEnterprise() }}
      >
        <span className={css.eyebrow}>根目录直属企业空间</span>
        <h2 id="requested-create-enterprise-title">新建企业</h2>
        <p>输入企业名称后，客户端会在当前企业空间根目录下创建同名文件夹，并直接用于这次新对话。</p>
        <label><span>企业名称</span><input
          autoFocus
          aria-label="企业名称"
          value={enterpriseName}
          maxLength={120}
          onChange={(event) => { setEnterpriseName(event.currentTarget.value); setError(null) }}
          placeholder="例如 杭州示例企业有限公司"
        /></label>
        {error !== null && <p className={css.dialogError} role="alert">{error}</p>}
        <div className={css.modalActions}>
          <button type="button" className={css.outlineButton} disabled={busy} onClick={() => { setDialogOpen(false) }}>取消</button>
          <button type="submit" className={css.solidButton} disabled={busy || enterpriseName.trim() === ''}>{busy ? '正在创建…' : '创建并开始对话'}</button>
        </div>
      </form>
    </div>}
    <EnterpriseDirectoryPicker
      open={directoryPickerOpen}
      busy={busy}
      listDirectory={props.listWorkspaceDirectory}
      createDirectory={props.createWorkspaceDirectory}
      onPick={connectDirectory}
      onClose={() => { if (!busy) setDirectoryPickerOpen(false) }}
    />
  </>
}

function EnterprisePage({ props }: { props: ProductOverlayProps }) {
  const workspaceState = props.useWorkspaces(state => state)
  const workspaces = workspaceState.items
  const phase = workspaceState.phase
  const sessionsById = props.useSessions(state => state.byId)
  const allSessionIds = workspaces.flatMap(workspace => workspace.sessionIds)
  const totalUsage = enterpriseCacheUsage(allSessionIds, sessionsById)
  const [busy, setBusy] = useState(false)
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [enterpriseName, setEnterpriseName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<WorkspaceId | null>(null)
  const [renaming, setRenaming] = useState<WorkspaceId | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [sessionRenaming, setSessionRenaming] = useState<SessionId | null>(null)
  const [sessionRenameValue, setSessionRenameValue] = useState('')
  const [archiveTarget, setArchiveTarget] = useState<WorkspaceId | null>(null)
  const [removeTarget, setRemoveTarget] = useState<WorkspaceId | null>(null)
  const [deleteTaskTarget, setDeleteTaskTarget] = useState<SessionId | null>(null)
  const archiveDialogRef = useDialogFocusTrap(archiveTarget !== null, archiveTarget === null ? null : `archive-${archiveTarget}`)
  const removeDialogRef = useDialogFocusTrap(removeTarget !== null, removeTarget === null ? null : `remove-${removeTarget}`)
  const deleteTaskDialogRef = useDialogFocusTrap(deleteTaskTarget !== null, deleteTaskTarget === null ? null : `delete-task-${deleteTaskTarget}`)
  const createDialogRef = useDialogFocusTrap<HTMLFormElement>(
    createDialogOpen,
    createDialogOpen ? 'create-enterprise' : null,
  )
  useEffect(() => {
    const closeOverlay = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      if (archiveTarget !== null) setArchiveTarget(null)
      else if (removeTarget !== null) setRemoveTarget(null)
      else if (deleteTaskTarget !== null) setDeleteTaskTarget(null)
      else if (createDialogOpen) setCreateDialogOpen(false)
      else if (directoryPickerOpen) setDirectoryPickerOpen(false)
      else return
      event.preventDefault()
    }
    document.addEventListener('keydown', closeOverlay)
    return () => { document.removeEventListener('keydown', closeOverlay) }
  }, [archiveTarget, busy, createDialogOpen, deleteTaskTarget, directoryPickerOpen, removeTarget])
  const connectDirectory = async (path: string) => {
    setBusy(true)
    setError(null)
    try {
      await props.pickAndCreateWorkspace(path)
      setDirectoryPickerOpen(false)
    } catch (cause) {
      setError(productError(cause, 'workspace'))
    } finally {
      setBusy(false)
    }
  }
  const createNamedEnterprise = async () => {
    if (props.createEnterpriseWorkspace === undefined || enterpriseName.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const directory = await props.createEnterpriseWorkspace(enterpriseName)
      await props.pickAndCreateWorkspace(directory.path)
      setEnterpriseName('')
      setCreateDialogOpen(false)
    } catch (cause) {
      setError(productError(cause, 'workspace'))
    } finally {
      setBusy(false)
    }
  }
  const importExistingEnterprise = async () => {
    if (props.importEnterpriseWorkspace === undefined) return
    setBusy(true)
    setError(null)
    try {
      const directory = await props.importEnterpriseWorkspace()
      if (directory !== null) await props.pickAndCreateWorkspace(directory.path)
    } catch (cause) {
      setError(productError(cause, 'workspace'))
    } finally {
      setBusy(false)
    }
  }
  const open = async (workspaceId: WorkspaceId) => {
    setBusy(true)
    setError(null)
    try {
      await props.openWorkspace(workspaceId)
    } catch (cause) {
      setError(productError(cause, 'workspace'))
    } finally {
      setBusy(false)
    }
  }
  const openSession = async (workspaceId: WorkspaceId, sessionId: SessionId) => {
    setBusy(true)
    setError(null)
    try {
      await props.openWorkspaceSession(workspaceId, sessionId)
    } catch (cause) {
      setError(productError(cause, 'workspace'))
    } finally {
      setBusy(false)
    }
  }
  const saveRename = async (workspaceId: WorkspaceId) => {
    setBusy(true)
    setError(null)
    try {
      await props.renameWorkspace(workspaceId, renameValue)
      setRenaming(null)
      setRenameValue('')
    } catch (cause) {
      setError(productError(cause, 'workspace'))
    } finally {
      setBusy(false)
    }
  }
  const archive = async (workspaceId: WorkspaceId) => {
    setBusy(true)
    setError(null)
    try {
      await props.archiveWorkspace(workspaceId)
      setArchiveTarget(null)
      if (expanded === workspaceId) setExpanded(null)
    } catch (cause) {
      setError(productError(cause, 'workspace'))
    } finally {
      setBusy(false)
    }
  }
  const archiveSession = async (workspaceId: WorkspaceId, sessionId: SessionId) => {
    setBusy(true)
    setError(null)
    try {
      await props.archiveWorkspaceSession(workspaceId, sessionId)
    } catch (cause) {
      setError(productError(cause, 'workspace'))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (workspaceId: WorkspaceId) => {
    setBusy(true)
    setError(null)
    try {
      await props.deleteWorkspace(workspaceId)
      setRemoveTarget(null)
      if (expanded === workspaceId) setExpanded(null)
    } catch (cause) {
      setError(productError(cause, 'workspace'))
    } finally {
      setBusy(false)
    }
  }
  const deleteTask = async (sessionId: SessionId) => {
    setBusy(true)
    setError(null)
    try {
      await props.deleteWorkspaceSession(sessionId)
      setDeleteTaskTarget(null)
    } catch (cause) {
      setError(productError(cause, 'workspace'))
    } finally {
      setBusy(false)
    }
  }
  const saveSessionRename = async (workspaceId: WorkspaceId, sessionId: SessionId) => {
    setBusy(true)
    setError(null)
    try {
      await props.renameWorkspaceSession(workspaceId, sessionId, sessionRenameValue)
      setSessionRenaming(null)
      setSessionRenameValue('')
    } catch (cause) {
      setError(productError(cause, 'workspace'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Header eyebrow="企业与项目的长期工作区" title="企业空间" description="集中管理企业资料、申报项目、会话记录与交付文件。">
        {props.importEnterpriseWorkspace !== undefined && <button className={css.outlineButton} type="button" disabled={busy} onClick={() => { void importExistingEnterprise() }}><Icon name="folder" size={17} />导入已有目录</button>}
        <button className={css.solidButton} type="button" disabled={busy} onClick={() => {
          if (props.createEnterpriseWorkspace === undefined) setDirectoryPickerOpen(true)
          else { setError(null); setEnterpriseName(''); setCreateDialogOpen(true) }
        }}><Icon name="plus" size={17} />{busy ? '正在创建…' : '新建企业'}</button>
      </Header>
      <section className={css.metricsRow} aria-label="企业空间概览">
        <div><span>企业空间</span><strong>{workspaces.length}</strong><small>已连接本机目录</small></div>
        <div><span>上下文归集</span><strong>同企业</strong><small>任务、会话与文件统一归档</small></div>
        <div><span>输入缓存复用</span><strong>{totalUsage.cacheReusePercent === null ? '待回执' : `${totalUsage.cacheReusePercent}%`}</strong><small>{totalUsage.cacheReusePercent === null ? '完成模型请求后显示' : `${formatEnterpriseTokens(totalUsage.cacheReadTokens)} Token 由供应商复用`}</small></div>
      </section>
      <p className={css.metricsNote}>继续使用同一企业会话，并保持系统提示、工具定义和资料前缀稳定，更容易命中模型缓存。比例来自模型供应商回执，不等同于通用成本节省率。</p>
      {error !== null && <p className={css.workspaceError} role="alert">企业空间连接失败：{error}</p>}
      <section className={css.sectionBlock}>
        <div className={css.sectionTitle}><div><h2>最近企业</h2><p>进入空间后，新任务、会话和文件都会自动归入该企业。</p></div></div>
        {phase !== 'ready' && workspaces.length === 0
          ? <EmptyState title="正在载入企业空间" text="客户端正在读取本机工作区索引。" />
          : workspaces.length === 0
            ? <EmptyState title="还没有企业空间" text={props.createEnterpriseWorkspace === undefined ? '选择一个企业资料目录即可开始，客户端不会搬动原文件。' : '输入企业名称即可创建空间，也可导入本机已有企业目录。'} />
            : <div className={css.enterpriseGrid}>{workspaces.map((workspace, index) => {
              const usage = enterpriseCacheUsage(workspace.sessionIds, sessionsById)
              const cacheLabel = usage.cacheReusePercent === null ? '暂无模型回执' : `缓存复用 ${usage.cacheReusePercent}%`
              const concrete = isConcreteEnterpriseWorkspacePath(workspace.path)
              const archived = new Set(workspaceState.archivedSessionIds)
              const deleted = new Set(workspaceState.deletedSessionIds)
              const sessions = workspace.sessionIds
                .flatMap((sessionId) => {
                  const session = sessionsById[sessionId]
                  return session === undefined || session.blank || archived.has(session.id)
                    || deleted.has(session.id) ? [] : [session]
                })
                .sort((left, right) => right.updatedAt - left.updatedAt)
              return (
                <article key={workspace.workspaceId} className={css.enterpriseCard} data-expanded={expanded === workspace.workspaceId ? '' : undefined}>
                  <div className={css.enterpriseCardSummary}>
                    <span className={css.enterpriseMonogram}>{workspace.title.slice(0, 1)}</span>
                    <span className={css.enterpriseInfo}><strong>{workspace.title}</strong><small>{workspace.path}</small><em>{concrete ? `${sessions.length} 个可用任务 · ${cacheLabel} · ${index === 0 ? '最近使用' : '已连接'}` : '范围过宽 · 请归档后改选具体企业目录'}</em></span>
                  </div>
                  <div className={css.enterpriseActions}>
                    <button type="button" className={css.outlineButton} disabled={busy} onClick={() => { setExpanded(expanded === workspace.workspaceId ? null : workspace.workspaceId) }}>{expanded === workspace.workspaceId ? '收起任务' : '查看任务'}</button>
                    <button type="button" className={css.solidButton} disabled={busy} onClick={() => { void open(workspace.workspaceId) }}>进入空间</button>
                  </div>
                  {expanded === workspace.workspaceId && <div className={css.enterpriseDetail}>
                    <div className={css.enterpriseDetailHeading}>
                      <div><strong>空间管理</strong><small>归档只收起空间，不删除目录、文件和会话记录。</small></div>
                      <div>
                        <button type="button" disabled={busy} onClick={() => { setRenaming(workspace.workspaceId); setRenameValue(workspace.title) }}>重命名空间</button>
                        <button type="button" disabled={busy} onClick={() => { setArchiveTarget(workspace.workspaceId) }}>归档空间</button>
                        <button type="button" disabled={busy} onClick={() => { setRemoveTarget(workspace.workspaceId) }}>删除企业空间</button>
                      </div>
                    </div>
                    {renaming === workspace.workspaceId && <form
                      className={css.enterpriseRename}
                      onSubmit={(event) => { event.preventDefault(); void saveRename(workspace.workspaceId) }}
                    >
                      <label><span>企业空间名称</span><input aria-label="企业空间名称" value={renameValue} onChange={(event) => { setRenameValue(event.target.value) }} /></label>
                      <button type="button" onClick={() => { setRenaming(null) }}>取消</button>
                      <button type="submit" disabled={busy || renameValue.trim() === ''}>保存名称</button>
                    </form>}
                    <div className={css.enterpriseSessions}>
                      {sessions.length === 0
                        ? <p>暂无已开始的任务；点击“进入空间”可创建新任务。</p>
                        : sessions.slice(0, 20).map(session => <div className={css.enterpriseSessionEntry} key={session.id}>
                          <article>
                            <div><strong>{session.blank ? '新任务（未开始）' : session.displayTitle}</strong><small>{new Date(session.updatedAt).toLocaleString('zh-CN')} · {session.running ? '正在运行' : '已保存'}</small></div>
                            <div>
                              <button type="button" disabled={busy} onClick={() => { void openSession(workspace.workspaceId, session.id) }}>打开</button>
                              <button type="button" disabled={busy || session.blank} onClick={() => { setSessionRenaming(session.id); setSessionRenameValue(session.displayTitle) }}>重命名任务</button>
                              <button type="button" disabled={busy} onClick={() => { void archiveSession(workspace.workspaceId, session.id) }}>归档任务</button>
                              <button type="button" disabled={busy} onClick={() => { setDeleteTaskTarget(session.id) }}>删除任务</button>
                            </div>
                          </article>
                          {sessionRenaming === session.id && <form
                            className={css.enterpriseSessionRename}
                            onSubmit={(event) => {
                              event.preventDefault()
                              void saveSessionRename(workspace.workspaceId, session.id)
                            }}
                          >
                            <label><span>任务名称</span><input aria-label="任务名称" value={sessionRenameValue} onChange={(event) => { setSessionRenameValue(event.target.value) }} /></label>
                            <button type="button" disabled={busy} onClick={() => { setSessionRenaming(null); setSessionRenameValue('') }}>取消</button>
                            <button type="submit" disabled={busy || sessionRenameValue.trim() === ''}>保存任务名称</button>
                          </form>}
                        </div>)}
                    </div>
                  </div>}
                </article>
              )
            })}</div>}
      </section>
      {archiveTarget !== null && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setArchiveTarget(null) }}>
        <section ref={archiveDialogRef} className={css.confirmDialog} role="dialog" aria-modal="true" aria-label="归档企业空间">
          <h2>归档企业空间</h2>
          <p>该空间会从客户端日常列表收起，但不会删除本机企业目录和历史会话；可在“设置 → 已归档”中直接恢复。</p>
          <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={busy} onClick={() => { setArchiveTarget(null) }}>取消</button><button type="button" className={css.dangerButton} disabled={busy} onClick={() => { void archive(archiveTarget) }}>{busy ? '正在归档…' : '确认归档'}</button></div>
        </section>
      </div>}
      {removeTarget !== null && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) setRemoveTarget(null) }}>
        <section ref={removeDialogRef} className={css.confirmDialog} role="dialog" aria-modal="true" aria-label="删除企业空间">
          <h2>删除企业空间</h2>
          <p>企业目录、原始资料、已生成文件和会话记录会移入系统废纸篓或回收站，并从客户端全部列表中删除；客户端不提供恢复入口。</p>
          <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={busy} onClick={() => { setRemoveTarget(null) }}>取消</button><button type="button" className={css.dangerButton} disabled={busy} onClick={() => { void remove(removeTarget) }}>{busy ? '正在删除…' : '确认删除'}</button></div>
        </section>
      </div>}
      {deleteTaskTarget !== null && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) setDeleteTaskTarget(null) }}>
        <section ref={deleteTaskDialogRef} className={css.confirmDialog} role="dialog" aria-modal="true" aria-label="删除企业对话">
          <h2>删除对话</h2>
          <p>该对话记录会移入系统废纸篓或回收站，并从企业空间和最近对话列表删除；不进入已归档列表，也不能从客户端恢复。企业目录和已生成文件不受影响。</p>
          <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={busy} onClick={() => { setDeleteTaskTarget(null) }}>取消</button><button type="button" className={css.dangerButton} disabled={busy} onClick={() => { void deleteTask(deleteTaskTarget) }}>{busy ? '正在删除…' : '确认删除'}</button></div>
        </section>
      </div>}
      {createDialogOpen && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) setCreateDialogOpen(false) }}>
        <form ref={createDialogRef} className={`${css.confirmDialog} ${css.enterpriseCreateDialog}`} role="dialog" aria-modal="true" aria-labelledby="create-enterprise-title" onSubmit={(event) => { event.preventDefault(); void createNamedEnterprise() }}>
          <span className={css.eyebrow}>根目录直属企业空间</span>
          <h2 id="create-enterprise-title">新建企业</h2>
          <p>输入企业名称后，客户端会在当前企业空间根目录下创建同名文件夹并直接进入。</p>
          <label><span>企业名称</span><input autoFocus aria-label="企业名称" value={enterpriseName} maxLength={120} onChange={(event) => { setEnterpriseName(event.currentTarget.value); setError(null) }} placeholder="例如 杭州示例企业有限公司" /></label>
          {error !== null && <p className={css.dialogError} role="alert">{error}</p>}
          <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={busy} onClick={() => { setCreateDialogOpen(false) }}>取消</button><button type="submit" className={css.solidButton} disabled={busy || enterpriseName.trim() === ''}>{busy ? '正在创建…' : '创建并进入'}</button></div>
        </form>
      </div>}
      <EnterpriseDirectoryPicker
        open={directoryPickerOpen}
        busy={busy}
        listDirectory={props.listWorkspaceDirectory}
        createDirectory={props.createWorkspaceDirectory}
        onPick={(path) => { void connectDirectory(path) }}
        onClose={() => { if (!busy) setDirectoryPickerOpen(false) }}
      />
    </>
  )
}

interface SkillCategoryOption {
  readonly key: string
  readonly label: string
  readonly icon: IconName
  readonly keywords?: readonly string[]
}

const FEATURED_SKILL_CATEGORIES: readonly SkillCategoryOption[] = Object.freeze([
  { key: '', label: '全部', icon: 'blocks' },
  { key: 'office', label: '文档办公', icon: 'folder', keywords: ['docx', 'xlsx', 'pdf', 'ppt', '文档', '表格', '办公', 'ocr'] },
  { key: 'policy', label: '政策申报', icon: 'search', keywords: ['政策', '项目', '申报', '高企', '专精特新'] },
  { key: 'enterprise', label: '企业服务', icon: 'building', keywords: ['企业', '工商', '画像', '同行', '招投标'] },
  { key: 'intellectual-property', label: '知识产权', icon: 'shield', keywords: ['专利', '商标', '知识产权', 'patent'] },
  { key: 'finance-legal', label: '财税法务', icon: 'clock', keywords: ['财务', '财税', '税务', '法律', '法规', '合同'] },
])

const MODELSCOPE_SKILL_CATEGORIES: readonly SkillCategoryOption[] = Object.freeze([
  { key: '', label: '全部', icon: 'blocks' },
  { key: 'skill-management', label: 'Skills 管理', icon: 'settings' },
  { key: 'developer-tools', label: '开发工具', icon: 'plug' },
  { key: 'marketing-seo', label: '市场推广', icon: 'spark' },
  { key: 'frontend-development', label: '前端开发', icon: 'folder' },
  { key: 'ai-media', label: '媒体处理', icon: 'download' },
  { key: 'code-quality-testing', label: '代码质检', icon: 'shield' },
  { key: 'mobile-development', label: '移动开发', icon: 'user' },
  { key: 'cloud-devops', label: '云效工具', icon: 'external' },
  { key: 'other', label: '其他', icon: 'plus' },
])

const SKILLHUB_SKILL_CATEGORIES: readonly SkillCategoryOption[] = Object.freeze([
  { key: '', label: '全部', icon: 'blocks' },
  { key: 'office-efficiency', label: '办公效率', icon: 'folder' },
  { key: 'content-creation', label: '内容创作', icon: 'spark' },
  { key: 'dev-programming', label: '开发编程', icon: 'plug' },
  { key: 'data-analysis', label: '数据分析', icon: 'search' },
  { key: 'design-media', label: '设计多媒体', icon: 'download' },
  { key: 'ai-agent', label: 'AI Agent', icon: 'blocks' },
  { key: 'knowledge-management', label: '知识管理', icon: 'shield' },
  { key: 'business-ops', label: '商业运营', icon: 'building' },
  { key: 'education', label: '教育学习', icon: 'user' },
  { key: 'professional', label: '行业专业', icon: 'location' },
  { key: 'it-ops-security', label: '运维与安全', icon: 'settings' },
  { key: 'life-service', label: '生活服务', icon: 'clock' },
])

function categoryOptions(catalog: 'featured' | SkillMarketplaceSource, results: readonly MarketplaceSkillView[]): readonly SkillCategoryOption[] {
  if (catalog === 'featured') return FEATURED_SKILL_CATEGORIES
  if (catalog === 'modelscope') return MODELSCOPE_SKILL_CATEGORIES
  if (catalog === 'skillhub') return SKILLHUB_SKILL_CATEGORIES
  return [
    { key: '', label: '全部', icon: 'blocks' },
    ...[...new Set(results.map(skill => skill.category).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
      .map(key => ({ key, label: key, icon: 'folder' as const })),
  ]
}

function categoryDisplayName(catalog: 'featured' | SkillMarketplaceSource, key: string): string {
  return categoryOptions(catalog, []).find(option => option.key === key)?.label ?? key
}

function featuredCategoryMatch(skill: MarketplaceSkillView, category: string): boolean {
  if (category === '') return true
  const option = FEATURED_SKILL_CATEGORIES.find(row => row.key === category)
  const haystack = `${skill.name} ${skill.description} ${skill.category} ${skill.coordinate}`.toLowerCase()
  return option?.keywords?.some(keyword => haystack.includes(keyword.toLowerCase())) ?? false
}

function SkillsPage({ props }: { props: ProductOverlayProps }) {
  const marketplace = props.useMarketplace(state => state)
  const [view, setView] = useState<'installed' | 'community'>('community')
  const [catalog, setCatalog] = useState<'featured' | SkillMarketplaceSource>('featured')
  const [source, setSource] = useState<SkillMarketplaceSource>('modelscope')
  const [query, setQuery] = useState('')
  const [installedQuery, setInstalledQuery] = useState('')
  const [marketCategory, setMarketCategory] = useState('')
  const [repositoryModal, setRepositoryModal] = useState(false)
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [repositoryBusy, setRepositoryBusy] = useState(false)
  const [repositoryError, setRepositoryError] = useState('')
  const [repositoryRemoveTarget, setRepositoryRemoveTarget] = useState<MarketplaceRepositoryView | null>(null)
  const [repositoryRemoveBusy, setRepositoryRemoveBusy] = useState(false)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [removeTarget, setRemoveTarget] = useState<InstalledSkillView | null>(null)
  const catalogRef = useRef<HTMLElement>(null)
  const skillsDialogKey = removeTarget !== null
    ? `skill-remove-${removeTarget.id}`
    : detail !== null ? `skill-detail-${detail.skill.coordinate}` : repositoryModal ? 'skill-repository' : null
  const skillsDialogRef = useDialogFocusTrap(skillsDialogKey !== null, skillsDialogKey)
  const installed = marketplace.snapshot.installed.filter((skill) => {
    const value = installedQuery.trim().toLowerCase()
    return value === '' || `${skill.name} ${skill.description}`.toLowerCase().includes(value)
  })
  const searchPage = marketplace.search.page?.source === source
    && marketplace.search.category === marketCategory
    ? marketplace.search.page
    : null
  const results = searchPage?.skills ?? []
  const featured = marketplace.snapshot.featured.filter(skill => featuredCategoryMatch(skill, marketCategory))
  const categories = categoryOptions(catalog, results)
  const totalPages = searchPage === null ? 0 : Math.ceil(searchPage.total / searchPage.pageSize)
  useEffect(() => {
    if (catalog !== 'featured' && marketplace.search.status === 'idle') void props.searchSkills(source, '', 1, marketCategory).catch(() => undefined)
  }, [catalog, marketCategory, marketplace.search.status, props, source])
  useEffect(() => {
    const closeOverlay = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (removeTarget !== null) setRemoveTarget(null)
      else if (detail !== null) setDetail(null)
      else if (repositoryModal && !repositoryBusy) setRepositoryModal(false)
      else return
      event.preventDefault()
    }
    document.addEventListener('keydown', closeOverlay)
    return () => { document.removeEventListener('keydown', closeOverlay) }
  }, [detail, removeTarget, repositoryBusy, repositoryModal])
  const switchCatalog = (next: 'featured' | SkillMarketplaceSource) => {
    setView('community')
    setCatalog(next)
    setQuery('')
    setMarketCategory('')
    window.requestAnimationFrame(() => catalogRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    if (next !== 'featured') {
      setSource(next)
      void props.searchSkills(next, '', 1, '').catch(() => undefined)
    }
  }
  const submitSearch = async (event: React.FormEvent) => {
    event.preventDefault()
    await props.searchSkills(source, query, 1, marketCategory).catch(() => undefined)
  }
  const install = async (skill: MarketplaceSkillView) => {
    try {
      await props.installSkill(skill)
      setDetail(null)
      if (skill.requiresConfiguration && skill.configurationUrl !== undefined) {
        window.open(skill.configurationUrl, '_blank', 'noopener,noreferrer')
      }
    } catch {
      // The controller publishes the Host error; keep the detail open for retry.
    }
  }
  const addRepository = async () => {
    const value = repositoryUrl.trim()
    if (value === '') return
    setRepositoryBusy(true)
    setRepositoryError('')
    try {
      await props.addSkillRepository(value)
      setRepositoryUrl('')
      setRepositoryModal(false)
      switchCatalog('custom')
    } catch (reason) {
      setRepositoryError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRepositoryBusy(false)
    }
  }
  const removeRepository = async () => {
    if (repositoryRemoveTarget === null) return
    setRepositoryRemoveBusy(true)
    try {
      await props.removeSkillRepository(repositoryRemoveTarget.id)
      setRepositoryRemoveTarget(null)
    } catch {
      // Host error remains available in marketplace state; keep confirmation open.
    } finally {
      setRepositoryRemoveBusy(false)
    }
  }
  const remove = async (skill: InstalledSkillView) => {
    try {
      await props.removeSkill(skill)
      setRemoveTarget(null)
      setDetail(null)
    } catch {
      // Controller retains the Host error and the confirmation remains available for retry.
    }
  }
  const setEnabled = async (skill: InstalledSkillView, enabled: boolean): Promise<boolean> => {
    try {
      await props.setSkillEnabled(skill, enabled)
      return true
    } catch {
      // Controller publishes the Host error and refreshes state after a successful change.
      return false
    }
  }
  const selectCategory = (category: string) => {
    setMarketCategory(category)
    if (catalog !== 'featured') void props.searchSkills(source, query, 1, category).catch(() => undefined)
  }
  const sourceName = source === 'modelscope' ? '魔搭' : source === 'skillhub' ? '腾讯 SkillHub' : '第三方仓库'
  const renderCommunityCard = (skill: MarketplaceSkillView) => {
    const key = marketplaceInstallKey(skill)
    const busy = marketplace.installing.includes(key)
    const installedNow = marketplace.snapshot.installed.some(row =>
      row.source === skill.source
      && row.coordinate === skill.coordinate
      && (skill.source !== 'custom' || row.repositoryId === skill.repositoryId))
    return (
      <article className={css.featureCard} key={key}>
        <button type="button" className={css.skillCardMain} onClick={() => { setDetail({ kind: 'marketplace', skill }) }}>
          <span className={css.featureTop}>
            <span className={css.skillGlyph}>{skill.name.slice(0, 1)}</span>
            <span className={css.categoryTag}>{skill.source === 'modelscope' ? '魔搭' : skill.source === 'skillhub' ? 'SkillHub' : '第三方'} · {skill.category}</span>
          </span>
          <h3>{skill.name}</h3><p>{skill.description}</p>
          <span className={css.skillMeta}><span>{skill.coordinate}</span><span>{skill.downloads.toLocaleString('zh-CN')} 次下载</span></span>
        </button>
        <div className={css.cardFooter}>
          <small>{skill.configurationUrl !== undefined ? '安装后进入官方配置' : skill.requiresConfiguration ? '安装后需自行配置' : skillSourceLabel(skill.source, skill.version)}</small>
          <button type="button" disabled={busy || installedNow} data-installed={installedNow || undefined} onClick={() => { void install(skill) }}>
            {busy ? '正在安装…' : installedNow ? '已安装' : skill.configurationUrl !== undefined ? '安装并配置' : '一键安装'}
          </button>
        </div>
      </article>
    )
  }
  return (
    <>
      <Header eyebrow="已安装技能与技能市场" title="技能中心" description="浏览精选、魔搭、腾讯 SkillHub 和第三方仓库，点击即可安装。">
        <button className={css.outlineButton} type="button" disabled={marketplace.status === 'loading'} onClick={() => { void props.refreshSkills() }}>
          {marketplace.status === 'loading' ? '正在刷新…' : '刷新技能状态'}
        </button>
      </Header>
      {marketplace.error !== null && <p className={css.errorText}>技能服务失败：{marketplace.error}</p>}
      {marketplace.notice !== null && <p className={css.successText} aria-live="polite">{marketplace.notice}</p>}
      <nav className={css.skillViewTabs} aria-label="技能中心分类">
        <button type="button" aria-pressed={view === 'community'} data-active={view === 'community' || undefined} onClick={() => { setView('community') }}>
          <span>技能市场</span><b>{marketplace.snapshot.featured.length} 项精选</b>
        </button>
        <button type="button" aria-pressed={view === 'installed'} data-active={view === 'installed' || undefined} onClick={() => { setView('installed') }}>
          <span>已安装技能</span><b>{marketplace.snapshot.installed.length} 项</b>
        </button>
      </nav>
      {view === 'installed' ? <section className={css.sectionBlock}>
        <div className={css.sectionTitle}>
          <div><h2>已安装</h2><p>内置专业技能固定启用；社区技能可启用、停用或删除。</p></div>
          <span>{marketplace.snapshot.installed.length} 项</span>
        </div>
        <div className={css.inlineSearch}><Icon name="search" size={18} /><input aria-label="检索已安装技能" value={installedQuery} onChange={(event) => { setInstalledQuery(event.target.value) }} placeholder="检索已安装技能" /></div>
        {marketplace.status !== 'ready' && marketplace.snapshot.installed.length === 0
          ? <EmptyState title="正在读取已安装技能" text="客户端正在读取内置技能和社区技能。" />
          : installed.length === 0
            ? <EmptyState title="没有匹配的已安装技能" text="请换一个名称或分类关键词继续检索。" />
            : <div className={css.installedGrid}>{installed.map((skill) => {
              const toggling = marketplace.toggling.includes(skill.id)
              const removing = marketplace.removing.includes(skill.id)
              return <article key={skill.id} className={css.installedCard} data-disabled={!skill.enabled || undefined}>
                <div className={css.installedCardHead}>
                  <button type="button" className={css.installedCardMain} onClick={() => { setDetail({ kind: 'installed', skill }) }}>
                    <span className={css.skillGlyph}>{skill.name.slice(0, 1)}</span>
                    <span><strong>{skill.name}</strong><small>{skill.category}</small></span>
                  </button>
                  {skill.bundled
                    ? <span className={css.bundledSkillState} aria-label="内置技能固定启用">内置</span>
                    : <button type="button" className={css.skillEnableSwitch} role="switch" aria-checked={skill.enabled} aria-label={`${skill.enabled ? '停用' : '启用'}技能 ${skill.name}`} disabled={toggling} data-enabled={skill.enabled || undefined} onClick={() => { void setEnabled(skill, !skill.enabled) }}><span /></button>}
                </div>
                <p>{skill.description}</p>
                <footer className={css.installedCardFooter}>
                  <span>{skill.bundled ? skillSourceLabel(skill.source, skill.version) : skill.source === 'modelscope' ? '魔搭社区' : skill.source === 'skillhub' ? 'SkillHub 社区' : '第三方仓库'}</span>
                  <b data-enabled={skill.enabled || undefined}>{toggling ? '切换中…' : skill.enabled ? '已启用' : '已停用'}</b>
                  <button type="button" onClick={() => { setDetail({ kind: 'installed', skill }) }}>详情</button>
                  {!skill.bundled && <button type="button" className={css.installedRemove} disabled={removing} aria-label={`删除技能 ${skill.name}`} onClick={() => { setRemoveTarget(skill) }}>{removing ? '删除中…' : '删除'}</button>}
                </footer>
              </article>
            })}</div>}
      </section> : <>
        <section className={css.repositoryStrip} aria-label="技能市场入口">
          <button type="button" className={css.repositoryCard} aria-pressed={catalog === 'featured'} data-active={catalog === 'featured' || undefined} onClick={() => { switchCatalog('featured') }}>
            <span className={css.repositoryBadge}>精</span><span><strong>精选</strong></span><StatusDot active />
          </button>
          <button type="button" className={css.repositoryCard} aria-pressed={catalog === 'modelscope'} data-active={catalog === 'modelscope' || undefined} onClick={() => { switchCatalog('modelscope') }}>
            <span className={css.repositoryBadge}>魔</span>
            <span><strong>魔搭 ModelScope</strong></span>
            <StatusDot active />
          </button>
          <button type="button" className={css.repositoryCard} aria-pressed={catalog === 'skillhub'} data-active={catalog === 'skillhub' || undefined} onClick={() => { switchCatalog('skillhub') }}>
            <span className={css.repositoryBadge}>S</span>
            <span><strong>腾讯 SkillHub</strong></span>
            <StatusDot active />
          </button>
          <button type="button" className={css.repositoryCard} aria-pressed={catalog === 'custom'} data-active={catalog === 'custom' || undefined} onClick={() => { switchCatalog('custom') }}>
            <span className={css.repositoryBadge}>＋</span>
            <span><strong>第三方仓库</strong></span>
            <StatusDot active={marketplace.snapshot.repositories.length > 0} />
          </button>
        </section>
        <nav className={css.skillCategoryRail} aria-label="技能分类">
          {categories.map(category => <button type="button" key={category.key || 'all'} aria-pressed={marketCategory === category.key} data-active={marketCategory === category.key || undefined} onClick={() => { selectCategory(category.key) }}>
            <span><Icon name={category.icon} size={18} /></span><small>{category.label}</small>
          </button>)}
        </nav>
        <section className={css.sectionBlock} ref={catalogRef}>
          {catalog === 'featured' ? <>
            <div className={css.sectionTitle}>
              <div><h2>精选</h2><p>核心办公能力常驻；政策、企业核验、知识产权、财务与交付能力按日轮换，已安装项保留并标记状态。</p></div>
              <span>{featured.length} 项本期推荐</span>
            </div>
            {featured.length === 0
              ? <EmptyState title={marketplace.snapshot.featured.length === 0 ? '精选目录暂不可用' : '该分类暂无本期推荐'} text={marketplace.snapshot.featured.length === 0 ? '请检查网络后刷新。' : '可切换到全部分类，或进入魔搭和腾讯 SkillHub 继续检索。'} />
              : <div className={css.cardGrid}>{featured.map(renderCommunityCard)}</div>}
          </> : <>
            <div className={css.sectionTitle}>
              <div><h2>{sourceName} 技能市场</h2><p>{marketCategory === '' ? '全部分类' : categoryDisplayName(catalog, marketCategory)} · 可继续搜索和翻页</p></div>
              <span>{searchPage?.total ?? 0} 项结果</span>
            </div>
            {source === 'custom' && marketplace.snapshot.repositories.length > 0 && <div className={css.repositoryList}>
              <span>已添加仓库</span>
              {marketplace.snapshot.repositories.map(repository => <div className={css.repositoryListItem} key={repository.id}>
                <button type="button" onClick={() => { void props.searchSkills('custom', '', 1, marketCategory) }}>
                  {repository.name}<small>{repository.skillCount} 项</small>
                </button>
                <button type="button" className={css.contextDanger} onClick={() => { setRepositoryRemoveTarget(repository) }}>移除</button>
              </div>)}
              <button type="button" onClick={() => { setRepositoryError(''); setRepositoryModal(true) }}>＋ 添加仓库</button>
            </div>}
            {source === 'custom' && marketplace.snapshot.repositories.length === 0
              ? <div className={css.customRepositoryEmpty}><EmptyState title="还没有第三方仓库" text="添加公开 HTTPS 兼容清单后，目录会在这里显示并支持检索、详情、翻页和安装。" /><button type="button" className={css.solidButton} onClick={() => { setRepositoryError(''); setRepositoryModal(true) }}>添加第三方仓库</button></div>
              : <>
                <form className={css.marketplaceSearch} onSubmit={(event) => { void submitSearch(event) }}>
                  <Icon name="search" size={18} /><input key={source} value={query} onChange={(event) => { setQuery(event.target.value) }} aria-label={`在${sourceName}中搜索技能`} placeholder={`在${sourceName}中搜索技能`} />
                  <button type="submit" disabled={marketplace.search.status === 'loading'}>{marketplace.search.status === 'loading' ? '搜索中…' : '搜索'}</button>
                </form>
                {marketplace.search.error !== null && <p className={css.errorText}>社区搜索失败：{marketplace.search.error}</p>}
                {marketplace.search.status === 'ready' && results.length === 0
                  ? <EmptyState title="没有找到匹配技能" text="可翻到其他页、换一个关键词，或切换到另一个市场继续检索。" />
                  : <div className={css.cardGrid}>{results.map(renderCommunityCard)}</div>}
                {searchPage !== null && totalPages > 1 && <nav className={css.pagination} aria-label="技能市场翻页">
                  <button type="button" disabled={marketplace.search.status === 'loading' || searchPage.page <= 1} onClick={() => { void props.searchSkills(source, marketplace.search.query, searchPage.page - 1, marketCategory) }}>上一页</button>
                  <div>{marketplacePageItems(searchPage.page, totalPages).map((page, index) => page === null
                    ? <span key={`gap-${String(index)}`}>…</span>
                    : <button type="button" key={page} data-active={page === searchPage.page || undefined} disabled={marketplace.search.status === 'loading'} aria-current={page === searchPage.page ? 'page' : undefined} onClick={() => { void props.searchSkills(source, marketplace.search.query, page, marketCategory) }}>{page}</button>)}</div>
                  <small>第 {searchPage.page} / {totalPages} 页</small>
                  <button type="button" disabled={marketplace.search.status === 'loading' || searchPage.page >= totalPages} onClick={() => { void props.searchSkills(source, marketplace.search.query, searchPage.page + 1, marketCategory) }}>下一页</button>
                </nav>}
              </>}
          </>}
        </section>
      </>}
      {repositoryModal && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !repositoryBusy) setRepositoryModal(false) }}>
        <section ref={skillsDialogRef} className={css.connectionModal} role="dialog" aria-modal="true" aria-labelledby="repository-dialog-title">
          <div className={css.modalHead}><div><span>第三方仓库</span><h2 id="repository-dialog-title">添加第三方技能仓库</h2></div><button type="button" disabled={repositoryBusy} aria-label="关闭" onClick={() => { setRepositoryModal(false) }}>×</button></div>
          <div className={css.repositoryModalBody}>
            <p>粘贴仓库提供的 HTTPS 技能清单地址，添加后即可在客户端内浏览并安装。</p>
            <label><span>仓库清单地址</span><input type="url" value={repositoryUrl} onChange={(event) => { setRepositoryUrl(event.target.value) }} placeholder="https://example.com/gongchuang-skills.json" autoFocus /></label>
            {repositoryError !== '' && <p className={css.errorText}>{repositoryError}</p>}
          </div>
          <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={repositoryBusy} onClick={() => { setRepositoryModal(false) }}>取消</button><button type="button" className={css.solidButton} disabled={repositoryBusy || repositoryUrl.trim() === ''} onClick={() => { void addRepository() }}>{repositoryBusy ? '正在添加…' : '添加仓库'}</button></div>
        </section>
      </div>}
      {repositoryRemoveTarget !== null && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !repositoryRemoveBusy) setRepositoryRemoveTarget(null) }}>
        <section ref={skillsDialogRef} className={css.connectionModal} role="dialog" aria-modal="true" aria-labelledby="repository-remove-title">
          <div className={css.modalHead}><div><span>第三方仓库</span><h2 id="repository-remove-title">移除仓库</h2></div><button type="button" disabled={repositoryRemoveBusy} aria-label="关闭" onClick={() => { setRepositoryRemoveTarget(null) }}>×</button></div>
          <div className={css.repositoryModalBody}><p>确定移除“{repositoryRemoveTarget.name}”？已安装的第三方技能会保留，不会被删除。</p></div>
          <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={repositoryRemoveBusy} onClick={() => { setRepositoryRemoveTarget(null) }}>取消</button><button type="button" className={css.dangerButton} disabled={repositoryRemoveBusy} onClick={() => { void removeRepository() }}>{repositoryRemoveBusy ? '正在移除…' : '移除仓库'}</button></div>
        </section>
      </div>}
      {detail !== null && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setDetail(null) }}>
        <section ref={skillsDialogRef} className={`${css.connectionModal} ${css.skillDetailModal}`} role="dialog" aria-modal="true" aria-labelledby="skill-detail-title">
          <div className={css.modalHead}><div><span>技能详情</span><h2 id="skill-detail-title">{detail.skill.name}</h2></div><button type="button" aria-label="关闭" onClick={() => { setDetail(null) }}>×</button></div>
          <div className={css.skillDetailBody}>
            <p>{detail.skill.description}</p>
            {detail.kind === 'marketplace' ? <dl>
              <div><dt>来源</dt><dd>{skillSourceLabel(detail.skill.source, detail.skill.version)}</dd></div>
              <div><dt>分类</dt><dd>{detail.skill.category}</dd></div>
              <div><dt>版本</dt><dd>{detail.skill.version}</dd></div>
              <div><dt>许可</dt><dd>{detail.skill.license}</dd></div>
              <div><dt>下载量</dt><dd>{detail.skill.downloads.toLocaleString('zh-CN')}</dd></div>
              <div><dt>配置要求</dt><dd>{detail.skill.configurationUrl !== undefined ? '安装后进入官方配置' : detail.skill.requiresConfiguration ? '安装后按社区说明自行配置' : '平台未标注额外配置'}</dd></div>
            </dl> : <dl>
              <div><dt>来源</dt><dd>{skillSourceLabel(detail.skill.source, detail.skill.version)}</dd></div>
              <div><dt>状态</dt><dd>{detail.skill.bundled ? '已启用 · 内置' : detail.skill.enabled ? '已启用' : '已停用'}</dd></div>
              <div><dt>版本</dt><dd>{detail.skill.version}</dd></div>
              <div><dt>许可</dt><dd>{detail.skill.license ?? '未标注'}</dd></div>
              <div><dt>配置要求</dt><dd>{detail.skill.configurationUrl !== undefined ? '需要完成官方配置' : detail.skill.requiresConfiguration ? '需要按社区说明自行配置' : '未标注额外配置'}</dd></div>
              <div><dt>安装时间</dt><dd>{new Date(detail.skill.installedAt).toLocaleString('zh-CN')}</dd></div>
            </dl>}
            {detail.skill.requiresConfiguration && detail.skill.configurationUrl !== undefined && <div className={css.configurationNotice}><Icon name="external" size={17} /><span><strong>安装后的下一步</strong><small>客户端会打开该技能的官方配置页面；只有完成官方授权或密钥验证后，相关工具才可使用。</small></span></div>}
          </div>
          <div className={css.modalActions}>
            {detail.skill.detailUrl !== undefined
              && <a className={css.outlineButton} href={detail.skill.detailUrl} target="_blank" rel="noreferrer">打开社区原页</a>}
            {detail.kind === 'installed' && detail.skill.configurationUrl !== undefined && <a className={css.solidButton} href={detail.skill.configurationUrl} target="_blank" rel="noreferrer">打开官方配置</a>}
            {detail.kind === 'installed' && !detail.skill.bundled && <button type="button" className={css.outlineButton} disabled={marketplace.toggling.includes(detail.skill.id)} onClick={() => { void setEnabled(detail.skill, !detail.skill.enabled).then((changed) => { if (changed) setDetail(null) }) }}>{marketplace.toggling.includes(detail.skill.id) ? '切换中…' : detail.skill.enabled ? '停用技能' : '启用技能'}</button>}
            {detail.kind === 'installed' && !detail.skill.bundled && <button type="button" className={css.dangerButton} onClick={() => { setRemoveTarget(detail.skill) }}>删除技能</button>}
            {detail.kind === 'marketplace' && (() => {
              const installedNow = marketplace.snapshot.installed.some(row =>
                row.source === detail.skill.source
                && row.coordinate === detail.skill.coordinate
                && (detail.skill.source !== 'custom' || row.repositoryId === detail.skill.repositoryId))
              if (installedNow && detail.skill.configurationUrl !== undefined) {
                return <a className={css.solidButton} href={detail.skill.configurationUrl} target="_blank" rel="noreferrer">打开官方配置</a>
              }
              return <button type="button" className={css.solidButton} disabled={installedNow || marketplace.installing.includes(marketplaceInstallKey(detail.skill))} onClick={() => { void install(detail.skill) }}>{installedNow ? '已安装' : detail.skill.configurationUrl !== undefined ? '安装并进入配置' : '一键安装'}</button>
            })()}
          </div>
        </section>
      </div>}
      {removeTarget !== null && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !marketplace.removing.includes(removeTarget.id)) setRemoveTarget(null) }}>
        <section ref={skillsDialogRef} className={css.confirmDialog} role="dialog" aria-modal="true" aria-label={`删除技能 ${removeTarget.name}`}>
          <h2>删除“{removeTarget.name}”</h2>
          <p>该技能会立即退出模型能力范围，并回到技能市场的未安装状态；以后仍可重新安装。</p>
          <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={marketplace.removing.includes(removeTarget.id)} onClick={() => { setRemoveTarget(null) }}>取消</button><button type="button" className={css.dangerButton} disabled={marketplace.removing.includes(removeTarget.id)} onClick={() => { void remove(removeTarget) }}>{marketplace.removing.includes(removeTarget.id) ? '正在删除…' : '确认删除'}</button></div>
        </section>
      </div>}
    </>
  )
}

function McpPage({ props }: { props: ProductOverlayProps }) {
  const connectorState = props.useConnectors(state => state)
  const [busy, setBusy] = useState<GongchuangConnectorId | null>(null)
  const [error, setError] = useState('')
  const [errorCopied, setErrorCopied] = useState(false)
  const [statusCopiedId, setStatusCopiedId] = useState<GongchuangConnectorId | null>(null)
  const [configuring, setConfiguring] = useState<GongchuangConnectorView | null>(null)
  const [detailId, setDetailId] = useState<GongchuangConnectorId | null>(null)
  const [credential, setCredential] = useState('')
  const [knowledgeEndpoint, setKnowledgeEndpoint] = useState('')
  const [tianyanchaAuthorization, setTianyanchaAuthorization] = useState<TianyanchaAuthorizationStart | null>(null)
  const [authorizing, setAuthorizing] = useState<readonly GongchuangConnectorId[]>([])
  const authorizationEpoch = useRef({ qcc: 0, tianyancha: 0 })
  const configuringId = useRef(configuring?.id)
  configuringId.current = configuring?.id
  const cancelAuthorization = useRef(props.cancelMcpAuthorization)
  cancelAuthorization.current = props.cancelMcpAuthorization
  useEffect(() => () => {
    const id = configuringId.current
    if (id === 'qcc' || id === 'tianyancha') {
      authorizationEpoch.current[id] += 1
      // 离开连接页与关闭弹窗具有同样的取消语义；失败由连接器状态保留，允许重试。
      void cancelAuthorization.current(id).catch(() => undefined)
    }
  }, [])
  const [remoteDataConsent, setRemoteDataConsent] = useState(false)
  const [customEditor, setCustomEditor] = useState<'new' | GongchuangConnectorView | null>(null)
  const [customName, setCustomName] = useState('')
  const [customTransport, setCustomTransport] = useState<GongchuangCustomMcpTransport>('streamable-http')
  const [customEndpoint, setCustomEndpoint] = useState('')
  const [customArgs, setCustomArgs] = useState('')
  const [customCwd, setCustomCwd] = useState('')
  const [customAuth, setCustomAuth] = useState<GongchuangCustomMcpAuthMode>('none')
  const [customCredentialName, setCustomCredentialName] = useState('')
  const [customCredentialPrefix, setCustomCredentialPrefix] = useState('')
  const [customCredential, setCustomCredential] = useState('')
  const [removeTarget, setRemoveTarget] = useState<GongchuangCustomConnectorId | null>(null)
  const byId = new Map(connectorState.snapshot.connectors.map(connector => [connector.id, connector]))
  const cards = [
    ...MCP_CARDS.filter(item => item.id !== 'gongchuang-search'),
    ...connectorState.snapshot.connectors.filter(connector => connector.custom).map(connector => ({
      id: connector.id,
      name: connector.name,
      description: connector.transport === 'streamable-http'
        ? '用户添加的 Streamable HTTP MCP。'
        : '用户添加的本机 stdio MCP。',
      status: '自定义',
      url: '',
      dataBoundary: undefined,
    })),
  ]
  const connectorDialogKey = detailId !== null
    ? `connector-detail-${detailId}`
    : configuring !== null
      ? `connector-configure-${configuring.id}`
      : customEditor !== null
        ? customEditor === 'new' ? 'custom-mcp-new' : `custom-mcp-${customEditor.id}`
        : removeTarget === null ? null : `custom-mcp-remove-${removeTarget}`
  const connectorDialogRef = useDialogFocusTrap(connectorDialogKey !== null, connectorDialogKey)
  const closeConfiguration = useCallback(() => {
    const id = configuring?.id
    if (id === 'qcc' || id === 'tianyancha') {
      authorizationEpoch.current[id] += 1
      if (authorizing.includes(id) || (id === 'tianyancha' && tianyanchaAuthorization !== null)) {
        void props.cancelMcpAuthorization(id).catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }
      setAuthorizing(current => current.filter(candidate => candidate !== id))
    }
    configuringId.current = undefined
    setConfiguring(null)
    setTianyanchaAuthorization(null)
    setRemoteDataConsent(false)
  }, [configuring, authorizing, tianyanchaAuthorization, props.cancelMcpAuthorization])
  useEffect(() => { setErrorCopied(false) }, [error])
  useEffect(() => { setStatusCopiedId(null) }, [connectorState.snapshot.revision])
  useEffect(() => {
    const closeOverlay = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (detailId !== null) {
        event.preventDefault()
        setDetailId(null)
        return
      }
      if (customEditor !== null && busy === null) {
        event.preventDefault()
        setCustomEditor(null)
        return
      }
      if (removeTarget !== null && busy === null) {
        event.preventDefault()
        setRemoveTarget(null)
        return
      }
      if (configuring !== null && busy === null) {
        event.preventDefault()
        closeConfiguration()
      }
    }
    document.addEventListener('keydown', closeOverlay)
    return () => { document.removeEventListener('keydown', closeOverlay) }
  }, [busy, configuring, customEditor, detailId, removeTarget, closeConfiguration])
  const copyConnectionError = async () => {
    if (error === '') return
    if (await writeClipboard(error)) setErrorCopied(true)
  }
  const copyConnectorStatus = async (connector: GongchuangConnectorView) => {
    if (await writeClipboard(connector.message)) setStatusCopiedId(connector.id)
  }
  const act = async (connector: GongchuangConnectorView | undefined, id: GongchuangConnectorId) => {
    if (connector === undefined) return
    setError('')
    if (!connector.enabled || connector.phase !== 'ready') {
      if (connector.credentialWritable) {
        setCredential('')
        setTianyanchaAuthorization(null)
        setRemoteDataConsent(false)
        setKnowledgeEndpoint(connector.endpoint)
        setConfiguring(connector)
        return
      }
    }
    setBusy(id)
    try {
      if (connector.enabled && connector.phase === 'ready') {
        await props.setMcpEnabled(id, false)
        return
      }
      await props.setMcpEnabled(id, true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }
  const verifyConfiguration = async () => {
    if (configuring === null || authorizing.includes(configuring.id)) return
    const value = credential.trim()
    if (!configuring.credentialConfigured && value === '') return
    setBusy(configuring.id)
    setError('')
    try {
      if (configuring.id === 'gongchuang-knowledge') await props.configureMcp(configuring.id, value, knowledgeEndpoint)
      else if (value === '') await props.setMcpEnabled(configuring.id, true)
      else await props.configureMcp(configuring.id, value)
      setConfiguring(null)
      setCredential('')
      setRemoteDataConsent(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }
  const authorizeQcc = async () => {
    const epoch = ++authorizationEpoch.current.qcc
    setAuthorizing(current => [...current, 'qcc'])
    setError('')
    try {
      await props.authorizeQcc()
      if (authorizationEpoch.current.qcc === epoch && configuringId.current === 'qcc') {
        setConfiguring(null)
        setCredential('')
      }
    } catch (reason) {
      if (authorizationEpoch.current.qcc === epoch && (configuringId.current === undefined || configuringId.current === 'qcc')) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (authorizationEpoch.current.qcc === epoch) setAuthorizing(current => current.filter(id => id !== 'qcc'))
    }
  }
  const beginTianyanchaAuthorization = async () => {
    const epoch = ++authorizationEpoch.current.tianyancha
    setAuthorizing(current => [...current, 'tianyancha'])
    setError('')
    try {
      const authorization = await props.beginTianyanchaAuthorization()
      if (authorizationEpoch.current.tianyancha === epoch && configuringId.current === 'tianyancha') setTianyanchaAuthorization(authorization)
    } catch (reason) {
      if (authorizationEpoch.current.tianyancha === epoch && (configuringId.current === undefined || configuringId.current === 'tianyancha')) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (authorizationEpoch.current.tianyancha === epoch) setAuthorizing(current => current.filter(id => id !== 'tianyancha'))
    }
  }
  const completeTianyanchaAuthorization = async () => {
    if (tianyanchaAuthorization === null) return
    const epoch = ++authorizationEpoch.current.tianyancha
    setAuthorizing(current => [...current, 'tianyancha'])
    setError('')
    try {
      await props.completeTianyanchaAuthorization(tianyanchaAuthorization.transactionId)
      if (authorizationEpoch.current.tianyancha === epoch && configuringId.current === 'tianyancha') {
        setConfiguring(null)
        setCredential('')
        setTianyanchaAuthorization(null)
      }
    } catch (reason) {
      if (authorizationEpoch.current.tianyancha === epoch && (configuringId.current === undefined || configuringId.current === 'tianyancha')) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (authorizationEpoch.current.tianyancha === epoch) setAuthorizing(current => current.filter(id => id !== 'tianyancha'))
    }
  }
  const editCustom = (connector?: GongchuangConnectorView) => {
    setError('')
    setCustomEditor(connector ?? 'new')
    setCustomName(connector?.name ?? '')
    setCustomTransport(connector?.transport ?? 'streamable-http')
    setCustomEndpoint(connector?.endpoint ?? '')
    setCustomArgs(connector?.arguments.join('\n') ?? '')
    setCustomCwd(connector?.cwd ?? '')
    setCustomAuth(connector?.authMode ?? 'none')
    setCustomCredentialName(connector?.credentialName ?? '')
    setCustomCredentialPrefix(connector?.credentialPrefix ?? '')
    setCustomCredential('')
  }
  const saveCustom = async () => {
    if (customEditor === null) return
    const id = customEditor === 'new' ? undefined : customEditor.id
    const request: GongchuangCustomMcpUpsertRequest = {
      ...(id === undefined ? {} : { id }),
      name: customName,
      transport: customTransport,
      ...(customTransport === 'streamable-http'
        ? { url: customEndpoint }
        : { command: customEndpoint, args: customArgs.split(/\r?\n/u).map(value => value.trim()).filter(Boolean), cwd: customCwd }),
      authMode: customAuth,
      ...(customCredentialName.trim() === '' ? {} : { credentialName: customCredentialName }),
      ...(customCredentialPrefix === '' ? {} : { credentialPrefix: customCredentialPrefix }),
      ...(customCredential.trim() === '' ? {} : { credentialValue: customCredential }),
    }
    setBusy(id ?? 'custom-new')
    setError('')
    try {
      await props.upsertCustomMcp(request)
      setCustomEditor(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }
  const removeCustom = async () => {
    if (removeTarget === null) return
    setBusy(removeTarget)
    setError('')
    try {
      await props.removeCustomMcp(removeTarget)
      setRemoveTarget(null)
      if (detailId === removeTarget) setDetailId(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }
  const connectorSetup = configuring === null ? undefined : CONNECTOR_SETUPS[configuring.id]
  const consentRequired = connectorSetup?.remoteDataConsent !== undefined
  return (
    <>
      <Header eyebrow="外部能力连接" title="MCP 连接" description="在这里配置企业数据、OCR 和其他 MCP 工具。密钥只进入系统安全存储，不写入对话。">
        <button type="button" className={css.solidButton} onClick={() => { editCustom() }}><Icon name="plus" size={17} />添加 MCP</button>
      </Header>
      {connectorState.error !== null && <p className={css.errorText}>连接状态读取失败：{connectorState.error}</p>}
      {error !== '' && configuring === null && <div className={css.copyableConnectionError} role="alert"><span>{error}</span><button type="button" aria-label="复制连接错误代码和详情" onClick={() => { void copyConnectionError() }}>{errorCopied ? '已复制' : '复制错误'}</button></div>}
      <section className={css.connectionGrid}>{cards.map((item) => {
        const connector = byId.get(item.id)
        const active = connector?.phase === 'ready'
        const failed = connector?.phase === 'error' || connector?.phase === 'unavailable'
        const status = connector?.message ?? (connectorState.status === 'loading' ? '正在读取宿主状态' : '宿主连接器未装载')
        return (
          <article key={item.id} className={css.connectionCard}>
            <div className={css.connectionHead}><span className={css.connectionLogo}>{item.name.slice(0, 1)}</span><span className={css.connectionStatus}><StatusDot active={active} />{active ? '已就绪' : connector?.phase === 'connecting' ? '连接中' : connector?.phase === 'missing-credential' ? '待配置' : connector?.phase === 'disabled' ? '未启用' : '不可用'}</span></div>
            <h3>{item.name}</h3><p>{item.description}</p>
            {item.dataBoundary !== undefined && <span className={css.connectorBoundary}><Icon name="shield" size={14} />{item.dataBoundary}</span>}
            <small title={status}>{status}</small>
            <div className={css.connectionActions}>
              <button type="button" className={css.connectorDetailButton} onClick={() => { setDetailId(item.id) }}>查看详情</button>
              {connector?.custom && <button type="button" className={css.connectorDetailButton} onClick={() => { editCustom(connector) }}>编辑</button>}
              {connector?.custom && <button type="button" className={css.connectorDetailButton} onClick={() => { setRemoveTarget(connector.id) }}>移除</button>}
              {failed && <button type="button" className={css.connectorDetailButton} aria-label={`复制${item.name}连接错误代码和详情`} onClick={() => { void copyConnectorStatus(connector) }}>{statusCopiedId === item.id ? '已复制' : '复制错误'}</button>}
              {(connector?.officialConfigUrl ?? item.url) !== '' && <a href={connector?.officialConfigUrl ?? item.url} target="_blank" rel="noreferrer">打开官方配置<Icon name="external" size={14} /></a>}
              <button type="button" disabled={connector === undefined || busy === item.id || authorizing.includes(item.id)} data-enabled={active || undefined} onClick={() => { void act(connector, item.id) }}>
                {authorizing.includes(item.id) ? '等待官方授权…' : busy === item.id ? '正在验证…' : active ? '停用' : connector?.credentialConfigured ? '重新连接' : connector?.credentialWritable ? '配置并连接' : '启用'}
              </button>
            </div>
          </article>
        )
      })}</section>
      {customEditor !== null && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && busy === null) setCustomEditor(null) }}>
        <section ref={connectorDialogRef} className={css.connectionModal} role="dialog" aria-modal="true" aria-labelledby="custom-mcp-title">
          <div className={css.modalHead}><div><span>自定义连接</span><h2 id="custom-mcp-title">{customEditor === 'new' ? '添加 MCP' : '编辑 MCP'}</h2></div><button type="button" disabled={busy !== null} aria-label="关闭" onClick={() => { setCustomEditor(null) }}>×</button></div>
          <div className={css.customMcpForm}>
            <label><span>MCP 名称</span><input value={customName} onChange={(event) => { setCustomName(event.target.value) }} placeholder="例如：公司内部知识库" /></label>
            <label><span>连接方式</span><select value={customTransport} onChange={(event) => { const value = event.target.value as GongchuangCustomMcpTransport; setCustomTransport(value); setCustomAuth('none') }}><option value="streamable-http">Streamable HTTP</option><option value="stdio">本机 stdio</option></select></label>
            <label><span>{customTransport === 'streamable-http' ? 'MCP 地址' : '启动命令'}</span><input value={customEndpoint} onChange={(event) => { setCustomEndpoint(event.target.value) }} placeholder={customTransport === 'streamable-http' ? 'https://example.com/mcp' : 'enterprise-mcp'} /></label>
            {customTransport === 'stdio' && <><label><span>启动参数，每行一项</span><textarea rows={4} value={customArgs} onChange={(event) => { setCustomArgs(event.target.value) }} placeholder={'--stdio\n--config\nC:\\path\\config.json'} /></label><label><span>工作目录，可选</span><input value={customCwd} onChange={(event) => { setCustomCwd(event.target.value) }} placeholder="留空使用当前企业空间" /></label></>}
            <label><span>鉴权方式</span><select value={customAuth} onChange={(event) => { setCustomAuth(event.target.value as GongchuangCustomMcpAuthMode) }}><option value="none">无鉴权</option>{customTransport === 'streamable-http' ? <><option value="bearer">Bearer Token</option><option value="header">自定义请求头</option></> : <option value="env">环境变量</option>}</select></label>
            {(customAuth === 'header' || customAuth === 'env') && <label><span>{customAuth === 'header' ? '请求头名称' : '环境变量名'}</span><input value={customCredentialName} onChange={(event) => { setCustomCredentialName(event.target.value) }} placeholder={customAuth === 'header' ? 'X-API-Key' : 'MCP_API_TOKEN'} /></label>}
            {customAuth === 'header' && <label><span>值前缀，可选</span><input value={customCredentialPrefix} onChange={(event) => { setCustomCredentialPrefix(event.target.value) }} placeholder="例如：Bearer " /></label>}
            {customAuth !== 'none' && <label><span>访问凭据</span><input type="password" autoComplete="off" value={customCredential} onChange={(event) => { setCustomCredential(event.target.value) }} placeholder={customEditor === 'new' ? '粘贴访问凭据' : '留空则保留已存凭据'} /></label>}
          </div>
          <p className={css.connectorReceipt}>保存后客户端会立即连接并执行 tools/list，只有真实发现工具才显示“已就绪”。</p>
          {error !== '' && <div className={`${css.modalError} ${css.copyableModalError}`} role="alert"><span>{error}</span><button type="button" onClick={() => { void copyConnectionError() }}>{errorCopied ? '已复制' : '复制错误'}</button></div>}
          <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={busy !== null} onClick={() => { setCustomEditor(null) }}>取消</button><button type="button" className={css.solidButton} disabled={busy !== null || customName.trim() === '' || customEndpoint.trim() === '' || (customAuth !== 'none' && customEditor === 'new' && customCredential.trim() === '')} onClick={() => { void saveCustom() }}>{busy !== null ? '正在连接…' : '保存并连接'}</button></div>
        </section>
      </div>}
      {removeTarget !== null && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && busy === null) setRemoveTarget(null) }}>
        <section ref={connectorDialogRef} className={css.confirmDialog} role="dialog" aria-modal="true" aria-label="移除自定义 MCP"><h2>移除自定义 MCP</h2><p>该 MCP 的连接、工具和系统存储凭据会从客户端移除。</p>{error !== '' && <p className={css.modalError}>{error}</p>}<div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={busy !== null} onClick={() => { setRemoveTarget(null) }}>取消</button><button type="button" className={css.dangerButton} disabled={busy !== null} onClick={() => { void removeCustom() }}>{busy === removeTarget ? '正在移除…' : '确认移除'}</button></div></section>
      </div>}
      {configuring !== null && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && busy === null) closeConfiguration() }}>
        <section ref={connectorDialogRef} className={css.connectionModal} role="dialog" aria-modal="true" aria-labelledby="connector-dialog-title">
          <div className={css.modalHead}><div><span>安全连接向导</span><h2 id="connector-dialog-title">{configuring.id === 'gongchuang-knowledge' ? props.t('knowledge.connectTitle') : <>连接{configuring.name}</>}</h2></div><button type="button" disabled={busy !== null} aria-label="关闭" onClick={closeConfiguration}>×</button></div>
          {configuring.id === 'gongchuang-knowledge' && <label className={css.accountField}><span>{props.t('knowledge.endpoint')}</span><input type="url" value={knowledgeEndpoint} onChange={(event) => { setKnowledgeEndpoint(event.currentTarget.value) }} placeholder={props.t('knowledge.endpointPlaceholder')} /></label>}
          {configuring.id === 'qcc' && <div className={css.oauthChoice}><div><strong>推荐：登录企查查并授权</strong><p>客户端会打开企查查官方登录页，授权完成后自动保存令牌并验证企业查询所需的核心 MCP 服务，无需复制 API Key。</p></div><button type="button" className={css.solidButton} disabled={busy !== null || authorizing.includes('qcc')} onClick={() => { void authorizeQcc() }}>{authorizing.includes('qcc') ? '等待官方授权…' : '登录企查查并授权'}</button></div>}
          {configuring.id === 'tianyancha' && <div className={css.oauthChoice}>{tianyanchaAuthorization === null
            ? <><div><strong>登录天眼查并授权</strong></div><button type="button" className={css.solidButton} disabled={busy !== null || authorizing.includes('tianyancha')} onClick={() => { void beginTianyanchaAuthorization() }}>{authorizing.includes('tianyancha') ? '正在打开…' : '登录并授权'}</button></>
            : <><div><strong>授权码</strong><code className={css.deviceCode}>{tianyanchaAuthorization.userCode}</code></div><button type="button" className={css.solidButton} disabled={busy !== null || authorizing.includes('tianyancha')} onClick={() => { void completeTianyanchaAuthorization() }}>{authorizing.includes('tianyancha') ? '正在验证…' : '我已完成授权'}</button></>}</div>}
          {connectorSetup?.remoteDataConsent !== undefined && <div className={css.dataBoundaryNotice} role="note"><Icon name="shield" size={19} /><div><strong>先确认数据去向</strong><p>当前 OCR 使用百度 AI Studio 官方 API，不是本地离线识别。连接验证不会上传企业文件；后续只有明确提交给 OCR 的文件才会上传。</p></div></div>}
          {(configuring.id === 'qcc' || configuring.id === 'tianyancha') && <div className={css.manualDivider}><span>或手动粘贴 API Key</span></div>}
          <ol className={css.guideSteps}>
            <li><span>1</span><div>{configuring.id === 'gongchuang-knowledge' ? <div className={css.knowledgeContact}><div><strong>{props.t('knowledge.credentialsTitle')}</strong><p>{props.t('knowledge.credentialsGuide')}</p></div><img src={WECHAT_QR_DATA_URL} alt={props.t('knowledge.wechatQr')} width={160} /></div> : <><strong>登录{connectorSetup?.platform ?? '官方平台'}</strong><p>{connectorSetup?.guide ?? '登录官方平台并取得访问凭据。'}</p>{configuring.officialConfigUrl && <a href={configuring.officialConfigUrl} target="_blank" rel="noreferrer">{connectorSetup?.officialLinkLabel ?? '打开官方登录页'}<Icon name="external" size={14} /></a>}</>}</div></li>
            <li><span>2</span><div><strong>{configuring.credentialConfigured ? '验证现有凭据或替换' : configuring.id === 'gongchuang-knowledge' ? props.t('knowledge.credential') : '粘贴官方访问密钥'}</strong><p>密钥由 Windows 凭据管理器或 macOS 钥匙串保护，不进入页面存储、普通配置文件或对话。</p><label className={css.credentialField}><span>{configuring.id === 'gongchuang-knowledge' ? props.t('knowledge.credential') : connectorSetup?.credentialLabel ?? '官方访问密钥'}</span><input type="password" autoComplete="off" value={credential} onChange={(event) => { setCredential(event.target.value) }} placeholder={configuring.credentialConfigured ? '留空则验证系统安全存储中的现有凭据' : configuring.id === 'gongchuang-knowledge' ? props.t('knowledge.credentialPlaceholder') : connectorSetup?.credentialPlaceholder ?? '粘贴官方平台提供的密钥'} /></label></div></li>
            <li><span>3</span><div><strong>自动连接并发现工具</strong><p>{connectorSetup?.verification ?? '只有官方凭据校验成功且发现至少一个可用工具，状态才会变成“已就绪”。'}</p></div></li>
          </ol>
          {connectorSetup?.remoteDataConsent !== undefined && <label className={css.consentField}><input type="checkbox" checked={remoteDataConsent} onChange={(event) => { setRemoteDataConsent(event.currentTarget.checked) }} /><span>{connectorSetup.remoteDataConsent}</span></label>}
          {error !== '' && <div className={`${css.modalError} ${css.copyableModalError}`} role="alert"><span>{error}</span><button type="button" aria-label="复制连接错误代码和详情" onClick={() => { void copyConnectionError() }}>{errorCopied ? '已复制' : '复制错误'}</button></div>}
          <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={busy !== null} onClick={closeConfiguration}>取消</button><button type="button" className={css.solidButton} disabled={busy !== null || authorizing.includes(configuring.id) || (!configuring.credentialConfigured && credential.trim() === '') || (consentRequired && !remoteDataConsent)} onClick={() => { void verifyConfiguration() }}>{busy === configuring.id ? '正在连接并验证…' : connectorSetup?.submitLabel ?? '连接并验证'}</button></div>
        </section>
      </div>}
      {detailId !== null && (() => {
        const connector = byId.get(detailId)
        const card = cards.find(item => item.id === detailId)
        if (card === undefined) return null
        return <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setDetailId(null) }}>
          <section ref={connectorDialogRef} className={`${css.connectionModal} ${css.connectorDetailModal}`} role="dialog" aria-modal="true" aria-labelledby="connector-detail-title">
            <div className={css.modalHead}><div><span>连接器能力详情</span><h2 id="connector-detail-title">{card.name}</h2></div><button type="button" aria-label="关闭" onClick={() => { setDetailId(null) }}>×</button></div>
            <div className={css.connectorDetailBody}>
              <p>{card.description}</p>
              {card.dataBoundary !== undefined && <div className={css.dataBoundaryNotice}><Icon name="shield" size={19} /><div><strong>数据边界</strong><p>{card.dataBoundary}</p></div></div>}
              <dl>
                <div><dt>当前状态</dt><dd>{connector?.phase === 'ready' ? connector.partial ? '部分能力可用' : '已验证可用' : connector?.message ?? '尚未装载'}</dd></div>
                <div><dt>验证方式</dt><dd>{connector?.verificationMethod ?? '等待宿主返回验证方式'}</dd></div>
                <div><dt>最近验证</dt><dd>{connector?.lastVerifiedAt === null || connector?.lastVerifiedAt === undefined ? '尚无真实验证回执' : verifiedTime(connector.lastVerifiedAt)}</dd></div>
                <div><dt>可用工具</dt><dd>{connector?.toolCount ?? 0} 个</dd></div>
              </dl>
              <div className={css.connectorToolList}>
                <h3>客户端实际发现的工具</h3>
                {connector === undefined || connector.tools.length === 0
                  ? <p>尚未发现工具。完成登录或密钥验证后，这里会显示真实 tools/list 结果。</p>
                  : connector.tools.map(tool => <article key={tool.name}><code>{tool.name}</code><span>{tool.description}</span></article>)}
              </div>
              {connector !== undefined && <div className={css.copyableConnectorStatus}>
                <p className={connector.partial || connector.phase === 'error' || connector.phase === 'unavailable' ? css.warningText : css.connectorReceipt}>{connector.message}</p>
                {(connector.phase === 'error' || connector.phase === 'unavailable') && <button type="button" aria-label={`复制${card.name}连接错误代码和详情`} onClick={() => { void copyConnectorStatus(connector) }}>{statusCopiedId === connector.id ? '已复制' : '复制错误'}</button>}
              </div>}
            </div>
            <div className={css.modalActions}>
              {(connector?.officialConfigUrl ?? card.url) !== '' && <a className={css.outlineButton} href={connector?.officialConfigUrl ?? card.url} target="_blank" rel="noreferrer">打开官方配置</a>}
              <button type="button" className={css.solidButton} onClick={() => { setDetailId(null) }}>完成</button>
            </div>
          </section>
        </div>
      })()}
    </>
  )
}

const AUTOMATION_CADENCES = [
  { seconds: 43_200, label: '每 12 小时' },
  { seconds: 86_400, label: '每 24 小时' },
  { seconds: 604_800, label: '每 7 天' },
  { seconds: 2_592_000, label: '每 30 天' },
] as const

function AutomationPage({ props }: { props: ProductOverlayProps }) {
  const automation = props.useAutomations(state => state)
  const workspaces = props.useWorkspaces(state => state)
  const sessionsById = props.useSessions(state => state.byId)
  const recentWorkspaceId = recentWorkspace(workspaces.items, sessionsById)
  const eligibleWorkspaces = workspaces.items.filter(item => isConcreteEnterpriseWorkspacePath(item.path))
  const [editor, setEditor] = useState<'new' | AutomationTaskView | null>(null)
  const [detail, setDetail] = useState<AutomationTaskView | null>(null)
  const [deleteAutomationTarget, setDeleteAutomationTarget] = useState<AutomationTaskView | null>(null)
  const [templateId, setTemplateId] = useState<string | undefined>()
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [everySeconds, setEverySeconds] = useState(86_400)
  const [cadenceChoice, setCadenceChoice] = useState('86400')
  const [customAmount, setCustomAmount] = useState(90)
  const [customUnit, setCustomUnit] = useState<CustomCadenceUnit>('minutes')
  const [firstRunAt, setFirstRunAt] = useState(nextLocalHour)
  const [scheduleMode, setScheduleMode] = useState<'natural' | 'manual'>('natural')
  const [naturalSchedule, setNaturalSchedule] = useState('')
  const [scheduleNotice, setScheduleNotice] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const automationDialogKey = deleteAutomationTarget !== null
    ? `automation-delete-${deleteAutomationTarget.id}`
    : detail !== null ? `automation-detail-${detail.id}` : editor === null ? null : editor === 'new' ? 'automation-new' : `automation-edit-${editor.id}`
  const automationDialogRef = useDialogFocusTrap(automationDialogKey !== null, automationDialogKey)
  useEffect(() => {
    const closeOverlay = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (deleteAutomationTarget !== null && busy === '') setDeleteAutomationTarget(null)
      else if (detail !== null) setDetail(null)
      else if (editor !== null && busy === '') setEditor(null)
      else return
      event.preventDefault()
    }
    document.addEventListener('keydown', closeOverlay)
    return () => { document.removeEventListener('keydown', closeOverlay) }
  }, [busy, deleteAutomationTarget, detail, editor])
  const cadenceLabel = cadenceChoice === 'custom'
    ? customCadenceLabel(customAmount, customUnit)
    : AUTOMATION_CADENCES.find(item => item.seconds === everySeconds)?.label ?? `每 ${String(everySeconds)} 秒`
  const workspaceTarget = () => eligibleWorkspaces.find(item => item.workspaceId === workspaceId)
    ?? eligibleWorkspaces.find(item => item.workspaceId === recentWorkspaceId)
    ?? eligibleWorkspaces[0]
  const setCadenceFromSeconds = (seconds: number) => {
    const preset = AUTOMATION_CADENCES.find(item => item.seconds === seconds)
    setEverySeconds(seconds)
    if (preset !== undefined) {
      setCadenceChoice(String(preset.seconds))
      return
    }
    const editable = editableCustomCadence(seconds)
    setCadenceChoice('custom')
    setCustomAmount(editable.amount)
    setCustomUnit(editable.unit)
  }
  const openNew = (template?: typeof AUTOMATION_TEMPLATES[number]) => {
    const workspace = workspaceTarget()
    setTemplateId(template?.id)
    setName(template?.name ?? '')
    setPrompt(template?.prompt ?? '')
    setWorkspaceId(workspace?.workspaceId ?? '')
    setCadenceFromSeconds(template?.everySeconds ?? 86_400)
    setFirstRunAt(nextLocalHour())
    setScheduleMode('natural')
    setNaturalSchedule('')
    setScheduleNotice('')
    setEnabled(true)
    setError('')
    setEditor('new')
  }
  const openEdit = (task: AutomationTaskView) => {
    setTemplateId(task.templateId ?? undefined)
    setName(task.name)
    setPrompt(task.prompt)
    setWorkspaceId(task.workspaceId)
    setCadenceFromSeconds(task.everySeconds)
    setFirstRunAt(localInputTime(task.scheduleAnchorAt))
    setScheduleMode('manual')
    setNaturalSchedule('')
    setScheduleNotice('')
    setEnabled(task.enabled)
    setError('')
    setEditor(task)
  }
  const submitEditor = async () => {
    const workspace = workspaceTarget()
    if (workspace === undefined) { setError('请先选择具体企业或项目资料目录，再保存自动化任务。'); return }
    if (!validAutomationInterval(everySeconds)) { setError('执行间隔需在 5 分钟至 365 天之间。'); return }
    const first = new Date(firstRunAt)
    if (enabled && Number.isNaN(first.getTime())) { setError('请选择有效的首次执行时间。'); return }
    setBusy('save')
    setError('')
    const common = {
      ...(templateId === undefined ? {} : { templateId }),
      name, prompt, workspaceId: workspace.workspaceId, everySeconds, cadenceLabel, enabled,
      ...(!Number.isNaN(first.getTime()) ? { firstRunAt: first.toISOString() } : {}),
    }
    try {
      if (editor === 'new') await props.createAutomation(common)
      else if (editor !== null) await props.updateAutomation({ id: editor.id, ...common })
      setEditor(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }
  const applyNaturalSchedule = () => {
    setError('')
    try {
      const parsed = parseNaturalSchedule(naturalSchedule)
      setCadenceFromSeconds(parsed.everySeconds)
      setFirstRunAt(parsed.firstRunAt)
      setScheduleNotice(parsed.summary)
    } catch (reason) {
      setScheduleNotice('')
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const toggleTask = async (task: AutomationTaskView) => {
    setBusy(`toggle:${task.id}`); setError('')
    try { await props.setAutomationEnabled(task.id, !task.enabled) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy('') }
  }
  const runNow = async (id: AutomationTaskId) => {
    setError('')
    // The controller tracks each running task; a model turn must not lock the page.
    try { await props.runAutomationNow(id) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const deleteTask = async () => {
    if (deleteAutomationTarget === null) return
    setBusy(`delete:${deleteAutomationTarget.id}`); setError('')
    try {
      await props.removeAutomation(deleteAutomationTarget.id)
      if (detail?.id === deleteAutomationTarget.id) setDetail(null)
      setDeleteAutomationTarget(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }
  const openRunResult = async (sessionId: string) => {
    setBusy(`open:${sessionId}`); setError('')
    try {
      await props.openAutomationResult(sessionId)
      setDetail(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }
  return (
    <>
      <Header eyebrow="本机执行，不发送云端任务" title="自动化任务">
        <button className={css.solidButton} type="button" onClick={() => { openNew() }}><Icon name="plus" size={17} />新建任务</button>
      </Header>
      <section className={css.automationSummary}>
        <div><span>运行环境</span><strong>本机</strong></div>
        <div><span>已启用</span><strong>{automation.snapshot.tasks.filter(task => task.enabled).length}</strong></div>
        <div><span>执行中</span><strong>{Math.max(automation.snapshot.running, automation.executing.length)}</strong></div>
      </section>
      {automation.error !== null && <p className={css.errorText}>{automation.error}</p>}
      {automation.notice !== null && <p className={css.successText}>{automation.notice}</p>}
      {error !== '' && <p className={css.errorText}>{error}</p>}
      <section className={css.sectionBlock}>
        <div className={css.sectionTitle}><div><h2>推荐模板</h2></div></div>
        <div className={css.automationList}>{AUTOMATION_TEMPLATES.map((item) => {
          const task = automation.snapshot.tasks.find(candidate => candidate.templateId === item.id)
          return <article key={item.id} className={css.automationRow}>
            <span className={css.automationIcon}><Icon name="clock" size={21} /></span>
            <span className={css.automationCopy}><strong>{item.name}</strong><small>{item.description}</small></span>
            <span className={css.cadence}>
              {task?.enabled === true && task.nextRunAt !== null
                ? `下次 ${new Date(task.nextRunAt).toLocaleString('zh-CN')}`
                : item.cadence}
            </span>
            <button type="button" data-active={task?.enabled || undefined} onClick={() => {
              if (task === undefined) openNew(item)
              else openEdit(task)
            }}>
              {task === undefined ? '设置' : '编辑'}
            </button>
          </article>
        })}</div>
      </section>
      <section className={css.sectionBlock}>
        <div className={css.sectionTitle}>
          <div><h2>我的任务</h2><p>点击查看完整指令、定时设置与最近 20 次运行回执。</p></div>
          <span>{automation.snapshot.tasks.length} 项</span>
        </div>
        {automation.snapshot.tasks.length === 0 ? <EmptyState title="尚未创建自动化任务" text="选择推荐模板进行设置，或点击“新建任务”绑定一个企业空间。" />
          : <div className={css.automationList}>{automation.snapshot.tasks.map((task) => {
            const executing = automation.executing.includes(task.id) || task.lastRun?.status === 'running'
            const taskWorkspace = workspaces.items.find(item => item.workspaceId === task.workspaceId)
            const taskWorkspaceReady = taskWorkspace !== undefined && isConcreteEnterpriseWorkspacePath(taskWorkspace.path)
            return <article key={task.id} className={css.automationRow}>
              <span className={css.automationIcon}><Icon name="clock" size={21} /></span>
              <button type="button" className={css.automationCopyButton} onClick={() => { setDetail(task) }}><span className={css.automationCopy}><strong>{task.name}</strong><small>{taskWorkspaceReady ? task.lastRun === null ? '尚未运行' : `${automationRunLabel(task.lastRun)} · ${task.lastRun.message || new Date(task.lastRun.startedAt).toLocaleString('zh-CN')}` : '需重配：请选择具体企业或项目目录'}</small></span></button>
              <span className={css.cadence}>{task.enabled && task.nextRunAt !== null ? `下次 ${new Date(task.nextRunAt).toLocaleString('zh-CN')}` : '已停用'}</span>
              <span className={css.automationRowActions}>
                <button type="button" onClick={() => { setDetail(task) }}>查看</button>
                <button type="button" onClick={() => { openEdit(task) }}>编辑</button>
                <button type="button" disabled={busy !== ''} data-active={task.enabled || undefined} onClick={() => { void toggleTask(task) }}>{task.enabled ? '停用' : '启用'}</button>
                <button type="button" disabled={!taskWorkspaceReady || executing || busy !== ''} onClick={() => { void runNow(task.id) }}>{taskWorkspaceReady ? executing ? '执行中…' : '立即运行' : '需重配'}</button>
                <button type="button" className={css.automationDelete} disabled={busy !== ''} onClick={() => { setDeleteAutomationTarget(task) }}>删除</button>
              </span>
            </article>
          })}</div>}
      </section>
      {editor !== null && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && busy === '') setEditor(null) }}>
        <section ref={automationDialogRef} className={`${css.connectionModal} ${css.automationEditorModal}`} role="dialog" aria-modal="true" aria-labelledby="automation-dialog-title">
          <div className={css.modalHead}><div><span>本机自动化</span><h2 id="automation-dialog-title">{editor === 'new' ? '新建自动化任务' : '编辑自动化任务'}</h2></div><button type="button" disabled={busy !== ''} aria-label="关闭" onClick={() => { setEditor(null) }}>×</button></div>
          <div className={css.automationForm}>
            <label><span>任务名称</span><input value={name} maxLength={128} onChange={(event) => { setName(event.target.value) }} placeholder="例如：重点项目通知监测" /></label>
            <label><span>企业空间</span><select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value) }}><option value="">使用最近的具体企业空间</option>{eligibleWorkspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>)}</select></label>
            {eligibleWorkspaces.length === 0 && <p className={css.errorText}>当前没有可用于自动化的具体企业目录，请先在“企业空间”中新建。</p>}
            <section className={css.scheduleEditor} aria-label="执行时间设置">
              <div className={css.scheduleModeTabs} aria-label="时间设置方式">
                <button type="button" aria-pressed={scheduleMode === 'natural'} data-active={scheduleMode === 'natural' || undefined} onClick={() => { setScheduleMode('natural') }}>一句话设置</button>
                <button type="button" aria-pressed={scheduleMode === 'manual'} data-active={scheduleMode === 'manual' || undefined} onClick={() => { setScheduleMode('manual') }}>手动选择</button>
              </div>
              {scheduleMode === 'natural'
                ? <div className={css.naturalSchedule}>
                  <label><span>用一句话描述执行时间</span><input value={naturalSchedule} onChange={(event) => { setNaturalSchedule(event.target.value); setScheduleNotice('') }} placeholder="例如：每周一上午 9 点，或每隔 90 分钟" /></label>
                  <button type="button" className={css.outlineButton} onClick={applyNaturalSchedule}>识别并填入</button>
                  {scheduleNotice !== '' && <p className={css.successText}>{scheduleNotice}</p>}
                  <small>识别结果只会填入下方任务设置，仍需点击保存，不会直接创建或执行。</small>
                </div>
                : <div className={css.manualSchedule}>
                  <label><span>执行周期</span><select value={cadenceChoice} onChange={(event) => {
                    const value = event.target.value
                    setCadenceChoice(value)
                    if (value === 'custom') {
                      setEverySeconds(customCadenceSeconds(customAmount, customUnit))
                    } else {
                      setEverySeconds(Number(value))
                    }
                  }}>{AUTOMATION_CADENCES.map(item => (
                      <option key={item.seconds} value={item.seconds}>{item.label}</option>
                    ))}<option value="custom">自定义间隔</option></select></label>
                  <label><span>首次执行时间</span><input type="datetime-local" value={firstRunAt} disabled={!enabled} min={minimumLocalMinute()} onChange={(event) => { setFirstRunAt(event.target.value) }} /></label>
                  {cadenceChoice === 'custom' && <div className={css.customCadence}>
                    <label><span>间隔数值</span><input type="number" min="1" step="1" value={customAmount} onChange={(event) => {
                      const amount = Number(event.target.value)
                      setCustomAmount(amount)
                      setEverySeconds(customCadenceSeconds(amount, customUnit))
                    }} /></label>
                    <label><span>间隔单位</span><select value={customUnit} onChange={(event) => {
                      const unit = event.target.value as CustomCadenceUnit
                      setCustomUnit(unit)
                      setEverySeconds(customCadenceSeconds(customAmount, unit))
                    }}><option value="minutes">分钟</option><option value="hours">小时</option><option value="days">天</option><option value="weeks">周</option></select></label>
                    <small>{validAutomationInterval(everySeconds) ? `当前设置：${cadenceLabel}` : '执行间隔需在 5 分钟至 365 天之间'}</small>
                  </div>}
                </div>}
            </section>
            <label className={css.automationEnabled}><input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.currentTarget.checked) }} /><span>保存并启用</span></label>
            <label className={css.automationPrompt}><span>执行指令</span><textarea value={prompt} maxLength={8_000} onChange={(event) => { setPrompt(event.target.value) }} placeholder="说明要检查的对象、来源要求和交付结果" /></label>
            <small className={css.automationFootnote}>显示时间采用本机时区。客户端关闭或电脑休眠时不会在云端代跑；下次客户端运行后会处理已到期任务。外部写入和高风险操作仍会等待确认。</small>
            {error !== '' && <p className={css.errorText}>{error}</p>}
          </div>
          <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={busy !== ''} onClick={() => { setEditor(null) }}>取消</button><button type="button" className={css.solidButton} disabled={busy !== '' || name.trim() === '' || prompt.trim() === '' || eligibleWorkspaces.length === 0 || !validAutomationInterval(everySeconds) || (enabled && firstRunAt === '')} onClick={() => { void submitEditor() }}>{busy === 'save' ? '正在保存…' : enabled ? editor === 'new' ? '保存并启用' : '保存修改并启用' : '仅保存，暂不启用'}</button></div>
        </section>
      </div>}
      {deleteAutomationTarget !== null && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && busy === '') setDeleteAutomationTarget(null) }}>
        <section ref={automationDialogRef} className={css.confirmDialog} role="dialog" aria-modal="true" aria-label="删除自动化任务">
          <h2>删除自动化任务</h2>
          <p>{automation.executing.includes(deleteAutomationTarget.id) || deleteAutomationTarget.lastRun?.status === 'running'
            ? '停止本次执行并删除任务。对话和文件保留。'
            : '删除任务的定时设置与运行回执。对话和文件保留。'}</p>
          {error !== '' && <p className={css.modalError}>{error}</p>}
          <div className={css.modalActions}>
            <button type="button" className={css.outlineButton} disabled={busy !== ''} onClick={() => { setDeleteAutomationTarget(null) }}>取消</button>
            <button type="button" className={css.dangerButton} disabled={busy !== ''} onClick={() => { void deleteTask() }}>{busy === `delete:${deleteAutomationTarget.id}` ? '正在停止并删除…'
              : automation.executing.includes(deleteAutomationTarget.id) || deleteAutomationTarget.lastRun?.status === 'running' ? '停止并删除' : '确认删除'}</button>
          </div>
        </section>
      </div>}
      {detail !== null && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setDetail(null) }}>
        <section ref={automationDialogRef} className={`${css.connectionModal} ${css.automationDetailModal}`} role="dialog" aria-modal="true" aria-labelledby="automation-detail-title">
          <div className={css.modalHead}><div><span>任务详情与运行历史</span><h2 id="automation-detail-title">{detail.name}</h2></div><button type="button" aria-label="关闭" onClick={() => { setDetail(null) }}>×</button></div>
          <div className={css.automationDetailBody}>
            <dl>
              <div><dt>企业空间</dt><dd>{workspaces.items.find(
                item => item.workspaceId === detail.workspaceId,
              )?.title ?? detail.workspaceId}</dd></div>
              <div><dt>执行周期</dt><dd>{detail.cadenceLabel}</dd></div>
              <div><dt>状态</dt><dd>{detail.enabled ? '已启用' : '已停用'}</dd></div>
              <div><dt>计划锚点</dt><dd>{new Date(detail.scheduleAnchorAt).toLocaleString('zh-CN')}</dd></div>
              <div><dt>下次执行</dt><dd>{detail.nextRunAt === null ? '无' : new Date(detail.nextRunAt).toLocaleString('zh-CN')}</dd></div>
              <div><dt>创建时间</dt><dd>{new Date(detail.createdAt).toLocaleString('zh-CN')}</dd></div>
              <div><dt>最后修改</dt><dd>{new Date(detail.updatedAt).toLocaleString('zh-CN')}</dd></div>
            </dl>
            <section><h3>执行指令</h3><pre>{detail.prompt}</pre></section>
            <section><h3>最近运行</h3>{detail.recentRuns.length === 0
              ? <p>尚无运行记录。</p>
              : <div className={css.automationHistory}>{detail.recentRuns.map((run) => {
                const resultSessionId = run.sessionId
                return <article key={run.runId}>
                  <span data-state={run.status}>
                    {automationRunLabel(run)}
                  </span>
                  <div>
                    <strong>
                      {run.manual ? '手动运行' : '计划运行'} · {new Date(run.scheduledAt).toLocaleString('zh-CN')}
                    </strong>
                    <small>{run.message || '等待执行回执'}</small>
                  </div>
                  {run.status !== 'running' && resultSessionId !== null && <button
                    type="button"
                    disabled={busy !== ''}
                    onClick={() => { void openRunResult(resultSessionId) }}
                  >
                    {busy === `open:${resultSessionId}` ? '正在打开…' : '打开结果会话'}
                  </button>}
                </article>
              })}</div>}</section>
          </div>
          <div className={css.modalActions}><button type="button" className={css.outlineButton} disabled={busy !== ''} onClick={() => { setDetail(null); openEdit(detail) }}>编辑</button><button type="button" className={css.dangerButton} disabled={busy !== ''} onClick={() => { setDetail(null); setDeleteAutomationTarget(detail) }}>删除</button><button type="button" className={css.solidButton} disabled={busy !== ''} onClick={() => { setDetail(null) }}>完成</button></div>
        </section>
      </div>}
    </>
  )
}

export function WindowsClosePromptDialog({
  requestId,
  respond,
}: {
  readonly requestId: string | null
  readonly respond: ProductUiActions['respondWindowsCloseRequest']
}) {
  const [decision, setDecision] = useState<'tray' | 'quit'>('tray')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useDialogFocusTrap(requestId !== null, requestId)
  useEffect(() => {
    setDecision('tray')
    setRemember(false)
    setBusy(false)
    setError(null)
  }, [requestId])
  if (requestId === null) return null
  const finish = (next: 'tray' | 'quit' | null): void => {
    setBusy(true)
    setError(null)
    void respond(requestId, next, next === null ? false : remember)
      .catch((failure: unknown) => {
        setBusy(false)
        setError(failure instanceof Error ? failure.message : '关闭操作未完成')
      })
  }
  return <div className={css.modalBackdrop} role="presentation">
    <section
      ref={dialogRef}
      className={css.windowsCloseDialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby="windows-close-dialog-title"
      onKeyDown={(event) => { if (event.key === 'Escape' && !busy) finish(null) }}
    >
      <h2 id="windows-close-dialog-title">关闭窗口后</h2>
      <div className={css.windowsCloseChoices} role="radiogroup" aria-label="关闭窗口后">
        <label>
          <input
            type="radio"
            name="windows-close-decision"
            value="tray"
            checked={decision === 'tray'}
            disabled={busy}
            onChange={() => { setDecision('tray') }}
          />
          <span>最小化到托盘</span>
        </label>
        <label>
          <input
            type="radio"
            name="windows-close-decision"
            value="quit"
            checked={decision === 'quit'}
            disabled={busy}
            onChange={() => { setDecision('quit') }}
          />
          <span>退出主程序</span>
        </label>
      </div>
      <label className={css.windowsCloseRemember}>
        <input type="checkbox" checked={remember} disabled={busy} onChange={(event) => { setRemember(event.currentTarget.checked) }} />
        <span>记住此选择</span>
      </label>
      {error !== null && <p className={css.dialogError} role="alert">{error}</p>}
      <div className={css.windowsCloseActions}>
        <button type="button" className={css.outlineButton} disabled={busy} onClick={() => { finish(null) }}>取消</button>
        <button type="button" className={css.solidButton} disabled={busy} onClick={() => { finish(decision) }}>{busy ? '正在处理…' : '确定'}</button>
      </div>
    </section>
  </div>
}

export function ProductOverlay(props: ProductOverlayProps) {
  const page = props.useProduct(state => state.page)
  const imageConsent = (props.useImageTransferConsent ?? (selector => selector(EMPTY_IMAGE_TRANSFER_CONSENT)))(state => state)
  const deepseekRetention = props.useConnectivity(state => state.deepseekFiles.retentionSeconds)
  const windowsCloseRequestId = props.useWindowsClosePrompt(state => state.requestId)
  return <>
    <div className={css.windowDragRegion} aria-hidden="true" />
    {page === 'assistant'
      ? <AssistantFloater props={props} />
      : <main className={css.page} data-product-page={page}>
        <div className={css.pageInner}>
          {page === 'enterprise' && <EnterprisePage props={props} />}
          {page === 'skills' && <SkillsPage props={props} />}
          {page === 'mcp' && <McpPage props={props} />}
          {page === 'automation' && <AutomationPage props={props} />}
        </div>
      </main>}
    <RequestedEnterpriseCreation props={props} />
    <ImageTransferConsentDialog
      state={imageConsent}
      retentionSeconds={deepseekRetention}
      approve={props.approveImageTransfer}
      reject={props.rejectImageTransfer}
    />
    <WindowsClosePromptDialog
      requestId={windowsCloseRequestId}
      respond={props.respondWindowsCloseRequest}
    />
  </>
}
