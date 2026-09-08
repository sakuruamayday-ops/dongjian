import { lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const ACCEPTANCE_MODE_ENV = 'GONGCHUANG_ACCEPTANCE_MODE'
export const ACCEPTANCE_ROOT_ENV = 'GONGCHUANG_ACCEPTANCE_USER_DATA_ROOT'

const SENSITIVE_ENVIRONMENT_NAME = /(?:token|secret|password|passwd|api_?key|access_?key|private_?key|credential|auth|cookie|session)/iu
const SENSITIVE_ENVIRONMENT_VALUE = /^(?:sk-|jtk_)/u

function isStrictDescendant(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`)
    && !isAbsolute(path)
}

/**
 * Resolve the isolated macOS acceptance root before Electron fixes appData.
 *
 * The override is deliberately unavailable during ordinary launches. A test
 * root must already exist, be owned by the current user, have no group/world
 * permissions, and sit below the current user's OS temporary directory.
 */
export function resolveAcceptanceUserDataRoot(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  systemTempDirectory: string = tmpdir(),
): string | undefined {
  const enabled = environment[ACCEPTANCE_MODE_ENV]
  const requested = environment[ACCEPTANCE_ROOT_ENV]?.trim()
  if (enabled !== '1') {
    if (requested !== undefined && requested !== '') {
      throw new Error(`${ACCEPTANCE_ROOT_ENV} 只能在显式验收模式下使用`)
    }
    return undefined
  }
  if (platform !== 'darwin') throw new Error('隔离的 macOS 验收数据根目录只能在 macOS 使用')
  if (requested === undefined || requested === '' || !isAbsolute(requested)) {
    throw new Error('macOS 验收数据根目录必须是已存在的绝对路径')
  }

  const requestedInfo = lstatSync(resolve(requested))
  if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) {
    throw new Error('macOS 验收数据根目录必须是非符号链接目录')
  }
  const canonicalTemp = realpathSync(systemTempDirectory)
  const canonicalRoot = realpathSync(resolve(requested))
  if (!isStrictDescendant(canonicalTemp, canonicalRoot)) {
    throw new Error('macOS 验收数据根目录必须位于当前用户临时目录内')
  }
  const info = lstatSync(canonicalRoot)
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (currentUid === undefined || info.uid !== currentUid) {
    throw new Error('macOS 验收数据根目录不属于当前用户')
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error('macOS 验收数据根目录权限必须为 0700')
  }
  return canonicalRoot
}

/**
 * Remove inherited credentials from an isolated lifecycle-acceptance launch.
 * The real macOS HOME must remain intact so Keychain can resolve the logged-in
 * user's keyring; all application data is isolated separately through appData.
 */
export function sanitizeAcceptanceLaunchEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => {
      const [name, value] = entry
      return value !== undefined
        && !SENSITIVE_ENVIRONMENT_NAME.test(name)
        && !SENSITIVE_ENVIRONMENT_VALUE.test(value)
    }),
  )
}
