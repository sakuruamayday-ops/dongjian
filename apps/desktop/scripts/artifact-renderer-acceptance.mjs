import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { app } from 'electron'
import { DesktopArtifactRenderer } from '../lib/types/apps/desktop/src/artifact-renderer.js'

const root = resolve(process.env.GONGCHUANG_RENDER_ACCEPTANCE_ROOT
  ?? `/private/tmp/gongchuang-artifact-renderer-${Date.now()}`)
mkdirSync(root, { recursive: true })
const source = resolve(root, 'sample.html')
const output = resolve(root, 'sample.pdf')
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 0; }
html, body { width: 210mm; min-height: 297mm; }
body { box-sizing: border-box; padding: 22mm; color: #17212b; background: white; }
h1 { font-size: 28px; margin: 0 0 20px; }
p { font-size: 16px; line-height: 1.8; }
.rule { height: 3px; background: #d64933; width: 80px; }
</style></head><body><div class="rule"></div><h1>洞见 PDF 验收样例</h1><p>这是一份由 Electron Chromium 导出、PyMuPDF 解析并逐页栅格化的真实 PDF。</p><p>自动视觉回归比较同源打印布局，不产生人工确认回执。</p></body></html>`
writeFileSync(source, html)
const digest = createHash('sha256').update(Buffer.from(html)).digest('hex')

async function run() {
  const renderer = new DesktopArtifactRenderer(
    process.env.GONGCHUANG_PYTHON_EXECUTABLE ?? 'python3',
    resolve(import.meta.dirname, '..', 'assets', 'fonts', 'NotoSansSC-Variable.ttf'),
  )
  const exported = await renderer.exportPdf({
    sourceArtifactPath: source,
    sourceArtifactSha256: digest,
    sourceFormat: 'html',
    outputPath: output,
    workspaceRoot: root,
  })
  const inspected = await renderer.inspectPdf({
    artifactPath: output,
    artifactSha256: exported.outputSha256,
    workspaceRoot: root,
  })
  const visual = await renderer.renderAndReview({
    artifactPath: output,
    artifactSha256: exported.outputSha256,
    format: 'pdf',
    workspaceRoot: root,
  })
  const receipt = { status: 'passed', root, exported, inspected, visual }
  writeFileSync(resolve(root, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  app.exit(0)
}

function fail(error) {
  const message = error?.stack ?? String(error)
  writeFileSync(resolve(root, 'receipt.json'), `${JSON.stringify({ status: 'failed', root, error: message }, null, 2)}\n`)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
  app.exit(1)
}

app.once('ready', () => { void run().catch(fail) })
app.on('window-all-closed', () => {})
