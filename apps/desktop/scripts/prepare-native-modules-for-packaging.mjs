import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ELECTRON_REBUILD_METADATA = '.forge-meta'

/**
 * Node 单测会用本机 Node ABI 覆写原生模块，但 @electron/rebuild 不会同步清除
 * `.forge-meta`。旧元数据会让打包器误判 Electron ABI 已完成，最终生成无法启动
 * 会话运行时的应用。打包前把元数据移入审计目录，强制按目标 ABI 重新编译；
 * afterPack 仍会用最终 Electron 可执行文件真实加载模块，不能绕过。
 */
export function quarantineElectronRebuildMetadata({ workspaceRoot, platform, arch }, now = Date.now) {
  const pnpmStore = join(workspaceRoot, 'node_modules', '.pnpm')
  if (!existsSync(pnpmStore)) return []

  const candidates = readdirSync(pnpmStore, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('fs-ext@'))
    .map(entry => ({
      name: entry.name,
      source: join(
        pnpmStore,
        entry.name,
        'node_modules',
        'fs-ext',
        'build',
        'Release',
        ELECTRON_REBUILD_METADATA,
      ),
    }))
    .filter(candidate => existsSync(candidate.source))

  if (candidates.length === 0) return []

  const quarantineRoot = join(
    workspaceRoot,
    '.build',
    'electron-rebuild-metadata-quarantine',
    `${now()}-${process.pid}-${platform}-${arch}`,
  )
  mkdirSync(quarantineRoot, { recursive: true })

  return candidates.map(candidate => {
    const destination = join(quarantineRoot, `${candidate.name}.forge-meta`)
    renameSync(candidate.source, destination)
    return destination
  })
}

export default async function prepareNativeModulesForPackaging(context) {
  const workspaceRoot = resolve(import.meta.dirname, '../../..')
  const quarantined = quarantineElectronRebuildMetadata({
    workspaceRoot,
    platform: context.platform,
    arch: context.arch,
  })
  if (quarantined.length > 0) {
    console.log(`Quarantined stale Electron rebuild metadata: ${quarantined.join(', ')}`)
  }
  return true
}
