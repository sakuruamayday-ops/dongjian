/** Minimal close event used by the desktop background lifecycle. */
export interface DesktopWindowCloseEvent {
  preventDefault(): void
}

/** Window operations shared by macOS menu-bar and Windows system-tray flows. */
export interface DesktopBackgroundWindow {
  focus(): void
  hide(): void
  isMinimized(): boolean
  restore(): void
  show(): void
}

/**
 * Keep the desktop runtime active when the title-bar close action is used.
 *
 * @param event Close event emitted by the desktop window.
 * @param window Desktop window to move into the background.
 * @param quitting Whether an explicit application quit is already in progress.
 */
export function closeWindowToBackground(
  event: DesktopWindowCloseEvent,
  window: DesktopBackgroundWindow,
  quitting: boolean,
): void {
  if (quitting) return
  event.preventDefault()
  window.hide()
}

/**
 * Restore the desktop window from the platform background surface.
 *
 * @param window Desktop window, when application startup has completed.
 */
export function restoreWindowFromBackground(window: DesktopBackgroundWindow | undefined): void {
  if (window === undefined) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
