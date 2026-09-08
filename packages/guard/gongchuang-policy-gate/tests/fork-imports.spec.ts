import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { preserveForkImports } from '../src/fork-imports.ts'

const fs = vi.hoisted(() => ({ files: new Map<string, string>(), copied: [] as string[] }))
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(), realpath: async (path: string) => path,
  lstat: async (path: string) => {
    if (!fs.files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return { isFile: () => true, isSymbolicLink: () => false }
  },
  readFile: async (path: string) => Buffer.from(fs.files.get(path)!),
  copyFile: async (source: string, target: string) => {
    if (fs.files.has(target)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    fs.files.set(target, fs.files.get(source)!)
    fs.copied.push(target)
  },
}))

const request = {
  sourceCwd: '/source', targetCwd: '/target',
  events: [{ type: 'user/message', data: {
    source: { kind: 'user', displayText: '@"导入资料/report.docx"\nReview' }, content: [],
  } }] as unknown as SessionEvent[],
}

beforeEach(() => { fs.files.clear(); fs.copied.length = 0; fs.files.set('/source/导入资料/report.docx', 'original') })

describe('cross-workspace imported files', () => {
  it('copies referenced imports and preserves the source, then permits an identical retry', async () => {
    fs.files.set('/source/导入资料/unrelated.docx', 'unrelated')
    await preserveForkImports(request)
    await preserveForkImports(request)
    expect(fs.copied).toEqual(['/target/导入资料/report.docx'])
    expect(fs.files.get('/source/导入资料/report.docx')).toBe('original')
    expect(fs.files.get('/target/导入资料/report.docx')).toBe('original')
    expect(fs.files.has('/target/导入资料/unrelated.docx')).toBe(false)
  })

  it('rejects a same-name different file without overwriting either file', async () => {
    fs.files.set('/target/导入资料/report.docx', 'another company')
    await expect(preserveForkImports(request)).rejects.toThrow('同名附件')
    expect(fs.files.get('/target/导入资料/report.docx')).toBe('another company')
    expect(fs.copied).toEqual([])
  })

  it('does not create a conversation with a missing source attachment', async () => {
    fs.files.clear()
    await expect(preserveForkImports(request)).rejects.toThrow('missing')
    expect(fs.copied).toEqual([])
  })
})
