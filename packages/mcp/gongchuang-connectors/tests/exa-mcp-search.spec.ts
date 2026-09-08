import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GONGCHUANG_EXA_MCP_URL,
  GongchuangExaMcpSearchProvider,
  parseExaMcpResponse,
  sourcesFromExaText,
} from '../src/exa-mcp-search.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('共创免密 Exa 联网检索', () => {
  it('解析 JSON 与 SSE MCP 文本结果', () => {
    const payload = JSON.stringify({ result: { content: [{ type: 'text', text: '检索结果' }] } })
    expect(parseExaMcpResponse(payload)).toBe('检索结果')
    expect(parseExaMcpResponse(`event: message\ndata: ${payload}\n\n`)).toBe('检索结果')
  })

  it('从 MCP 结果保留可供 web_fetch 使用的来源链接', () => {
    expect(sourcesFromExaText('1. [浙江省经信厅](https://jxt.zj.gov.cn/art/1.html)\n2. https://www.gov.cn/xinwen/2.html。'))
      .toEqual([
        { title: '浙江省经信厅', url: 'https://jxt.zj.gov.cn/art/1.html' },
        { url: 'https://www.gov.cn/xinwen/2.html' },
      ])
  })

  it('不读取 DeepSeek 密钥，直接调用 OpenCode 使用的 Exa 托管 MCP', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new TypeError('expected JSON request body')
      expect(new Headers(init.headers).get('user-agent')).toBe('gongchuang-enterprise-assistant/0.4.0')
      const body = JSON.parse(init.body) as { params: { name: string; arguments: { query: string; numResults: number } } }
      expect(body.params).toMatchObject({ name: 'web_search_exa', arguments: { query: '浙江政策', numResults: 6 } })
      return new Response(JSON.stringify({
        result: { content: [{ type: 'text', text: '[政策原文](https://example.gov.cn/policy)' }] },
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new GongchuangExaMcpSearchProvider('gongchuang-enterprise-assistant/0.4.0')
      .search({ query: '浙江政策', maxResults: 6 })
    expect(fetchMock).toHaveBeenCalledWith(GONGCHUANG_EXA_MCP_URL, expect.objectContaining({ method: 'POST' }))
    expect(result.sources).toEqual([{ title: '政策原文', url: 'https://example.gov.cn/policy' }])
  })

  it('拒绝可注入额外 HTTP 头的 User-Agent 配置', () => {
    expect(() => new GongchuangExaMcpSearchProvider('gongchuang/0.4.0\r\nx-extra: injected'))
      .toThrow('User-Agent 配置无效')
  })
})
