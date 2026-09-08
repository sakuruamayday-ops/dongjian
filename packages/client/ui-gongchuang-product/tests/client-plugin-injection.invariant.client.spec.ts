// @vitest-environment jsdom

import { mkdtemp, rename, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { SlotTestRuntime, workspaceView } from '@deepseek-ai/dsh-client-test-runtime'
import type { AutomationClaim, SessionRequestId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import * as RemoteGateway from '@deepseek-ai/dsh-api-gateway/client'
import * as Remotes from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as ProductPlugin from '../src/client/index.ts'
import { dispatchAutomation } from '../src/client/automation-dispatch.ts'
import { ConnectivityController } from '../src/client/connectivity.ts'
import { GONGCHUANG_MODEL_PROVIDERS } from '@gongchuang/model-connections/registry'

const runtimes: SlotTestRuntime[] = []
const roots: string[] = []

const modelSnapshot = {
  revision: 1,
  providers: Object.fromEntries(GONGCHUANG_MODEL_PROVIDERS.map(({ id: provider, route }) => [provider, {
    provider, route, phase: 'missing' as const, configured: false, verifiedAt: null,
    modelCount: 0, selectedModel: null, message: '尚未配置',
  }] as const)),
}

async function composition(
  productModule: object = ProductPlugin,
  options: { keychainFailure?: boolean; onModelRefresh?: () => void } = {},
): Promise<SlotTestRuntime> {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  await runtime.declare({
    sidebar: { kind: 'single', scope: 'root' },
    'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
    'conversation.hero.headline': { kind: 'single', scope: 'root' },
    'conversation.hero.preview': { kind: 'single', scope: 'root' },
  } as never)

  runtime.ctx.provide('layout', {})
  runtime.ctx.provide('uiWorkspace', {
    startSession: vi.fn(),
    listDirectory: vi.fn(),
    createDirectory: vi.fn(),
    connectWorkspace: vi.fn(),
    moveSessionToWorkspace: vi.fn(),
  } as never)
  runtime.ctx.provide('theme', { overrideTokens: () => () => {} } as never)
  runtime.ctx.provide('conversation', {})
  runtime.ctx.provide('conversationDraftText', {
    source: () => ({ getSnapshot: () => '', subscribe: () => () => {} }),
    restoreIfEmpty: () => undefined,
    clear: () => undefined,
  } as never)
  runtime.ctx.provide('conversationDraftImages', {
    source: () => ({ getSnapshot: () => [], subscribe: () => () => {} }),
    serialize: async () => [],
    restoreIfEmpty: () => undefined,
  })
  await runtime.ctx.plugin({
    name: 'test-conversation-provider',
    apply(ctx) { ctx.provide('uiConversation', { binding: vi.fn() } as never) },
  })
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('zh')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const responses: Record<string, unknown> = {
    'llm/listProviders': [],
    'llm/listConfigurableProviders': [],
    'gongchuangModelConnections/snapshot': modelSnapshot,
    'gongchuangModelConnections/deepseekFiles': {
      retentionSeconds: 3_600,
      retentionOptions: [3_600, 604_800, 2_592_000],
    },
    'gongchuangConnectors/list': {
      revision: 0, region: 'all', regionConfirmed: false, connectors: [],
    },
    'gongchuangSkillMarketplace/snapshot': {
      revision: 0, installed: [], featured: [], sources: ['modelscope', 'skillhub'], repositories: [],
    },
    'gongchuangLocalAutomation/snapshot': {
      revision: 0, tasks: [], running: 0, dispatched: 0, failed: 0,
    },
    'gongchuangAccount/refresh': {
      revision: 0, phase: 'disconnected', portalUrl: 'https://example.test', username: null,
      message: '请登录', hasSavedPassword: false, autoLoginBlocked: false, singleDevice: true,
      clientCompatibility: null, minimumSupportedVersion: null,
    },
  }
  if (options.keychainFailure) {
    responses['llm/listProviders'] = [{ id: 'opencode-go', name: 'OpenCode Go' }]
    responses['llm/listConfigurableProviders'] = [{
      provider: 'opencode-go', displayName: 'OpenCode Go', settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'opencode-go'], declared: true,
    }]
    const row = {
      ...modelSnapshot.providers['opencode-go'], phase: 'error', failureKind: 'transient',
      message: '系统凭据暂不可用（诊断码：GC-MODEL-KEYCHAIN）',
    }
    responses['gongchuangModelConnections/snapshot'] = {
      ...modelSnapshot, providers: { ...modelSnapshot.providers, 'opencode-go': row },
    }
    responses['gongchuangModelConnections/refresh'] = {
      ...modelSnapshot, revision: 2,
      providers: {
        ...modelSnapshot.providers,
        'opencode-go': {
          ...row, phase: 'ready', configured: true, verifiedAt: '2026-09-05T05:00:00Z',
          modelCount: 1, selectedModel: 'qa-model', message: '已连接',
        },
      },
    }
  }
  const connection = {
    isLoopback: true,
    generation: {
      getSnapshot: () => undefined,
      subscribe: () => () => {},
    },
    state: {
      getSnapshot: () => 'connected' as const,
      subscribe: () => () => {},
    },
    rpc: {
      call: vi.fn(async (channel: string, endpoint: string) => {
        expect(channel).toBe('/api')
        if (!(endpoint in responses)) throw new Error(`unexpected Remote call: ${endpoint}`)
        if (endpoint === 'gongchuangModelConnections/refresh') {
          options.onModelRefresh?.()
          responses['gongchuangModelConnections/snapshot'] = responses[endpoint]
        }
        return { ok: true as const, value: responses[endpoint] }
      }),
      open: () => (async function *(): AsyncGenerator<never> {})(),
    },
    reconnect: () => {},
    registerGenerationSource: () => () => {},
    start: () => ({ stop: () => {} }),
  } satisfies ConnectionHandle
  runtime.ctx.provide('connection', connection)
  runtime.ctx.provide('modelDirectories', {
    directoryFor: () => ({
      store: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} },
      load: () => Promise.resolve([]),
      select: () => Promise.resolve(),
    }),
  } as never)

  const root = await mkdtemp(join(tmpdir(), 'gongchuang-client-ui-loader-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-typert-registry'",
    "- name: '@deepseek-ai/dsh-api-gateway/client'",
    "- name: '@deepseek-ai/dsh-api-remotes/client'",
    "- name: '@gongchuang/client-ui/client'",
    '',
  ].join('\n'))
  runtime.ctx.baseUrl = pathToFileURL(root).href + '/'
  await runtime.ctx.plugin(Loader)
  runtime.ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-typert-registry', TypertRegistry],
    ['@deepseek-ai/dsh-api-gateway/client', RemoteGateway],
    ['@deepseek-ai/dsh-api-remotes/client', Remotes],
    ['@gongchuang/client-ui/client', productModule],
  ])
  runtime.ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof runtime.ctx.loader.internal>
  await runtime.ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await runtime.ctx.loader.await()
  return runtime
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  // Keep test configs recoverable; other hosts retain their temporary folder.
  for (const root of roots.splice(0)) {
    if (process.platform === 'darwin') await rename(root, join(homedir(), '.Trash', basename(root)))
  }
  vi.restoreAllMocks()
  delete document.body.dataset.gongchuangProduct
})

describe('Gongchuang client real composition', () => {
  it('observes live model responses through the Session feed, not a Host-only event', async () => {
    const recovery = vi.spyOn(ConnectivityController.prototype, 'recoverAfterResponse')
    const refresh = vi.fn()
    const runtime = await composition(ProductPlugin, { keychainFailure: true, onModelRefresh: refresh })
    const response = (seq: number, step = 1): SessionLiveEventEntry => ({
      type: 'event',
      event: {
        seq, time: seq, type: 'assistant/message',
        data: {
          turn: 1, step,
          message: {
            id: `model-${seq}`, role: 'assistant', content: [{ type: 'text', text: '测试响应' }],
            source: { kind: 'model', provider: 'opencode-go', model: 'qa-model' },
          },
        },
      },
    } as SessionLiveEventEntry)
    const id = await runtime.sessions.add({ id: 'credential-recovery-feed', events: [response(0)] })
    expect(recovery).not.toHaveBeenCalled()
    await runtime.sessions.appendEvent(id, response(1))
    expect(recovery).toHaveBeenCalledExactlyOnceWith('opencode-go')
    await waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
    await runtime.sessions.appendEvent(id, response(2, 2))
    await runtime.sessions.replaceEvents(id, [response(0), response(1), response(2, 2)], false)
    expect(recovery).toHaveBeenCalledTimes(1)
    await runtime.sessions.add({ id: 'other-selected-session' })
    await runtime.sessions.appendEvent(id, response(3))
    expect(recovery).toHaveBeenCalledTimes(1)
    await runtime.dispose()
    await runtime.sessions.appendEvent(id, response(4))
    expect(recovery).toHaveBeenCalledTimes(1)
    recovery.mockRestore()
  })

  it('attributes a live model failure to its recorded route without replaying history', async () => {
    const recordFailure = vi.spyOn(ConnectivityController.prototype, 'recordRuntimeFailure')
    const runtime = await composition()
    const header = {
      type: 'event',
      event: {
        seq: 0, time: 0, type: 'request/header',
        data: { reason: 'initial', header: { config: { provider: 'opencode-go', model: 'qa-model' } } },
      },
    } as SessionLiveEventEntry
    const failure = {
      type: 'event',
      event: {
        seq: 1, time: 1, type: 'turn/end',
        data: { turn: 1, reason: { kind: 'error', error: { name: 'Error', code: 'BALANCE', message: 'insufficient balance' } } },
      },
    } as SessionLiveEventEntry
    const id = await runtime.sessions.add({ id: 'model-failure-feed', events: [header] })
    await runtime.sessions.appendEvent(id, failure)
    expect(recordFailure).toHaveBeenCalledExactlyOnceWith('opencode-go', 'BALANCE insufficient balance')
    await runtime.sessions.replaceEvents(id, [header, failure], false)
    expect(recordFailure).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('dispatches through the loaded plugin conversation dependency: missing=%s', async (missing) => {
    let productContext: Context | undefined
    const runtime = await composition({
      ...ProductPlugin,
      inject: ProductPlugin.inject.filter(service => !missing || service !== 'uiConversation'),
      apply(ctx: Context) { productContext = ctx; ProductPlugin.apply(ctx) },
    })
    const sessionId = await runtime.sessions.add({ id: 'automation-result' })
    const workspaceId = 'automation-workspace' as WorkspaceId
    await runtime.workspaces.update((state) => {
      state.items = [workspaceView({ workspaceId, path: '/tmp/automation-test', sessionIds: [sessionId] })]
    })
    const requestId = 'automation-run:test' as SessionRequestId
    const prompt = {
      kind: 'user', location: { kind: 'turn', turn: { turn: 1, data: { get: () => undefined } } },
      data: { source: { kind: 'user', rpcId: requestId } },
    }
    vi.spyOn(runtime.ctx.uiConversation, 'binding').mockReturnValue({
      target: () => ({
        getSnapshot: () => ({
          nodes: { values: () => [prompt] },
          legacy: { nodes: [{ kind: 'assistant', turn: 1 }], turnEnds: new Map([[1, 10]]) },
        }),
        subscribe: () => () => {},
      }),
    } as never)
    const claim: AutomationClaim = {
      workspaceId, conversationSessionId: sessionId, prompt: '仅回复 OK', taskName: '测试',
      runId: 'run-test' as AutomationClaim['runId'], runToken: 'token-test',
      taskId: 'automation-test' as AutomationClaim['taskId'], scheduledAt: '2026-09-03T00:00:00.000Z', manual: true,
    }
    const reveal = vi.fn()
    const result = dispatchAutomation(productContext!, claim, async () => {}, reveal, async () => requestId)
    if (missing) await expect(result).rejects.toThrow('cannot get property "uiConversation" without inject')
    else await expect(result).resolves.toMatchObject({ sessionId })
    expect(reveal).toHaveBeenCalledWith(sessionId)
  })

  it('fails actual product activation when the nested LLM Remote is not declared', async () => {
    const withoutLlm = {
      ...ProductPlugin,
      inject: ProductPlugin.inject.filter(service => service !== 'remote.llm'),
    }

    await expect(composition(withoutLlm)).rejects.toThrow(/cannot get property .*llm.* without inject/u)
    expect(document.body.dataset.gongchuangProduct).toBeUndefined()
    expect(runtimes.at(-1)?.slots.entries('sidebar')).toHaveLength(0)
  })

  it('declares the nested Session Remote required by model projection', () => {
    expect(ProductPlugin.inject).toContain('remote.session')
  })

  it('activates the actual product plugin and renders its visible shell', async () => {
    const runtime = await composition()

    expect(document.body.dataset.gongchuangProduct).toBe('v0.1')
    expect(runtime.slots.entries('sidebar')).toHaveLength(1)
    expect(runtime.slots.entries('conversation.hero.brand.mark')).toHaveLength(1)
    expect(runtime.slots.entries('conversation.hero.headline')).toHaveLength(1)
    expect(runtime.slots.entries('conversation.hero.preview')).toHaveLength(1)
    const sidebar = runtime.renderSlot('sidebar', { collapsed: false, width: 300 })
    expect(sidebar.view.getByText('洞见')).toBeDefined()
    const headline = runtime.renderSlot('conversation.hero.headline', {})
    expect(headline.view.getByText('洞见')).toBeDefined()
    const mark = runtime.renderSlot('conversation.hero.brand.mark', { size: 34 })
    expect(mark.container.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/u)
    const preview = runtime.renderSlot('conversation.hero.preview', {})
    expect(preview.container.textContent).toBe('')
  })
})
