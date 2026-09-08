import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeOcrPages, selectOcrPdfPages } from '../src/pdf-pages.ts'

const launch = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>())
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => launch(...args) }))

describe('workspace PDF page selection', () => {
  beforeEach(() => { launch.mockReset() })

  it('retains requested page order and removes duplicates', () => {
    expect(normalizeOcrPages([3, 1, 3])).toEqual([3, 1])
  })

  it.each([[], [0], [-1], [1.5], [NaN], Array.from({ length: 201 }, (_, index) => index + 1)].map(pages => ({ pages })))(
    'rejects invalid page lists before executing a process', ({ pages }) => {
      expect(() => normalizeOcrPages(pages)).toThrow('OCR 页码')
      expect(launch).not.toHaveBeenCalled()
    },
  )

  it('passes immutable bytes over stdin to the isolated no-bytecode interpreter', async () => {
    let payload: unknown
    launch.mockImplementation((python, args, options, callback) => {
      expect(python).toBe('/verified/python3')
      expect((args as string[]).slice(0, 3)).toEqual(['-I', '-B', '-c'])
      expect(options).toMatchObject({ timeout: 30_000, maxBuffer: 24 * 1024 * 1024 })
      return { stdin: { on: vi.fn(), end: (input: string) => {
        payload = JSON.parse(input) as unknown
        ;(callback as (error: Error | null, stdout: Buffer, stderr: Buffer) => void)(null, Buffer.from('%PDF-selected'), Buffer.alloc(0))
      } } }
    })
    const input = new Uint8Array([1, 2, 3])
    const result = await selectOcrPdfPages('/verified/python3', input, [2], new AbortController().signal)
    expect(payload).toEqual({ pdf: 'AQID', pages: [2] })
    expect(input).toEqual(new Uint8Array([1, 2, 3]))
    expect(Buffer.from(result).toString()).toBe('%PDF-selected')
  })

  it.each([
    [new Error('failed'), '', 'page exceeds the PDF page count', '指定页读取失败'],
    [null, 'not a pdf', '', '未返回有效 PDF'],
  ])('does not forward a failed or invalid extraction', async (error, stdout, stderr, expected) => {
    launch.mockImplementation((_python, _args, _options, callback) => ({ stdin: {
      on: vi.fn(),
      end: () => {
        (callback as (failure: unknown, output: Buffer, errors: Buffer) => void)(
          error,
          Buffer.from(stdout),
          Buffer.from(stderr),
        )
      },
    } }))
    await expect(selectOcrPdfPages('/verified/python3', new Uint8Array([1]), [2], new AbortController().signal))
      .rejects.toThrow(expected)
  })

  it('does not launch a cancelled selection', () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    expect(() => selectOcrPdfPages('/verified/python3', new Uint8Array([1]), [2], controller.signal)).toThrow('cancelled')
    expect(launch).not.toHaveBeenCalled()
  })
})
