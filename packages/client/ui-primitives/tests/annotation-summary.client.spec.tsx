// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnnotationSummary } from '../src/AnnotationSummary.tsx'

afterEach(cleanup)

const annotations = [
  { index: 1, text: '第一处历史引文', comment: '请核对证据' },
  { index: 3, text: '第二处历史引文\n保持换行', comment: '' },
]
const labels = { countLabel: '2 条注释', itemLabel: (index: number) => `注释 ${index}`, closeLabel: '关闭注释' }

describe('numbered annotation summary', () => {
  it('shows a compact count until opened and restores focus on Escape', () => {
    render(<AnnotationSummary annotations={annotations} {...labels} />)
    const trigger = screen.getByRole('button', { name: '2 条注释' })
    expect(screen.queryByText('第一处历史引文')).toBeNull()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '2 条注释' })
    expect(document.activeElement).toBe(dialog)
    expect(screen.getByText('注释 3')).toBeTruthy()
    expect(screen.getByText('请核对证据')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('edits comments and removes one stable number without mutating quotes', () => {
    const onComment = vi.fn()
    const onRemove = vi.fn()
    const view = render(<AnnotationSummary annotations={annotations} {...labels} editing={{
      disabled: false, commentLabel: index => `评论 ${index}`, removeLabel: index => `移除注释 ${index}`, onComment, onRemove,
    }} />)
    fireEvent.click(screen.getByRole('button', { name: '2 条注释' }))
    fireEvent.change(screen.getByRole('textbox', { name: '评论 3' }), { target: { value: '这是为什么？' } })
    expect(onComment).toHaveBeenCalledExactlyOnceWith(3, '这是为什么？')
    fireEvent.click(screen.getByRole('button', { name: '移除注释 1' }))
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(1)
    expect(screen.getByText('第一处历史引文')).toBeTruthy()
    view.rerender(<AnnotationSummary annotations={[]} {...labels} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    view.rerender(<AnnotationSummary annotations={annotations} {...labels} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('dismisses on outside pointer, keyboard focus leaving, and the close button', () => {
    render(<><button type="button">outside</button><AnnotationSummary annotations={annotations} {...labels} /></>)
    const trigger = screen.getByRole('button', { name: '2 条注释' })
    fireEvent.click(trigger)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.blur(screen.getByRole('dialog'), { relatedTarget: screen.getByRole('button', { name: 'outside' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: '关闭注释' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('disables mutation while submitting and does not forward comment Enter to the composer', () => {
    const onComment = vi.fn()
    const onRemove = vi.fn()
    const onKeyDown = vi.fn()
    render(<div onKeyDown={onKeyDown}><AnnotationSummary annotations={annotations} {...labels} editing={{
      disabled: true, commentLabel: index => `评论 ${index}`, removeLabel: index => `移除注释 ${index}`, onComment, onRemove,
    }} /></div>)
    fireEvent.click(screen.getByRole('button', { name: '2 条注释' }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '评论 1' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '移除注释 1' }))
    expect(onRemove).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(onKeyDown).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' })
    expect(onKeyDown).toHaveBeenCalledOnce()
  })
})
