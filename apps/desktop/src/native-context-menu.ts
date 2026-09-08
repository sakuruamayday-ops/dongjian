/** Native desktop context-menu entries for editable fields and selected text. */

import type { MenuItemConstructorOptions } from 'electron'

/** Electron edit capabilities used to enable native editing commands. */
interface DesktopEditFlags {
  canCopy: boolean
  canCut: boolean
  canPaste: boolean
  canSelectAll: boolean
}

/** Stable subset of Electron's context-menu request used by the product. */
export interface DesktopContextMenuRequest {
  editFlags: DesktopEditFlags
  isEditable: boolean
  selectionText: string
}

/**
 * Build the native menu for the focused editor or current document selection.
 * @param request - edit capabilities and selection reported by Chromium.
 * @returns native Electron menu entries, or an empty list outside supported targets.
 */
export function nativeContextMenuTemplate(
  request: DesktopContextMenuRequest,
): MenuItemConstructorOptions[] {
  if (request.isEditable) {
    return [
      { label: '剪切', role: 'cut', enabled: request.editFlags.canCut },
      { label: '复制', role: 'copy', enabled: request.editFlags.canCopy },
      // The native paste role resolves the system clipboard itself. On Windows
      // a separate clipboard capability probe can report false while the role
      // still works; an empty clipboard is already a harmless no-op.
      { label: '粘贴', role: 'paste', enabled: true },
      { type: 'separator' },
      { label: '全选', role: 'selectAll', enabled: request.editFlags.canSelectAll },
    ]
  }

  if (request.selectionText.length > 0) {
    return [{ label: '复制', role: 'copy', enabled: request.editFlags.canCopy }]
  }

  return []
}
