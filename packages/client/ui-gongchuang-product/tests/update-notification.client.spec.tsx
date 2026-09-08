// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { UpdateNotification } from '../src/client/UpdateNotification.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

describe('noninterrupting update notification', () => {
  const props = () => ({
    snapshot: { status: 'available' as const, currentVersion: '0.4.3', latestVersion: '0.4.4', message: '发现更新', releaseNotes: '修复文件卡片、注释与自动任务。' },
    progress: null, busy: null, download: vi.fn(), install: vi.fn(), t: makeTranslate(zh),
  })

  it('announces the available update without downloading or installing, and opens actual release notes', () => {
    const p = props()
    render(<UpdateNotification {...p} />)
    expect(p.download).not.toHaveBeenCalled()
    expect(p.install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '更新日志' }))
    expect(screen.getByRole('dialog').textContent).toContain(p.snapshot.releaseNotes)
    fireEvent.click(screen.getByRole('button', { name: '下载更新' }))
    expect(p.download).toHaveBeenCalledOnce()
    expect(p.install).not.toHaveBeenCalled()
  })

  it('shows a fresh ready notice after discovery was dismissed and installs only on its restart button', () => {
    const p = props()
    const view = render(<UpdateNotification {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭更新提醒' }))
    expect(view.container.ownerDocument.querySelector('[data-update-notification]')).toBeNull()
    view.rerender(<UpdateNotification {...p} snapshot={{ ...p.snapshot, status: 'downloaded' }} />)
    expect(screen.getByRole('button', { name: '重启升级' })).toBeTruthy()
    expect(p.install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重启升级' }))
    expect(p.install).toHaveBeenCalledOnce()
  })

  it('does not claim ready during verification or after a failed check', () => {
    const p = props()
    const view = render(<UpdateNotification {...p} busy="download" progress={{
      phase: 'verifying', percent: 100, totalBytes: 200, receivedBytes: 200, remainingSeconds: 0,
      resumedFromBytes: 100, latestVersion: '0.4.4',
    }} />)
    expect(screen.queryByRole('button', { name: '重启升级' })).toBeNull()
    expect(screen.getByRole('button', { name: '下载更新' }).hasAttribute('disabled')).toBe(true)
    view.rerender(<UpdateNotification {...p} snapshot={{ ...p.snapshot, status: 'error' }} />)
    expect(view.container.ownerDocument.querySelector('[data-update-notification]')).toBeNull()
  })

  it('keeps the notice in layout and exposes an update action when the sidebar is collapsed', () => {
    const p = props()
    const view = render(<UpdateNotification {...p} compact />)
    const notice = view.container.querySelector<HTMLButtonElement>('[data-update-notification]')!
    expect(notice).not.toBeNull()
    expect(screen.queryByRole('button', { name: '下载更新' })).toBeNull()
    fireEvent.click(notice)
    fireEvent.click(screen.getByRole('button', { name: '下载更新' }))
    expect(p.download).toHaveBeenCalledOnce()
  })
})
