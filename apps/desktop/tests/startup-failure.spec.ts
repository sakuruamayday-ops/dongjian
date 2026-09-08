import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const mainPath = resolve(import.meta.dirname, '../src/main.ts')
const main = readFileSync(mainPath, 'utf8')

describe('desktop startup failure contract', () => {
  test('uses a non-blocking dialog and a bounded fail-closed exit', () => {
    expect(main).toContain('const STARTUP_FAILURE_EXIT_TIMEOUT_MS = 15_000')
    expect(main).toContain('dialog.showMessageBox({')
    expect(main).not.toContain('dialog.showErrorBox(')
    expect(main).toContain('const exitTimer = setTimeout(exit, STARTUP_FAILURE_EXIT_TIMEOUT_MS)')
    expect(main).toContain('app.exit(1)')
    expect(main).toContain("gongchuangUserError(error, 'startup')")
    expect(main).toContain('detail: presented.text')
    expect(main).not.toContain('detail: message')
  })

  test('exits immediately in isolated acceptance mode', () => {
    expect(main).toContain('if (acceptanceUserDataRoot !== undefined)')
    expect(main).toMatch(/if \(acceptanceUserDataRoot !== undefined\) \{\s+exit\(\)\s+return/u)
  })

  test('pins bundled Python output to UTF-8 for Windows command results', () => {
    expect(main).toContain("process.env.PYTHONUTF8 = '1'")
    expect(main).toContain("process.env.PYTHONIOENCODING = 'utf-8'")
  })

  test('keeps the signed Python runtime out of ordinary task commands', () => {
    expect(main).not.toContain('process.env.GONGCHUANG_PYTHON_EXECUTABLE = python')
    expect(main).not.toContain('process.env.PATH = [...commandDirectories')
    expect(main).toContain("process.env.PYTHONDONTWRITEBYTECODE = '1'")
    expect(main).toContain("process.env.PYTHONNOUSERSITE = '1'")
    expect(main).toContain("process.env.PIP_REQUIRE_VIRTUALENV = '1'")
  })

  test('offers the current full installer after a packaged startup failure', () => {
    expect(main).toContain("buttons: offersRepair ? ['下载完整修复安装包', '关闭'] : ['关闭']")
    expect(main).toContain("startupRepairUrl(process.platform as 'darwin' | 'win32', arch)")
    expect(main).toContain('openPublicExternal(url')
  })
})
