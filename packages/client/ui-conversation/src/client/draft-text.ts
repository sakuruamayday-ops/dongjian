import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InputHub } from './input/hub.ts'

/** Product-facing access to the ordinary text draft owned by ui-conversation. */
export interface ConversationDraftText {
  /**
   * Read and observe the current text without exposing the editor.
   * @param sessionId - Materialized conversation.
   * @returns Its stable text source.
   */
  source(sessionId: SessionId): ObservableSnapshot<string>
  /**
   * Restore persisted text without overwriting a user's current draft.
   * @param sessionId - Owning conversation.
   * @param text - Text restored only while its draft is empty.
   */
  restoreIfEmpty(sessionId: SessionId, text: string): void
}

/**
 * Expose text draft persistence without leaking the editor or submit machine.
 * The product desktop can mirror this narrow face into native storage while
 * browser-only deployments keep the existing origin-local persistence.
 */
export class ConversationDraftTextController implements ConversationDraftText {
  private readonly sources = new Map<SessionId, ObservableSnapshot<string>>()

  constructor(private readonly input: InputHub) {}

  source(sessionId: SessionId): ObservableSnapshot<string> {
    const existing = this.sources.get(sessionId)
    if (existing !== undefined) return existing
    const state = this.input.shell(sessionId).state
    const source: ObservableSnapshot<string> = {
      getSnapshot: () => state.getSnapshot().draft,
      subscribe: listener => state.subscribe(listener),
    }
    this.sources.set(sessionId, source)
    return source
  }

  restoreIfEmpty(sessionId: SessionId, text: string): void {
    if (text === '') return
    const shell = this.input.shell(sessionId)
    if (shell.snapshot.draft === '') shell.setDraft(text)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional desktop persistence bridge for ordinary composer text. */
    conversationDraftText: ConversationDraftText
  }
}
