/** V2 history records become one event-shaped Client value per wire record. */

import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionHistoryRecord } from '../src/types.ts'
import {
  historyEntries,
  historyRecordFirstSeq,
  historyRecordLastSeq,
} from '../src/client/sessions/history-records.ts'

describe('Session history record projection', () => {
  it('retains an ordinary event and its point cursor', () => {
    const ordinary: SessionHistoryRecord = {
      type: 'event',
      event: { type: 'turn/start', seq: 7, time: 1, data: { turn: 1 } },
    }

    const records = [ordinary]
    const [entry] = historyEntries(records)

    expect(historyEntries(records)).toBe(records)
    expect(entry).toBe(ordinary)
    expect(historyRecordFirstSeq(ordinary)).toBe(7)
    expect(entry?.event.time).toBe(1)
    expect(historyRecordLastSeq(ordinary)).toBe(7)
  })

  it('retains one message with an embedded compact text stream', () => {
    const message: SessionHistoryRecord = {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 11,
        time: 20,
        data: {
          turn: 1,
          step: 2,
          message: {
            id: 'message-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'abcd' }],
            source: { kind: 'model', provider: 'fixture', model: 'fixture-v2' },
          },
          stream: [{ type: 'text-chunks', time0: 20, index: 0, dt: [1, 2, 3], texts: ['a', 'b', 'c', 'd'] }],
        },
      },
    }

    const [entry] = historyEntries([message])
    if (entry?.type !== 'event') throw new Error('expected v2 history entry')
    const { event } = entry

    expect(entry).toBe(message)
    expect(event).toBe(message.event)
    expect(historyRecordFirstSeq(message)).toBe(11)
    expect(event.time).toBe(20)
    expect(historyRecordLastSeq(message)).toBe(11)
  })

  it('preserves an attempt stream and optional tool-name absence', () => {
    const attempt: SessionHistoryRecord = {
      type: 'event',
      event: {
        type: 'assistant/attempt',
        seq: 20,
        time: 200,
        data: {
          turn: 2,
          step: 4,
          stream: [{
            type: 'tool-call-chunks',
            time0: 200,
            index: 1,
            id: ToolCallId('call-1'),
            dt: [2, 3],
            args: ['', '{"x":', '1}'],
          }],
        },
      },
    }

    const [entry] = historyEntries([attempt])
    if (entry?.type !== 'event') throw new Error('expected v2 history entry')
    const { event } = entry

    if (event.type !== 'assistant/attempt') throw new Error('expected Assistant attempt event')
    expect(event).toBe(attempt.event)
    const [record] = event.data.stream
    expect(record).toMatchObject({ type: 'tool-call-chunks', id: 'call-1' })
    expect(Object.hasOwn(record as object, 'name')).toBe(false)
    expect(historyRecordLastSeq(attempt)).toBe(20)
  })

  it('restores legacy nested Tool coordinates from the preceding root call', () => {
    const records = [
      {
        type: 'event',
        event: {
          type: 'tool/call', seq: 30, time: 300,
          data: {
            turn: 4, step: 2, callId: ToolCallId('root-call'), name: 'run_code', arguments: '{}',
          },
        },
      },
      {
        type: 'event',
        event: {
          type: 'tool/code-dispatch-start', seq: 31, time: 301,
          data: {
            rootCallId: ToolCallId('root-call'), parentCallId: ToolCallId('root-call'),
            subCallId: ToolCallId('root-call:code:1'), name: 'gongchuang_publish_files',
            arguments: { paths: ['report.docx'] },
          },
        },
      },
      {
        type: 'event',
        event: {
          type: 'tool/code-dispatch', seq: 32, time: 302,
          data: {
            rootCallId: ToolCallId('root-call'), parentCallId: ToolCallId('root-call'),
            subCallId: ToolCallId('root-call:code:1'), name: 'gongchuang_publish_files',
            arguments: { paths: ['report.docx'] }, isError: false, content: [],
          },
        },
      },
    ] as const satisfies readonly SessionHistoryRecord[]

    const projected = historyEntries(records)

    expect(projected).not.toBe(records)
    expect(projected[0]).toBe(records[0])
    expect(projected[1]?.event.data).toMatchObject({ turn: 4, step: 2 })
    expect(projected[2]?.event.data).toMatchObject({ turn: 4, step: 2 })
    expect(records[1].event.data).not.toHaveProperty('turn')
  })

  it('does not guess locations for current, partial, or orphan nested Tool events', () => {
    const records = [
      {
        type: 'event',
        event: {
          type: 'tool/code-dispatch', seq: 40, time: 400,
          data: {
            rootCallId: ToolCallId('missing-root'), parentCallId: ToolCallId('missing-root'),
            subCallId: ToolCallId('missing-root:code:1'), name: 'gongchuang_publish_files',
            arguments: { paths: ['orphan.docx'] }, isError: false, content: [],
          },
        },
      },
      {
        type: 'event',
        event: {
          type: 'tool/call', seq: 41, time: 401,
          data: {
            turn: 5, step: 3, callId: ToolCallId('current-root'), name: 'run_code', arguments: '{}',
          },
        },
      },
      {
        type: 'event',
        event: {
          type: 'tool/code-dispatch', seq: 42, time: 402,
          data: {
            rootCallId: ToolCallId('current-root'), parentCallId: ToolCallId('current-root'),
            subCallId: ToolCallId('current-root:code:1'), turn: 5, step: 3,
            name: 'gongchuang_publish_files', arguments: { paths: ['current.docx'] },
            isError: false, content: [],
          },
        },
      },
      {
        type: 'event',
        event: {
          type: 'tool/code-dispatch', seq: 43, time: 403,
          data: {
            rootCallId: ToolCallId('current-root'), parentCallId: ToolCallId('current-root'),
            subCallId: ToolCallId('current-root:code:2'), turn: 5,
            name: 'gongchuang_publish_files', arguments: { paths: ['partial.docx'] },
            isError: false, content: [],
          },
        },
      },
    ] as const satisfies readonly SessionHistoryRecord[]

    expect(historyEntries(records)).toBe(records)
  })
})
