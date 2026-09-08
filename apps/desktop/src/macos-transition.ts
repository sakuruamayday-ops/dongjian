/** One-time, user-started V0.1.4 to V0.2.0 macOS transition application. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, shell } from 'electron'
import {
  DEFAULT_MACOS_SELF_UPDATE_MANIFEST_URL,
  MacSelfUpdaterController,
  verifyMacTransitionSource,
} from './macos-self-updater.ts'
import { PRODUCT_TRUST_ANCHORS } from '../../../product/gongchuang-client/src/trust-anchors.ts'

const PRODUCT_NAME = '洞见'
const SOURCE_VERSION = '0.1.4'
const TARGET_VERSION = '0.2.0'
const DEFAULT_APPLICATION_PATH = `/Applications/${PRODUCT_NAME}.app`

async function selectSourceApplication(): Promise<string | null> {
  if (existsSync(DEFAULT_APPLICATION_PATH)) return DEFAULT_APPLICATION_PATH
  const selected = await dialog.showOpenDialog({
    title: `选择已安装的${PRODUCT_NAME} V${SOURCE_VERSION}`,
    buttonLabel: '选择应用',
    properties: ['openFile'],
    filters: [{ name: 'macOS 应用', extensions: ['app'] }],
  })
  return selected.canceled ? null : selected.filePaths[0] ?? null
}

async function startInstallHelper(jobPath: string): Promise<void> {
  const helper = join(app.getAppPath(), 'dist', 'macos-update-helper.js')
  const child = spawn(process.execPath, [helper, jobPath], {
    detached: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GONGCHUANG_UPDATE_HELPER: '1' },
    stdio: 'ignore',
  })
  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.once('spawn', resolvePromise)
    child.once('error', rejectPromise)
  })
  child.unref()
}

async function runTransition(): Promise<void> {
  const sourceAppPath = await selectSourceApplication()
  if (sourceAppPath === null) return
  let architecture: 'arm64' | 'x64'
  try {
    architecture = await verifyMacTransitionSource(sourceAppPath, SOURCE_VERSION)
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: '无法开始过渡安装',
      message: error instanceof Error ? error.message : '所选应用无法验证',
      detail: '未改动现有应用、用户数据或系统凭据。',
    })
    return
  }
  const approved = await dialog.showMessageBox({
    type: 'question',
    buttons: ['验证并安装 V0.2.0', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: `${PRODUCT_NAME} V0.2.0 过渡安装`,
    message: `已验证本机 ${architecture} V${SOURCE_VERSION} 应用。`,
    detail: '安装程序将验证签名清单、归档、应用身份以及包内运行时和技能；新版本未完成启动提交时自动恢复旧应用。企业空间、会话和系统凭据不会被移动或删除。',
  })
  if (approved.response !== 0) return
  const resources = join(process.resourcesPath, 'product')
  const updateRoot = join(app.getPath('userData'), 'desktop-updates')
  const controller = new MacSelfUpdaterController({
    architecture,
    currentAppPath: sourceAppPath,
    currentVersion: SOURCE_VERSION,
    requiredTargetVersion: TARGET_VERSION,
    expectedManifestPublicKeySha256: PRODUCT_TRUST_ANCHORS.runtimePublicKeySha256,
    expectedSigningTier: PRODUCT_TRUST_ANCHORS.runtimeSigningTier,
    manifestPublicKeyPath: join(resources, 'runtime', 'runtime-index.pub.pem'),
    runtimeTrustAnchor: {
      expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.runtimePublicKeySha256,
      expectedSigningTier: PRODUCT_TRUST_ANCHORS.runtimeSigningTier,
      expectedPlatform: 'darwin',
      expectedArch: architecture,
      expectedClientVersion: SOURCE_VERSION,
    },
    skillTrustAnchor: {
      expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.skillBundlePublicKeySha256,
      expectedSigningTier: PRODUCT_TRUST_ANCHORS.skillBundleSigningTier,
    },
    updateRoot,
    feedUrl: process.env.GONGCHUANG_MAC_TRANSITION_MANIFEST_URL ?? DEFAULT_MACOS_SELF_UPDATE_MANIFEST_URL,
    startInstallHelper,
    trashItem: async (path) => { await shell.trashItem(path) },
  })
  const checked = await controller.check()
  if (checked.status !== 'available' || checked.latestVersion !== TARGET_VERSION) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'V0.2.0 过渡包不可用',
      message: checked.message,
      detail: '未改动现有应用、用户数据或系统凭据。请从受控门户重新下载安装程序后再试。',
    })
    return
  }
  const downloaded = await controller.download()
  const installed = downloaded.status === 'downloaded' ? await controller.install() : downloaded
  if (installed.status === 'downloaded') app.exit(0)
  if (installed.status === 'error') {
    await dialog.showMessageBox({
      type: 'error',
      title: 'V0.2.0 过渡安装未完成',
      message: installed.message,
      detail: '验证或暂存失败，现有 V0.1.4 应用保持不变。',
    })
  }
}

app.setName(`${PRODUCT_NAME} V0.2.0 过渡安装程序`)
app.setPath('userData', join(app.getPath('appData'), PRODUCT_NAME))
const ownsProductLock = app.requestSingleInstanceLock()
if (!ownsProductLock) {
  void app.whenReady().then(async () => {
    await dialog.showMessageBox({
      type: 'warning',
      title: '请先退出洞见',
      message: 'V0.1.4 仍在运行。请从菜单栏图标选择“退出应用”，再重新打开过渡安装程序。',
    })
    app.exit(1)
  })
} else {
  void app.whenReady().then(runTransition).then(() => { app.quit() }).catch(async (error: unknown) => {
    await dialog.showMessageBox({
      type: 'error',
      title: '过渡安装程序未完成',
      message: error instanceof Error ? error.message : '发生未知错误',
      detail: '现有应用、用户数据和系统凭据均未被主动删除。',
    })
    app.exit(1)
  })
}
