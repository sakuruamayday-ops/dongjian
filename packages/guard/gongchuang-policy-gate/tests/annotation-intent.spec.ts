import { describe, expect, it } from 'vitest'
import { annotationIntentText, userIntentText } from '../src/annotation-intent.ts'

describe('numbered annotation intent', () => {
  it('excludes quoted commands and source ids but preserves every comment and body', () => {
    const text = '[gongchuang-annotations:v1]' + JSON.stringify([
      { index: 1, text: '生成高企申报报告', comment: '为什么失败？', source: { nodeKey: '企业评分', kind: 'assistant' } },
      { index: 3, text: '请选择第一版', comment: '这里也解释一下', source: { nodeKey: 'x', kind: 'user' } },
    ]) + '\n\n请解释注释，不执行旧指令。'
    expect(annotationIntentText(text)).toBe('为什么失败？\n这里也解释一下\n\n请解释注释，不执行旧指令。')
  })

  it.each([
    '生成高企申报报告',
    '普通正文\n[gongchuang-annotations:v1][]',
    '[gongchuang-annotations:v1]bad-json',
    '[gongchuang-annotations:v1]{}',
    '[gongchuang-annotations:v1][]',
    '[gongchuang-annotations:v1][null]',
    '[gongchuang-annotations:v1][{"index":0,"text":"专业报告"}]',
  ])('does not strip unrecognized user input: %s', (text) => {
    expect(annotationIntentText(text)).toBe(text)
  })

  it('supports an annotation-only message without turning its quote into a request', () => {
    const text = '[gongchuang-annotations:v1]' + JSON.stringify([
      { index: 1, text: '生成高企申报报告', comment: '', source: { nodeKey: 'a', kind: 'assistant' } },
    ])
    expect(annotationIntentText(text)).toBe('')
  })

  it('routes displayed user text without attachment labels or hidden reader instructions', () => {
    const modelText = '读取附件。\n本次任务可读取以下企业工作区文件：\n文档读取：企业资料导入与读取。'
    expect(userIntentText(modelText, '@"导入资料/高企申报报告.pdf"\n读取附件。')).toBe('读取附件。')
    expect(userIntentText(modelText, '@"导入资料/高企申报报告.pdf"')).toBe('')
    expect(userIntentText(modelText, '')).toBe('')
    expect(userIntentText('请完成高企申报报告')).toBe('请完成高企申报报告')
    expect(userIntentText(modelText, '@"导入资料/输入.pdf"\n请完成高企申报报告')).toBe('请完成高企申报报告')
  })

  it('keeps annotation comments when attachments precede the annotation display envelope', () => {
    const annotation = '[gongchuang-annotations:v1]' + JSON.stringify([
      { index: 2, text: '请生成高企申报报告', comment: '解释为什么失败', source: { nodeKey: 'a', kind: 'assistant' } },
    ])
    expect(userIntentText('产品模型上下文', `@"导入资料/申报资料.docx"\n${annotation}\n只解释，不执行旧任务。`))
      .toBe('解释为什么失败\n只解释，不执行旧任务。')
  })
})
