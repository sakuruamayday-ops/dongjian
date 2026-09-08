import { describe, expect, it } from 'vitest'
import { startupRepairUrl } from '../src/startup-repair.ts'

describe('startup repair installer selection', () => {
  it('selects the stable current-release repair route for each platform', () => {
    expect(startupRepairUrl('win32', 'x64')).toBe(
      'https://zshjiaotang.cn/client-updates/v0.2/repair/windows/x64',
    )
    expect(startupRepairUrl('darwin', 'arm64')).toBe(
      'https://zshjiaotang.cn/client-updates/v0.2/repair/macos/arm64',
    )
    expect(startupRepairUrl('darwin', 'x64')).toBe(
      'https://zshjiaotang.cn/client-updates/v0.2/repair/macos/x64',
    )
  })
})
