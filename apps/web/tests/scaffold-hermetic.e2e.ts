import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-skill'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import {
  launchWebScaffold, normalizeAria, registerVolatileSeedClock, type WebScaffold,
} from './scaffold.ts'

it('normalizes volatile seed dates without erasing fixed historical calendar values', () => {
  const workspaceCwd = '/private/tmp/dsh-web-clock-scope'
  const volatileTime = new Date(2026, 7, 30, 9, 31).getTime()
  registerVolatileSeedClock(workspaceCwd, volatileTime)

  expect(normalizeAria([
    'dynamic 8月30日 09:31',
    'dynamic long 2026年8月30日 09:31',
    'dynamic slash 8/30 09:31',
    'dynamic ISO 2026-8-30 09:31',
    'historical 2024年1月2日 03:04',
    'historical short 7月25日 14:05',
    'historical slash 7/25 14:06',
    'historical ISO 2024-1-2 03:05',
    'standalone 18:22',
    'standalone seconds 18:22:31',
  ].join('\n'), workspaceCwd, false)).toBe([
    'dynamic {{clock}}',
    'dynamic long {{clock}}',
    'dynamic slash {{clock}}',
    'dynamic ISO {{clock}}',
    'historical 2024年1月2日 {{clock}}',
    'historical short 7月25日 {{clock}}',
    'historical slash 7/25 {{clock}}',
    'historical ISO 2024-1-2 {{clock}}',
    'standalone {{clock}}',
    'standalone seconds {{clock}}',
  ].join('\n'))
})

async function writeSkill(root: string, name: string): Promise<void> {
  const bundle = join(root, name)
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'SKILL.md'), `---
name: ${name}
description: Must not enter the Web replay scaffold
---

Ambient host state.
`)
}

it('isolates replay skill discovery from every ambient host root', async () => {
  const ambient = await mkdtemp(join(tmpdir(), 'dsh-web-ambient-skills-'))
  const dshHome = join(ambient, 'dsh-home')
  const agentsHome = join(ambient, 'agents-home')
  const bundled = join(ambient, 'bundled')
  await Promise.all([
    writeSkill(join(dshHome, 'skills'), 'ambient-dsh'),
    writeSkill(join(agentsHome, 'skills'), 'ambient-agents'),
    writeSkill(bundled, 'ambient-bundled'),
  ])

  const originalDshHome = process.env.DSH_HOME
  const originalAgentsHome = process.env.DSH_AGENTS_HOME
  const originalBundled = process.env.DSH_BUNDLED_SKILL_DIR
  process.env.DSH_HOME = dshHome
  process.env.DSH_AGENTS_HOME = agentsHome
  process.env.DSH_BUNDLED_SKILL_DIR = bundled
  let scaffold: WebScaffold | undefined
  try {
    scaffold = await launchWebScaffold()
    const ctx = scaffold.ctx
    // Local skill discovery belongs to the agent's preset LAYER of the host
    // registry, so the roots under test are only reachable through a composed
    // agent's view — the same scope the `skills/list` Remote resolves for a
    // browser request about a session.
    const handle = await ctx.agents.create({
      sessionId: SessionId('hermetic-skills'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    try {
      const skills = ctx.get('skills')
      if (skills === undefined) throw new Error('the composition mounts no skill registry')
      const names = (await skills.list({ cwd: scaffold.workspaceCwd, scope: handle.agent })).map(skill => skill.name)
      expect(names).not.toContain('ambient-dsh')
      expect(names).not.toContain('ambient-agents')
      expect(names).not.toContain('ambient-bundled')
    } finally {
      await handle.dispose()
    }
  } finally {
    try {
      await scaffold?.close()
    } finally {
      if (originalDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = originalDshHome
      if (originalAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
      else process.env.DSH_AGENTS_HOME = originalAgentsHome
      if (originalBundled === undefined) delete process.env.DSH_BUNDLED_SKILL_DIR
      else process.env.DSH_BUNDLED_SKILL_DIR = originalBundled
      await rm(ambient, { recursive: true, force: true })
    }
  }
})
