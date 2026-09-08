import { createHash, generateKeyPairSync } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { verifyProductRuntime } from '../../../product/gongchuang-client/src/product-runtime-verifier.ts'
import { GONGCHUANG_CLIENT_VERSION } from '../../../product/gongchuang-client/src/product-version.ts'

const script = resolve(import.meta.dirname, '../../../product/gongchuang-client/scripts/stage-product-runtime.ts')

function executable(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
}

function fixture(): {
  root: string
  python: string
  overlay: string
  out: string
  trash: string
  key: string
  entitlements: string
  publicKeySha256: string
} {
  const root = mkdtempSync(join(tmpdir(), 'gongchuang-stage-runtime-'))
  const python = join(root, 'python-source')
  const overlay = join(root, 'python-overlay')
  const out = join(root, 'product-runtime')
  const trash = join(root, 'system-trash-fixture')
  mkdirSync(trash)
  executable(join(python, 'bin', 'python3.13'))
  executable(join(python, 'python.exe'))
  symlinkSync('python3.13', join(python, 'bin', 'python3'))
  symlinkSync('python3.13', join(python, 'bin', 'python'))
  writeFileSync(join(python, 'stdlib.py'), 'stdlib\n')
  mkdirSync(join(python, '__pycache__'), { recursive: true })
  writeFileSync(join(python, '__pycache__', 'stdlib.cpython-313.pyc'), 'build cache\n')
  writeFileSync(join(python, 'legacy.py'), '# retained optimized source\n')
  writeFileSync(join(python, 'legacy.pyo'), 'optimized build cache\n')
  const paddleModule = join(python, 'lib', 'python3.12', 'site-packages', 'paddleocr_mcp', '__main__.py')
  const paddleMetadata = join(python, 'lib', 'python3.12', 'site-packages', 'paddleocr_mcp-0.8.5.dist-info', 'METADATA')
  mkdirSync(dirname(paddleModule), { recursive: true })
  mkdirSync(dirname(paddleMetadata), { recursive: true })
  writeFileSync(paddleModule, '# signed paddleocr mcp fixture\n')
  writeFileSync(paddleMetadata, 'Metadata-Version: 2.4\nName: paddleocr_mcp\nVersion: 0.8.5\n')
  const localOcr = join(dirname(paddleModule), 'inference', 'ocr', 'local.py')
  mkdirSync(dirname(localOcr), { recursive: true })
  writeFileSync(localOcr, [
    'from paddleocr import PaddleOCR',
    '',
    'class OCRLocalInference:',
    '    async def start(self) -> None:',
    '        self._inference = PaddleOCR()',
    '',
  ].join('\n'))
  const sitePackages = dirname(dirname(paddleModule))
  writeFileSync(join(sitePackages, 'typing_extensions.py'), '# pinned dependency\n')
  const typingMetadata = join(sitePackages, 'typing_extensions-4.16.0.dist-info', 'METADATA')
  mkdirSync(dirname(typingMetadata), { recursive: true })
  writeFileSync(typingMetadata, 'Name: typing_extensions\nVersion: 4.16.0\n')
  mkdirSync(join(sitePackages, 'cv2'), { recursive: true })
  writeFileSync(join(sitePackages, 'cv2', 'native.bin'), 'local inference only\n')
  mkdirSync(join(sitePackages, 'pandas', 'tests'), { recursive: true })
  writeFileSync(join(sitePackages, 'pandas', 'core.py'), 'local inference only\n')
  writeFileSync(join(sitePackages, 'pandas', 'tests', 'test_core.py'), 'not a runtime dependency\n')
  mkdirSync(join(sitePackages, 'retained_dependency', 'tests'), { recursive: true })
  writeFileSync(join(sitePackages, 'retained_dependency', '__init__.py'), 'retained = True\n')
  writeFileSync(join(sitePackages, 'retained_dependency', 'tests', 'test_runtime.py'), 'not shipped\n')
  mkdirSync(join(python, 'include'), { recursive: true })
  writeFileSync(join(python, 'include', 'Python.h'), 'development header\n')
  const overlayPackages: Array<{
    moduleRoots: string[]
    distInfo: string
    name: string
    version: string
    tags: string[]
    license?: string
  }> = [
    {
      moduleRoots: ['docx'],
      distInfo: 'python_docx-1.2.0.dist-info',
      name: 'python-docx',
      version: '1.2.0',
      tags: ['py3-none-any'],
    },
    {
      moduleRoots: ['lxml'],
      distInfo: 'lxml-6.1.1.dist-info',
      name: 'lxml',
      version: '6.1.1',
      tags: [
        'cp313-cp313-macosx_10_13_universal2',
        'cp313-cp313-win_amd64',
      ],
    },
    {
      moduleRoots: ['fitz', 'pymupdf'],
      distInfo: 'pymupdf-1.28.2.dist-info',
      name: 'PyMuPDF',
      version: '1.28.2',
      tags: [
        'cp310-abi3-macosx_11_0_arm64',
        'cp310-abi3-win_amd64',
      ],
    },
    {
      moduleRoots: ['openpyxl'],
      distInfo: 'openpyxl-3.1.5.dist-info',
      name: 'openpyxl',
      version: '3.1.5',
      tags: ['py2-none-any', 'py3-none-any'],
    },
    {
      moduleRoots: ['xlrd'],
      distInfo: 'xlrd-2.0.2.dist-info',
      name: 'xlrd',
      version: '2.0.2',
      tags: ['py2-none-any', 'py3-none-any'],
    },
    {
      moduleRoots: ['et_xmlfile'],
      distInfo: 'et_xmlfile-2.0.0.dist-info',
      name: 'et-xmlfile',
      version: '2.0.0',
      tags: ['py3-none-any'],
    },
    {
      moduleRoots: ['pptx'],
      distInfo: 'python_pptx-1.0.2.dist-info',
      name: 'python-pptx',
      version: '1.0.2',
      tags: ['py3-none-any'],
      license: 'LICENSE',
    },
    {
      moduleRoots: ['PIL'],
      distInfo: 'pillow-12.3.0.dist-info',
      name: 'Pillow',
      version: '12.3.0',
      tags: [
        'cp313-cp313-macosx_11_0_arm64',
        'cp313-cp313-win_amd64',
      ],
      license: 'licenses/LICENSE',
    },
    {
      moduleRoots: ['xlsxwriter'],
      distInfo: 'xlsxwriter-3.2.5.dist-info',
      name: 'XlsxWriter',
      version: '3.2.5',
      tags: ['py3-none-any'],
      license: 'LICENSE.txt',
    },
  ]
  for (const dependency of overlayPackages) {
    for (const moduleRoot of dependency.moduleRoots) {
      mkdirSync(join(overlay, moduleRoot), { recursive: true })
      writeFileSync(join(overlay, moduleRoot, '__init__.py'), '# pinned overlay module\n')
    }
    const distInfo = join(overlay, dependency.distInfo)
    mkdirSync(distInfo, { recursive: true })
    writeFileSync(join(distInfo, 'METADATA'), `Name: ${dependency.name}\nVersion: ${dependency.version}\n`)
    writeFileSync(join(distInfo, 'WHEEL'), `${dependency.tags.map(tag => `Tag: ${tag}`).join('\n')}\n`)
    if (dependency.license !== undefined) {
      const license = join(distInfo, dependency.license)
      mkdirSync(dirname(license), { recursive: true })
      writeFileSync(license, `${dependency.name} fixture license\n`)
    }
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const key = join(root, 'runtime-signing.pem')
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const entitlements = join(root, 'runtime-entitlements.plist')
  writeFileSync(entitlements, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    '<key>com.apple.security.cs.disable-library-validation</key><true/>',
    '</dict></plist>',
    '',
  ].join('\n'))
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
  return {
    root,
    python,
    overlay,
    out,
    trash,
    key,
    entitlements,
    publicKeySha256: createHash('sha256').update(publicPem).digest('hex'),
  }
}

function stage(
  paths: ReturnType<typeof fixture>,
  platform: 'darwin' | 'win32' = 'darwin',
  arch: 'arm64' | 'x64' = 'arm64',
  tier: 'development-candidate' | 'formal' = 'development-candidate',
): void {
  const argv = [
    '--import', 'tsx/esm',
    script,
    '--python', paths.python,
    '--python-overlay', paths.overlay,
    '--out', paths.out,
    '--key', paths.key,
    '--tier', tier,
    '--platform', platform,
    '--arch', arch,
  ]
  if (platform === 'darwin') argv.push('--macos-entitlements', paths.entitlements)
  execFileSync(process.execPath, argv, {
    stdio: 'pipe',
    env: {
      ...process.env,
      // Production staging defaults to macOS Trash. Tests inject an isolated
      // recovery root so the same no-permanent-delete path also runs on CI.
      GONGCHUANG_STAGE_TRASH_ROOT: paths.trash,
    },
  })
}

describe('product runtime staging', () => {
  it('copies executable modes, signs the exact tree, and promotes a verifiable formal runtime', () => {
    const paths = fixture()
    stage(paths, 'darwin', 'arm64', 'formal')
    const verified = verifyProductRuntime(paths.out, {
      expectedPublicKeySha256: paths.publicKeySha256,
      expectedSigningTier: 'formal',
      expectedPlatform: 'darwin',
      expectedArch: 'arm64',
      expectedClientVersion: GONGCHUANG_CLIENT_VERSION,
    })
    expect(verified.signingTier).toBe('formal')
    expect(verified.pythonExecutableSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(verified.paddleOcrMcpVersion).toBe('0.8.5')
    expect(lstatSync(join(paths.out, 'files', 'python', 'bin', 'python3')).isFile()).toBe(true)
    expect(readlinkSync(join(paths.out, 'files', 'python', 'bin', 'python'))).toBe('python3')
    expect(readlinkSync(join(paths.out, 'files', 'python', 'bin', 'python3.13'))).toBe('python3')
    expect(verified.fileHashes).not.toHaveProperty('python/__pycache__/stdlib.cpython-313.pyc')
    expect(verified.fileHashes).not.toHaveProperty('python/legacy.pyo')
    expect(verified.fileHashes).not.toHaveProperty('python/include/Python.h')
    expect(readFileSync(join(paths.python, '__pycache__', 'stdlib.cpython-313.pyc'), 'utf8')).toBe('build cache\n')
    expect(readFileSync(join(paths.python, 'legacy.pyo'), 'utf8')).toBe('optimized build cache\n')
    expect(readFileSync(join(paths.python, 'include', 'Python.h'), 'utf8')).toBe('development header\n')
    const recoveryEntries = readdirSync(paths.trash, { recursive: true }).map(String)
    expect(recoveryEntries.some(path => path.endsWith('stdlib.cpython-313.pyc'))).toBe(true)
    expect(recoveryEntries.some(path => path.endsWith('legacy.pyo'))).toBe(true)
    expect(recoveryEntries.some(path => path.endsWith('include'))).toBe(true)
    expect(verified.fileHashes).not.toHaveProperty('python/lib/python3.12/site-packages/cv2/native.bin')
    expect(verified.fileHashes).not.toHaveProperty('python/lib/python3.12/site-packages/pandas/core.py')
    expect(verified.fileHashes).toHaveProperty('python/lib/python3.12/site-packages/retained_dependency/__init__.py')
    expect(verified.fileHashes).not.toHaveProperty('python/lib/python3.12/site-packages/retained_dependency/tests/test_runtime.py')
    expect(verified.fileHashes).toHaveProperty('python/lib/python3.12/site-packages/docx/__init__.py')
    expect(verified.fileHashes).toHaveProperty('python/lib/python3.12/site-packages/lxml/__init__.py')
    expect(verified.fileHashes).toHaveProperty('python/lib/python3.12/site-packages/fitz/__init__.py')
    expect(verified.fileHashes).toHaveProperty('python/lib/python3.12/site-packages/pymupdf/__init__.py')
    expect(verified.fileHashes).toHaveProperty('python/lib/python3.12/site-packages/openpyxl/__init__.py')
    expect(verified.fileHashes).toHaveProperty('python/lib/python3.12/site-packages/xlrd/__init__.py')
    expect(verified.fileHashes).toHaveProperty('python/lib/python3.12/site-packages/et_xmlfile/__init__.py')
    expect(verified.fileHashes).toHaveProperty('python/lib/python3.12/site-packages/pptx/__init__.py')
    expect(verified.fileHashes).toHaveProperty('python/lib/python3.12/site-packages/PIL/__init__.py')
    expect(verified.fileHashes).toHaveProperty('python/lib/python3.12/site-packages/xlsxwriter/__init__.py')
    expect(verified.fileHashes).toHaveProperty(
      'python/lib/python3.12/site-packages/python_pptx-1.0.2.dist-info/LICENSE',
    )
    expect(verified.fileHashes).toHaveProperty(
      'python/lib/python3.12/site-packages/pillow-12.3.0.dist-info/licenses/LICENSE',
    )
    expect(verified.fileHashes).toHaveProperty(
      'python/lib/python3.12/site-packages/xlsxwriter-3.2.5.dist-info/LICENSE.txt',
    )
    expect(verified.fileHashes).toHaveProperty(
      'python/lib/python3.12/site-packages/python_docx-1.2.0.dist-info/METADATA',
    )
    expect(verified.fileHashes).toHaveProperty(
      'python/lib/python3.12/site-packages/pymupdf-1.28.2.dist-info/METADATA',
    )
    expect(verified.documentRuntimeVersions).toEqual({
      'python-docx': '1.2.0',
      lxml: '6.1.1',
      pymupdf: '1.28.2',
      openpyxl: '3.1.5',
      xlrd: '2.0.2',
      'et-xmlfile': '2.0.0',
      'python-pptx': '1.0.2',
      pillow: '12.3.0',
      xlsxwriter: '3.2.5',
      'typing-extensions': '4.16.0',
    })
    const localOcr = readFileSync(join(
      paths.out,
      'files',
      'python',
      'lib',
      'python3.12',
      'site-packages',
      'paddleocr_mcp',
      'inference',
      'ocr',
      'local.py',
    ), 'utf8')
    expect(localOcr).not.toMatch(/^from paddleocr import PaddleOCR$/mu)
    expect(localOcr).toContain('    async def start(self) -> None:\n        from paddleocr import PaddleOCR\n')
  })

  it('preserves signed intra-root symlinks without duplicating their targets', () => {
    const paths = fixture()
    const resources = join(paths.python, 'share', 'runtime')
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, 'identity.txt'), 'signed internal resource\n')
    symlinkSync('share/runtime', join(paths.python, 'runtime-resources'))

    stage(paths)

    const stagedLink = join(paths.out, 'files', 'python', 'runtime-resources')
    expect(lstatSync(stagedLink).isSymbolicLink()).toBe(true)
    expect(readlinkSync(stagedLink)).toBe('share/runtime')
    expect(readFileSync(join(stagedLink, 'identity.txt'), 'utf8')).toBe('signed internal resource\n')

    const verified = verifyProductRuntime(paths.out, {
      expectedPublicKeySha256: paths.publicKeySha256,
      expectedSigningTier: 'development-candidate',
      expectedPlatform: 'darwin',
      expectedArch: 'arm64',
      expectedClientVersion: GONGCHUANG_CLIENT_VERSION,
    })
    expect(verified.pythonExecutable).toContain('python/bin/python3')
  })

  it('keeps the current runtime untouched when candidate construction fails', () => {
    const paths = fixture()
    mkdirSync(paths.out, { recursive: true })
    writeFileSync(join(paths.out, 'current.marker'), 'current\n')
    renameSync(
      join(paths.python, 'bin', 'python3'),
      join(paths.python, 'bin', 'python3.missing'),
    )
    expect(() => { stage(paths) }).toThrow()
    expect(readFileSync(join(paths.out, 'current.marker'), 'utf8')).toBe('current\n')
    expect(readdirSync(dirname(paths.out)).filter(name => name.startsWith(`${basename(paths.out)}.candidate-`)))
      .toEqual([])
    const recoveryEntries = readdirSync(paths.trash, { recursive: true }).map(String)
    expect(recoveryEntries.some(path => path.includes('gongchuang-runtime-failed-candidate-'))).toBe(true)
  })

  it('moves a superseded complete runtime to recoverable trash after promotion', () => {
    const paths = fixture()
    stage(paths)
    const firstIndex = readFileSync(join(paths.out, 'runtime-index.json'), 'utf8')

    stage(paths)

    expect(readFileSync(join(paths.out, 'runtime-index.json'), 'utf8')).toBe(firstIndex)
    expect(readdirSync(dirname(paths.out)).filter(name => name.startsWith(`${basename(paths.out)}.previous-`)))
      .toEqual([])
    const recoveryEntries = readdirSync(paths.trash, { recursive: true }).map(String)
    expect(recoveryEntries.some(path => path.includes('gongchuang-runtime-previous-'))).toBe(true)
  })

  it('does not prune a pyc-only runtime module without a retained source file', () => {
    const paths = fixture()
    const orphan = join(
      paths.python,
      'lib',
      'python3.12',
      '__pycache__',
      'orphan.cpython-312.pyc',
    )
    mkdirSync(dirname(orphan), { recursive: true })
    writeFileSync(orphan, 'only compiled runtime module\n')

    expect(() => { stage(paths) }).toThrow(/no retained source file/u)
  })

  it('does not promote a runtime that omitted the reviewed PaddleOCR MCP package', () => {
    const paths = fixture()
    mkdirSync(paths.out, { recursive: true })
    writeFileSync(join(paths.out, 'current.marker'), 'current\n')
    renameSync(
      join(paths.python, 'lib', 'python3.12', 'site-packages', 'paddleocr_mcp', '__main__.py'),
      join(paths.python, 'lib', 'python3.12', 'site-packages', 'paddleocr_mcp', '__main__.missing'),
    )

    expect(() => { stage(paths) }).toThrow()
    expect(readFileSync(join(paths.out, 'current.marker'), 'utf8')).toBe('current\n')
  })

  it('rejects a dependency overlay whose native wheel tag does not match the target', () => {
    const paths = fixture()
    writeFileSync(
      join(paths.overlay, 'lxml-6.1.1.dist-info', 'WHEEL'),
      'Tag: cp313-cp313-manylinux_2_28_x86_64\n',
    )

    expect(() => { stage(paths) }).toThrow(/dependency overlay identity mismatch/u)
  })

  it('accepts an already installed dependency only when it exactly matches the pinned wheel overlay', () => {
    const paths = fixture()
    const sitePackages = join(paths.python, 'lib', 'python3.12', 'site-packages')
    for (const name of ['PIL', 'pillow-12.3.0.dist-info']) {
      cpSync(join(paths.overlay, name), join(sitePackages, name), { recursive: true })
    }

    expect(() => { stage(paths) }).not.toThrow()
  })

  it('accepts installer-specific hashes only for external launchers in a matching wheel RECORD', () => {
    const paths = fixture()
    const sitePackages = join(paths.python, 'lib', 'python3.12', 'site-packages')
    for (const name of ['fitz', 'pymupdf', 'pymupdf-1.28.2.dist-info']) {
      cpSync(join(paths.overlay, name), join(sitePackages, name), { recursive: true })
    }
    const overlayRecord = join(paths.overlay, 'pymupdf-1.28.2.dist-info', 'RECORD')
    const installedRecord = join(sitePackages, 'pymupdf-1.28.2.dist-info', 'RECORD')
    writeFileSync(overlayRecord, [
      '../../bin/pymupdf,sha256=overlay,248',
      'pymupdf/__init__.py,sha256=shared,24',
      '',
    ].join('\n'))
    writeFileSync(installedRecord, [
      '../../bin/pymupdf,sha256=installed,264',
      'pymupdf/__init__.py,sha256=shared,24',
      '',
    ].join('\n'))

    expect(() => { stage(paths) }).not.toThrow()
  })

  it('rejects a preinstalled dependency that differs from the pinned wheel overlay', () => {
    const paths = fixture()
    const sitePackages = join(paths.python, 'lib', 'python3.12', 'site-packages')
    for (const name of ['PIL', 'pillow-12.3.0.dist-info']) {
      cpSync(join(paths.overlay, name), join(sitePackages, name), { recursive: true })
    }
    writeFileSync(join(sitePackages, 'PIL', '__init__.py'), '# tampered preinstalled dependency\n')

    expect(() => { stage(paths) }).toThrow(/overlay conflicts with an existing package: PIL/u)
  })

  it('rejects a dependency overlay that omitted a pinned runtime license', () => {
    const paths = fixture()
    renameSync(
      join(paths.overlay, 'python_pptx-1.0.2.dist-info', 'LICENSE'),
      join(paths.overlay, 'python_pptx-1.0.2.dist-info', 'LICENSE.missing'),
    )

    expect(() => { stage(paths) }).toThrow(/overlay license is absent: python-pptx/u)
  })

  it('removes package installers and unused setuptools launchers before signing a Windows runtime', () => {
    const paths = fixture()
    const sitePackages = join(paths.python, 'lib', 'python3.12', 'site-packages')
    const pip = join(sitePackages, 'pip')
    mkdirSync(join(pip, '_vendor'), { recursive: true })
    writeFileSync(join(pip, '__init__.py'), '# package installer\n')
    writeFileSync(join(pip, '_vendor', 'vendor.py'), '# package installer dependency\n')
    mkdirSync(join(sitePackages, 'pip-25.1.dist-info'), { recursive: true })
    writeFileSync(join(sitePackages, 'pip-25.1.dist-info', 'METADATA'), 'Name: pip\nVersion: 25.1\n')
    mkdirSync(join(paths.python, 'lib', 'python3.12', 'ensurepip'), { recursive: true })
    writeFileSync(join(paths.python, 'lib', 'python3.12', 'ensurepip', '__init__.py'), '# installer bootstrap\n')
    executable(join(paths.python, 'Scripts', 'pip.exe'))
    const setuptoolsRoots = [join(paths.python, 'lib', 'python3.12', 'site-packages', 'setuptools')]
    for (const root of setuptoolsRoots) {
      mkdirSync(root, { recursive: true })
      for (const name of [
        'cli.exe', 'cli-32.exe', 'cli-64.exe', 'cli-arm64.exe',
        'gui.exe', 'gui-32.exe', 'gui-64.exe', 'gui-arm64.exe',
      ]) executable(join(root, name))
      writeFileSync(join(root, '__init__.py'), '# retained setuptools package\n')
    }

    stage(paths, 'win32', 'x64')

    const verified = verifyProductRuntime(paths.out, {
      expectedPublicKeySha256: paths.publicKeySha256,
      expectedSigningTier: 'development-candidate',
      expectedPlatform: 'win32',
      expectedArch: 'x64',
      expectedClientVersion: GONGCHUANG_CLIENT_VERSION,
    })
    expect(Object.keys(verified.fileHashes).filter(path => /\/site-packages\/pip(?:\/|-)/iu.test(path))).toEqual([])
    expect(Object.keys(verified.fileHashes).filter(path => /\/ensurepip\//iu.test(path))).toEqual([])
    expect(Object.keys(verified.fileHashes).filter(path => /\/scripts\/pip(?:3(?:\.\d+)?)?\.exe$/iu.test(path)))
      .toEqual([])
    expect(Object.keys(verified.fileHashes).filter(path => /\/setuptools\/(?:cli|gui)(?:-(?:32|64|arm64))?\.exe$/iu.test(path)))
      .toEqual([])
    expect(verified.fileHashes).toHaveProperty(
      'python/lib/python3.12/site-packages/setuptools/__init__.py',
    )
  })

  it('uses the native Windows Recycle Bin when no staging trash override is configured', () => {
    const paths = fixture()
    const fakeBin = join(paths.root, 'fake-bin')
    const invocation = join(paths.root, 'powershell-invocation.txt')
    mkdirSync(fakeBin)
    const fakePowerShell = join(fakeBin, 'powershell.exe')
    writeFileSync(fakePowerShell, '#!/bin/sh\nprintf "%s\\n" "$@" > "$GONGCHUANG_FAKE_POWERSHELL_LOG"\n')
    chmodSync(fakePowerShell, 0o755)
    const argv = [
      process.execPath, script,
      '--python', paths.python,
      '--python-overlay', paths.overlay,
      '--out', paths.out,
      '--key', paths.key,
      '--tier', 'development-candidate',
      '--platform', 'win32',
      '--arch', 'x64',
    ]
    const bootstrap = [
      'Object.defineProperty(process, \'platform\', { value: \'win32\' })',
      `process.argv = ${JSON.stringify(argv)}`,
      `await import(${JSON.stringify(pathToFileURL(script).href)})`,
    ].join('; ')

    execFileSync(process.execPath, ['--import', 'tsx/esm', '--eval', bootstrap], {
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        GONGCHUANG_FAKE_POWERSHELL_LOG: invocation,
        GONGCHUANG_STAGE_TRASH_ROOT: '',
      },
    })

    expect(readFileSync(invocation, 'utf8')).toContain('-EncodedCommand')
    const verified = verifyProductRuntime(paths.out, {
      expectedPublicKeySha256: paths.publicKeySha256,
      expectedSigningTier: 'development-candidate',
      expectedPlatform: 'win32',
      expectedArch: 'x64',
      expectedClientVersion: GONGCHUANG_CLIENT_VERSION,
    })
    expect(verified.pythonExecutable).toContain('python/python.exe')
  })
})
