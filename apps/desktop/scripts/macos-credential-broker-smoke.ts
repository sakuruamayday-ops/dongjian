/** Exercise the packaged Keychain broker across two independently signed App bundles. */

import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

interface BrokerEnvelope<T> {
  readonly ok?: boolean
  readonly result?: T
}

const BROKER_RUNNER = String.raw`
const { spawn } = require('node:child_process')
const { dirname, join, resolve } = require('node:path')
const broker = resolve(dirname(process.execPath), '..', 'Resources', 'product', 'credentials', 'gongchuang-credential-broker')
const child = spawn(broker, [], { stdio: ['pipe', 'pipe', 'pipe'] })
child.stdout.pipe(process.stdout)
child.stderr.resume()
process.stdin.pipe(child.stdin)
child.once('error', () => process.exit(78))
child.once('close', code => { process.exitCode = code ?? 79 })
`

function argument(name: string): string {
  const offset = process.argv.indexOf(`--${name}`)
  const value = offset === -1 ? undefined : process.argv[offset + 1]
  if (value === undefined || value.trim() === '') throw new Error(`missing --${name}`)
  return resolve(value)
}

function applicationExecutable(appPath: string): string {
  const name = execFileSync('/usr/bin/plutil', [
    '-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8' }).trim()
  if (name === '' || name.includes('/') || name.includes('\\')) {
    throw new Error('packaged application executable name is invalid')
  }
  return join(appPath, 'Contents', 'MacOS', name)
}

function request<T>(appPath: string, payload: object): T {
  // The product executable remains the broker's real signed parent, while the
  // synthetic secret travels only through stdin and never appears in argv/env.
  const result = spawnSync(applicationExecutable(appPath), ['-e', BROKER_RUNNER], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    input: `${JSON.stringify(payload)}\n`,
    timeout: 15_000,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error('packaged application could not execute its credential broker')
  let envelope: BrokerEnvelope<T>
  try {
    envelope = JSON.parse(result.stdout.trim()) as BrokerEnvelope<T>
  } catch (error) {
    throw new Error('packaged credential broker returned invalid JSON', { cause: error })
  }
  if (envelope.ok !== true) throw new Error('packaged credential broker rejected a smoke-test request')
  return envelope.result as T
}

if (process.platform !== 'darwin') throw new Error('macOS credential broker smoke requires macOS')
const firstApp = argument('first-app')
const secondApp = argument('second-app')
const reference = `GONGCHUANG_BROKER_SMOKE_${randomUUID().replaceAll('-', '').toUpperCase()}`
const secret = `synthetic-${randomUUID()}`
let written = false

try {
  request(firstApp, { op: 'write', ref: reference, value: secret })
  written = true
  const firstRead = request<{ found: boolean; value?: string }>(firstApp, { op: 'read', ref: reference })
  if (!firstRead.found || firstRead.value !== secret) throw new Error('first App could not read its broker credential')

  const secondRead = request<{ found: boolean; value?: string }>(secondApp, { op: 'read', ref: reference })
  if (!secondRead.found || secondRead.value !== secret) {
    throw new Error('second App could not read the credential written by the frozen broker')
  }
  request(secondApp, { op: 'delete', ref: reference })
  written = false
  const removed = request<{ found: boolean }>(secondApp, { op: 'read', ref: reference })
  if (removed.found) throw new Error('broker smoke-test credential was not deleted')
  process.stdout.write(`${JSON.stringify({ ok: true, crossApplicationRead: true, deleted: true })}\n`)
} finally {
  if (written) {
    try { request(firstApp, { op: 'delete', ref: reference }) } catch {}
  }
}
