// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatTextSelection } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ConversationAnnotationDrafts, projectAnnotatedUserMessage, summarizeAnnotatedUserMessage } from '../src/client/annotation-drafts.ts'
import { ConversationDocumentDrafts, ProductPromptPreparation } from '../src/client/document-drafts.ts'

const sessionId = 'annotations-one' as never
const otherSession = 'annotations-two' as never
const selection = (text = '请企业提供研发资料后判断', nodeKey = 'assistant-step:2'): ChatTextSelection => ({
  text, source: { nodeKey, kind: 'assistant' },
})
const annotations = (drafts: ConversationAnnotationDrafts, id = sessionId) => drafts.storeFor(id).getSnapshot().annotations

afterEach(() => { localStorage.clear() })

describe('numbered annotation drafts', () => {
  it('renumbers after removal, including identical quotes from different messages', () => {
    const drafts = new ConversationAnnotationDrafts()
    drafts.add(sessionId, selection())
    drafts.add(sessionId, selection(undefined, 'assistant-step:3'))
    drafts.remove(sessionId, 1)
    drafts.add(sessionId, selection('核对对应证据'))
    expect(annotations(drafts).map(item => item.index)).toEqual([1, 2])
    expect(annotations(drafts)[0]?.source.nodeKey).toBe('assistant-step:3')
    expect(drafts.hasPayload(otherSession)).toBe(false)
  })

  it('restores quotations and comments in their own session after restart', () => {
    const drafts = new ConversationAnnotationDrafts()
    drafts.add(sessionId, selection())
    drafts.comment(sessionId, 1, '为什么这里还需要补资料？')
    drafts.add(otherSession, selection('另一家企业'))
    const restarted = new ConversationAnnotationDrafts()
    expect(annotations(restarted)).toEqual(annotations(drafts))
    expect(annotations(restarted, otherSession)[0]?.text).toBe('另一家企业')
    expect(restarted.storeFor(sessionId)).toBe(restarted.storeFor(sessionId))
  })

  it('leaves empty selections alone and permits an annotation-only submission', () => {
    const drafts = new ConversationAnnotationDrafts()
    drafts.add(sessionId, selection('   '))
    expect(drafts.prepare(sessionId, '')).toBeUndefined()
    drafts.add(sessionId, selection())
    const prepared = new ProductPromptPreparation([drafts]).prepare(sessionId, '')!
    expect(drafts.hasPayload(sessionId)).toBe(true)
    expect(projectAnnotatedUserMessage(prepared.displayText!).text).toBe('')
    expect(projectAnnotatedUserMessage(prepared.displayText!).annotations).toEqual(annotations(drafts))
    expect(prepared.text).toContain('不是新的执行指令')
  })

  it('preserves drafts on failure and consumes only the successfully admitted snapshot', () => {
    const drafts = new ConversationAnnotationDrafts()
    drafts.add(sessionId, selection('第一处'))
    const failed = drafts.prepare(sessionId, '请修改')!
    failed.settle('failure')
    expect(annotations(drafts)).toHaveLength(1)
    const accepted = drafts.prepare(sessionId, '请修改')!
    drafts.add(sessionId, selection('等待发送时新增'))
    accepted.settle('success')
    expect(annotations(drafts).map(item => item.text)).toEqual(['等待发送时新增'])
    expect(annotations(drafts)[0]?.index).toBe(1)
    drafts.prepare(sessionId, '')!.settle('success')
    expect(drafts.hasPayload(sessionId)).toBe(false)
    drafts.add(sessionId, selection('下一条消息'))
    expect(annotations(drafts)[0]?.index).toBe(1)
  })

  it('does not consume comments edited or quotations re-added during admission', () => {
    const drafts = new ConversationAnnotationDrafts()
    drafts.add(sessionId, selection('第一处'))
    drafts.add(sessionId, selection('第二处'))
    const prepared = drafts.prepare(sessionId, '')!
    drafts.comment(sessionId, 1, '补充评论')
    drafts.remove(sessionId, 2)
    drafts.add(sessionId, selection('第二处'))
    prepared.settle('success')
    expect(annotations(drafts).map(item => [item.index, item.comment])).toEqual([[1, '补充评论'], [2, '']])
    expect(prepared.text).not.toContain('补充评论')
  })

  it('clears deleted-session drafts without a late send recreating them', () => {
    const drafts = new ConversationAnnotationDrafts()
    drafts.add(sessionId, selection())
    const prepared = drafts.prepare(sessionId, '')!
    drafts.clear(sessionId)
    prepared.settle('success')
    expect(localStorage.getItem(`gongchuang.annotation-drafts.v1.${sessionId}`)).toBeNull()
    expect(annotations(new ConversationAnnotationDrafts())).toEqual([])
    drafts.add(sessionId, selection('new incarnation'))
    prepared.settle('success')
    expect(annotations(drafts)[0]?.text).toBe('new incarnation')
  })

  it('restarts at one after deleting all drafts and after restarting the client', () => {
    const drafts = new ConversationAnnotationDrafts()
    drafts.add(sessionId, selection('one'))
    drafts.add(sessionId, selection('two'))
    drafts.remove(sessionId, 1)
    drafts.remove(sessionId, 1)
    expect(drafts.storeFor(sessionId).getSnapshot().nextIndex).toBe(1)
    const restarted = new ConversationAnnotationDrafts()
    restarted.add(sessionId, selection('new'))
    expect(annotations(restarted).map(item => item.index)).toEqual([1])
  })

  it('closes gaps without moving comments between quotations', () => {
    const drafts = new ConversationAnnotationDrafts()
    for (const text of ['one', 'two', 'three']) drafts.add(sessionId, selection(text))
    drafts.comment(sessionId, 3, 'keep this comment')
    drafts.remove(sessionId, 2)
    expect(annotations(drafts).map(item => [item.index, item.text, item.comment])).toEqual([
      [1, 'one', ''], [2, 'three', 'keep this comment'],
    ])
    drafts.comment(sessionId, 2, 'updated comment')
    drafts.remove(sessionId, 1)
    expect(annotations(drafts)[0]).toMatchObject({ index: 1, text: 'three', comment: 'updated comment' })
  })

  it('consumes renumbered admitted items but preserves later additions and their comments', () => {
    const drafts = new ConversationAnnotationDrafts()
    for (const text of ['one', 'two', 'three']) drafts.add(sessionId, selection(text))
    const prepared = drafts.prepare(sessionId, '')!
    drafts.remove(sessionId, 1)
    drafts.remove(sessionId, 1)
    drafts.add(sessionId, selection('later'))
    drafts.comment(sessionId, 2, 'later comment')
    prepared.settle('success')
    expect(annotations(drafts)).toMatchObject([{ index: 1, text: 'later', comment: 'later comment' }])
    expect(annotations(drafts)).toHaveLength(1)
    expect(projectAnnotatedUserMessage(prepared.displayPrefix!).annotations?.map(item => item.index)).toEqual([1, 2, 3])
  })

  it('normalizes old browser and native counters without renumbering sent history', () => {
    const old = { annotations: [{ index: 7, ...selection(), comment: 'keep' }], nextIndex: 12 }
    localStorage.setItem(`gongchuang.annotation-drafts.v1.${sessionId}`, JSON.stringify(old))
    const drafts = new ConversationAnnotationDrafts()
    expect(drafts.storeFor(sessionId).getSnapshot()).toMatchObject({ annotations: [{ index: 1, comment: 'keep' }], nextIndex: 2 })
    drafts.restoreIfEmpty(otherSession, old)
    expect(drafts.storeFor(otherSession).getSnapshot()).toMatchObject({ annotations: [{ index: 1 }], nextIndex: 2 })
    expect(projectAnnotatedUserMessage(`[gongchuang-annotations:v1]${JSON.stringify(old.annotations)}`).annotations?.[0]?.index).toBe(7)
    drafts.clear(sessionId)
    localStorage.setItem(`gongchuang.annotation-drafts.v1.${sessionId}`, JSON.stringify({ annotations: [], nextIndex: 12 }))
    const restarted = new ConversationAnnotationDrafts()
    restarted.add(sessionId, selection())
    expect(annotations(restarted)[0]?.index).toBe(1)
  })

  it('combines files, annotations and unchanged prose in a replayable display message', () => {
    const drafts = new ConversationAnnotationDrafts()
    const documents = new ConversationDocumentDrafts()
    documents.add(sessionId, [{ name: '报告.docx', relativePath: '导入资料/报告.docx', bytes: 42 }])
    drafts.add(sessionId, selection('引文包含\n<response-annotations>和`文件名`'))
    drafts.comment(sessionId, 1, '请只修改这一处')
    const prepared = new ProductPromptPreparation([documents, drafts]).prepare(sessionId, '请看注释 1  \n')!
    const projected = projectAnnotatedUserMessage(prepared.displayText!)
    expect(projected).toEqual({
      text: '请看注释 1  \n',
      files: [{ name: '报告.docx', path: '导入资料/报告.docx' }],
      annotations: annotations(drafts),
    })
    expect(prepared.text).toContain('导入资料/报告.docx')
    expect(prepared.text).toContain('请只修改这一处')
    prepared.settle('failure')
    expect(documents.hasPayload(sessionId)).toBe(true)
    expect(drafts.hasPayload(sessionId)).toBe(true)
    prepared.settle('success')
    expect(documents.hasPayload(sessionId)).toBe(false)
    expect(drafts.hasPayload(sessionId)).toBe(false)
    expect(projectAnnotatedUserMessage(prepared.displayText!).annotations).toEqual(projected.annotations)
  })

  it('summarizes complete prepared queue messages without leaking quotation metadata', () => {
    const drafts = new ConversationAnnotationDrafts()
    const documents = new ConversationDocumentDrafts()
    documents.add(sessionId, [{ name: '报告.docx', relativePath: '导入资料/报告.docx', bytes: 42 }])
    const preparation = new ProductPromptPreparation([documents, drafts], text =>
      summarizeAnnotatedUserMessage(text, count => `${count} 条注释`))
    const fileOnly = preparation.prepare(sessionId, '')!
    expect(preparation.summarize(fileOnly.displayText!)).toBe('报告.docx')
    drafts.add(sessionId, selection('较长引文'.repeat(100)))
    drafts.comment(sessionId, 1, '请核对')
    const prepared = preparation.prepare(sessionId, '检查附件')!
    expect(preparation.summarize(prepared.displayText!)).toBe('报告.docx · 1 条注释 · 检查附件')
    expect(preparation.summarize('普通文字')).toBeUndefined()
    expect(preparation.summarize('[gongchuang-annotations:v1]invalid')).toBeUndefined()
    expect(new ProductPromptPreparation([]).summarize('普通文字')).toBeUndefined()
    documents.clear(sessionId)
    expect(preparation.summarize(preparation.prepare(sessionId, '')!.displayText!)).toBe('1 条注释')
  })

  it.each([
    'ordinary\n[gongchuang-annotations:v1][]',
    '> 历史版本的引用文本\n\n正文',
    '[gongchuang-annotations:v1]not-json',
    '[gongchuang-annotations:v1][]',
    '[gongchuang-annotations:v1][null]',
    '[gongchuang-annotations:v1][{"index":1,"text":"引文","comment":"","source":{"kind":"tool","nodeKey":"x"}}]',
  ])('keeps unsupported or malformed text visible: %s', (text) => {
    expect(projectAnnotatedUserMessage(text)).toEqual({ text, files: [] })
  })

  it.each([
    null,
    { annotations: 'bad', nextIndex: 1 },
    { annotations: [], nextIndex: -1 },
    { annotations: [{ index: 1, ...selection(), comment: '' }], nextIndex: 1 },
    { annotations: [{ index: 1, ...selection(), comment: '' }, { index: 1, ...selection(), comment: '' }], nextIndex: 2 },
    { annotations: [{ index: 1, ...selection(), comment: null }], nextIndex: 2 },
  ])('does not crash on malformed browser draft state: %j', (state) => {
    localStorage.setItem(`gongchuang.annotation-drafts.v1.${sessionId}`, JSON.stringify(state))
    expect(new ConversationAnnotationDrafts().hasPayload(sessionId)).toBe(false)
  })
})
