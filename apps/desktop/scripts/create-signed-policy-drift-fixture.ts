/** Create a signed, intentionally version-drifted policy for isolated acceptance. */

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { PRODUCT_TRUST_ANCHORS } from '../../../product/gongchuang-client/src/trust-anchors.ts'

interface PolicyShape {
  schemaVersion: unknown
  product?: {
    id?: unknown
    clientVersion?: unknown
    skillBundleVersion?: unknown
  }
}

const args = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (key === undefined || value === undefined || !key.startsWith('--')) {
    throw new Error('usage: create-signed-policy-drift-fixture.ts --source <policy.json> --key <external.pem> --out <temporary-directory> --skill-bundle-version <different-version>')
  }
  args.set(key.slice(2), value)
}

const sourceArgument = args.get('source')
const keyArgument = args.get('key')
const outArgument = args.get('out')
const driftVersion = args.get('skill-bundle-version') ?? ''
if (sourceArgument === undefined || keyArgument === undefined || outArgument === undefined
  || !isAbsolute(sourceArgument) || !isAbsolute(keyArgument) || !isAbsolute(outArgument) || driftVersion.length === 0) {
  throw new Error('source, key, out and skill-bundle-version are required')
}
const source = resolve(sourceArgument)
const keyPath = resolve(keyArgument)
const out = resolve(outArgument)

const temporaryRoot = resolve(tmpdir())
const outRelative = relative(temporaryRoot, out)
if (outRelative === '' || outRelative.startsWith('..') || isAbsolute(outRelative)) {
  throw new Error('acceptance fixture output must be a strict descendant of the operating-system temporary directory')
}

const sourceBytes = readFileSync(source)
const policy = JSON.parse(sourceBytes.toString('utf8')) as PolicyShape
if (policy.schemaVersion !== 1 || policy.product?.id !== 'cn.dongjian.desktop'
  || policy.product.clientVersion !== '0.1.1' || policy.product.skillBundleVersion !== '1.6.6') {
  throw new Error('source policy is not the reviewed V0.1.1 / V1.6.6 product policy')
}
if (driftVersion === policy.product.skillBundleVersion) throw new Error('fixture version must differ from the source policy')

const drifted = Buffer.from(`${JSON.stringify({
  ...policy,
  product: { ...policy.product, skillBundleVersion: driftVersion },
}, null, 2)}\n`)
const privateKey = createPrivateKey(readFileSync(keyPath))
const publicKey = Buffer.from(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }))
const publicKeySha256 = createHash('sha256').update(publicKey).digest('hex')
if (publicKeySha256 !== PRODUCT_TRUST_ANCHORS.policyPublicKeySha256) {
  throw new Error('acceptance fixture key does not belong to the compiled policy host')
}

mkdirSync(out, { recursive: false, mode: 0o700 })
writeFileSync(resolve(out, 'policy.json'), drifted, { mode: 0o600, flag: 'wx' })
writeFileSync(resolve(out, 'policy.sig'), `${sign(null, drifted, privateKey).toString('base64')}\n`, { mode: 0o600, flag: 'wx' })
writeFileSync(resolve(out, 'policy.pub.pem'), publicKey, { mode: 0o600, flag: 'wx' })
writeFileSync(resolve(out, 'receipt.json'), `${JSON.stringify({
  schemaVersion: 1,
  purpose: 'isolated-signed-policy-version-drift-acceptance',
  sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
  fixtureSha256: createHash('sha256').update(drifted).digest('hex'),
  publicKeySha256,
  sourceSkillBundleVersion: '1.6.6',
  fixtureSkillBundleVersion: driftVersion,
  signatureAlgorithm: 'Ed25519',
}, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
