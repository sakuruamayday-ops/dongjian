import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const desktopRoot = resolve(import.meta.dirname, '..')

function icoEntries(value: Buffer): { width: number; height: number; bytes: Buffer }[] {
  expect(value.readUInt16LE(0)).toBe(0)
  expect(value.readUInt16LE(2)).toBe(1)
  const count = value.readUInt16LE(4)
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + index * 16
    const width = value.readUInt8(entry) || 256
    const height = value.readUInt8(entry + 1) || 256
    const size = value.readUInt32LE(entry + 8)
    const offset = value.readUInt32LE(entry + 12)
    return { width, height, bytes: value.subarray(offset, offset + size) }
  })
}

describe('Windows product chrome', () => {
  it('replaces the Electron default menu with explicit Chinese product labels', () => {
    const source = readFileSync(resolve(desktopRoot, 'src/main.ts'), 'utf8')
    expect(source).toContain("if (process.platform !== 'win32') return")
    expect(source).toContain('Menu.setApplicationMenu(Menu.buildFromTemplate([')
    for (const label of ['文件', '编辑', '查看', '窗口', '帮助']) {
      expect(source).toContain(`label: '${label}'`)
    }
  })

  it('ships a transparent, multi-resolution taskbar icon with the full brand mark', () => {
    const source = readFileSync(resolve(desktopRoot, 'src/main.ts'), 'utf8')
    expect(source).toContain("process.platform === 'win32' ? 'dongjian-mark.png' : 'dongjian-app.png'")
    const entries = icoEntries(readFileSync(resolve(desktopRoot, 'build/icon-dongjian.ico')))
    expect(entries.map(entry => entry.width)).toEqual([16, 24, 32, 48, 64, 128, 256])
    for (const entry of entries) {
      expect(entry.height).toBe(entry.width)
      expect(entry.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      expect(entry.bytes.readUInt8(25)).toBe(6)
    }
  })

  it('records startup stages so Win10 and Win11 receipts can identify the slow phase', () => {
    const source = readFileSync(resolve(desktopRoot, 'src/main.ts'), 'utf8')
    for (const stage of ['skills-verified', 'runtime-verified', 'host-modules-loaded', 'profile-ready', 'window-loaded', 'ready']) {
      expect(source).toContain(`logStartupStage('${stage}')`)
    }
    expect(source).toContain("logStartupStage('startup-window-visible')")
    expect(source).toContain('正在验证运行环境并加载企业能力…')
  })
})
