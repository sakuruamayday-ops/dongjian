import { afterEach, describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { launchWebScaffold, seedSession, type WebScaffold } from './scaffold.ts'

describe('Session disposal through the shipped Loader composition', () => {
  let scaffold: WebScaffold | undefined

  afterEach(async () => { await scaffold?.close() })

  it.each(['cold', 'live'] as const)('retires a %s Session before its artifact can move', async (state) => {
    scaffold = await launchWebScaffold()
    const { ctx, workspaceCwd } = scaffold
    const sessionId = SessionId(`trash-${state}-composition`)
    if (state === 'cold') {
      const history = Session.create(sessionId)
      history.append('turn/start', { turn: 1 })
      history.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await seedSession(scaffold, [JSON.stringify({
        type: 'session', version: 0, id: '{{sessionId}}', createdAt: 0, cwd: '{{cwd}}',
      }), ...history.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n'), sessionId)
      expect(ctx.sessions.get(sessionId)).toBeUndefined()
    } else {
      await ctx.sessionController.create({ sessionId, cwd: workspaceCwd })
      expect(ctx.agents.get(sessionId)).toBeDefined()
    }

    await expect(ctx.sessionController.disposeSession(sessionId)).resolves.toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    const persisted = await ctx.sessionPersistence.list()
    expect(persisted.some(candidate => candidate.header.id === sessionId)).toBe(true)
    ctx.sessionController.releaseSessionDisposal(sessionId)
  })
})
