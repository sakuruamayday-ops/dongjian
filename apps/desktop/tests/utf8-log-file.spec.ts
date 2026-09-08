import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureUtf8LogFile } from '../src/utf8-log-file.ts'

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

describe('desktop UTF-8 log file', () => {
  it('creates a BOM and prefixes an existing BOM-less Chinese log exactly once', () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-utf8-log-'))
    const fresh = join(root, 'fresh', 'main.log')
    ensureUtf8LogFile(fresh)
    expect(readFileSync(fresh)).toEqual(BOM)

    const existing = join(root, 'existing.log')
    const line = Buffer.from('title=洞见 V0.2.3\n')
    writeFileSync(existing, line)
    ensureUtf8LogFile(existing)
    ensureUtf8LogFile(existing)
    expect(readFileSync(existing)).toEqual(Buffer.concat([BOM, line]))
  })
})
