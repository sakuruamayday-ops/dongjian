import { describe, expect, it } from 'vitest'

describe('desktop tray icon contract', () => {
  it('uses a dedicated small transparent brand asset instead of the 1024px app icon', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const source = await fs.readFile(path.resolve(__dirname, '../src/main.ts'), 'utf8')
    expect(source).toContain('trayIcon: join(product, \'brand\', \'dongjian-mark.png\')')
    expect(source).toContain('trayIcon: join(sourceRoot, \'apps\', \'desktop\', \'assets\', \'dongjian-mark.png\')')
    expect(source).toContain('resize({')
    expect(source).toContain('width: 18')
    expect(source).toContain('height: 18')
    expect(source).toContain('setTemplateImage(true)')
    expect(source).not.toContain('new Tray(nativeImage.createFromPath(icon))')
  })
})
