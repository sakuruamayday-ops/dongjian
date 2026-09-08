import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GONGCHUANG_CLIENT_DISPLAY_VERSION,
  GONGCHUANG_CLIENT_VERSION,
  GONGCHUANG_SKILL_BUNDLE_VERSION,
} from '../product/gongchuang-client/src/product-version.ts'
import { PRODUCT_TRUST_ANCHORS } from '../product/gongchuang-client/src/trust-anchors.ts'

interface ProductManifest {
  productId: string
  displayName: string
  organizationName: string
  slogan: string
  client: { displayVersion: string; semver: string; status: string; releaseChannels: string[] }
  productionBaseline: {
    clientVersion: string
    skillBundleVersion: string
    upstreamCommit: string
    sourceCommit: string
    serverReleaseId: number
  }
  bundledSkillSuite: { displayVersion: string; semver: string; relationship: string }
  upstream: { ref: string; commit: string }
  productPolicy: {
    generalAssistant: boolean
    professionalTemplates: string
    hardGate: string
    skillSources: string[]
  }
  releaseRequirements: { macos: string[]; windows: string[] }
}

interface DesktopPackage {
  version: string
  scripts: Record<string, string>
  build: { artifactName: string; dmg: { title: string } }
}

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(
  resolve(root, 'product/gongchuang-client/product-manifest.json'),
  'utf8',
)) as ProductManifest
const desktopPackage = JSON.parse(readFileSync(
  resolve(root, 'apps/desktop/package.json'),
  'utf8',
)) as DesktopPackage
const productUiPackage = JSON.parse(readFileSync(
  resolve(root, 'packages/client/ui-gongchuang-product/package.json'),
  'utf8',
)) as { version: string }
const productUiCatalog = readFileSync(resolve(
  root,
  'packages/client/ui-gongchuang-product/src/client/catalog.ts',
), 'utf8')
const policy = JSON.parse(readFileSync(
  resolve(root, 'product/gongchuang-client/policy-template.json'),
  'utf8',
)) as { product: { clientVersion: string; skillBundleVersion: string } }

describe('共创客户端产品契约', () => {
  it('将已发布 V0.4.7 精确映射到生产基线', () => {
    // 只有服务器事务和公网更新源验收通过后，候选身份才允许切换为正式生产基线。
    expect(manifest.productionBaseline).toEqual({
      clientVersion: '0.4.7',
      skillBundleVersion: '1.6.19',
      upstreamCommit: 'd347e703908d0406b7a7ef80e3a0e594d86b2215',
      sourceCommit: '70c732c813ade57958b7637bfc6a5539d9d132bf',
      serverReleaseId: 24,
    })
    expect(manifest.client).toMatchObject({
      displayVersion: GONGCHUANG_CLIENT_DISPLAY_VERSION,
      semver: GONGCHUANG_CLIENT_VERSION,
    })
    expect(['candidate', 'published']).toContain(manifest.client.status)
    // 候选仍保留现网身份；只有正式事务完成后才允许两者相同。
    expect(manifest.client.semver === manifest.productionBaseline.clientVersion)
      .toBe(manifest.client.status === 'published')
    expect(manifest.bundledSkillSuite).toMatchObject({
      displayVersion: `V${GONGCHUANG_SKILL_BUNDLE_VERSION}`,
      semver: GONGCHUANG_SKILL_BUNDLE_VERSION,
      relationship: 'bundled-compatible-content',
    })
    expect(manifest.upstream).toMatchObject({
      ref: 'dsh-v0.1.3-alpha.1',
      commit: 'd347e703908d0406b7a7ef80e3a0e594d86b2215',
    })
    expect(manifest.client.semver).not.toBe(manifest.bundledSkillSuite.semver)
  })

  it('桌面、产品外壳、签名策略与 portable runtime 使用同一客户端版本源', () => {
    expect(GONGCHUANG_CLIENT_VERSION).toBe(manifest.client.semver)
    expect(GONGCHUANG_CLIENT_DISPLAY_VERSION).toBe(manifest.client.displayVersion)
    expect(desktopPackage.version).toBe(GONGCHUANG_CLIENT_VERSION)
    expect(productUiPackage.version).toBe(GONGCHUANG_CLIENT_VERSION)
    expect(policy.product.clientVersion).toBe(GONGCHUANG_CLIENT_VERSION)
    expect(policy.product.skillBundleVersion).toBe(GONGCHUANG_SKILL_BUNDLE_VERSION)
    expect(productUiCatalog).toContain(
      `export const BUNDLED_SKILL_VERSION = '${GONGCHUANG_SKILL_BUNDLE_VERSION}'`,
    )
    expect(GONGCHUANG_SKILL_BUNDLE_VERSION).toBe(manifest.bundledSkillSuite.semver)
    expect('skillCount' in manifest.bundledSkillSuite).toBe(false)
    expect(PRODUCT_TRUST_ANCHORS).toMatchObject({
      runtimeSigningTier: 'formal',
      skillBundleSigningTier: 'formal',
    })
  })

  it('固定品牌、双桌面平台与 DSH 上游提交', () => {
    expect(manifest).toMatchObject({
      productId: 'cn.gongchuang.enterprise-assistant',
      displayName: '共创企业助手',
      organizationName: '共创知识产权',
      slogan: '为中小企业探路点灯',
    })
    expect(manifest.client.releaseChannels).toEqual(['windows', 'macos'])
    expect(manifest.upstream.commit).toBe('d347e703908d0406b7a7ef80e3a0e594d86b2215')
  })

  it('保留通用助手能力，并只把单账号单设备列为硬门禁', () => {
    expect(manifest.productPolicy).toMatchObject({
      generalAssistant: true,
      professionalTemplates: 'default-and-user-editable',
      hardGate: 'one-account-one-active-desktop-client',
    })
    expect(manifest.productPolicy.skillSources).toEqual([
      'bundled',
      'marketplace',
      'user',
      'workspace',
    ])
  })

  it('macOS 正式发布采用服务器签名清单，不声明 Developer ID 或旧版本回滚', () => {
    expect(manifest.releaseRequirements.macos).toEqual([
      'adhoc-code-integrity',
      'server-ed25519-release-manifest',
      'embedded-runtime-and-skill-signatures',
      'first-install-gatekeeper-open-anyway-ui-guidance',
      'clean-device-install-update-relaunch',
      'transactional-current-install-recovery',
    ])
    expect(manifest.releaseRequirements.macos.join(' ')).not.toMatch(/developer-id|notar|staple|0\.1\.1|rollback/u)
  })

  it('桌面构建先强制生成完整 Host 与 Client 运行时闭包', () => {
    expect(desktopPackage.scripts['build:workspace-runtime']).toBe(
      'pnpm -w exec tsc -b --force tsconfig.host.json && pnpm -w exec tsdown --env.DSH_BUILD_FACE host'
      + ' && pnpm -w exec tsc -b --force tsconfig.client.json'
      + ' && pnpm -w exec tsdown --env.DSH_BUILD_FACE client --env.DSH_CLIENT_TITLE 共创企业助手',
    )
    expect(desktopPackage.scripts.build?.startsWith(
      'pnpm run build:workspace-runtime && pnpm run build:web && tsc -b --force',
    )).toBe(true)
    expect(desktopPackage.build.artifactName).toContain('${version}')
    expect(desktopPackage.build.dmg.title).toContain('${version}')
    expect(desktopPackage.scripts['dist:mac']).toContain('updates:metadata:mac')
    expect(desktopPackage.scripts['dist:win']).toContain('updates:metadata:win')
  })
})
