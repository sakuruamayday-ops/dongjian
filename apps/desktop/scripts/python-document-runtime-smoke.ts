import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'

const expectedVersions = Object.freeze({
  'python-docx': '1.2.0',
  openpyxl: '3.1.5',
  xlrd: '2.0.2',
  pymupdf: '1.28.2',
  'python-pptx': '1.0.2',
  pillow: '12.3.0',
  xlsxwriter: '3.2.5',
})

const smokeProgram = String.raw`
import base64
import json
from io import BytesIO

import docx
import openpyxl
import xlrd
import pymupdf
import PIL
import pptx
import typing_extensions
import xlsxwriter
from PIL import Image
from pptx.chart.data import ChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches

def encoded(value):
    return base64.b64encode(value).decode("ascii")

word_buffer = BytesIO()
word_document = docx.Document()
word_document.add_paragraph("Gongchuang DOCX runtime smoke")
word_document.save(word_buffer)

excel_buffer = BytesIO()
workbook = openpyxl.Workbook()
workbook.active["A1"] = "Gongchuang XLSX runtime smoke"
workbook.save(excel_buffer)

image_buffer = BytesIO()
Image.new("RGB", (24, 24), color=(202, 145, 35)).save(image_buffer, format="PNG")
image_buffer.seek(0)

powerpoint_buffer = BytesIO()
presentation = pptx.Presentation()
slide = presentation.slides.add_slide(presentation.slide_layouts[5])
slide.shapes.title.text = "Gongchuang PPTX runtime smoke"
slide.shapes.add_picture(image_buffer, Inches(0.5), Inches(1.25), Inches(0.5), Inches(0.5))
chart_data = ChartData()
chart_data.categories = ["Runtime"]
chart_data.add_series("Verified", (1,))
slide.shapes.add_chart(
    XL_CHART_TYPE.COLUMN_CLUSTERED,
    Inches(1.5),
    Inches(1.25),
    Inches(4.5),
    Inches(2.75),
    chart_data,
)
presentation.save(powerpoint_buffer)

pdf_document = pymupdf.open()
pdf_page = pdf_document.new_page()
pdf_page.insert_text((72, 72), "Gongchuang PDF runtime smoke")
pdf_bytes = pdf_document.tobytes()

assert docx.Document(BytesIO(word_buffer.getvalue())).paragraphs[0].text == "Gongchuang DOCX runtime smoke"
assert openpyxl.load_workbook(BytesIO(excel_buffer.getvalue())).active["A1"].value == "Gongchuang XLSX runtime smoke"
assert pptx.Presentation(BytesIO(powerpoint_buffer.getvalue())).slides[0].shapes.title.text == "Gongchuang PPTX runtime smoke"
assert pymupdf.open(stream=pdf_bytes, filetype="pdf").page_count == 1

print(json.dumps({
    "versions": {
        "python-docx": docx.__version__,
        "openpyxl": openpyxl.__version__,
        "xlrd": xlrd.__version__,
        "pymupdf": pymupdf.__version__,
        "python-pptx": pptx.__version__,
        "pillow": PIL.__version__,
        "xlsxwriter": xlsxwriter.__version__,
    },
    "artifacts": {
        "docx": encoded(word_buffer.getvalue()),
        "xlsx": encoded(excel_buffer.getvalue()),
        "pptx": encoded(powerpoint_buffer.getvalue()),
        "pdf": encoded(pdf_bytes),
    },
}, separators=(",", ":")))
`

interface SmokePayload {
  versions: Record<string, string>
  artifacts: Record<string, string>
}

function isPortableExecutable(path: string): boolean {
  if (!existsSync(path)) return false
  return readFileSync(path).subarray(0, 2).equals(Buffer.from('MZ'))
}

/**
 * Validate a Windows document runtime without attempting to execute its PE binaries.
 * Native generation remains mandatory when the preflight itself runs on Windows.
 * @param pythonExecutable - Signed Windows runtime Python executable selected for packaging.
 * @returns Package versions proven by dist-info metadata and import-package layout.
 */
export function verifyWindowsPythonDocumentRuntimeLayout(
  pythonExecutable: string,
): Readonly<Record<string, string>> {
  if (!isPortableExecutable(pythonExecutable)) {
    throw new Error('Windows 打包 Python 不是有效的 PE 可执行文件')
  }
  const sitePackages = join(dirname(pythonExecutable), 'Lib', 'site-packages')
  const packages = [
    ['python-docx', 'python_docx', 'docx'],
    ['openpyxl', 'openpyxl', 'openpyxl'],
    ['xlrd', 'xlrd', 'xlrd'],
    ['pymupdf', 'pymupdf', 'pymupdf'],
    ['python-pptx', 'python_pptx', 'pptx'],
    ['pillow', 'pillow', 'PIL'],
    ['xlsxwriter', 'xlsxwriter', 'xlsxwriter'],
  ] as const
  const versions: Record<string, string> = {}
  const entries = existsSync(sitePackages) ? readdirSync(sitePackages) : []
  for (const [packageName, metadataName, importName] of packages) {
    const expectedVersion = expectedVersions[packageName]
    const metadataDirectory = entries.find(entry => (
      entry.toLowerCase() === `${metadataName}-${expectedVersion}.dist-info`.toLowerCase()
    ))
    if (metadataDirectory === undefined) {
      throw new Error(`Windows 打包 Python 缺少 ${packageName}@${expectedVersion} 元数据`)
    }
    const metadata = readFileSync(join(sitePackages, metadataDirectory, 'METADATA'), 'utf8')
    const actualVersion = /^Version:\s*(\S+)\s*$/mu.exec(metadata)?.[1]
    if (actualVersion !== expectedVersion) {
      throw new Error(`Windows 打包 Python 文档依赖版本无效：${packageName}@${actualVersion ?? 'unknown'}`)
    }
    if (!existsSync(join(sitePackages, importName, '__init__.py'))) {
      throw new Error(`Windows 打包 Python 缺少可导入包：${importName}`)
    }
    versions[packageName] = actualVersion
  }

  let pydCount = 0
  const visit = (root: string): void => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.name.endsWith('.pyd')) {
        pydCount += 1
        if (!isPortableExecutable(path)) {
          throw new Error(`Windows 打包 Python 混入非 PE 扩展：${path}`)
        }
      } else if (entry.name.endsWith('.dylib') || entry.name.endsWith('.so')) {
        throw new Error(`Windows 打包 Python 混入其他平台动态库：${path}`)
      }
    }
  }
  visit(sitePackages)
  if (pydCount === 0) throw new Error('Windows 打包 Python 未包含任何原生 .pyd 扩展')
  return Object.freeze(versions)
}

/**
 * Confirm the bundled Python can generate structurally readable Office and PDF artifacts.
 * @param pythonExecutable - Signed runtime Python executable selected for packaging.
 * @returns Imported package versions proven by the generation smoke.
 */
export function verifyPythonDocumentRuntime(pythonExecutable: string): Readonly<Record<string, string>> {
  const output = execFileSync(pythonExecutable, ['-B', '-c', smokeProgram], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
  })
  const payload = JSON.parse(output) as SmokePayload
  for (const [name, version] of Object.entries(expectedVersions)) {
    if (payload.versions[name] !== version) {
      throw new Error(`打包 Python 文档依赖版本无效：${name}@${payload.versions[name] ?? 'unknown'}`)
    }
  }

  const decoded = Object.fromEntries(['docx', 'xlsx', 'pptx', 'pdf'].map((format) => {
    const encoded = payload.artifacts[format]
    if (typeof encoded !== 'string' || encoded === '') {
      throw new Error(`打包 Python 未生成 ${format.toUpperCase()} 验收文件`)
    }
    return [format, Buffer.from(encoded, 'base64')]
  }))
  const docx = unzipSync(decoded.docx ?? Buffer.alloc(0))
  const xlsx = unzipSync(decoded.xlsx ?? Buffer.alloc(0))
  const pptx = unzipSync(decoded.pptx ?? Buffer.alloc(0))
  const utf8 = (value: Uint8Array | undefined): string => Buffer.from(value ?? []).toString('utf8')
  if (!utf8(docx['word/document.xml']).includes('Gongchuang DOCX runtime smoke')) {
    throw new Error('打包 Python 生成的 DOCX 无法按 OOXML 读取')
  }
  if (!utf8(xlsx['xl/worksheets/sheet1.xml']).includes('Gongchuang XLSX runtime smoke')) {
    throw new Error('打包 Python 生成的 XLSX 无法按 OOXML 读取')
  }
  if (!utf8(pptx['ppt/slides/slide1.xml']).includes('Gongchuang PPTX runtime smoke')
    || pptx['ppt/charts/chart1.xml'] === undefined
    || pptx['ppt/media/image1.png'] === undefined
    || !Object.keys(pptx).some(path => path.startsWith('ppt/embeddings/') && path.endsWith('.xlsx'))) {
    throw new Error('打包 Python 生成的 PPTX 无法按 OOXML 读取')
  }
  if (!(decoded.pdf?.subarray(0, 5).equals(Buffer.from('%PDF-')) ?? false)) {
    throw new Error('打包 Python 生成的 PDF 头无效')
  }
  return Object.freeze({ ...payload.versions })
}
