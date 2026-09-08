/**
 * The workspace domain declaration: record schema and the `defineDomain` spec
 * the registry opens. The zod schema validates the shipped format at the
 * durability boundary and is the direct source of a future RPC wire projection.
 * @module @deepseek-ai/dsh-workspace/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from './types.ts'

/** Workspace id schema at the durable boundary; branding has no runtime representation. */
const workspaceId = z.string().transform(value => value as WorkspaceId)

/**
 * Durable shape of one workspace record. `path` is the `fs.realpath` canon
 * stamped at create; `sessionIds` is the ordered ownership account (array
 * order is display order); timestamps are ISO-8601 strings.
 */
export const workspaceRecord = z.object({
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(z.string().transform(value => brandString<SessionId>(value))),
  pinnedSessionIds: z.array(z.string().transform(value => brandString<SessionId>(value))).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
}).superRefine((record, ctx) => {
  const sessions = new Set(record.sessionIds)
  const pinned = new Set<SessionId>()
  for (const sessionId of record.pinnedSessionIds) {
    if (!sessions.has(sessionId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['pinnedSessionIds'],
        message: `pinned session '${sessionId}' is not accounted by sessionIds`,
      })
    }
    if (pinned.has(sessionId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['pinnedSessionIds'],
        message: `pinned session '${sessionId}' is duplicated`,
      })
    }
    pinned.add(sessionId)
  }
})

/** One stored workspace record, inferred from {@link workspaceRecord}. */
export type WorkspaceRecord = z.infer<typeof workspaceRecord>

/**
 * Recoverable two-write mutation marker. The marker is persisted before the
 * record/order pair can diverge, so startup can distinguish an interrupted
 * registry operation from unexplained medium corruption.
 */
const workspacePendingMutation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), workspaceId }),
  z.object({ operation: z.literal('delete'), workspaceId }),
])

/**
 * Durable registry state. `initialized` distinguishes a valid empty registry
 * from one that still needs the header-only history bootstrap;
 * `workspaceIds` is the authoritative display order. `archivedWorkspaceIds`
 * hides registrations without discarding them. `archivedSessionIds` is
 * the registry-global archive set layered over workspace accounting: an
 * archived session keeps its `sessionIds` slot (unarchiving must restore the
 * position), so the set never participates in the one-owner accounting
 * invariant. Defaulted so records written before the field parse unchanged.
 */
export const workspaceDomainState = z.object({
  initialized: z.boolean(),
  workspaceIds: z.array(workspaceId),
  archivedWorkspaceIds: z.array(workspaceId).default([]),
  deletedWorkspaceIds: z.array(workspaceId).default([]),
  archivedSessionIds: z.array(z.string().transform(value => brandString<SessionId>(value))).default([]),
  deletedSessionIds: z.array(z.string().transform(value => brandString<SessionId>(value))).default([]),
  pendingMutation: workspacePendingMutation.optional(),
})

/** Durable registry state inferred from {@link workspaceDomainState}. */
export type WorkspaceDomainState = z.infer<typeof workspaceDomainState>

/**
 * The workspace domain spec: one `workspaces` table keyed by
 * {@link WorkspaceId} plus the bootstrap/order singleton. The registry opens
 * this through `ctx.storage.domain`; the spec object is the single source of
 * the domain's identity, version, and schemas.
 */
export const workspaceDomainSpec = defineDomain({
  name: 'workspace',
  version: 2,
  global: {
    schema: workspaceDomainState,
    initial: {
      initialized: false,
      workspaceIds: [],
      archivedWorkspaceIds: [],
      deletedWorkspaceIds: [],
      archivedSessionIds: [],
      deletedSessionIds: [],
    },
  },
  tables: { workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord) },
})
