import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { moveGeneratedPathToTrash } from './move-generated-path-to-trash.ts'

describe('generated Python overlay residue', () => {
  it('moves pip-only entries into the configured recoverable Trash root', () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-overlay-trash-'))
    const candidate = join(root, 'candidate')
    const generatedBin = join(candidate, 'bin')
    const trashRoot = join(root, 'Trash')
    mkdirSync(generatedBin, { recursive: true })
    writeFileSync(join(generatedBin, 'fitz'), 'generated console script\n')

    const destination = moveGeneratedPathToTrash(generatedBin, trashRoot)

    expect(existsSync(generatedBin)).toBe(false)
    expect(existsSync(candidate)).toBe(true)
    expect(destination?.startsWith(`${trashRoot}/gongchuang-python-overlay-`)).toBe(true)
    expect(readFileSync(join(destination ?? '', 'fitz'), 'utf8')).toBe('generated console script\n')
  })

  it('does nothing when pip produced no script directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-overlay-trash-'))
    const trashRoot = join(root, 'Trash')

    expect(moveGeneratedPathToTrash(join(root, 'missing'), trashRoot)).toBeUndefined()
    expect(existsSync(trashRoot)).toBe(false)
  })
})
