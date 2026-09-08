import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as GraphMemoryModule from '../src/index.ts'
import { GongchuangGraphMemoryService } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('共创 Graph Memory 真实 Loader 组合', () => {
  it('通过 cordis.yml 加载宿主服务并使用独立本地目录', async () => {
    root = await mkdtemp(join(tmpdir(), 'gongchuang-graph-memory-loader-'))
    const configPath = join(root, 'cordis.yml')
    const memoryRoot = join(root, 'memory')
    await writeFile(configPath, [
      "- name: '@gongchuang/graph-memory'",
      '  config:',
      `    rootDir: ${JSON.stringify(memoryRoot)}`,
      '    extractionEnabled: true',
      '    recallEnabled: true',
      '    recallMaxNodes: 6',
      '    recallMaxDepth: 2',
      '    maintenanceInterval: 6',
      '    llmMaxTokens: 4096',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(SystemPrompt).await()
    await context.plugin(ToolRuntime).await()
    context.provide('llm', {} as never)
    context.provide('workspaceRegistry', { list: () => [] } as never)
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier !== '@gongchuang/graph-memory') throw new Error(`unexpected Loader import: ${specifier}`)
        return GraphMemoryModule
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    expect(context.get('gongchuangGraphMemory')).toBeInstanceOf(GongchuangGraphMemoryService)
    await expect(context.gongchuangGraphMemory.snapshot()).resolves.toMatchObject({
      enabled: true, includeToolResults: true, totalNodes: 0, enterpriseStores: 0,
    })
  })
})
