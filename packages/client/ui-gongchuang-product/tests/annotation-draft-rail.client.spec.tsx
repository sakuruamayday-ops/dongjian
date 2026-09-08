// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { AnnotationDraftRail } from '../src/client/AnnotationDraftRail.tsx'
import { ConversationAnnotationDrafts } from '../src/client/annotation-drafts.ts'
import { zh, type ProductKey } from '../src/client/locales.ts'

afterEach(() => { cleanup(); localStorage.clear() })

describe('composer annotation rail', () => {
  it('refreshes external payload, binds session edits, and disappears after the last removal', () => {
    const drafts = new ConversationAnnotationDrafts()
    const sessionId = 'annotation-rail' as never
    drafts.add(sessionId, { text: '缺少第七章', source: { nodeKey: 'a:2', kind: 'assistant' } })
    const refresh = vi.fn()
    const props = {
      input: { phase: 'plain', draft: '原来的正文' },
      inputActions: { refreshExternalPayload: refresh },
      useAnnotationDrafts: (selector: (state: ReturnType<ReturnType<typeof drafts.storeFor>['getSnapshot']>) => unknown) => selector(drafts.storeFor(sessionId).getSnapshot()),
      removeAnnotation: (index: number) => { drafts.remove(sessionId, index) },
      commentAnnotation: (index: number, comment: string) => { drafts.comment(sessionId, index, comment) },
      t: (key: ProductKey, params: Record<string, string | number> = {}) =>
        Object.entries(params).reduce<string>((text, [name, value]) => text.replace(`{${name}}`, String(value)), zh[key]),
    } as unknown as ComponentProps<typeof AnnotationDraftRail>
    const view = render(<AnnotationDraftRail {...props} />)
    expect(refresh).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '1 条注释' }))
    fireEvent.change(screen.getByRole('textbox', { name: '注释 1 的评论' }), { target: { value: '这是为什么？' } })
    view.rerender(<AnnotationDraftRail {...props} />)
    expect(drafts.storeFor(sessionId).getSnapshot().annotations[0]?.comment).toBe('这是为什么？')
    expect(props.input.draft).toBe('原来的正文')
    fireEvent.click(screen.getByRole('button', { name: '移除注释 1' }))
    view.rerender(<AnnotationDraftRail {...props} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(drafts.hasPayload(sessionId)).toBe(false)
  })
})
