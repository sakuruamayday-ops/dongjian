/** Incremental references from durable user messages and pending annotation drafts. */
import type { SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ChatAnnotationMarker } from '@deepseek-ai/dsh-client-ui-chat/client'
import { projectAnnotatedUserMessage, type ConversationAnnotationDraftState } from './annotation-drafts.ts'

const EMPTY: readonly ChatAnnotationMarker[] = Object.freeze([])

/** Per-conversation source index, reconstructed from display metadata rather than persisted twice. */
export class AnnotationMarkers {
  private readonly history = new Map<number, readonly ChatAnnotationMarker[]>()
  private readonly sources = new Map<string, SnapshotStore<readonly ChatAnnotationMarker[]>>()
  private readonly disposeEvents: () => void
  private readonly disposeDrafts: () => void
  private revision = -1

  constructor(private readonly events: SessionEventSource, private readonly drafts: ObservableSnapshot<ConversationAnnotationDraftState>) {
    this.readEvents()
    this.disposeEvents = events.subscribe(() => { if (this.readEvents()) this.publish() })
    this.disposeDrafts = drafts.subscribe(() => { this.publish() })
  }

  /**
   * Resolve the stable observable owned by one source message.
   * @param nodeKey - Source message identity.
   * @returns Stable reference observable for its renderer.
   */
  source(nodeKey: string): ObservableSnapshot<readonly ChatAnnotationMarker[]> {
    let source = this.sources.get(nodeKey)
    if (source === undefined) {
      source = createSnapshotStore(this.forNode(nodeKey))
      this.sources.set(nodeKey, source)
    }
    return source
  }

  /** Release subscriptions with the product or owning conversation. */
  dispose(): void { this.disposeEvents(); this.disposeDrafts() }

  private readEvents(): boolean {
    const window = this.events.getSnapshot()
    if (window.revision === this.revision) return false
    const replace = this.revision + 1 !== window.revision || window.change.kind === 'replace'
    let changed = replace && this.history.size > 0
    if (replace) this.history.clear()
    this.revision = window.revision
    const entries = replace
      ? window.entries
      : window.change.kind === 'append' || window.change.kind === 'prepend'
        ? window.change.entries
        : []
    for (const { event } of entries) {
      if (event.type !== 'user/message') continue
      const source = event.data.source as { kind?: string; displayText?: string } | undefined
      if (source?.kind !== 'user' || source.displayText === undefined) continue
      const annotations = projectAnnotatedUserMessage(source.displayText).annotations
      if (annotations === undefined) continue
      this.history.set(event.seq, annotations.map(annotation => ({
        ...annotation, id: `message:${String(event.seq)}:${String(annotation.index)}`,
      })))
      changed = true
    }
    return changed
  }

  private forNode(nodeKey: string): readonly ChatAnnotationMarker[] {
    const annotations = [...this.history.entries()].sort(([a], [b]) => a - b).flatMap(([, values]) => values)
    annotations.push(...this.drafts.getSnapshot().annotations.map(annotation => ({
      ...annotation, id: `draft:${String(annotation.index)}`,
    })))
    const matched = annotations.filter(annotation => annotation.source.nodeKey === nodeKey)
    if (matched.length === 0) return EMPTY
    const submissions = [...new Set(matched.map(annotation => annotation.id.replace(/:[^:]+$/u, '')))]
    return matched.map(annotation => matched.some(other => other.id !== annotation.id && other.index === annotation.index)
      ? { ...annotation, round: submissions.indexOf(annotation.id.replace(/:[^:]+$/u, '')) + 1 }
      : annotation)
  }

  private publish(): void {
    for (const [key, source] of this.sources) source.set(this.forNode(key))
  }
}
