import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const clientSource = readFileSync(resolve(import.meta.dirname, '../src/client/index.ts'), 'utf8')
const productShellSource = readFileSync(resolve(import.meta.dirname, '../src/client/ProductShell.tsx'), 'utf8')
const productCss = readFileSync(resolve(import.meta.dirname, '../src/client/ProductShell.module.css'), 'utf8')

describe('desktop title-bar layout', () => {
  test('keeps the expanded desktop surface flush while preserving a compact macOS drag target', () => {
    expect(clientSource).toContain("window.gongchuangDesktop?.platform === 'darwin'")
    expect(clientSource).toContain("document.body.dataset.gongchuangMacDesktop = 'true'")
    expect(clientSource).toContain('delete document.body.dataset.gongchuangMacDesktop')
    expect(productCss).toMatch(
      /data-gongchuang-mac-desktop='true'[\s\S]*?\.brandBlock \{[\s\S]*?padding-left: 66px;[\s\S]*?-webkit-app-region: drag/u,
    )
    expect(productCss).toMatch(/data-gongchuang-mac-desktop='true'[\s\S]*?\.brandBlock button \{[\s\S]*?-webkit-app-region: no-drag/u)
    expect(productCss).not.toContain('padding-top: 48px')
    expect(productCss).not.toContain('.sidebar::before')
  })

  test('limits vertical traffic-light clearance to the collapsed macOS rail', () => {
    expect(productCss).toMatch(/data-gongchuang-mac-desktop='true'[\s\S]*?\.sidebar\[data-collapsed\] \{[\s\S]*?padding-top: 42px/u)
    expect(productCss).toMatch(
      /data-gongchuang-mac-desktop='true'[\s\S]*?\.sidebar\[data-collapsed\] \.brandBlock \{[\s\S]*?padding-left: 0/u,
    )
  })

  test('uses the full conversation header as a macOS drag surface without swallowing controls', () => {
    expect(productShellSource).toContain('<div className={css.windowDragRegion} aria-hidden="true" />')
    expect(productCss).toMatch(
      /data-gongchuang-mac-desktop='true'[^}]*\[data-phase\] > header \{\s*-webkit-app-region: drag;/u,
    )
    expect(productCss).toMatch(
      /data-gongchuang-mac-desktop='true'[^}]*\[data-phase\] > header[\s\S]*?button:not\(:disabled\)[\s\S]*?-webkit-app-region: no-drag;/u,
    )
    expect(productCss).toMatch(
      new RegExp([
        String.raw`\.windowDragRegion \{[\s\S]*?height: 44px;[\s\S]*?\}`,
        String.raw`[\s\S]*?data-gongchuang-mac-desktop='true'[^}]*\.windowDragRegion \{`,
        String.raw`[\s\S]*?-webkit-app-region: drag;`,
      ].join(''), 'u'),
    )
    expect(productCss).toMatch(/\.assistantFloater \{[\s\S]*?z-index: 10;[\s\S]*?-webkit-app-region: no-drag;/u)
  })

  test('keeps version details in settings instead of the main sidebar', () => {
    expect(productShellSource).not.toContain('客户端版本读取中')
    expect(productShellSource).not.toContain('客户端 V${updateSnapshot.currentVersion}')
    expect(productShellSource).not.toContain('技能包 V{activeSkillVersion}')
    expect(productCss).not.toContain('.versionLine')
  })

  test('keeps the full product name visible and uses the WorkBuddy-style selected row', () => {
    const activeSessionStyle = new RegExp([
      String.raw`\.workspaceSessionButton\[data-active\] \{[\s\S]*?box-shadow: none;`,
      String.raw`[\s\S]*?border-radius: 7px;`,
      String.raw`[\s\S]*?background: transparent;`,
    ].join(''), 'u')
    const activeTitleStyle = new RegExp([
      String.raw`\.workspaceSessionButton\[data-active\] > span \{[\s\S]*?border: 0;`,
      String.raw`[\s\S]*?background: transparent;`,
    ].join(''), 'u')
    const activeTimeStyle = new RegExp([
      String.raw`\.workspaceSessionButton\[data-active\] > small \{[\s\S]*?border: 0;`,
      String.raw`[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;`,
    ].join(''), 'u')
    expect(productShellSource).toContain('<strong>洞见</strong>')
    expect(productCss).toMatch(/\.brandCopy strong \{[\s\S]*?overflow: visible;[\s\S]*?text-overflow: clip;[\s\S]*?white-space: nowrap/u)
    expect(productCss).toMatch(activeSessionStyle)
    expect(productCss).toMatch(
      /\.workspaceSessionRow\[data-active\] \{\s*background: color-mix\(in srgb, var\(--gc-sidebar-ink\) 7%, transparent\);/u,
    )
    expect(productCss).toMatch(activeTitleStyle)
    expect(productCss).toMatch(activeTimeStyle)
    expect(productCss).toMatch(/\.workspaceSessionRow:hover,[\s\S]*?\.workspaceSessionRow:focus-within \{\s*background: transparent;/u)
    expect(productCss).toMatch(/\.workspaceSessionButton:focus-visible \{[\s\S]*?outline: 1px solid/u)
    expect(productCss).toMatch(/\.workspaceSessionActions \{[\s\S]*?opacity: 0;[\s\S]*?pointer-events: none;/u)
    expect(productCss).toMatch(/\.workspaceSessionRow:hover \.workspaceSessionActions,[\s\S]*?opacity: 1;[\s\S]*?pointer-events: auto;/u)
    expect(productCss).toMatch(/\.workspaceSessionButton \{[\s\S]*?align-items: center;[\s\S]*?gap: 7px;/u)
    expect(productCss).not.toMatch(/\.workspaceSessionButton \{[^}]*flex-direction: column;/u)
    expect(productCss).toMatch(/\.workspaceSessionRow:hover \.workspaceSessionButton small,[\s\S]*?display: none;/u)
    expect(productCss).not.toMatch(/\.workspaceSessionButton\[data-active\] > span \{[^}]*var\(--gc-gold\)/u)
    expect(productCss).not.toContain('box-shadow: inset 2px 0 var(--gc-gold)')
    expect(productCss).not.toContain('cursor: grab')
    expect(productCss).not.toContain('cursor: grabbing')
    expect(productCss).toMatch(/\.workspaceTreeToggle,[\s\S]*?\.workspaceSessionButton \{[\s\S]*?cursor: default;/u)
    expect(productCss).not.toContain('data-gongchuang-sidebar-drag-preview')
    expect(productCss).toMatch(/data-drop-edge='before'[\s\S]*?height: 2px;[\s\S]*?linear-gradient/u)
  })
})
