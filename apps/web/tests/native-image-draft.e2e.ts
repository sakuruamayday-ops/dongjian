import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { GongchuangConnectorService } from '@gongchuang/connectors'
import { ComposerDraftStore } from '../../desktop/src/composer-drafts.ts'
import { ImageTransferConsentStore } from '../../desktop/src/image-transfer-consents.ts'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, saveFailureShot, writeComposerDraft } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./annotation-message.overlay.yml', import.meta.url))
const REPLAY = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v2.jsonl', import.meta.url))
const SESSION_ID = 'native-image-draft-web'
const PNG = readFileSync(new URL('../../../snapshots/session/read-image/workspace/red.png', import.meta.url)).toString('base64')

describe('pasted image drafts across cold renderers', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let page: Page
  let consoleReport: ReturnType<typeof watchConsole>
  let overrideDir: string | undefined

  afterAll(async () => {
    await browser?.close()
    if (scaffold !== undefined && process.platform === 'darwin') {
      await scaffold.ctx.fiber.dispose()
      const trash = await mkdtemp(join(homedir(), '.Trash', 'GC-QA-image-draft-'))
      await rename(scaffold.workspaceCwd, join(trash, 'workspace'))
      await rename(scaffold.persistenceRoot, join(trash, 'persistence'))
      if (overrideDir !== undefined) await rename(overrideDir, join(trash, 'replay'))
    }
    await scaffold?.close()
  })

  it('restores image drafts and provider consent through native storage across cold renderers', async () => {
    overrideDir = await mkdtemp(join(tmpdir(), 'gongchuang-image-consent-replay-'))
    const replay = deriveReplayScript(parseSessionLog(await readFile(REPLAY, 'utf8')))
    expect(replay).toHaveLength(1)
    const override = join(overrideDir, 'replay.json')
    await writeFile(override, JSON.stringify([replay[0], replay[0]]))
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      extraInstallAnchors: [join(REPO_ROOT, 'apps/desktop/package.json')],
      replayFixture: REPLAY, replayOverride: override, compareReplaySession: false,
    })
    scaffold.ctx.provide('gongchuangAccount', {
      snapshot: () => ({ portalUrl: 'https://example.invalid' }),
    } as unknown as typeof scaffold.ctx.gongchuangAccount)
    await scaffold.ctx.plugin(GongchuangConnectorService)
    await scaffold.ctx.settings.mutate('gongchuang-connectors', [{ op: 'set', path: ['enabled'], value: [] }])
    await seedSession(scaffold, await readFile(REPLAY, 'utf8'), SESSION_ID)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, '图片草稿验收')
    await workspace.attachSession(SessionId(SESSION_ID))
    const native = new ComposerDraftStore(join(scaffold.workspaceCwd, 'native-drafts.v1.json'))
    const consent = new ImageTransferConsentStore(join(scaffold.workspaceCwd, 'native-consents.v1.json'))
    browser = await chromium.launch()
    onTestFailed(async () => {
      console.error(consoleReport)
      await saveFailureShot(page, 'native-image-draft')
    })

    const openColdRenderer = async (): Promise<void> => {
      await context?.close()
      context = await browser!.newContext({ locale: 'zh-CN', reducedMotion: 'reduce' })
      page = await context.newPage()
      consoleReport = watchConsole(page)
      await page.exposeFunction('qaDraftRead', (id: string) => native.read(id))
      await page.exposeFunction('qaDraftWrite', (id: string, value: unknown) => native.write(id, value))
      await page.exposeFunction('qaDraftClear', (id: string) => native.clear(id))
      await page.exposeFunction('qaConsentRead', () => consent.read())
      await page.exposeFunction('qaConsentRemember', (provider: unknown) => consent.remember(provider))
      await page.addInitScript((rootPath) => {
        // The bridge alone is substituted; storage validation and the complete Loader UI are real.
        const host = window as unknown as {
          qaDraftRead: (id: string) => Promise<unknown>
          qaDraftWrite: (id: string, value: unknown) => Promise<void>
          qaDraftClear: (id: string) => Promise<void>
          qaConsentRead: () => Promise<unknown>
          qaConsentRemember: (provider: unknown) => Promise<void>
          gongchuangDesktop: unknown
        }
        host.gongchuangDesktop = {
          platform: 'darwin',
          onOpenSessionDeepLink: () => () => {},
          onUpdateProgress: () => () => {},
          readAvatar: async () => null,
          workspaceRootState: async () => ({ rootPath, isDefault: true, needsInitialSetup: false }),
          readSkillUpdateState: async () => ({ status: 'idle', currentVersion: '1.6.16' }),
          checkSkillUpdates: async () => ({ status: 'idle', currentVersion: '1.6.16' }),
          checkForUpdates: async () => ({ status: 'idle', currentVersion: '0.4.4' }),
          readComposerDraft: host.qaDraftRead,
          writeComposerDraft: host.qaDraftWrite,
          clearComposerDraft: host.qaDraftClear,
          readImageTransferConsents: host.qaConsentRead,
          rememberImageTransferConsent: host.qaConsentRemember,
        }
      }, scaffold!.workspaceCwd)
      await page.goto(scaffold!.authenticatedUrl, { waitUntil: 'load' })
      await page.locator('body[data-gongchuang-product]').waitFor({ timeout: 30_000 })
      const enter = page.getByRole('button', { name: '保存并进入共创企业助手', exact: true })
      await enter.or(page.locator('[data-sidebar-workspace-toggle]').first()).first().waitFor()
      if (await enter.isVisible()) await enter.click()
      await page.getByRole('dialog', { name: '设置所属地与企业空间' }).waitFor({ state: 'hidden' })
      const toggle = page.locator('[data-sidebar-workspace-toggle]').first()
      await toggle.waitFor({ timeout: 15_000 })
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
      await page.locator(`[data-sidebar-session-id="${SESSION_ID}"] button`).first().click()
      await page.locator('[data-composer-input]').first().waitFor()
    }

    const pastePng = async (): Promise<void> => {
      await page.locator('[data-composer-input]').first().evaluate((element, base64) => {
        const clipboardData = new DataTransfer()
        clipboardData.items.add(new File(
          [Uint8Array.from(atob(base64), char => char.charCodeAt(0))], 'image.png', { type: 'image/png' },
        ))
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
      }, PNG)
    }

    await openColdRenderer()
    const tripwire = watchConsole(page)
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, 'GC-QA cold image draft')
    await pastePng()
    await expect.poll(async () => (await native.read(SESSION_ID))?.images?.[0]?.data).toBe(PNG)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await openColdRenderer()
    const restoredTripwire = watchConsole(page)
    await expect.poll(() => page.locator('[data-composer-input]').first().innerText()).toBe('GC-QA cold image draft')
    await page.getByRole('button', { name: 'image.png', exact: true }).waitFor()
    await expect.poll(() => page.getByRole('img', { name: 'image.png', exact: true })
      .evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1)
    await page.getByRole('button', { name: '移除图片 image.png', exact: true }).click()
    await expect.poll(async () => (await native.read(SESSION_ID))?.images).toEqual([])
    expect(restoredTripwire.pageErrors).toEqual([])
    expect(restoredTripwire.warnings).toEqual([])
    await openColdRenderer()
    expect(await page.getByRole('button', { name: 'image.png', exact: true }).count()).toBe(0)
    await expect.poll(() => page.locator('[data-composer-input]').first().innerText()).toBe('GC-QA cold image draft')

    await pastePng()
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '确认图片传输', exact: true })
    await dialog.waitFor()
    await page.getByRole('button', { name: '取消发送', exact: true }).click()
    await expect.poll(() => native.read(SESSION_ID)).toMatchObject({ images: [{ data: PNG }] })
    expect(await consent.read()).toEqual([])
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await dialog.waitFor()
    const firstSettled = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: '同意并发送', exact: true }).click()
    await firstSettled
    expect(await consent.read()).toEqual(['deepseek'])
    expect(await page.evaluate(() => localStorage.getItem('gongchuang.image-transfer-consent.v1'))).toBeNull()

    await openColdRenderer()
    await pastePng()
    const secondSettled = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await secondSettled
    expect(await page.getByRole('dialog', { name: '确认图片传输', exact: true }).count()).toBe(0)
    expect(consoleReport.pageErrors).toEqual([])
    expect(consoleReport.warnings).toEqual([])
  }, 120_000)
})
