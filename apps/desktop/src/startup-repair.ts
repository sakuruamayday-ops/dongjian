/** Public repair-installer selection available before the product runtime mounts. */

const REPAIR_BASE_URL = 'https://zshjiaotang.cn/client-updates/v0.2/repair/'

/**
 * Resolve the stable current-release installer used after startup integrity failure.
 * @param platform - Packaged desktop platform.
 * @param arch - Packaged desktop architecture.
 * @returns Public route that resolves only to the current verified full installer.
 */
export function startupRepairUrl(
  platform: 'darwin' | 'win32',
  arch: 'arm64' | 'x64',
): string {
  const os = platform === 'win32' ? 'windows' : 'macos'
  return new URL(`${os}/${arch}`, REPAIR_BASE_URL).href
}
