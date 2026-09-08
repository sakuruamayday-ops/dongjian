/** Durable main-process intent for completing an interrupted conversation Trash operation. */

import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export interface PendingConversationTrash {
  readonly sessionId: string
  readonly artifactDirectory: string
}

export interface PendingWorkspaceTrash {
  readonly workspaceId: string
  readonly workspaceDirectory: string
  readonly sessionIds: readonly string[]
  readonly sessionDirectories: readonly string[]
}

interface EnterpriseTrashJournalDocument {
  readonly schemaVersion: 1
  readonly conversations: readonly PendingConversationTrash[]
  readonly workspaces: readonly PendingWorkspaceTrash[]
}

const EMPTY_JOURNAL: EnterpriseTrashJournalDocument = Object.freeze({
  schemaVersion: 1,
  conversations: Object.freeze([]),
  workspaces: Object.freeze([]),
})

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) {
    throw new Error(`${label}标识无效`)
  }
  return value
}

function absoluteDirectory(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label}目标无效`)
  return value
}

function entry(value: unknown): PendingConversationTrash {
  if (typeof value !== 'object' || value === null) throw new Error('企业删除事务记录格式无效')
  const candidate = value as Partial<PendingConversationTrash>
  return Object.freeze({
    sessionId: opaqueId(candidate.sessionId, '企业删除事务会话'),
    artifactDirectory: absoluteDirectory(candidate.artifactDirectory, '企业删除事务'),
  })
}

function workspaceEntry(value: unknown): PendingWorkspaceTrash {
  if (typeof value !== 'object' || value === null) throw new Error('企业删除事务记录格式无效')
  const candidate = value as Partial<PendingWorkspaceTrash>
  if (!Array.isArray(candidate.sessionIds) || !Array.isArray(candidate.sessionDirectories)
    || candidate.sessionIds.length !== candidate.sessionDirectories.length) {
    throw new Error('企业删除事务会话目标无效')
  }
  const sessionIds = candidate.sessionIds.map(value => opaqueId(value, '企业删除事务会话'))
  const sessionDirectories = candidate.sessionDirectories
    .map(value => absoluteDirectory(value, '企业删除事务会话'))
  if (new Set(sessionIds).size !== sessionIds.length || new Set(sessionDirectories).size !== sessionDirectories.length) {
    throw new Error('企业删除事务会话目标重复')
  }
  return Object.freeze({
    workspaceId: opaqueId(candidate.workspaceId, '企业删除事务空间'),
    workspaceDirectory: absoluteDirectory(candidate.workspaceDirectory, '企业删除事务空间'),
    sessionIds: Object.freeze(sessionIds),
    sessionDirectories: Object.freeze(sessionDirectories),
  })
}

/** Atomically stores Host-resolved deletion intent without accepting renderer paths. */
export class EnterpriseTrashJournal {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly filename: string) {}

  list(): Promise<readonly PendingConversationTrash[]> {
    return this.enqueue(async () => (await this.read()).conversations)
  }

  listWorkspaces(): Promise<readonly PendingWorkspaceTrash[]> {
    return this.enqueue(async () => (await this.read()).workspaces)
  }

  begin(sessionId: string, artifactDirectory: string): Promise<void> {
    return this.enqueue(async () => {
      const next = entry({ sessionId, artifactDirectory })
      const document = await this.read()
      const current = document.conversations.find(candidate => candidate.sessionId === sessionId)
      if (current !== undefined && current.artifactDirectory !== artifactDirectory) {
        throw new Error('同一会话已有不同的删除事务目标')
      }
      if (current !== undefined) return
      await this.write([...document.conversations, next], document.workspaces)
    })
  }

  complete(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const document = await this.read()
      const conversations = document.conversations.filter(candidate => candidate.sessionId !== sessionId)
      if (conversations.length === document.conversations.length) return
      await this.write(conversations, document.workspaces)
    })
  }

  beginWorkspace(value: PendingWorkspaceTrash): Promise<void> {
    return this.enqueue(async () => {
      const next = workspaceEntry(value)
      const document = await this.read()
      const current = document.workspaces.find(candidate => candidate.workspaceId === next.workspaceId)
      if (current !== undefined && JSON.stringify(current) !== JSON.stringify(next)) {
        throw new Error('同一企业空间已有不同的删除事务目标')
      }
      if (current !== undefined) return
      await this.write(document.conversations, [...document.workspaces, next])
    })
  }

  completeWorkspace(workspaceId: string): Promise<void> {
    return this.enqueue(async () => {
      const document = await this.read()
      const workspaces = document.workspaces.filter(candidate => candidate.workspaceId !== workspaceId)
      if (workspaces.length === document.workspaces.length) return
      await this.write(document.conversations, workspaces)
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private async read(): Promise<EnterpriseTrashJournalDocument> {
    let raw: string
    try {
      raw = await readFile(this.filename, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_JOURNAL
      throw error
    }
    const parsed = JSON.parse(raw) as Partial<EnterpriseTrashJournalDocument>
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.conversations)
      || (parsed.workspaces !== undefined && !Array.isArray(parsed.workspaces))) {
      throw new Error('企业删除事务记录格式无效')
    }
    const conversations = parsed.conversations.map(entry)
    const workspaces = (parsed.workspaces ?? []).map(workspaceEntry)
    if (new Set(conversations.map(candidate => candidate.sessionId)).size !== conversations.length) {
      throw new Error('企业删除事务记录包含重复会话')
    }
    if (new Set(workspaces.map(candidate => candidate.workspaceId)).size !== workspaces.length) {
      throw new Error('企业删除事务记录包含重复空间')
    }
    return Object.freeze({
      schemaVersion: 1,
      conversations: Object.freeze(conversations),
      workspaces: Object.freeze(workspaces),
    })
  }

  private write(
    conversations: readonly PendingConversationTrash[],
    workspaces: readonly PendingWorkspaceTrash[],
  ): Promise<void> {
    return writeFileAtomic(this.filename, `${JSON.stringify({ schemaVersion: 1, conversations, workspaces })}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }
}
