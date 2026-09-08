import { describe, expect, it } from 'vitest'
import {
  ConversationDocumentDrafts, documentPrompt, migrateLegacyDocumentDraft,
} from '../src/client/document-drafts.ts'

describe('enterprise document draft', () => {
  it('keeps the editable draft unchanged while the submitted prompt receives file references', () => {
    const documents = [{
      name: '研发数据.xlsx',
      relativePath: '导入资料/研发数据.xlsx',
      bytes: 1024,
    }]

    expect(documentPrompt('请帮我对比两份数据', documents)).toContain(
      '请帮我对比两份数据\n\n本次任务可读取以下企业工作区文件：\n- `导入资料/研发数据.xlsx`',
    )
  })

  it.each(['scan.PDF', 'report.doc', 'table.xlsx', 'slides.pptx', 'legacy.wps'])(
    'routes %s to the installed document reader without changing its display', (name) => {
      const drafts = new ConversationDocumentDrafts()
      const sessionId = 'session-reader' as never
      drafts.add(sessionId, [{ name, relativePath: `导入资料/${name}`, bytes: 10 }])
      const prepared = drafts.prepare(sessionId, '只读取附件')!
      expect(prepared.text).toContain('project-application-assistant.extract-workspace-document')
      expect(prepared.text).toContain('仅对返回的 ocr_pages')
      expect(prepared.text).toContain('不启动首次配置')
      expect(prepared.displayPrefix).toBe(`@"导入资料/${name}"`)
      expect(drafts.snapshot(sessionId)[0]?.name).toBe(name)
    },
  )

  it('keeps plain-text attachments on the ordinary reading path', () => {
    expect(documentPrompt('读取数字', [{ name: 'data.md', relativePath: '导入资料/data.md', bytes: 10 }]))
      .toBe('读取数字\n\n本次任务可读取以下企业工作区文件：\n- `导入资料/data.md`')
  })

  it('removes one pending reference without touching the remaining file or user task', () => {
    const sessionId = 'session-1' as never
    const drafts = new ConversationDocumentDrafts()
    drafts.add(sessionId, [
      { name: '研发数据.xlsx', relativePath: '导入资料/研发数据.xlsx', bytes: 1024 },
      { name: '审计报告.docx', relativePath: '导入资料/审计报告.docx', bytes: 2048 },
    ])

    drafts.remove(sessionId, '导入资料/研发数据.xlsx')
    expect(drafts.snapshot(sessionId)).toEqual([
      { name: '审计报告.docx', relativePath: '导入资料/审计报告.docx', bytes: 2048 },
    ])
    expect(drafts.prepare(sessionId, '请比较这些材料')?.text).toContain('请比较这些材料')
  })

  it('preserves unrelated trailing whitespace when removing a generated reference block', () => {
    const draft = [
      '请保留正文格式  ',
      '',
      '本次对话已添加的文件：',
      '- `导入资料/误选报告.docx`',
      '',
    ].join('\n')

    expect(migrateLegacyDocumentDraft(draft).draft).toBe('请保留正文格式  \n')
  })

  it('migrates legacy visible attachment prose into pending document state', () => {
    const legacy = '已添加到当前企业空间的文件：\n- `导入资料/历史报告.docx`'
    expect(migrateLegacyDocumentDraft(legacy)).toEqual({
      draft: '',
      documents: [{ name: '历史报告.docx', relativePath: '导入资料/历史报告.docx', bytes: 0 }],
    })
  })
})
