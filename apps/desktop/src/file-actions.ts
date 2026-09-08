/** Explicit file-card actions. Renderer paths are always revalidated in the main process. */
import { execFile } from 'node:child_process'
import { constants, copyFile, lstat } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { workspaceDocumentPath } from './document-import.ts'
import { fileApplications } from './file-applications.ts'

const run = promisify(execFile)
const FILE_APPLICATIONS = 'gongchuang:documents:applications'
const FILE_ACTION = 'gongchuang:documents:action'

/** @param currentWindow - Current trusted product window. Register its narrow native file menu. */
export function configureFileActions(currentWindow: () => BrowserWindow | undefined): void {
  const senderWindow = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const window = currentWindow()
    if (window === undefined || event.sender !== window.webContents) throw new Error('文件操作来源无效')
    return window
  }
  const document = (workspace: unknown, path: unknown): Promise<string> => {
    if (typeof workspace !== 'string' || workspace.length > 4_096 || typeof path !== 'string') {
      throw new Error('文件操作参数无效')
    }
    return workspaceDocumentPath(workspace, path)
  }
  ipcMain.handle(FILE_APPLICATIONS, async (event, workspace: unknown, path: unknown) => {
    senderWindow(event)
    const applications = await fileApplications(await document(workspace, path))
    const rows = []
    for (const application of applications) {
      let iconUrl: string | undefined
      try { iconUrl = (await app.getFileIcon(application.id, { size: 'small' })).toDataURL() } catch { /* Optional native icon. */ }
      rows.push({ ...application, ...(iconUrl === undefined ? {} : { iconUrl }) })
    }
    return rows
  })
  ipcMain.handle(FILE_ACTION, async (event, workspace: unknown, path: unknown, action: unknown, applicationId: unknown) => {
    const window = senderWindow(event)
    const absolute = await document(workspace, path)
    if (action === 'reveal') { shell.showItemInFolder(absolute); return }
    if (action === 'save-copy') {
      const result = await dialog.showSaveDialog(window, { title: '保存副本', defaultPath: basename(absolute) })
      if (!result.canceled) {
        // A copy must not silently replace the original or another existing document.
        await copyFile(absolute, result.filePath, constants.COPYFILE_EXCL)
      }
      return
    }
    if (action !== 'open-with') throw new Error('文件操作无效')
    if (process.platform === 'win32') {
      if (applicationId !== null) throw new Error('请使用系统打开方式选择应用')
      await run('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', absolute], { windowsHide: true })
      return
    }
    let selected: string
    if (applicationId === null) {
      const result = await dialog.showOpenDialog(window, {
        title: '选择打开方式', defaultPath: '/Applications', properties: ['openFile'],
        filters: [{ name: '应用程序', extensions: ['app'] }],
      })
      if (result.canceled || result.filePaths[0] === undefined) return
      selected = result.filePaths[0]
      if (!selected.endsWith('.app') || !(await lstat(selected)).isDirectory()) throw new Error('请选择应用程序')
    } else {
      const application = (await fileApplications(absolute)).find(candidate => candidate.id === applicationId)
      if (application === undefined) throw new Error('所选应用已不可用')
      selected = application.id
    }
    await run('/usr/bin/open', ['-a', selected, absolute])
  })
}
