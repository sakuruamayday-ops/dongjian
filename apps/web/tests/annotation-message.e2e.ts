import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, describe, expect, it, onTestFailed } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { GongchuangConnectorService } from '@gongchuang/connectors'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, saveFailureShot, writeComposerDraft } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./annotation-message.overlay.yml', import.meta.url))
const REPLAY = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v2.jsonl', import.meta.url))
const SESSION_ID = 'numbered-annotation-web'
const QUOTE_ONE = '核对研发项目的起止日期。'
const QUOTE_TWO = '按材料里的记录检查成果归属。'
const QUOTE_THREE = '请确认长回复末尾的交付结论。'
const LONG_REPLY = Array.from({ length: 32 }, (_, index) =>
  `第 ${String(index + 1)} 项材料核对：本段为纯合成滚动测试内容，保留原始记录并逐项核对。`).join('\n\n')
const SHOTS = join(REPO_ROOT, '.artifacts', 'numbered-annotations')
const DOCUMENTS = ['研发项目说明.docx', '材料核对表-客户与经营情况-待补材料清单.xlsx'].map(name => ({
  name, relativePath: `共创导入资料/${name}`, bytes: 128,
}))

function historyFixture(): string {
  const session = Session.create(SessionId('numbered-annotation-source'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '请核对这些材料的内容。' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title: '材料核对', messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Synthetic workspace instructions.' }],
    source: { kind: 'agent-instructions', form: 'instructions', baseline: true,
      changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: 'annotation-qa' }] },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 1, step: 1, message: createAssistantMessage({
      content: [{ type: 'text', text: `${QUOTE_ONE}\n\n${QUOTE_TWO}\n\n${LONG_REPLY}\n\n${QUOTE_THREE}` }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
      cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)), '',
  ].join('\n')
}

describe('product numbered annotations over the assembled browser', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps quotes out of the draft and persists a numbered annotation-only message', async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      extraInstallAnchors: [join(REPO_ROOT, 'apps/desktop/package.json')],
      replayFixture: REPLAY, compareReplaySession: false,
    })
    // Only the connector's read-only portal lookup is needed. No account
    // provider, login guard, native credentials, or external MCP is installed.
    scaffold.ctx.provide('gongchuangAccount', {
      snapshot: () => ({ portalUrl: 'https://example.invalid' }),
    } as unknown as typeof scaffold.ctx.gongchuangAccount)
    await scaffold.ctx.plugin(GongchuangConnectorService)
    await scaffold.ctx.settings.mutate('gongchuang-connectors', [{ op: 'set', path: ['enabled'], value: [] }])
    await seedSession(scaffold, historyFixture(), SESSION_ID)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, '材料核对')
    await workspace.attachSession(SessionId(SESSION_ID))
    const events: SessionEvent[] = []
    scaffold.ctx.on('session/event', (_session, event) => { events.push(event) })
    browser = await chromium.launch()
    page = await browser.newPage({ locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'numbered-annotation-message'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('body[data-gongchuang-product]').waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: '进入共创企业助手', exact: true }).click()
    await page.getByRole('dialog', { name: '选择所属地' }).waitFor({ state: 'hidden' })
    const toggle = page.locator('[data-sidebar-workspace-toggle]').first()
    await toggle.waitFor({ timeout: 15_000 })
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    await page.locator(`[data-sidebar-session-id="${SESSION_ID}"] button`).first().click()
    await page.getByText(QUOTE_ONE, { exact: true }).waitFor({ timeout: 15_000 })
    await page.getByText('请核对这些材料的内容。', { exact: true }).click({ clickCount: 3 })
    await page.getByRole('button', { name: '添加到对话', exact: true }).waitFor({ timeout: 5_000 })
    await page.keyboard.press('Escape')
    const input = page.locator('[data-composer-input]').first()
    await input.click()
    // A real paste exercises the Unicode intake route; keyboard.type does
    // not synthesize IME composition for Chinese text in an empty Lexical root.
    await input.evaluate((element) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', '请看注释 2')
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
    })
    await expect.poll(() => input.innerText()).toBe('请看注释 2')
    const opened: { cwd: string; path: string }[] = []
    await page.exposeFunction('annotationFixtureOpenFile', (cwd: string, path: string) => { opened.push({ cwd, path }) })
    // Only the OS import/open boundary is a fixture. The real product handler
    // owns attachment state, prompt preparation, persistence and rendering.
    const installImportBridge = async (): Promise<void> => {
      await page.evaluate((documents) => {
        const host = window as unknown as {
          annotationFixtureOpenFile: (cwd: string, path: string) => Promise<void>
          gongchuangDesktop: unknown
        }
        host.gongchuangDesktop = {
          importDocuments: async () => documents.slice(0, 1),
          importDroppedDocuments: async (_cwd: string, files: File[]) =>
            documents.filter(document => files.some(file => file.name === document.name)),
          openImportedDocument: host.annotationFixtureOpenFile,
        }
      }, DOCUMENTS)
    }
    await installImportBridge()
    const files = page.getByRole('list', { name: '已添加文件', exact: true })
    const sessionsBeforeImport = [...workspace.sessionIds]
    await page.getByRole('button', { name: '为本次对话添加文件', exact: true }).click()
    await expect.poll(() => files.getByRole('listitem').count()).toBe(1)
    await input.evaluate((element, name) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['layout fixture'], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }, DOCUMENTS[1]!.name)
    await expect.poll(() => files.getByRole('listitem').count()).toBe(2)
    await files.getByRole('button', { name: `打开 ${DOCUMENTS[0]!.name}`, exact: true }).click()
    await expect.poll(() => opened).toEqual([{ cwd: scaffold.workspaceCwd, path: DOCUMENTS[0]!.relativePath }])
    expect(events.filter(event => event.type === 'user/message')).toHaveLength(0)
    expect(workspace.sessionIds).toEqual(sessionsBeforeImport)
    const select = async (text: string): Promise<void> => {
      await page.getByText(text, { exact: true }).scrollIntoViewIfNeeded()
      const box = await page.getByText(text, { exact: true }).evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const rect = range.getBoundingClientRect()
        return { x: rect.x, right: rect.right, y: rect.y + rect.height / 2 }
      })
      await page.mouse.move(box.x - 1, box.y)
      await page.mouse.down()
      await page.mouse.move(box.right + 1, box.y, { steps: 6 })
      await page.mouse.up()
      expect(await page.evaluate(() => window.getSelection()?.toString().trim())).toBe(text)
      await page.getByRole('button', { name: '添加到对话', exact: true }).click()
      await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
    }
    // Native paragraph selection can end at offset zero of the next paragraph.
    // Keep this gesture real; a synthetic Range does not exercise Chromium's boundary choice.
    await page.getByText(QUOTE_ONE, { exact: true }).click({ clickCount: 3 })
    expect(await page.evaluate(() => window.getSelection()?.toString().trim())).toBe(QUOTE_ONE)
    await page.getByRole('button', { name: '添加到对话', exact: true }).click()
    await page.locator('[data-source-annotations]').getByRole('button', { name: '注释 1', exact: true }).waitFor()
    // The final paragraph borders the composer, including its attachment icons.
    await page.getByText(QUOTE_TWO, { exact: true }).click({ clickCount: 3 })
    await page.getByRole('button', { name: '添加到对话', exact: true }).waitFor({ timeout: 5_000 })
    await page.keyboard.press('Escape')
    await input.click()
    await select(QUOTE_TWO)
    const draft = page.locator('[data-annotation-draft]')
    await draft.getByRole('button', { name: '2 条注释' }).waitFor()
    expect(await input.innerText()).toBe('请看注释 2')
    await page.getByText(QUOTE_THREE, { exact: true }).click({ clickCount: 3 })
    await page.getByRole('button', { name: '添加到对话', exact: true }).click()
    await draft.getByRole('button', { name: '3 条注释' }).waitFor()
    await mkdir(SHOTS, { recursive: true })
    const assertSourceMarkersAtEnd = async (numbers: number[]): Promise<void> => {
      await page.getByText(QUOTE_THREE, { exact: true }).scrollIntoViewIfNeeded()
      const markers = page.locator('[data-source-annotations]')
      for (const number of numbers) {
        await markers.getByRole('button', { name: `注释 ${String(number)}`, exact: true }).waitFor()
      }
      // DOM visibility alone also passes when every badge is above the viewport.
      await expect.poll(() => markers.evaluate((element) => {
        const row = element.closest('[data-chat-flow-key]')!
        const prose = row.querySelector('p')!
        const scroll = row.closest('[data-conversation-scroll]')!
        const composer = document.querySelector('[data-composer-card]')!
        const markerBox = element.getBoundingClientRect()
        const rowBox = row.getBoundingClientRect()
        return {
          visibleTop: markerBox.top >= Math.max(0, scroll.getBoundingClientRect().top),
          visibleBottom: markerBox.bottom <= composer.getBoundingClientRect().top,
          withinSource: markerBox.top >= rowBox.top && markerBox.bottom <= rowBox.bottom,
          besideProse: markerBox.left >= prose.getBoundingClientRect().right,
        }
      })).toEqual({ visibleTop: true, visibleBottom: true, withinSource: true, besideProse: true })
    }
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await assertSourceMarkersAtEnd([1, 2, 3])
      await page.screenshot({ path: join(SHOTS, `long-reply-markers-${viewport.width}.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await draft.getByRole('button', { name: '3 条注释' }).click()
    await page.getByRole('button', { name: '移除注释 3' }).click()
    await page.getByRole('button', { name: '移除注释 1' }).click()
    expect(await page.locator('[data-source-annotations]').getByRole('button', { name: '注释 2', exact: true }).count()).toBe(0)
    expect(await page.getByRole('dialog').getByText(QUOTE_TWO, { exact: true }).count()).toBe(1)
    await page.getByRole('button', { name: '移除注释 1' }).click()
    expect(await draft.count()).toBe(0)
    expect(await page.locator('[data-source-annotations]').count()).toBe(0)
    await select(QUOTE_TWO)
    await draft.getByRole('button', { name: '1 条注释' }).click()
    await page.getByRole('textbox', { name: '注释 1 的评论' }).fill('请说明这里的判断依据。')
    await page.getByRole('button', { name: '关闭注释' }).click()
    await page.reload({ waitUntil: 'load' })
    await draft.getByRole('button', { name: '1 条注释' }).waitFor({ timeout: 15_000 })
    await assertSourceMarkersAtEnd([1])
    await expect.poll(() => files.getByRole('listitem').count()).toBe(2)
    await installImportBridge()
    expect(await input.innerText()).toBe('请看注释 2')
    await mkdir(SHOTS, { recursive: true })
    await page.screenshot({ path: join(SHOTS, 'desktop-collapsed.png') })
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      for (const rail of [files, draft]) {
        // Read both boxes in one layout frame; the responsive sidebar moves the
        // composer after a viewport change, invalidating separately read boxes.
        await expect.poll(() => rail.evaluate((element) => {
          const card = element.closest('[data-composer-card]')
          const cardBox = card?.getBoundingClientRect()
          const railBox = element.getBoundingClientRect()
          return {
            insideCard: card !== null,
            alignedLeft: cardBox !== undefined && Math.abs(railBox.x - cardBox.x) <= 1,
            alignedWidth: cardBox !== undefined && Math.abs(railBox.width - cardBox.width) <= 1,
            insideVertically: cardBox !== undefined && railBox.y >= cardBox.y && railBox.bottom <= cardBox.bottom,
            noOverflow: element.scrollWidth <= element.clientWidth,
          }
        })).toEqual({
          insideCard: true, alignedLeft: true, alignedWidth: true, insideVertically: true, noOverflow: true,
        })
      }
      await draft.getByRole('button', { name: '1 条注释' }).click()
      const dialog = page.getByRole('dialog', { name: '1 条注释' })
      await dialog.waitFor()
      expect(await dialog.getByRole('textbox', { name: '注释 1 的评论' }).inputValue()).toBe('请说明这里的判断依据。')
      const box = await dialog.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(11)
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width - 11)
      expect(box!.y).toBeGreaterThanOrEqual(11)
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height - 11)
      await page.screenshot({ path: join(SHOTS, `expanded-${viewport.width}.png`) })
      await dialog.screenshot({ path: join(SHOTS, `annotation-panel-${viewport.width}.png`) })
      await dialog.press('Escape')
      await input.click()
      await page.locator('[data-composer-seat]').first().screenshot({ path: join(SHOTS, `composer-${viewport.width}.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    for (const document of DOCUMENTS) {
      await files.getByRole('button', { name: `从本次会话移除 ${document.name}`, exact: true }).click()
    }
    expect(await files.count()).toBe(0)
    await writeComposerDraft(page, input, '')
    const settled = scaffold.whenTurnSettled()
    await input.press('Enter')
    await settled
    await page.locator('[data-user-annotations]').getByRole('button', { name: '1 条注释' }).waitFor()
    expect(await draft.count()).toBe(0)
    const sent = events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(sent?.type).toBe('user/message')
    if (sent?.type !== 'user/message') throw new Error('annotation was not persisted as a user message')
    const modelText = sent.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(modelText).toContain(QUOTE_TWO)
    expect(modelText).not.toContain(QUOTE_ONE)
    expect(modelText).toContain('请说明这里的判断依据。')
    expect('displayText' in sent.data.source && sent.data.source.displayText).toMatch(/^\[gongchuang-annotations:v1\]/u)
    await page.reload({ waitUntil: 'load' })
    const sourceMarker = page.locator('[data-source-annotations]').getByRole('button', { name: '注释 1', exact: true })
    await sourceMarker.waitFor({ timeout: 15_000 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.body.toggleAttribute('data-ds-dark-theme', value === 'dark') }, theme)
      for (const hovering of [false, true]) {
        if (hovering) await sourceMarker.hover()
        else await input.hover()
        const colors = await sourceMarker.evaluate((element, isHovered) => {
          const style = getComputedStyle(element)
          const sample = document.createElement('span')
          sample.style.backgroundColor = style.getPropertyValue(isHovered
            ? '--dsw-alias-interactive-bg-active'
            : '--dsw-alias-interactive-bg-hover')
          sample.style.color = style.getPropertyValue('--dsw-alias-label-secondary')
          element.append(sample)
          const expected = getComputedStyle(sample)
          const actual = { foreground: style.color, background: style.backgroundColor,
            expectedForeground: expected.color, expectedBackground: expected.backgroundColor }
          sample.remove()
          return actual
        }, hovering)
        expect(colors.background).toBe(colors.expectedBackground)
        expect(colors.foreground).toBe(colors.expectedForeground)
      }
      await sourceMarker.screenshot({ path: join(SHOTS, `source-marker-${theme}.png`) })
    }
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    await sourceMarker.click()
    expect(await page.getByRole('dialog').getByText(QUOTE_TWO, { exact: true }).count()).toBe(1)
    await page.getByRole('dialog').press('Escape')
    const sentSummary = page.locator('[data-user-annotations]').getByRole('button', { name: '1 条注释' })
    await sentSummary.click()
    expect(await page.getByRole('dialog').getByText('注释 1', { exact: true }).count()).toBe(1)
    expect(await page.getByRole('dialog').getByText('请说明这里的判断依据。', { exact: true }).count()).toBe(1)
    expect(await page.getByRole('dialog').getByRole('textbox').count()).toBe(0)
    expect(await page.locator('[data-user-message-body]').filter({ hasText: 'gongchuang-annotations' }).count()).toBe(0)
    await page.getByRole('dialog').press('Escape')
    await page.evaluate(() => {
      const host = window as unknown as { gongchuangDesktop: { checkForUpdates: () => Promise<unknown> } }
      host.gongchuangDesktop = {
        checkForUpdates: async () => ({ status: 'available', currentVersion: '0.4.3', latestVersion: '0.4.4',
          message: '发现客户端 V0.4.4', releaseNotes: '文件卡片与注释更新验收。' }),
      }
    })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '更新与版本', exact: true }).click()
    await settings.getByRole('button', { name: '检查更新', exact: true }).click()
    const notice = page.locator('[data-update-notification]')
    await notice.waitFor()
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    const noticeBox = await notice.boundingBox()
    const sidebarBox = await page.locator('[data-gongchuang-product-root="sidebar"]').boundingBox()
    const composerBox = await page.locator('[data-composer-card]').first().boundingBox()
    expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width)
    expect(noticeBox!.x + noticeBox!.width).toBeLessThan(composerBox!.x)
    await page.screenshot({ path: join(SHOTS, 'update-notice-sidebar.png') })
    await notice.getByRole('button', { name: '更新日志', exact: true }).click()
    expect(await page.getByRole('dialog').getByText('文件卡片与注释更新验收。', { exact: true }).count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
})
