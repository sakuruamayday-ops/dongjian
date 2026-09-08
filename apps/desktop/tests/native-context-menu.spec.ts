import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nativeContextMenuTemplate } from '../src/native-context-menu.ts'

const flags = {
  canCopy: true,
  canCut: true,
  canPaste: true,
  canSelectAll: true,
}

describe('desktop native context menu', () => {
  it('offers working native edit roles in the conversation input', () => {
    const template = nativeContextMenuTemplate({ editFlags: flags, isEditable: true, selectionText: '草稿' })

    expect(template.map(item => item.role ?? item.type)).toEqual([
      'cut', 'copy', 'paste', 'separator', 'selectAll',
    ])
    expect(template.filter(item => item.type !== 'separator').every(item => item.enabled)).toBe(true)
  })

  it('keeps unavailable editor actions visible but disabled', () => {
    const template = nativeContextMenuTemplate({
      editFlags: { ...flags, canCopy: false, canCut: false, canPaste: false },
      isEditable: true,
      selectionText: '',
    })

    expect(template.find(item => item.role === 'cut')?.enabled).toBe(false)
    expect(template.find(item => item.role === 'copy')?.enabled).toBe(false)
    expect(template.find(item => item.role === 'paste')?.enabled).toBe(true)
  })

  it('offers copy for selected generated content and no menu for page chrome', () => {
    expect(nativeContextMenuTemplate({ editFlags: flags, isEditable: false, selectionText: '生成内容' }))
      .toEqual([{ label: '复制', role: 'copy', enabled: true }])
    expect(nativeContextMenuTemplate({ editFlags: flags, isEditable: false, selectionText: '' })).toEqual([])
  })

  it('installs the template on the main Electron webContents context-menu event', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/main.ts'), 'utf8')
    expect(source).toContain("window.webContents.on('context-menu'")
    expect(source).toContain('nativeContextMenuTemplate(params)')
    expect(source).toContain('Menu.buildFromTemplate(template).popup({ window })')
  })
})
