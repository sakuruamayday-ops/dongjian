/** Broad filesystem locations that cannot safely represent one enterprise. */
const BROAD_LEAF_NAMES = new Set(['desktop', 'documents', 'downloads', '桌面', '文稿', '下载'])

/**
 * Client-side admission check for enterprise spaces.
 *
 * This intentionally mirrors the host search guard without importing Node-only
 * path helpers into the renderer bundle. It rejects filesystem roots, user
 * homes, and the common Desktop/Documents/Downloads roots on macOS, Linux and
 * Windows. A concrete child directory remains valid.
 * @param path - User-selected workspace path.
 * @returns Whether the path is sufficiently concrete for one enterprise.
 */
export function isConcreteEnterpriseWorkspacePath(path: string): boolean {
  const normalized = path.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  if (normalized === '' || normalized === '/' || /^[A-Za-z]:$/.test(normalized)) return false
  const parts = normalized.split('/').filter(Boolean)
  const leaf = parts.at(-1)
  if (leaf === undefined || BROAD_LEAF_NAMES.has(leaf.toLowerCase())) return false
  if (parts.length === 2 && (parts[0]?.toLowerCase() === 'users' || parts[0]?.toLowerCase() === 'home')) return false
  const first = parts[0]
  if (parts.length === 3 && first !== undefined && /^[A-Za-z]:$/.test(first) && parts[1]?.toLowerCase() === 'users') return false
  return true
}

/** Actionable product-facing message shared by creation and automation. */
export const CONCRETE_ENTERPRISE_WORKSPACE_REQUIRED =
  '请选择具体企业或项目资料目录，不能直接使用主目录、桌面、Documents 或 Downloads。'
