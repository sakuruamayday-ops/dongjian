import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const modelSelectCss = readFileSync(resolve(import.meta.dirname, '../src/client/ModelSelect.module.css'), 'utf8')

describe('ModelSelect trigger chrome', () => {
  it('keeps the trigger frameless while retaining a visible keyboard-focus surface', () => {
    expect(modelSelectCss).toMatch(/\.trigger \{[\s\S]*?border: none;[\s\S]*?outline: none;[\s\S]*?background: transparent;/u)
    expect(modelSelectCss).toMatch(/\.trigger:focus-visible \{\s*background: var\(--dsw-alias-interactive-bg-hover\);/u)
    expect(modelSelectCss).not.toMatch(/\.trigger:focus-visible \{[^}]*box-shadow:/u)
  })
})
