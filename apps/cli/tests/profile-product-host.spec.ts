import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { Profile } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  boot: vi.fn(),
  healProfilesModuleFallback: vi.fn(),
  installFailLoud: vi.fn(),
  loadOptionalPatches: vi.fn(),
  loadOverlayPatches: vi.fn(),
  loadProfile: vi.fn(),
  watchUserPatches: vi.fn(),
  dir: '',
  bootPatches: [] as PatchOptions[],
  bootModuleBase: undefined as string | undefined,
  readyCommits: 0,
}))

vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  PROFILE_PATCH_FILENAME: 'cordis.patch.yml',
  PROFILES_DIR: 'profiles',
  boot: mocked.boot,
  composeEntries: (layers: PatchOptions[][]) => {
    const entries: EntryOptions[] = []
    for (const patch of layers.flat()) {
      if ('insert' in patch && Array.isArray(patch.insert)) {
        entries.push(...structuredClone(patch.insert))
        continue
      }
      if (!('id' in patch) || typeof patch.id !== 'string') continue
      const entry = entries.find(candidate => candidate.id === patch.id)
      if (entry === undefined) continue
      const update = structuredClone(patch)
      if (typeof entry.config === 'object' && entry.config !== null
        && typeof update.config === 'object' && update.config !== null) {
        update.config = { ...(entry.config as object), ...(update.config as object) }
      }
      Object.assign(entry, update)
    }
    return entries
  },
  healProfilesModuleFallback: mocked.healProfilesModuleFallback,
  installFailLoud: mocked.installFailLoud,
  loadOptionalPatches: mocked.loadOptionalPatches,
  loadOverlayPatches: mocked.loadOverlayPatches,
  loadProfile: mocked.loadProfile,
  watchUserPatches: mocked.watchUserPatches,
}))

import { runProfile } from '../src/profile-boot.ts'

const environment = createLaunchEnvironmentSnapshot([])
let priorHome: string | undefined
let processOn: { mockRestore: () => void }

/** Return a profile whose user patch follows the requested load policy. */
function profile(userLayer: boolean): Profile {
  return {
    name: 'web',
    dir: mocked.dir,
    layers: [{
      packageName: '@test/bundle',
      packageDir: mocked.dir,
      patchPath: join(mocked.dir, 'bundle.patch.yml'),
      patches: [{ insert: [{ id: 'protected', name: '@test/protected', config: { owner: 'bundle' } }] }],
    }],
    patchPath: join(mocked.dir, 'cordis.patch.yml'),
    patches: userLayer ? [{ id: 'protected', config: { owner: 'profile' } }] : [],
    patchReload: 'startup',
  }
}

beforeEach(async () => {
  priorHome = process.env.DSH_HOME
  mocked.dir = await mkdtemp(join(tmpdir(), 'dsh-profile-product-host-'))
  process.env.DSH_HOME = mocked.dir
  mocked.bootPatches = []
  mocked.bootModuleBase = undefined
  mocked.readyCommits = 0
  vi.clearAllMocks()
  processOn = vi.spyOn(process, 'on').mockImplementation(() => process)

  mocked.loadProfile.mockImplementation((
    _binName: string,
    _name: string,
    _installAnchor: string,
    _templates: unknown,
    options: { userLayer: boolean },
  ) => profile(options.userLayer))
  mocked.loadOverlayPatches.mockImplementation((_binName: string, path: string): PatchOptions[] => {
    if (path.endsWith('trusted.patch.yml')) return [{ id: 'protected', config: { owner: 'trusted-file' } }]
    return [{ id: 'protected', config: { owner: 'cli' } }]
  })
  mocked.loadOptionalPatches.mockReturnValue([{ id: 'protected', config: { owner: 'home' } }])
  mocked.healProfilesModuleFallback.mockResolvedValue(undefined)
  mocked.boot.mockImplementation(async (
    _binName: string,
    _rootConfig: string,
    patches: PatchOptions[],
    prepare: ((ctx: Context) => void) | undefined,
    moduleBase: string | undefined,
  ) => {
    mocked.bootPatches = patches
    mocked.bootModuleBase = moduleBase
    const ctx = new Context()
    ctx.provide('loader', { create: vi.fn() } as never)
    prepare?.(ctx)
    ctx.get('appReady')?.onReady(() => { mocked.readyCommits += 1 })
    return ctx
  })
})

afterEach(async () => {
  processOn.mockRestore()
  if (priorHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = priorHome
  await rm(mocked.dir, { recursive: true, force: true })
})

describe('profile boot for a product-owned Host', () => {
  it('keeps trusted patches above disabled user layers and uses the packaged module anchor', async () => {
    const validateComposition = vi.fn()
    const setupHost = vi.fn()
    const moduleBase = join(mocked.dir, 'app.asar', 'package.json')
    const result = await runProfile({
      environment,
      profile: 'web',
      patchFiles: ['cli.patch.yml'],
      args: [],
      trustedPatchFiles: ['trusted.patch.yml'],
      trustedPatches: [{ id: 'protected', config: { owner: 'trusted-memory' } }],
      userLayers: false,
      validateComposition,
      setupHost,
      hostOwnedModuleBaseUrl: moduleBase,
      processSignalHandlers: false,
    })

    expect(mocked.loadProfile).toHaveBeenCalledWith(
      'dsh', 'web', expect.any(String), undefined, { userLayer: false },
    )
    expect(mocked.loadOptionalPatches).not.toHaveBeenCalled()
    expect(mocked.healProfilesModuleFallback).not.toHaveBeenCalled()
    expect(mocked.bootModuleBase).toBe(moduleBase)
    expect(setupHost).toHaveBeenCalledOnce()
    expect(validateComposition).toHaveBeenCalledOnce()
    expect(validateComposition.mock.calls[0]?.[0]).toContainEqual(expect.objectContaining({
      id: 'protected',
      config: { owner: 'trusted-memory' },
    }))
    expect(mocked.readyCommits).toBe(1)
    expect(processOn).not.toHaveBeenCalled()

    await result.ctx.fiber.dispose()
  })

  it('retains alpha profile loading while anchoring a development Host at the healed fallback', async () => {
    const result = await runProfile({
      environment,
      profile: 'web',
      patchFiles: [],
      args: [],
      hostOwnedModuleResolution: true,
    })

    expect(mocked.loadProfile).toHaveBeenCalledWith(
      'dsh', 'web', expect.any(String), undefined, { userLayer: true },
    )
    expect(mocked.healProfilesModuleFallback).toHaveBeenCalledOnce()
    expect(mocked.loadOptionalPatches).toHaveBeenCalledOnce()
    expect(mocked.bootModuleBase).toBe(join(mocked.dir, 'profiles', '.host-module-resolution.cjs'))
    expect(mocked.readyCommits).toBe(1)
    expect(processOn).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
    expect(processOn).toHaveBeenCalledWith('SIGINT', expect.any(Function))

    await result.ctx.fiber.dispose()
  })
})
