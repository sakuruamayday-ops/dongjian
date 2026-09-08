/** Controlled user messages and redacted diagnostics for 共创企业助手. */

/** Product surfaces that translate failures for users. */
export type GongchuangErrorArea = 'startup' | 'account' | 'model' | 'product'

/** Product operations whose recovery advice is safe to expose in the renderer. */
export type GongchuangProductErrorAction =
  | 'account'
  | 'archive'
  | 'avatar'
  | 'memory'
  | 'navigation'
  | 'personalization'
  | 'region'
  | 'workspace'
  | 'generic'

/** A controlled message safe to render or return through a client Remote. */
export interface GongchuangUserError {
  readonly code: string
  readonly message: string
  readonly text: string
}

const PRODUCT_MESSAGES: Readonly<Record<GongchuangProductErrorAction, readonly [string, string]>> = {
  account: ['GC-UI-ACCOUNT', '账号操作未完成，请检查网络后重试'],
  archive: ['GC-UI-ARCHIVE', '归档操作未完成，请稍后重试'],
  avatar: ['GC-UI-AVATAR', '头像操作未完成，请换一张图片后重试'],
  memory: ['GC-UI-MEMORY', '记忆设置未能应用，请稍后重试'],
  navigation: ['GC-UI-NAVIGATION', '对话操作未完成，请稍后重试'],
  personalization: ['GC-UI-PERSONALIZATION', '个性化设置未能保存，请检查内容后重试'],
  region: ['GC-UI-REGION', '地区设置未能保存，请稍后重试'],
  workspace: ['GC-UI-WORKSPACE', '企业空间操作未完成，请检查目录权限后重试'],
  generic: ['GC-UI-UNKNOWN', '操作未完成，请稍后重试'],
}

const WORKSPACE_MESSAGES = {
  config: '企业空间保存位置未能写入客户端设置，请重新打开客户端后重试',
  directory: '所选位置不是可用目录，请重新选择',
  permission: '客户端无法读写所选目录，请在系统设置中允许文件访问后重试',
} as const

const MODEL_KEYCHAIN_MESSAGE = '系统凭据暂不可用，请允许系统访问后重试'

const KNOWN_MESSAGES: Readonly<Record<string, string>> = {
  'GC-STARTUP-001': '客户端服务未能完整启动，请重新打开客户端；如问题持续，请联系支持',
  'GC-ACCOUNT-AUTH': '账号或密码无效，请重新输入',
  'GC-ACCOUNT-DEVICE': '账号已在另一台设备登录，请重新登录本机',
  'GC-ACCOUNT-SERVER': '客户端登录服务尚未开放，请联系管理员',
  'GC-ACCOUNT-KEYCHAIN': '无法访问系统凭据库，请检查系统权限后重试',
  'GC-ACCOUNT-TIMEOUT': '连接共创服务器超时，请稍后重试',
  'GC-ACCOUNT-NETWORK': '暂时无法连接共创服务器，请检查网络后重试',
  'GC-ACCOUNT-UNKNOWN': '账号操作未完成，请稍后重试',
  'GC-MODEL-AUTH': 'API Key 无效或无权访问，请检查后重试',
  'GC-MODEL-KEYCHAIN': MODEL_KEYCHAIN_MESSAGE,
  'GC-MODEL-BALANCE': '模型服务余额不足，请充值后重试',
  'GC-MODEL-UNAVAILABLE': '所选模型当前不可用，请选择其他模型或稍后重试',
  'GC-MODEL-TIMEOUT': '模型服务连接超时，请稍后重试',
  'GC-MODEL-NETWORK': '无法连接模型服务，请检查网络与 API 地址',
  'GC-MODEL-UNKNOWN': '模型连接未能完成，请检查配置后重试',
  'GC-UI-WORKSPACE-CONFIG': WORKSPACE_MESSAGES.config,
  'GC-UI-WORKSPACE-DIRECTORY': WORKSPACE_MESSAGES.directory,
  'GC-UI-WORKSPACE-PERMISSION': WORKSPACE_MESSAGES.permission,
  ...Object.fromEntries(Object.values(PRODUCT_MESSAGES)),
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : ''
}

function numericStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined
  const status = (error as { readonly status?: unknown }).status
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined
}

function controlled(code: string, message: string): GongchuangUserError {
  return Object.freeze({ code, message, text: `${message}（诊断码：${code}）` })
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some(needle => value.includes(needle))
}

/**
 * Translate an arbitrary failure into a controlled Chinese message.
 * Classification may inspect the failure, but never copies its text, stack or
 * cause into the returned value.
 *
 * @param error Failure received at a user-visible operation.
 * @param area Product surface that owns the recovery action.
 * @param action Product-shell operation when `area` is `product`.
 * @returns A safe message with a stable diagnostic code.
 */
export function gongchuangUserError(
  error: unknown,
  area: GongchuangErrorArea,
  action: GongchuangProductErrorAction = 'generic',
): GongchuangUserError {
  const value = errorText(error).toLowerCase()
  const existingCode = errorText(error).match(/诊断码：(GC-[A-Z0-9-]+)/u)?.[1]
  const existingMessage = existingCode === undefined ? undefined : KNOWN_MESSAGES[existingCode]
  if (existingCode !== undefined && existingMessage !== undefined) return controlled(existingCode, existingMessage)
  const status = numericStatus(error)
  const timeout = error instanceof Error && error.name === 'TimeoutError'
    || includesAny(value, ['timeout', 'timed out', '超时'])
  const network = error instanceof TypeError
    || includesAny(value, ['fetch failed', 'network', 'econn', 'enotfound', '网络'])

  if (area === 'startup') {
    return controlled('GC-STARTUP-001', '客户端服务未能完整启动，请重新打开客户端；如问题持续，请联系支持')
  }
  if (area === 'account') {
    if (status === 401 || includesAny(value, ['unauthorized', '密码已失效', '账号或密码'])) {
      return controlled('GC-ACCOUNT-AUTH', '账号或密码无效，请重新输入')
    }
    if (status === 409) return controlled('GC-ACCOUNT-DEVICE', '账号已在另一台设备登录，请重新登录本机')
    if (status === 404) return controlled('GC-ACCOUNT-SERVER', '客户端登录服务尚未开放，请联系管理员')
    if (includesAny(value, ['keychain', 'credential', '凭据库', '钥匙串'])) {
      return controlled('GC-ACCOUNT-KEYCHAIN', '无法访问系统凭据库，请检查系统权限后重试')
    }
    if (timeout) return controlled('GC-ACCOUNT-TIMEOUT', '连接共创服务器超时，请稍后重试')
    if (network) return controlled('GC-ACCOUNT-NETWORK', '暂时无法连接共创服务器，请检查网络后重试')
    return controlled('GC-ACCOUNT-UNKNOWN', '账号操作未完成，请稍后重试')
  }
  if (area === 'model') {
    if (includesAny(value, ['keychain', '凭据库', '钥匙串'])) {
      return controlled('GC-MODEL-KEYCHAIN', MODEL_KEYCHAIN_MESSAGE)
    }
    if (status === 401 || status === 403
      || includesAny(value, ['http 401', 'http 403', 'unauthorized', 'forbidden', 'invalid api key', 'api key 无效', '鉴权'])) {
      return controlled('GC-MODEL-AUTH', 'API Key 无效或无权访问，请检查后重试')
    }
    if (status === 402 || includesAny(value, ['http 402', 'insufficient balance', 'insufficient credit', '余额不足', '欠费'])) {
      return controlled('GC-MODEL-BALANCE', '模型服务余额不足，请充值后重试')
    }
    if (status === 404 || includesAny(value, ['http 404', 'model not found', '模型不可用', '模型目录中未找到'])) {
      return controlled('GC-MODEL-UNAVAILABLE', '所选模型当前不可用，请选择其他模型或稍后重试')
    }
    if (timeout) return controlled('GC-MODEL-TIMEOUT', '模型服务连接超时，请稍后重试')
    if (network) return controlled('GC-MODEL-NETWORK', '无法连接模型服务，请检查网络与 API 地址')
    return controlled('GC-MODEL-UNKNOWN', '模型连接未能完成，请检查配置后重试')
  }
  if (action === 'workspace') {
    if (includesAny(value, ['配置无法写入', 'workspace-root.json'])) {
      return controlled('GC-UI-WORKSPACE-CONFIG', WORKSPACE_MESSAGES.config)
    }
    if (includesAny(value, ['不可读写', 'eacces', 'eperm', 'permission denied', 'access denied'])) {
      return controlled('GC-UI-WORKSPACE-PERMISSION', WORKSPACE_MESSAGES.permission)
    }
    if (includesAny(value, ['必须是目录', '必须是绝对路径', 'enoent', 'not a directory', '安装目录'])) {
      return controlled('GC-UI-WORKSPACE-DIRECTORY', WORKSPACE_MESSAGES.directory)
    }
  }
  const [code, message] = PRODUCT_MESSAGES[action]
  return controlled(code, message)
}

function describeDiagnostic(error: unknown, depth = 0): string {
  if (depth > 6) return '[cause-depth-exceeded]'
  if (error instanceof AggregateError) {
    return `${error.name}: ${error.message}\n${Array.from(error.errors as Iterable<unknown>)
      .map(item => describeDiagnostic(item, depth + 1)).join('\n')}`
  }
  if (error instanceof Error) {
    const cause = error.cause === undefined ? '' : `\nCaused by: ${describeDiagnostic(error.cause, depth + 1)}`
    return `${error.name}: ${error.message}\n${error.stack ?? ''}${cause}`
  }
  return String(error)
}

/**
 * Render technical diagnostics for existing logs while removing common local
 * paths, credentials, authorization headers and secret-bearing query values.
 *
 * @param error Failure recorded in a trusted local log.
 * @returns Redacted diagnostic text that is never intended for product UI.
 */
export function gongchuangDiagnostic(error: unknown): string {
  return describeDiagnostic(error)
    .replace(/\b(?:sk|jtk)_[a-z0-9_-]{8,}\b/gi, '[redacted-credential]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '[redacted-credential]')
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[redacted-credential]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/file:\/\/\/[A-Za-z]:\/[^\s)]+/g, 'file:///[local-path]')
    .replace(/file:\/\/\/[^\s)]+/g, 'file:///[local-path]')
    .replace(/\b[a-z]:\\(?:Users|Documents and Settings)\\[^\r\n:]+/gi, '[local-path]')
    .replace(/\/(?:Users|home|private|var\/folders)\/[^\r\n: )]+/g, '[local-path]')
}
