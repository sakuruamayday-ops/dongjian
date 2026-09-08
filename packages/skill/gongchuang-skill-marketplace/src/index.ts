/** Community skill marketplace for 共创企业助手. */

import { createHash } from 'node:crypto'
import {
  access, mkdir, readFile, rename, stat, writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK, isSkillName,
  type SkillCandidate, type SkillDefinition, type SkillProvider, type SkillProviderControl,
  type SkillViewOptions,
} from '@deepseek-ai/dsh-skill'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { strFromU8, unzipSync } from 'fflate'
import { parse as parseYaml } from 'yaml'
import { fetchPinnedRepositoryBytes } from './repository-https.ts'
import type {
  InstalledSkillView, MarketplaceSkillView, SkillInstallReceipt, SkillInstallRequest,
  MarketplaceRepositoryView, SkillMarketplaceSnapshot, SkillMarketplaceSource, SkillRepositoryAddReceipt,
  SkillRepositoryRemoveReceipt, SkillRepositoryRemoveRequest,
  SkillEnabledSetReceipt, SkillEnabledSetRequest, SkillRemoveReceipt, SkillRemoveRequest,
  SkillRepositoryAddRequest, SkillSearchPage, SkillSearchRequest,
} from './types.ts'

export type * from './types.ts'

const MODELSCOPE_API = 'https://www.modelscope.cn/openapi/v1'
const MODELSCOPE_WEB = 'https://modelscope.cn'
const SKILLHUB_API = 'https://api.skillhub.cn'
const SKILLHUB_WEB = 'https://skillhub.cn'
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_ZIP_BYTES = 20 * 1024 * 1024
const MAX_FILES = 256
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const PROVIDER_NAME = 'gongchuang-community'
const COMMUNITY_RANK = BUNDLED_SKILL_RANK + 100
const COORDINATE = /^@?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const REPOSITORY_ID = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/

interface FeaturedEntry {
  readonly source: SkillMarketplaceSource
  readonly coordinate: string
}

const FEATURED_CORE: readonly FeaturedEntry[] = [
  { source: 'modelscope', coordinate: '@anthropics/docx' },
  { source: 'modelscope', coordinate: '@anthropics/pdf' },
  { source: 'modelscope', coordinate: '@anthropics/xlsx' },
  { source: 'modelscope', coordinate: 'lichaoyang1998/pptx' },
  { source: 'modelscope', coordinate: 'Zhoujianping/legal-retrieval' },
  { source: 'modelscope', coordinate: 'hu1230/cn-policy-search' },
  { source: 'modelscope', coordinate: 'WEIAIb/ocr-finance-skill' },
  { source: 'skillhub', coordinate: '@tencent-adm/tencent-docs' },
]

const FEATURED_ROTATION: readonly FeaturedEntry[] = [
  { source: 'modelscope', coordinate: 'cuecue0730/cue-enterprise-panorama' },
  { source: 'modelscope', coordinate: 'cuecue0730/cue-ip-bidding-check' },
  { source: 'modelscope', coordinate: 'zhangchaonj/cue-financial-verification' },
  { source: 'modelscope', coordinate: 'handsomestWei/patent-disclosure-skill' },
  { source: 'skillhub', coordinate: '@user_11064e10/tax-policy-knowledge' },
  { source: 'skillhub', coordinate: '@user_9c63fdb4/patent-drafting-cn' },
  { source: 'skillhub', coordinate: '@user_0b65fce7/patseek-patent-search' },
  { source: 'skillhub', coordinate: '@user_5f9c21aa/pdf-image-text-extractor' },
  { source: 'skillhub', coordinate: '@user_7871dce1/excel-auto-zh' },
  { source: 'skillhub', coordinate: '@user_00c9b356/humanizer-zh-pro' },
]

const FEATURED_ROTATION_SIZE = 6
const DAY_MS = 86_400_000

const REVIEWED_CONFIGURATION_URLS: Readonly<Record<string, string>> = Object.freeze({
  '@user_0b65fce7/patseek-patent-search': 'https://patseek.cn/',
})

/**
 * Select core business skills plus a deterministic daily reviewed window.
 * @param epochDay - Integer UTC epoch day used to rotate the reviewed pool.
 * @returns Frozen featured coordinates in stable core-first order.
 */
export function featuredEntriesForEpochDay(epochDay: number): readonly FeaturedEntry[] {
  const start = Math.abs(Math.trunc(epochDay)) % FEATURED_ROTATION.length
  const rotating = Array.from({ length: Math.min(FEATURED_ROTATION_SIZE, FEATURED_ROTATION.length) }, (_, index) => {
    const entry = FEATURED_ROTATION[(start + index) % FEATURED_ROTATION.length]
    if (entry === undefined) throw new Error('精选技能轮换池不完整')
    return entry
  })
  return Object.freeze([...FEATURED_CORE, ...rotating])
}

interface StoredSkill extends InstalledSkillView {
  directory: string
  metadata: Readonly<Record<string, unknown>>
}

interface StoredRepositorySkill {
  coordinate: string
  name: string
  description: string
  category: string
  version: string
  license: string
  archiveUrl: string
  publisherVerified: boolean
  configurationUrl?: string
}

interface StoredRepository extends MarketplaceRepositoryView {
  skills: StoredRepositorySkill[]
}

interface RegistryFile {
  schemaVersion: 1
  installed: StoredSkill[]
  repositories: StoredRepository[]
  disabledSkillNames: string[]
}

interface ParsedSkill {
  name: string
  description: string
  content: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  metadata?: Readonly<Record<string, unknown>>
}

interface BundledAgentMetadata {
  readonly interface?: {
    readonly display_name?: unknown
    readonly short_description?: unknown
  }
}

interface ArchiveEntry {
  path: string
  compressedSize: number
  uncompressedSize: number
  unixMode: number
}

interface PreparedArchive {
  files: Map<string, Uint8Array>
  skillPath: string
  prefix: string
  checks: string[]
}

interface ModelScopeSkill {
  id?: string
  display_name?: string
  description?: string
  category?: string
  license?: string
  logo_url?: string
  downloads?: number
  file_last_modified?: string
  developer?: string
  owner?: string
  tags?: string[]
  custom_tag?: string[]
}

interface SkillHubListSkill {
  slug?: string
  name?: string
  displayName?: string
  description?: string
  description_zh?: string
  summary?: string
  summary_zh?: string
  category?: string
  version?: string
  downloads?: number
  stats?: { downloads?: number }
  iconUrl?: string
  verified?: boolean
  source?: string
  namespace?: { handle?: string; canonicalName?: string }
  publisher?: { verified?: boolean }
  labels?: Record<string, string>
  isServiceized?: boolean
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nowId(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-')
}

function assertCoordinate(value: string): void {
  if (!COORDINATE.test(value)) throw new Error('技能坐标格式无效')
}

function splitCoordinate(value: string): { namespace: string; slug: string } {
  assertCoordinate(value)
  const separator = value.indexOf('/')
  return { namespace: value.slice(0, separator).replace(/^@/, ''), slug: value.slice(separator + 1) }
}

function readonlySkill(value: MarketplaceSkillView): MarketplaceSkillView {
  return Object.freeze({ ...value })
}

function reviewedConfigurationUrl(coordinate: string): string | undefined {
  return REVIEWED_CONFIGURATION_URLS[coordinate]
}

function explicitConfigurationMarker(values: readonly string[]): boolean {
  const markers = new Set([
    'requires_api_key', 'requires-api-key', 'requires_auth', 'requires-auth',
    'requires_oauth', 'requires-oauth', 'requires_configuration', 'requires-configuration',
  ])
  return values.some((value) => {
    const normalized = value.trim().toLowerCase()
    const [key, markerValue] = normalized.split(':', 2)
    return markers.has(normalized) || (markers.has(key ?? '') && markerValue === 'true')
  })
}

async function fetchText(url: string, maxBytes = MAX_JSON_BYTES): Promise<string> {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'follow' })
  if (!response.ok) throw new Error(`社区接口返回 HTTP ${String(response.status)}`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('社区响应超过大小上限')
  const text = await response.text()
  if (Buffer.byteLength(text) > maxBytes) throw new Error('社区响应超过大小上限')
  return text
}

async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T
}

function publicHttpsUrl(raw: string, label: string): URL {
  if (raw.length > 2_048) throw new Error(`${label}过长`)
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') throw new Error(`${label}必须是无凭据 HTTPS 地址`)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) {
    throw new Error(`${label}不能指向本机或内网地址`)
  }
  return url
}

async function fetchPublicText(rawUrl: string, maxBytes: number, label: string): Promise<{ text: string; finalUrl: string }> {
  let current = publicHttpsUrl(rawUrl, label)
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await fetchPinnedRepositoryBytes(current, { Accept: 'application/json' }, maxBytes, label)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location
      if (location === undefined) throw new Error(`${label}重定向缺少目标`)
      current = publicHttpsUrl(new URL(location, current).href, label)
      continue
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`${label}返回 HTTP ${String(response.status)}`)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)
    } catch (error: unknown) {
      throw new Error(`${label}不是有效的 UTF-8 文本`, { cause: error })
    }
    return { text, finalUrl: current.href }
  }
  throw new Error(`${label}重定向次数过多`)
}

function requiredString(value: unknown, label: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) throw new Error(`${label}无效`)
  return value.trim()
}

function parseRepositoryManifest(raw: string, requestedUrl: string, finalUrl: string): StoredRepository {
  const value = JSON.parse(raw) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('第三方仓库清单必须是 JSON 对象')
  const manifest = value as Record<string, unknown>
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.skills)) throw new Error('第三方仓库清单版本无效')
  const id = requiredString(manifest.id, '仓库 ID', 64)
  if (!REPOSITORY_ID.test(id)) throw new Error('仓库 ID 必须是 3 至 64 位小写字母、数字、点、横线或下划线')
  if (manifest.skills.length === 0 || manifest.skills.length > 200) throw new Error('第三方仓库必须包含 1 至 200 个技能')
  const manifestBase = new URL(finalUrl)
  const skills: StoredRepositorySkill[] = manifest.skills.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error(`第 ${String(index + 1)} 个技能条目无效`)
    const row = item as Record<string, unknown>
    const coordinate = requiredString(row.coordinate, `第 ${String(index + 1)} 个技能坐标`, 129)
    assertCoordinate(coordinate)
    const archiveUrl = publicHttpsUrl(new URL(requiredString(row.archiveUrl, `${coordinate} 的下载地址`, 2_048), manifestBase).href, '技能下载地址').href
    const configurationUrl = typeof row.configurationUrl === 'string' && row.configurationUrl.trim() !== ''
      ? publicHttpsUrl(new URL(row.configurationUrl.trim(), manifestBase).href, `${coordinate} 的配置地址`).href
      : undefined
    return {
      coordinate,
      name: requiredString(row.name, `${coordinate} 的名称`, 128),
      description: requiredString(row.description, `${coordinate} 的简介`, 2_000),
      category: typeof row.category === 'string' && row.category.trim() !== '' ? row.category.trim().slice(0, 128) : '其他',
      version: requiredString(row.version, `${coordinate} 的版本`, 64),
      license: typeof row.license === 'string' && row.license.trim() !== '' ? row.license.trim().slice(0, 128) : '未标注',
      archiveUrl,
      publisherVerified: row.publisherVerified === true,
      ...(configurationUrl === undefined ? {} : { configurationUrl }),
    }
  })
  if (new Set(skills.map(skill => skill.coordinate)).size !== skills.length) throw new Error('第三方仓库存在重复技能坐标')
  const homepage = typeof manifest.homepage === 'string' && manifest.homepage.trim() !== ''
    ? publicHttpsUrl(manifest.homepage.trim(), '仓库主页').href
    : new URL('/', manifestBase).href
  return {
    id, name: requiredString(manifest.name, '仓库名称', 128),
    manifestUrl: requestedUrl, homepage, skillCount: skills.length,
    addedAt: new Date().toISOString(), skills,
  }
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`技能下载返回 HTTP ${String(response.status)}`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_ZIP_BYTES) throw new Error('技能压缩包超过 20 MB 上限')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_ZIP_BYTES) throw new Error('技能压缩包超过 20 MB 上限')
  return bytes
}

async function downloadPublic(url: string): Promise<Uint8Array> {
  let current = publicHttpsUrl(url, '技能下载地址')
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await fetchPinnedRepositoryBytes(current, { Accept: 'application/zip' }, MAX_ZIP_BYTES, '技能压缩包')
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location
      if (location === undefined) throw new Error('技能下载重定向缺少目标')
      current = publicHttpsUrl(new URL(location, current).href, '技能下载地址')
      continue
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`技能下载返回 HTTP ${String(response.status)}`)
    return response.bytes
  }
  throw new Error('技能下载重定向次数过多')
}

function findEocd(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const start = Math.max(0, bytes.byteLength - 65_557)
  for (let offset = bytes.byteLength - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset
  }
  throw new Error('技能包不是有效 ZIP')
}

function inspectCentralDirectory(bytes: Uint8Array): ArchiveEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEocd(bytes)
  const count = view.getUint16(eocd + 10, true)
  const size = view.getUint32(eocd + 12, true)
  const start = view.getUint32(eocd + 16, true)
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new Error('不支持 ZIP64 技能包')
  if (count > MAX_FILES || start + size > bytes.byteLength) throw new Error('技能包目录结构超过安全上限')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const rows: ArchiveEntry[] = []
  let offset = start
  let total = 0
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('技能包中央目录损坏')
    }
    const madeBy = view.getUint16(offset + 4, true)
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const external = view.getUint32(offset + 38, true)
    if ((flags & 1) !== 0) throw new Error('不支持加密技能包')
    if (method !== 0 && method !== 8) throw new Error('技能包使用了不支持的压缩算法')
    const nameEnd = offset + 46 + nameLength
    if (nameEnd > bytes.byteLength) throw new Error('技能包文件名越界')
    const path = decoder.decode(bytes.subarray(offset + 46, nameEnd))
    if (path.includes('\\') || path.startsWith('/') || path.split('/').some(part => part === '..')) {
      throw new Error(`技能包包含越界路径：${path}`)
    }
    const unixMode = madeBy >>> 8 === 3 ? external >>> 16 : 0
    if ((unixMode & 0o170000) === 0o120000) throw new Error(`技能包包含符号链接：${path}`)
    if (uncompressedSize > MAX_FILE_BYTES) throw new Error(`技能文件超过 8 MB：${path}`)
    total += uncompressedSize
    if (total > MAX_TOTAL_BYTES) throw new Error('技能包解压后超过 50 MB 上限')
    rows.push({ path, compressedSize, uncompressedSize, unixMode })
    offset = nameEnd + extraLength + commentLength
  }
  return rows
}

function ignoredIntegrityPath(path: string): boolean {
  const parts = path.split('/')
  const name = parts.at(-1) ?? ''
  return path === '_meta.json' || parts.includes('__MACOSX') || name === '.DS_Store'
    || name.startsWith('._') || name === 'Thumbs.db' || path.endsWith('/')
}

function commonSkillRoot(paths: readonly string[]): { prefix: string; skillPath: string } {
  const direct = paths.filter(path => path === 'SKILL.md')
  if (direct.length === 1) return { prefix: '', skillPath: 'SKILL.md' }
  const nested = paths.filter(path => path.endsWith('/SKILL.md'))
  if (nested.length !== 1) throw new Error('技能包必须且只能包含一个 SKILL.md')
  const skillPath = nested.at(0)
  if (skillPath === undefined) throw new Error('技能包缺少 SKILL.md')
  const prefix = skillPath.slice(0, -'SKILL.md'.length)
  if (paths.some(path => !path.startsWith(prefix))) throw new Error('技能包只能包含一个顶层技能目录')
  return { prefix, skillPath }
}

function prepareArchive(bytes: Uint8Array): PreparedArchive {
  const central = inspectCentralDirectory(bytes)
  const unpacked = unzipSync(bytes)
  const files = new Map<string, Uint8Array>()
  for (const row of central) {
    if (row.path.endsWith('/')) continue
    const content = unpacked[row.path]
    if (content === undefined || content.byteLength !== row.uncompressedSize) {
      throw new Error(`技能包解压结果不一致：${row.path}`)
    }
    files.set(row.path, content)
  }
  const { prefix, skillPath } = commonSkillRoot([...files.keys()].filter(path => !ignoredIntegrityPath(path)))
  return {
    files, prefix, skillPath,
    checks: ['installed'],
  }
}

function parseFrontmatter(raw: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  if (match === null) throw new Error('SKILL.md 缺少 YAML frontmatter')
  const frontmatter = match.at(1)
  const content = match.at(2)
  if (frontmatter === undefined || content === undefined) throw new Error('SKILL.md frontmatter 结构无效')
  const data = parseYaml(frontmatter) as unknown
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('SKILL.md frontmatter 无效')
  const fields = data as Record<string, unknown>
  const rawName = fields.name
  const rawDescription = fields.description
  if (typeof rawName !== 'string' || !isSkillName(rawName)) throw new Error('SKILL.md 缺少有效的 kebab-case name')
  if (typeof rawDescription !== 'string' || rawDescription.trim() === '') throw new Error('SKILL.md 缺少 description')
  const name: string = rawName
  const description: string = rawDescription
  const boolean = (key: string, fallback: boolean): boolean => {
    const value = fields[key]
    if (value === undefined) return fallback
    if (typeof value !== 'boolean') throw new Error(`SKILL.md ${key} 必须是布尔值`)
    return value
  }
  return {
    name, description, content: content.trim(),
    invocation: {
      modelInvocable: !boolean('disable-model-invocation', false),
      userInvocable: boolean('user-invocable', true),
    },
    ...(typeof fields.metadata === 'object' && fields.metadata !== null && !Array.isArray(fields.metadata)
      ? { metadata: fields.metadata as Record<string, unknown> }
      : {}),
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

async function readRegistry(path: string): Promise<RegistryFile> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<RegistryFile>
    if (value.schemaVersion !== 1 || !Array.isArray(value.installed)) throw new Error('技能安装清单结构无效')
    const installed = value.installed.map((item) => {
      const { files: _legacyFiles, ...current } = item as StoredSkill & { files?: unknown }
      return current
    })
    const repositories = (Array.isArray(value.repositories) ? value.repositories : []).map((item) => {
      const { manifestDigest: _legacyManifestDigest, ...current }
        = item as StoredRepository & { manifestDigest?: unknown }
      return current
    })
    return {
      schemaVersion: 1,
      installed,
      repositories,
      disabledSkillNames: Array.isArray(value.disabledSkillNames)
        ? value.disabledSkillNames.filter((name): name is string => typeof name === 'string')
        : [],
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1, installed: [], repositories: [], disabledSkillNames: [] }
    }
    throw error
  }
}

async function writeRegistry(path: string, value: RegistryFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const suffix = nowId()
  const temporary = `${path}.next-${suffix}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  if (await pathExists(path)) await rename(path, `${path}.previous-${suffix}`)
  await rename(temporary, path)
}

class CommunityProvider implements SkillProvider {
  readonly name = PROVIDER_NAME

  constructor(private readonly registryPath: string) {}

  async list(_options: SkillViewOptions): Promise<SkillCandidate[]> {
    const registry = await readRegistry(this.registryPath)
    const candidates: SkillCandidate[] = []
    for (const installed of registry.installed) {
      if (registry.disabledSkillNames.includes(installed.name)) continue
      try {
        const skill = await this.loadInstalled(installed)
        candidates.push({
          name: skill.name, description: skill.description, invocation: skill.invocation,
          source: 'gongchuang-community', provider: this.name, rank: COMMUNITY_RANK,
          locator: installed.id, resourceBase: { kind: 'directory', path: installed.directory },
          path: join(installed.directory, 'SKILL.md'),
          ...skill.metadata === undefined ? {} : { metadata: skill.metadata },
        })
      } catch {
        // A missing or invalid SKILL.md cannot be loaded into the model catalog.
      }
    }
    return candidates
  }

  async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
    const registry = await readRegistry(this.registryPath)
    const installed = registry.installed.find(row => row.id === candidate.locator)
    if (installed === undefined || registry.disabledSkillNames.includes(installed.name)) return undefined
    const skill = await this.loadInstalled(installed)
    return {
      name: skill.name, description: skill.description, content: skill.content,
      invocation: skill.invocation, source: 'gongchuang-community', provider: this.name,
      resourceBase: { kind: 'directory', path: installed.directory }, path: join(installed.directory, 'SKILL.md'),
      ...skill.metadata === undefined ? {} : { metadata: skill.metadata },
    }
  }

  private async loadInstalled(installed: StoredSkill): Promise<ParsedSkill> {
    return parseFrontmatter(await readFile(join(installed.directory, 'SKILL.md'), 'utf8'))
  }
}

function marketplaceViewFromModelScope(skill: ModelScopeSkill, installed: ReadonlySet<string>, featured: boolean): MarketplaceSkillView {
  const coordinate = skill.id ?? ''
  const { namespace, slug } = splitCoordinate(coordinate)
  const detailUrl = `${MODELSCOPE_WEB}/skills/${coordinate}`
  const configurationUrl = reviewedConfigurationUrl(coordinate)
  const requiresConfiguration = configurationUrl !== undefined
    || explicitConfigurationMarker([...(skill.tags ?? []), ...(skill.custom_tag ?? [])])
  return readonlySkill({
    source: 'modelscope', coordinate, namespace, slug,
    name: skill.display_name?.trim() || slug,
    description: skill.description?.trim() || '魔搭社区技能',
    category: skill.category?.trim() || '其他', version: 'master', license: skill.license?.trim() || '未标注',
    downloads: skill.downloads ?? 0, iconUrl: skill.logo_url ?? '',
    detailUrl,
    publisherVerified: skill.developer === 'anthropics' || skill.owner === 'anthropics',
    platformSigned: false, requiresConfiguration,
    ...(configurationUrl === undefined ? {} : { configurationUrl }),
    featured, installed: installed.has(`modelscope:${coordinate}`),
  })
}

function marketplaceViewFromSkillHub(skill: SkillHubListSkill, installed: ReadonlySet<string>, featured: boolean): MarketplaceSkillView {
  const slug = skill.slug ?? ''
  const namespace = skill.namespace?.handle ?? ''
  const coordinate = skill.namespace?.canonicalName ?? `@${namespace}/${slug}`
  if (slug === '' || namespace === '') throw new Error('SkillHub 返回了无坐标技能')
  const detailUrl = `${SKILLHUB_WEB}/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`
  const configurationUrl = reviewedConfigurationUrl(coordinate)
  const requiresConfiguration = configurationUrl !== undefined || skill.isServiceized === true || explicitConfigurationMarker(
    Object.entries(skill.labels ?? {}).map(([key, value]) => `${key}:${value}`),
  )
  return readonlySkill({
    source: 'skillhub', coordinate, namespace, slug,
    name: skill.displayName?.trim() || skill.name?.trim() || slug,
    description: skill.summary_zh?.trim() || skill.description_zh?.trim()
      || skill.summary?.trim() || skill.description?.trim() || 'SkillHub 社区技能',
    category: skill.category?.trim() || '其他', version: skill.version ?? 'latest', license: '平台元数据未标注',
    downloads: skill.stats?.downloads ?? skill.downloads ?? 0, iconUrl: skill.iconUrl ?? '',
    detailUrl,
    publisherVerified: skill.publisher?.verified === true || skill.source === 'enterprise' || skill.verified === true,
    platformSigned: false, requiresConfiguration,
    ...(configurationUrl === undefined ? {} : { configurationUrl }),
    featured, installed: installed.has(`skillhub:${coordinate}`),
  })
}

function installedKey(source: SkillMarketplaceSource, coordinate: string, repositoryId?: string): string {
  return source === 'custom' ? `custom:${repositoryId ?? ''}:${coordinate}` : `${source}:${coordinate}`
}

function marketplaceViewFromRepository(
  repository: StoredRepository,
  skill: StoredRepositorySkill,
  installed: ReadonlySet<string>,
): MarketplaceSkillView {
  const { namespace, slug } = splitCoordinate(skill.coordinate)
  const requiresConfiguration = skill.configurationUrl !== undefined
  return readonlySkill({
    source: 'custom', repositoryId: repository.id, coordinate: skill.coordinate, namespace, slug,
    name: skill.name, description: skill.description, category: skill.category, version: skill.version,
    license: skill.license, downloads: 0, iconUrl: '', detailUrl: repository.homepage,
    publisherVerified: skill.publisherVerified, platformSigned: false, requiresConfiguration,
    ...(skill.configurationUrl === undefined ? {} : { configurationUrl: skill.configurationUrl }),
    featured: false,
    installed: installed.has(installedKey('custom', skill.coordinate, repository.id)),
  })
}

/** Host-side verified skill catalog and installer. */
export class GongchuangSkillMarketplaceService extends TypertRemoteService {
  static inject = ['skills']

  private readonly root: string
  private readonly registryPath: string
  private revision = 0
  private invalidateProvider: (() => void) | undefined
  private featuredCache: { at: number; rows: MarketplaceSkillView[] } | undefined

  constructor(ctx: Context) {
    super(ctx, 'gongchuangSkillMarketplace')
    const configured = process.env.GONGCHUANG_SKILL_MARKETPLACE_DIR
    if (configured === undefined || configured.trim() === '') throw new Error('技能市场数据目录未由桌面宿主绑定')
    this.root = resolve(configured)
    this.registryPath = join(this.root, 'registry.json')
  }

  protected async [Service.init](): Promise<void> {
    await mkdir(join(this.root, 'installed'), { recursive: true, mode: 0o700 })
    await mkdir(join(this.root, 'removed'), { recursive: true, mode: 0o700 })
    this.ctx.skills.registerProvider((control: SkillProviderControl) => {
      this.invalidateProvider = control.invalidate
      return new CommunityProvider(this.registryPath)
    })
    this.ctx.effect(() => () => {
      this.invalidateProvider = undefined
    }, 'gongchuang marketplace provider')
  }

  /**
   * Read marketplace state and refresh the rotating featured selection.
   * @returns Installed, featured, source, and custom-repository marketplace state.
   */
  @Remote('snapshot')
  async snapshot(): Promise<SkillMarketplaceSnapshot> {
    const installed = await this.installedViews()
    const registry = await readRegistry(this.registryPath)
    const keys = new Set(installed.filter(row => !row.bundled).map(row => installedKey(
      row.source as SkillMarketplaceSource, row.coordinate, row.repositoryId,
    )))
    const featured = await this.loadFeatured(keys)
    const repositories = registry.repositories.map(repository => this.publicRepository(repository))
    return Object.freeze({
      revision: this.revision,
      installed: Object.freeze(installed.map(row => Object.freeze({ ...row }))),
      featured: Object.freeze(featured.map(readonlySkill)),
      sources: Object.freeze(repositories.length === 0 ? ['modelscope', 'skillhub'] as const : ['modelscope', 'skillhub', 'custom'] as const),
      repositories: Object.freeze(repositories.map(repository => Object.freeze({ ...repository }))),
    })
  }

  /**
   * Search one official market or locally registered repository with pagination.
   * @param request - Source, query, page, page size, and optional repository id.
   * @returns Normalized page with local installation state applied.
   */
  @Remote('search')
  async search(request: SkillSearchRequest): Promise<SkillSearchPage> {
    const page = Math.max(1, Math.trunc(request.page))
    const pageSize = Math.max(1, Math.min(24, Math.trunc(request.pageSize)))
    const category = request.category?.trim() ?? ''
    const registry = await readRegistry(this.registryPath)
    const installed = new Set(registry.installed.map(row => installedKey(
      row.source as SkillMarketplaceSource, row.coordinate, row.repositoryId,
    )))
    if (request.source === 'custom') {
      const repositories = request.repositoryId === undefined
        ? registry.repositories
        : registry.repositories.filter(repository => repository.id === request.repositoryId)
      if (request.repositoryId !== undefined && repositories.length === 0) throw new Error('第三方仓库不存在或尚未添加')
      const query = request.query.trim().toLowerCase()
      const rows = repositories.flatMap(repository => repository.skills.map(skill =>
        marketplaceViewFromRepository(repository, skill, installed)))
        .filter(skill => query === ''
          || `${skill.name} ${skill.description} ${skill.coordinate} ${skill.category}`.toLowerCase().includes(query))
        .filter(skill => category === '' || skill.category === category)
      const start = (page - 1) * pageSize
      return Object.freeze({
        source: request.source, query: request.query, page, pageSize, total: rows.length,
        skills: Object.freeze(rows.slice(start, start + pageSize)),
      })
    }
    if (request.source === 'modelscope') {
      const url = new URL(`${MODELSCOPE_API}/skills`)
      url.searchParams.set('page_number', String(page))
      url.searchParams.set('page_size', String(pageSize))
      const search = [category, request.query.trim()].filter(Boolean).join(' ')
      if (search !== '') url.searchParams.set('search', search)
      const body = await fetchJson<{ data?: { skills?: ModelScopeSkill[]; total?: number } }>(url.href)
      const skills = (body.data?.skills ?? []).map(skill => marketplaceViewFromModelScope(skill, installed, false))
      return Object.freeze({
        source: request.source, query: request.query, page, pageSize,
        total: body.data?.total ?? 0, skills: Object.freeze(skills),
      })
    }
    const url = new URL(`${SKILLHUB_API}/api/skills`)
    url.searchParams.set('page', String(page))
    url.searchParams.set('pageSize', String(pageSize))
    url.searchParams.set('sortBy', 'downloads')
    url.searchParams.set('order', 'desc')
    if (request.query.trim() !== '') url.searchParams.set('keyword', request.query.trim())
    if (category !== '') url.searchParams.set('category', category)
    const body = await fetchJson<{
      code?: number
      data?: { skills?: SkillHubListSkill[]; total?: number }
      message?: string
    }>(url.href)
    if (body.code !== 0) throw new Error(body.message ?? 'SkillHub 搜索失败')
    const skills = (body.data?.skills ?? []).map(skill => marketplaceViewFromSkillHub(skill, installed, false))
    return Object.freeze({
      source: request.source, query: request.query, page, pageSize,
      total: body.data?.total ?? 0, skills: Object.freeze(skills),
    })
  }

  /**
   * Validate and persist one public HTTPS repository manifest.
   * @param request - Manifest URL with no embedded credentials.
   * @returns Registered repository metadata and the checks applied.
   */
  @Remote('addRepository')
  async addRepository(request: SkillRepositoryAddRequest): Promise<SkillRepositoryAddReceipt> {
    const requestedUrl = publicHttpsUrl(request.manifestUrl.trim(), '仓库清单地址').href
    const response = await fetchPublicText(requestedUrl, 512 * 1024, '仓库清单')
    let repository = parseRepositoryManifest(response.text, requestedUrl, response.finalUrl)
    const registry = await readRegistry(this.registryPath)
    const existingIndex = registry.repositories.findIndex(row => row.id === repository.id || row.manifestUrl === requestedUrl)
    if (existingIndex !== -1) {
      const existing = registry.repositories[existingIndex]
      if (existing === undefined) throw new Error('仓库索引状态不一致')
      if (existing.id !== repository.id || existing.manifestUrl !== requestedUrl) throw new Error('仓库 ID 或清单地址已被另一仓库占用')
      repository = { ...repository, addedAt: existing.addedAt }
      registry.repositories.splice(existingIndex, 1, repository)
    } else {
      registry.repositories.push(repository)
    }
    await writeRegistry(this.registryPath, registry)
    this.revision += 1
    return Object.freeze({
      repository: Object.freeze(this.publicRepository(repository)), updated: existingIndex !== -1,
      checks: Object.freeze(['repository-added']),
    })
  }

  /**
   * Remove a registered repository while preserving skills already installed from it.
   * @param request - Repository identity from the current snapshot.
   * @returns Removed repository metadata and the count of retained installed skills.
   */
  @Remote('removeRepository')
  async removeRepository(request: SkillRepositoryRemoveRequest): Promise<SkillRepositoryRemoveReceipt> {
    const registry = await readRegistry(this.registryPath)
    const index = registry.repositories.findIndex(repository => repository.id === request.id)
    if (index === -1) throw new Error('第三方仓库不存在或已移除')
    const repository = registry.repositories[index]
    if (repository === undefined) throw new Error('第三方仓库索引状态不一致')
    registry.repositories.splice(index, 1)
    await writeRegistry(this.registryPath, registry)
    this.revision += 1
    return Object.freeze({
      id: repository.id,
      name: repository.name,
      installedSkillCount: registry.installed.filter(skill => skill.repositoryId === repository.id).length,
    })
  }

  /**
   * Download, unpack, and register one selected skill version in the user community directory.
   * @param request - Marketplace source and immutable skill coordinate selected by the user.
   * @returns Installed skill metadata, or a reused receipt.
   */
  @Remote('installSkill')
  async install(request: SkillInstallRequest): Promise<SkillInstallReceipt> {
    assertCoordinate(request.coordinate)
    const current = await readRegistry(this.registryPath)
    const existing = current.installed.find(row => row.source === request.source && row.coordinate === request.coordinate
      && row.version === request.version && row.repositoryId === request.repositoryId)
    if (existing !== undefined) return Object.freeze({ installed: Object.freeze(this.publicView(existing, current)), reused: true, checks: Object.freeze(['already-installed']) })

    const resolved = request.source === 'modelscope'
      ? await this.resolveModelScopeInstall(request.coordinate)
      : request.source === 'skillhub'
        ? await this.resolveSkillHubInstall(request.namespace, request.slug)
        : this.resolveRepositoryInstall(current, request)
    const archive = request.source === 'custom' ? await downloadPublic(resolved.downloadUrl) : await download(resolved.downloadUrl)
    const archiveDigest = sha256(archive)
    const prepared = prepareArchive(archive)
    const checks = [...prepared.checks]
    const integrity: InstalledSkillView['integrity'] = 'community-install'

    const skillBytes = prepared.files.get(prepared.skillPath)
    if (skillBytes === undefined) throw new Error('技能包缺少 SKILL.md')
    const parsed = parseFrontmatter(strFromU8(skillBytes))
    const bundledNames = new Set(await this.bundledSkillNames())
    if (bundledNames.has(parsed.name)) throw new Error(`社区技能名称与内置技能冲突：${parsed.name}`)
    if (current.installed.some(row => row.name === parsed.name)) throw new Error(`技能名称已被其他社区安装占用：${parsed.name}`)

    const installId = `${request.source}-${parsed.name}-${archiveDigest.slice(0, 12)}`
    const destination = join(this.root, 'installed', installId)
    const staging = join(this.root, `quarantine-${installId}-${nowId()}`)
    await mkdir(staging, { recursive: false, mode: 0o700 })
    const written = new Set<string>()
    for (const [archivePath, content] of prepared.files) {
      if (ignoredIntegrityPath(archivePath) || !archivePath.startsWith(prepared.prefix)) continue
      const path = archivePath.slice(prepared.prefix.length)
      if (path === '' || path.endsWith('/')) continue
      const target = join(staging, ...path.split('/'))
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, content, { flag: 'wx', mode: 0o600 })
      written.add(path)
    }
    if (!written.has('SKILL.md')) throw new Error('规范化技能目录缺少 SKILL.md')
    if (await pathExists(destination)) throw new Error('内容寻址安装目录已存在但注册清单不一致')
    await rename(staging, destination)
    const installed: StoredSkill = {
      id: installId, name: parsed.name, description: parsed.description, source: request.source,
      category: request.category?.trim() || '其他', enabled: true,
      ...(request.repositoryId === undefined ? {} : { repositoryId: request.repositoryId }),
      coordinate: resolved.coordinate, version: resolved.version, digest: archiveDigest,
      installedAt: new Date().toISOString(), bundled: false, integrity, directory: destination,
      detailUrl: resolved.detailUrl, license: resolved.license || '未标注',
      requiresConfiguration: resolved.requiresConfiguration,
      ...(resolved.configurationUrl === undefined ? {} : { configurationUrl: resolved.configurationUrl }),
      metadata: Object.freeze({
        upstream: resolved.detailUrl, license: resolved.license || 'unreported',
        requiresConfiguration: resolved.requiresConfiguration,
        ...(resolved.configurationUrl === undefined ? {} : { configurationUrl: resolved.configurationUrl }),
        checks: Object.freeze(checks),
      }),
    }
    current.installed.push(installed)
    await writeRegistry(this.registryPath, current)
    this.revision += 1
    this.invalidateProvider?.()
    this.featuredCache = undefined
    return Object.freeze({ installed: Object.freeze(this.publicView(installed)), reused: false, checks: Object.freeze(checks) })
  }

  /**
   * Remove one user-installed community skill from the active registry.
   * Its directory is moved to the marketplace's recoverable `removed` area;
   * bundled V1.6.7 skills are intentionally outside this registry.
   * @param request - Installed community skill identity to remove.
   * @returns Identity and source of the recoverably removed skill.
   */
  @Remote('removeSkill')
  async remove(request: SkillRemoveRequest): Promise<SkillRemoveReceipt> {
    const registry = await readRegistry(this.registryPath)
    const index = registry.installed.findIndex(row => row.id === request.id)
    if (index === -1) throw new Error('要删除的社区技能已不存在；内置技能不能从这里删除')
    const installed = registry.installed[index]
    if (installed === undefined) throw new Error('技能安装清单状态不一致')
    const destination = join(this.root, 'removed', `${installed.id}-${nowId()}`)
    await rename(installed.directory, destination)
    registry.installed.splice(index, 1)
    registry.disabledSkillNames = registry.disabledSkillNames.filter(name => name !== installed.name)
    try {
      await writeRegistry(this.registryPath, registry)
    } catch (error) {
      await rename(destination, installed.directory).catch(() => undefined)
      throw error
    }
    this.revision += 1
    this.invalidateProvider?.()
    this.featuredCache = undefined
    return Object.freeze({
      id: installed.id,
      name: installed.name,
      source: installed.source as SkillMarketplaceSource,
      coordinate: installed.coordinate,
    })
  }

  /**
   * Enable or disable an installed community skill without deleting its files.
   * @param request - Installed skill identity and requested enabled state.
   * @returns Effective enabled state; bundled skills remain enabled.
   */
  @Remote('setSkillEnabled')
  async setEnabled(request: SkillEnabledSetRequest): Promise<SkillEnabledSetReceipt> {
    const registry = await readRegistry(this.registryPath)
    const bundled = await this.bundledViews()
    const installed = [...bundled, ...registry.installed.map(row => this.publicView(row, registry))]
      .find(row => row.id === request.id)
    if (installed === undefined) throw new Error('要切换的技能已不存在，请刷新技能中心')
    if (installed.bundled) {
      if (!request.enabled) throw new Error('共创内置专业技能固定启用，不能停用')
      return Object.freeze({ id: installed.id, name: installed.name, enabled: true })
    }
    const disabled = new Set(registry.disabledSkillNames)
    if (request.enabled) disabled.delete(installed.name)
    else disabled.add(installed.name)
    registry.disabledSkillNames = [...disabled].sort((left, right) => left.localeCompare(right, 'zh-CN'))
    await writeRegistry(this.registryPath, registry)
    this.revision += 1
    this.invalidateProvider?.()
    return Object.freeze({ id: installed.id, name: installed.name, enabled: request.enabled })
  }

  private publicView(installed: StoredSkill, registry?: RegistryFile): InstalledSkillView {
    const { directory: _directory, metadata, ...view } = installed
    const category = (view as { category?: string }).category ?? '其他'
    const detailUrl = view.detailUrl ?? (typeof metadata.upstream === 'string' ? metadata.upstream : undefined)
    const license = view.license ?? (typeof metadata.license === 'string' ? metadata.license : undefined)
    const requiresConfiguration = view.requiresConfiguration ?? metadata.requiresConfiguration === true
    // Community detail pages are provenance, not credential destinations. Older
    // registries may have persisted the detail page as configurationUrl; replace
    // those records with the current reviewed vendor destination instead of
    // reopening an unrelated marketplace page after restart.
    const configurationUrl = view.source === 'custom'
      ? view.configurationUrl ?? (typeof metadata.configurationUrl === 'string' ? metadata.configurationUrl : undefined)
      : reviewedConfigurationUrl(view.coordinate)
    return {
      ...view,
      category,
      enabled: registry === undefined ? view.enabled : !registry.disabledSkillNames.includes(view.name),
      ...(detailUrl === undefined ? {} : { detailUrl }),
      ...(license === undefined ? {} : { license }),
      ...(requiresConfiguration ? { requiresConfiguration: true } : {}),
      ...(configurationUrl === undefined ? {} : { configurationUrl }),
    }
  }

  private publicRepository(repository: StoredRepository): MarketplaceRepositoryView {
    const { skills: _skills, ...view } = repository
    return view
  }

  private resolveRepositoryInstall(registry: RegistryFile, request: SkillInstallRequest): {
    coordinate: string
    namespace: string
    slug: string
    version: string
    license: string
    detailUrl: string
    downloadUrl: string
    requiresConfiguration: boolean
    configurationUrl?: string
  } {
    if (request.repositoryId === undefined) throw new Error('第三方仓库安装请求缺少仓库 ID')
    const repository = registry.repositories.find(row => row.id === request.repositoryId)
    const skill = repository?.skills.find(row => row.coordinate === request.coordinate)
    if (repository === undefined || skill === undefined) throw new Error('第三方仓库技能不存在或清单已变化')
    if (skill.version !== request.version) throw new Error('第三方仓库技能版本与当前清单不一致')
    const { namespace, slug } = splitCoordinate(skill.coordinate)
    return {
      coordinate: skill.coordinate, namespace, slug, version: skill.version, license: skill.license,
      requiresConfiguration: skill.configurationUrl !== undefined,
      ...(skill.configurationUrl === undefined ? {} : { configurationUrl: skill.configurationUrl }),
      detailUrl: repository.homepage, downloadUrl: skill.archiveUrl,
    }
  }

  private async installedViews(): Promise<InstalledSkillView[]> {
    const registry = await readRegistry(this.registryPath)
    const bundled = await this.bundledViews()
    const community = registry.installed.map(row => this.publicView(row, registry))
    return [...bundled, ...community].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  }

  private async bundledSkillNames(): Promise<string[]> {
    return (await this.bundledViews()).map(row => row.coordinate)
  }

  private async bundledViews(): Promise<InstalledSkillView[]> {
    const root = process.env.GONGCHUANG_BUNDLED_SKILL_DIR
    if (root === undefined || root.trim() === '') throw new Error('签名内置技能目录未绑定')
    const parent = dirname(root)
    const index = JSON.parse(await readFile(join(parent, 'skill-bundle-index.json'), 'utf8')) as {
      skillBundleVersion?: string
      files?: Record<string, string>
      skills?: string[]
    }
    if (typeof index.skillBundleVersion !== 'string'
      || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(index.skillBundleVersion)
      || !Array.isArray(index.skills) || index.files === undefined) {
      throw new Error('内置技能索引无效')
    }
    const receipt = await stat(join(parent, 'skill-bundle-index.json'))
    const installedAt = receipt.mtime.toISOString()
    const rows: InstalledSkillView[] = []
    for (const directoryName of index.skills) {
      const parsed = parseFrontmatter(await readFile(join(root, directoryName, 'SKILL.md'), 'utf8'))
      const agentMetadataPath = `${directoryName}/agents/openai.yaml`
      let agentMetadata: BundledAgentMetadata | undefined
      if (typeof index.files[agentMetadataPath] === 'string') {
        const value = parseYaml(await readFile(join(root, directoryName, 'agents', 'openai.yaml'), 'utf8')) as unknown
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          agentMetadata = value
        }
      }
      const displayName = typeof agentMetadata?.interface?.display_name === 'string'
        && agentMetadata.interface.display_name.trim() !== ''
        ? agentMetadata.interface.display_name.trim().slice(0, 128)
        : parsed.name
      const shortDescription = typeof agentMetadata?.interface?.short_description === 'string'
        && agentMetadata.interface.short_description.trim() !== ''
        ? agentMetadata.interface.short_description.trim().slice(0, 2_000)
        : parsed.description
      const licensePath = Object.keys(index.files).find(path =>
        path.startsWith(`${directoryName}/`) && /(?:^|\/)LICENSE(?:-[A-Za-z0-9.-]+)?\.txt$/u.test(path),
      )
      const license = licensePath === undefined
        ? undefined
        : licensePath.endsWith('/LICENSE-MIT.txt') ? 'MIT' : '随技能包许可文件'
      rows.push({
        id: `bundled-${directoryName}`, name: displayName, description: shortDescription,
        category: '共创专业', enabled: true,
        source: 'bundled', coordinate: directoryName, version: index.skillBundleVersion,
        digest: index.files[`${directoryName}/SKILL.md`] ?? '', installedAt,
        bundled: true, integrity: 'signed-bundle',
        ...(license === undefined ? {} : { license }),
      })
    }
    return rows
  }

  private async loadFeatured(installed: ReadonlySet<string>): Promise<MarketplaceSkillView[]> {
    if (this.featuredCache !== undefined && Date.now() - this.featuredCache.at < 5 * 60_000) {
      return this.featuredCache.rows.map(row => readonlySkill({
        ...row, installed: installed.has(`${row.source}:${row.coordinate}`),
      }))
    }
    const entries = featuredEntriesForEpochDay(Math.floor(Date.now() / DAY_MS))
    const failures: Array<{ coordinate: string; message: string }> = []
    const rows = (await Promise.all(entries.map(async (entry) => {
      try {
        if (entry.source === 'modelscope') {
          const body = await fetchJson<{ data?: ModelScopeSkill }>(`${MODELSCOPE_API}/skills/${entry.coordinate}`)
          if (body.data === undefined) return undefined
          return marketplaceViewFromModelScope(body.data, installed, true)
        }
        const { namespace, slug } = splitCoordinate(entry.coordinate)
        const body = await fetchJson<{
          skill?: SkillHubListSkill
          latestVersion?: { version?: string }
          namespace?: { handle?: string; canonicalName?: string }
        }>(
          `${SKILLHUB_API}/api/v1/skills/${encodeURIComponent(slug)}?namespace=${encodeURIComponent(namespace)}`,
        )
        if (body.skill === undefined) return undefined
        const version = body.latestVersion?.version ?? body.skill.version
        const skillNamespace = body.namespace ?? body.skill.namespace
        return marketplaceViewFromSkillHub({
          ...body.skill,
          ...(version === undefined ? {} : { version }),
          ...(skillNamespace === undefined ? {} : { namespace: skillNamespace }),
        }, installed, true)
      } catch (error) {
        failures.push({ coordinate: entry.coordinate, message: errorMessage(error) })
        return undefined
      }
    }))).filter((row): row is MarketplaceSkillView => row !== undefined)
    for (const failure of failures) {
      this.ctx.logger.debug(`featured skill ${failure.coordinate} unavailable: ${failure.message}`)
    }
    if (failures.length > 0) {
      const message = rows.length === 0
        ? `featured skill catalog unavailable code=GC-SKILL-FEATURED-UNAVAILABLE failed=${failures.length} total=${entries.length}`
        : `featured skill catalog partially available code=GC-SKILL-FEATURED-PARTIAL failed=${failures.length} total=${entries.length}`
      // 第三方精选目录不可达不影响内置签名技能；聚合记录，避免每个条目各报一次核心技能故障。
      if (rows.length === 0) this.ctx.logger.warn(message)
      else this.ctx.logger.info(message)
    }
    this.featuredCache = { at: Date.now(), rows }
    return rows
  }

  private async resolveModelScopeInstall(coordinate: string): Promise<{
    coordinate: string
    namespace: string
    slug: string
    version: string
    license: string
    detailUrl: string
    downloadUrl: string
    requiresConfiguration: boolean
    configurationUrl?: string
  }> {
    const { namespace, slug } = splitCoordinate(coordinate)
    const body = await fetchJson<{ data?: ModelScopeSkill }>(`${MODELSCOPE_API}/skills/${coordinate}`)
    if (body.data?.id !== coordinate) throw new Error('魔搭详情坐标与安装请求不一致')
    const detailUrl = `${MODELSCOPE_WEB}/skills/${coordinate}`
    const configurationUrl = reviewedConfigurationUrl(coordinate)
    const requiresConfiguration = configurationUrl !== undefined
      || explicitConfigurationMarker([...(body.data.tags ?? []), ...(body.data.custom_tag ?? [])])
    return {
      coordinate, namespace, slug, version: 'master', license: body.data.license?.trim() ?? '',
      detailUrl, requiresConfiguration,
      ...(configurationUrl === undefined ? {} : { configurationUrl }),
      downloadUrl: `${MODELSCOPE_WEB}/skills/${coordinate}/archive/zip/master`,
    }
  }

  private async resolveSkillHubInstall(namespace: string, slug: string): Promise<{
    coordinate: string
    namespace: string
    slug: string
    version: string
    license: string
    detailUrl: string
    downloadUrl: string
    requiresConfiguration: boolean
    configurationUrl?: string
  }> {
    if (!/^[A-Za-z0-9_.-]+$/.test(namespace) || !/^[A-Za-z0-9_.-]+$/.test(slug)) throw new Error('SkillHub 坐标无效')
    const body = await fetchJson<{
      skill?: SkillHubListSkill
      latestVersion?: { version?: string }
      namespace?: { handle?: string; canonicalName?: string }
    }>(`${SKILLHUB_API}/api/v1/skills/${encodeURIComponent(slug)}?namespace=${encodeURIComponent(namespace)}`)
    const coordinate = body.namespace?.canonicalName ?? body.skill?.namespace?.canonicalName
    const version = body.latestVersion?.version
    if (body.skill?.slug !== slug || body.namespace?.handle !== namespace || coordinate === undefined || version === undefined) {
      throw new Error('SkillHub 详情坐标与安装请求不一致')
    }
    const query = new URLSearchParams({ slug, version, namespace })
    const detailUrl = `${SKILLHUB_WEB}/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`
    const configurationUrl = reviewedConfigurationUrl(coordinate)
    const requiresConfiguration = configurationUrl !== undefined || body.skill.isServiceized === true || explicitConfigurationMarker(
      Object.entries(body.skill.labels ?? {}).map(([key, value]) => `${key}:${value}`),
    )
    return {
      coordinate, namespace, slug, version, license: '',
      detailUrl, requiresConfiguration,
      ...(configurationUrl === undefined ? {} : { configurationUrl }),
      downloadUrl: `${SKILLHUB_API}/api/v1/download?${query.toString()}`,
    }
  }

}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gongchuangSkillMarketplace: GongchuangSkillMarketplaceService
  }
}

export default GongchuangSkillMarketplaceService
