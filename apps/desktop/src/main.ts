/** 洞见 Electron host. */

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron'
import { openPublicExternal } from './external-navigation.ts'
import {
  DesktopUpdaterController, UPDATE_CHECK_CHANNEL, UPDATE_DOWNLOAD_CHANNEL, UPDATE_INSTALL_CHANNEL,
  UPDATE_PROGRESS_CHANNEL, desktopUpdateFeedUrl, type DesktopUpdateSnapshot,
} from './desktop-updater.ts'
import {
  macApplicationPath,
  MacSelfUpdaterController,
} from './macos-self-updater.ts'
import {
  beginMacUpdateLaunch, beginMacUpdateRecovery, commitMacUpdateLaunch, macUpdateTerminalCleanupPaths,
  macUpdateProcessIdentity, waitForMacUpdateHelperHandoff,
} from './macos-update-helper.ts'
import {
  commitSkillBundleLaunch, resolveSkillBundleForLaunch, SkillUpdaterController, trashReconciledSkillUpdateStaging,
  SKILL_UPDATE_STATE_CHANNEL, SKILL_UPDATE_CHECK_CHANNEL, SKILL_UPDATE_DOWNLOAD_CHANNEL, SKILL_UPDATE_INSTALL_CHANNEL,
} from './skill-updater.ts'
import log from 'electron-log/main.js'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { createLaunchEnvironmentSnapshot as CreateLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search'
import type { runProfile as RunProfile, RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import type { GongchuangSkillRuntimeBinding } from '@gongchuang/signed-skill-runtime'
import { ProfessionalTaskCheckpointStore } from '@gongchuang/client-policy-gate'
import { gongchuangDiagnostic, gongchuangUserError } from '@gongchuang/user-errors'
import { createProductTrustedPatches } from '../../../product/gongchuang-client/src/host-admission.ts'
import { verifyProductRuntimeForStartup } from '../../../product/gongchuang-client/src/product-runtime-verifier.ts'
import type { VerifiedSkillSuite } from '../../../product/gongchuang-client/src/skill-suite-verifier.ts'
import { PRODUCT_TRUST_ANCHORS } from '../../../product/gongchuang-client/src/trust-anchors.ts'
import { developmentRuntimeBundleDirectory } from './runtime-bundle-path.ts'
import { DESKTOP_LOOPBACK_URLS, desktopAuthenticatedLoopbackUrl } from './loopback.ts'
import {
  AVATAR_READ_CHANNEL, AVATAR_WRITE_CHANNEL, DesktopAvatarStore,
} from './profile-avatar.ts'
import {
  DOCUMENT_DROP_IMPORT_CHANNEL, DOCUMENT_IMPORT_CHANNEL, DOCUMENT_OPEN_CHANNEL, SESSION_ATTACHMENT_OPEN_CHANNEL,
  DocumentImportDirectoryStore, importedDocumentPath, importSelectedDocuments,
} from './document-import.ts'
import { DesktopWorkspaceRootStore } from './workspace-root.ts'
import { configureFileActions } from './file-actions.ts'
import { registerWorkspaceRootIpc } from './workspace-root-ipc.ts'
import { EnterpriseTrashService } from './enterprise-trash.ts'
import { registerEnterpriseTrashIpc } from './enterprise-trash-ipc.ts'
import { EnterpriseTrashJournal } from './enterprise-trash-journal.ts'
import { closeWindowToBackground, restoreWindowFromBackground } from './window-background-lifecycle.ts'
import {
  resolveAcceptanceUserDataRoot,
  sanitizeAcceptanceLaunchEnvironment,
} from './acceptance-user-data.ts'
import { bundledArtifactFontPath, DesktopArtifactRenderer } from './artifact-renderer.ts'
import { ensureUtf8LogFile } from './utf8-log-file.ts'
import { nativeContextMenuTemplate } from './native-context-menu.ts'
import {
  DESKTOP_CLOSE_BEHAVIOR_WRITE_CHANNEL,
  DESKTOP_CLOSE_REQUEST_CHANNEL,
  DESKTOP_CLOSE_RESPONSE_CHANNEL,
  DESKTOP_PREFERENCES_READ_CHANNEL,
  DesktopPreferencesStore,
  WindowsCloseRequestCoordinator,
  type WindowsCloseBehavior,
} from './desktop-preferences.ts'
import { startupRepairUrl } from './startup-repair.ts'
import { createHostRuntimeDiagnosticsExporter } from './host-runtime-diagnostics.ts'
import { runDesktopInstallHandoff } from './desktop-install-handoff.ts'
import { clearBrowserTransportCookies } from './browser-transport-cookie-cleanup.ts'
import {
  GONGCHUANG_PROTOCOL, OPEN_SESSION_DEEP_LINK_CHANNEL, parseSessionDeepLink, sessionDeepLinkFromArgv,
} from './deep-link.ts'
import { PROFESSIONAL_TASK_STATUS_CHANNEL, professionalTaskUiStatus } from './professional-task-status.ts'
import {
  armDesktopHardExit, disposeDesktopRuntime, finishDesktopHostQuit, forceDesktopProcessExit,
} from './runtime-shutdown.ts'
import {
  COMPOSER_DRAFT_CLEAR_CHANNEL, COMPOSER_DRAFT_READ_CHANNEL, COMPOSER_DRAFT_WRITE_CHANNEL,
  ComposerDraftStore,
} from './composer-drafts.ts'
import {
  IMAGE_TRANSFER_CONSENTS_READ_CHANNEL, IMAGE_TRANSFER_CONSENT_REMEMBER_CHANNEL, ImageTransferConsentStore,
} from './image-transfer-consents.ts'

const PRODUCT_ID = 'cn.dongjian.desktop'
const PRODUCT_NAME = '洞见'
const PRODUCT_LOCALE = 'zh-CN'
const STARTUP_FAILURE_EXIT_TIMEOUT_MS = 15_000
const DESKTOP_LOG_MAX_BYTES = 5 * 1024 * 1024
const ACCEPTANCE_RENDERER_PROBE = `(async () => {
  const inspect = () => {
    const manifest = document.getElementById('dsh-boot-manifest')
    const bootPage = document.querySelector('[data-dsh-boot]')
    const executableInlineScripts = Array.from(document.scripts)
      .filter(script => script.src === '' && script.type !== 'application/json').length
    return {
      manifestType: manifest instanceof HTMLScriptElement ? manifest.type : null,
      loaderMode: window.__ModuleLoader__?.mode ?? null,
      executableInlineScripts,
      bootPagePresent: bootPage !== null,
      bootFailureVisible: bootPage?.textContent?.includes('Failed to load plugins') ?? false,
      productUiMarker: document.body.dataset.gongchuangProduct ?? null,
      productRootVisible: (() => {
        const root = document.querySelector('[data-gongchuang-product-root="sidebar"]')
        if (!(root instanceof HTMLElement)) return false
        const rect = root.getBoundingClientRect()
        const style = getComputedStyle(root)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      })(),
    }
  }
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const probe = inspect()
    if (probe.bootFailureVisible
      || (!probe.bootPagePresent && probe.productUiMarker === 'v0.1' && probe.productRootVisible)) return probe
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return inspect()
})()`
const DESKTOP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const startupStartedAt = performance.now()

// The product UI is Chinese-first. Electron otherwise inherits the Chromium
// process locale, which can be English even when macOS itself is Chinese.
// Host-backed explicit locale preferences may still replace this provisional
// browser language after the client runtime connects.
app.commandLine.appendSwitch('lang', PRODUCT_LOCALE)
const mainWindowPreload = fileURLToPath(new URL('./main-window-preload.cjs', import.meta.url))

interface ProductPaths {
  icon: string
  trayIcon: string
  skillBundle: string
  runtimeBundle: string
  policyManifest: string
  policySignature: string
  policyPublicKey: string
}

let mainWindow: BrowserWindow | undefined
let startupWindow: BrowserWindow | undefined
let appTray: Tray | undefined
let profileRuntime: Awaited<ReturnType<typeof RunProfile>> | undefined
let quitting = false
let desktopHostShutdownStarted = false
let windowsCloseBehavior: WindowsCloseBehavior = 'ask'
let desktopPreferencesStore: DesktopPreferencesStore | undefined
let composerDraftStore: ComposerDraftStore | undefined
let pendingDeepLinkedSession: string | undefined
const windowsCloseRequests = new WindowsCloseRequestCoordinator()

async function disposeProfileRuntime(): Promise<void> {
  const runtime = profileRuntime
  if (runtime === undefined) return
  await disposeDesktopRuntime(async () => {
    await composerDraftStore?.flush()
    await runtime.ctx.fiber.dispose()
  })
}

function beginDesktopHostShutdown(code: number): void {
  if (desktopHostShutdownStarted) {
    forceDesktopProcessExit(code)
    return
  }
  desktopHostShutdownStarted = true
  quitting = true
  armDesktopHardExit(code, (exitCode) => {
    log.error(`desktop native exit exceeded the absolute deadline pid=${String(process.pid)}`)
    forceDesktopProcessExit(exitCode)
  })
  appTray?.destroy()
  appTray = undefined
  void finishDesktopHostQuit(disposeProfileRuntime, {
    complete: () => { log.info(`desktop runtime shutdown complete pid=${String(process.pid)}`) },
    fail: (error: unknown) => {
      log.error(`desktop runtime shutdown failed pid=${String(process.pid)}: ${gongchuangDiagnostic(error)}`)
    },
    exit: (exitCode) => { app.exit(exitCode) },
    forceExit: (exitCode) => {
      // This runs only after the ten-second disposal deadline. A self-SIGKILL
      // avoids the Rosetta case where Electron kept an orphaned native main process.
      forceDesktopProcessExit(exitCode)
    },
  }, code)
}

function revealMainWindow(): void {
  if (mainWindow === undefined) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function flushPendingDeepLink(): void {
  if (mainWindow === undefined || pendingDeepLinkedSession === undefined) return
  mainWindow.webContents.send(OPEN_SESSION_DEEP_LINK_CHANNEL, pendingDeepLinkedSession)
  pendingDeepLinkedSession = undefined
}

function acceptSessionDeepLink(value: string): boolean {
  const sessionId = parseSessionDeepLink(value)
  if (sessionId === undefined) return false
  pendingDeepLinkedSession = sessionId
  flushPendingDeepLink()
  revealMainWindow()
  return true
}

function logStartupStage(stage: string): void {
  log.info(`desktop startup stage=${stage} elapsedMs=${String(Math.round(performance.now() - startupStartedAt))}`)
}

interface AcceptanceRendererProbe {
  bootFailureVisible: boolean
  bootPagePresent: boolean
  executableInlineScripts: number
  loaderMode: string | null
  manifestType: string | null
  productUiMarker: string | null
  productRootVisible: boolean
}

function failClosedAfterStartupError(error: unknown): void {
  startupWindow?.destroy()
  startupWindow = undefined
  const presented = gongchuangUserError(error, 'startup')
  log.error(`[${presented.code}] ${gongchuangDiagnostic(error)}`)
  quitting = true

  let exited = false
  const exit = (): void => {
    if (exited) return
    exited = true
    app.exit(1)
  }

  if (acceptanceUserDataRoot !== undefined) {
    exit()
    return
  }

  const exitTimer = setTimeout(exit, STARTUP_FAILURE_EXIT_TIMEOUT_MS)
  const offersRepair = app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32')
  void dialog.showMessageBox({
    type: 'error',
    title: '洞见启动失败',
    message: '客户端服务未能完整启动，客户端已关闭。',
    detail: presented.text,
    buttons: offersRepair ? ['下载完整修复安装包', '关闭'] : ['关闭'],
    defaultId: 0,
    cancelId: offersRepair ? 1 : 0,
    noLink: true,
  }).then(async (result) => {
    if (!offersRepair || result.response !== 0) return
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const url = startupRepairUrl(process.platform as 'darwin' | 'win32', arch)
    await openPublicExternal(url, async (target) => { await shell.openExternal(target) })
  }).catch((dialogError: unknown) => {
    log.error(`startup failure dialog failed: ${gongchuangDiagnostic(dialogError)}`)
  }).finally(() => {
    clearTimeout(exitTimer)
    exit()
  })
}

async function createWindowsStartupWindow(icon: string): Promise<BrowserWindow | undefined> {
  if (process.platform !== 'win32') return undefined
  const brand = nativeImage.createFromPath(icon).resize({ width: 52, height: 52, quality: 'best' }).toDataURL()
  const window = new BrowserWindow({
    title: `正在启动${PRODUCT_NAME}`,
    width: 420,
    height: 176,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    backgroundColor: '#F7F3EA',
    icon,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: false,
    },
  })
  const page = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
    <style>html,body{height:100%;margin:0}body{display:flex;align-items:center;gap:18px;box-sizing:border-box;padding:30px 34px;background:#f7f3ea;color:#191714;font-family:'Microsoft YaHei UI','Microsoft YaHei',sans-serif}img{width:52px;height:52px;object-fit:contain}.copy{min-width:0}.title{font-size:17px;font-weight:600;line-height:26px}.status{margin-top:6px;color:#6d665b;font-size:13px;line-height:20px}.line{width:250px;height:2px;margin-top:16px;overflow:hidden;background:#ddd4c5}.line::after{display:block;width:42%;height:100%;background:#b88a42;content:'';animation:progress 1.2s ease-in-out infinite alternate}@keyframes progress{from{transform:translateX(-20%)}to{transform:translateX(160%)}}</style>
    <img src="${brand}" alt=""><div class="copy"><div class="title">${PRODUCT_NAME}正在启动</div><div class="status">正在验证运行环境并加载企业能力…</div><div class="line"></div></div>`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
  window.center()
  window.show()
  logStartupStage('startup-window-visible')
  return window
}

function environmentSnapshot(
  createLaunchEnvironmentSnapshot: typeof CreateLaunchEnvironmentSnapshot,
): ReturnType<typeof CreateLaunchEnvironmentSnapshot> {
  const values = acceptanceUserDataRoot === undefined
    ? Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
    : sanitizeAcceptanceLaunchEnvironment(process.env)
  return createLaunchEnvironmentSnapshot([{ source: 'process', values }])
}

function productPaths(): ProductPaths {
  const windowIcon = process.platform === 'win32' ? 'dongjian-mark.png' : 'dongjian-app.png'
  if (app.isPackaged) {
    const product = join(process.resourcesPath, 'product')
    const skillBundle = join(product, 'skill-suite')
    const policy = join(product, 'policy')
    return {
      icon: join(product, 'brand', windowIcon),
      trayIcon: join(product, 'brand', 'dongjian-mark.png'),
      skillBundle,
      runtimeBundle: join(product, 'runtime'),
      policyManifest: join(policy, 'policy-template.json'),
      policySignature: join(policy, 'policy.sig'),
      policyPublicKey: join(policy, 'policy.pub.pem'),
    }
  }
  const skillBundle = join(sourceRoot, 'apps', 'desktop', '.build', 'product-skills')
  const product = join(sourceRoot, 'product', 'gongchuang-client')
  return {
    icon: join(sourceRoot, 'apps', 'desktop', 'assets', windowIcon),
    trayIcon: join(sourceRoot, 'apps', 'desktop', 'assets', 'dongjian-mark.png'),
    skillBundle,
    runtimeBundle: developmentRuntimeBundleDirectory(
      join(sourceRoot, 'apps', 'desktop', '.build'),
      process.platform,
      process.arch,
    ),
    policyManifest: join(product, 'policy-template.json'),
    policySignature: join(product, 'signatures', 'development', 'policy.sig'),
    policyPublicKey: join(product, 'signatures', 'development', 'policy.pub.pem'),
  }
}

function createTrayImage(path: string): Electron.NativeImage {
  const image = nativeImage.createFromPath(path).resize({
    width: 18,
    height: 18,
    quality: 'best',
  })
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

function configureWindowsApplicationMenu(): void {
  if (process.platform !== 'win32') return
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { role: 'close', label: '关闭窗口' },
        { type: 'separator' },
        { role: 'quit', label: '退出应用' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '查看',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
    {
      label: '帮助',
      submenu: [{
        label: '关于洞见',
        click: () => {
          void dialog.showMessageBox({
            type: 'info',
            title: '关于洞见',
            message: `${PRODUCT_NAME} V${app.getVersion()}`,
            detail: '基于 DeepSeek Harness 构建的企业级智能工作客户端。',
            buttons: ['知道了'],
            defaultId: 0,
            noLink: true,
          })
        },
      }],
    },
  ]))
}

function configureSession(): Electron.Session {
  // 跨客户端更新保留这个历史持久分区，以免清空普通 Web 状态与非传输认证 Cookie。
  // Connection 的进程级签名 Cookie 会在每次启动时重新签发，不代表账号登录状态。
  const desktopSession = session.fromPartition('persist:dongjian-v0.1')
  desktopSession.webRequest.onHeadersReceived(
    { urls: [...DESKTOP_LOOPBACK_URLS] },
    (details, callback) => {
      const responseHeaders = Object.fromEntries(
        Object.entries(details.responseHeaders ?? {})
          .filter(([name]) => name.toLowerCase() !== 'content-security-policy'),
      )
      responseHeaders['Content-Security-Policy'] = [DESKTOP_CSP]
      responseHeaders['X-Content-Type-Options'] = ['nosniff']
      responseHeaders['Referrer-Policy'] = ['no-referrer']
      callback({ responseHeaders })
    },
  )
  desktopSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write')
  desktopSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write')
  })
  return desktopSession
}

/** Prove the packaged renderer completed CSP-protected boot and mounted the product UI. */
async function verifyProductRendererStartup(window: BrowserWindow): Promise<void> {
  const value = await window.webContents.executeJavaScript(ACCEPTANCE_RENDERER_PROBE, true) as unknown
  if (typeof value !== 'object' || value === null) {
    throw new Error('桌面启动无法读取渲染器状态')
  }
  const probe = value as Partial<AcceptanceRendererProbe>
  if (probe.manifestType !== 'application/json'
    || probe.loaderMode !== 'live'
    || probe.executableInlineScripts !== 0
    || probe.bootFailureVisible !== false
    || probe.bootPagePresent !== false
    || probe.productUiMarker !== 'v0.1'
    || !probe.productRootVisible) {
    throw new Error(`桌面启动检测到不安全或未完成的产品界面：${JSON.stringify(probe)}`)
  }
  log.info(
    `desktop renderer CSP startup verified manifest=${probe.manifestType}`
      + ` loader=${probe.loaderMode}`
      + ` inlineExecutableScripts=${String(probe.executableInlineScripts)}`
      + ' productUi=@gongchuang/client-ui bootPage=absent',
  )
}

function developmentPythonExecutable(): string {
  const developmentOverride = process.env.GONGCHUANG_DEVELOPMENT_PYTHON
  const candidates = [
    ...(developmentOverride === undefined || developmentOverride === '' ? [] : [developmentOverride]),
    '/usr/local/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/bin/python3',
  ]
  const candidate = candidates.find(path => existsSync(path))
  if (candidate === undefined) throw new Error('未找到洞见受控 Python 运行时')
  const info = lstatSync(candidate)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('洞见受控 Python 运行时不是普通文件')
  return candidate
}

function runtimePlatform(): 'darwin' | 'win32' {
  if (process.platform === 'darwin' || process.platform === 'win32') return process.platform
  throw new Error(`洞见桌面端不支持运行平台 ${process.platform}`)
}

function runtimeArch(): 'arm64' | 'x64' {
  if (process.arch === 'arm64' || process.arch === 'x64') return process.arch
  throw new Error(`洞见桌面端不支持处理器架构 ${process.arch}`)
}

async function startRuntime(
  skillBundle: string,
  verifiedSkills: VerifiedSkillSuite,
  runtimeBundle: string,
  policyPaths: Pick<ProductPaths, 'policyManifest' | 'policySignature' | 'policyPublicKey'>,
): Promise<string> {
  const bundledSkillDir = join(skillBundle, 'skills')
  if (!existsSync(bundledSkillDir) || !lstatSync(bundledSkillDir).isDirectory()) {
    throw new Error('洞见技能目录不存在')
  }

  let python: string | undefined
  let runtimeBinding: GongchuangSkillRuntimeBinding | undefined
  const runtimeIndexPath = join(runtimeBundle, 'runtime-index.json')
  if (existsSync(runtimeIndexPath)) {
    const verifiedRuntime = await verifyProductRuntimeForStartup(runtimeBundle, {
      expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.runtimePublicKeySha256,
      expectedSigningTier: PRODUCT_TRUST_ANCHORS.runtimeSigningTier,
      expectedPlatform: runtimePlatform(),
      expectedArch: runtimeArch(),
      expectedClientVersion: app.getVersion(),
    })
    if (verifiedRuntime.signingTier !== verifiedSkills.signingTier) {
      throw new Error('产品运行时与内置技能包版本层级不一致')
    }
    python = verifiedRuntime.pythonExecutable
    runtimeBinding = Object.freeze({
      skillsRoot: verifiedSkills.skillsRoot,
      skillBundleVersion: verifiedSkills.version,
      skillBundleIndexSha256: verifiedSkills.indexSha256,
      skillFileHashes: verifiedSkills.fileHashes,
      signingTier: verifiedSkills.signingTier,
      pythonExecutable: verifiedRuntime.pythonExecutable,
      pythonExecutableSha256: verifiedRuntime.pythonExecutableSha256,
      runtimeIntegrity: 'signed',
      runtimeIndexSha256: verifiedRuntime.indexSha256,
      paddleOcrMcpVersion: verifiedRuntime.paddleOcrMcpVersion,
    })
    log.info(`product runtime verified tier=${verifiedRuntime.signingTier} index=${verifiedRuntime.indexSha256}`)
    logStartupStage('runtime-verified')
  } else if (app.isPackaged) {
    throw new Error('客户端内置运行时不存在')
  }
  python ??= developmentPythonExecutable()
  if (runtimeBinding === undefined) throw new Error('洞见受签名专业运行时不存在')
  const searchExecutable = await resolveRgPath()
  const searchExecutableInfo = lstatSync(searchExecutable)
  if (!searchExecutableInfo.isFile() || searchExecutableInfo.isSymbolicLink()) {
    throw new Error('本地检索程序不可用')
  }
  log.info(`local search runtime ready path=${searchExecutable}`)
  const [launchEnvironment, profileBoot] = await Promise.all([
    import('@deepseek-ai/dsh-launch-environment'),
    import('@deepseek-ai/dsh/profile-boot'),
  ])
  logStartupStage('host-modules-loaded')
  process.env.DSH_HOME = join(app.getPath('userData'), 'runtime')
  process.env.GONGCHUANG_BUNDLED_SKILL_DIR = bundledSkillDir
  process.env.GONGCHUANG_SKILL_PLUGIN_ROOT = skillBundle
  process.env.GONGCHUANG_SKILL_MARKETPLACE_DIR = join(app.getPath('userData'), 'skill-marketplace')
  process.env.GONGCHUANG_DISABLED_SKILL_REGISTRY = join(app.getPath('userData'), 'skill-marketplace', 'registry.json')
  process.env.GONGCHUANG_AUTOMATION_DIR = join(app.getPath('userData'), 'automations')
  // The packaged Python tree is an immutable product resource.  Prevent
  // document/OCR subprocesses from adding __pycache__ files that would make
  // the next launch differ from the staged runtime file set.
  process.env.PYTHONDONTWRITEBYTECODE = '1'
  process.env.PYTHONNOUSERSITE = '1'
  process.env.PIP_REQUIRE_VIRTUALENV = '1'
  // Windows console and redirected pipes otherwise inherit the active OEM
  // code page. Pin Python text I/O to UTF-8 so Chinese script output remains
  // readable through the one-shot PowerShell executor as well as direct runs.
  process.env.PYTHONUTF8 = '1'
  process.env.PYTHONIOENCODING = 'utf-8'
  process.env.GONGCHUANG_NODE_EXECUTABLE = process.execPath
  process.env.GONGCHUANG_NODE_MODULES = join(app.getAppPath(), 'node_modules')
  process.env.NODE_PATH = process.env.GONGCHUANG_NODE_MODULES
  const artifactFont = app.isPackaged
    ? bundledArtifactFontPath(process.resourcesPath)
    : join(sourceRoot, 'apps', 'desktop', 'assets', 'fonts', 'NotoSansSC-Variable.ttf')
  const artifactRenderer = new DesktopArtifactRenderer(python, artifactFont)
  const desktopManifest = app.isPackaged
    ? join(app.getAppPath(), 'package.json')
    : join(sourceRoot, 'apps', 'desktop', 'package.json')
  const trustedPatches = createProductTrustedPatches(profileBoot.SHIPPED_PRESET_ROOT, {
    policyManifestPath: policyPaths.policyManifest,
    policySignaturePath: policyPaths.policySignature,
    policyPublicKeyPath: policyPaths.policyPublicKey,
    professionalContractsPath: join(runtimeBinding.skillsRoot, 'delivery-contracts.json'),
    skillCallGraphPath: join(runtimeBinding.skillsRoot, 'skill-call-graph.json'),
    professionalCheckpointDir: join(app.getPath('userData'), 'professional-tasks'),
    activeSkillBundleVersion: runtimeBinding.skillBundleVersion,
  })
  const options: RunProfileOptions = {
    environment: environmentSnapshot(launchEnvironment.createLaunchEnvironmentSnapshot),
    profile: 'web',
    patchFiles: [],
    trustedPatches,
    userLayers: false,
    args: [],
    setupHost: (ctx) => {
      ctx.logger.exporter(createHostRuntimeDiagnosticsExporter((level, line) => {
        if (level === 'error') log.error(line)
        else if (level === 'warn') log.warn(line)
        else log.info(line)
      }))
      ctx.provide('gongchuangSkillRuntimeBinding', runtimeBinding)
      ctx.provide('gongchuangArtifactRenderer', artifactRenderer)
    },
    ...(app.isPackaged
      ? { hostOwnedModuleBaseUrl: desktopManifest }
      : { hostOwnedModuleResolution: true }),
    // Electron owns app.quit/app.exit. The embedded Harness must not install a
    // second SIGTERM/SIGINT controller or its process.exit path can race the
    // native lifecycle and leave a translated macOS process half-closed.
    processSignalHandlers: false,
  }
  profileRuntime = await profileBoot.runProfile(options)
  logStartupStage('profile-ready')
  const webServer = profileRuntime.ctx.get('webServer')
  const connection = profileRuntime.ctx.get('connection')
  if (webServer === undefined || connection === undefined) {
    throw new Error('desktop runtime did not publish its authenticated loopback transport')
  }
  return desktopAuthenticatedLoopbackUrl(webServer, connection)
}

async function createMainWindow(url: string, icon: string): Promise<BrowserWindow> {
  const desktopSession = configureSession()
  const removedTransportCookies = await clearBrowserTransportCookies(desktopSession.cookies)
  if (removedTransportCookies > 0) {
    log.info(`desktop browser transport cookies cleared count=${String(removedTransportCookies)}`)
  }
  const displayVersion = `V${app.getVersion()}`
  const window = new BrowserWindow({
    title: `${PRODUCT_NAME} ${displayVersion}`,
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    show: false,
    backgroundColor: '#F7F3EA',
    icon,
    webPreferences: {
      session: desktopSession,
      preload: mainWindowPreload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  })
  const allowedOrigin = new URL(url).origin
  const workspaceRootStore = new DesktopWorkspaceRootStore({
    settingsFile: join(app.getPath('userData'), 'enterprise-workspace-root.json'),
    documentsDirectory: app.getPath('documents'),
    installationDirectories: [app.getAppPath(), process.resourcesPath, dirname(process.execPath)],
    protectedDirectories: [
      app.getPath('home'),
      app.getPath('documents'),
      app.getPath('desktop'),
      app.getPath('downloads'),
    ],
  })
  registerWorkspaceRootIpc({
    ipcMain,
    window,
    store: workspaceRootStore,
    showOpenDialog: (owner, options) => dialog.showOpenDialog(owner, options),
  })
  const professionalCheckpointStore = new ProfessionalTaskCheckpointStore(
    join(app.getPath('userData'), 'professional-tasks'),
  )
  ipcMain.handle(PROFESSIONAL_TASK_STATUS_CHANNEL, (event, sessionId: unknown) => {
    if (event.sender !== window.webContents) throw new Error('专业任务状态请求不属于当前主窗口')
    return professionalTaskUiStatus(professionalCheckpointStore, sessionId)
  })
  configureComposerDrafts(window)
  configureImageTransferConsents(window)
  const runtime = profileRuntime?.ctx as unknown as {
    readonly workspaceRegistry: {
      get(id: string): { readonly id: string; readonly path: string; readonly sessionIds: readonly string[] } | undefined
      list(): readonly { readonly id: string; readonly path: string }[]
      delete(id: string): Promise<boolean>
      deleteSession(id: string): Promise<void>
      restoreSession(id: string): Promise<void>
    }
    readonly sessionPersistence: {
      list(): Promise<readonly { readonly id: string; readonly cwd?: string }[]>
      locate(header: unknown): { readonly kind: string; readonly path: string } | undefined
    }
    readonly sessionController: {
      disposeSession(id: string): Promise<void>
      releaseSessionDisposal(id: string): void
    }
    readonly agents: { get(id: string): unknown }
    readonly sessions: {
      get(id: string): unknown
      list(): readonly { readonly id: string; readonly header: { readonly id: string; readonly cwd?: string } }[]
    }
  } | undefined
  if (runtime === undefined) throw new Error('企业空间删除服务无法连接到产品运行时')
  const enterpriseTrash = new EnterpriseTrashService({
    host: {
      workspace: workspaceId => runtime.workspaceRegistry.get(workspaceId),
      workspaces: async () => Promise.all(runtime.workspaceRegistry.list().map(async workspace => ({
        ...workspace,
        path: await workspaceRootStore.canonicalRegisteredEnterpriseDirectory(workspace.path),
      }))),
      assertWorkspaceDeletionSafe: workspace =>
        workspaceRootStore.assertDeletableEnterpriseDirectory(workspace.path),
      sessionHeaders: async () => {
        const headers = new Map(
          (await runtime.sessionPersistence.list()).map(header => [header.id, header]),
        )
        for (const session of runtime.sessions.list()) headers.set(session.id, session.header)
        return headers
      },
      sessionArtifactDirectory: (header) => {
        const location = runtime.sessionPersistence.locate(header)
        return location?.kind === 'jsonl' ? dirname(location.path) : undefined
      },
      quiesceSession: sessionId => runtime.sessionController.disposeSession(sessionId),
      releaseSessionDisposal: (sessionId) => {
        runtime.sessionController.releaseSessionDisposal(sessionId)
        return Promise.resolve()
      },
      hardDeleteWorkspace: workspaceId => runtime.workspaceRegistry.delete(workspaceId),
      markDeletedSession: sessionId => runtime.workspaceRegistry.deleteSession(sessionId),
      restoreDeletedSession: sessionId => runtime.workspaceRegistry.restoreSession(sessionId),
    },
    journal: new EnterpriseTrashJournal(join(app.getPath('userData'), 'enterprise-trash-pending.json')),
    trashItem: path => shell.trashItem(path),
    pathExists: async (path) => {
      try {
        await lstat(path)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
  })
  try {
    await enterpriseTrash.reconcilePending()
  } catch (error) {
    log.warn(`enterprise Trash reconciliation deferred: ${String(error)}`)
  }
  registerEnterpriseTrashIpc({
    ipcMain,
    window,
    service: enterpriseTrash,
    reportFailure: (operation, error) => {
      log.warn(`enterprise Trash ${operation} failed: ${gongchuangDiagnostic(error)}`)
    },
  })
  if (!app.isPackaged || acceptanceUserDataRoot !== undefined) {
    window.webContents.on('console-message', (details) => {
      if (details.level === 'warning' || details.level === 'error') {
        log.warn(`renderer ${details.level}: ${details.message} (${details.sourceId}:${String(details.lineNumber)})`)
      }
    })
  }
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== allowedOrigin) event.preventDefault()
  })
  window.webContents.on('did-start-loading', () => { windowsCloseRequests.cancelPending() })
  window.webContents.on('render-process-gone', () => { windowsCloseRequests.cancelPending() })
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    void openPublicExternal(target, async (url) => { await shell.openExternal(url) })
    return { action: 'deny' }
  })
  window.webContents.on('context-menu', (_event, params) => {
    const template = nativeContextMenuTemplate(params)
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window })
  })
  window.on('close', (event) => {
    if (process.platform === 'win32' && windowsCloseBehavior === 'ask' && !quitting) {
      event.preventDefault()
      requestWindowsCloseBehavior(window)
      return
    }
    if (process.platform === 'win32' && windowsCloseBehavior === 'quit' && !quitting) {
      event.preventDefault()
      app.quit()
      return
    }
    closeWindowToBackground(event, window, quitting)
  })
  window.once('ready-to-show', () => { window.show() })
  await window.loadURL(url)
  if (acceptanceUserDataRoot !== undefined || macUpdateLaunch?.status === 'attempting') {
    await verifyProductRendererStartup(window)
  }
  return window
}

async function configureUpdater(
  activeSkillVersion: string,
  skillUpdateRoot: string,
  paths: ProductPaths,
): Promise<void> {
  // This independent distribution has no published update feed yet. Never
  // contact or install another product's desktop or skill releases.
  const desktopUnavailable = () => ({
    status: 'unconfigured', currentVersion: app.getVersion(), latestVersion: null,
    message: '尚未配置洞见更新通道，请从下载页面获取新版本。',
  })
  const skillsUnavailable = () => ({
    status: 'error', currentVersion: activeSkillVersion, latestVersion: null,
    releaseNotes: null, message: '内置技能随洞见客户端更新。',
  })
  if (process.env.DONGJIAN_UPDATE_URL === undefined
    || process.env.DONGJIAN_MAC_UPDATE_MANIFEST_URL === undefined
    || process.env.DONGJIAN_SKILL_UPDATE_URL === undefined) {
    for (const channel of [UPDATE_CHECK_CHANNEL, UPDATE_DOWNLOAD_CHANNEL, UPDATE_INSTALL_CHANNEL]) {
      ipcMain.handle(channel, desktopUnavailable)
    }
    for (const channel of [SKILL_UPDATE_STATE_CHANNEL, SKILL_UPDATE_CHECK_CHANNEL, SKILL_UPDATE_DOWNLOAD_CHANNEL, SKILL_UPDATE_INSTALL_CHANNEL]) {
      ipcMain.handle(channel, skillsUnavailable)
    }
    return
  }
  const controller = process.platform === 'darwin' && app.isPackaged
    ? new MacSelfUpdaterController({
      architecture: runtimeArch(),
      currentAppPath: macApplicationPath(process.execPath),
      currentVersion: app.getVersion(),
      expectedManifestPublicKeySha256: PRODUCT_TRUST_ANCHORS.runtimePublicKeySha256,
      expectedSigningTier: PRODUCT_TRUST_ANCHORS.runtimeSigningTier,
      manifestPublicKeyPath: join(paths.runtimeBundle, 'runtime-index.pub.pem'),
      runtimeTrustAnchor: {
        expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.runtimePublicKeySha256,
        expectedSigningTier: PRODUCT_TRUST_ANCHORS.runtimeSigningTier,
        expectedPlatform: 'darwin',
        expectedArch: runtimeArch(),
        expectedClientVersion: app.getVersion(),
      },
      skillTrustAnchor: {
        expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.skillBundlePublicKeySha256,
        expectedSigningTier: PRODUCT_TRUST_ANCHORS.skillBundleSigningTier,
      },
      updateRoot: join(app.getPath('userData'), 'desktop-updates'),
      feedUrl: process.env.DONGJIAN_MAC_UPDATE_MANIFEST_URL,
      startInstallHelper: startMacUpdateInstallHelper,
      reportError: (error) => {
        log.error(`macOS desktop update failed: ${gongchuangDiagnostic(error)}`)
      },
      reportProgress: (progress) => {
        if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(UPDATE_PROGRESS_CHANNEL, progress)
        }
      },
      trashItem: async (path) => { await shell.trashItem(path) },
    })
    : await (async () => {
      const { default: updater } = await import('electron-updater')
      const { autoUpdater } = updater
      autoUpdater.logger = log
      return new DesktopUpdaterController(
        autoUpdater,
        app.getVersion(),
        desktopUpdateFeedUrl(process.env.DONGJIAN_UPDATE_URL),
      )
    })()
  const prepareDesktopInstall = async (): Promise<void> => {
    await disposeProfileRuntime()
    // The macOS helper must not exist until shutdown succeeds. Other platforms
    // hand off and exit inside electron-updater, so they still mark the close
    // as intentional before quitAndInstall runs.
    if (process.platform !== 'darwin' || !app.isPackaged) quitting = true
  }
  const exitAfterMacHelperStarts = (snapshot: DesktopUpdateSnapshot): DesktopUpdateSnapshot => {
    if (snapshot.status === 'downloaded' && process.platform === 'darwin' && app.isPackaged) {
      quitting = true
      app.exit(0)
    }
    return snapshot
  }
  const relaunchCurrentClient = (): void => {
    app.relaunch()
    quitting = true
    app.exit(0)
  }
  ipcMain.handle(UPDATE_CHECK_CHANNEL, () => controller.check())
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, () => controller.download())
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => (
    exitAfterMacHelperStarts(await runDesktopInstallHandoff(
      beforeInstall => controller.install(beforeInstall),
      prepareDesktopInstall,
      relaunchCurrentClient,
    ))
  ))
  const skillController = new SkillUpdaterController({
    updateRoot: skillUpdateRoot,
    activeVersion: activeSkillVersion,
    feedUrl: process.env.DONGJIAN_SKILL_UPDATE_URL,
    trustAnchor: {
      expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.skillBundlePublicKeySha256,
      expectedSigningTier: PRODUCT_TRUST_ANCHORS.skillBundleSigningTier,
    },
  })
  ipcMain.handle(SKILL_UPDATE_STATE_CHANNEL, () => skillController.current())
  ipcMain.handle(SKILL_UPDATE_CHECK_CHANNEL, () => skillController.check())
  ipcMain.handle(SKILL_UPDATE_DOWNLOAD_CHANNEL, () => skillController.download())
  ipcMain.handle(SKILL_UPDATE_INSTALL_CHANNEL, async () => {
    const snapshot = skillController.prepareInstall()
    if (snapshot.status === 'error') return snapshot
    try {
      await disposeProfileRuntime()
    } catch (error) {
      relaunchCurrentClient()
      throw error
    }
    app.relaunch()
    quitting = true
    app.exit(0)
    return snapshot
  })
}

async function startMacUpdateInstallHelper(
  jobPath: string,
  mode: 'install' | 'recovery' = 'install',
): Promise<void> {
  const helper = join(app.getAppPath(), 'dist', 'macos-update-helper.js')
  const child = spawn(process.execPath, [helper, jobPath], {
    detached: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GONGCHUANG_UPDATE_HELPER: '1' },
    stdio: 'ignore',
  })
  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.once('spawn', () => { resolvePromise() })
    child.once('error', rejectPromise)
  })
  if (child.pid === undefined) throw new Error('macOS 更新辅助程序未返回进程标识')
  const helperIdentity = macUpdateProcessIdentity(child.pid)
  if (helperIdentity === null) throw new Error('无法绑定 macOS 更新辅助程序进程身份')
  await waitForMacUpdateHelperHandoff(jobPath, child, helperIdentity, { mode })
}

function configureProfileAvatar(): void {
  const store = new DesktopAvatarStore(join(app.getPath('userData'), 'profile', 'avatar.json'))
  ipcMain.handle(AVATAR_READ_CHANNEL, () => store.read())
  ipcMain.handle(AVATAR_WRITE_CHANNEL, (_event, value: unknown) => store.write(value as string | null))
}

async function configureDesktopPreferences(): Promise<void> {
  const store = new DesktopPreferencesStore(join(app.getPath('userData'), 'desktop-preferences.json'))
  desktopPreferencesStore = store
  windowsCloseBehavior = (await store.read()).windowsCloseBehavior
  const assertSender = (event: Electron.IpcMainInvokeEvent): void => {
    if (mainWindow === undefined || event.sender !== mainWindow.webContents) {
      throw new Error('桌面偏好请求不属于当前主窗口')
    }
  }
  ipcMain.handle(DESKTOP_PREFERENCES_READ_CHANNEL, (event) => {
    assertSender(event)
    return windowsCloseBehavior
  })
  ipcMain.handle(DESKTOP_CLOSE_BEHAVIOR_WRITE_CHANNEL, async (event, value: unknown) => {
    assertSender(event)
    const saved = await store.writeWindowsCloseBehavior(value)
    windowsCloseBehavior = saved.windowsCloseBehavior
    return windowsCloseBehavior
  })
  ipcMain.handle(DESKTOP_CLOSE_RESPONSE_CHANNEL, async (event, requestId: unknown, decision: unknown, remember: unknown) => {
    assertSender(event)
    await windowsCloseRequests.respond(
      requestId,
      decision,
      remember,
      async (selected) => {
        if (desktopPreferencesStore === undefined) return
        try {
          windowsCloseBehavior = (await desktopPreferencesStore.writeWindowsCloseBehavior(selected)).windowsCloseBehavior
        } catch (error) {
          log.warn(`windows close preference could not be saved: ${gongchuangDiagnostic(error)}`)
        }
      },
      (selected) => {
        if (selected === 'tray') mainWindow?.hide()
        else if (selected === 'quit') app.quit()
      },
    )
  })
}

function configureImageTransferConsents(window: BrowserWindow): void {
  const store = new ImageTransferConsentStore(join(app.getPath('userData'), 'privacy', 'image-transfer-consents.v1.json'))
  const assertSender = (event: Electron.IpcMainInvokeEvent): void => {
    if (event.sender !== window.webContents) throw new Error('Image consent request is not from the main window')
  }
  ipcMain.handle(IMAGE_TRANSFER_CONSENTS_READ_CHANNEL, (event) => {
    assertSender(event)
    return store.read()
  })
  ipcMain.handle(IMAGE_TRANSFER_CONSENT_REMEMBER_CHANNEL, (event, provider: unknown) => {
    assertSender(event)
    return store.remember(provider)
  })
}

function configureComposerDrafts(window: BrowserWindow): void {
  const store = new ComposerDraftStore(join(app.getPath('userData'), 'composer', 'drafts.v1.json'))
  composerDraftStore = store
  const assertSender = (event: Electron.IpcMainInvokeEvent): void => {
    if (event.sender !== window.webContents) {
      throw new Error('待发送草稿请求不属于当前主窗口')
    }
  }
  ipcMain.handle(COMPOSER_DRAFT_READ_CHANNEL, (event, sessionId: unknown) => {
    assertSender(event)
    return store.read(sessionId)
  })
  ipcMain.handle(COMPOSER_DRAFT_WRITE_CHANNEL, (event, sessionId: unknown, value: unknown) => {
    assertSender(event)
    return store.write(sessionId, value)
  })
  ipcMain.handle(COMPOSER_DRAFT_CLEAR_CHANNEL, (event, sessionId: unknown) => {
    assertSender(event)
    return store.clear(sessionId)
  })
}

function requestWindowsCloseBehavior(window: BrowserWindow): void {
  const requestId = randomBytes(18).toString('base64url')
  if (!windowsCloseRequests.start(requestId)) return
  window.webContents.send(DESKTOP_CLOSE_REQUEST_CHANNEL, requestId)
}

function configureDocumentImport(): void {
  const directoryStore = new DocumentImportDirectoryStore(join(app.getPath('userData'), 'document-import', 'last-directory.json'))
  function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow {
    if (mainWindow === undefined || event.sender !== mainWindow.webContents) {
      throw new Error('添加文件请求不属于当前主窗口')
    }
    return mainWindow
  }
  function assertWorkspace(workspacePath: unknown): asserts workspacePath is string {
    if (typeof workspacePath !== 'string' || workspacePath.length === 0 || workspacePath.length > 4_096) {
      throw new Error('当前企业空间路径无效')
    }
  }
  ipcMain.handle(DOCUMENT_IMPORT_CHANNEL, async (event, workspacePath: unknown) => {
    const window = senderWindow(event)
    assertWorkspace(workspacePath)
    const defaultPath = await directoryStore.read()
    const selected = await dialog.showOpenDialog(window, {
      title: '为本次对话添加文件',
      buttonLabel: '添加文件',
      ...(defaultPath === undefined ? {} : { defaultPath }),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (selected.canceled) return []
    if (selected.filePaths[0] !== undefined) await directoryStore.remember(selected.filePaths[0])
    return importSelectedDocuments(workspacePath, selected.filePaths, path => shell.trashItem(path))
  })
  ipcMain.handle(DOCUMENT_DROP_IMPORT_CHANNEL, async (event, workspacePath: unknown, selectedPaths: unknown) => {
    senderWindow(event)
    assertWorkspace(workspacePath)
    if (!Array.isArray(selectedPaths) || !selectedPaths.every(path => typeof path === 'string' && path.length <= 4_096)) {
      throw new Error('拖入文件路径无效')
    }
    const paths = selectedPaths as string[]
    if (paths[0] !== undefined) await directoryStore.remember(paths[0])
    return importSelectedDocuments(workspacePath, paths, path => shell.trashItem(path))
  })
  ipcMain.handle(DOCUMENT_OPEN_CHANNEL, async (event, workspacePath: unknown, relativePath: unknown) => {
    senderWindow(event)
    assertWorkspace(workspacePath)
    if (typeof relativePath !== 'string') throw new Error('导入文件引用无效')
    const path = await importedDocumentPath(workspacePath, relativePath)
    const failure = await shell.openPath(path)
    if (failure !== '') throw new Error('无法使用系统默认应用打开文件')
  })
  ipcMain.handle(SESSION_ATTACHMENT_OPEN_CHANNEL, async (event, sessionId: unknown, attachment: unknown) => {
    senderWindow(event)
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) {
      throw new Error('附件所属对话无效')
    }
    if (typeof attachment !== 'object' || attachment === null) throw new Error('附件引用无效')
    const candidate = attachment as Partial<{ attachmentId: string; name: string; bytes: number }>
    if (
      typeof candidate.attachmentId !== 'string'
      || candidate.attachmentId.length === 0
      || candidate.attachmentId.length > 256
      || typeof candidate.name !== 'string'
      || candidate.name.length === 0
      || candidate.name.length > 255
      || typeof candidate.bytes !== 'number'
      || !Number.isSafeInteger(candidate.bytes)
      || candidate.bytes < 0
    ) throw new Error('附件引用无效')
    const runtime = profileRuntime
    if (runtime === undefined) throw new Error('客户端运行时尚未就绪')
    const sessionController = (runtime.ctx as unknown as {
      readonly sessionController?: {
        fileAttachmentPath(id: string, expected: FileAttachmentRef): Promise<string>
      }
    }).sessionController
    if (sessionController === undefined) throw new Error('客户端会话服务尚未就绪')
    const expected: FileAttachmentRef = {
      attachmentId: candidate.attachmentId as FileAttachmentRef['attachmentId'],
      name: candidate.name,
      bytes: candidate.bytes,
    }
    const path = await sessionController.fileAttachmentPath(sessionId, expected)
    const failure = await shell.openPath(path)
    if (failure !== '') throw new Error('无法使用系统默认应用打开附件')
  })
}

async function launch(): Promise<void> {
  if (macUpdateLaunch?.stateProjectionError !== undefined) {
    log.warn(`macOS update state reconciliation failed: ${gongchuangDiagnostic(macUpdateLaunch.stateProjectionError)}`)
  }
  if (macUpdateLaunch?.status === 'restoring') {
    await startMacUpdateInstallHelper(macUpdateLaunch.jobPath, 'recovery')
    throw new Error('macOS 更新正在恢复上一个可用版本')
  }
  configureWindowsApplicationMenu()
  const paths = productPaths()
  const { icon, trayIcon, skillBundle, runtimeBundle } = paths
  startupWindow = await createWindowsStartupWindow(icon)
  const skillUpdateRoot = join(app.getPath('userData'), 'skill-updates')
  const skillSelection = resolveSkillBundleForLaunch(skillBundle, skillUpdateRoot, {
    expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.skillBundlePublicKeySha256,
    expectedSigningTier: PRODUCT_TRUST_ANCHORS.skillBundleSigningTier,
  })
  log.info(
    `skill suite verified version=${skillSelection.verified.version}`
      + ` tier=${skillSelection.verified.signingTier}`
      + ` skills=${String(skillSelection.verified.skillCount)}`
      + ` files=${String(skillSelection.verified.fileCount)}`,
  )
  logStartupStage('skills-verified')
  // Packaged macOS builds already use the size-aware .icns asset. Replacing it
  // with the raw 1024px PNG after launch makes the active Dock tile appear
  // larger than the inactive application icon. Development builds still need
  // the explicit product icon because Electron otherwise shows its own mark.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(icon)
  const url = await startRuntime(skillSelection.path, skillSelection.verified, runtimeBundle, paths)
  commitSkillBundleLaunch(skillUpdateRoot, skillSelection)
  try {
    await trashReconciledSkillUpdateStaging(
      skillUpdateRoot,
      skillSelection.verified.version,
      path => shell.trashItem(path),
    )
  } catch (error) {
    log.warn(`completed skill update staging cleanup failed: ${gongchuangDiagnostic(error)}`)
  }
  await configureUpdater(skillSelection.verified.version, skillUpdateRoot, paths)
  configureProfileAvatar()
  await configureDesktopPreferences()
  mainWindow = await createMainWindow(url, icon)
  flushPendingDeepLink()
  logStartupStage('window-loaded')
  startupWindow?.destroy()
  startupWindow = undefined
  appTray = new Tray(createTrayImage(trayIcon))
  appTray.setToolTip(PRODUCT_NAME)
  appTray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '打开窗口',
      click: () => {
        restoreWindowFromBackground(mainWindow)
      },
    },
    { type: 'separator' },
    {
      label: '退出应用',
      click: () => {
        app.quit()
      },
    },
  ]))
  appTray.on('click', () => {
    restoreWindowFromBackground(mainWindow)
  })
  configureDocumentImport()
  configureFileActions(() => mainWindow)
  if (process.platform === 'darwin' && app.isPackaged) {
    const committedUpdate = macUpdateLaunch?.status === 'attempting'
      ? commitMacUpdateLaunch(macUpdateLaunch)
      : macUpdateLaunch?.status === 'committed'
        ? { cleanupPaths: macUpdateLaunch.cleanupPaths, stateProjectionError: macUpdateLaunch.stateProjectionError }
        : null
    if (committedUpdate?.stateProjectionError !== undefined) {
      log.warn(`macOS update committed with stale diagnostic state: ${gongchuangDiagnostic(committedUpdate.stateProjectionError)}`)
    }
    if (committedUpdate !== null) {
      for (const path of committedUpdate.cleanupPaths) {
        if (!existsSync(path)) continue
        try {
          await shell.trashItem(path)
        } catch (error) {
          log.warn(`committed update residue could not be moved to Trash: ${gongchuangDiagnostic(error)}`)
        }
      }
    }
  }
  log.info(`desktop main window ready title=${PRODUCT_NAME} V${app.getVersion()}`)
  logStartupStage('ready')
  if (process.platform === 'darwin' && app.isPackaged) {
    const updateRoot = join(app.getPath('userData'), 'desktop-updates')
    for (const path of macUpdateTerminalCleanupPaths(
      updateRoot, macApplicationPath(process.execPath), app.getVersion(),
    )) {
      if (!existsSync(path)) continue
      try {
        await shell.trashItem(path)
      } catch (error) {
        log.warn(`terminal macOS update residue could not be moved to Trash: ${gongchuangDiagnostic(error)}`)
      }
    }
  }
}

async function recoverMacUpdateAfterStartupFailure(error: unknown): Promise<void> {
  if (macUpdateLaunch?.status === 'attempting') {
    try {
      const recovery = beginMacUpdateRecovery(
        macUpdateLaunch,
        error instanceof Error ? error.message : String(error),
      )
      if (recovery.stateProjectionError !== undefined) {
        log.warn(`macOS update recovery claimed with stale diagnostic state: ${gongchuangDiagnostic(recovery.stateProjectionError)}`)
      }
      await startMacUpdateInstallHelper(recovery.jobPath, 'recovery')
    } catch (recoveryError) {
      log.error(`macOS update recovery helper failed: ${gongchuangDiagnostic(recoveryError)}`)
    }
  }
  failClosedAfterStartupError(error)
}

const acceptanceUserDataRoot = resolveAcceptanceUserDataRoot()
if (acceptanceUserDataRoot !== undefined) {
  const isolatedAppData = join(acceptanceUserDataRoot, 'Library', 'Application Support')
  mkdirSync(isolatedAppData, { recursive: true, mode: 0o700 })
  app.setPath('appData', isolatedAppData)
  log.transports.file.resolvePathFn = () => join(
    acceptanceUserDataRoot,
    'Library',
    'Logs',
    PRODUCT_NAME,
    'main.log',
  )
}
app.setName(PRODUCT_NAME)
app.setPath('userData', join(app.getPath('appData'), PRODUCT_NAME))
app.setAppUserModelId(PRODUCT_ID)
const ownsInstanceLock = app.requestSingleInstanceLock()
const macUpdateLaunch = ownsInstanceLock && process.platform === 'darwin' && app.isPackaged
  ? beginMacUpdateLaunch(
    join(app.getPath('userData'), 'desktop-updates'),
    app.getVersion(),
    macApplicationPath(process.execPath),
  )
  : null
if (!ownsInstanceLock) app.quit()
else {
  log.transports.file.maxSize = DESKTOP_LOG_MAX_BYTES
  const archiveLog = log.transports.file.archiveLogFn
  const logFile = log.transports.file.getFile()
  ensureUtf8LogFile(logFile.path)
  log.transports.file.archiveLogFn = (file) => {
    archiveLog(file)
    ensureUtf8LogFile(file.path)
  }
  log.info(`desktop main ready product=${PRODUCT_ID} client=${app.getVersion()} packaged=${String(app.isPackaged)}`)
  const registered = process.defaultApp && process.argv[1] !== undefined
    ? app.setAsDefaultProtocolClient(GONGCHUANG_PROTOCOL, process.execPath, [resolve(process.argv[1])])
    : app.setAsDefaultProtocolClient(GONGCHUANG_PROTOCOL)
  if (!registered) log.warn(`desktop protocol registration failed scheme=${GONGCHUANG_PROTOCOL}`)
  const initialSession = sessionDeepLinkFromArgv(process.argv)
  if (initialSession !== undefined) pendingDeepLinkedSession = initialSession
}

app.on('second-instance', (_event, argv) => {
  const sessionId = sessionDeepLinkFromArgv(argv)
  if (sessionId !== undefined) acceptSessionDeepLink(`dongjian://threads/${sessionId}`)
  else revealMainWindow()
})

app.on('open-url', (event, url) => {
  event.preventDefault()
  if (!acceptSessionDeepLink(url)) log.warn('desktop ignored malformed product deep link')
})

app.on('activate', () => {
  revealMainWindow()
})

app.on('before-quit', (event) => {
  if (quitting) return
  if (profileRuntime === undefined) return
  event.preventDefault()
  beginDesktopHostShutdown(0)
})

app.on('will-quit', () => {
  appTray?.destroy()
  appTray = undefined
})
process.on('SIGTERM', () => { beginDesktopHostShutdown(0) })
process.on('SIGINT', () => { beginDesktopHostShutdown(130) })

if (ownsInstanceLock) void app.whenReady().then(launch).catch(recoverMacUpdateAfterStartupFailure)
