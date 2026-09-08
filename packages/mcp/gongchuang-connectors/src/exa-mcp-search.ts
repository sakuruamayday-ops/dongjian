import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'

/**
 * Canonical value for gongchuang search provider id.
 */
export const GONGCHUANG_SEARCH_PROVIDER_ID = 'gongchuang-exa-mcp'
/**
 * Canonical value for gongchuang exa mcp url.
 */
export const GONGCHUANG_EXA_MCP_URL = 'https://mcp.exa.ai/mcp'

const DEFAULT_USER_AGENT = 'gongchuang-enterprise-assistant'

function normalizedUserAgent(value: string): string {
  const normalized = value.trim()
  if (normalized === '' || normalized.length > 200 || /[\0-\x1f\x7f]/u.test(normalized)) {
    throw new Error('联网检索 User-Agent 配置无效')
  }
  return normalized
}

interface McpTextContent {
  type?: unknown
  text?: unknown
}

interface McpEnvelope {
  result?: { content?: McpTextContent[] }
  error?: { message?: unknown }
}

function parseEnvelope(value: string): string | undefined {
  let envelope: McpEnvelope
  try {
    envelope = JSON.parse(value) as McpEnvelope
  } catch {
    return undefined
  }
  if (typeof envelope.error?.message === 'string' && envelope.error.message.length > 0) {
    throw new WebError(`联网检索失败：${envelope.error.message}`, 'WEB_PROVIDER_ERROR')
  }
  return envelope.result?.content?.find(item => item.type === 'text' && typeof item.text === 'string')?.text as string | undefined
}

/**
 * Perform the parse exa mcp response operation.
 * @param body - The body value.
 * @returns The parse exa mcp response result.
 */
export function parseExaMcpResponse(body: string): string {
  const direct = parseEnvelope(body.trim())
  if (direct !== undefined) return direct
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const text = parseEnvelope(trimmed.slice('data:'.length).trim())
    if (text !== undefined) return text
  }
  throw new WebError('联网检索返回了无法识别的结果', 'WEB_PROVIDER_ERROR')
}

function trimUrl(url: string): string {
  return url.replace(/[.,;:!?，。；：！？]+$/gu, '')
}

/**
 * Perform the sources from exa text operation.
 * @param text - The text value.
 * @returns The sources from exa text result.
 */
export function sourcesFromExaText(text: string): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  const append = (urlValue: string, title?: string): void => {
    const url = trimUrl(urlValue)
    if (!URL.canParse(url) || seen.has(url)) return
    seen.add(url)
    sources.push({ url, ...(title === undefined || title.trim() === '' ? {} : { title: title.trim() }) })
  }
  for (const match of text.matchAll(/\[([^\]\r\n]+)\]\((https?:\/\/[^)\s]+)\)/gu)) {
    const url = match[2]
    if (url !== undefined) append(url, match[1])
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]}]+/gu)) append(match[0])
  return sources
}

/**
 * Service implementation for gongchuang exa mcp search provider.
 */
export class GongchuangExaMcpSearchProvider implements WebSearchProvider {
  readonly id = GONGCHUANG_SEARCH_PROVIDER_ID

  private readonly userAgent: string

  constructor(userAgent = DEFAULT_USER_AGENT) {
    this.userAgent = normalizedUserAgent(userAgent)
  }

  available(): boolean {
    return true
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    let response: Response
    try {
      const timeout = AbortSignal.timeout(25_000)
      response = await fetch(GONGCHUANG_EXA_MCP_URL, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'user-agent': this.userAgent,
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: {
            name: 'web_search_exa',
            arguments: {
              query: request.query,
              type: 'auto',
              numResults: request.maxResults ?? 8,
              livecrawl: 'fallback',
              contextMaxCharacters: 12_000,
            },
          },
        }),
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new WebError('联网检索已取消或超时', 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(`联网检索连接失败：${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!response.ok) throw new WebError(`联网检索服务返回 HTTP ${String(response.status)}`, 'WEB_PROVIDER_ERROR')
    const content = parseExaMcpResponse(await response.text())
    return { content, sources: sourcesFromExaText(content), truncated: false }
  }
}
