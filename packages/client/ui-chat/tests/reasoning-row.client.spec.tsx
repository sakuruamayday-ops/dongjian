// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'

afterEach(() => {
  cleanup()
  document.documentElement.lang = ''
})

const t = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

describe('ReasoningRow', () => {
  it('keeps English-dominant reasoning out of the Chinese UI without changing the answer', () => {
    document.documentElement.lang = 'zh-CN'
    const view = render(<AssistantMarkdown t={t} blocks={[
      { kind: 'reasoning', text: 'Inspect the document and calculate the result' },
      { kind: 'text', text: '核对结果为 31。' },
    ]} streaming={false} renderMessageImages={renderMessageImages} />)
    expect(view.getByText('思考已完成')).toBeTruthy()
    expect(view.container.textContent).not.toContain('Inspect the document')
    expect(view.getByText('核对结果为 31。')).toBeTruthy()
    view.rerender(<AssistantMarkdown t={t} blocks={[
      { kind: 'reasoning', text: 'Inspect the document and calculate the result' },
    ]} streaming renderMessageImages={renderMessageImages} />)
    expect(view.getByText('正在处理…')).toBeTruthy()
  })

  it('retains meaningful mixed Chinese reasoning', () => {
    document.documentElement.lang = 'zh'
    const view = render(<AssistantMarkdown t={t} blocks={[
      { kind: 'reasoning', text: '正在核对 Excel 表格中的数据。' },
    ]} streaming={false} renderMessageImages={renderMessageImages} />)
    fireEvent.click(view.getByText('思考'))
    expect(view.getByText('正在核对 Excel 表格中的数据。')).toBeTruthy()
  })

  it.each([
    'Let me understand the task:\nRead 共创导入资料/验收结果.docx and calculate the spreadsheet totals.',
    'Found:\n下面需要核对两份文档的内容、表格和结果，然后生成用户需要的文件。',
  ])('does not expose English previews containing Chinese filenames or later paragraphs', (text) => {
    document.documentElement.lang = 'zh'
    const view = render(<AssistantMarkdown t={t} blocks={[
      { kind: 'reasoning', text },
      { kind: 'text', text: '已完成核对。' },
    ]} streaming={false} renderMessageImages={renderMessageImages} />)

    expect(view.getByText('思考已完成')).toBeTruthy()
    expect(view.container.textContent).not.toContain(text.split('\n')[0])
    expect(view.getByText('已完成核对。')).toBeTruthy()
  })

  it('hides an English streaming tail after Chinese reasoning', () => {
    document.documentElement.lang = 'zh'
    const view = render(<AssistantMarkdown t={t} blocks={[
      { kind: 'reasoning', text: '先核对用户提供的两份测试文档，然后读取表格确认总额。\nCheck the totals' },
    ]} streaming renderMessageImages={renderMessageImages} />)

    expect(view.getByText('正在处理…')).toBeTruthy()
    expect(view.container.textContent).not.toContain('Check the totals')
  })

  it('follows the latest streaming line, then restores the settled first line', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('运行中')).toBeTruthy()
    expect(view.getByText('Newest reasoning tokens').parentElement?.getAttribute('data-follow-end'))
      .toBe('true')

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens keep arriving' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('Newest reasoning tokens keep arriving').parentElement
      ?.getAttribute('data-follow-end')).toBe('true')

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens keep arriving\n' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    const settledSummary = view.getByText('Inspect the session')
    expect(view.queryByText('运行中')).toBeNull()
    expect(settledSummary.parentElement?.hasAttribute('data-follow-end')).toBe(false)
  })

  it('expands from either Think or the reasoning summary', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    const row = view.getByRole('button')

    fireEvent.click(view.getByText('Inspect the session'))
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Check persistence/)).toBeTruthy()

    fireEvent.click(view.getByText('思考'))
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('expanded Think drops the inline summary and renders plain prose, no IN card', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    fireEvent.click(view.getByText('思考'))
    expect(view.getAllByText(/Inspect the session/)).toHaveLength(1)
    expect(view.queryByText('IN')).toBeNull()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
    expect(view.container.querySelector('[class*="thinkBody"]')).not.toBeNull()
  })
})
