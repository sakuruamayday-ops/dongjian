import { join } from 'node:path'

/** Resolve the only runtime bundles supported by the current desktop product. */
export function runtimeBundleSlot(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'darwin' && arch === 'arm64') return 'product-runtime-mac-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'product-runtime-mac-x64'
  if (platform === 'win32' && arch === 'x64') return 'product-runtime-win-x64'
  throw new Error(`共创客户端不支持此运行时目标：${platform}/${arch}`)
}

/** Keep development and packaging inputs separated so one target cannot overwrite the other. */
export function developmentRuntimeBundleDirectory(
  buildRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  return join(buildRoot, runtimeBundleSlot(platform, arch))
}
