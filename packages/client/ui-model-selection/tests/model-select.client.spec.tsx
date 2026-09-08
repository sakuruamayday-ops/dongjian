// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        description: 'Fast catalog description',
        reasoning,
      }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
  it('renders effort names without descriptions and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      refresh={vi.fn().mockResolvedValue(undefined)}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'Max'])
    expect(screen.queryByText('Largest budget')).toBeNull()

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      refresh={vi.fn().mockResolvedValue(undefined)}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('shows the durable model id when the catalog has no matching display name', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      refresh={vi.fn().mockResolvedValue(undefined)}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型，当前 deepseek-official/removed-model' })
    expect(trigger.textContent).toContain('deepseek-official/removed-model')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    expect(screen.queryByRole('menuitemradio', { name: 'removed-model' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
    expect(screen.queryByText('Fast catalog description')).toBeNull()
  })

  it('shows loading until the catalog and Session projection are both ready', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: null,
      routable: null,
      groups: [],
      status: 'loading',
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      refresh={vi.fn().mockResolvedValue(undefined)}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    expect(screen.getByRole('button', { name: '正在加载模型…' }).textContent)
      .toContain('正在加载模型…')
    directory.set(state())
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
      })).toBeTruthy()
    })
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'session/model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      refresh={vi.fn().mockResolvedValue(undefined)}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：session/model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      refresh={vi.fn().mockResolvedValue(undefined)}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })

  it('searches by provider or model identity and lets provider groups collapse', async () => {
    const directory = createSnapshotStore(state({
      groups: [
        {
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [
            { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning },
            { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
          ],
        },
        {
          id: 'opencode-go',
          name: 'OpenCode Go',
          models: [{ id: 'minimax-m2.5', name: 'MiniMax M2.5' }],
        },
      ],
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      refresh={vi.fn().mockResolvedValue(undefined)}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const search = screen.getByRole('searchbox', { name: '搜索模型' })
    await waitFor(() => { expect(document.activeElement).toBe(search) })

    const collapse = screen.getByRole('menuitem', { name: '收起 DeepSeek' })
    fireEvent.click(collapse)
    expect(screen.queryByRole('menuitemradio', { name: 'DeepSeek V4 Flash' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: '展开 DeepSeek' })).toBeTruthy()

    fireEvent.change(search, { target: { value: 'v4-pro' } })
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek V4 Pro' })).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: 'MiniMax M2.5' })).toBeNull()

    fireEvent.change(search, { target: { value: 'opencode' } })
    expect(screen.getByRole('menuitemradio', { name: 'MiniMax M2.5' })).toBeTruthy()

    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.getByText('没有匹配的模型。')).toBeTruthy()
  })

  it('refreshes only from the explicit command, never on open or model selection', async () => {
    const load = vi.fn()
    const refresh = vi.fn().mockResolvedValue(undefined)
    const select = vi.fn().mockResolvedValue(true)
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
        ],
      }],
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={load}
      refresh={refresh}
      select={select}
      t={t}
    />)

    expect(load).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    expect(screen.getByRole('menuitem', { name: '刷新模型' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '刷新模型' }))
    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1) })

    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    expect(refresh).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Pro' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('menu')).toBeNull()
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '刷新模型' }))
    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(2) })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('removes stale model rows and exposes retry after an explicit refresh failure', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const load = vi.fn()
    const refresh = vi.fn(async () => {
      directory.set(state({
        groups: [],
        failures: [],
        status: 'error',
        error: 'provider refresh rejected',
      }))
      throw new Error('provider refresh rejected')
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={load}
      refresh={refresh}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '刷新模型' }))

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeNull()
      expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
      expect(screen.getAllByText('模型操作失败：provider refresh rejected')).not.toHaveLength(0)
    })

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(2) })
    expect(load).toHaveBeenCalledTimes(1)
  })
})
