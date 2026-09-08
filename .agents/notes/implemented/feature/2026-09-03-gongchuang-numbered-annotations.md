# Agent Note: numbered conversation annotations

Status: implemented

English | [中文](2026-09-03-gongchuang-numbered-annotations.zh.md)

## Problem

Inserting selected transcript text as Markdown into the draft makes several quotations hard to address individually. Reordering or deleting quotations can invalidate the user's numbered references, and routing old quoted commands as fresh instructions can restart an unrelated professional task. Document attachments and annotation summaries also need the same content-column geometry as the composer after the upstream dock moved outside the input card.

## Decision

The source row reserves a narrow marker column that stays visible while its reply scrolls, bounded by that reply rather than the entire transcript. When different submissions refer to the same reply with the same number, markers include the submission ordinal. Stored annotation indices and quoted text remain unchanged.

The product supplies Chat's optional selection callback and stores immutable numbered quotations in per-session draft state. The composer shows a count disclosure; each item contains the original quote and an optional user-authored comment. Removal and draft restoration number pending items consecutively from one, with source markers reflecting the same numbers. Empty drafts restart at one. Renumbered objects retain their admission identity so settlement consumes submitted selections without consuming later edits or re-additions. The shared presentational disclosure also renders sent messages, submission echoes, and pending steering. Non-product Chat keeps the [ordinary quote action](2026-08-21-gongchuang-quote-selection-into-composer.md).

The existing prompt-preparation pipeline serializes selections into an ordinary user message and its durable display text. The display projection separates files, annotations, and current prose. Draft state persists under a session-scoped browser key; failed admission retains it and successful admission consumes only the submitted object identities. Later edits and additions survive settlement. Host-confirmed conversation deletion clears both draft stores. No new event type, RPC, release gate, or background task is added.

The Host's intent projection parses only the leading annotation metadata and classifies the current comments and body. It does not treat quotations as current user facts or authorization. The full quote remains visible to the model and reconstructable from the Session log. Provider, permission, signed-skill, artifact, and professional-validation checks remain in their current owners.

Document and annotation draft rails share the composer's maximum width, side-clearance tokens, and wrapping layout. File activation uses the existing system-application bridge; it neither starts a new conversation nor embeds a previewer.

Queue presentation calls the product preparation's optional summary projection on complete display text, before the queue's ordinary preview truncation can cut through metadata. Pending submission echoes use the same projection. Rows with a separate display projection expose no plain-text edit payload: replacing that text alone would discard model context while retaining stale display metadata. Removal and steering are unchanged.

## Alternatives considered

**Keep Markdown quotes in the draft.** It does not provide independently removable numbered items or a compact summary and conflates quotation with the user's new request.

**Preserve gaps after removal.** The user expects a compact sequence and a fresh first number after clearing the draft. Draft numbers follow that expectation; already-sent metadata and user-authored body or comment text remain verbatim rather than guessing which prose contains numbered references.

**Create a new Session event or RPC.** Existing user-message content, display text, and prompt settlement already preserve the required data and lifecycle; a second transport would duplicate them.

**Embed a document preview.** The user explicitly chose system applications for file cards. Preview rendering and a new file-navigation flow are outside this change.

## Verification

Owner tests cover persistence, numbered removal, malformed metadata, failed sends, edits during admission, stale settlement after deletion, file-plus-annotation projection, selection callbacks, focus, and read-only history. The assembled browser exercises native text selection, picker and drop entry points, attachment and annotation geometry, comments, refresh, annotation-only submission, and durable replay. Its OS import/open boundary uses named fixtures; it does not claim to test a packaged installer or the operating system's default applications. Host routing tests retain professional classification for explicit comments and current-body requests while excluding historical quotations.

## Consequences

Quotations add tokens only when sent and remain separately inspectable afterwards. Existing messages containing Markdown quotations are not silently migrated. Draft persistence is device-local and does not provide cross-device synchronization. Metadata is a display and routing convention, not a trust mechanism. Formal installation packages and publication evidence are tracked separately in the product document.
