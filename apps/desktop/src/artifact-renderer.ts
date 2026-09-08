import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BrowserWindow, nativeImage, session } from 'electron'
import type {
  GongchuangArtifactRenderer,
  ProfessionalPdfExportReceipt,
  ProfessionalPdfInspectionReceipt,
  ProfessionalRenderReceipt,
} from '@gongchuang/client-policy-gate'

const ARTIFACT_RENDERER_ID = 'gongchuang-electron-pymupdf-v2' as const
const A4_WIDTH_PX = 794
const A4_HEIGHT_PX = 1123
const MAX_HTML_BYTES = 20 * 1024 * 1024
const MAX_PDF_BYTES = 256 * 1024 * 1024
const MAX_PAGES = 200
const MAX_PYTHON_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_PREVIEW_BYTES_PER_DOCUMENT = 32 * 1024 * 1024
const MAX_PREVIEW_CACHE_BYTES = 64 * 1024 * 1024
const MAX_PREVIEW_CACHE_RECORDS = 32
const CHANGED_PIXEL_RATIO_TOLERANCE = 0.12
// 96 DPI 截图与 Skia PDF 光栅化在密集中文表格上存在约 2.7% 的抗锯齿误差。
// 3% 容差覆盖该已测渲染差异；12% 变化像素阈值仍负责拦截结构性错位。
const MEAN_ABSOLUTE_ERROR_TOLERANCE = 0.03
const CHROMIUM_STAGE_TIMEOUT_MS = 30_000
const PYTHON_STAGE_TIMEOUT_MS = 60_000
const ALLOWED_LOCAL_RESOURCE_EXTENSIONS = new Set([
  '.css', '.gif', '.jpeg', '.jpg', '.otf', '.png', '.svg', '.ttf', '.webp', '.woff', '.woff2',
])

interface PreviewRecord {
  artifactSha256: string
  pages: readonly Buffer[]
  bytes: number
}

interface PythonInspection {
  pageCount: number
  contentText: string
  contentSha256: string
}

interface PythonComparison extends PythonInspection {
  pages: Array<{
    page: number
    width: number
    height: number
    pngSha256: string
    changedPixelRatio: number
    meanAbsoluteError: number
    diffPng?: string
  }>
}

interface ChromiumLayoutEvaluation {
  result?: {
    value?: unknown
  }
  exceptionDetails?: unknown
}

interface ChromiumScreenshot {
  data?: unknown
}

type ArtifactRendererTrace = (stage: string) => void

function withTimeout<T>(label: string, timeoutMs: number, task: Promise<T>): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}超过 ${String(timeoutMs / 1000)} 秒，已停止本次渲染`))
    }, timeoutMs)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function parseChromiumLayout(evaluation: ChromiumLayoutEvaluation): {
  height: number
  fontReady: boolean
  text: string
  overflowPages: Array<{ page: number; label: string; overflowPx: number }>
} {
  const value = evaluation.result?.value
  if (evaluation.exceptionDetails !== undefined || typeof value !== 'object' || value === null) {
    throw new Error('Chromium 未返回可用的打印布局')
  }
  const layout = value as Record<string, unknown>
  if (typeof layout.height !== 'number' || !Number.isFinite(layout.height)
    || typeof layout.fontReady !== 'boolean' || typeof layout.text !== 'string'
    || !Array.isArray(layout.overflowPages)) {
    throw new Error('Chromium 返回了无效的打印布局')
  }
  const overflowPages = layout.overflowPages.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('Chromium 返回了无效的页面溢出结果')
    const page = entry as Record<string, unknown>
    if (typeof page.page !== 'number' || !Number.isInteger(page.page) || page.page < 1
      || typeof page.label !== 'string' || typeof page.overflowPx !== 'number'
      || !Number.isFinite(page.overflowPx) || page.overflowPx <= 0) {
      throw new Error(`Chromium 返回了无效的第 ${String(index + 1)} 项页面溢出结果`)
    }
    return { page: page.page, label: page.label, overflowPx: page.overflowPx }
  })
  return { height: layout.height, fontReady: layout.fontReady, text: layout.text, overflowPages }
}

const PYTHON_RENDERER = String.raw`
import base64, hashlib, io, json, re, sys, unicodedata
import pymupdf as fitz
from PIL import Image, ImageChops, ImageEnhance

def normalize_text(value):
    value = unicodedata.normalize("NFC", value).replace("\r\n", "\n").replace("\r", "\n")
    value = re.sub(r"[ \t]+\n", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()

request = json.load(sys.stdin)
if "pdfBase64" in request:
    encoded = request["pdfBase64"]
    if not isinstance(encoded, str):
        raise RuntimeError("PDF bytes are invalid")
    doc = fitz.open(stream=base64.b64decode(encoded, validate=True), filetype="pdf")
else:
    doc = fitz.open(request["path"])
if not doc.is_pdf or doc.page_count <= 0:
    raise RuntimeError("artifact is not a non-empty PDF")
if doc.page_count > request["maxPages"]:
    raise RuntimeError("PDF page count exceeds the product limit")
content = normalize_text("\n\n".join(page.get_text("text") for page in doc))
if not content:
    raise RuntimeError("PDF contains no extractable text")
result = {
    "pageCount": doc.page_count,
    "contentText": content,
    "contentSha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
}
if request["mode"] == "compare":
    references = request["references"]
    if len(references) != doc.page_count:
        raise RuntimeError("source preview page count differs from final PDF")
    pages = []
    for index, page in enumerate(doc):
        pix = page.get_pixmap(matrix=fitz.Matrix(96 / 72, 96 / 72), colorspace=fitz.csRGB, alpha=False)
        png = pix.tobytes("png")
        current = Image.open(io.BytesIO(png)).convert("RGB")
        reference = Image.open(io.BytesIO(base64.b64decode(references[index]))).convert("RGB")
        if reference.size != current.size:
            canvas = Image.new("RGB", current.size, "white")
            canvas.paste(reference, (0, 0))
            reference = canvas
        difference = ImageChops.difference(reference, current)
        pixels = current.width * current.height
        changed = 0
        absolute = 0
        for red, green, blue in difference.getdata():
            absolute += red + green + blue
            if max(red, green, blue) > request["perPixelThreshold"]:
                changed += 1
        changed_ratio = changed / pixels
        mean_error = absolute / (pixels * 3 * 255)
        page_result = {
            "page": index + 1,
            "width": current.width,
            "height": current.height,
            "pngSha256": hashlib.sha256(png).hexdigest(),
            "changedPixelRatio": changed_ratio,
            "meanAbsoluteError": mean_error,
        }
        if changed_ratio > request["changedPixelRatioTolerance"] or mean_error > request["meanAbsoluteErrorTolerance"]:
            enhanced = ImageEnhance.Contrast(difference).enhance(3)
            output = io.BytesIO()
            enhanced.save(output, format="PNG")
            page_result["diffPng"] = base64.b64encode(output.getvalue()).decode("ascii")
        pages.append(page_result)
    result["pages"] = pages
json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
`

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function within(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function assertWorkspaceFile(path: string, workspaceRoot: string, expectedExtension?: string): string {
  const root = realpathSync(resolve(workspaceRoot))
  const requested = resolve(path)
  const stat = lstatSync(requested)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('文档渲染只接受企业空间内的普通文件')
  const actual = realpathSync(requested)
  if (!within(root, actual)) throw new Error('文档渲染拒绝企业空间外的路径')
  if (expectedExtension !== undefined && extname(actual).toLowerCase() !== expectedExtension) {
    throw new Error(`文档渲染只接受 ${expectedExtension} 文件`)
  }
  return actual
}

function assertOutputPath(path: string, workspaceRoot: string, sourcePath: string): string {
  const root = realpathSync(resolve(workspaceRoot))
  const output = resolve(path)
  if (extname(output).toLowerCase() !== '.pdf') throw new Error('PDF 输出路径必须使用 .pdf 扩展名')
  if (dirname(output) !== dirname(sourcePath)) throw new Error('PDF 必须生成在源文件所在目录')
  if (existsSync(output)) throw new Error('PDF 输出已存在，宿主拒绝覆盖')
  const parent = realpathSync(dirname(output))
  if (!within(root, parent)) throw new Error('PDF 输出路径不在企业空间内')
  return output
}

function assertDigest(path: string, expected: string): Buffer {
  if (!/^[0-9a-f]{64}$/u.test(expected)) throw new Error('文档摘要格式无效')
  const bytes = readFileSync(path)
  if (sha256(bytes) !== expected) throw new Error('文档在渲染前发生变化')
  return bytes
}

function pythonJson<T>(pythonExecutable: string, request: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const child = spawn(pythonExecutable, ['-B', '-I', '-c', PYTHON_RENDERER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error(`随包 PyMuPDF 超过 ${String(PYTHON_STAGE_TIMEOUT_MS / 1000)} 秒，已停止本次检查`))
    }, PYTHON_STAGE_TIMEOUT_MS)
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_PYTHON_OUTPUT_BYTES) {
        child.kill()
        fail(new Error('PDF 渲染回执超过安全上限'))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })
    child.on('error', (error) => { fail(new Error('随包 PyMuPDF 运行失败', { cause: error })) })
    child.on('close', (code) => {
      if (settled) return
      clearTimeout(timer)
      if (code !== 0) {
        fail(new Error(`随包 PyMuPDF 返回失败：${Buffer.concat(stderr).toString('utf8').trim() || String(code)}`))
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8')) as T
        settled = true
        resolvePromise(parsed)
      } catch (error) {
        fail(new Error('随包 PyMuPDF 返回了无效回执', { cause: error }))
      }
    })
    child.stdin.end(JSON.stringify(request))
  })
}

function normalizeText(value: string): string {
  return value.normalize('NFC')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function comparableText(value: string): string {
  return normalizeText(value)
    .split('\n')
    // Chromium 的 innerText 不含 <ol> 标号，PyMuPDF 会把打印后的自动标号提取出来。
    // 只忽略行首的自动列表标号，正文中的数字、小数点和编号仍参与保真比较。
    .map(line => line.replace(/^\s*\d{1,3}[.)、]\s+/u, ''))
    .join('\n')
    .replace(/\s+/gu, '')
}

function sameCharacterInventory(sourceText: string, pdfText: string): boolean {
  const source = comparableText(sourceText)
  const pdf = comparableText(pdfText)
  if (source.length !== pdf.length) return false
  const inventory = new Map<string, number>()
  for (const character of source) inventory.set(character, (inventory.get(character) ?? 0) + 1)
  for (const character of pdf) {
    const remaining = inventory.get(character)
    if (remaining === undefined || remaining === 0) return false
    if (remaining === 1) inventory.delete(character)
    else inventory.set(character, remaining - 1)
  }
  return inventory.size === 0
}

function textMismatchSummary(sourceText: string, pdfText: string): string {
  const source = comparableText(sourceText)
  const pdf = comparableText(pdfText)
  const count = (value: string): Map<string, number> => {
    const inventory = new Map<string, number>()
    for (const character of value) inventory.set(character, (inventory.get(character) ?? 0) + 1)
    return inventory
  }
  const sourceInventory = count(source)
  const pdfInventory = count(pdf)
  const changed = [...new Set([...sourceInventory.keys(), ...pdfInventory.keys()])]
    .filter(character => sourceInventory.get(character) !== pdfInventory.get(character))
    .slice(0, 3)
    .map(character => `“${character}”源 ${String(sourceInventory.get(character) ?? 0)} / PDF ${String(pdfInventory.get(character) ?? 0)}`)
    .join('，')
  return `源正文 ${String(source.length)} 字，PDF 正文 ${String(pdf.length)} 字；字符计数差异：${changed || '未知'}`
}

/** Signed desktop PDF implementation with byte-bounded, single-use source previews. */
export class DesktopArtifactRenderer implements GongchuangArtifactRenderer {
  private readonly previews = new Map<string, PreviewRecord>()
  private previewCacheBytes = 0

  constructor(
    private readonly pythonExecutable: string,
    private readonly bundledFontPath: string,
    private readonly trace: ArtifactRendererTrace = () => {},
  ) {
    const font = lstatSync(bundledFontPath)
    if (!font.isFile() || font.isSymbolicLink()) throw new Error('随包中文字体不存在或不是普通文件')
  }

  async inspectPdf(request: Readonly<{
    artifactPath: string
    artifactSha256: string
    workspaceRoot: string
  }>): Promise<ProfessionalPdfInspectionReceipt> {
    const path = assertWorkspaceFile(request.artifactPath, request.workspaceRoot, '.pdf')
    assertDigest(path, request.artifactSha256)
    const inspection = await pythonJson<PythonInspection>(this.pythonExecutable, {
      mode: 'inspect', path, maxPages: MAX_PAGES,
    })
    return {
      rendererId: ARTIFACT_RENDERER_ID,
      status: 'passed-host-pdf-inspection',
      artifactSha256: request.artifactSha256,
      pageCount: inspection.pageCount,
      contentText: inspection.contentText,
      contentSha256: inspection.contentSha256,
    }
  }

  async exportPdf(request: Readonly<{
    sourceArtifactPath: string
    sourceArtifactSha256: string
    sourceFormat: string
    outputPath: string
    workspaceRoot: string
  }>): Promise<ProfessionalPdfExportReceipt> {
    this.trace('export:start')
    if (request.sourceFormat.toLowerCase() !== 'html' && request.sourceFormat.toLowerCase() !== 'htm') {
      throw new Error('PDF 导出只接受静态 HTML；Office 文件保持原生 OOXML 交付')
    }
    const source = assertWorkspaceFile(request.sourceArtifactPath, request.workspaceRoot)
    const sourceBytes = assertDigest(source, request.sourceArtifactSha256)
    if (sourceBytes.length > MAX_HTML_BYTES) throw new Error('HTML PDF 源文件超过 20 MiB 上限')
    const output = assertOutputPath(request.outputPath, request.workspaceRoot, source)
    const { pdf, previews, sourceText, inspection } = await this.renderHtml(source, request.workspaceRoot)
    this.trace('export:html-rendered')
    if (pdf.length > MAX_PDF_BYTES) throw new Error('生成的 PDF 超过 256 MiB 上限')
    const outputSha256 = sha256(pdf)
    if (inspection.pageCount !== previews.length) {
      throw new Error('HTML 打印布局页数与最终 PDF 页数不一致')
    }
    // PDF 文本提取会按视觉坐标重排行、列、绝对定位块；比较字符库存可以容忍
    // 这种合法重排，同时仍能发现任何正文字符的缺失、重复或替换。
    if (!sameCharacterInventory(sourceText, inspection.contentText)) {
      throw new Error(`最终 PDF 的可提取正文与同源 HTML 不一致：${textMismatchSummary(sourceText, inspection.contentText)}`)
    }
    if (existsSync(output)) throw new Error('PDF 输出在导出期间被其他操作占用')
    writeFileSync(output, pdf, { flag: 'wx', mode: 0o600 })
    const outputBytes = readFileSync(output)
    if (sha256(outputBytes) !== outputSha256) throw new Error('PDF 写入后的摘要与内存候选不一致')
    this.cachePreview(outputSha256, previews)
    this.trace('export:complete')
    return {
      rendererId: ARTIFACT_RENDERER_ID,
      status: 'passed-host-pdf-export',
      sourceArtifactSha256: request.sourceArtifactSha256,
      outputPath: output,
      outputSha256,
      bytes: outputBytes.length,
    }
  }

  async renderAndReview(request: Readonly<{
    artifactPath: string
    artifactSha256: string
    format: string
    workspaceRoot: string
  }>): Promise<ProfessionalRenderReceipt> {
    if (request.format.toLowerCase() !== 'pdf') throw new Error('自动视觉回归只接受最终 PDF')
    const path = assertWorkspaceFile(request.artifactPath, request.workspaceRoot, '.pdf')
    assertDigest(path, request.artifactSha256)
    const preview = this.previews.get(request.artifactSha256)
    if (preview === undefined || preview.artifactSha256 !== request.artifactSha256) {
      throw new Error('最终 PDF 没有同源打印布局预览，不能生成自动视觉通过回执')
    }
    this.removeCachedPreview(request.artifactSha256)
    const comparison = await pythonJson<PythonComparison>(this.pythonExecutable, {
      mode: 'compare',
      path,
      maxPages: MAX_PAGES,
      references: preview.pages.map(page => page.toString('base64')),
      perPixelThreshold: 24,
      changedPixelRatioTolerance: CHANGED_PIXEL_RATIO_TOLERANCE,
      meanAbsoluteErrorTolerance: MEAN_ABSOLUTE_ERROR_TOLERANCE,
    })
    const failed = comparison.pages.filter(
      (page): page is typeof page & { diffPng: string } => page.diffPng !== undefined,
    )
    if (failed.length > 0) {
      for (const page of failed) {
        const suffix = request.artifactSha256.slice(0, 12)
        const diffPath = resolve(dirname(path), `${path.slice(dirname(path).length + 1, -4)}.visual-diff-p${String(page.page)}-${suffix}.png`)
        if (!existsSync(diffPath)) writeFileSync(diffPath, Buffer.from(page.diffPng, 'base64'), { flag: 'wx', mode: 0o600 })
      }
      const summary = failed.map(page => `第 ${String(page.page)} 页变化像素 ${page.changedPixelRatio.toFixed(4)}、平均误差 ${page.meanAbsoluteError.toFixed(4)}`).join('；')
      throw new Error(`PDF 自动视觉回归超出容差，已生成 ${String(failed.length)} 张逐页差异图：${summary}`)
    }
    return {
      rendererId: ARTIFACT_RENDERER_ID,
      status: 'passed-host-render',
      review: 'automatic-source-preview',
      artifactSha256: request.artifactSha256,
      comparison: {
        reference: 'same-source-print-layout',
        maxChangedPixelRatio: Math.max(...comparison.pages.map(page => page.changedPixelRatio), 0),
        maxMeanAbsoluteError: Math.max(...comparison.pages.map(page => page.meanAbsoluteError), 0),
        changedPixelRatioTolerance: CHANGED_PIXEL_RATIO_TOLERANCE,
        meanAbsoluteErrorTolerance: MEAN_ABSOLUTE_ERROR_TOLERANCE,
      },
      pages: comparison.pages.map(page => ({
        page: page.page,
        width: page.width,
        height: page.height,
        pngSha256: page.pngSha256,
      })),
    }
  }

  private async renderHtml(source: string, workspaceRoot: string): Promise<{
    pdf: Buffer
    previews: readonly Buffer[]
    sourceText: string
    inspection: PythonInspection
  }> {
    const partition = `gongchuang-pdf-${randomUUID()}`
    const renderSession = session.fromPartition(partition, { cache: false })
    const root = realpathSync(resolve(workspaceRoot))
    const font = realpathSync(this.bundledFontPath)
    const blocked = new Set<string>()
    renderSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    renderSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const url = new URL(details.url)
        if (url.protocol === 'data:' && /^(?:image|font)\//u.test(url.pathname)) {
          callback({ cancel: false })
          return
        }
        if (url.protocol !== 'file:') throw new Error('non-local resource')
        const requested = realpathSync(fileURLToPath(url))
        const allowed = requested === font || (within(root, requested)
          && (requested === source || ALLOWED_LOCAL_RESOURCE_EXTENSIONS.has(extname(requested).toLowerCase())))
        if (!allowed) throw new Error('resource outside the approved static set')
        callback({ cancel: false })
      } catch {
        blocked.add(details.url)
        callback({ cancel: true })
      }
    })
    const window = new BrowserWindow({
      show: false,
      width: A4_WIDTH_PX,
      height: A4_HEIGHT_PX,
      useContentSize: true,
      webPreferences: {
        session: renderSession,
        javascript: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    let debuggerAttached = false
    try {
      this.trace('html:load:start')
      await withTimeout('HTML PDF 源加载', CHROMIUM_STAGE_TIMEOUT_MS, window.loadURL(pathToFileURL(source).href))
      this.trace('html:load:complete')
      if (blocked.size > 0) throw new Error(`HTML PDF 源引用了不允许的资源：${[...blocked][0]}`)
      window.webContents.debugger.attach('1.3')
      debuggerAttached = true
      await withTimeout('打印媒体模式设置', CHROMIUM_STAGE_TIMEOUT_MS,
        window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'print' }))
      const fontUrl = pathToFileURL(font).href.replaceAll("'", '%27')
      await withTimeout('随包字体样式注入', CHROMIUM_STAGE_TIMEOUT_MS, window.webContents.insertCSS(`
        @font-face { font-family: 'Gongchuang Noto Sans SC'; src: url('${fontUrl}') format('truetype'); font-weight: 100 900; }
        html, body, body * { font-family: 'Gongchuang Noto Sans SC' !important; }
      `))
      const evaluation = await withTimeout('HTML 打印布局计算', CHROMIUM_STAGE_TIMEOUT_MS,
        window.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: `(async () => {
        await document.fonts.ready
        return {
          height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
          fontReady: document.fonts.check('16px "Gongchuang Noto Sans SC"'),
          text: document.body?.innerText ?? '',
          overflowPages: [...document.querySelectorAll('body > .page')].flatMap((element, index) => {
            const overflowPx = Math.ceil(element.scrollHeight - element.clientHeight)
            if (overflowPx <= 1) return []
            const label = element.querySelector('.page-no')?.textContent?.trim()
              || element.querySelector('h1, h2')?.textContent?.trim()
              || String(index + 1)
            return [{ page: index + 1, label, overflowPx }]
          }),
        }
      })()`,
          awaitPromise: true,
          returnByValue: true,
        })) as ChromiumLayoutEvaluation
      const layout = parseChromiumLayout(evaluation)
      if (!layout.fontReady) throw new Error('随包 Noto Sans SC 字体未能装载')
      if (normalizeText(layout.text).length === 0) throw new Error('HTML PDF 源没有可导出的正文')
      // 固定页若使用 overflow:hidden，innerText 仍包含被裁掉的正文，而 PDF 已经丢字。
      // 在打印前报告精确页码，避免模型根据字符差异反复猜测并删错内容。
      if (layout.overflowPages.length > 0) {
        const detail = layout.overflowPages
          .map(page => `第 ${String(page.page)} 页（${page.label}）超出 ${String(page.overflowPx)} 像素`)
          .join('；')
        throw new Error(`HTML 固定页面内容溢出：${detail}。请重排该页内容后再渲染`)
      }
      this.trace('html:print:start')
      const pdf = await withTimeout('Electron PDF 生成', CHROMIUM_STAGE_TIMEOUT_MS, window.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        preferCSSPageSize: false,
        generateTaggedPDF: true,
        generateDocumentOutline: true,
      }))
      this.trace('html:print:complete')
      if (pdf.length === 0) throw new Error('Electron 未生成 PDF 字节')
      const inspection = await pythonJson<PythonInspection>(this.pythonExecutable, {
        mode: 'inspect', pdfBase64: pdf.toString('base64'), maxPages: MAX_PAGES,
      })
      this.trace('export:pdf-inspected')
      const pageCount = inspection.pageCount

      // 打印页边距不会出现在普通页面截图中。这里在 PDF 已生成后把每个直属
      // .page 映射成一张完整 A4 画布，供同源逐页视觉比较使用。
      await withTimeout('HTML A4 预览样式注入', CHROMIUM_STAGE_TIMEOUT_MS, window.webContents.insertCSS(`
        html, body {
          width: ${String(A4_WIDTH_PX)}px !important;
          min-width: ${String(A4_WIDTH_PX)}px !important;
          margin: 0 !important;
          background: white !important;
        }
        body {
          display: flex !important;
          flex-direction: column !important;
          align-items: stretch !important;
        }
        body > .page {
          flex: 0 0 auto !important;
          width: 688px !important;
          height: 1017px !important;
          margin: 49px 53px 57px !important;
        }
      `))
      const previews: Buffer[] = []
      let previewBytes = 0
      for (let page = 0; page < pageCount; page += 1) {
        this.trace(`html:preview:${String(page + 1)}/${String(pageCount)}:start`)
        let screenshot: ChromiumScreenshot
        try {
          // 不把隐藏窗口扩成整份报告的高度。macOS 的 Viz 合成面在多页长窗口下会返回
          // UnknownVizError；CDP 按 A4 分段截取页面，既保留同源预览，也避免超大表面。
          screenshot = await withTimeout(`HTML 打印布局第 ${String(page + 1)} 页截图`, CHROMIUM_STAGE_TIMEOUT_MS,
            window.webContents.debugger.sendCommand('Page.captureScreenshot', {
              format: 'png',
              fromSurface: true,
              captureBeyondViewport: true,
              clip: {
                x: 0,
                y: page * A4_HEIGHT_PX,
                width: A4_WIDTH_PX,
                height: A4_HEIGHT_PX,
                scale: 1,
              },
            })) as ChromiumScreenshot
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(`HTML 打印布局第 ${String(page + 1)} 页截图失败：${detail}`, { cause: error })
        }
        if (typeof screenshot.data !== 'string' || screenshot.data.length === 0) {
          throw new Error(`HTML 打印布局第 ${String(page + 1)} 页没有返回截图数据`)
        }
        // DevTools 截图仍可能继承 Retina 比例；归一到 PDF 的 96 DPI A4 像素尺寸。
        const image = nativeImage.createFromBuffer(Buffer.from(screenshot.data, 'base64'))
        if (image.isEmpty()) throw new Error(`HTML 打印布局第 ${String(page + 1)} 页截图无效`)
        const png = image.resize({
          width: A4_WIDTH_PX,
          height: A4_HEIGHT_PX,
          quality: 'best',
        }).toPNG()
        if (png.length === 0) throw new Error(`HTML 打印布局第 ${String(page + 1)} 页为空`)
        previewBytes += png.length
        if (previewBytes > MAX_PREVIEW_BYTES_PER_DOCUMENT) {
          throw new Error('HTML 打印布局预览超过 32 MiB 上限')
        }
        previews.push(png)
        this.trace(`html:preview:${String(page + 1)}/${String(pageCount)}:complete`)
      }
      return { pdf, previews, sourceText: normalizeText(layout.text), inspection }
    } finally {
      if (debuggerAttached) window.webContents.debugger.detach()
      window.destroy()
    }
  }

  private cachePreview(artifactSha256: string, pages: readonly Buffer[]): void {
    this.removeCachedPreview(artifactSha256)
    const bytes = pages.reduce((total, page) => total + page.length, 0)
    while (
      this.previews.size >= MAX_PREVIEW_CACHE_RECORDS
      || this.previewCacheBytes + bytes > MAX_PREVIEW_CACHE_BYTES
    ) {
      const oldest = this.previews.keys().next().value
      if (oldest === undefined) break
      this.removeCachedPreview(oldest)
    }
    this.previews.set(artifactSha256, { artifactSha256, pages, bytes })
    this.previewCacheBytes += bytes
  }

  private removeCachedPreview(artifactSha256: string): void {
    const preview = this.previews.get(artifactSha256)
    if (preview === undefined) return
    this.previews.delete(artifactSha256)
    this.previewCacheBytes -= preview.bytes
  }
}

export function bundledArtifactFontPath(resourcesPath: string): string {
  const path = resolve(resourcesPath, 'product', 'brand', 'fonts', 'NotoSansSC-Variable.ttf')
  if (!statSync(path).isFile()) throw new Error('随包确定性中文字体不存在')
  return path
}
