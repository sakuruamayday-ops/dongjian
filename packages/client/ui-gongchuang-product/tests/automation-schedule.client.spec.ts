// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  editableCustomCadence, parseNaturalSchedule, validAutomationInterval,
} from '../src/client/automation-schedule.ts'

const NOW = new Date(2026, 7, 15, 10, 20, 0, 0)

describe('中文自动化时间识别', () => {
  it('识别每天和每周的本地执行时间', () => {
    expect(parseNaturalSchedule('每天上午 9 点检查政策', NOW)).toMatchObject({
      everySeconds: 86_400,
      cadenceLabel: '每天',
      firstRunAt: '2026-08-16T09:00',
    })
    expect(parseNaturalSchedule('每周一上午 9 点 30 分巡检材料', NOW)).toMatchObject({
      everySeconds: 604_800,
      cadenceLabel: '每周一',
      firstRunAt: '2026-08-17T09:30',
    })
  })

  it('识别自定义间隔和明确的首次执行时间', () => {
    expect(parseNaturalSchedule('从明天下午 2 点开始，每隔 90 分钟检查一次', NOW)).toMatchObject({
      everySeconds: 5_400,
      cadenceLabel: '每 90 分钟',
      firstRunAt: '2026-08-16T14:00',
    })
  })

  it('拒绝不完整或越界的时间描述', () => {
    expect(() => parseNaturalSchedule('每周一检查政策', NOW)).toThrow(/具体时分/)
    expect(() => parseNaturalSchedule('每隔 2 分钟检查政策', NOW)).toThrow(/5 分钟/)
    expect(validAutomationInterval(300)).toBe(true)
    expect(validAutomationInterval(299)).toBe(false)
    expect(editableCustomCadence(172_800)).toEqual({ amount: 2, unit: 'days' })
  })
})
