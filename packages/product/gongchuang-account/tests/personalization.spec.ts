import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PERSONALIZATION, PersonalizationStore, personalizationTool } from '../src/personalization.ts'

async function fixture() {
  const path = join(await mkdtemp(join(tmpdir(), 'gc-preferences-')), 'AGENTS.md')
  return { path, store: new PersonalizationStore(path) }
}

describe('shared personalization file', () => {
  it('creates editable defaults once and preserves existing custom or explicitly empty preferences', async () => {
    const { path, store } = await fixture()
    expect((await store.read()).instructions).toBe(DEFAULT_PERSONALIZATION)
    await store.save('先给简短结论，金额保留两位小数。')
    expect((await new PersonalizationStore(path).read()).instructions).toBe('先给简短结论，金额保留两位小数。')
    await store.save('')
    expect((await new PersonalizationStore(path).read()).instructions).toBe('')
    expect(await readFile(path, 'utf8')).toBe('')
  })

  it('reads a directly edited AGENTS.md instead of restoring stale settings', async () => {
    const { path, store } = await fixture()
    await store.read()
    await writeFile(path, '默认给出来源与不确定性。\n', 'utf8')
    expect((await store.read()).instructions).toBe('默认给出来源与不确定性。')
  })

  it('does not turn the settings editor limit into a startup gate for an existing AGENTS.md', async () => {
    const { path, store } = await fixture()
    const existing = '已有自定义指令\n'.repeat(1_000)
    await writeFile(path, existing, 'utf8')
    await expect(store.initialize()).resolves.toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe(existing)
    await store.settle()
  })

  it('writes conversation changes to the same file that settings and a restarted client read', async () => {
    const { path, store } = await fixture()
    const tool = personalizationTool(store)
    const execution = { agent: {} } as never
    await tool.execute({ action: 'read' }, execution)
    const instructions = `${DEFAULT_PERSONALIZATION}\n称呼我为委托方，表格金额使用元。`
    const output = await tool.execute({ action: 'save', instructions }, execution)
    if (typeof output !== 'string') throw new Error('Expected a serialized preference receipt')
    const receipt = JSON.parse(output) as { instructions: string }
    expect(receipt.instructions).toBe(instructions)
    expect((await store.read()).instructions).toBe(instructions)
    expect((await new PersonalizationStore(path).read()).instructions).toBe(instructions)
    expect(await readFile(path, 'utf8')).toContain(instructions)
    await tool.execute({ action: 'reset' }, execution)
    expect((await store.read()).instructions).toBe(DEFAULT_PERSONALIZATION)
  })

  it('serializes writes and does not change the file for an invalid preference', async () => {
    const { path, store } = await fixture()
    const first = store.save('先保存的偏好')
    const second = store.save('后保存的偏好')
    await first
    await second
    expect((await store.read()).instructions).toBe('后保存的偏好')
    const before = await readFile(path, 'utf8')
    expect(() => store.save('字'.repeat(6_001))).toThrow('不能超过')
    expect(() => store.save('<!-- gongchuang-personalization:start -->')).toThrow('保留标记')
    expect(await readFile(path, 'utf8')).toBe(before)
  })
})
