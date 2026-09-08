/** Recovery orchestration for a desktop update after the product runtime stops. */

import type { DesktopUpdateSnapshot } from './desktop-updater.ts'

/**
 * Run one updater handoff and relaunch the current app if native installation cannot start.
 * @param operation - Updater action that invokes the supplied callback at its commit point.
 * @param shutdownRuntime - Product-runtime shutdown performed immediately before native handoff.
 * @param relaunchCurrent - Native relaunch of the unchanged current application.
 * @returns The updater snapshot when the controller settles normally.
 */
export async function runDesktopInstallHandoff(
  operation: (beforeInstall: () => Promise<void>) => Promise<DesktopUpdateSnapshot>,
  shutdownRuntime: () => Promise<void>,
  relaunchCurrent: () => void,
): Promise<DesktopUpdateSnapshot> {
  const state: { runtimeStopStarted: boolean; runtimeStopped: boolean } = {
    runtimeStopStarted: false,
    runtimeStopped: false,
  }
  const beforeInstall = async (): Promise<void> => {
    state.runtimeStopStarted = true
    await shutdownRuntime()
    state.runtimeStopped = true
  }
  try {
    const snapshot = await operation(beforeInstall)
    if (state.runtimeStopped && snapshot.status === 'error') relaunchCurrent()
    return snapshot
  } catch (error) {
    // Disposal can stop the loopback server before its promise rejects or times
    // out. Reopen the unchanged client after every attempted handoff failure so
    // the user is never left in a half-stopped process.
    if (state.runtimeStopStarted) relaunchCurrent()
    throw error
  }
}
