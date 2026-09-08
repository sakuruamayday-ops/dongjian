/** Narrow desktop bridge for product-owned native actions. */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopUpdateProgress, DesktopUpdateSnapshot } from './desktop-updater.ts'
import type { SkillUpdateSnapshot } from './skill-updater.ts'
import type { WorkspaceRootDesktopBridge } from './workspace-root.ts'
import type { ProfessionalTaskUiStatus } from './professional-task-status.ts'
import type { GongchuangModelProvider } from '@gongchuang/model-connections/registry'

// Sandboxed Electron preloads may require only a small builtin allowlist.
// Keep these literals local so the bundler cannot emit a relative shared
// chunk that the sandboxed preload would be unable to require.
const UPDATE_CHECK_CHANNEL = 'gongchuang:update:check'
const UPDATE_DOWNLOAD_CHANNEL = 'gongchuang:update:download'
const UPDATE_INSTALL_CHANNEL = 'gongchuang:update:install'
const UPDATE_PROGRESS_CHANNEL = 'gongchuang:update:progress'
const SKILL_UPDATE_STATE_CHANNEL = 'gongchuang:skill-update:state'
const SKILL_UPDATE_CHECK_CHANNEL = 'gongchuang:skill-update:check'
const SKILL_UPDATE_DOWNLOAD_CHANNEL = 'gongchuang:skill-update:download'
const SKILL_UPDATE_INSTALL_CHANNEL = 'gongchuang:skill-update:install'
const AVATAR_READ_CHANNEL = 'gongchuang:profile-avatar:read'
const AVATAR_WRITE_CHANNEL = 'gongchuang:profile-avatar:write'
const DOCUMENT_IMPORT_CHANNEL = 'gongchuang:documents:import'
const DOCUMENT_DROP_IMPORT_CHANNEL = 'gongchuang:documents:import-dropped'
const DOCUMENT_OPEN_CHANNEL = 'gongchuang:documents:open-imported'
const SESSION_ATTACHMENT_OPEN_CHANNEL = 'gongchuang:documents:open-session-attachment'
const DESKTOP_PREFERENCES_READ_CHANNEL = 'gongchuang:desktop-preferences:read'
const DESKTOP_CLOSE_BEHAVIOR_WRITE_CHANNEL = 'gongchuang:desktop-preferences:close-behavior'
const DESKTOP_CLOSE_REQUEST_CHANNEL = 'gongchuang:desktop-close:request'
const DESKTOP_CLOSE_RESPONSE_CHANNEL = 'gongchuang:desktop-close:response'
const WORKSPACE_ROOT_STATE_CHANNEL = 'gongchuang:workspace-root:state'
const WORKSPACE_ROOT_CHOOSE_CHANNEL = 'gongchuang:workspace-root:choose'
const WORKSPACE_ROOT_USE_DEFAULT_CHANNEL = 'gongchuang:workspace-root:use-default'
const ENTERPRISE_WORKSPACE_CREATE_CHANNEL = 'gongchuang:enterprise-workspace:create'
const ENTERPRISE_WORKSPACE_IMPORT_CHANNEL = 'gongchuang:enterprise-workspace:import'
const ENTERPRISE_WORKSPACE_TRASH_CHANNEL = 'gongchuang:enterprise-workspace:trash'
const ENTERPRISE_CONVERSATION_TRASH_CHANNEL = 'gongchuang:enterprise-conversation:trash'
const OPEN_SESSION_DEEP_LINK_CHANNEL = 'gongchuang:deep-link:open-session'
const PROFESSIONAL_TASK_STATUS_CHANNEL = 'gongchuang:professional-task:status'
const COMPOSER_DRAFT_READ_CHANNEL = 'gongchuang:composer-draft:read'
const COMPOSER_DRAFT_WRITE_CHANNEL = 'gongchuang:composer-draft:write'
const COMPOSER_DRAFT_CLEAR_CHANNEL = 'gongchuang:composer-draft:clear'
const IMAGE_TRANSFER_CONSENTS_READ_CHANNEL = 'gongchuang:image-transfer-consents:read'
const IMAGE_TRANSFER_CONSENT_REMEMBER_CHANNEL = 'gongchuang:image-transfer-consents:remember'

interface ImportedDocument {
  readonly name: string
  readonly relativePath: string
  readonly bytes: number
}

type WindowsCloseBehavior = 'ask' | 'tray' | 'quit'
type WindowsCloseDecision = Exclude<WindowsCloseBehavior, 'ask'> | null

const deepLinkListeners = new Set<(sessionId: string) => void>()
let pendingDeepLinkedSession: string | undefined
ipcRenderer.on(OPEN_SESSION_DEEP_LINK_CHANNEL, (_event, sessionId: unknown) => {
  if (typeof sessionId !== 'string') return
  if (deepLinkListeners.size === 0) {
    pendingDeepLinkedSession = sessionId
    return
  }
  for (const listener of deepLinkListeners) listener(sessionId)
})

const workspaceRootBridge: WorkspaceRootDesktopBridge = {
  workspaceRootState: () => ipcRenderer.invoke(WORKSPACE_ROOT_STATE_CHANNEL) as ReturnType<WorkspaceRootDesktopBridge['workspaceRootState']>,
  chooseWorkspaceRoot: () => ipcRenderer.invoke(WORKSPACE_ROOT_CHOOSE_CHANNEL) as ReturnType<WorkspaceRootDesktopBridge['chooseWorkspaceRoot']>,
  useDefaultWorkspaceRoot: () => ipcRenderer.invoke(WORKSPACE_ROOT_USE_DEFAULT_CHANNEL) as ReturnType<WorkspaceRootDesktopBridge['useDefaultWorkspaceRoot']>,
  createEnterpriseWorkspace: name => ipcRenderer.invoke(
    ENTERPRISE_WORKSPACE_CREATE_CHANNEL,
    name,
  ) as ReturnType<WorkspaceRootDesktopBridge['createEnterpriseWorkspace']>,
  importEnterpriseWorkspace: () => ipcRenderer.invoke(ENTERPRISE_WORKSPACE_IMPORT_CHANNEL) as ReturnType<WorkspaceRootDesktopBridge['importEnterpriseWorkspace']>,
}

contextBridge.exposeInMainWorld('gongchuangDesktop', Object.freeze({
  platform: process.platform === 'darwin' ? 'darwin' : 'win32',
  checkForUpdates: (): Promise<DesktopUpdateSnapshot> => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL) as Promise<DesktopUpdateSnapshot>,
  downloadUpdate: (): Promise<DesktopUpdateSnapshot> => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL) as Promise<DesktopUpdateSnapshot>,
  installUpdate: (): Promise<DesktopUpdateSnapshot> => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL) as Promise<DesktopUpdateSnapshot>,
  onUpdateProgress: (listener: (progress: DesktopUpdateProgress) => void): (() => void) => {
    const handle = (_event: Electron.IpcRendererEvent, progress: DesktopUpdateProgress): void => { listener(progress) }
    ipcRenderer.on(UPDATE_PROGRESS_CHANNEL, handle)
    return () => { ipcRenderer.removeListener(UPDATE_PROGRESS_CHANNEL, handle) }
  },
  readSkillUpdateState: (): Promise<SkillUpdateSnapshot> => ipcRenderer.invoke(SKILL_UPDATE_STATE_CHANNEL) as Promise<SkillUpdateSnapshot>,
  checkSkillUpdates: (): Promise<SkillUpdateSnapshot> => ipcRenderer.invoke(SKILL_UPDATE_CHECK_CHANNEL) as Promise<SkillUpdateSnapshot>,
  downloadSkillUpdate: (): Promise<SkillUpdateSnapshot> =>
    ipcRenderer.invoke(SKILL_UPDATE_DOWNLOAD_CHANNEL) as Promise<SkillUpdateSnapshot>,
  installSkillUpdate: (): Promise<SkillUpdateSnapshot> => ipcRenderer.invoke(SKILL_UPDATE_INSTALL_CHANNEL) as Promise<SkillUpdateSnapshot>,
  readAvatar: (): Promise<string | null> => ipcRenderer.invoke(AVATAR_READ_CHANNEL) as Promise<string | null>,
  writeAvatar: (value: string | null): Promise<string | null> => ipcRenderer.invoke(AVATAR_WRITE_CHANNEL, value) as Promise<string | null>,
  importDocuments: (workspacePath: string): Promise<readonly ImportedDocument[]> =>
    ipcRenderer.invoke(DOCUMENT_IMPORT_CHANNEL, workspacePath) as Promise<readonly ImportedDocument[]>,
  importDroppedDocuments: (workspacePath: string, files: readonly File[]): Promise<readonly ImportedDocument[]> => {
    const paths = files.map(file => webUtils.getPathForFile(file))
    if (paths.some(path => path === '')) return Promise.reject(new Error('只能拖入本机磁盘上的文件'))
    return ipcRenderer.invoke(DOCUMENT_DROP_IMPORT_CHANNEL, workspacePath, paths) as Promise<readonly ImportedDocument[]>
  },
  openImportedDocument: (workspacePath: string, relativePath: string): Promise<void> =>
    ipcRenderer.invoke(DOCUMENT_OPEN_CHANNEL, workspacePath, relativePath) as Promise<void>,
  openSessionAttachment: (
    sessionId: string,
    attachment: { readonly attachmentId: string; readonly name: string; readonly bytes: number },
  ): Promise<void> => ipcRenderer.invoke(SESSION_ATTACHMENT_OPEN_CHANNEL, sessionId, attachment) as Promise<void>,
  fileApplications: (workspacePath: string, path: string) =>
    ipcRenderer.invoke('gongchuang:documents:applications', workspacePath, path),
  fileAction: (workspacePath: string, path: string, action: 'open-with' | 'reveal' | 'save-copy', applicationId: string | null = null): Promise<void> =>
    ipcRenderer.invoke('gongchuang:documents:action', workspacePath, path, action, applicationId) as Promise<void>,
  trashEnterpriseWorkspace: (workspaceId: string): Promise<void> =>
    ipcRenderer.invoke(ENTERPRISE_WORKSPACE_TRASH_CHANNEL, workspaceId) as Promise<void>,
  trashEnterpriseConversation: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(ENTERPRISE_CONVERSATION_TRASH_CHANNEL, sessionId) as Promise<void>,
  readWindowsCloseBehavior: (): Promise<WindowsCloseBehavior> =>
    ipcRenderer.invoke(DESKTOP_PREFERENCES_READ_CHANNEL) as Promise<WindowsCloseBehavior>,
  writeWindowsCloseBehavior: (value: WindowsCloseBehavior): Promise<WindowsCloseBehavior> =>
    ipcRenderer.invoke(DESKTOP_CLOSE_BEHAVIOR_WRITE_CHANNEL, value) as Promise<WindowsCloseBehavior>,
  onWindowsCloseRequested: (listener: (requestId: string) => void): (() => void) => {
    const handle = (_event: Electron.IpcRendererEvent, requestId: unknown): void => {
      if (typeof requestId === 'string') listener(requestId)
    }
    ipcRenderer.on(DESKTOP_CLOSE_REQUEST_CHANNEL, handle)
    return () => { ipcRenderer.removeListener(DESKTOP_CLOSE_REQUEST_CHANNEL, handle) }
  },
  respondWindowsCloseRequest: (
    requestId: string,
    decision: WindowsCloseDecision,
    remember: boolean,
  ): Promise<void> => ipcRenderer.invoke(
    DESKTOP_CLOSE_RESPONSE_CHANNEL,
    requestId,
    decision,
    remember,
  ) as Promise<void>,
  onOpenSessionDeepLink: (listener: (sessionId: string) => void): (() => void) => {
    deepLinkListeners.add(listener)
    if (pendingDeepLinkedSession !== undefined) {
      const sessionId = pendingDeepLinkedSession
      pendingDeepLinkedSession = undefined
      queueMicrotask(() => { if (deepLinkListeners.has(listener)) listener(sessionId) })
    }
    return () => { deepLinkListeners.delete(listener) }
  },
  readProfessionalTaskStatus: (sessionId: string): Promise<ProfessionalTaskUiStatus> =>
    ipcRenderer.invoke(PROFESSIONAL_TASK_STATUS_CHANNEL, sessionId) as Promise<ProfessionalTaskUiStatus>,
  readComposerDraft: (sessionId: string): Promise<unknown> =>
    ipcRenderer.invoke(COMPOSER_DRAFT_READ_CHANNEL, sessionId) as Promise<unknown>,
  writeComposerDraft: (sessionId: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke(COMPOSER_DRAFT_WRITE_CHANNEL, sessionId, value) as Promise<void>,
  clearComposerDraft: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(COMPOSER_DRAFT_CLEAR_CHANNEL, sessionId) as Promise<void>,
  readImageTransferConsents: (): Promise<readonly GongchuangModelProvider[]> =>
    ipcRenderer.invoke(IMAGE_TRANSFER_CONSENTS_READ_CHANNEL) as Promise<readonly GongchuangModelProvider[]>,
  rememberImageTransferConsent: (provider: GongchuangModelProvider): Promise<void> =>
    ipcRenderer.invoke(IMAGE_TRANSFER_CONSENT_REMEMBER_CHANNEL, provider) as Promise<void>,
  ...workspaceRootBridge,
}))
