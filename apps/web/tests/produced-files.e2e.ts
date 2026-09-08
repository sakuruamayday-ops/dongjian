// Web e2e scenario: the produced-file cards a finished turn ends with.
// Cold-seeds ten writes (zero model calls), then verifies the real assembled
// lane expands its remainder without horizontal overflow and keeps a capability-gated folder handoff.
// The folder request is intercepted so one real browser click can exercise
// the full client carrier without launching a native application in CI.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed, vi } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-tools/types'
import {
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('./produced-files.overlay.yml', import.meta.url))
const SEED_ID = 'produced-files-web-e2e'
const DONE = 'PRODUCED_FILES_DONE'
const PUBLICATION_SEED_ID = 'published-files-legacy-web-e2e'
const PUBLICATION_DONE = 'PUBLISHED_FILES_DONE'

/** Ten varied names exercise estimated prefix selection and CSS shrinking. */
const PRODUCED = [
  '关于我.md',
  'index.html',
  'long-generated-experience-specification-for-produced-files-overflow.md',
  'styles.css',
  'app.ts',
  'schema.json',
  'README.md',
  'preview.svg',
  'notes.txt',
  'manifest.yaml',
] as const

/** Build one settled turn whose successful write calls carry ten locations. */
function producedFixture(): string {
  const session = Session.create(SessionId('produced-files-source'))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Create the site files.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Produced files overflow', messageSeqs: [user.seq], source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  const calls = PRODUCED.map((path, index) => ({
    path,
    callId: ToolCallId(`produced-files-${String(index)}`),
    args: JSON.stringify({ file_path: path, content: `content of ${path}\n` }),
  }))
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: calls.map(call => ({
        type: 'tool-call' as const,
        id: call.callId,
        name: 'write',
        arguments: call.args,
      })),
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  for (const call of calls) {
    const source = session.append('tool/call', {
      turn: 1, step: 1, callId: call.callId, name: 'write', arguments: call.args,
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: call.callId,
        content: [{ type: 'text', text: `Created ${call.path}` }],
        isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
  }
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 2,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `Created the site.\n\n${DONE}` }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  return [
    JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
      createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify({
      ...event, time: eventTimeOrigin + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

/** Alpha.4 recordings retained root ids but omitted their PTC coordinates. */
function publicationFixture(draft = false, olderMessages = 0): string {
  const session = Session.create(SessionId('published-files-source'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Publish the finished documents.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: draft ? 'Draft quality files' : 'Recovered published files', messageSeqs: [user.seq], source: { kind: 'fallback' },
  })
  for (let index = 0; index < olderMessages; index++) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Earlier context ${index}` }],
      source: { kind: 'plugin', plugin: 'fixture', form: 'notice', summary: `Earlier context ${index}` },
    }), { surfaceOp: 'append' })
  }
  session.append('step/start', { turn: 1, step: 1 })
  const rootCallId = ToolCallId('publish-through-code')
  const source = session.append('tool/call', {
    turn: 1, step: 1, callId: rootCallId, name: 'run_code', arguments: '{}',
  })
  for (const [index, name, args] of [
    [0, 'gongchuang_publish_files', { paths: ['published.md'] }],
    [1, 'gongchuang_artifact_probe', { artifactPath: 'inspected.html' }],
  ] as const) {
    const dispatch = {
      rootCallId, parentCallId: rootCallId, subCallId: ToolCallId(`publish-child-${String(index)}`),
      name, arguments: args,
    }
    session.append('tool/code-dispatch-start', dispatch)
    session.append('tool/code-dispatch', { ...dispatch, isError: false, content: [] })
  }
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: rootCallId, content: [], isError: false }),
  }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', {
    stream: [],
    turn: 1, step: 2,
    message: createAssistantMessage({
      content: [{ type: 'text', text: PUBLICATION_DONE }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  if (draft) session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '文件待完善' }],
    source: {
      kind: 'plugin', plugin: 'gongchuang-policy-gate', form: 'notice', summary: '文件待完善',
      delivery: {
        turn: 1, phase: 'draft', issues: ['Missing policy source'],
        files: [{ originalPath: 'published.md', path: 'published-draft.md' }],
      },
    },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
      cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

describe('web e2e: a finished turn ends with the files it produced', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  async function openFixture(fixture: string, id: string): Promise<void> {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    await seedSession(scaffold, fixture, id)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    // Keep the responsive sidebar available while selecting the cold seed;
    // the assertion itself narrows the conversation after navigation.
    await page.setViewportSize({ width: 1800, height: 900 })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[data-app-frame]', { timeout: 30_000 })
    // A legacy cold log has no catalog projection yet. Open the only seeded
    // session; its title becomes available when the recording is resumed.
    const group = page.getByRole('treeitem').first()
    await group.waitFor({ timeout: 15_000 })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await page.getByRole('treeitem').nth(1).click()
  }

  afterEach(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('expands a ten-file summary without horizontal overflow', async () => {
    await openFixture(producedFixture(), SEED_ID)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-produced-files'))

    await expect.poll(() => page.getByText(DONE, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    const row = page.locator('[data-produced-files-row]')
    await row.waitFor({ timeout: 15_000 })
    expect(await row.count()).toBe(1)
    const fileCards = row.getByRole('button', { name: /^Open / })
    await expect.poll(() => fileCards.count()).toBe(6)
    await expect.poll(() => row.getByText('+ 4 files', { exact: true }).isVisible()).toBe(true)

    await page.setViewportSize({ width: 780, height: 900 })
    await expect.poll(() => fileCards.count()).toBe(6)
    await expect.poll(() => row.getByText('+ 4 files', { exact: true }).isVisible()).toBe(true)
    await row.getByRole('button', { name: '+ 4 files', exact: true }).click()
    await expect.poll(() => fileCards.count()).toBe(10)
    expect(await row.getByRole('button', { name: '+ 4 files', exact: true }).count()).toBe(0)
    const showFolder = page.getByRole('button', { name: 'Show in folder', exact: true })
    expect(await showFolder.count()).toBe(1)
    expect(await page.getByText('Produced', { exact: true }).count()).toBe(1)

    const openPath = vi.spyOn(scaffold.ctx.sessionController, 'openWorkspacePath')
      .mockResolvedValue({ opened: true })
    try {
      const [response] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/openWorkspacePath'),
        showFolder.click({ clickCount: 1 }),
      ])
      expect(response.status()).toBe(200)
      expect(openPath).toHaveBeenCalledTimes(1)
      expect(openPath.mock.calls[0]![0]).toMatchObject({ path: `${scaffold.workspaceCwd}/.` })
    } finally {
      openPath.mockRestore()
    }

    const geometry = await row.evaluate(element => ({
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
    }))
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth)

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)

  it.skipIf(MODE === 'record')('restores published and probe-only file buttons from a cold legacy PTC log', async () => {
    await openFixture(publicationFixture(), PUBLICATION_SEED_ID)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-published-files-legacy'))
    await expect.poll(() => page.getByText(PUBLICATION_DONE, { exact: true }).count()).toBe(1)
    const row = page.locator('[data-produced-files-row]')
    await expect.poll(() => row.getByRole('button').count()).toBe(2)
    const openPath = vi.spyOn(scaffold.ctx.sessionController, 'openWorkspacePath')
      .mockResolvedValue({ opened: true })
    try {
      for (const path of ['published.md', 'inspected.html']) {
        await row.getByRole('button', { name: `Open ${path}`, exact: true }).click()
        await expect.poll(() => openPath.mock.calls.at(-1)?.[0]).toMatchObject({
          path: `${scaffold.workspaceCwd}/${path}`,
        })
      }
      expect(openPath).toHaveBeenCalledTimes(2)
    } finally {
      openPath.mockRestore()
    }
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => page.locator('[data-produced-files-row]').getByRole('button').count()).toBe(2)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps draft status, diagnostics and the marked file target after reload', async () => {
    await openFixture(publicationFixture(true), 'draft-quality-web-e2e')
    onTestFailed(() => saveFailureShot(page, 'web-e2e-produced-files-draft'))
    const row = page.locator('[data-produced-files-row]')
    const marked = row.getByRole('button', { name: 'Open published-draft.md', exact: true })
    await marked.waitFor()
    expect(await row.getByRole('button', { name: 'Open published.md', exact: true }).count()).toBe(0)
    expect(await marked.locator('[data-phase="draft"]').count()).toBe(1)
    const opener = vi.spyOn(scaffold.ctx.sessionController, 'openWorkspacePath').mockResolvedValue({ opened: true })
    try {
      await marked.click()
      await expect.poll(() => opener.mock.calls.at(-1)?.[0]).toMatchObject({ path: `${scaffold.workspaceCwd}/published-draft.md` })
    } finally { opener.mockRestore() }
    await page.locator('details').filter({ hasText: 'Missing policy source' }).locator('summary').click()
    expect(await page.getByText('Missing policy source', { exact: true }).isVisible()).toBe(true)
    await page.setViewportSize({ width: 780, height: 900 })
    const geometry = await row.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }))
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client)
    await page.reload({ waitUntil: 'load' })
    await marked.waitFor()
    expect(await marked.locator('[data-phase="draft"]').count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('opens a marked file from a long history tail without loading its turn start', async () => {
    await openFixture(publicationFixture(true, 100), 'partial-turn-draft-web-e2e')
    onTestFailed(() => saveFailureShot(page, 'web-e2e-partial-turn-draft'))
    const row = page.locator('[data-produced-files-row]')
    const marked = row.getByRole('button', { name: 'Open published-draft.md', exact: true })
    await marked.waitFor()
    expect(await page.getByText('Earlier context 0', { exact: true }).count()).toBe(0)
    expect(await row.getByRole('button', { name: 'Open published.md', exact: true }).count()).toBe(0)
    expect(await marked.locator('[data-phase="draft"]').count()).toBe(1)
    const opener = vi.spyOn(scaffold.ctx.sessionController, 'openWorkspacePath').mockResolvedValue({ opened: true })
    try {
      await marked.click()
      await expect.poll(() => opener.mock.calls.at(-1)?.[0]).toMatchObject({ path: `${scaffold.workspaceCwd}/published-draft.md` })
    } finally { opener.mockRestore() }
    await page.reload({ waitUntil: 'load' })
    await marked.waitFor()
    expect(await row.getByRole('button', { name: 'Open inspected.html', exact: true }).count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
