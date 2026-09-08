import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  verifyProductRuntime, verifyProductRuntimeForStartup,
} from '../../../product/gongchuang-client/src/product-runtime-verifier.ts'
import { GONGCHUANG_CLIENT_VERSION } from '../../../product/gongchuang-client/src/product-version.ts'

function fixture(options: {
  clientVersion?: string
  platform?: 'darwin' | 'win32'
  tier?: 'development-candidate' | 'formal'
  paddleVersion?: string
  includePaddleModule?: boolean
  includePptxModule?: boolean
  includePptxLicense?: boolean
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gongchuang-product-runtime-'))
  const platform = options.platform ?? 'darwin'
  const clientVersion = options.clientVersion ?? GONGCHUANG_CLIENT_VERSION
  const signingTier = options.tier ?? 'development-candidate'
  const python = platform === 'win32' ? 'python/python.exe' : 'python/bin/python3'
  const paddleVersion = options.paddleVersion ?? '0.8.5'
  const paddleModule = platform === 'win32'
    ? 'python/Lib/site-packages/paddleocr_mcp/__main__.py'
    : 'python/lib/python3.12/site-packages/paddleocr_mcp/__main__.py'
  const paddleMetadata = platform === 'win32'
    ? `python/Lib/site-packages/paddleocr_mcp-${paddleVersion}.dist-info/METADATA`
    : `python/lib/python3.12/site-packages/paddleocr_mcp-${paddleVersion}.dist-info/METADATA`
  const sitePackages = platform === 'win32'
    ? 'python/Lib/site-packages'
    : 'python/lib/python3.12/site-packages'
  const documentDependencies: Array<{
    name: string
    version: string
    distInfo: string
    modules: string[]
    license?: string
  }> = [
    { name: 'python-docx', version: '1.2.0', distInfo: 'python_docx-1.2.0', modules: ['docx/__init__.py'] },
    { name: 'lxml', version: '6.1.1', distInfo: 'lxml-6.1.1', modules: ['lxml/__init__.py'] },
    {
      name: 'PyMuPDF',
      version: '1.28.2',
      distInfo: 'pymupdf-1.28.2',
      modules: ['fitz/__init__.py', 'pymupdf/__init__.py'],
    },
    { name: 'openpyxl', version: '3.1.5', distInfo: 'openpyxl-3.1.5', modules: ['openpyxl/__init__.py'] },
    { name: 'xlrd', version: '2.0.2', distInfo: 'xlrd-2.0.2', modules: ['xlrd/__init__.py'] },
    { name: 'et-xmlfile', version: '2.0.0', distInfo: 'et_xmlfile-2.0.0', modules: ['et_xmlfile/__init__.py'] },
    {
      name: 'python-pptx',
      version: '1.0.2',
      distInfo: 'python_pptx-1.0.2',
      modules: ['pptx/__init__.py'],
      license: 'LICENSE',
    },
    {
      name: 'Pillow',
      version: '12.3.0',
      distInfo: 'pillow-12.3.0',
      modules: ['PIL/__init__.py'],
      license: 'licenses/LICENSE',
    },
    {
      name: 'XlsxWriter',
      version: '3.2.5',
      distInfo: 'xlsxwriter-3.2.5',
      modules: ['xlsxwriter/__init__.py'],
      license: 'LICENSE.txt',
    },
    {
      name: 'typing-extensions',
      version: '4.16.0',
      distInfo: 'typing_extensions-4.16.0',
      modules: ['typing_extensions.py'],
    },
  ] as const
  const ordinaryPaths = [python, 'python/lib/stdlib.py']
  if (options.includePaddleModule !== false) ordinaryPaths.push(paddleModule)
  for (const dependency of documentDependencies) {
    for (const module of dependency.modules) {
      if (dependency.name !== 'python-pptx' || options.includePptxModule !== false) {
        ordinaryPaths.push(`${sitePackages}/${module}`)
      }
    }
    const metadata = `${sitePackages}/${dependency.distInfo}.dist-info/METADATA`
    ordinaryPaths.push(metadata)
    if (dependency.license !== undefined
      && (dependency.name !== 'python-pptx' || options.includePptxLicense !== false)) {
      ordinaryPaths.push(`${sitePackages}/${dependency.distInfo}.dist-info/${dependency.license}`)
    }
  }
  for (const path of ordinaryPaths) {
    mkdirSync(dirname(join(root, 'files', path)), { recursive: true })
    writeFileSync(join(root, 'files', path), `${path}\n`)
  }
  for (const dependency of documentDependencies) {
    const metadata = `${sitePackages}/${dependency.distInfo}.dist-info/METADATA`
    writeFileSync(
      join(root, 'files', metadata),
      `Metadata-Version: 2.4\nName: ${dependency.name}\nVersion: ${dependency.version}\n`,
    )
  }
  mkdirSync(dirname(join(root, 'files', paddleMetadata)), { recursive: true })
  writeFileSync(join(root, 'files', paddleMetadata), `Metadata-Version: 2.4\nName: paddleocr-mcp\nVersion: ${paddleVersion}\n`)
  const paths = [...ordinaryPaths, paddleMetadata].sort()
  const files = Object.fromEntries(paths.map(path => [
    path,
    createHash('sha256').update(readFileSync(join(root, 'files', path))).digest('hex'),
  ]))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }))
  const index = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    productId: 'cn.dongjian.desktop',
    clientVersion,
    platform,
    arch: 'arm64',
    signingTier,
    executables: { python },
    files,
    links: {},
  }, null, 2)}\n`)
  writeFileSync(join(root, 'runtime-index.json'), index)
  writeFileSync(join(root, 'runtime-index.sig'), `${sign(null, index, privateKey).toString('base64')}\n`)
  writeFileSync(join(root, 'runtime-index.pub.pem'), publicKeyPem)
  return {
    root,
    anchor: {
      expectedPublicKeySha256: createHash('sha256').update(publicKeyPem).digest('hex'),
      expectedSigningTier: signingTier,
      expectedPlatform: platform,
      expectedArch: 'arm64' as const,
      expectedClientVersion: clientVersion,
    },
  }
}

describe('packaged product runtime verifier', () => {
  it('accepts an exact formally signed Python document runtime', () => {
    const value = fixture({ tier: 'formal' })
    const verified = verifyProductRuntime(value.root, value.anchor)
    expect(verified.signingTier).toBe('formal')
    expect(verified.pythonExecutableSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(verified.paddleOcrMcpVersion).toBe('0.8.5')
    expect(verified.documentRuntimeVersions['python-pptx']).toBe('1.0.2')
    expect(verified.indexSha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('binds a staged runtime to the explicitly selected target client version', () => {
    const target = fixture({ clientVersion: '0.2.6' })
    expect(verifyProductRuntime(target.root, target.anchor).indexSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(() => verifyProductRuntime(target.root, {
      ...target.anchor,
      expectedClientVersion: '0.2.5',
    })).toThrow(/身份或结构无效/u)
  })

  it('keeps concurrent startup verification equivalent and fail-closed', async () => {
    const accepted = fixture({ tier: 'formal' })
    await expect(verifyProductRuntimeForStartup(accepted.root, accepted.anchor)).resolves.toMatchObject({
      signingTier: 'formal',
      paddleOcrMcpVersion: '0.8.5',
    })

    const drift = fixture({ tier: 'formal' })
    writeFileSync(join(drift.root, 'files', 'python/lib/stdlib.py'), 'tampered\n')
    await expect(verifyProductRuntimeForStartup(drift.root, drift.anchor)).rejects.toThrow(/完整性校验未通过/u)
  })

  it('rejects file drift, an extra file, a replacement key, and platform drift', () => {
    const drift = fixture()
    writeFileSync(join(drift.root, 'files', 'python/lib/stdlib.py'), 'tampered\n')
    expect(() => verifyProductRuntime(drift.root, drift.anchor)).toThrow(/完整性校验未通过/u)

    const extra = fixture()
    writeFileSync(join(extra.root, 'files', 'unexpected'), 'extra\n')
    expect(() => verifyProductRuntime(extra.root, extra.anchor)).toThrow(/多出：unexpected/u)

    const replacement = fixture()
    expect(() => verifyProductRuntime(replacement.root, {
      ...replacement.anchor,
      expectedPublicKeySha256: '0'.repeat(64),
    })).toThrow(/不属于当前签名宿主/u)

    const platform = fixture()
    expect(() => verifyProductRuntime(platform.root, {
      ...platform.anchor,
      expectedPlatform: 'win32',
    })).toThrow(/身份或结构无效/u)
  })

  it('rejects runtime symlinks and a signing tier not compiled into the host', () => {
    const linked = fixture()
    symlinkSync(join(linked.root, 'files', 'python/lib/stdlib.py'), join(linked.root, 'files', 'python/lib/link.py'))
    expect(() => verifyProductRuntime(linked.root, linked.anchor)).toThrow(/符号链接/u)

    const formal = fixture({ tier: 'formal' })
    expect(() => verifyProductRuntime(formal.root, {
      ...formal.anchor,
      expectedSigningTier: 'development-candidate',
    })).toThrow(/身份或结构无效/u)
  })

  it('rejects an unreviewed or missing PaddleOCR MCP runtime', () => {
    const wrongVersion = fixture({ paddleVersion: '0.8.4' })
    expect(() => verifyProductRuntime(wrongVersion.root, wrongVersion.anchor)).toThrow(/身份无效/u)

    const missingModule = fixture({ includePaddleModule: false })
    expect(() => verifyProductRuntime(missingModule.root, missingModule.anchor)).toThrow(/必须内置唯一/u)
  })

  it('rejects a signed runtime that omitted the python-pptx module', () => {
    const missingPptx = fixture({ includePptxModule: false })
    expect(() => verifyProductRuntime(missingPptx.root, missingPptx.anchor)).toThrow(
      /文档模块不完整：python-pptx/u,
    )
  })

  it('rejects a signed runtime that omitted the python-pptx license', () => {
    const missingLicense = fixture({ includePptxLicense: false })
    expect(() => verifyProductRuntime(missingLicense.root, missingLicense.anchor)).toThrow(
      /文档依赖许可证不完整：python-pptx/u,
    )
  })
})
