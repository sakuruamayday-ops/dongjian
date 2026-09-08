import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const renderer = readFileSync(resolve(import.meta.dirname, '../src/artifact-renderer.ts'), 'utf8')

describe('desktop artifact renderer process boundary', () => {
  it('keeps the signed runtime immutable while Python inspects or renders artifacts', () => {
    expect(renderer).toContain("['-B', '-I', '-c', PYTHON_RENDERER]")
    expect(renderer).toContain("PYTHONDONTWRITEBYTECODE: '1'")
  })

  it('uses the debugger protocol when JavaScript is disabled in the review window', () => {
    expect(renderer).toContain('javascript: false')
    expect(renderer).toContain("'Runtime.evaluate'")
    expect(renderer).not.toContain('.executeJavaScript(')
  })

  it('keeps text fidelity strict while allowing print extraction order and automatic list markers', () => {
    expect(renderer).toContain("line.replace(/^\\s*\\d{1,3}[.)、]\\s+/u, '')")
    expect(renderer).toContain('sameCharacterInventory(sourceText, inspection.contentText)')
    expect(renderer).toContain('字符计数差异')
  })

  it('reports the exact overflowing fixed page before Chromium clips its text', () => {
    expect(renderer).toContain("document.querySelectorAll('body > .page')")
    expect(renderer).toContain('element.scrollHeight - element.clientHeight')
    expect(renderer).toContain('HTML 固定页面内容溢出')
    expect(renderer.indexOf('HTML 固定页面内容溢出')).toBeLessThan(renderer.indexOf("this.trace('html:print:start')"))
  })

  it('imports the canonical PyMuPDF package without protocol noise', () => {
    expect(renderer).toContain('import pymupdf as fitz')
  })

  it('bounds and consumes same-source page previews instead of retaining full documents indefinitely', () => {
    expect(renderer).toContain('MAX_PREVIEW_BYTES_PER_DOCUMENT = 32 * 1024 * 1024')
    expect(renderer).toContain('MAX_PREVIEW_CACHE_BYTES = 64 * 1024 * 1024')
    expect(renderer).toContain('this.removeCachedPreview(request.artifactSha256)')
  })

  it('captures long documents page by page without creating an oversized Viz surface', () => {
    expect(renderer).toContain("'Page.captureScreenshot'")
    expect(renderer).toContain('captureBeyondViewport: true')
    expect(renderer).toContain('y: page * A4_HEIGHT_PX')
    expect(renderer).toContain('const pageCount = inspection.pageCount')
    expect(renderer).toContain('body > .page')
    expect(renderer).not.toContain('window.setContentSize(A4_WIDTH_PX, pageCount * A4_HEIGHT_PX)')
    expect(renderer).toContain('UnknownVizError')
    expect(renderer).toContain('CHROMIUM_STAGE_TIMEOUT_MS = 30_000')
    expect(renderer).toContain('已停止本次渲染')
  })

  it('normalizes DevTools Retina captures to the same 96 DPI A4 pixels used by PDF rasterization', () => {
    expect(renderer).toContain("nativeImage.createFromBuffer(Buffer.from(screenshot.data, 'base64'))")
    expect(renderer).toContain('const png = image.resize({')
    expect(renderer).toContain('width: A4_WIDTH_PX')
    expect(renderer).toContain('height: A4_HEIGHT_PX')
    expect(renderer).toContain("quality: 'best'")
  })
})
