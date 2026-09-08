import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isMachOFile,
  macRuntimeCodePaths,
  signMacRuntimeCode,
  verifyMacRuntimeCodeSignatures,
  type MacRuntimeCodeSigningRunner,
} from '../../../product/gongchuang-client/scripts/macos-runtime-code-signing.ts'

function nativeFixture(): {
  root: string
  entitlements: string
  thin: string
  universal: string
  plain: string
} {
  const root = mkdtempSync(join(tmpdir(), 'gongchuang-runtime-codesign-'))
  const entitlements = join(root, 'entitlements.plist')
  const thin = join(root, 'thin.dylib')
  const universal = join(root, 'universal.so')
  const plain = join(root, 'plain.txt')
  writeFileSync(entitlements, '<plist version="1.0"><dict/></plist>\n')
  writeFileSync(thin, Buffer.concat([Buffer.from('feedfacf', 'hex'), Buffer.from('thin')]))
  writeFileSync(universal, Buffer.concat([Buffer.from('cafebabe', 'hex'), Buffer.from('fat')]))
  writeFileSync(plain, 'not native\n')
  return { root, entitlements, thin, universal, plain }
}

describe('macOS product runtime code signing', () => {
  it('detects thin and universal Mach-O magic without following symbolic links', () => {
    const paths = nativeFixture()
    const link = join(paths.root, 'native-link')
    symlinkSync('thin.dylib', link)

    expect(isMachOFile(paths.thin)).toBe(true)
    expect(isMachOFile(paths.universal)).toBe(true)
    expect(isMachOFile(paths.plain)).toBe(false)
    expect(isMachOFile(link)).toBe(false)
    expect(macRuntimeCodePaths(paths.root, ['plain.txt', 'universal.so', 'thin.dylib']))
      .toEqual(['thin.dylib', 'universal.so'])
  })

  it('signs every native file before verifying all architecture slices', () => {
    const paths = nativeFixture()
    const calls: Array<{ executable: string; args: string[] }> = []
    const runner: MacRuntimeCodeSigningRunner = (executable, args) => {
      calls.push({ executable, args })
    }

    expect(signMacRuntimeCode(
      paths.root,
      ['plain.txt', 'universal.so', 'thin.dylib'],
      paths.entitlements,
      runner,
    )).toEqual(['thin.dylib', 'universal.so'])

    expect(calls).toHaveLength(4)
    expect(calls.slice(0, 2).every(call => call.executable === '/usr/bin/codesign'
      && call.args.includes('--force')
      && call.args.includes('--timestamp=none')
      && call.args.includes(paths.entitlements))).toBe(true)
    expect(calls.slice(2).every(call => call.args.includes('--verify')
      && call.args.includes('--strict')
      && call.args.includes('--all-architectures'))).toBe(true)
  })

  it('verifies only authenticated native paths and rejects path traversal', () => {
    const paths = nativeFixture()
    const calls: string[][] = []
    expect(verifyMacRuntimeCodeSignatures(paths.root, ['thin.dylib', 'plain.txt'], (_, args) => {
      calls.push(args)
    })).toEqual(['thin.dylib'])
    expect(calls).toHaveLength(1)
    expect(() => verifyMacRuntimeCodeSignatures(paths.root, ['../outside'], () => undefined))
      .toThrow('runtime code-signing path is invalid')
  })

  it('rejects symbolic-link entitlements before signing native code', () => {
    const paths = nativeFixture()
    const linkedEntitlements = join(paths.root, 'linked-entitlements.plist')
    symlinkSync('entitlements.plist', linkedEntitlements)

    expect(() => signMacRuntimeCode(
      paths.root,
      ['thin.dylib'],
      linkedEntitlements,
      () => undefined,
    )).toThrow('macOS runtime entitlements must be a regular file')
  })
})
