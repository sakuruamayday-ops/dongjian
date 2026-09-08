import { describe, expect, it } from 'vitest'
import { assertReleasedPayloadSemantics, releasedV0SessionFormatCodec, sessionFormatV0ToV1 } from '../src/index.ts'
import type { SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'

const migrate = (type: string, data: SessionFormatJsonObject) => sessionFormatV0ToV1.migrate(
  releasedV0SessionFormatCodec.decodeArtifact({
    type: 'session', version: 0, id: 'product-migration', createdAt: 1, delegationDepth: 0,
  }, [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type, seq: 2, time: 4, data,
      ...(type === 'user/message' ? { surfaceOp: 'append' } : {}) },
  ]),
)
const user = (source: SessionFormatJsonObject) => ({ id: 'user-1', role: 'user', content: [], source })

describe('released product session fields', () => {
  it('preserves composer display metadata on durable and inbox messages', () => {
    const message = user({ kind: 'user', displayText: '[gongchuang-annotations:v1][]\n', rpcId: 'request-1' })
    expect(migrate('user/message', message).events.at(-1)?.data).toEqual(message)
    const event = { type: 'agent/inbox/spliced', seq: 0, time: 1,
      data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] } }
    // The same source parser validates claimed and pending user input.
    expect(() => assertReleasedPayloadSemantics(event, 0)).not.toThrow()
    expect(() => migrate('user/message', user({ kind: 'user', displayText: 12 }))).toThrow(/displayText/)
  })

  it('preserves fractional model cost without accepting fractional token counts', () => {
    const data = { turn: 1, step: 1, chunk: { type: 'usage', usage: {
      inputTokens: 12, outputTokens: 5, estimatedCostUsd: 0.0000123,
    } } }
    expect(migrate('assistant/chunk', data).events.at(-1)?.data).toEqual(data)
    for (const usage of [
      { inputTokens: 0.1, outputTokens: 1 },
      { inputTokens: 1, outputTokens: 1, estimatedCostUsd: -1 },
    ]) expect(() => migrate('assistant/chunk', { ...data, chunk: { type: 'usage', usage } })).toThrow()
  })

  it('preserves located dispatches and rejects invalid coordinates', () => {
    const data = { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'read',
      arguments: { path: 'example.docx' }, turn: 1, step: 1 }
    expect(migrate('tool/code-dispatch-start', data).events.at(-1)?.data).toEqual(data)
    expect(() => migrate('tool/code-dispatch-start', { ...data, turn: -1 })).toThrow()
  })

  it('preserves typed delivery results only on their owning plugin', () => {
    const source = { kind: 'plugin', plugin: 'gongchuang-policy-gate', form: 'notice', summary: 'Draft',
      delivery: { turn: 1, phase: 'draft', files: [{ originalPath: '/work/a.docx', path: '/work/draft.docx' }],
        issues: ['Missing evidence'], draftText: 'Retained candidate' } }
    expect(migrate('user/message', user(source)).events.at(-1)?.data).toEqual(user(source))
    expect(() => migrate('user/message', user({ ...source, plugin: 'unrelated' }))).toThrow(/delivery/)
    expect(() => migrate('user/message', user({ ...source, delivery: { ...source.delivery, phase: 'unknown' } }))).toThrow()
  })

  it('converts legacy pi-ai replay state without mutating the source', () => {
    const replayState = { kind: 'pi-ai', version: 1, api: 'openai-completions', provider: 'opencode-go',
      model: 'example', responseId: 'response-1', stopReason: 'stop', blocks: [{ type: 'text', text: 'hello' }] }
    const data = { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' }, replayState } }
    const before = structuredClone(data)
    const result = migrate('assistant/chunk', data)
    expect(result.events.at(-1)?.data).toMatchObject({ chunk: { replayState: {
      response: { kind: 'pi-ai', version: 2, responseId: 'response-1' }, blocks: replayState.blocks,
    } } })
    expect(data).toEqual(before)
    expect(() => migrate('assistant/chunk', { ...data,
      chunk: { ...data.chunk, replayState: { ...replayState, unknown: true } },
    })).toThrow(/unknown/)
  })
})
