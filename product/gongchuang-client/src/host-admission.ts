/** Product composition additions for 洞见. */

import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { GONGCHUANG_CLIENT_VERSION, GONGCHUANG_SKILL_BUNDLE_VERSION } from './product-version.ts'
import { PRODUCT_TRUST_ANCHORS } from './trust-anchors.ts'


export type ProductPlatform = 'macos' | 'windows'

/** Immutable files and verified skill-suite paths mounted by the desktop Host. */
export interface ProductProfessionalRuntimePaths {
  /** Signed product policy manifest. */
  policyManifestPath: string
  /** Detached Ed25519 signature for the policy manifest. */
  policySignaturePath: string
  /** Public key whose digest is pinned by the product Host. */
  policyPublicKeyPath: string
  /** Delivery-validation contracts from the verified skill bundle. */
  professionalContractsPath: string
  /** Professional routing graph from the verified skill bundle. */
  skillCallGraphPath: string
  /** Private mutable directory for atomic professional-task checkpoints. */
  professionalCheckpointDir: string
  /** Exact version of the Host-verified skill bundle selected for this launch. */
  activeSkillBundleVersion: string
}

function productPlatform(): ProductPlatform {
  return process.platform === 'win32' ? 'windows' : 'macos'
}

/**
 * Add the product shell and default services without replacing DSH's general
 * conversation, skill, MCP, filesystem, or web capabilities.
 * @param agentPresetRoot - verified product preset directory.
 * @param professionalRuntime - signed policy and verified skill-suite files.
 * @param platform - target platform whose product permissions are composed.
 * @returns trusted Loader patches owned by the desktop Host.
 */
export function createProductTrustedPatches(
  agentPresetRoot: string,
  professionalRuntime: ProductProfessionalRuntimePaths,
  platform: ProductPlatform = productPlatform(),
): PatchOptions[] {
  const windowsPermissionPatches: PatchOptions[] = platform === 'windows'
    ? [{
        // Windows must keep the confining PowerShell provider mounted even
        // when the product starts in full-access mode.  The provider exposes
        // `sandboxMode`, which is the capability fact required by the
        // permission-preset service.  Full access takes the executor's local
        // path; users may still switch to a confined preset from the UI.
        id: 'bash-sandbox',
        disabled: true,
      }, {
        id: 'pwsh-sandbox',
        disabled: false,
      }, {
        id: 'sandbox-policy',
        config: {
          mode: 'danger-full-access',
          workspaceRoot: process.cwd(),
        },
      }, {
        id: 'approval',
        config: {
          policy: 'never',
        },
      }]
    : []

  return [{
    insert: [{
      id: 'gongchuang-policy-gate',
      name: '@gongchuang/client-policy-gate',
      config: {
        manifestPath: professionalRuntime.policyManifestPath,
        signaturePath: professionalRuntime.policySignaturePath,
        publicKeyPath: professionalRuntime.policyPublicKeyPath,
        expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.policyPublicKeySha256,
        expectedProductId: 'cn.dongjian.desktop',
        expectedClientVersion: GONGCHUANG_CLIENT_VERSION,
        expectedSkillBundleVersion: GONGCHUANG_SKILL_BUNDLE_VERSION,
        activeSkillBundleVersion: professionalRuntime.activeSkillBundleVersion,
        professionalContractsPath: professionalRuntime.professionalContractsPath,
        skillCallGraphPath: professionalRuntime.skillCallGraphPath,
        professionalCheckpointDir: professionalRuntime.professionalCheckpointDir,
      },
    }, {
      id: 'gongchuang-signed-skill-runtime',
      name: '@gongchuang/signed-skill-runtime',
    }, {
      id: 'gongchuang-client-ui',
      name: '@gongchuang/client-ui',
    }, {
      id: 'gongchuang-directory-picker-ui',
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse',
    }, {
      id: 'gongchuang-directory-picker-host',
      name: '@deepseek-ai/dsh-host-directory-picker-browse',
      config: { maxEntries: 1_000 },
    }, {
      id: 'gongchuang-credentials-keychain',
      name: '@gongchuang/credentials-keychain',
      config: {},
    }, {
      id: 'gongchuang-agent-default-model',
      name: '@deepseek-ai/dsh-agent-default-model',
      inject: ['settings'],
      config: {
        // A fresh installation starts from DeepSeek V4 Flash.  Once a user
        // selects any other route/model, agent-default-model persists that
        // exact selection and it wins on later launches and new sessions.
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        requireSettings: true,
      },
    }, {
      id: 'gongchuang-account',
      name: '@gongchuang/account',
      config: {},
    }, {
      id: 'gongchuang-connectors',
      name: '@gongchuang/connectors',
      config: {
        userAgent: `gongchuang-enterprise-assistant/${GONGCHUANG_CLIENT_VERSION}`,
      },
    }, {
      id: 'gongchuang-model-connections',
      name: '@gongchuang/model-connections',
    }, {
      id: 'gongchuang-skill-marketplace',
      name: '@gongchuang/skill-marketplace',
    }, {
      id: 'gongchuang-local-automation',
      name: '@gongchuang/local-automation',
    }, {
      id: 'gongchuang-graph-memory',
      name: '@gongchuang/graph-memory',
      config: {
        extractionEnabled: true,
        recallEnabled: true,
        recallMaxNodes: 6,
        recallMaxDepth: 2,
        maintenanceInterval: 6,
      },
    }],
  }, {
    // 当前底座已在基础组合中挂载该提供方。直接修改原行，确保产品只保留
    // 一个抓取提供方，并继续限制为公开网络，不让 overlay 成为第二所有者。
    id: 'web-fetch-http',
    config: {
      maxUrlLength: 2_048,
      maxResponseBytes: 5_000_000,
      maxBodyChars: 120_000,
      timeoutMs: 75_000,
      maxRedirects: 5,
      userAgent: `gongchuang-enterprise-assistant/${GONGCHUANG_CLIENT_VERSION}`,
      networkPolicy: 'public-only',
    },
  }, {
    id: 'directory-picker',
    disabled: true,
  }, {
    id: 'credentials',
    name: '@deepseek-ai/dsh-credentials-local',
    disabled: true,
  }, {
    id: 'agent-default-model',
    disabled: true,
  }, {
    id: 'llm-deepseek',
    inject: ['credentials'],
    config: {
      // Product consent copy promises one hour by default; refresh shortly
      // before expiry so a draft never starts with an immediately stale id.
      fileExpiresAfterSeconds: 3_600,
      fileRefreshMarginSeconds: 300,
    },
  }, {
    id: 'llm-pi-ai',
    inject: ['credentials'],
    config: {
      providers: {
        'opencode-go': {
          apiKeyEnv: 'OPENCODE_GO_API_KEY',
          // 只用流空闲计时无法约束持续发送心跳、却不产生有效结果的请求。
          // 同时设置单次绝对截止和有限重试，避免传输异常让一个模型步骤无限运行。
          timeoutMs: 300_000,
          streamIdleTimeoutMs: 120_000,
          retryPolicy: { mode: 'normal', maxRetries: 2 },
        },
      },
    },
  }, {
    id: 'web',
    config: {
      searchProvider: 'gongchuang-exa-mcp',
      fetchProvider: 'http',
    },
  }, {
    // `both` 是 DSH 官方兼容模式：模型仍可通过 run_code 批量执行；服务商
    // 偶发直接发出原生工具调用时，也会进入同一策略与确认链，而不会先报
    // UNKNOWN_TOOL。这里不能只靠提示词要求模型永远遵守纯 PTC 调用方式。
    id: 'tools',
    config: {
      mode: 'both',
      maxParallelSubCalls: 5,
    },
  }, {
    id: 'repeat-tool-reminder',
    config: {
      thresholds: [2, 3, 5],
      blockAt: 3,
      argumentsPreviewChars: 300,
    },
  }, {
    id: 'ui-sidebar',
    disabled: true,
  }, {
    id: 'ui-settings-models',
    disabled: true,
  }, {
    // “模型与连接”是产品唯一的供应商登录入口。
    id: 'ui-settings-plugins',
    disabled: true,
  }, {
    id: 'ui-settings-plugin-inventory',
    disabled: true,
  }, {
    id: 'ui-agent-preset',
    disabled: true,
  }, {
    id: 'webserver',
    config: {
      host: '127.0.0.1',
      port: 0,
    },
  }, {
    id: 'connection',
    config: {
      trustedHosts: [],
      // Electron exchanges a fresh loopback launch token on every start. Keep
      // this transport-only key in memory so an ad-hoc app update cannot block
      // startup on a stale macOS Keychain ACL. Account credentials stay in the
      // product credential provider and are not changed by this setting.
      persistentBrowserSession: false,
    },
  }, {
    // 可见窗口由 Electron 管理。Connection 仍签发一次性启动 URL，
    // 通用 Web 组合不得再打开系统浏览器，也不得把该 URL 写入桌面日志。
    id: 'web-runtime',
    config: {
      openBrowser: false,
      printUrl: false,
      surfaceContext: true,
      trustedHosts: [],
    },
  }, {
    id: 'agent-presets',
    config: {
      default: 'gongchuang',
      allowedIds: ['gongchuang'],
      includeUserRoot: false,
      roots: [{ path: agentPresetRoot, trust: 'system' }],
    },
  }, {
    // 提供方请求元数据与 OTLP 遥测分别关闭：会话事件和已安装产品包清单
    // 都不得从客户端外发。
    id: 'session-log-deepseek',
    disabled: true,
    config: { enabled: false },
  }, {
    id: 'plugin-package-inventory-deepseek',
    disabled: true,
    config: { enabled: false },
  }, {
    id: 'session-telemetry-otel',
    disabled: true,
  }, {
    id: 'hmr',
    disabled: true,
  }, ...windowsPermissionPatches]
}
