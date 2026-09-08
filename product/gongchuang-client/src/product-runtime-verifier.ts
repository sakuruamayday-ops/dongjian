/** Ed25519 and full-tree verifier for packaged Python document resources. */

import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { GONGCHUANG_PADDLEOCR_MCP_VERSION } from '@gongchuang/signed-skill-runtime'

interface ProductRuntimeIndex {
  schemaVersion: number
  productId: unknown
  clientVersion: unknown
  platform: unknown
  arch: unknown
  signingTier: unknown
  executables: unknown
  files: unknown
  links: unknown
}

/** Reviewed PaddleOCR MCP release embedded in every product runtime. */
export const EXPECTED_PADDLEOCR_MCP_VERSION = GONGCHUANG_PADDLEOCR_MCP_VERSION

/** Host-compiled expectations for one platform runtime bundle. */
export interface ProductRuntimeTrustAnchor {
  readonly expectedPublicKeySha256: string
  readonly expectedSigningTier: 'development-candidate' | 'formal'
  readonly expectedPlatform: 'darwin' | 'win32'
  readonly expectedArch: 'arm64' | 'x64'
  readonly expectedClientVersion: string
}

/** Exact runtime identity retained after full-tree verification. */
export interface VerifiedProductRuntime {
  readonly filesRoot: string
  readonly signingTier: 'development-candidate' | 'formal'
  readonly indexSha256: string
  readonly publicKeySha256: string
  readonly fileHashes: Readonly<Record<string, string>>
  readonly pythonExecutable: string
  readonly pythonExecutableSha256: string
  readonly paddleOcrMcpVersion: string
  readonly documentRuntimeVersions: Readonly<Record<PythonDocumentDistribution, string>>
}

/** Reviewed Python distributions that provide product document generation. */
export type PythonDocumentDistribution =
  | 'python-docx'
  | 'lxml'
  | 'pymupdf'
  | 'openpyxl'
  | 'xlrd'
  | 'et-xmlfile'
  | 'python-pptx'
  | 'pillow'
  | 'xlsxwriter'
  | 'typing-extensions'

interface PythonDocumentDependency {
  readonly distribution: PythonDocumentDistribution
  readonly version: string
  readonly moduleMarkers: readonly RegExp[]
  readonly licenseMarker?: RegExp
}

const PYTHON_DOCUMENT_DEPENDENCIES: readonly PythonDocumentDependency[] = [
  {
    distribution: 'python-docx',
    version: '1.2.0',
    moduleMarkers: [/^python\/.+\/site-packages\/docx\/__init__\.py$/u],
  },
  {
    distribution: 'lxml',
    version: '6.1.1',
    moduleMarkers: [/^python\/.+\/site-packages\/lxml\/__init__\.py$/u],
  },
  {
    distribution: 'pymupdf',
    version: '1.28.2',
    moduleMarkers: [
      /^python\/.+\/site-packages\/fitz\/__init__\.py$/u,
      /^python\/.+\/site-packages\/pymupdf\/__init__\.py$/u,
    ],
  },
  {
    distribution: 'openpyxl',
    version: '3.1.5',
    moduleMarkers: [/^python\/.+\/site-packages\/openpyxl\/__init__\.py$/u],
  },
  {
    distribution: 'xlrd',
    version: '2.0.2',
    moduleMarkers: [/^python\/.+\/site-packages\/xlrd\/__init__\.py$/u],
  },
  {
    distribution: 'et-xmlfile',
    version: '2.0.0',
    moduleMarkers: [/^python\/.+\/site-packages\/et_xmlfile\/__init__\.py$/u],
  },
  {
    distribution: 'python-pptx',
    version: '1.0.2',
    moduleMarkers: [/^python\/.+\/site-packages\/pptx\/__init__\.py$/u],
    licenseMarker: /^python\/.+\/site-packages\/python_pptx-1\.0\.2\.dist-info\/LICENSE$/u,
  },
  {
    distribution: 'pillow',
    version: '12.3.0',
    moduleMarkers: [/^python\/.+\/site-packages\/PIL\/__init__\.py$/u],
    licenseMarker: /^python\/.+\/site-packages\/pillow-12\.3\.0\.dist-info\/licenses\/LICENSE$/u,
  },
  {
    distribution: 'xlsxwriter',
    version: '3.2.5',
    moduleMarkers: [/^python\/.+\/site-packages\/xlsxwriter\/__init__\.py$/u],
    licenseMarker: /^python\/.+\/site-packages\/xlsxwriter-3\.2\.5\.dist-info\/LICENSE\.txt$/u,
  },
  {
    distribution: 'typing-extensions',
    version: '4.16.0',
    moduleMarkers: [/^python\/.+\/site-packages\/typing_extensions\.py$/u],
  },
]

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function runtimeEntries(root: string, current = root): { files: string[]; links: Record<string, string> } {
  const files: string[] = []
  const links: Record<string, string> = {}
  const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const absolute = join(current, entry.name)
    const portable = relative(root, absolute).split(sep).join('/')
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(absolute)
      const resolved = realpathSync(absolute)
      if (isAbsolute(target) || !contained(root, resolved) || resolved === absolute) {
        throw new Error(`产品运行时符号链接越出签名目录：${absolute}`)
      }
      links[portable] = target.split(sep).join('/')
    } else if (entry.isDirectory()) {
      const nested = runtimeEntries(root, absolute)
      files.push(...nested.files)
      Object.assign(links, nested.links)
    } else if (entry.isFile()) files.push(portable)
    else throw new Error(`产品运行时包含不支持的文件类型：${absolute}`)
  }
  return { files, links }
}

function portablePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function executableMap(value: unknown): { python: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('产品运行时可执行文件映射无效')
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== 1 || typeof row.python !== 'string' || !portablePath(row.python)) {
    throw new Error('产品运行时可执行文件映射无效')
  }
  return { python: row.python }
}

/**
 * Prove the copied Python tree contains exactly one reviewed PaddleOCR MCP
 * module and distribution record. The surrounding runtime signature covers
 * both files and the complete dependency tree; this check pins the package
 * identity instead of downloading code through uvx at first use.
 */
export function inspectPaddleOcrMcpRuntime(filesRoot: string, files: readonly string[]): string {
  const modulePaths = files.filter(path => /^python\/.+\/site-packages\/paddleocr_mcp\/__main__\.py$/iu.test(path))
  const metadataPaths = files.filter(path => /^python\/.+\/site-packages\/paddleocr_mcp-[^/]+\.dist-info\/METADATA$/iu.test(path))
  if (modulePaths.length !== 1 || metadataPaths.length !== 1) {
    throw new Error('产品运行时必须内置唯一的 PaddleOCR MCP 模块与发行元数据')
  }
  const metadata = readFileSync(join(filesRoot, metadataPaths[0] ?? ''), 'utf8')
  const name = /^Name:\s*(.+)$/imu.exec(metadata)?.[1]?.trim().toLowerCase().replace(/[._-]+/gu, '-')
  const version = /^Version:\s*(.+)$/imu.exec(metadata)?.[1]?.trim()
  if (name !== 'paddleocr-mcp' || version !== EXPECTED_PADDLEOCR_MCP_VERSION) {
    throw new Error(`产品运行时 PaddleOCR MCP 身份无效：${name ?? 'unknown'}@${version ?? 'unknown'}`)
  }
  return version
}

function canonicalDistribution(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[._-]+/gu, '-')
}

/**
 * Prove that the signed runtime retains the reviewed DOCX, XLSX, PPTX, and PDF
 * Python dependency closure used by the product's document skills.
 * @param filesRoot - Verified runtime `files` directory.
 * @param files - Exact portable file set covered by the runtime signature.
 * @returns Reviewed distribution versions keyed by canonical package name.
 */
export function inspectPythonDocumentRuntime(
  filesRoot: string,
  files: readonly string[],
): Readonly<Record<PythonDocumentDistribution, string>> {
  const versions = {} as Record<PythonDocumentDistribution, string>
  for (const dependency of PYTHON_DOCUMENT_DEPENDENCIES) {
    for (const marker of dependency.moduleMarkers) {
      if (files.filter(path => marker.test(path)).length !== 1) {
        throw new Error(`产品运行时文档模块不完整：${dependency.distribution}`)
      }
    }
    if (dependency.licenseMarker !== undefined
      && files.filter(path => dependency.licenseMarker?.test(path) ?? false).length !== 1) {
      throw new Error(`产品运行时文档依赖许可证不完整：${dependency.distribution}`)
    }
    const metadataPaths = files.filter(path => (
      /^python\/.+\/site-packages\/[^/]+\.dist-info\/METADATA$/iu.test(path)
      && canonicalDistribution(/^python\/.+\/site-packages\/([^/]+)\.dist-info\/METADATA$/iu.exec(path)?.[1] ?? '')
        .startsWith(`${dependency.distribution}-`)
    ))
    if (metadataPaths.length !== 1) {
      throw new Error(`产品运行时文档发行元数据不完整：${dependency.distribution}`)
    }
    const metadata = readFileSync(join(filesRoot, metadataPaths[0] ?? ''), 'utf8')
    const name = canonicalDistribution(/^Name:\s*(.+)$/imu.exec(metadata)?.[1] ?? '')
    const version = /^Version:\s*(.+)$/imu.exec(metadata)?.[1]?.trim()
    if (name !== dependency.distribution || version !== dependency.version) {
      throw new Error(
        `产品运行时文档依赖身份无效：${name || 'unknown'}@${version ?? 'unknown'}`,
      )
    }
    versions[dependency.distribution] = version
  }
  return Object.freeze(versions)
}

interface PreparedProductRuntime {
  readonly filesRoot: string
  readonly files: Record<string, string>
  readonly actualFiles: string[]
  readonly executables: { python: string }
  readonly signingTier: ProductRuntimeTrustAnchor['expectedSigningTier']
  readonly indexSha256: string
  readonly publicKeySha256: string
}

function prepareProductRuntime(root: string, anchor: ProductRuntimeTrustAnchor): PreparedProductRuntime {
  if (!/^[0-9a-f]{64}$/u.test(anchor.expectedPublicKeySha256)) throw new Error('产品运行时宿主公钥指纹无效')
  const indexBytes = readFileSync(join(root, 'runtime-index.json'))
  const signature = readFileSync(join(root, 'runtime-index.sig'), 'utf8').trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(signature)) throw new Error('产品运行时签名不是规范 Base64')
  const publicKeyPem = readFileSync(join(root, 'runtime-index.pub.pem'))
  const publicKeySha256 = createHash('sha256').update(publicKeyPem).digest('hex')
  if (publicKeySha256 !== anchor.expectedPublicKeySha256) throw new Error('产品运行时公钥不属于当前签名宿主')
  if (!verify(null, indexBytes, createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'))) {
    throw new Error('产品运行时 Ed25519 签名无效')
  }
  const index = JSON.parse(indexBytes.toString('utf8')) as ProductRuntimeIndex
  if (index.schemaVersion !== 2 || index.productId !== 'cn.dongjian.desktop'
    || index.clientVersion !== anchor.expectedClientVersion || index.platform !== anchor.expectedPlatform
    || index.arch !== anchor.expectedArch || index.signingTier !== anchor.expectedSigningTier
    || typeof index.files !== 'object' || index.files === null || Array.isArray(index.files)
    || typeof index.links !== 'object' || index.links === null || Array.isArray(index.links)) {
    throw new Error('产品运行时索引身份或结构无效')
  }
  const executables = executableMap(index.executables)
  const files = Object.fromEntries(Object.entries(index.files).map(([path, digest]) => {
    if (!portablePath(path) || typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)) {
      throw new Error(`产品运行时完整性记录无效：${path}`)
    }
    return [path, digest]
  }))
  const links = Object.fromEntries(Object.entries(index.links).map(([path, target]) => {
    if (!portablePath(path) || typeof target !== 'string' || target === '' || target.includes('\\')
      || target.includes('\0') || isAbsolute(target) || files[path] !== undefined) {
      throw new Error(`产品运行时符号链接记录无效：${path}`)
    }
    return [path, target]
  }))
  // macOS exposes temporary directories through both `/var` and
  // `/private/var`. Canonicalize the signed root before comparing resolved
  // symlink targets so that this system alias is not mistaken for an escape.
  const filesRoot = realpathSync(join(root, 'files'))
  // Recursive directory order is not global path order when sibling names
  // share a prefix (for example `paddleocr_mcp/` and
  // `paddleocr_mcp-0.8.5.dist-info/`). Compare canonical sorted path sets.
  const actual = runtimeEntries(filesRoot)
  const actualFiles = actual.files.sort()
  const expectedFiles = Object.keys(files).sort()
  if (actualFiles.length !== expectedFiles.length
    || actualFiles.some((path, indexValue) => path !== expectedFiles[indexValue])) {
    const actualSet = new Set(actualFiles)
    const expectedSet = new Set(expectedFiles)
    const missing = expectedFiles.filter(path => !actualSet.has(path)).slice(0, 5)
    const unexpected = actualFiles.filter(path => !expectedSet.has(path)).slice(0, 5)
    const detail = [
      `实际 ${String(actualFiles.length)} 项，签名索引 ${String(expectedFiles.length)} 项`,
      missing.length === 0 ? '' : `缺少：${missing.join('、')}`,
      unexpected.length === 0 ? '' : `多出：${unexpected.join('、')}`,
    ].filter(Boolean).join('；')
    throw new Error(`产品运行时文件集合与签名索引不一致：${detail}`)
  }
  const actualLinks = Object.keys(actual.links).sort()
  const expectedLinks = Object.keys(links).sort()
  if (actualLinks.length !== expectedLinks.length
    || actualLinks.some((path, indexValue) => path !== expectedLinks[indexValue])) {
    throw new Error('产品运行时符号链接集合与签名索引不一致')
  }
  for (const path of actualLinks) {
    if (actual.links[path] !== links[path]) throw new Error(`产品运行时符号链接目标不一致：${path}`)
    const resolved = resolve(dirname(join(filesRoot, path)), links[path] ?? '')
    if (!contained(filesRoot, resolved) || resolved === join(filesRoot, path)) {
      throw new Error(`产品运行时符号链接目标无效：${path}`)
    }
  }
  return {
    filesRoot,
    files,
    actualFiles,
    executables,
    signingTier: anchor.expectedSigningTier,
    indexSha256: createHash('sha256').update(indexBytes).digest('hex'),
    publicKeySha256,
  }
}

function completeProductRuntime(prepared: PreparedProductRuntime): VerifiedProductRuntime {
  const { actualFiles, executables, files, filesRoot } = prepared
  const paddleOcrMcpVersion = inspectPaddleOcrMcpRuntime(filesRoot, actualFiles)
  const documentRuntimeVersions = inspectPythonDocumentRuntime(filesRoot, actualFiles)
  if (files[executables.python] === undefined) throw new Error(`产品运行时索引未登记可执行文件：${executables.python}`)
  return Object.freeze({
    filesRoot,
    signingTier: prepared.signingTier,
    indexSha256: prepared.indexSha256,
    publicKeySha256: prepared.publicKeySha256,
    fileHashes: Object.freeze({ ...files }),
    pythonExecutable: join(filesRoot, executables.python),
    pythonExecutableSha256: files[executables.python] ?? '',
    paddleOcrMcpVersion,
    documentRuntimeVersions,
  })
}

function verifyRuntimeFilesSync(prepared: PreparedProductRuntime): void {
  for (const path of prepared.actualFiles) {
    const digest = createHash('sha256').update(readFileSync(join(prepared.filesRoot, path))).digest('hex')
    if (digest !== prepared.files[path]) throw new Error(`产品运行时文件完整性校验未通过：${path}`)
  }
}

async function verifyRuntimeFilesConcurrently(prepared: PreparedProductRuntime): Promise<void> {
  let cursor = 0
  const verifyNext = async (): Promise<void> => {
    while (cursor < prepared.actualFiles.length) {
      const path = prepared.actualFiles[cursor]
      cursor += 1
      if (path === undefined) return
      const digest = createHash('sha256').update(await readFile(join(prepared.filesRoot, path))).digest('hex')
      if (digest !== prepared.files[path]) throw new Error(`产品运行时文件完整性校验未通过：${path}`)
    }
  }
  // Startup still hashes every installed byte: the signed index authenticates
  // expected digests but cannot prove that the mutable files tree still has
  // them. Concurrency reduces wall time without turning prior results into a
  // cache or weakening exact-file-set verification.
  const readers = Math.min(availableParallelism(), prepared.actualFiles.length)
  await Promise.all(Array.from({ length: readers }, verifyNext))
}

/**
 * Verify the packaged runtime signature, identity, exact file set, and every file digest.
 * @param root - Directory containing the index envelope and `files` tree.
 * @param anchor - Host-pinned signing identity, tier, platform, and architecture.
 * @returns Immutable executable paths and digests from the verified index.
 */
export function verifyProductRuntime(root: string, anchor: ProductRuntimeTrustAnchor): VerifiedProductRuntime {
  const prepared = prepareProductRuntime(root, anchor)
  verifyRuntimeFilesSync(prepared)
  return completeProductRuntime(prepared)
}

/**
 * Verify the same complete runtime with bounded concurrent file reads for desktop startup.
 * @param root - Directory containing the index envelope and `files` tree.
 * @param anchor - Host-pinned signing identity, tier, platform, and architecture.
 * @returns Immutable executable paths and digests from the verified index.
 */
export async function verifyProductRuntimeForStartup(
  root: string,
  anchor: ProductRuntimeTrustAnchor,
): Promise<VerifiedProductRuntime> {
  const prepared = prepareProductRuntime(root, anchor)
  await verifyRuntimeFilesConcurrently(prepared)
  return completeProductRuntime(prepared)
}
