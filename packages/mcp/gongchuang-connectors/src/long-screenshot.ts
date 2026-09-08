/** Local, bounded preprocessing for OCR of very tall screenshots. */

import { createHash } from 'node:crypto'
import sharp from 'sharp'

const MAX_INPUT_PIXELS = 40_000_000
const MAX_CHUNKS = 16
const ANALYSIS_WIDTH = 320
const MIN_LONG_EDGE = 3_400
const MIN_LONG_RATIO = 2.6
const DEFAULT_OVERLAP = 48

/** One deterministic vertical crop sent to the configured OCR connector. */
export interface LongScreenshotChunk {
  readonly data: Uint8Array
  readonly mediaType: 'image/png'
  readonly index: number
  readonly total: number
  readonly top: number
  readonly bottom: number
  readonly overlapTop: number
  readonly overlapBottom: number
  readonly sha256: string
}

interface CoreRange {
  top: number
  bottom: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)))
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const index = clamp((ordered.length - 1) * ratio, 0, ordered.length - 1)
  return ordered[index] ?? 0
}

function rollingMean(values: readonly number[], radius: number): number[] {
  const prefix = new Float64Array(values.length + 1)
  for (let index = 0; index < values.length; index += 1) {
    prefix[index + 1] = (prefix[index] ?? 0) + (values[index] ?? 0)
  }
  return values.map((_value, index) => {
    const start = Math.max(0, index - radius)
    const end = Math.min(values.length, index + radius + 1)
    return ((prefix[end] ?? 0) - (prefix[start] ?? 0)) / Math.max(1, end - start)
  })
}

function rowEnergy(raw: Uint8Array, width: number, height: number): number[] {
  const rows = new Array<number>(height).fill(0)
  for (let y = 0; y < height; y += 1) {
    let energy = 0
    const offset = y * width
    const previous = Math.max(0, y - 1) * width
    for (let x = 1; x < width; x += 1) {
      const value = raw[offset + x] ?? 0
      energy += Math.abs(value - (raw[offset + x - 1] ?? value))
      energy += Math.abs(value - (raw[previous + x] ?? value)) * 0.4
    }
    rows[y] = energy / Math.max(1, width - 1)
  }
  return rollingMean(rows, 2)
}

function chooseCut(
  energy: readonly number[],
  start: number,
  target: number,
  minimum: number,
  maximum: number,
): number {
  const lower = Math.min(energy.length - 1, start + minimum)
  const upper = Math.min(energy.length - minimum, start + maximum)
  if (lower >= upper) return upper
  const local = energy.slice(lower, upper + 1)
  const low = percentile(local, 0.08)
  const high = percentile(local, 0.92)
  const span = Math.max(0.001, high - low)
  const desired = Math.min(energy.length - 1, start + target)
  let selected = lower
  let selectedScore = Number.POSITIVE_INFINITY
  for (let row = lower; row <= upper; row += 1) {
    const normalizedEnergy = ((energy[row] ?? high) - low) / span
    const distance = Math.abs(row - desired) / Math.max(1, maximum - minimum)
    const score = normalizedEnergy + distance * 0.28
    if (score < selectedScore) {
      selectedScore = score
      selected = row
    }
  }
  return selected
}

function normalizedLine(value: string): string {
  return value.trim().replaceAll(/\s+/g, ' ').toLocaleLowerCase('zh-CN')
}

/**
 * Merge OCR chunks while removing only exact repeated boundary lines.
 * Fuzzy deletion is intentionally avoided because policy numbers and names may
 * differ by one character and must never be silently collapsed.
 * @param chunks - OCR text ordered by deterministic screenshot chunk index.
 * @returns Joined OCR text with only exact boundary-line duplicates removed.
 */
export function mergeLongScreenshotText(chunks: readonly string[]): string {
  const merged: string[] = []
  for (const chunk of chunks) {
    const current = chunk.replaceAll('\r\n', '\n').split('\n')
    while (current.length > 0 && current[0]?.trim() === '') current.shift()
    while (current.length > 0 && current.at(-1)?.trim() === '') current.pop()
    const limit = Math.min(24, merged.length, current.length)
    let repeated = 0
    for (let size = limit; size > 0; size -= 1) {
      const suffix = merged.slice(-size).map(normalizedLine)
      const prefix = current.slice(0, size).map(normalizedLine)
      if (suffix.every((line, index) => line !== '' && line === prefix[index])) {
        repeated = size
        break
      }
    }
    if (merged.length > 0 && current.length > repeated) merged.push('')
    merged.push(...current.slice(repeated))
  }
  return merged.join('\n').replaceAll(/\n{3,}/g, '\n\n').trim()
}

/**
 * Split only unusually tall images. Cuts prefer low visual-energy rows and
 * retain a small overlap because image content cannot prove a blank boundary.
 * @param data - Original encoded image bytes.
 * @returns Deterministic PNG chunks with source ranges and content hashes.
 */
export async function splitLongScreenshot(data: Uint8Array): Promise<readonly LongScreenshotChunk[]> {
  const source = sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'warning' }).rotate()
  const metadata = await source.metadata()
  const { width, height } = metadata.autoOrient
  if (height <= MIN_LONG_EDGE || height / width < MIN_LONG_RATIO) {
    return Object.freeze([Object.freeze({
      data, mediaType: 'image/png' as const, index: 1, total: 1,
      top: 0, bottom: height, overlapTop: 0, overlapBottom: 0,
      sha256: createHash('sha256').update(data).digest('hex'),
    })])
  }

  const analysisWidth = Math.min(ANALYSIS_WIDTH, width)
  const analysisHeight = Math.max(1, Math.round(height * analysisWidth / width))
  const analysis = await source.clone().resize({ width: analysisWidth, height: analysisHeight, fit: 'fill' })
    .greyscale().raw().toBuffer()
  const energy = rowEnergy(analysis, analysisWidth, analysisHeight)
  const scale = analysisHeight / height
  const targetOriginal = clamp(width * 1.5, 1_200, 2_500)
  const minimumOriginal = Math.max(700, Math.round(targetOriginal * 0.58))
  const maximumOriginal = Math.min(3_500, Math.round(targetOriginal * 1.42))
  const target = Math.max(1, Math.round(targetOriginal * scale))
  const minimum = Math.max(1, Math.round(minimumOriginal * scale))
  const maximum = Math.max(minimum + 1, Math.round(maximumOriginal * scale))
  const cuts = [0]
  while (analysisHeight - (cuts.at(-1) ?? 0) > maximum) {
    const start = cuts.at(-1) ?? 0
    if (analysisHeight - start < minimum * 2) break
    const cut = chooseCut(energy, start, target, minimum, maximum)
    if (cut <= start) throw new Error('长截图切片边界没有前进')
    cuts.push(cut)
    if (cuts.length > MAX_CHUNKS) throw new Error(`长截图超过 ${String(MAX_CHUNKS)} 个安全切片上限`)
  }
  cuts.push(analysisHeight)
  const mapped = cuts.map((cut, index) => index === 0 ? 0 : index === cuts.length - 1
    ? height
    : clamp(cut / scale, 1, height - 1))
  const ranges: CoreRange[] = mapped.slice(0, -1).map((top, index) => ({
    top,
    bottom: mapped[index + 1] ?? height,
  }))
  if (ranges.length > MAX_CHUNKS) throw new Error(`长截图超过 ${String(MAX_CHUNKS)} 个安全切片上限`)

  const chunks = await Promise.all(ranges.map(async (range, index) => {
    const overlapTop = index === 0 ? 0 : DEFAULT_OVERLAP
    const overlapBottom = index === ranges.length - 1 ? 0 : DEFAULT_OVERLAP
    const top = Math.max(0, range.top - overlapTop)
    const bottom = Math.min(height, range.bottom + overlapBottom)
    const png = await source.clone().extract({ left: 0, top, width, height: bottom - top }).png().toBuffer()
    return Object.freeze({
      data: new Uint8Array(png), mediaType: 'image/png' as const,
      index: index + 1, total: ranges.length, top, bottom,
      overlapTop, overlapBottom,
      sha256: createHash('sha256').update(png).digest('hex'),
    })
  }))
  return Object.freeze(chunks)
}
