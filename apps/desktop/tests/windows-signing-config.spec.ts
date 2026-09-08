import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const configPath = resolve(import.meta.dirname, '../electron-builder.windows.cjs')
const packagePath = resolve(import.meta.dirname, '../package.json')

describe('Windows packaging configuration', () => {
  it('builds the explicitly approved unsigned package without publisher verification', async () => {
    const config = await import(configPath) as unknown as {
      default: {
        forceCodeSigning: boolean
        npmRebuild: boolean
        win: {
          files: string[]
          signAndEditExecutable: boolean
          verifyUpdateCodeSignature: boolean
          azureSignOptions?: unknown
        }
      }
    }
    expect(config.default.forceCodeSigning).toBe(false)
    expect(config.default.npmRebuild).toBe(false)
    expect(config.default.win).toMatchObject({
      signAndEditExecutable: true,
      verifyUpdateCodeSignature: false,
    })
    expect(config.default.win.files).toContain('!**/node_modules/fs-ext/**')
    expect(config.default.win.azureSignOptions).toBeUndefined()
  })

  it('routes both Windows package commands through the Windows config', async () => {
    const packageJson = await import(packagePath, { with: { type: 'json' } }) as {
      default: { scripts: Record<string, string> }
    }
    expect(packageJson.default.scripts['package:dir:win']).toContain('--config electron-builder.windows.cjs')
    expect(packageJson.default.scripts['dist:win']).toContain('--config electron-builder.windows.cjs')
  })
})
