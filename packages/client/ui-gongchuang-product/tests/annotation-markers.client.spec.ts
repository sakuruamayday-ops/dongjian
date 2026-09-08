// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutableSessionEventSource, type SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { AnnotationMarkers } from '../src/client/annotation-markers.ts'
import { ConversationAnnotationDrafts } from '../src/client/annotation-drafts.ts'
import { ProductPromptPreparation } from '../src/client/document-drafts.ts'

const sessionId = 'annotation-source-test' as never
const nodeKey = 'assistant-step:2'
const selection = { text: '原消息中的结论', source: { nodeKey, kind: 'assistant' as const } }
const message = (seq: number, displayText: string, kind = 'user'): SessionLiveEventEntry => ({
  type: 'event', event: { seq, time: seq * 1_000, type: 'user/message', data: {
    id: `message-${seq}`, content: [{ type: 'text', text: '处理注释' }], source: { kind, displayText },
  } },
} as SessionLiveEventEntry)

afterEach(() => { localStorage.clear() })

describe('source-message annotation markers', () => {
  it('distinguishes repeated numbers in different submissions without renumbering their text', () => {
    const events = new MutableSessionEventSource()
    const drafts = new ConversationAnnotationDrafts()
    const markers = new AnnotationMarkers(events, drafts.storeFor(sessionId))
    for (const seq of [4, 5]) {
      drafts.add(sessionId, selection)
      const prepared = new ProductPromptPreparation([drafts]).prepare(sessionId, 'reply')!
      events.append(message(seq, prepared.displayText!))
      prepared.settle('success')
    }
    expect(markers.source(nodeKey).getSnapshot()).toMatchObject([
      { id: 'message:4:1', index: 1, round: 1 }, { id: 'message:5:1', index: 1, round: 2 },
    ])
    markers.dispose()
  })
  it('updates the correct source when a draft is added, edited or removed', () => {
    const events = new MutableSessionEventSource()
    const drafts = new ConversationAnnotationDrafts()
    const markers = new AnnotationMarkers(events, drafts.storeFor(sessionId))
    const source = markers.source(nodeKey)
    expect(markers.source(nodeKey)).toBe(source)
    drafts.add(sessionId, selection)
    expect(source.getSnapshot()).toMatchObject([{ index: 1, text: selection.text }])
    expect(markers.source('another-message').getSnapshot()).toEqual([])
    drafts.comment(sessionId, 1, '说明依据')
    expect(source.getSnapshot()[0]?.comment).toBe('说明依据')
    drafts.remove(sessionId, 1)
    expect(source.getSnapshot()).toEqual([])
    markers.dispose()
  })

  it('renumbers pending markers across source rows while preserving sent markers', () => {
    const events = new MutableSessionEventSource()
    const drafts = new ConversationAnnotationDrafts()
    drafts.add(sessionId, selection)
    const prepared = new ProductPromptPreparation([drafts]).prepare(sessionId, '')!
    events.append(message(4, prepared.displayText!))
    prepared.settle('success')
    const markers = new AnnotationMarkers(events, drafts.storeFor(sessionId))
    drafts.add(sessionId, selection)
    drafts.add(sessionId, { text: '另一条结论', source: { nodeKey: 'another-message', kind: 'assistant' } })
    drafts.comment(sessionId, 2, '保留的评论')
    expect(markers.source('another-message').getSnapshot()).toMatchObject([{ id: 'draft:2', index: 2 }])
    drafts.remove(sessionId, 1)
    expect(markers.source(nodeKey).getSnapshot()).toMatchObject([{ id: 'message:4:1', index: 1 }])
    expect(markers.source(nodeKey).getSnapshot()).toHaveLength(1)
    expect(markers.source('another-message').getSnapshot()).toMatchObject([
      { id: 'draft:1', index: 1, text: '另一条结论', comment: '保留的评论' },
    ])
    drafts.remove(sessionId, 1)
    expect(markers.source('another-message').getSnapshot()).toEqual([])
    drafts.add(sessionId, selection)
    expect(markers.source(nodeKey).getSnapshot()).toMatchObject([
      { id: 'message:4:1', index: 1 }, { id: 'draft:1', index: 1 },
    ])
    markers.dispose()
  })

  it('reconstructs sent markers after draft settlement and a fresh client instance', () => {
    const events = new MutableSessionEventSource()
    const drafts = new ConversationAnnotationDrafts()
    drafts.add(sessionId, selection)
    drafts.comment(sessionId, 1, '请更正')
    const prepared = new ProductPromptPreparation([drafts]).prepare(sessionId, '修改这里')!
    const markers = new AnnotationMarkers(events, drafts.storeFor(sessionId))
    const source = markers.source(nodeKey)
    events.append(message(4, prepared.displayText!))
    prepared.settle('success')
    expect(source.getSnapshot()).toMatchObject([{ id: 'message:4:1', index: 1, comment: '请更正' }])
    expect(source.getSnapshot()).toHaveLength(1)
    markers.dispose()
    const restarted = new AnnotationMarkers(events, new ConversationAnnotationDrafts().storeFor(sessionId))
    expect(restarted.source(nodeKey).getSnapshot()).toEqual(source.getSnapshot())
    restarted.dispose()
  })

  it('handles older-page prepend and replacement without rescanning unrelated live output', () => {
    const events = new MutableSessionEventSource()
    const drafts = new ConversationAnnotationDrafts()
    drafts.add(sessionId, selection)
    const prepared = new ProductPromptPreparation([drafts]).prepare(sessionId, '')!
    prepared.settle('success')
    const markers = new AnnotationMarkers(events, drafts.storeFor(sessionId))
    const source = markers.source(nodeKey)
    const listener = vi.fn()
    source.subscribe(listener)
    events.append(message(9, '普通消息'))
    expect(listener).not.toHaveBeenCalled()
    events.prepend([message(4, prepared.displayText!)], false)
    expect(source.getSnapshot()[0]?.id).toBe('message:4:1')
    events.replace([message(9, '普通消息')], false)
    expect(source.getSnapshot()).toEqual([])
    markers.dispose()
    events.append(message(10, prepared.displayText!))
    expect(source.getSnapshot()).toEqual([])
  })

  it('does not promote a plugin notice into a user annotation', () => {
    const events = new MutableSessionEventSource()
    const drafts = new ConversationAnnotationDrafts()
    drafts.add(sessionId, selection)
    const prepared = new ProductPromptPreparation([drafts]).prepare(sessionId, '')!
    prepared.settle('success')
    events.replace([message(4, prepared.displayText!, 'plugin')], false)
    const markers = new AnnotationMarkers(events, drafts.storeFor(sessionId))
    expect(markers.source(nodeKey).getSnapshot()).toEqual([])
    markers.dispose()
  })
})
