import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { mergeLongScreenshotText, splitLongScreenshot } from '../src/long-screenshot.ts'

describe('long screenshot OCR preprocessing', () => {
  it('leaves an ordinary image as one original-byte chunk', async () => {
    const image = await sharp({
      create: { width: 800, height: 1_200, channels: 3, background: '#ffffff' },
    }).png().toBuffer()
    const chunks = await splitLongScreenshot(image)
    expect(chunks).toHaveLength(1)
    expect(Buffer.from(chunks[0]?.data ?? [])).toEqual(image)
    expect(chunks[0]).toMatchObject({ index: 1, total: 1, top: 0, bottom: 1_200 })
    expect(chunks[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('cuts a tall screenshot into bounded overlapping PNG chunks', async () => {
    const image = await sharp({
      create: { width: 1_000, height: 8_000, channels: 3, background: '#ffffff' },
    }).png().toBuffer()
    const chunks = await splitLongScreenshot(image)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.length).toBeLessThanOrEqual(16)
    expect(chunks[0]).toMatchObject({ index: 1, total: chunks.length, top: 0, overlapTop: 0 })
    expect(chunks.at(-1)).toMatchObject({ index: chunks.length, total: chunks.length, bottom: 8_000, overlapBottom: 0 })
    for (const chunk of chunks) {
      const metadata = await sharp(chunk.data).metadata()
      expect(metadata.format).toBe('png')
      expect(metadata.width).toBe(1_000)
      expect(metadata.height).toBe(chunk.bottom - chunk.top)
      expect(chunk.sha256).toMatch(/^[0-9a-f]{64}$/u)
    }
    expect(new Set(chunks.map(chunk => chunk.sha256)).size).toBeGreaterThan(1)
  })

  it('removes exact boundary duplicates without fuzzy-merging policy facts', () => {
    expect(mergeLongScreenshotText([
      '申报主体：甲企业\n研发费用：120万元',
      '研发费用：120万元\n知识产权：8件',
      '知识产权：9件\n结论：待核验',
    ])).toBe('申报主体：甲企业\n研发费用：120万元\n\n知识产权：8件\n\n知识产权：9件\n结论：待核验')
  })
})
