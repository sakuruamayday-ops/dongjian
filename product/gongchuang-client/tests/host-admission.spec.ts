import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { createProductTrustedPatches } from '../src/host-admission.ts'
import { PRODUCT_TRUST_ANCHORS } from '../src/trust-anchors.ts'
import {
  GONGCHUANG_CLIENT_VERSION,
  GONGCHUANG_SKILL_BUNDLE_VERSION,
} from '../src/product-version.ts'

const agentPresetRoot = '/product/agent-presets'
const professionalRuntime = {
  policyManifestPath: '/product/policy/policy-template.json',
  policySignaturePath: '/product/policy/policy.sig',
  policyPublicKeyPath: '/product/policy/policy.pub.pem',
  professionalContractsPath: '/product/skill-suite/skills/delivery-contracts.json',
  skillCallGraphPath: '/product/skill-suite/skills/skill-call-graph.json',
  professionalCheckpointDir: '/user-data/professional-tasks',
  activeSkillBundleVersion: '1.6.15',
}

function composition(platform: 'macos' | 'windows' = 'macos') {
  return composeEntries([
    loadOverlayPatches('test', 'packages/bundle/base/cordis.patch.yml'),
    loadOverlayPatches('test', 'packages/bundle/web-app/cordis.patch.yml'),
    createProductTrustedPatches(agentPresetRoot, professionalRuntime, platform),
  ])
}

describe('desktop product composition', () => {
  it('keeps account, general web, models, marketplace, local automation, and isolated memory', () => {
    const entries = composition()
    expect(entries.find(row => row.id === 'gongchuang-account')).toMatchObject({
      name: '@gongchuang/account',
      config: {},
    })
    expect(entries.find(row => row.id === 'web')?.config).toMatchObject({
      searchProvider: 'gongchuang-exa-mcp', fetchProvider: 'http',
    })
    // 当前底座由选中的预设为每个会话挂载 tool-web；宿主行保持禁用，
    // 避免再注册一套同名全局工具。
    expect(entries.find(row => row.id === 'tool-web')).toMatchObject({ disabled: true })
    const presetEntries = loadOverlayPatches('test', 'apps/cli/config/agent-presets/gongchuang/agent.cordis.yml')
    expect(presetEntries.find(row => row.id === 'tool-web')?.config).toMatchObject({ search: true, fetch: true })
    expect(entries.find(row => row.id === 'tools')?.config).toMatchObject({ mode: 'both', maxParallelSubCalls: 5 })
    expect(entries.filter(row => row.name === '@deepseek-ai/dsh-web-fetch-http' && row.disabled !== true)).toHaveLength(1)
    expect(entries.find(row => row.id === 'web-fetch-http')).toMatchObject({
      config: { networkPolicy: 'public-only' },
    })
    expect(entries.find(row => row.id === 'web-fetch-http')?.disabled).not.toBe(true)
    expect(entries.find(row => row.id === 'repeat-tool-reminder')?.config).toEqual({
      thresholds: [2, 3, 5],
      blockAt: 3,
      argumentsPreviewChars: 300,
    })
    expect(entries.find(row => row.id === 'gongchuang-skill-marketplace')).toBeDefined()
    expect(entries.find(row => row.id === 'gongchuang-connectors')).toMatchObject({
      config: { userAgent: `gongchuang-enterprise-assistant/${GONGCHUANG_CLIENT_VERSION}` },
    })
    expect(entries.find(row => row.id === 'gongchuang-credentials-keychain')).toMatchObject({
      name: '@gongchuang/credentials-keychain',
    })
    expect(entries.find(row => row.id === 'credentials')).toMatchObject({ disabled: true })
    expect(entries.find(row => row.id === 'gongchuang-local-automation')).toBeDefined()
    expect(entries.find(row => row.id === 'gongchuang-graph-memory')).toMatchObject({
      name: '@gongchuang/graph-memory',
      config: { recallEnabled: true, extractionEnabled: true, recallMaxNodes: 6 },
    })
    expect(entries.find(row => row.id === 'gongchuang-agent-default-model')).toMatchObject({
      config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    expect(entries.find(row => row.id === 'gongchuang-pwsh-local')).toBeUndefined()
    expect(entries.find(row => row.id === 'webserver')).toMatchObject({
      config: { host: '127.0.0.1', port: 0 },
    })
    expect(entries.find(row => row.id === 'webserver')?.inject ?? []).not.toContain('webRequestGuard')
    expect(entries.find(row => row.id === 'connection')).toMatchObject({
      config: { trustedHosts: [], persistentBrowserSession: false },
    })
    expect(entries.find(row => row.id === 'web-runtime')?.config).toEqual({
      openBrowser: false,
      printUrl: false,
      surfaceContext: true,
      trustedHosts: [],
    })
  })

  it('keeps provider metadata and generic login surfaces disabled', () => {
    const entries = composition()
    expect(entries.find(row => row.id === 'session-log-deepseek')).toMatchObject({
      disabled: true,
      config: { enabled: false },
    })
    expect(entries.find(row => row.id === 'plugin-package-inventory-deepseek')).toMatchObject({
      disabled: true,
      config: { enabled: false },
    })
    for (const id of ['ui-settings-models', 'ui-settings-plugins', 'ui-settings-plugin-inventory']) {
      expect(entries.find(row => row.id === id)).toMatchObject({ disabled: true })
    }
    expect(entries.find(row => row.id === 'gongchuang-model-connections')).toMatchObject({
      name: '@gongchuang/model-connections',
    })
    expect(entries.find(row => row.id === 'llm-pi-ai')).toMatchObject({
      config: {
        providers: {
          'opencode-go': {
            apiKeyEnv: 'OPENCODE_GO_API_KEY',
            timeoutMs: 300_000,
            streamIdleTimeoutMs: 120_000,
            retryPolicy: { mode: 'normal', maxRetries: 2 },
          },
        },
      },
    })
  })

  it('keeps the Alpha produced-files surface mounted exactly once', () => {
    const entries = composition()
    expect(entries.filter(row => row.id === 'ui-deliverables')).toHaveLength(1)
    expect(entries.filter(row => (
      row.name === '@deepseek-ai/dsh-client-ui-deliverables' && row.disabled !== true
    ))).toHaveLength(1)
  })

  it('keeps the Windows permission service over the sandbox-capable PowerShell executor', () => {
    const entries = composition('windows')
    expect(entries.find(row => row.id === 'bash-sandbox')).toMatchObject({ disabled: true })
    expect(entries.find(row => row.id === 'pwsh-sandbox')).toMatchObject({
      name: '@deepseek-ai/dsh-pwsh-sandbox',
      disabled: false,
    })
    expect(entries.find(row => row.id === 'gongchuang-pwsh-local')).toBeUndefined()
    expect(entries.find(row => row.id === 'sandbox-policy')).toMatchObject({
      name: '@deepseek-ai/dsh-sandbox-policy',
      config: { mode: 'danger-full-access' },
    })
    expect(entries.find(row => row.id === 'approval')).toMatchObject({
      name: '@deepseek-ai/dsh-user-approval',
      config: { policy: 'never' },
    })
    expect(entries.find(row => row.id === 'permission')?.name).toBe('@deepseek-ai/dsh-permission-presets')
    expect(entries.find(row => row.id === 'permission')?.disabled).not.toBe(true)
  })

  it('does not change the macOS sandbox and approval composition', () => {
    const entries = composition('macos')
    const baseEntries = composeEntries([
      loadOverlayPatches('test', 'packages/bundle/base/cordis.patch.yml'),
      loadOverlayPatches('test', 'packages/bundle/web-app/cordis.patch.yml'),
    ])
    for (const id of ['bash-sandbox', 'pwsh-sandbox', 'sandbox-policy', 'approval']) {
      expect(entries.find(row => row.id === id)).toEqual(baseEntries.find(row => row.id === id))
    }
  })

  it('mounts the signed professional policy and fixed skill-operation runtime', () => {
    const entries = composition()
    expect(entries.find(row => row.id === 'gongchuang-policy-gate')).toMatchObject({
      name: '@gongchuang/client-policy-gate',
      config: {
        manifestPath: professionalRuntime.policyManifestPath,
        signaturePath: professionalRuntime.policySignaturePath,
        publicKeyPath: professionalRuntime.policyPublicKeyPath,
        professionalContractsPath: professionalRuntime.professionalContractsPath,
        skillCallGraphPath: professionalRuntime.skillCallGraphPath,
        professionalCheckpointDir: professionalRuntime.professionalCheckpointDir,
        expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.policyPublicKeySha256,
        expectedProductId: 'cn.dongjian.desktop',
        expectedClientVersion: GONGCHUANG_CLIENT_VERSION,
        expectedSkillBundleVersion: GONGCHUANG_SKILL_BUNDLE_VERSION,
        activeSkillBundleVersion: professionalRuntime.activeSkillBundleVersion,
      },
    })
    expect(entries.find(row => row.id === 'gongchuang-signed-skill-runtime')).toMatchObject({
      name: '@gongchuang/signed-skill-runtime',
    })
  })

  it('keeps one general product preset while user and workspace skills stay inside that preset', () => {
    const entries = composition()
    expect(entries.find(row => row.id === 'agent-presets')?.config).toEqual({
      default: 'gongchuang',
      allowedIds: ['gongchuang'],
      includeUserRoot: false,
      roots: [{ path: agentPresetRoot, trust: 'system' }],
    })
  })
})
