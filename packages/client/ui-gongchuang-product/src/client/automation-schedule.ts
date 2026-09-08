const MIN_INTERVAL_SECONDS = 300
const MAX_INTERVAL_SECONDS = 31_536_000

const UNIT_SECONDS = {
  minutes: 60,
  hours: 3_600,
  days: 86_400,
  weeks: 604_800,
} as const

/** Units exposed by the bounded custom interval editor. */
export type CustomCadenceUnit = keyof typeof UNIT_SECONDS

/** Deterministic projection of one supported Chinese schedule phrase. */
export interface ParsedNaturalSchedule {
  readonly everySeconds: number
  readonly cadenceLabel: string
  readonly firstRunAt: string
  readonly summary: string
}

/** Editable amount and unit reconstructed from a fixed interval. */
export interface CustomCadence {
  readonly amount: number
  readonly unit: CustomCadenceUnit
}

const WEEKDAY = new Map([
  ['日', 0], ['天', 0], ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6],
])

const UNIT_LABEL: Readonly<Record<CustomCadenceUnit, string>> = {
  minutes: '分钟', hours: '小时', days: '天', weeks: '周',
}

/**
 * Convert a Date into the minute-precision value expected by datetime-local.
 * @param date - Local instant to render.
 * @returns Minute-precision local input value.
 */
export function localDateTimeValue(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 16)
}

/**
 * Default a new task to the next safe full local hour.
 * @param now - Current local time.
 * @returns Minute-precision local input value.
 */
export function nextLocalHour(now = new Date()): string {
  const date = new Date(now)
  date.setMinutes(0, 0, 0)
  if (date.getTime() < now.getTime() + 120_000) date.setHours(date.getHours() + 1)
  return localDateTimeValue(date)
}

/**
 * Compute the earliest manual value accepted by the Host future-time guard.
 * @param now - Current local time.
 * @returns Next minute as a local input value.
 */
export function minimumLocalMinute(now = new Date()): string {
  const date = new Date(now.getTime() + 60_000)
  date.setSeconds(0, 0)
  return localDateTimeValue(date)
}

/**
 * Convert a stored ISO timestamp or a new-task default into a local form value.
 * @param value - Stored ISO timestamp, or null for a new task.
 * @param now - Current local time used for the new-task default.
 * @returns Minute-precision local input value.
 */
export function localInputTime(value: string | null, now = new Date()): string {
  return value === null ? nextLocalHour(now) : localDateTimeValue(new Date(value))
}

/**
 * Convert a positive custom amount and unit into seconds.
 * @param amount - Whole-number interval amount.
 * @param unit - Selected interval unit.
 * @returns Interval seconds, or zero when the amount is invalid.
 */
export function customCadenceSeconds(amount: number, unit: CustomCadenceUnit): number {
  if (!Number.isSafeInteger(amount) || amount < 1) return 0
  return amount * UNIT_SECONDS[unit]
}

/**
 * Check the Host's fixed-interval bounds.
 * @param seconds - Candidate interval in seconds.
 * @returns Whether the interval is an accepted safe integer.
 */
export function validAutomationInterval(seconds: number): boolean {
  return Number.isSafeInteger(seconds)
    && seconds >= MIN_INTERVAL_SECONDS
    && seconds <= MAX_INTERVAL_SECONDS
}

/**
 * Render the user-facing Chinese custom cadence label.
 * @param amount - Whole-number interval amount.
 * @param unit - Selected interval unit.
 * @returns Chinese cadence label.
 */
export function customCadenceLabel(amount: number, unit: CustomCadenceUnit): string {
  return `每 ${String(amount)} ${UNIT_LABEL[unit]}`
}

/**
 * Pick the largest exact unit so existing custom values remain easy to edit.
 * @param seconds - Existing fixed interval in seconds.
 * @returns Editable amount and unit.
 */
export function editableCustomCadence(seconds: number): CustomCadence {
  for (const unit of ['weeks', 'days', 'hours', 'minutes'] as const) {
    const size = UNIT_SECONDS[unit]
    if (seconds % size === 0) return { amount: seconds / size, unit }
  }
  return { amount: Math.max(5, Math.ceil(seconds / 60)), unit: 'minutes' }
}

interface ClockValue { hour: number; minute: number }

function clockFrom(text: string): ClockValue | null {
  const match = text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*(?:[:：点时]\s*(\d{1,2})?)?\s*(半|分)?/)
  if (match === null) return null
  const period = match[1] ?? ''
  let hour = Number(match[2])
  const minute = match[4] === '半' ? 30 : Number(match[3] ?? 0)
  if (period === '下午' || period === '傍晚' || period === '晚上') {
    if (hour < 12) hour += 12
  } else if (period === '中午' && hour < 11) {
    hour += 12
  } else if (period === '凌晨' && hour === 12) {
    hour = 0
  }
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null
  return { hour, minute }
}

function nextDaily(clock: ClockValue, now: Date): Date {
  const result = new Date(now)
  result.setHours(clock.hour, clock.minute, 0, 0)
  if (result.getTime() <= now.getTime() + 30_000) result.setDate(result.getDate() + 1)
  return result
}

function nextWeekly(day: number, clock: ClockValue, now: Date): Date {
  const result = new Date(now)
  result.setHours(clock.hour, clock.minute, 0, 0)
  let distance = (day - result.getDay() + 7) % 7
  if (distance === 0 && result.getTime() <= now.getTime() + 30_000) distance = 7
  result.setDate(result.getDate() + distance)
  return result
}

function explicitStart(text: string, now: Date): Date | null {
  // oxlint-disable-next-line @stylistic/max-len -- keep this Chinese date-and-clock grammar auditable as one expression
  const absolute = text.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?[^\d]{0,8}?((?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*\d{1,2}\s*(?:[:：点时]\s*\d{0,2})?\s*(?:半|分)?)/)
  if (absolute !== null) {
    const clock = clockFrom(absolute[4] ?? '')
    if (clock === null) return null
    const result = new Date(Number(absolute[1]), Number(absolute[2]) - 1, Number(absolute[3]), clock.hour, clock.minute, 0, 0)
    return Number.isNaN(result.getTime()) ? null : result
  }
  const relative = text.match(/(今天|明天)[^\d]{0,8}?((?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*\d{1,2}\s*(?:[:：点时]\s*\d{0,2})?\s*(?:半|分)?)/)
  if (relative === null) return null
  const clock = clockFrom(relative[2] ?? '')
  if (clock === null) return null
  const result = new Date(now)
  if (relative[1] === '明天') result.setDate(result.getDate() + 1)
  result.setHours(clock.hour, clock.minute, 0, 0)
  return result
}

function readableTime(value: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(value)
}

/**
 * Deterministically recognize the common Chinese schedules used by business users.
 * The result only fills a reviewable form; saving remains an explicit user action.
 * @param text - User-authored Chinese schedule phrase.
 * @param now - Current local time used to resolve the next occurrence.
 * @returns Parsed fixed interval, first run, label, and review summary.
 */
export function parseNaturalSchedule(text: string, now = new Date()): ParsedNaturalSchedule {
  const normalized = text.trim().replace(/\s+/g, ' ')
  if (normalized === '') throw new Error('请先描述执行时间，例如“每周一上午 9 点”。')

  const weekly = normalized.match(/每周\s*([一二三四五六日天])/)
  if (weekly !== null) {
    const clock = clockFrom(normalized.slice((weekly.index ?? 0) + weekly[0].length))
    if (clock === null) throw new Error('请补充每周任务的具体时分，例如“每周一上午 9 点”。')
    const dayText = weekly[1] ?? ''
    const day = WEEKDAY.get(dayText)
    if (day === undefined) throw new Error('无法识别星期，请使用周一至周日。')
    const first = nextWeekly(day, clock, now)
    return {
      everySeconds: 604_800,
      cadenceLabel: `每周${dayText}`,
      firstRunAt: localDateTimeValue(first),
      summary: `已识别：每周${dayText}执行，下次为 ${readableTime(first)}`,
    }
  }

  if (/每天|每日/.test(normalized)) {
    const clock = clockFrom(normalized.replace(/^.*?(?:每天|每日)/, ''))
    if (clock === null) throw new Error('请补充每天任务的具体时分，例如“每天上午 9 点”。')
    const first = nextDaily(clock, now)
    return {
      everySeconds: 86_400,
      cadenceLabel: '每天',
      firstRunAt: localDateTimeValue(first),
      summary: `已识别：每天执行，下次为 ${readableTime(first)}`,
    }
  }

  const interval = normalized.match(/每(?:隔)?\s*(\d{1,4})\s*(分钟|小时|天|周)/)
  if (interval === null) {
    throw new Error('暂未识别时间。支持“每天 9 点”“每周一 9 点”或“每隔 90 分钟”等说法。')
  }
  const amount = Number(interval[1])
  const unitText = interval[2] ?? ''
  const unit = unitText === '分钟' ? 'minutes'
    : unitText === '小时' ? 'hours'
      : unitText === '天' ? 'days' : 'weeks'
  const everySeconds = customCadenceSeconds(amount, unit)
  if (!validAutomationInterval(everySeconds)) throw new Error('执行间隔需在 5 分钟至 365 天之间。')
  const statedStart = explicitStart(normalized, now)
  const first = statedStart ?? new Date(now.getTime() + everySeconds * 1_000)
  if (first.getTime() <= now.getTime() + 30_000) throw new Error('首次执行时间必须晚于当前时间。')
  const cadenceLabel = customCadenceLabel(amount, unit)
  return {
    everySeconds,
    cadenceLabel,
    firstRunAt: localDateTimeValue(first),
    summary: `已识别：${cadenceLabel}执行，下次为 ${readableTime(first)}`,
  }
}
