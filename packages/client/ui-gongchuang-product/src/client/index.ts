import type { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  GongchuangDeepSeekFileRetentionSeconds,
  GongchuangModelConfigureRequest, GongchuangModelProvider, SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComposerAttachment, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatUserMessageFiles } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { FileApplication } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
// Alpha exposes the slot registry Context merge from the renderer client entry.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { GONGCHUANG_MODEL_PROVIDERS, isGongchuangModelProvider } from '@gongchuang/model-connections/registry'
import { ConnectorController } from './connectors.ts'
import { ConnectivityController, type ConnectionReadiness } from './connectivity.ts'
import { MarketplaceController } from './marketplace.ts'
import { AutomationController } from './automations.ts'
import { dispatchAutomation } from './automation-dispatch.ts'
import { AccountController } from './account.ts'
import { GraphMemoryController } from './memory.ts'
import {
  CONCRETE_ENTERPRISE_WORKSPACE_REQUIRED, isConcreteEnterpriseWorkspacePath,
} from './enterprise-workspace.ts'
import {
  EnterpriseCreationMenuItem, installProductShellStyleRecovery, ProductOverlay, ProductSidebar, providerHealthLabel,
  ImageTransferProviderNotice,
  type ProductEnterpriseWorkspaceDirectory, type ProductPage,
  type ImageTransferProviderNoticeProps,
  type ProviderConfigurationResult,
  type ProductProvider, type ProductSkillUpdateSnapshot, type ProductUpdateProgress,
  type ProductUiActions, type ProductUiState, type ProductUpdateSnapshot, type ProductWorkspaceRootState,
  type ProfessionalTaskStatusState, type WindowsClosePromptState,
} from './ProductShell.tsx'
import {
  DocumentImportControl, DocumentImportRail,
  type DocumentImportInjected, type DocumentImportRailInjected,
} from './DocumentImportControl.tsx'
import {
  DeepClarificationControl, DeepClarificationMode, type DeepClarificationInjected,
} from './DeepClarificationControl.tsx'
import { ImageTransferConsentController, type ImageTransferProvider } from './image-transfer-consent.ts'
import { installModelCatalogRefresh } from './model-catalog-refresh.ts'
import {
  ConversationDocumentDrafts, ProductPromptPreparation, migrateLegacyDocumentDraft,
  isImportedDocumentNamespace, type ImportedDocument,
} from './document-drafts.ts'
import { ConversationAnnotationDrafts, projectAnnotatedUserMessage, summarizeAnnotatedUserMessage } from './annotation-drafts.ts'
import { AnnotationDraftRail, type AnnotationDraftRailInjected } from './AnnotationDraftRail.tsx'
import { AnnotationMarkers } from './annotation-markers.ts'
import {
  ComposerDraftPersistenceController, type ComposerDraftDesktopBridge,
} from './composer-draft-persistence.ts'
import { ProductHeroHeadline } from './ProductHeroHeadline.tsx'
import { ProductHeroBrandMark, ProductHeroPreview } from './ProductHeroBrand.tsx'
import { en, NS, zh, type ProductKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Gongchuang product-owned public copy. */
    gongchuangProduct: ProductKey
  }
}

const PERSIST_KEY = 'gongchuang.client.ui.v0.1'

export const inject = [
  'slots', 'layout', 'sessions', 'workspaces', 'uiWorkspace', 'theme', 'conversation', 'uiConversation',
  'conversationDraftText', 'conversationDraftImages',
  'connection', 'locale', 'remote',
  // Cordis authorizes nested Remote services separately. Model projection calls
  // through ModelDirectoryResolver also need the caller to authorize Session.
  'remote.llm', 'remote.session',
  'remote.gongchuangConnectors', 'remote.gongchuangSkillMarketplace', 'remote.gongchuangLocalAutomation',
  'remote.gongchuangAccount', 'remote.gongchuangModelConnections', 'modelDirectories',
  'remote.gongchuangGraphMemory',
]

function initialState(): ProductUiState {
  return {
    page: 'assistant',
    provider: 'deepseek',
    accountDialogRevision: 0,
    avatarDataUrl: null,
    enterpriseCreateRequested: false,
  }
}

/** Commit the visible provider only after the Host accepts the matching model route.
 * @param store - The store value.
 * @param provider - The provider value.
 * @param select - The select value.
 */
export async function selectAndRememberProvider(
  store: SnapshotStore<ProductUiState>,
  provider: ProductProvider,
  select: () => Promise<void>,
): Promise<void> {
  await select()
  store.update((draft) => { draft.provider = provider })
}

/** Save one connection first, then report automatic selection as a separate outcome.
 * @param store - Device-local visible provider state.
 * @param provider - Product provider whose connection was saved.
 * @param configure - Trusted Host connection commit.
 * @param select - Host model selection attempted after the commit.
 * @param partial - Publisher for the partial-success message.
 * @returns Whether the saved connection was also selected automatically.
 */
export async function configureAndRememberProvider(
  store: SnapshotStore<ProductUiState>,
  provider: ProductProvider,
  configure: () => Promise<void>,
  select: () => Promise<void>,
  partial: (error: unknown) => string,
): Promise<ProviderConfigurationResult> {
  await configure()
  try {
    await selectAndRememberProvider(store, provider, select)
    return { connectionSaved: true, autoSelected: true }
  } catch (error) {
    return {
      connectionSaved: true,
      autoSelected: false,
      message: partial(error),
    }
  }
}

interface GongchuangDesktopBridge {
  readonly platform: 'darwin' | 'win32'
  checkForUpdates: () => Promise<ProductUpdateSnapshot>
  downloadUpdate: () => Promise<ProductUpdateSnapshot>
  installUpdate: () => Promise<ProductUpdateSnapshot>
  onUpdateProgress: (listener: (progress: ProductUpdateProgress) => void) => () => void
  readSkillUpdateState: () => Promise<ProductSkillUpdateSnapshot>
  checkSkillUpdates: () => Promise<ProductSkillUpdateSnapshot>
  downloadSkillUpdate: () => Promise<ProductSkillUpdateSnapshot>
  installSkillUpdate: () => Promise<ProductSkillUpdateSnapshot>
  readAvatar: () => Promise<string | null>
  writeAvatar: (value: string | null) => Promise<string | null>
  importDocuments: (workspacePath: string) => Promise<readonly ImportedDocument[]>
  importDroppedDocuments: (workspacePath: string, files: readonly File[]) => Promise<readonly ImportedDocument[]>
  openImportedDocument: (workspacePath: string, relativePath: string) => Promise<void>
  openSessionAttachment: (
    sessionId: string,
    attachment: { readonly attachmentId: string; readonly name: string; readonly bytes: number },
  ) => Promise<void>
  fileApplications: (workspacePath: string, path: string) => Promise<readonly FileApplication[]>
  fileAction: (workspacePath: string, path: string, action: 'open-with' | 'reveal' | 'save-copy', applicationId?: string | null) => Promise<void>
  trashEnterpriseWorkspace: (workspaceId: string) => Promise<void>
  trashEnterpriseConversation: (sessionId: string) => Promise<void>
  readWindowsCloseBehavior: () => Promise<WindowsCloseBehavior>
  writeWindowsCloseBehavior: (value: WindowsCloseBehavior) => Promise<WindowsCloseBehavior>
  onWindowsCloseRequested: (listener: (requestId: string) => void) => () => void
  respondWindowsCloseRequest: (
    requestId: string,
    decision: Exclude<WindowsCloseBehavior, 'ask'> | null,
    remember: boolean,
  ) => Promise<void>
  onOpenSessionDeepLink: (listener: (sessionId: string) => void) => () => void
  readProfessionalTaskStatus?: (sessionId: string) => Promise<{
    readonly phase: ProfessionalTaskStatusState['phase']
    readonly contractVersion: string | null
    readonly updatedAt: string | null
  }>
  readComposerDraft?: (sessionId: string) => Promise<unknown>
  writeComposerDraft?: ComposerDraftDesktopBridge['writeComposerDraft']
  clearComposerDraft?: (sessionId: string) => Promise<void>
  readImageTransferConsents?: () => Promise<readonly ImageTransferProvider[]>
  rememberImageTransferConsent?: (provider: ImageTransferProvider) => Promise<void>
  workspaceRootState: () => Promise<ProductWorkspaceRootState>
  chooseWorkspaceRoot: () => Promise<ProductWorkspaceRootState | null>
  useDefaultWorkspaceRoot: () => Promise<ProductWorkspaceRootState>
  createEnterpriseWorkspace: (name: string) => Promise<ProductEnterpriseWorkspaceDirectory>
  importEnterpriseWorkspace: () => Promise<ProductEnterpriseWorkspaceDirectory | null>
}

/** Persisted action applied when a Windows user closes the main window. */
export type WindowsCloseBehavior = 'ask' | 'tray' | 'quit'

declare global {
  interface Window {
    gongchuangDesktop?: GongchuangDesktopBridge
  }
}

function unavailableUpdateAction(): Promise<ProductUpdateSnapshot> {
  return Promise.resolve({
    status: 'unconfigured', currentVersion: '未知', latestVersion: null,
    message: '浏览器模式不提供客户端更新，请在桌面客户端中使用此功能',
  })
}

function unavailableSkillUpdateAction(): Promise<ProductSkillUpdateSnapshot> {
  return Promise.resolve({
    status: 'error', currentVersion: '未知', latestVersion: null, releaseNotes: null,
    message: '浏览器模式不提供技能包更新，请在桌面客户端中使用此功能',
  })
}

/**
 * Include archived workspaces when retiring conversation-scoped attachment drafts.
 * @param management - active and archived workspace projections.
 * @param workspaceId - workspace whose Session drafts are being retired.
 * @returns the Session identities attached to that workspace.
 */
export function workspaceSessionIdsForDeletion(
  management: {
    readonly items: readonly { readonly workspaceId: string; readonly sessionIds: readonly SessionId[] }[]
    readonly archivedItems: readonly { readonly workspaceId: string; readonly sessionIds: readonly SessionId[] }[]
  },
  workspaceId: string,
): readonly SessionId[] {
  return [...management.items, ...management.archivedItems]
    .find(item => item.workspaceId === workspaceId)?.sessionIds ?? []
}

/**
 * Restore and reveal one retained automation result Session.
 * @param ctx - Product context containing the authoritative management projections.
 * @param sessionId - Persisted result Session selected from an automation run receipt.
 * @param navigate - Product-shell navigation used after the Session is opened.
 */
export async function openAutomationResultConversation(
  ctx: Context,
  sessionId: string,
  navigate: (page: ProductPage) => void,
): Promise<void> {
  const id = sessionId as SessionId
  const management = ctx.workspaces.list.getSnapshot()
  if (management.deletedSessionIds.includes(id)) {
    throw new Error('这次运行的结果会话已删除，无法打开。')
  }
  const archivedWorkspace = management.archivedItems.find(item => item.sessionIds.includes(id))
  if (archivedWorkspace !== undefined) await ctx.workspaces.unarchiveWorkspace(archivedWorkspace.workspaceId)
  if (management.archivedSessionIds.includes(id)) await ctx.workspaces.unarchiveSession(id)
  if (ctx.sessions.list.getSnapshot().byId[id] === undefined) {
    throw new Error('这次运行的结果会话已不在本机会话列表中，无法打开。')
  }
  ctx.sessions.open(id)
  navigate('assistant')
}

/** Restore and open one exact local Session requested by the desktop protocol.
 * @param ctx - Local Session and workspace controllers.
 * @param sessionId - Exact local Session identifier from the desktop protocol.
 * @param navigate - Product-shell navigation used after the Session is opened.
 */
export async function openDeepLinkedConversation(
  ctx: Pick<Context, 'sessions' | 'workspaces'>,
  sessionId: string,
  navigate: (page: ProductPage) => void,
): Promise<void> {
  const id = sessionId as SessionId
  const management = ctx.workspaces.list.getSnapshot()
  if (management.deletedSessionIds.includes(id)) throw new Error('该对话已删除，无法通过链接打开。')
  const archivedWorkspace = management.archivedItems.find(item => item.sessionIds.includes(id))
  if (archivedWorkspace !== undefined) await ctx.workspaces.unarchiveWorkspace(archivedWorkspace.workspaceId)
  if (management.archivedSessionIds.includes(id)) await ctx.workspaces.unarchiveSession(id)
  if (ctx.sessions.list.getSnapshot().byId[id] === undefined) {
    throw new Error('链接指向的对话不在本机，无法打开。')
  }
  ctx.sessions.open(id)
  navigate('assistant')
}

async function importDocumentsForSession(
  ctx: Context,
  documentDrafts: ConversationDocumentDrafts,
  sessionId: SessionId,
  files?: readonly File[],
): Promise<number> {
  const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId))
  if (workspace === undefined) throw new Error('请先进入具体企业空间')
  const bridge = window.gongchuangDesktop
  if (bridge === undefined) throw new Error('添加文件仅在 Windows 和 macOS 客户端可用')
  const documents = files === undefined
    ? await bridge.importDocuments(workspace.path)
    : await bridge.importDroppedDocuments(workspace.path, files)
  if (documents.length === 0) return 0
  documentDrafts.add(sessionId, documents)
  return documents.length
}

async function openImportedDocumentForSession(
  ctx: Context,
  sessionId: SessionId,
  relativePath: string,
): Promise<void> {
  const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId))
  if (workspace === undefined) throw new Error('当前企业空间已不可用')
  const desktop = window.gongchuangDesktop
  if (desktop === undefined) throw new Error('打开文件仅在桌面客户端可用')
  await desktop.openImportedDocument(workspace.path, relativePath)
}

/**
 * Create the product-owned projection and secure opener for sent document references.
 * @param ctx - Product Context providing workspace identity and desktop access.
 * @returns Chat's optional file projection and opening provider.
 */
export function createChatUserMessageFiles(ctx: Context): ChatUserMessageFiles {
  return Object.freeze({
    project: projectAnnotatedUserMessage,
    actions: (sessionId: string, path: string) => {
      const desktop = window.gongchuangDesktop
      const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId as SessionId))
      if (desktop === undefined || workspace === undefined) return undefined
      return {
        listApplications: () => desktop.fileApplications(workspace.path, path),
        openWith: (applicationId: string | null) => desktop.fileAction(workspace.path, path, 'open-with', applicationId),
        reveal: () => desktop.fileAction(workspace.path, path, 'reveal'),
        saveCopy: () => desktop.fileAction(workspace.path, path, 'save-copy'),
      }
    },
    open: async (sessionId: string, path: string) => {
      // The controlled import namespace must never fall back to Chat's generic
      // workspace opener. The desktop Host is the final authority and rejects
      // malformed paths, traversal, directories, and symbolic links.
      if (!isImportedDocumentNamespace(path)) return false
      await openImportedDocumentForSession(ctx, sessionId as SessionId, path)
      return true
    },
    openAttachment: async (sessionId: string, attachment: FileAttachmentRef) => {
      const desktop = window.gongchuangDesktop
      if (desktop === undefined) throw new Error('打开附件仅在桌面客户端可用')
      await desktop.openSessionAttachment(sessionId, {
        attachmentId: String(attachment.attachmentId),
        name: attachment.name,
        bytes: attachment.bytes,
      })
    },
  })
}

/**
 * Perform the load desktop avatar operation.
 * @param store - The store value.
 * @param bridge - The bridge value.
 */
export async function loadDesktopAvatar(
  store: SnapshotStore<ProductUiState>,
  bridge: Pick<GongchuangDesktopBridge, 'readAvatar'> | undefined,
): Promise<void> {
  if (bridge === undefined) return
  const avatarDataUrl = await bridge.readAvatar()
  store.update((draft) => { draft.avatarDataUrl = avatarDataUrl })
}

/**
 * Perform the persist desktop avatar operation.
 * @param store - The store value.
 * @param value - The value value.
 * @param bridge - The bridge value.
 */
export async function persistDesktopAvatar(
  store: SnapshotStore<ProductUiState>,
  value: string | null,
  bridge: Pick<GongchuangDesktopBridge, 'writeAvatar'> | undefined,
): Promise<void> {
  const avatarDataUrl = bridge === undefined ? value : await bridge.writeAvatar(value)
  store.update((draft) => { draft.avatarDataUrl = avatarDataUrl })
}

/**
 * Perform the preferred model operation.
 * @param provider - The provider value.
 * @param ids - The ids value.
 * @returns The preferred model result.
 */
export function preferredModel(provider: ProductProvider, ids: readonly string[]): string | undefined {
  // The persisted Host default is always consulted before this helper.  This
  // is only the first-use / unavailable-selection fallback for a route the
  // user just chose, so favor the agreed DeepSeek V4 Flash baseline everywhere
  // before falling back to what that endpoint actually advertises.
  void provider
  // Compatible services use both `deepseek-v4-flash` and namespaced IDs such
  // as `deepseek-ai/DeepSeek-V4-Flash`.  Match the model identity rather than
  // assuming a particular catalog spelling or ordering.
  const isV4Flash = (id: string): boolean => /(?:^|[/:_-])deepseek[-_]?v4[-_]?flash$/iu.test(id)
  const isV4FlashFree = (id: string): boolean => /(?:^|[/:_-])deepseek[-_]?v4[-_]?flash[-_]?free$/iu.test(id)
  const isV4Pro = (id: string): boolean => /(?:^|[/:_-])deepseek[-_]?v4[-_]?pro$/iu.test(id)
  return ids.find(isV4Flash)
    ?? ids.find(isV4FlashFree)
    ?? ids.find(isV4Pro)
    ?? ids[0]
}

/** Keep the product's OpenCode Go Flash route at the user-approved Max baseline after provider switches.
 * @param provider - The provider value.
 * @param model - The model value.
 * @returns The preferred reasoning effort result.
 */
export function preferredReasoningEffort(
  provider: ProductProvider,
  model: string,
): string | undefined {
  if (provider !== 'opencode-go') return undefined
  return /(?:^|[/:_-])deepseek[-_]?v4[-_]?flash(?:[-_]?free)?$/iu.test(model) ? 'max' : undefined
}

async function selectCurrentProvider(
  ctx: Context,
  controller: ConnectivityController,
  provider: ProductProvider,
): Promise<void> {
  const sessionId = ctx.sessions.list.getSnapshot().current
  if (sessionId === undefined) return
  const connection = controller.store.getSnapshot().providers[provider]
  if (connection.status !== 'ready' || connection.route === undefined) {
    throw new Error(connection.message)
  }
  controller.beginSelection()
  try {
    const directory = ctx.modelDirectories.directoryFor(sessionId)
    const models = await directory.load()
    // Catalog membership is advisory. A custom/private current model may not
    // be listed, so keep it until the Host says the route is unservable or the
    // user explicitly picks another model.
    if (models.current?.provider === connection.route && models.routable) {
      controller.selectionSucceeded()
      return
    }
    const group = models.groups.find(candidate => candidate.id === connection.route)
    if (group === undefined) throw new Error(`模型路由 ${connection.route} 当前没有可选模型`)
    const model = preferredModel(provider, group.models.map(candidate => candidate.id))
    if (model === undefined) throw new Error(`模型路由 ${connection.route} 当前没有可用模型`)
    const reasoningEffort = preferredReasoningEffort(provider, model)
    await directory.select({
      provider: group.id,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
    controller.selectionSucceeded()
  } catch (error) {
    controller.selectionFailed(error)
    throw error
  }
}

/** Pick a usable product route when a saved default belongs to a removed connection. */
function fallbackReadyProvider(connectivity: ConnectivityController): ProductProvider | null {
  const providers = connectivity.store.getSnapshot().providers
  const ordered: readonly ProductProvider[] = GONGCHUANG_MODEL_PROVIDERS.map(provider => provider.id)
  return ordered.find(provider => providers[provider].status === 'ready') ?? null
}

/** Migrate the V0.3 OpenCode label and discard removed UI choices without touching stored credentials.
 * @param value - Provider identifier persisted by an earlier client version.
 * @returns A provider identifier supported by the current product surface.
 */
export function migratePersistedProvider(value: unknown): ProductProvider {
  if (value === 'opencode') return 'opencode-go'
  return isGongchuangModelProvider(value) ? value : 'deepseek'
}

/** Project connection refreshes into the visible provider without writing a model selection.
 * @param activeProvider - Product provider projected from the durable Session route.
 * @param readyFallback - First verified route used only when no durable product route exists.
 * @param rememberedProvider - Device-local UI choice used only when Host state has none.
 * @param rememberedStatus - Latest verified state for the device-local choice.
 * @returns Provider to show. Background refreshes deliberately have no write decision.
 */
export function providerConnectivityRefreshDecision(
  activeProvider: ProductProvider | null,
  readyFallback: ProductProvider | null,
  rememberedProvider: ProductProvider,
  rememberedStatus: ConnectionReadiness,
): { readonly provider: ProductProvider } {
  if (activeProvider !== null) return { provider: activeProvider }
  // Startup connectivity can settle after an explicit selection. When no
  // Session route exists, a ready remembered provider remains the visible choice.
  if (rememberedStatus === 'ready') return { provider: rememberedProvider }
  return { provider: readyFallback ?? rememberedProvider }
}

/** Fork a task inside its current enterprise workspace and open the copy.
 * @param ctx - The ctx value.
 * @param workspaceId - The workspace id value.
 * @param sessionId - The session id value.
 * @param navigate - The navigate value.
 */
export async function copyWorkspaceSession(
  ctx: Pick<Context, 'sessions' | 'workspaces'>,
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  navigate: (page: ProductPage) => void,
): Promise<void> {
  const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
  if (workspace === undefined || !workspace.sessionIds.includes(sessionId)) {
    throw new Error('该任务已不属于当前企业空间，请刷新后重试。')
  }
  if (ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) {
    throw new Error('该任务会话已不在本机会话列表中。')
  }
  const childId = await ctx.sessions.fork({ sessionId, increaseTitle: true })
  ctx.sessions.open(childId)
  navigate('assistant')
}

function actions(
  ctx: Context,
  store: SnapshotStore<ProductUiState>,
  connectivity: ConnectivityController,
  connectors: ConnectorController,
  marketplace: MarketplaceController,
  automations: AutomationController,
  account: AccountController,
  memory: GraphMemoryController,
  imageTransferConsent: ImageTransferConsentController,
  documentDrafts: ConversationDocumentDrafts,
  annotationDrafts: ConversationAnnotationDrafts,
  composerDraftPersistence: ComposerDraftPersistenceController | undefined,
  windowsClosePrompt: SnapshotStore<WindowsClosePromptState>,
  professionalTaskStatus: SnapshotStore<ProfessionalTaskStatusState>,
): ProductUiActions {
  const navigate = (page: ProductPage): void => {
    store.update((draft) => { draft.page = page })
    // A task may have been created from a conversation through the Host tool,
    // outside this controller's form mutation path. Refresh on entry so the
    // Automation page projects the just-committed registry revision instead
    // of retaining its startup snapshot.
    if (page === 'automation') void automations.load()
  }
  const desktop = window.gongchuangDesktop
  const productActions: ProductUiActions = {
    navigate,
    startSession: () => { ctx.uiWorkspace.startSession() },
    requestEnterpriseCreation: () => { store.update((draft) => { draft.enterpriseCreateRequested = true }) },
    consumeEnterpriseCreationRequest: () => { store.update((draft) => { draft.enterpriseCreateRequested = false }) },
    selectProvider: async (provider: ProductProvider) => {
      try {
        await selectAndRememberProvider(
          store,
          provider,
          () => selectCurrentProvider(ctx, connectivity, provider),
        )
      } catch { /* status carries the actionable failure; keep the last usable provider selected */ }
    },
    configureProvider: async (request: GongchuangModelConfigureRequest) => {
      return configureAndRememberProvider(
        store,
        request.provider,
        () => connectivity.configure(request),
        () => selectCurrentProvider(ctx, connectivity, request.provider),
        error => connectivity.selectionPartiallySucceeded(error),
      )
    },
    refreshProviderConnection: async (provider: GongchuangModelProvider) => {
      await connectivity.refreshProvider(provider)
      if (store.getSnapshot().provider === provider) {
        await selectCurrentProvider(ctx, connectivity, provider)
      }
    },
    setDeepSeekFileRetention: async (retentionSeconds: GongchuangDeepSeekFileRetentionSeconds) => {
      await connectivity.setDeepSeekFileRetention(retentionSeconds)
    },
    clearDeepSeekFiles: () => connectivity.clearDeepSeekFiles(),
    approveImageTransfer: () => { imageTransferConsent.approve() },
    rejectImageTransfer: () => { imageTransferConsent.reject() },
    listWorkspaceDirectory: (path, signal) => ctx.uiWorkspace.listDirectory(path, signal),
    createWorkspaceDirectory: (path, name) => ctx.uiWorkspace.createDirectory(path, name),
    pickAndCreateWorkspace: async (path) => {
      if (!isConcreteEnterpriseWorkspacePath(path)) throw new Error(CONCRETE_ENTERPRISE_WORKSPACE_REQUIRED)
      const workspace = await ctx.workspaces.create({ path })
      const sessionId = await ctx.uiWorkspace.connectWorkspace(workspace.workspaceId)
      ctx.sessions.open(sessionId)
      navigate('assistant')
    },
    openWorkspace: async (workspaceId) => {
      const sessionId = await ctx.uiWorkspace.connectWorkspace(workspaceId)
      ctx.sessions.open(sessionId)
      navigate('assistant')
    },
    openWorkspaceSession: (workspaceId, sessionId) => {
      const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
      if (workspace === undefined || !workspace.sessionIds.includes(sessionId)) {
        return Promise.reject(new Error('该任务已不属于当前企业空间，请刷新后重试。'))
      }
      if (ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) {
        return Promise.reject(new Error('该任务会话已不在本机会话列表中。'))
      }
      ctx.sessions.open(sessionId)
      navigate('assistant')
      return Promise.resolve()
    },
    renameWorkspaceSession: async (workspaceId, sessionId, title) => {
      const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
      if (workspace === undefined || !workspace.sessionIds.includes(sessionId)) {
        throw new Error('该任务已不属于当前企业空间，请刷新后重试。')
      }
      const session = ctx.sessions.binding(sessionId)?.session
      if (session === undefined) throw new Error('该任务会话已不在本机会话列表中。')
      const result = await session.rename(title)
      if (!result.ok) throw new Error(result.error.message)
    },
    copyWorkspaceSession: async (workspaceId: WorkspaceId, sessionId: SessionId) => {
      await copyWorkspaceSession(ctx, workspaceId, sessionId, navigate)
    },
    moveWorkspaceSession: async (sessionId: SessionId, workspaceId: WorkspaceId) => {
      const childId = await ctx.uiWorkspace.moveSessionToWorkspace(sessionId, workspaceId)
      ctx.sessions.open(childId)
      navigate('assistant')
    },
    reorderWorkspace: async (workspaceId, beforeWorkspaceId) => {
      await ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId)
    },
    reorderWorkspaceSession: async (workspaceId, sessionId, beforeSessionId) => {
      await ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    },
    setWorkspaceSessionPinned: async (workspaceId, sessionId, pinned) => {
      await ctx.workspaces.setSessionPinned(workspaceId, sessionId, pinned)
    },
    renameWorkspace: async (workspaceId, title) => { await ctx.workspaces.rename(workspaceId, title) },
    archiveWorkspace: async (workspaceId) => { await ctx.workspaces.archiveWorkspace(workspaceId) },
    deleteWorkspace: async (workspaceId) => {
      if (desktop === undefined) throw new Error('删除企业空间仅在桌面客户端可用')
      const management = ctx.workspaces.list.getSnapshot()
      const sessionIds = workspaceSessionIdsForDeletion(management, workspaceId)
      await desktop.trashEnterpriseWorkspace(workspaceId)
      for (const sessionId of sessionIds) {
        documentDrafts.clear(sessionId)
        annotationDrafts.clear(sessionId)
        await composerDraftPersistence?.clear(sessionId)
      }
    },
    restoreWorkspace: async (workspaceId) => { await ctx.workspaces.unarchiveWorkspace(workspaceId) },
    archiveWorkspaceSession: async (workspaceId, sessionId) => {
      const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
      if (workspace === undefined || !workspace.sessionIds.includes(sessionId)) {
        throw new Error('该任务已不属于当前企业空间，请刷新后重试。')
      }
      await ctx.workspaces.archiveSession(sessionId)
    },
    restoreWorkspaceSession: async (sessionId) => { await ctx.workspaces.unarchiveSession(sessionId) },
    deleteWorkspaceSession: async (sessionId) => {
      if (desktop === undefined) throw new Error('删除对话仅在桌面客户端可用')
      await desktop.trashEnterpriseConversation(sessionId)
      documentDrafts.clear(sessionId)
      annotationDrafts.clear(sessionId)
      await composerDraftPersistence?.clear(sessionId)
    },
    refreshSkills: () => marketplace.load(),
    searchSkills: (source, query, page, category) => marketplace.search(source, query, page, category),
    installSkill: skill => marketplace.install(skill),
    setSkillEnabled: (skill, enabled) => marketplace.setEnabled(skill, enabled),
    removeSkill: skill => marketplace.remove(skill),
    addSkillRepository: manifestUrl => marketplace.addRepository(manifestUrl),
    removeSkillRepository: id => marketplace.removeRepository(id),
    setMcpEnabled: (id, enabled) => connectors.setEnabled({ id, enabled }),
    configureMcp: (id, value, endpoint) => connectors.configure({ id, value, ...(endpoint === undefined ? {} : { endpoint }) }),
    upsertCustomMcp: request => connectors.upsertCustom(request),
    removeCustomMcp: id => connectors.removeCustom({ id }),
    authorizeQcc: () => connectors.authorizeQcc((url) => { window.open(url, '_blank', 'noopener,noreferrer') }),
    beginTianyanchaAuthorization: () => connectors.beginTianyanchaAuthorization((url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    }),
    completeTianyanchaAuthorization: transactionId => connectors.completeTianyanchaAuthorization(transactionId),
    cancelMcpAuthorization: id => connectors.cancelAuthorization(id),
    refreshMcps: () => connectors.refresh(),
    setRegion: region => connectors.setRegion(region),
    createAutomation: request => automations.create(request),
    updateAutomation: request => automations.update(request),
    setAutomationEnabled: (id, enabled) => automations.setEnabled(id, enabled),
    removeAutomation: id => automations.remove(id),
    runAutomationNow: id => automations.runNow(id),
    openAutomationResult: sessionId => openAutomationResultConversation(ctx, sessionId, navigate),
    loginAccount: request => account.login(request),
    requestAccountLogin: () => { store.update((draft) => { draft.accountDialogRevision += 1 }) },
    refreshAccount: () => account.refresh(),
    disconnectAccount: () => account.disconnect(),
    loadPersonalization: () => account.loadPersonalization(),
    savePersonalization: instructions => account.savePersonalization(instructions),
    loadMemory: () => memory.snapshot(),
    configureMemory: request => memory.configure(request),
    clearMemory: () => memory.clearAll(),
    setAvatar: value => persistDesktopAvatar(store, value, window.gongchuangDesktop),
    checkForUpdates: () => window.gongchuangDesktop?.checkForUpdates() ?? unavailableUpdateAction(),
    downloadUpdate: () => window.gongchuangDesktop?.downloadUpdate() ?? unavailableUpdateAction(),
    installUpdate: () => window.gongchuangDesktop?.installUpdate() ?? unavailableUpdateAction(),
    ...(desktop === undefined ? {} : { onUpdateProgress: listener => desktop.onUpdateProgress(listener) }),
    readSkillUpdateState: () => window.gongchuangDesktop?.readSkillUpdateState() ?? unavailableSkillUpdateAction(),
    checkSkillUpdates: () => window.gongchuangDesktop?.checkSkillUpdates() ?? unavailableSkillUpdateAction(),
    downloadSkillUpdate: () => window.gongchuangDesktop?.downloadSkillUpdate() ?? unavailableSkillUpdateAction(),
    installSkillUpdate: () => window.gongchuangDesktop?.installSkillUpdate() ?? unavailableSkillUpdateAction(),
    respondWindowsCloseRequest: async (requestId, decision, remember) => {
      if (desktop === undefined || desktop.platform !== 'win32') throw new Error('当前环境不支持关闭窗口选择')
      await desktop.respondWindowsCloseRequest(requestId, decision, remember)
      windowsClosePrompt.update((draft) => {
        if (draft.requestId === requestId) draft.requestId = null
      })
    },
    resumeProfessionalTask: async () => {
      const sessionId = ctx.sessions.list.getSnapshot().current
      if (sessionId === undefined) throw new Error('当前没有可继续的任务')
      const conversation = ctx.sessions.scope(sessionId)?.get('conversation')
      if (conversation === undefined) throw new Error('当前任务会话尚未就绪')
      professionalTaskStatus.update((draft) => { draft.busy = true; draft.error = null })
      try {
        await conversation.send('继续')
        professionalTaskStatus.update((draft) => {
          draft.phase = 'none'
          draft.busy = false
          draft.error = null
        })
      } catch (error) {
        professionalTaskStatus.update((draft) => {
          draft.busy = false
          draft.error = error instanceof Error ? error.message : '任务未能继续'
        })
        throw error
      }
    },
    ...(desktop === undefined ? {} : {
      workspaceRootState: () => desktop.workspaceRootState(),
      chooseWorkspaceRoot: () => desktop.chooseWorkspaceRoot(),
      useDefaultWorkspaceRoot: () => desktop.useDefaultWorkspaceRoot(),
      createEnterpriseWorkspace: (name: string) => desktop.createEnterpriseWorkspace(name),
      importEnterpriseWorkspace: () => desktop.importEnterpriseWorkspace(),
      ...(desktop.platform === 'win32' ? {
        readWindowsCloseBehavior: () => desktop.readWindowsCloseBehavior(),
        writeWindowsCloseBehavior: (value: WindowsCloseBehavior) => desktop.writeWindowsCloseBehavior(value),
      } : {}),
    }),
  }
  return productActions
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gongchuang-client-ui: dictionaries')
  const store = createSnapshotStore(initialState(), { persist: { name: PERSIST_KEY } })
  const persistedProvider = store.getSnapshot().provider as unknown
  const migratedProvider = migratePersistedProvider(persistedProvider)
  if (persistedProvider !== migratedProvider) {
    store.update((draft) => { draft.provider = migratedProvider })
  }
  const windowsClosePrompt = createSnapshotStore<WindowsClosePromptState>({ requestId: null })
  const professionalTaskStatus = createSnapshotStore<ProfessionalTaskStatusState>({
    sessionId: null, phase: 'none', busy: false, error: null,
  })
  const deepClarification = new DeepClarificationMode()
  const documentDrafts = new ConversationDocumentDrafts()
  const annotationDrafts = new ConversationAnnotationDrafts()
  const desktopDraftBridge = window.gongchuangDesktop
  const composerDraftPersistence = desktopDraftBridge?.readComposerDraft === undefined
    || desktopDraftBridge.writeComposerDraft === undefined
    || desktopDraftBridge.clearComposerDraft === undefined
    ? undefined
    : new ComposerDraftPersistenceController({
      readComposerDraft: sessionId => desktopDraftBridge.readComposerDraft?.(sessionId) ?? Promise.resolve(null),
      writeComposerDraft: (sessionId, value) => desktopDraftBridge.writeComposerDraft?.(sessionId, value) ?? Promise.resolve(),
      clearComposerDraft: sessionId => desktopDraftBridge.clearComposerDraft?.(sessionId) ?? Promise.resolve(),
    }, ctx.conversationDraftText, documentDrafts, annotationDrafts, ctx.conversationDraftImages, (error, sessionId) => {
      ctx.logger.warn(`desktop composer draft persistence failed: ${error instanceof Error ? error.message : String(error)}`)
      const scope = ctx.sessions.scope(sessionId)
      if (scope !== undefined) ctx.conversation.input.for(scope).notify('error', ctx.locale.bind(NS)('draft.saveFailed'))
    })
  const annotationMarkers = new Map<SessionId, AnnotationMarkers>()
  ctx.effect(() => () => {
    for (const markers of annotationMarkers.values()) markers.dispose()
  }, 'gongchuang-client-ui: annotation source references')
  const t = ctx.locale.bind(NS)
  const readImageConsents = window.gongchuangDesktop?.readImageTransferConsents
  const rememberImageConsent = window.gongchuangDesktop?.rememberImageTransferConsent
  const imageTransferConsent = new ImageTransferConsentController(() => store.getSnapshot().provider,
    readImageConsents === undefined || rememberImageConsent === undefined ? undefined : {
      read: readImageConsents, remember: rememberImageConsent, failureMessage: t('images.consentSaveFailed'),
    })
  ctx.provide('conversationPromptPreparation', new ProductPromptPreparation([
    deepClarification, documentDrafts, annotationDrafts,
  ], text => summarizeAnnotatedUserMessage(text, count => t('annotations.count', { count }))))
  ctx.provide('conversationPromptAdmission', imageTransferConsent)
  ctx.provide('chatUserMessageFiles', createChatUserMessageFiles(ctx))
  ctx.provide('chatSelectionAnnotations', {
    add: (sessionId, selection) => { annotationDrafts.add(sessionId as SessionId, selection) },
    source: (id, nodeKey) => {
      const sessionId = id as SessionId
      let markers = annotationMarkers.get(sessionId)
      if (markers === undefined) {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) throw new Error('注释来源会话不可用')
        markers = new AnnotationMarkers(binding.eventSource, annotationDrafts.storeFor(sessionId))
        annotationMarkers.set(sessionId, markers)
      }
      return markers.source(nodeKey)
    },
  })
  installModelCatalogRefresh(ctx, ctx.remote.gongchuangModelConnections)
  void loadDesktopAvatar(store, window.gongchuangDesktop).catch(() => undefined)
  const persistedPage = store.getSnapshot().page as string
  if (!['assistant', 'enterprise', 'skills', 'mcp', 'automation'].includes(persistedPage)) {
    store.update((draft) => { draft.page = 'assistant' })
  }
  const activeRoute = (): string | undefined => {
    const sessionId = ctx.sessions.list.getSnapshot().current
    return sessionId === undefined
      ? undefined
      : ctx.modelDirectories.directoryFor(sessionId).store.getSnapshot().current?.provider
  }
  const connectivity = new ConnectivityController(
    ctx.remote.llm,
    ctx.remote.gongchuangModelConnections,
    activeRoute,
  )
  const activeProductProvider = (): ProductProvider | null => {
    const route = activeRoute()
    if (route === undefined) return null
    const providers = connectivity.store.getSnapshot().providers
    return GONGCHUANG_MODEL_PROVIDERS.find(provider => providers[provider.id].route === route)?.id ?? null
  }
  const syncVisibleProvider = (): void => {
    const rememberedProvider = store.getSnapshot().provider
    const decision = providerConnectivityRefreshDecision(
      activeProductProvider(),
      fallbackReadyProvider(connectivity),
      rememberedProvider,
      connectivity.store.getSnapshot().providers[rememberedProvider].status,
    )
    if (rememberedProvider !== decision.provider) {
      store.update((draft) => { draft.provider = decision.provider })
    }
  }
  const connectors = new ConnectorController(ctx.remote.gongchuangConnectors)
  const marketplace = new MarketplaceController(ctx.remote.gongchuangSkillMarketplace)
  const automations = new AutomationController(
    ctx.remote.gongchuangLocalAutomation,
    (claim, bindSession, admitMessage) => dispatchAutomation(ctx, claim, bindSession, (sessionId) => {
      ctx.sessions.open(sessionId)
      store.update((draft) => { draft.page = 'assistant' })
    }, admitMessage),
  )
  const account = new AccountController(
    ctx.remote.gongchuangAccount,
    () => { void connectors.refresh(); void marketplace.load() },
  )
  const memory = new GraphMemoryController(ctx.remote.gongchuangGraphMemory)
  const productActions = actions(
    ctx, store, connectivity, connectors, marketplace, automations, account, memory, imageTransferConsent,
    documentDrafts, annotationDrafts,
    composerDraftPersistence,
    windowsClosePrompt,
    professionalTaskStatus,
  )
  const injectProduct = () => ({
    hooks: {
      product: store,
      connectivity: connectivity.store,
      imageTransferConsent: imageTransferConsent.store,
      connectors: connectors.store,
      marketplace: marketplace.store,
      automations: automations.store,
      account: account.store,
      windowsClosePrompt,
      professionalTaskStatus,
    },
    ...productActions,
  })

  const refreshConnectivity = async (): Promise<void> => {
    await connectivity.load()
    // Connectivity, credential, and adapter events refresh availability only.
    // During resume, Session replay can briefly expose the Host default before
    // its durable selection; writing that transition would make it permanent.
    syncVisibleProvider()
  }
  void refreshConnectivity()
  void connectors.load()
  void marketplace.load()
  void automations.load()
  void account.load()
  if (composerDraftPersistence !== undefined) {
    ctx.effect(() => {
      const bindCurrent = (): void => {
        const sessions = ctx.sessions.list.getSnapshot()
        const current = sessions.current
        if (sessions.phase === 'ready' && current !== undefined && ctx.sessions.binding(current) !== undefined) {
          void composerDraftPersistence.bind(current)
        }
      }
      const flush = (): void => { composerDraftPersistence.flushAll() }
      bindCurrent()
      const offSessions = ctx.sessions.list.subscribe(bindCurrent)
      window.addEventListener('pagehide', flush)
      window.addEventListener('beforeunload', flush)
      return () => {
        offSessions()
        window.removeEventListener('pagehide', flush)
        window.removeEventListener('beforeunload', flush)
        composerDraftPersistence.dispose()
      }
    }, 'gongchuang-client-ui: native composer draft continuity')
  }
  const desktop = window.gongchuangDesktop
  if (desktop?.platform === 'win32') {
    ctx.effect(
      () => desktop.onWindowsCloseRequested((requestId) => {
        windowsClosePrompt.update((draft) => { draft.requestId = requestId })
      }),
      'gongchuang-client-ui: Windows close request projection',
    )
  }
  if (desktop !== undefined) {
    if (desktop.readProfessionalTaskStatus !== undefined) {
      ctx.effect(() => {
        let key = ''
        let revision = 0
        const refresh = (): void => {
          const sessions = ctx.sessions.list.getSnapshot()
          const nextKey = `${sessions.phase}:${sessions.current ?? ''}`
          if (nextKey === key) return
          key = nextKey
          const current = sessions.current
          const requestRevision = ++revision
          if (sessions.phase !== 'ready' || current === undefined) {
            professionalTaskStatus.update((draft) => {
              draft.sessionId = null
              draft.phase = 'none'
              draft.busy = false
              draft.error = null
            })
            return
          }
          void desktop.readProfessionalTaskStatus?.(current).then((status) => {
            if (requestRevision !== revision || ctx.sessions.list.getSnapshot().current !== current) return
            professionalTaskStatus.update((draft) => {
              draft.sessionId = current
              draft.phase = status.phase
              draft.busy = false
              draft.error = status.phase === 'unavailable' ? '任务状态不可恢复' : null
            })
          }).catch(() => {
            if (requestRevision !== revision || ctx.sessions.list.getSnapshot().current !== current) return
            professionalTaskStatus.update((draft) => {
              draft.sessionId = current
              draft.phase = 'unavailable'
              draft.busy = false
              draft.error = '任务状态不可读取'
            })
          })
        }
        refresh()
        return ctx.sessions.list.subscribe(refresh)
      }, 'gongchuang-client-ui: professional task checkpoint status')
    }
    ctx.effect(() => {
      let pending: string | null = null
      let opening = false
      const openPending = (): void => {
        if (opening || pending === null || ctx.sessions.list.getSnapshot().phase !== 'ready'
          || ctx.workspaces.list.getSnapshot().phase !== 'ready') return
        const sessionId = pending
        pending = null
        opening = true
        store.update((draft) => { draft.navigationError = null })
        void openDeepLinkedConversation(ctx, sessionId, (page) => {
          store.update((draft) => { draft.page = page })
        }).catch((error: unknown) => {
          store.update((draft) => {
            draft.navigationError = error instanceof Error ? error.message : String(error)
          })
          ctx.logger.warn(`gongchuang deep link could not open Session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        }).finally(() => {
          opening = false
          if (pending !== null) openPending()
        })
      }
      const disposeDeepLink = desktop.onOpenSessionDeepLink((sessionId) => {
        pending = sessionId
        openPending()
      })
      const disposeSessions = ctx.sessions.list.subscribe(openPending)
      const disposeWorkspaces = ctx.workspaces.list.subscribe(openPending)
      return () => {
        pending = null
        disposeDeepLink()
        disposeSessions()
        disposeWorkspaces()
      }
    }, 'gongchuang-client-ui: desktop Session deep links')
  }
  ctx.effect(() => {
    let observedSession: SessionId | undefined
    let disposeModelProjection = (): void => {}
    let disposeSessionEvents = (): void => {}
    const bindSessionModelProjection = (): void => {
      const current = ctx.sessions.list.getSnapshot().current
      if (current === observedSession) return
      disposeModelProjection()
      disposeSessionEvents()
      disposeModelProjection = (): void => {}
      disposeSessionEvents = (): void => {}
      observedSession = current
      if (current === undefined) {
        syncVisibleProvider()
        return
      }
      const directory = ctx.modelDirectories.directoryFor(current)
      const sync = (): void => { syncVisibleProvider() }
      disposeModelProjection = directory.store.subscribe(sync)
      const binding = ctx.sessions.binding(current)
      if (binding !== undefined) {
        let route = directory.store.getSnapshot().current?.provider
        const lastHeader = binding.eventSource.getSnapshot().entries.findLast(entry => entry.event.type === 'request/header')
        if (lastHeader?.event.type === 'request/header') route = lastHeader.event.data.header.config.provider
        // session/event belongs to the Host. The Client consumes live appends
        // from its existing feed; loading old history must not replay failures.
        disposeSessionEvents = binding.eventSource.subscribe(() => {
          const change = binding.eventSource.getSnapshot().change
          if (change.kind !== 'append') return
          for (const { event } of change.entries) {
            // alpha.1 exposes transient assistant chunks through the same Client
            // feed. They carry no durable provider failure or recovery state.
            if (event.type === 'assistant/live-chunk') continue
            if (event.type === 'request/header') route = event.data.header.config.provider
            if (event.type === 'assistant/message') {
              route = event.data.message.source.provider
            }
            onSessionEvent(event, route)
          }
        })
      }
      sync()
    }
    const refresh = (): void => {
      void refreshConnectivity()
      void connectors.load()
      void marketplace.load()
    }
    const onSessionEvent = (event: SessionEvent, route: string | undefined): void => {
      if (event.type === 'assistant/message' && event.data.step === 1) {
        const source = event.data.message.source
        void connectivity.recoverAfterResponse(source.provider).catch((error: unknown) => {
          ctx.logger.warn(`gongchuang credential recovery probe failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        return
      }
      if (event.type !== 'turn/end' || event.data.reason.kind !== 'error') return
      const failure = event.data.reason.error
      const detail = `${typeof failure.code === 'string' ? failure.code : ''} ${typeof failure.message === 'string' ? failure.message : ''}`.trim()
      const label = providerHealthLabel({
        status: 'error', configured: true, message: detail,
      })
      if (label !== '余额不足' && label !== '模型不可用') return
      const provider = GONGCHUANG_MODEL_PROVIDERS.find(provider => provider.route === route)?.id
      if (provider !== undefined) connectivity.recordRuntimeFailure(provider, detail)
    }
    const automationTimer = window.setInterval(() => {
      if (ctx.workspaces.list.getSnapshot().phase === 'ready'
        && ctx.sessions.list.getSnapshot().phase === 'ready') void automations.poll()
    }, 5_000)
    const connectorTimer = window.setInterval(() => { void connectors.load() }, 60_000)
    const pollVisibleAccount = (): void => {
      if (document.visibilityState === 'visible') void account.poll()
    }
    // Every agent request is device-verified by the Host. The background poll
    // only refreshes UI state, so once per minute plus foreground resume keeps
    // single-device status current without a /v1/me request every ten seconds.
    const accountTimer = window.setInterval(pollVisibleAccount, 60_000)
    document.addEventListener('visibilitychange', pollVisibleAccount)
    bindSessionModelProjection()
    const disposers = [
      ctx.sessions.list.subscribe(bindSessionModelProjection),
      connectivity.store.subscribe(syncVisibleProvider),
      ctx.remote.$on('settings/document-updated', refresh),
      ctx.remote.$on('credentials/reference-updated', refresh),
      ctx.remote.$on('llm/adapters-updated', refresh),
      ctx.remote.$on('gongchuang-connectors/changed', () => { void connectors.load() }),
      ctx.on('connection/reset', refresh),
    ]
    return () => {
      window.clearInterval(automationTimer)
      window.clearInterval(connectorTimer)
      window.clearInterval(accountTimer)
      document.removeEventListener('visibilitychange', pollVisibleAccount)
      disposeModelProjection()
      disposeSessionEvents()
      for (const dispose of disposers) dispose()
      account.dispose()
      imageTransferConsent.dispose()
    }
  }, 'gongchuang-client-ui: provider connectivity receipts')

  const previousTitle = document.title
  document.title = '洞见'
  document.body.dataset.gongchuangProduct = 'v0.1'
  if (window.gongchuangDesktop?.platform === 'darwin') document.body.dataset.gongchuangMacDesktop = 'true'
  ctx.effect(
    () => installProductShellStyleRecovery(),
    'gongchuang-client-ui: product stylesheet recovery',
  )
  ctx.effect(() => () => {
    document.title = previousTitle
    delete document.body.dataset.gongchuangProduct
    delete document.body.dataset.gongchuangMacDesktop
    document.body.style.removeProperty('--gc-sidebar-width')
  }, 'gongchuang-client-ui: document identity')

  ctx.effect(() => ctx.theme.overrideTokens('@gongchuang/client-ui', {
    '--gc-brand': { light: 'var(--dsw-static-red-900)', dark: 'var(--dsw-static-red-400)' },
    '--gc-brand-hover': { light: 'var(--dsw-static-red-600)', dark: 'var(--dsw-static-red-500)' },
    '--gc-brand-soft': { light: 'var(--dsw-static-red-50)', dark: 'var(--dsw-static-red-900)' },
    '--gc-brand-soft-border': { light: 'var(--dsw-static-red-400)', dark: 'var(--dsw-static-red-600)' },
    '--gc-gold': { light: 'var(--dsw-static-amber-600)', dark: 'var(--dsw-static-amber-400)' },
    '--gc-on-brand': { light: 'var(--dsw-static-neutral-00)', dark: 'var(--dsw-static-neutral-1000)' },
    '--gc-sidebar': { light: 'var(--dsw-static-neutral-900)', dark: 'var(--dsw-static-neutral-1000)' },
    '--gc-sidebar-ink': { light: 'var(--dsw-static-neutral-00)', dark: 'var(--dsw-static-neutral-50)' },
    '--gc-sidebar-muted': { light: 'var(--dsw-static-neutral-300)', dark: 'var(--dsw-static-neutral-400)' },
    '--gc-sidebar-faint': { light: 'var(--dsw-static-neutral-500)', dark: 'var(--dsw-static-neutral-600)' },
    '--gc-sidebar-hover': { light: 'var(--dsw-static-neutral-800)', dark: 'var(--dsw-static-neutral-850)' },
    '--gc-sidebar-active': { light: 'var(--dsw-static-neutral-700)', dark: 'var(--dsw-static-neutral-800)' },
    '--gc-sidebar-border': { light: 'var(--dsw-static-neutral-700)', dark: 'var(--dsw-static-neutral-800)' },
    '--gc-paper': { light: 'var(--dsw-static-neutral-50)', dark: 'var(--dsw-static-neutral-bluish-950)' },
    '--gc-surface': { light: 'var(--dsw-static-neutral-00)', dark: 'var(--dsw-static-neutral-900)' },
    '--gc-surface-muted': { light: 'var(--dsw-static-neutral-100)', dark: 'var(--dsw-static-neutral-850)' },
    '--gc-ink': { light: 'var(--dsw-static-neutral-900)', dark: 'var(--dsw-static-neutral-50)' },
    '--gc-muted': { light: 'var(--dsw-static-neutral-600)', dark: 'var(--dsw-static-neutral-400)' },
    '--gc-faint': { light: 'var(--dsw-static-neutral-500)', dark: 'var(--dsw-static-neutral-500)' },
    '--gc-border': { light: 'var(--dsw-static-neutral-200)', dark: 'var(--dsw-static-neutral-800)' },
    '--gc-border-strong': { light: 'var(--dsw-static-neutral-300)', dark: 'var(--dsw-static-neutral-700)' },
    '--gc-safe': { light: 'var(--dsw-static-green-500)', dark: 'var(--dsw-static-green-400)' },
    '--gc-safe-soft': { light: 'var(--dsw-static-green-100)', dark: 'var(--dsw-static-green-900)' },
    '--gc-safe-border': { light: 'var(--dsw-static-green-400)', dark: 'var(--dsw-static-green-500)' },
    '--gc-disabled': { light: 'var(--dsw-static-neutral-400)', dark: 'var(--dsw-static-neutral-600)' },
    '--gc-disabled-soft': { light: 'var(--dsw-static-neutral-150)', dark: 'var(--dsw-static-neutral-800)' },
    '--gc-danger': { light: 'var(--dsw-static-red-600)', dark: 'var(--dsw-static-red-400)' },
    '--gc-shadow-sm': { light: '0 1px 2px rgb(0 0 0 / 5%)', dark: '0 1px 2px rgb(0 0 0 / 30%)' },
    '--gc-shadow-md': { light: '0 8px 24px rgb(15 15 15 / 7%)', dark: '0 8px 24px rgb(0 0 0 / 35%)' },
  }), 'gongchuang-client-ui: product theme tokens')

  ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar',
    locale: NS,
    priority: -100,
    inject: injectProduct,
  }, ProductSidebar))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    locale: NS,
    id: 'gongchuang-product-pages',
    order: -100,
    inject: injectProduct,
  }, ProductOverlay))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    locale: NS,
    id: 'gongchuang-document-import',
    order: -100,
    inject: (sessionId): DocumentImportInjected => ({
      importDocuments: files => importDocumentsForSession(ctx, documentDrafts, sessionId, files),
    }),
  }, DocumentImportControl))
  ctx.slots.inject('conversation.input.payload', () => ctx.slots.register({
    name: 'conversation.input.payload',
    locale: NS,
    id: 'gongchuang-document-import-rail',
    order: -100,
    inject: (sessionId): DocumentImportRailInjected => {
      void composerDraftPersistence?.bind(sessionId)
      return {
        hooks: { documentDrafts: documentDrafts.storeFor(sessionId) },
        migrateLegacyDraft: (draft) => {
          const migrated = migrateLegacyDocumentDraft(draft)
          if (migrated.documents.length === 0) return
          documentDrafts.add(sessionId, migrated.documents)
          const actx = ctx.sessions.scope(sessionId)
          const conversation = actx?.get('conversation')
          if (actx !== undefined && conversation !== undefined) {
            conversation.input.for(actx).setDraft(migrated.draft)
          }
        },
        removeDocument: (relativePath) => {
          documentDrafts.remove(sessionId, relativePath)
        },
        openDocument: async (relativePath) => {
          await openImportedDocumentForSession(ctx, sessionId, relativePath)
        },
      }
    },
  }, DocumentImportRail))
  ctx.slots.inject('conversation.input.payload', () => ctx.slots.register({
    name: 'conversation.input.payload',
    id: 'gongchuang-annotation-draft-rail',
    order: -90,
    locale: NS,
    inject: (sessionId): AnnotationDraftRailInjected => ({
      hooks: { annotationDrafts: annotationDrafts.storeFor(sessionId) },
      removeAnnotation: (index) => { annotationDrafts.remove(sessionId, index) },
      commentAnnotation: (index, comment) => { annotationDrafts.comment(sessionId, index, comment) },
    }),
  }, AnnotationDraftRail))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'gongchuang-deep-clarification',
    order: -90,
    inject: (sessionId): DeepClarificationInjected => ({
      isDeepClarificationArmed: () => deepClarification.isArmed(sessionId),
      subscribeDeepClarification: listener => deepClarification.subscribe(sessionId, listener),
      setDeepClarificationArmed: (armed) => { deepClarification.setArmed(sessionId, armed) },
      hasHandledDeepClarificationSuggestion: () => deepClarification.hasHandledSuggestion(sessionId),
      markDeepClarificationSuggestionHandled: () => { deepClarification.markSuggestionHandled(sessionId) },
    }),
  }, DeepClarificationControl))
  ctx.slots.inject('conversation.hero.headline', () => ctx.slots.register({
    name: 'conversation.hero.headline',
    locale: NS,
  }, ProductHeroHeadline))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
    name: 'conversation.hero.brand.mark',
  }, ProductHeroBrandMark))
  ctx.slots.inject('conversation.hero.preview', () => ctx.slots.register({
    name: 'conversation.hero.preview',
  }, ProductHeroPreview))
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'gongchuang-image-transfer-provider',
    order: -100,
    inject: (): ImageTransferProviderNoticeProps => ({
      hooks: { product: store },
      resolveDraftAttachments: (ids: readonly DraftAttachmentId[]): readonly ComposerAttachment[] => {
        const conversation = ctx.get('conversation') as unknown as {
          resolveDraftAttachments: (draftIds: readonly DraftAttachmentId[]) => readonly ComposerAttachment[]
        } | undefined
        if (conversation === undefined) throw new Error('conversation attachment resolver unavailable')
        return conversation.resolveDraftAttachments(ids)
      },
    } as unknown as ImageTransferProviderNoticeProps),
  }, ImageTransferProviderNotice))
  ctx.slots.inject('conversation.hero.workspace.createEnterprise', () => ctx.slots.register({
    name: 'conversation.hero.workspace.createEnterprise',
    inject: injectProduct,
  }, EnterpriseCreationMenuItem))
}
