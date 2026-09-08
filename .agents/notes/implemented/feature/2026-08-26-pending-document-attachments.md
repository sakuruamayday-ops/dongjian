# Agent Note: Pending document attachments

Status: implemented

English | [中文](2026-08-26-pending-document-attachments.zh.md)

## Problem

Document import originally encoded selected files as visible generated prose. That coupled user-authored text to attachment lifecycle, made a simple removal action depend on text parsing, and gave a card no safe way to open its controlled workspace copy.

## Decision

The product owns per-session pending document state separately from the textarea. Import adds controlled relative references to that state without changing text or sending a task. Each session persists its redacted references under an independent browser-storage key, and a new product runtime restores only bounded controlled-import records. Prompt preparation appends the references only to a real submission, consumes them after success, and retains them after failure. The migration parser removes old generated attachment blocks from restored drafts and recovers their references into the same state.

The conversation shell renders compact cards through `conversation.input.dock` inside the composer, above image attachments and editable text. Each card contains two independent actions. Its body asks the desktop Host to open the imported copy after the Host proves that the relative path resolves to a regular, non-symbolic-link file inside the controlled import directory. Its close control removes only the pending reference from that session. It never deletes, moves, or rewrites a source file, imported copy, enterprise record, or another session's reference. Removal is disabled outside the plain editing phase; image attachments keep their existing browser-owned slot and lifecycle.

Successful submission consumes only the prepared document objects. An import completing later, or a removed and re-added reference, remains in the next draft. Settlement does not recreate a deleted session's browser-storage entry. Mixed drops split supported images from documents: the left composer slot receives the resident composer's image-intake callback and lock, so image limits, previews and visual submission remain upstream-owned. The Host reserves room for collision suffixes within the persisted filename bound, and containment tests distinguish the parent segment `..` from legal dot-prefixed filenames without allowing traversal or symbolic links.

## Alternatives considered

**Keep generated references in visible draft text.** Rejected because presentation, user text, and attachment lifecycle would remain coupled, and normal editing could silently alter file references.

**Open renderer-provided absolute paths.** Rejected because an untrusted renderer must not choose arbitrary local files. The Host derives and validates the path from the active workspace and controlled relative reference.

**Delete the imported copy when closing a card.** Rejected because closing means “do not reference this file in the pending turn,” not file deletion.

**Render document cards above the composer.** Rejected because the cards belong to the pending message, while workflow status and ambient usage readouts remain outside the composer.

## Consequences

The composer stays free of generated attachment prose and duplicate banners. Pending cards survive an application restart or update, while a malformed stored path cannot enter model-facing prompt preparation. Users can open a selected file for confirmation or stop referencing it before sending, while the Host retains path authority. Component, prompt-preparation, desktop import, preload packaging, and window-lifecycle tests cover restoration, the two actions, and their failure behavior.
