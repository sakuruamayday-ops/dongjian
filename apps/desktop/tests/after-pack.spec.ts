import { createPackage } from '@electron/asar'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('desktop packaging hooks', () => {
  it('leaves macOS final ad-hoc signing to Electron Builder after fuses are applied', () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'),
    ) as {
      build: {
        beforeBuild: unknown
        afterPack: unknown
        afterSign: unknown
        mac: unknown
      }
    }
    const entitlements = readFileSync(
      join(import.meta.dirname, '../build/entitlements.mac.plist'),
      'utf8',
    )
    const hook = readFileSync(
      join(import.meta.dirname, '../scripts/verify-packaged-application.mjs'),
      'utf8',
    )
    const afterSignHook = readFileSync(
      join(import.meta.dirname, '../scripts/verify-signed-macos-application.mjs'),
      'utf8',
    )

    expect(packageJson.build.beforeBuild).toBe('scripts/prepare-native-modules-for-packaging.mjs')
    expect(packageJson.build.afterPack).toBe('scripts/verify-packaged-application.mjs')
    expect(packageJson.build.afterSign).toBe('scripts/verify-signed-macos-application.mjs')
    expect(packageJson.build.mac).toMatchObject({
      identity: '-',
      forceCodeSigning: true,
      hardenedRuntime: true,
      notarize: false,
      signIgnore: [
        '/Contents/Resources/product/runtime/files/',
        '/Contents/Resources/product/credentials/gongchuang-credential-broker$',
      ],
      extraResources: [
        {
          from: 'native-credentials/mac-${arch}/gongchuang-credential-broker',
          to: 'product/credentials/gongchuang-credential-broker',
        },
        {
          from: 'native-credentials/manifest.json',
          to: 'product/credentials/manifest.json',
        },
      ],
    })
    expect(entitlements).toContain('com.apple.security.cs.disable-library-validation')
    expect(hook).not.toContain('codesign')
    expect(hook).not.toContain('execFileSync')
    expect(afterSignHook).not.toContain('writeFile')
    expect(afterSignHook).not.toContain('rename')
  })

  it('quarantines stale fs-ext rebuild metadata before Electron packaging', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'gongchuang-native-metadata-'))
    const metadata = join(
      workspaceRoot,
      'node_modules',
      '.pnpm',
      'fs-ext@2.1.1',
      'node_modules',
      'fs-ext',
      'build',
      'Release',
      '.forge-meta',
    )
    mkdirSync(join(metadata, '..'), { recursive: true })
    writeFileSync(metadata, 'arm64--148')

    const scriptUrl = pathToFileURL(
      join(import.meta.dirname, '../scripts/prepare-native-modules-for-packaging.mjs'),
    )
    const module = await import(scriptUrl.href) as {
      quarantineElectronRebuildMetadata: (
        context: { workspaceRoot: string; platform: string; arch: string },
        now: () => number,
      ) => string[]
    }
    const quarantined = module.quarantineElectronRebuildMetadata({
      workspaceRoot,
      platform: 'darwin',
      arch: 'arm64',
    }, () => 1234)

    expect(existsSync(metadata)).toBe(false)
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(quarantined[0], 'utf8')).toBe('arm64--148')
    expect(quarantined[0]).toContain('1234-')
    expect(quarantined[0]).toContain('-darwin-arm64')
  })

  it('verifies the final signed macOS application and skips other platforms', async () => {
    const scriptUrl = pathToFileURL(
      join(import.meta.dirname, '../scripts/verify-signed-macos-application.mjs'),
    )
    const module = await import(scriptUrl.href) as {
      verifySignedMacApplication: (
        context: {
          appOutDir: string
          arch?: number
          electronPlatformName: string
          packager: { appInfo: { productFilename: string } }
        },
        run: (executable: string, args: string[], options: { stdio: string }) => void,
      ) => void
    }
    const calls: Array<{ executable: string; args: string[]; stdio: string }> = []
    const context = {
      appOutDir: '/candidate/mac-arm64',
      arch: 3,
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: '洞见' } },
    }
    module.verifySignedMacApplication(context, (executable, args, options) => {
      calls.push({ executable, args, stdio: options.stdio })
    })
    module.verifySignedMacApplication({ ...context, electronPlatformName: 'win32' }, () => {
      throw new Error('Windows must not run the macOS afterSign verifier')
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.executable).toBe(process.execPath)
    expect(calls[0]?.args.slice(-4)).toEqual([
      '--app',
      join('/candidate/mac-arm64', '洞见.app'),
      '--arch',
      'arm64',
    ])
    expect(calls[0]?.stdio).toBe('inherit')
    expect(() => {
      module.verifySignedMacApplication({ ...context, arch: 4 }, () => undefined)
    })
      .toThrow('unsupported signed macOS architecture')
  })

  it('resolves macOS and Windows application archives from Electron Builder context', async () => {
    const scriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/verify-packaged-application.mjs'))
    const module = await import(scriptUrl.href) as {
      packagedApplicationArchivePath: (context: {
        appOutDir: string
        electronPlatformName: string
        packager: { appInfo: { productFilename: string } }
      }) => string
    }
    const context = {
      appOutDir: '/candidate',
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: '洞见' } },
    }

    expect(module.packagedApplicationArchivePath(context)).toBe(
      join('/candidate', '洞见.app', 'Contents', 'Resources', 'app.asar'),
    )
    expect(module.packagedApplicationArchivePath({
      ...context,
      electronPlatformName: 'win32',
    })).toBe(join('/candidate', 'resources', 'app.asar'))
  })

  it('loads the ABI-sensitive session lock addon with packaged Electron before signing', async () => {
    const scriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/verify-packaged-application.mjs'))
    const module = await import(scriptUrl.href) as {
      verifyPackagedMacNativeModuleAbi: (
        context: {
          appOutDir: string
          electronPlatformName: string
          packager: { appInfo: { productFilename: string } }
        },
        run: (
          executable: string,
          args: string[],
          options: { encoding: string; env: NodeJS.ProcessEnv },
        ) => { error?: Error; status: number | null; stderr?: string; stdout?: string },
      ) => void
    }
    const context = {
      appOutDir: '/candidate/mac-arm64',
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: '洞见' } },
    }
    const calls: Array<{ executable: string; args: string[]; electronRunAsNode?: string }> = []

    module.verifyPackagedMacNativeModuleAbi(context, (executable, args, options) => {
      calls.push({
        executable,
        args,
        electronRunAsNode: options.env.ELECTRON_RUN_AS_NODE,
      })
      return { status: 0 }
    })

    expect(calls).toEqual([{
      executable: join('/candidate/mac-arm64', '洞见.app', 'Contents', 'MacOS', '洞见'),
      args: [
        '-e',
        'require(process.argv[1])',
        join(
          '/candidate/mac-arm64',
          '洞见.app',
          'Contents',
          'Resources',
          'app.asar',
          'node_modules',
          'fs-ext',
        ),
      ],
      electronRunAsNode: '1',
    }])
    expect(() => {
      module.verifyPackagedMacNativeModuleAbi(context, () => ({
        status: 1,
        stderr: 'NODE_MODULE_VERSION 127; requires NODE_MODULE_VERSION 148',
      }))
    }).toThrow('NODE_MODULE_VERSION 127')
    expect(() => {
      module.verifyPackagedMacNativeModuleAbi(
        { ...context, electronPlatformName: 'win32' },
        () => { throw new Error('Windows must skip the macOS native ABI verifier') },
      )
    }).not.toThrow()
  })

  it('verifies the copied macOS credential broker before final application signing', async () => {
    const scriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/verify-packaged-application.mjs'))
    const module = await import(scriptUrl.href) as {
      verifyPackagedMacCredentialBroker: (
        context: {
          appOutDir: string
          arch: number
          electronPlatformName: string
          packager: { appInfo: { productFilename: string } }
        },
        run: (
          executable: string,
          args: string[],
          options: { encoding: string },
        ) => { error?: Error; status: number | null; stderr?: string; stdout?: string },
      ) => void
    }
    const context = {
      appOutDir: '/candidate/mac-arm64',
      arch: 3,
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: '洞见' } },
    }
    const calls: Array<{ executable: string; args: string[]; encoding: string }> = []

    module.verifyPackagedMacCredentialBroker(context, (executable, args, options) => {
      calls.push({ executable, args, encoding: options.encoding })
      return { status: 0 }
    })

    expect(calls).toEqual([{
      executable: process.execPath,
      args: [
        '--import',
        'tsx/esm',
        join(import.meta.dirname, '../scripts/verify-final-macos-application.ts'),
        '--app',
        join('/candidate/mac-arm64', '洞见.app'),
        '--arch',
        'arm64',
        '--broker-only',
      ],
      encoding: 'utf8',
    }])
    expect(() => {
      module.verifyPackagedMacCredentialBroker({ ...context, arch: 4 }, () => ({ status: 0 }))
    }).toThrow('unsupported packaged macOS architecture')
    expect(() => {
      module.verifyPackagedMacCredentialBroker(context, () => ({
        status: 1,
        stderr: 'credential broker SHA-256 mismatch',
      }))
    }).toThrow('credential broker SHA-256 mismatch')
    expect(() => {
      module.verifyPackagedMacCredentialBroker(
        { ...context, electronPlatformName: 'win32' },
        () => { throw new Error('Windows must skip the macOS credential broker verifier') },
      )
    }).not.toThrow()
  })

  it('accepts a bounded application archive without generated output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-after-pack-'))
    const source = join(root, 'source')
    const appOutDir = join(root, 'mac-arm64')
    mkdirSync(source, { recursive: true })
    mkdirSync(join(appOutDir, 'resources'), { recursive: true })
    writeFileSync(join(source, 'package.json'), '{}\n')
    await createPackage(source, join(appOutDir, 'resources', 'app.asar'))

    const scriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/verify-packaged-application.mjs'))
    const module = await import(scriptUrl.href) as {
      verifyPackagedApplicationArchive: (asarPath: string, maxBytes?: number) => void
    }

    expect(() => {
      module.verifyPackagedApplicationArchive(join(appOutDir, 'resources', 'app.asar'))
    }).not.toThrow()
  })

  it('rejects unexpected top-level output and an archive above the size ceiling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-after-pack-'))
    const source = join(root, 'source')
    const appOutDir = join(root, 'mac-arm64')
    mkdirSync(join(source, 'release.previous-test'), { recursive: true })
    mkdirSync(join(appOutDir, 'resources'), { recursive: true })
    writeFileSync(join(source, 'release.previous-test', 'candidate.zip'), 'candidate')
    await createPackage(source, join(appOutDir, 'resources', 'app.asar'))

    const scriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/verify-packaged-application.mjs'))
    const module = await import(scriptUrl.href) as {
      verifyPackagedApplicationArchive: (asarPath: string, maxBytes?: number) => void
    }
    const asarPath = join(appOutDir, 'resources', 'app.asar')

    expect(() => {
      module.verifyPackagedApplicationArchive(join(appOutDir, 'resources', 'missing.asar'))
    }).toThrow('Packaged application archive is missing')
    expect(() => {
      module.verifyPackagedApplicationArchive(asarPath)
    }).toThrow(
      'contains unexpected top-level entries: release.previous-test',
    )
    expect(() => {
      module.verifyPackagedApplicationArchive(asarPath, 1)
    }).toThrow(
      'is unexpectedly large',
    )
  })

  it('rejects nested source maps, compiler state, and generated output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-after-pack-'))
    const source = join(root, 'source')
    const appOutDir = join(root, 'win-unpacked')
    mkdirSync(join(source, 'node_modules', 'example', 'output'), { recursive: true })
    mkdirSync(join(appOutDir, 'resources'), { recursive: true })
    writeFileSync(join(source, 'package.json'), '{}\n')
    writeFileSync(join(source, 'node_modules', 'example', 'index.js.map'), '{}\n')
    writeFileSync(join(source, 'node_modules', 'example', 'state.tsbuildinfo'), '{}\n')
    writeFileSync(join(source, 'node_modules', 'example', 'output', 'screen.png'), 'image\n')
    await createPackage(source, join(appOutDir, 'resources', 'app.asar'))

    const scriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/verify-packaged-application.mjs'))
    const module = await import(scriptUrl.href) as {
      verifyPackagedApplicationArchive: (asarPath: string, maxBytes?: number) => void
    }
    expect(() => {
      module.verifyPackagedApplicationArchive(join(appOutDir, 'resources', 'app.asar'))
    }).toThrow('contains development payloads')
  })

  it('rejects a required workspace peer omitted from the final archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-after-pack-'))
    const source = join(root, 'source')
    const owner = join(source, 'node_modules', '@deepseek-ai', 'dsh-owner')
    mkdirSync(owner, { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@gongchuang/desktop',
      dependencies: { '@deepseek-ai/dsh-owner': 'workspace:^' },
    }))
    writeFileSync(join(owner, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-owner',
      peerDependencies: { '@deepseek-ai/dsh-util-time': 'workspace:^' },
    }))
    const missingPeerAsar = join(root, 'missing-peer.asar')
    await createPackage(source, missingPeerAsar)

    const scriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/verify-packaged-application.mjs'))
    const module = await import(scriptUrl.href) as {
      verifyPackagedApplicationArchive: (asarPath: string, maxBytes?: number) => void
    }
    expect(() => { module.verifyPackagedApplicationArchive(missingPeerAsar) })
      .toThrow('dsh-owner -> @deepseek-ai/dsh-util-time')

    const peer = join(source, 'node_modules', '@deepseek-ai', 'dsh-util-time')
    mkdirSync(peer, { recursive: true })
    writeFileSync(join(peer, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-util-time',
    }))
    const completeAsar = join(root, 'complete.asar')
    await createPackage(source, completeAsar)
    expect(() => { module.verifyPackagedApplicationArchive(completeAsar) }).not.toThrow()
  })

  it('rejects an omitted root workspace dependency', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-after-pack-'))
    const source = join(root, 'source')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@gongchuang/desktop',
      dependencies: { '@deepseek-ai/dsh-owner': 'workspace:^' },
    }))
    const asarPath = join(root, 'missing-owner.asar')
    await createPackage(source, asarPath)

    const scriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/verify-packaged-application.mjs'))
    const module = await import(scriptUrl.href) as {
      verifyPackagedApplicationArchive: (asarPath: string, maxBytes?: number) => void
    }
    expect(() => { module.verifyPackagedApplicationArchive(asarPath) })
      .toThrow('@gongchuang/desktop -> @deepseek-ai/dsh-owner')
  })

  it('rejects an omitted direct host runtime dependency', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-after-pack-'))
    const source = join(root, 'source')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@gongchuang/desktop',
      dependencies: { 'word-extractor': '1.0.4' },
    }))
    const asarPath = join(root, 'missing-word-extractor.asar')
    await createPackage(source, asarPath)

    const scriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/verify-packaged-application.mjs'))
    const module = await import(scriptUrl.href) as {
      verifyPackagedApplicationArchive: (asarPath: string, maxBytes?: number) => void
    }
    expect(() => { module.verifyPackagedApplicationArchive(asarPath) })
      .toThrow('@gongchuang/desktop -> word-extractor')
  })

  it('allows optional workspace peers and checks peers across product scopes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-after-pack-'))
    const source = join(root, 'source')
    const owner = join(source, 'node_modules', '@gongchuang', 'owner')
    mkdirSync(owner, { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@gongchuang/desktop',
      dependencies: { '@gongchuang/owner': 'workspace:^' },
    }))
    writeFileSync(join(owner, 'package.json'), JSON.stringify({
      name: '@gongchuang/owner',
      peerDependencies: { '@deepseek-ai/dsh-optional': 'workspace:^' },
      peerDependenciesMeta: { '@deepseek-ai/dsh-optional': { optional: true } },
    }))
    const optionalAsar = join(root, 'optional-peer.asar')
    await createPackage(source, optionalAsar)

    const scriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/verify-packaged-application.mjs'))
    const module = await import(scriptUrl.href) as {
      verifyPackagedApplicationArchive: (asarPath: string, maxBytes?: number) => void
    }
    expect(() => { module.verifyPackagedApplicationArchive(optionalAsar) }).not.toThrow()

    writeFileSync(join(owner, 'package.json'), JSON.stringify({
      name: '@gongchuang/owner',
      peerDependencies: { '@deepseek-ai/dsh-required': 'workspace:^' },
    }))
    const requiredAsar = join(root, 'required-peer.asar')
    await createPackage(source, requiredAsar)
    expect(() => { module.verifyPackagedApplicationArchive(requiredAsar) })
      .toThrow('@gongchuang/owner -> @deepseek-ai/dsh-required')
  })

  it('uses the path separator required by the host ASAR reader', async () => {
    const scriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/verify-packaged-application.mjs'))
    const module = await import(scriptUrl.href) as {
      packagedNodeModuleManifestPath: (
        packageName: string,
        pathJoin?: (...parts: string[]) => string,
      ) => string
    }
    expect(module.packagedNodeModuleManifestPath(
      '@deepseek-ai/dsh-owner',
      (...parts) => win32.join(...parts),
    ))
      .toBe('node_modules\\@deepseek-ai\\dsh-owner\\package.json')
  })

  it('quarantines the unused Windows ARM64 ConPTY helper without touching x64', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-after-pack-'))
    const appOutDir = join(root, 'win-unpacked')
    const conptyRoot = join(
      appOutDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
      'third_party',
      'conpty',
      '1.2.3',
    )
    const arm64 = join(conptyRoot, 'win10-arm64')
    const x64 = join(conptyRoot, 'win10-x64')
    mkdirSync(arm64, { recursive: true })
    mkdirSync(x64, { recursive: true })
    writeFileSync(join(arm64, 'OpenConsole.exe'), 'arm64')
    writeFileSync(join(x64, 'OpenConsole.exe'), 'x64')

    const scriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/verify-packaged-application.mjs'))
    const module = await import(scriptUrl.href) as {
      quarantineUnusedWindowsConpty: (context: {
        appOutDir: string
        electronPlatformName: string
        outDir: string
      }) => string[]
    }
    const quarantined = module.quarantineUnusedWindowsConpty({
      appOutDir,
      electronPlatformName: 'win32',
      outDir: root,
    })

    expect(quarantined).toHaveLength(1)
    expect(existsSync(arm64)).toBe(false)
    expect(existsSync(join(quarantined[0], 'OpenConsole.exe'))).toBe(true)
    expect(existsSync(join(x64, 'OpenConsole.exe'))).toBe(true)
  })
})
