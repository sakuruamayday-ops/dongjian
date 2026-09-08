import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { developmentRuntimeBundleDirectory, runtimeBundleSlot } from '../src/runtime-bundle-path.ts'

describe('target-specific product runtimes', () => {
  it('keeps macOS and Windows inputs in distinct slots', () => {
    expect(runtimeBundleSlot('darwin', 'arm64')).toBe('product-runtime-mac-arm64')
    expect(runtimeBundleSlot('darwin', 'x64')).toBe('product-runtime-mac-x64')
    expect(runtimeBundleSlot('win32', 'x64')).toBe('product-runtime-win-x64')
    expect(developmentRuntimeBundleDirectory('/build', 'darwin', 'arm64'))
      .toBe(resolve('/build', 'product-runtime-mac-arm64'))
  })

  it('fails closed for product targets that are not supported', () => {
    expect(() => runtimeBundleSlot('linux', 'x64')).toThrow(/不支持/u)
  })

  it('makes packaging select the runtime that matches electron-builder os and arch', () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      build: {
        npmRebuild: boolean
        extraResources: Array<{ from: string; to: string }>
        asarUnpack: string[]
        files: string[]
        mac: { files: string[] }
        win: { files: string[] }
      }
      scripts: Record<string, string>
      optionalDependencies: Record<string, string>
      dependencies: Record<string, string>
    }
    expect(packageJson.build.extraResources).toContainEqual({
      from: '.build/product-runtime-${os}-${arch}',
      to: 'product/runtime',
    })
    // DSH alpha.1 的 fs-ext 是 ABI 相关原生模块，必须由 Electron Builder
    // 按目标 Electron 重建；否则测试可通过而正式 App 会在首次启动时崩溃。
    expect(packageJson.build.npmRebuild).toBe(true)
    expect(packageJson.build.extraResources).toEqual(expect.arrayContaining([
      {
        from: '../../product/gongchuang-client/policy-template.json',
        to: 'product/policy/policy-template.json',
      },
      {
        from: '../../product/gongchuang-client/signatures/development/policy.sig',
        to: 'product/policy/policy.sig',
      },
      {
        from: '../../product/gongchuang-client/signatures/development/policy.pub.pem',
        to: 'product/policy/policy.pub.pem',
      },
    ]))
    expect(packageJson.dependencies['@gongchuang/client-policy-gate']).toBe('workspace:^')
    // DSH 在正式包中按名称加载这些服务；workspace peer 不会被 electron-builder 自动带入。
    const packagedRuntimePeers = [
      '@deepseek-ai/cordis-plugin-group',
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-authorization',
      '@deepseek-ai/dsh-brand',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-hook-protocol',
      '@deepseek-ai/dsh-jobs',
      '@deepseek-ai/dsh-sdk-protocol',
      '@deepseek-ai/dsh-session-persistence',
      '@deepseek-ai/dsh-session-query',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-util-time',
      '@deepseek-ai/dsh-util-workspace-path',
    ]
    for (const dependency of packagedRuntimePeers) {
      expect(packageJson.dependencies[dependency]).toBe('workspace:^')
    }
    expect(packageJson.scripts['dist:mac']).toContain('verify:inputs:mac')
    expect(packageJson.scripts['dist:mac-intel']).toContain('--x64')
    expect(packageJson.scripts['verify:inputs:mac-intel']).toContain('--arch x64')
    expect(packageJson.scripts['dist:win']).toContain('verify:inputs:win')
    expect(packageJson.scripts['package:dir:mac']).toContain('electron-builder --dir --mac --arm64')
    expect(packageJson.scripts['package:dir:win'])
      .toContain('electron-builder --config electron-builder.windows.cjs --dir --win --x64')
    expect(packageJson.scripts['build:web']).toBe('pnpm --filter @deepseek-ai/dsh-web-frontend run build')
    expect(packageJson.scripts.build).toContain('pnpm run build:workspace-runtime && pnpm run build:web')
    expect(packageJson.scripts['build:workspace-runtime']).toContain('--env.DSH_CLIENT_TITLE 洞见')
    expect(packageJson.optionalDependencies['@vscode/ripgrep-darwin-arm64']).toBe('1.18.0')
    expect(packageJson.optionalDependencies['@vscode/ripgrep-darwin-x64']).toBe('1.18.0')
    expect(packageJson.optionalDependencies['@koromix/koffi-darwin-x64']).toBe('3.1.1')
    expect(packageJson.optionalDependencies['@vscode/ripgrep-win32-x64']).toBe('1.18.0')
    expect(packageJson.dependencies['@deepseek-ai/dsh-tool-fs-search']).toBe('workspace:^')
    expect(packageJson.build.asarUnpack).toContain('**/bin/rg')
    expect(packageJson.build.asarUnpack).toContain('**/*.exe')
    expect(packageJson.build.asarUnpack).toContain(
      '!**/node-pty/third_party/conpty/**/win10-arm64/**',
    )
    expect(packageJson.build.mac.files).toContain('!.build/**')
    expect(packageJson.build.mac.files.slice(0, 2)).toEqual(['dist/**', 'package.json'])
    expect(packageJson.build.files).toContain('!release*/**')
    expect(packageJson.build.files).toContain('!output/**')
    expect(packageJson.build.mac.files).toContain('!release*/**')
    expect(packageJson.build.mac.files).toContain('!output/**')
    expect(packageJson.build.win.files).toContain('!.build/**')
    expect(packageJson.build.win.files.slice(0, 2)).toEqual(['dist/**', 'package.json'])
    expect(packageJson.build.win.files).toContain('!release*/**')
    expect(packageJson.build.win.files).toContain('!output/**')
    expect(packageJson.build.mac.files).toContain(
      '!**/node_modules/@napi-rs/canvas-{win32-*,linux-*}/**',
    )
    expect(packageJson.build.mac.files).toContain(
      '!**/node_modules/node-pty/prebuilds/{win32-*,linux-*}/**',
    )
    expect(packageJson.build.win.files).toContain(
      '!**/node_modules/@napi-rs/canvas-{darwin-*,win32-arm64*,linux-*}/**',
    )
    expect(packageJson.build.win.files).toContain(
      '!**/node_modules/node-pty/prebuilds/{darwin-*,win32-arm64*,linux-*}/**',
    )
    expect(packageJson.build.win.files).toContain('!**/node_modules/node-pty/build/**')
    expect(packageJson.build.win.files).toContain(
      '!**/node_modules/node-pty/third_party/conpty/**/win10-arm64/**',
    )
  })

  it('builds the startup ripgrep preflight through an explicit project reference', () => {
    const tsconfig = JSON.parse(readFileSync(resolve(import.meta.dirname, '../tsconfig.json'), 'utf8')) as {
      references: Array<{ path: string }>
    }
    expect(tsconfig.references).toContainEqual({ path: '../../packages/fs/tool-fs-search' })
  })

  it('verifies the signed policy, skill suite, and product runtime before every desktop package is built', () => {
    const preflightSource = readFileSync(
      resolve(import.meta.dirname, '../scripts/verify-packaging-inputs.ts'),
      'utf8',
    )
    expect(preflightSource).toContain('loadVerifiedPolicy')
    expect(preflightSource).toContain('PRODUCT_TRUST_ANCHORS.policyPublicKeySha256')
    expect(preflightSource).toContain("join(productRoot, 'policy-template.json')")
    expect(preflightSource).toContain("join(productRoot, 'signatures', 'development', 'policy.sig')")
    expect(preflightSource).toContain('verifyStagedSkillSuite')
    expect(preflightSource).toContain('PRODUCT_TRUST_ANCHORS.skillBundlePublicKeySha256')
    expect(preflightSource).toContain('verifyProductRuntime')
    expect(preflightSource).toContain('PRODUCT_TRUST_ANCHORS.runtimePublicKeySha256')
    expect(preflightSource).toContain('verifyPythonDocumentRuntime')
    expect(preflightSource).toContain('verifyWindowsPythonDocumentRuntimeLayout')
    expect(preflightSource).toContain('documentRuntimeValidation: nativeDocumentRuntimeSmoke')
    expect(preflightSource).toContain('documentRuntimeVersions')
  })
})
