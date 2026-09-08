import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadVerifiedPolicy } from '@gongchuang/client-policy-gate'
import { verifyProductRuntime } from '../../../product/gongchuang-client/src/product-runtime-verifier.ts'
import { verifyStagedSkillSuite } from '../../../product/gongchuang-client/src/skill-suite-verifier.ts'
import { PRODUCT_TRUST_ANCHORS } from '../../../product/gongchuang-client/src/trust-anchors.ts'
import {
  GONGCHUANG_CLIENT_VERSION,
  GONGCHUANG_SKILL_BUNDLE_VERSION,
} from '../../../product/gongchuang-client/src/product-version.ts'
import { developmentRuntimeBundleDirectory } from '../src/runtime-bundle-path.ts'
import {
  verifyPythonDocumentRuntime,
  verifyWindowsPythonDocumentRuntimeLayout,
} from './python-document-runtime-smoke.ts'
import { verifyMacCredentialBrokerInputs } from './verify-final-macos-application.ts'

const argumentsMap = new Map<string, string>()
for (let offset = 2; offset < process.argv.length; offset += 2) {
  const key = process.argv[offset]
  const value = process.argv[offset + 1]
  if (key === undefined || value === undefined || !key.startsWith('--')) {
    throw new Error('usage: verify-packaging-inputs.ts --platform <darwin|win32> --arch <arm64|x64>')
  }
  argumentsMap.set(key.slice(2), value)
}

const requestedPlatform = argumentsMap.get('platform')
const requestedArch = argumentsMap.get('arch')
if (requestedPlatform !== 'darwin' && requestedPlatform !== 'win32') {
  throw new Error('--platform 必须是 darwin 或 win32')
}
if (requestedArch !== 'arm64' && requestedArch !== 'x64') {
  throw new Error('--arch 必须是 arm64 或 x64')
}

const desktopRoot = resolve(import.meta.dirname, '..')
const credentialBroker = requestedPlatform === 'darwin'
  ? verifyMacCredentialBrokerInputs(desktopRoot)
  : undefined
const skillBundleRoot = resolve(desktopRoot, '.build', 'product-skills')
const verifiedSkills = verifyStagedSkillSuite(skillBundleRoot, {
  expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.skillBundlePublicKeySha256,
  expectedSigningTier: PRODUCT_TRUST_ANCHORS.skillBundleSigningTier,
})
if (verifiedSkills.version !== GONGCHUANG_SKILL_BUNDLE_VERSION) {
  throw new Error(`打包技能包必须是 V${GONGCHUANG_SKILL_BUNDLE_VERSION}`)
}

const productRoot = resolve(desktopRoot, '../../product/gongchuang-client')
// 策略正文改动后必须重新签名，避免把“新策略＋旧签名”打进一个无法启动的安装包。
const verifiedPolicy = loadVerifiedPolicy({
  manifestPath: join(productRoot, 'policy-template.json'),
  signaturePath: join(productRoot, 'signatures', 'development', 'policy.sig'),
  publicKeyPath: join(productRoot, 'signatures', 'development', 'policy.pub.pem'),
  expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.policyPublicKeySha256,
  expectedProductId: 'cn.dongjian.desktop',
  expectedClientVersion: GONGCHUANG_CLIENT_VERSION,
  expectedSkillBundleVersion: GONGCHUANG_SKILL_BUNDLE_VERSION,
  activeSkillBundleVersion: verifiedSkills.version,
  professionalContractsPath: join(skillBundleRoot, 'skills', 'delivery-contracts.json'),
  skillCallGraphPath: join(skillBundleRoot, 'skills', 'skill-call-graph.json'),
})

const runtimeRoot = developmentRuntimeBundleDirectory(
  resolve(desktopRoot, '.build'),
  requestedPlatform,
  requestedArch,
)
const runtimeIndexPath = join(runtimeRoot, 'runtime-index.json')
if (!existsSync(runtimeIndexPath)) throw new Error('打包运行组件索引不存在')

function assertNoPythonBytecode(root: string): void {
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')) {
        throw new Error(`打包运行组件含 Python 字节码缓存：${path}`)
      }
      if (entry.isDirectory()) visit(path)
    }
  }
  visit(root)
}

assertNoPythonBytecode(join(runtimeRoot, 'files'))
const verifiedRuntime = verifyProductRuntime(runtimeRoot, {
  expectedPublicKeySha256: PRODUCT_TRUST_ANCHORS.runtimePublicKeySha256,
  expectedSigningTier: PRODUCT_TRUST_ANCHORS.runtimeSigningTier,
  expectedPlatform: requestedPlatform,
  expectedArch: requestedArch,
  expectedClientVersion: GONGCHUANG_CLIENT_VERSION,
})
if (!lstatSync(verifiedRuntime.pythonExecutable).isFile()) throw new Error('Python 运行组件不存在')
const nativeDocumentRuntimeSmoke = requestedPlatform === process.platform
const documentRuntimeVersions = nativeDocumentRuntimeSmoke
  ? verifyPythonDocumentRuntime(verifiedRuntime.pythonExecutable)
  : requestedPlatform === 'win32'
    ? verifyWindowsPythonDocumentRuntimeLayout(verifiedRuntime.pythonExecutable)
    : (() => { throw new Error(`当前主机不能执行 ${requestedPlatform} 文档运行组件冒烟`) })()

process.stdout.write(`${JSON.stringify({
  ok: true,
  target: `${requestedPlatform}/${requestedArch}`,
  skillCount: verifiedSkills.skillCount,
  skillBundleVersion: verifiedSkills.version,
  documentRuntime: true,
  documentRuntimeValidation: nativeDocumentRuntimeSmoke ? 'native-generation' : 'cross-platform-structure',
  documentRuntimeVersions,
  ...(credentialBroker === undefined ? {} : {
    credentialBrokerSha256: credentialBroker.artifacts[requestedArch].sha256,
    credentialBrokerCdHash: credentialBroker.artifacts[requestedArch].cdhash,
  }),
  policySha256: verifiedPolicy.sha256,
  runtimeIndexSha256: verifiedRuntime.indexSha256,
})}\n`)
