/** Sign the exact policy bytes with an external Ed25519 private key. */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const productRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(productRoot, '../..')
const args = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (key === undefined || value === undefined || !key.startsWith('--')) {
    throw new Error('usage: sign-policy.ts --key <external.pem> --out <directory> [--init development]')
  }
  args.set(key.slice(2), value)
}
const keyPath = resolve(args.get('key') ?? '')
const out = resolve(args.get('out') ?? '')
if (keyPath === resolve('') || out === resolve('')) throw new Error('--key and --out are required')
const keyRelative = relative(repositoryRoot, keyPath)
if (keyRelative === '' || (!keyRelative.startsWith('..') && !keyRelative.startsWith('/'))) {
  throw new Error('private signing keys must stay outside the repository')
}

let privatePem: Buffer
try {
  privatePem = readFileSync(keyPath)
} catch (error) {
  if (args.get('init') !== 'development') throw error
  const pair = generateKeyPairSync('ed25519')
  privatePem = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, privatePem, { mode: 0o600, flag: 'wx' })
}
const privateKey = createPrivateKey(privatePem)
const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
const manifestPath = resolve(productRoot, 'policy-template.json')
const manifest = readFileSync(manifestPath)
const signature = sign(null, manifest, privateKey).toString('base64')
mkdirSync(out, { recursive: true })
writeFileSync(resolve(out, 'policy.sig'), `${signature}\n`, { mode: 0o644 })
writeFileSync(resolve(out, 'policy.pub.pem'), publicPem, { mode: 0o644 })
writeFileSync(resolve(out, 'receipt.json'), `${JSON.stringify({
  schemaVersion: 1,
  manifest: 'policy-template.json',
  manifestSha256: createHash('sha256').update(manifest).digest('hex'),
  publicKeySha256: createHash('sha256').update(publicPem).digest('hex'),
  signatureAlgorithm: 'Ed25519',
  signingTier: args.get('init') === 'development' ? 'development' : 'external',
}, null, 2)}\n`, { mode: 0o644 })
