import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type TrackingKind = 'branch' | 'release'

interface ProductUpstream {
  adoptedCommit: string
  id: string
  ref: string
  relationship: string
  releasePolicy: 'must-match' | 'report-change'
  repository: string
  reviewedCommit: string
  tracking: TrackingKind
}

interface ProductUpstreamManifest {
  reviewedAt: string
  schemaVersion: 1
  upstreams: ProductUpstream[]
}

interface GitHubCommitResponse {
  sha: string
}

interface GitHubReleaseResponse {
  draft: boolean
  tag_name: string
}

type FetchLike = typeof fetch
type Sleep = (delayMs: number) => Promise<void>

/** One live upstream identity resolved from GitHub. */
export interface UpstreamSnapshot {
  commit: string
  ref: string
}

/** One comparison result used by the release command and unit tests. */
export interface UpstreamAuditResult extends UpstreamSnapshot {
  blocking: boolean
  current: boolean
  id: string
  repository: string
}

const manifestPath = resolve(
  import.meta.dirname,
  '../../../product/gongchuang-client/upstream-products.json',
)

function parseManifest(value: unknown): ProductUpstreamManifest {
  if (typeof value !== 'object' || value === null) throw new Error('上游产品清单不是对象')
  const candidate = value as { schemaVersion?: unknown; upstreams?: unknown }
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.upstreams)) {
    throw new Error('上游产品清单版本或 upstreams 无效')
  }
  for (const entry of candidate.upstreams) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('上游产品清单含无效条目')
    }
    const upstream = entry as Record<string, unknown>
    if (typeof upstream.id !== 'string'
      || typeof upstream.repository !== 'string'
      || (upstream.tracking !== 'branch' && upstream.tracking !== 'release')
      || (upstream.releasePolicy !== 'must-match' && upstream.releasePolicy !== 'report-change')
      || typeof upstream.ref !== 'string'
      || typeof upstream.reviewedCommit !== 'string'
      || !/^[0-9a-f]{40}$/u.test(upstream.reviewedCommit)) {
      throw new Error('上游产品清单含无效条目')
    }
  }
  return candidate as unknown as ProductUpstreamManifest
}

/**
 * Compare one reviewed upstream with its live GitHub identity.
 * @param upstream - reviewed product relationship and ref.
 * @param snapshot - live ref and commit returned by GitHub.
 * @returns stable release-audit result.
 */
export function compareProductUpstream(
  upstream: ProductUpstream,
  snapshot: UpstreamSnapshot,
): UpstreamAuditResult {
  return {
    id: upstream.id,
    repository: upstream.repository,
    ...snapshot,
    current: snapshot.ref === upstream.ref && snapshot.commit === upstream.reviewedCommit,
    blocking: upstream.releasePolicy === 'must-match'
      && (snapshot.ref !== upstream.ref || snapshot.commit !== upstream.reviewedCommit),
  }
}

type TokenReader = () => string

function readGitHubCliToken(): string {
  return execFileSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * Resolve one GitHub token for the complete audit run.
 * @param environment - process environment carrying CI or explicit credentials.
 * @param readCliToken - authenticated GitHub CLI token reader used only as a local fallback.
 * @returns a non-empty token, or undefined for the anonymous API allowance.
 */
export function resolveProductUpstreamGitHubToken(
  environment: NodeJS.ProcessEnv = process.env,
  readCliToken: TokenReader = readGitHubCliToken,
): string | undefined {
  const configured = environment.GITHUB_TOKEN?.trim() || environment.GH_TOKEN?.trim()
  if (configured !== undefined && configured !== '') return configured
  try {
    const cliToken = readCliToken().trim()
    return cliToken === '' ? undefined : cliToken
  } catch {
    // GitHub CLI is optional; the API still offers a bounded anonymous allowance.
    return undefined
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

/** Fetch one live GitHub record with bounded retries for transient transport failures. */
export async function githubJson<T>(
  path: string,
  token: string | undefined,
  fetchImpl: FetchLike = globalThis.fetch,
  wait: Sleep = sleep,
): Promise<T> {
  const attempts = 3
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response
    try {
      response = await fetchImpl(`https://api.github.com${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'gongchuang-product-upstream-audit',
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
    } catch (error) {
      // 只重试连接中断等传输故障，且总次数固定；不能把发布前置审计
      // 变成无限等待，也不能在没有真实 GitHub 回执时降级放行。
      if (attempt === attempts - 1) throw error
      await wait(250 * (2 ** attempt))
      continue
    }
    if (!response.ok) {
      const message = `GitHub 上游查询失败：${path} HTTP ${String(response.status)}`
      const transient = response.status === 408 || response.status === 429 || response.status >= 500
      if (!transient || attempt === attempts - 1) throw new Error(message)
      await wait(250 * (2 ** attempt))
      continue
    }
    try {
      return await response.json() as T
    } catch (error) {
      // 代理或 TLS 连接可能在 JSON 末尾被截断；该情形与传输失败同样
      // 有限重试，三次仍失败就保留阻断，不使用半截响应或本地猜测。
      if (attempt === attempts - 1) throw error
      await wait(250 * (2 ** attempt))
    }
  }
  throw new Error(`GitHub 上游查询失败：${path}`)
}

async function resolveSnapshot(
  upstream: ProductUpstream,
  token: string | undefined,
): Promise<UpstreamSnapshot> {
  if (upstream.tracking === 'branch') {
    const commit = await githubJson<GitHubCommitResponse>(
      `/repos/${upstream.repository}/commits/${encodeURIComponent(upstream.ref)}`,
      token,
    )
    return { ref: upstream.ref, commit: commit.sha }
  }

  const releases = await githubJson<GitHubReleaseResponse[]>(
    `/repos/${upstream.repository}/releases?per_page=100`,
    token,
  )
  const latest = releases.find(release => !release.draft)
  if (latest === undefined) throw new Error(`${upstream.repository} 没有可审阅的 GitHub Release`)
  const commit = await githubJson<GitHubCommitResponse>(
    `/repos/${upstream.repository}/commits/${encodeURIComponent(latest.tag_name)}`,
    token,
  )
  return { ref: latest.tag_name, commit: commit.sha }
}

/** Query tracked GitHub projects and reject unreviewed blocking drift. */
export async function runProductUpstreamAudit(): Promise<void> {
  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown)
  const token = resolveProductUpstreamGitHubToken()
  const results: UpstreamAuditResult[] = []
  for (const upstream of manifest.upstreams) {
    results.push(compareProductUpstream(upstream, await resolveSnapshot(upstream, token)))
  }
  for (const result of results) {
    const status = result.current ? 'CURRENT' : result.blocking ? 'REVIEW_REQUIRED' : 'REFERENCE_CHANGED'
    process.stdout.write(`${status} ${result.id} ${result.ref} ${result.commit}\n`)
  }
  const stale = results.filter(result => result.blocking)
  if (stale.length > 0) {
    throw new Error(`正式打包前需审阅 ${stale.map(result => result.id).join('、')} 的上游变化`)
  }
}
