import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import { DesktopArtifactRenderer } from '../src/artifact-renderer.ts'

const [sourceArtifactPath, outputPath, workspaceRoot, pythonExecutable, bundledFontPath] = process.argv.slice(2)

if ([sourceArtifactPath, outputPath, workspaceRoot, pythonExecutable, bundledFontPath]
  .some(value => value === undefined || value.length === 0)) {
  throw new Error('usage: electron artifact-renderer-electron-smoke.js <source.html> <output.pdf> <workspace-root> <python> <font>')
}

process.stderr.write(`[artifact-renderer] app-ready:${String(app.isReady())}\n`)
// The renderer intentionally destroys its hidden window before PyMuPDF inspection.
// Keep the smoke host alive until that asynchronous post-render check finishes.
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  process.stderr.write('[artifact-renderer] app-ready:true\n')
  const sourceBytes = readFileSync(sourceArtifactPath)
  const renderer = new DesktopArtifactRenderer(
    pythonExecutable,
    bundledFontPath,
    (stage) => { process.stderr.write(`[artifact-renderer] ${stage}\n`) },
  )
  if (process.env.GONGCHUANG_ARTIFACT_DIAGNOSTIC === '1') {
    const diagnostic = await (renderer as unknown as { renderHtml: (source: string, root: string) => Promise<{
      pdf: Buffer
      sourceText: string
      inspection: { contentText: string }
    }> }).renderHtml(sourceArtifactPath, workspaceRoot)
    writeFileSync(`${outputPath}.diagnostic.pdf`, diagnostic.pdf)
    writeFileSync(`${outputPath}.source.txt`, diagnostic.sourceText)
    writeFileSync(`${outputPath}.pdf.txt`, diagnostic.inspection.contentText)
    process.stdout.write(`${JSON.stringify({ diagnostic: true })}\n`)
    return
  }
  const receipt = await renderer.exportPdf({
    sourceArtifactPath,
    sourceArtifactSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    sourceFormat: 'html',
    outputPath,
    workspaceRoot,
  })
  const review = await renderer.renderAndReview({
    artifactPath: receipt.outputPath,
    artifactSha256: receipt.outputSha256,
    format: 'pdf',
    workspaceRoot,
  })
  process.stdout.write(`${JSON.stringify({ receipt, review })}\n`)
}).then(() => {
  app.exit(0)
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  app.exit(1)
})
