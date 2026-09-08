import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { AttachmentId, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import SessionController from '../src/index.ts'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

const defaults = {
  defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

describe('SessionController facade', () => {
  it('does not require the Tools service', () => {
    expect(SessionController.inject).not.toContain('tools')
  })

  it('resolves only a file reference recorded by the addressed Session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const fileHostPath = vi.fn(() => '/tmp/dsh-attachments/source.docx')
    ctx.provide('attachments', { fileHostPath } as never)
    const controller = createSessionTestController(ctx, defaults)
    const sessionId = SessionId('controller-file-open')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/workspace' } })
    const attachment: FileAttachmentRef = {
      attachmentId: AttachmentId('attachment-1'), name: 'source.docx', bytes: 128,
    }
    session.append('user/message', createUserMessage({
      content: [{ type: 'file', attachment }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await expect(controller.fileAttachmentPath(sessionId, attachment))
      .resolves.toBe('/tmp/dsh-attachments/source.docx')
    expect(fileHostPath).toHaveBeenCalledExactlyOnceWith(attachment)
    await expect(controller.fileAttachmentPath(sessionId, { ...attachment, name: 'other.docx' }))
      .rejects.toThrow('File is not referenced by this session.')
    await expect(controller.fileAttachmentPath(sessionId, {
      ...attachment, attachmentId: AttachmentId('attachment-2'),
    })).rejects.toThrow('File is not referenced by this session.')
    expect(fileHostPath).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('rejects artifact deletion without persistence before changing a live Session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const controller = createSessionTestController(ctx, defaults)
    const sessionId = SessionId('controller-delete-no-persistence')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/workspace' } })
    const flush = vi.spyOn(ctx.sessions, 'flush')
    await expect(controller.disposeSession(sessionId)).rejects.toThrow('requires session persistence')
    expect(ctx.sessions.get(sessionId)).toBe(session)
    expect(flush).not.toHaveBeenCalled()
    controller.releaseSessionDisposal(sessionId)
    await ctx.fiber.dispose()
  })

  it('owns Host service methods and publishes Agent lifecycle projections', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const sessionId = SessionId('controller-session')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      cwd: '/workspace',
      isSeeded: false,
    }
    const events: SessionEvent[] = []
    const inspect = vi.fn(() => Promise.resolve({
      meta: header,
      inheritedEventCount: SessionLogOffset(0),
      events,
    }))
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect,
    }) as never)
    let uploadResolver: ((sessionId: SessionId) => Promise<Agent>) | undefined
    ctx.provide('fileUploads', {
      registerAgentResolver: (resolve: (sessionId: SessionId) => Promise<Agent>) => {
        uploadResolver = resolve
        return () => {}
      },
      resolve: () => undefined,
      bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
      retirePrompt: () => {},
    } as never)
    const controller = createSessionTestController(ctx, defaults)
    const status = vi.fn()
    const failure = vi.fn()
    const activity = vi.fn()
    ctx.on('api-session/status', status)
    ctx.on('api-session/error', failure)
    ctx.on('api-session/activity', activity)

    await expect(controller.inspect(sessionId)).resolves.toEqual({
      meta: header,
      inheritedEventCount: SessionLogOffset(0),
      events,
    })
    expect(inspect).toHaveBeenCalledOnce()

    const session = ctx.sessions.create(sessionId, { meta: header })
    const agent = {
      id: sessionId,
      session,
      status: 'idle',
      ctx,
    } as Agent
    ctx.agents.register(agent)
    const resolveUploadAgent = (id: SessionId): Promise<Agent> => {
      if (uploadResolver === undefined) throw new Error('file upload resolver was not registered')
      return uploadResolver(id)
    }
    await expect(resolveUploadAgent(sessionId)).resolves.toBe(agent)
    const activationError = new RemoteError('session/not-found', 'missing upload session', { sessionId })
    vi.spyOn(
      (controller as unknown as { agents: ApiSessionAgentController }).agents,
      'resolveAgent',
    ).mockResolvedValueOnce({ error: activationError })
    await expect(resolveUploadAgent(sessionId)).rejects.toBe(activationError)
    const consumeSelection = vi.spyOn(
      (controller as unknown as { agents: ApiSessionAgentController }).agents,
      'consumeSelection',
    )

    await expect(controller.resolveAgent(sessionId)).resolves.toEqual({ agent })
    await expect(controller.inspect(sessionId)).resolves.toEqual({
      meta: header,
      inheritedEventCount: SessionLogOffset(0),
      events,
    })
    expect(inspect).toHaveBeenCalledOnce()
    ctx.emit('agent/status', { agent, status: 'running' })
    ctx.emit('agent/error', { agent, turn: 1, step: 0, error: new Error('fixture failure') })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'browser prompt' }],
      source: { kind: 'user', rpcId: 'controller-rpc' as never },
    }), { surfaceOp: 'append' })
    expect(status).toHaveBeenCalledWith(sessionId, true)
    expect(failure).toHaveBeenCalledWith(sessionId, expect.stringContaining('fixture failure'))
    expect(activity).toHaveBeenCalledWith(sessionId, expect.any(Number))
    session.append('request/header', {
      header: { config: { provider: 'fixture', model: 'fixture-model' } },
      reason: 'initial',
    })
    expect(consumeSelection).toHaveBeenCalledWith(
      agent, 'fixture', 'fixture-model', undefined,
    )
    const unowned = ctx.sessions.create(SessionId('controller-unowned'), {
      meta: { cwd: '/workspace' },
    })
    unowned.append('request/header', {
      header: { config: { provider: 'fixture', model: 'other-model' } },
      reason: 'initial',
    })
    expect(consumeSelection).toHaveBeenCalledTimes(1)

    const abort = new AbortController()
    const iterator = controller.follow({
      address: { kind: 'session', sessionId },
    }, abort.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'snapshot', cursor: 2 },
    })
    abort.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('flushes an owned AgentHandle and awaits its durable disposal before Host deletion', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const sessionId = SessionId('controller-dispose')
    const order: string[] = []
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([]),
      inspect: () => Promise.resolve(undefined),
    }) as never)
    const controller = createSessionTestController(ctx, defaults)
    const session = ctx.sessions.prepare(sessionId, { meta: { cwd: '/workspace' } })
    const detachSession = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    const agent = { id: sessionId, session, status: 'idle', ctx } as Agent
    const detachAgent = ctx.agents.register(agent)
    const handle: AgentHandle = {
      agent,
      dispose: () => {
        order.push('dispose')
        detachAgent()
        detachSession()
        return Promise.resolve()
      },
    }
    const agents = (controller as unknown as { agents: ApiSessionAgentController }).agents
    ;(agents as unknown as { handles: Map<SessionId, AgentHandle> }).handles.set(sessionId, handle)
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async () => {
      order.push('flush')
      return true
    })

    await controller.disposeSession(sessionId)

    expect(order).toEqual(['flush', 'dispose'])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    controller.releaseSessionDisposal(sessionId)
    await ctx.fiber.dispose()
  })

  it('allows a transient quiesce failure to be retried', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const sessionId = SessionId('controller-dispose-retry')
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([]),
      inspect: () => Promise.resolve(undefined),
    }) as never)
    const controller = createSessionTestController(ctx, defaults)
    const session = ctx.sessions.prepare(sessionId, { meta: { cwd: '/workspace' } })
    const detachSession = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    const agent = { id: sessionId, session, status: 'idle', ctx } as Agent
    const detachAgent = ctx.agents.register(agent)
    const dispose = vi.fn(() => {
      detachAgent()
      detachSession()
      return Promise.resolve()
    })
    const handle: AgentHandle = {
      agent,
      dispose,
    }
    const agents = (controller as unknown as { agents: ApiSessionAgentController }).agents
    ;(agents as unknown as { handles: Map<SessionId, AgentHandle> }).handles.set(sessionId, handle)
    vi.spyOn(ctx.sessions, 'flush')
      .mockRejectedValueOnce(new Error('temporary flush failure'))
      .mockResolvedValueOnce(true)

    await expect(controller.disposeSession(sessionId)).rejects.toThrow('temporary flush failure')
    const blocked = await controller.resolveAgent(sessionId)
    expect(blocked).toMatchObject({ error: { code: 'session/agent-busy' } })
    if (!('error' in blocked)) throw new Error('expected deletion to block agent resolution')
    expect(blocked.error.message).toContain('being deleted')
    expect(dispose).not.toHaveBeenCalled()
    await expect(controller.disposeSession(sessionId)).resolves.toBeUndefined()
    expect(dispose).toHaveBeenCalledOnce()
    controller.releaseSessionDisposal(sessionId)
    await ctx.fiber.dispose()
  })

  it.each(['resumes', 'creations'] as const)(
    'waits for an admitted %s activation and rejects later publication while deletion is active',
    async (registry) => {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      const sessionId = SessionId(`controller-dispose-${registry}`)
      ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
        list: () => Promise.resolve([]),
        inspect: () => Promise.resolve(undefined),
      }) as never)
      const controller = createSessionTestController(ctx, defaults)
      const agents = (controller as unknown as { agents: ApiSessionAgentController }).agents
      let finishActivation!: (agent: Agent) => void
      const activation = new Promise<Agent>((resolve) => { finishActivation = resolve })
      ;(agents as unknown as Record<typeof registry, Map<SessionId, Promise<Agent>>>)[registry]
        .set(sessionId, activation)

      let settled = false
      const disposal = controller.disposeSession(sessionId).then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      await expect(controller.resolveAgent(sessionId)).resolves.toMatchObject({
        error: { code: 'session/agent-busy' },
      })
      await expect(agents.ensureSession(sessionId, '/workspace', false)).rejects.toThrow('being deleted')

      finishActivation({ id: sessionId } as Agent)
      await disposal
      expect(settled).toBe(true)
      controller.releaseSessionDisposal(sessionId)
      await ctx.fiber.dispose()
    },
  )

  it.each(['success', 'domain-error', 'throw'] as const)(
    'promotes a prepared follow observation in the background: %s',
    async (outcome) => {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      const sessionId = SessionId(`background-${outcome}`)
      const header: SessionHeader = {
        version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: '/workspace', isSeeded: false,
      }
      ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
        list: () => Promise.resolve([header]),
        inspect: () => Promise.resolve({
          meta: header,
          inheritedEventCount: SessionLogOffset(0),
          events: [],
        }),
      }) as never)
      const controller = createSessionTestController(ctx, defaults)
      const agents = (controller as unknown as { agents: ApiSessionAgentController }).agents
      const apiError = vi.fn()
      ctx.on('api-session/error', apiError)
      const logError = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
      const live = { id: sessionId, session: { id: sessionId }, ctx, status: 'idle' } as unknown as Agent
      const resolve = vi.spyOn(agents, 'resolveObservedAgent')
      if (outcome === 'success') resolve.mockResolvedValue({ agent: live })
      else if (outcome === 'domain-error') {
        resolve.mockResolvedValue({
          error: new RemoteError('gateway/internal', 'activation unavailable', {}),
        })
      } else {
        resolve.mockRejectedValue(new Error('activation crashed'))
      }
      const abort = new AbortController()
      const iterator = controller.follow({
        address: { kind: 'session', sessionId },
      }, abort.signal)[Symbol.asyncIterator]()

      await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'snapshot' } })
      const waiting = iterator.next()
      await vi.waitFor(() => { expect(resolve).toHaveBeenCalledOnce() })
      if (outcome === 'domain-error') {
        await vi.waitFor(() => {
          expect(apiError).toHaveBeenCalledWith(sessionId, 'activation unavailable')
        })
      } else if (outcome === 'throw') {
        await vi.waitFor(() => {
          expect(logError).toHaveBeenCalledWith(expect.stringContaining('activation crashed'))
        })
      } else {
        expect(apiError).not.toHaveBeenCalled()
      }
      abort.abort()
      await expect(waiting).resolves.toMatchObject({ done: true })
      await ctx.fiber.dispose()
    },
  )

  it('waits for an admitted background promotion during teardown', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const sessionId = SessionId('background-disposal')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: '/workspace', isSeeded: false,
    }
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect: () => Promise.resolve({
        meta: header,
        inheritedEventCount: SessionLogOffset(0),
        events: [],
      }),
    }) as never)
    const controller = createSessionTestController(ctx, defaults)
    const agents = (controller as unknown as { agents: ApiSessionAgentController }).agents
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(agents, 'resolveObservedAgent').mockImplementation(async () => {
      started.resolve(undefined)
      await release.promise
      return {
        agent: { id: sessionId, session: { id: sessionId }, ctx, status: 'idle' } as unknown as Agent,
      }
    })
    const iterator = controller.follow({
      address: { kind: 'session', sessionId },
    }, new AbortController().signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'snapshot' } })
    const waiting = iterator.next()
    await started.promise
    let disposed = false
    const disposal = ctx.fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    release.resolve(undefined)
    await disposal
    await expect(waiting).resolves.toMatchObject({ done: true })
  })
})
