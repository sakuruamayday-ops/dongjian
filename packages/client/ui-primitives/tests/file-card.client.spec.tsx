// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileCard, type FileCardActions, type FileCardLabels } from '../src/FileCard.tsx'

const labels: FileCardLabels = {
  open: '打开 测试报告.docx', openWith: '打开方式', defaultApplication: '默认应用',
  chooseOther: '选择其他应用', reveal: '在文件夹中显示', saveCopy: '保存副本',
  loading: '正在读取应用', failed: '文件操作失败，请重试', file: '文件',
}
const actions = (): FileCardActions => ({
  listApplications: vi.fn(async () => [{ id: '/Applications/WPS.app', name: 'WPS Office', isDefault: true }]),
  openWith: vi.fn(async () => {}), reveal: vi.fn(async () => {}), saveCopy: vi.fn(async () => {}),
})

afterEach(cleanup)

describe('full file cards', () => {
  it('keeps the full file name, type, quality status and default system opener', async () => {
    const onOpen = vi.fn(async () => {})
    const name = '测试报告_宁波市首台套装备申报书_技术主线修订版.docx'
    render(<FileCard name={name} path={`reports/${name}`} labels={labels} onOpen={onOpen} phase="draft" status="待完善" />)
    expect(screen.getByText(name)).toBeTruthy()
    expect(screen.getByText(/DOCX/)).toBeTruthy()
    expect(screen.getByText('待完善').getAttribute('data-phase')).toBe('draft')
    fireEvent.click(screen.getByRole('button', { name: labels.open }))
    await waitFor(() => { expect(onOpen).toHaveBeenCalledOnce() })
    expect(screen.queryByRole('button', { name: labels.openWith })).toBeNull()
  })

  it('uses the host application list and distinct open, reveal and copy operations', async () => {
    const native = actions()
    const onOpen = vi.fn()
    render(<FileCard name="测试报告.docx" path="测试报告.docx" labels={labels} onOpen={onOpen} actions={native} />)
    const choose = async (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: labels.openWith }))
      fireEvent.click(await screen.findByRole('menuitem', { name }))
      await waitFor(() => { expect(screen.getByRole('button', { name: labels.openWith }).hasAttribute('disabled')).toBe(false) })
    }
    await choose('WPS Office (默认应用)')
    expect(native.openWith).toHaveBeenCalledWith('/Applications/WPS.app')
    await choose(labels.chooseOther)
    expect(native.openWith).toHaveBeenLastCalledWith(null)
    await choose(labels.reveal)
    expect(native.reveal).toHaveBeenCalledOnce()
    await choose(labels.saveCopy)
    expect(native.saveCopy).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('keeps native open usable after an application-list error and shows an operation failure', async () => {
    const native = actions()
    native.listApplications = vi.fn(async () => { throw new Error('unavailable') })
    const onOpen = vi.fn(async () => { throw new Error('file removed') })
    render(<FileCard name="测试报告.docx" path="测试报告.docx" labels={labels} onOpen={onOpen} actions={native} />)
    fireEvent.click(screen.getByRole('button', { name: labels.openWith }))
    fireEvent.click(await screen.findByRole('menuitem', { name: labels.defaultApplication }))
    await waitFor(() => { expect(onOpen).toHaveBeenCalledOnce() })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', labels.failed)
    expect(screen.getByText('测试报告.docx')).toBeTruthy()
  })
})
