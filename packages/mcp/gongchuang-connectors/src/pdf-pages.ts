import { execFile } from 'node:child_process'

const SELECT_PAGES = String.raw`
import base64, json, sys
import pymupdf as fitz

request = json.load(sys.stdin)
with fitz.open(stream=base64.b64decode(request["pdf"], validate=True), filetype="pdf") as source:
    if source.is_encrypted:
        raise ValueError("PDF is encrypted")
    pages = request["pages"]
    if any(page > source.page_count for page in pages):
        raise ValueError("page exceeds the PDF page count")
    with fitz.open() as selected:
        for page in pages:
            selected.insert_pdf(source, from_page=page - 1, to_page=page - 1)
        sys.stdout.buffer.write(selected.tobytes(garbage=4, deflate=True))
`

/**
 * Normalize one-based OCR page numbers without changing their requested order.
 * @param pages - Requested one-based page numbers.
 * @returns Deduplicated page numbers in first-requested order.
 */
export function normalizeOcrPages(pages: readonly number[]): number[] {
  if (pages.length === 0 || pages.length > 200
    || pages.some(page => !Number.isSafeInteger(page) || page < 1)) {
    throw new Error('OCR 页码必须为非空的正整数列表，最多选择 200 页')
  }
  return [...new Set(pages)]
}

/**
 * Select pages in memory with the verified desktop Python, never a model-authored script.
 * @param pythonExecutable - Verified bundled Python executable.
 * @param bytes - Complete PDF bytes.
 * @param pages - Requested one-based page numbers.
 * @param signal - Cancellation signal for the bounded subprocess.
 * @returns PDF bytes containing only the requested pages.
 */
export function selectOcrPdfPages(
  pythonExecutable: string,
  bytes: Uint8Array,
  pages: readonly number[],
  signal: AbortSignal,
): Promise<Uint8Array> {
  const selected = normalizeOcrPages(pages)
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    // -I ignores Python environment overrides; -B keeps signed resources unchanged.
    const child = execFile(pythonExecutable, ['-I', '-B', '-c', SELECT_PAGES], {
      encoding: 'buffer', timeout: 30_000, maxBuffer: 24 * 1024 * 1024, signal,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`PDF 指定页读取失败：${stderr.toString('utf8').trim().slice(-500) || error.message}`))
      } else if (stdout.subarray(0, 5).toString('ascii') !== '%PDF-') {
        reject(new Error('PDF 指定页读取未返回有效 PDF'))
      } else {
        resolve(new Uint8Array(stdout))
      }
    })
    child.stdin?.on('error', reject)
    child.stdin?.end(JSON.stringify({ pdf: Buffer.from(bytes).toString('base64'), pages: selected }))
  })
}
