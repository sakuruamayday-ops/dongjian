import { chmodSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_MODE_ENV,
  ACCEPTANCE_ROOT_ENV,
  resolveAcceptanceUserDataRoot,
  sanitizeAcceptanceLaunchEnvironment,
} from '../src/acceptance-user-data.ts'

function isolatedRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `gongchuang-${label}-`))
  chmodSync(root, 0o700)
  return root
}

describe('macOS acceptance user-data isolation', () => {
  it('leaves ordinary launches on Electron default paths', () => {
    expect(resolveAcceptanceUserDataRoot({}, 'darwin')).toBeUndefined()
  })

  it('accepts only an explicit private directory below the user temp root', () => {
    const root = isolatedRoot('acceptance-root')
    expect(resolveAcceptanceUserDataRoot({
      [ACCEPTANCE_MODE_ENV]: '1',
      [ACCEPTANCE_ROOT_ENV]: root,
    }, 'darwin')).toBe(realpathSync(root))
  })

  it('rejects an override without acceptance mode and rejects broad roots', () => {
    const root = isolatedRoot('mode-required')
    expect(() => resolveAcceptanceUserDataRoot({ [ACCEPTANCE_ROOT_ENV]: root }, 'darwin'))
      .toThrow('只能在显式验收模式下使用')
    expect(() => resolveAcceptanceUserDataRoot({
      [ACCEPTANCE_MODE_ENV]: '1',
      [ACCEPTANCE_ROOT_ENV]: tmpdir(),
    }, 'darwin')).toThrow('必须位于当前用户临时目录内')
  })

  it('rejects permissive and symlink roots', () => {
    const permissive = isolatedRoot('permissive')
    chmodSync(permissive, 0o755)
    expect(() => resolveAcceptanceUserDataRoot({
      [ACCEPTANCE_MODE_ENV]: '1',
      [ACCEPTANCE_ROOT_ENV]: permissive,
    }, 'darwin')).toThrow('权限必须为 0700')

    const target = isolatedRoot('symlink-target')
    const linkParent = isolatedRoot('symlink-parent')
    const link = join(linkParent, 'root-link')
    symlinkSync(target, link)
    expect(() => resolveAcceptanceUserDataRoot({
      [ACCEPTANCE_MODE_ENV]: '1',
      [ACCEPTANCE_ROOT_ENV]: link,
    }, 'darwin')).toThrow('非符号链接目录')
  })

  it('keeps the real HOME but strips inherited credentials from lifecycle acceptance', () => {
    expect(sanitizeAcceptanceLaunchEnvironment({
      HOME: '/Users/example',
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'redacted',
      OPENCODE_API_KEY: 'redacted',
      GITHUB_TOKEN: 'redacted',
      INDIRECT_VALUE: 'sk-redacted',
      GONGCHUANG_ACCEPTANCE_MODE: '1',
    })).toEqual({
      HOME: '/Users/example',
      PATH: '/usr/bin',
      GONGCHUANG_ACCEPTANCE_MODE: '1',
    })
  })
})
