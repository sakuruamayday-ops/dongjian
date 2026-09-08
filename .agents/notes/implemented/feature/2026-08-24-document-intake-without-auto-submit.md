# Agent Note: document intake without auto-submit

Status: implemented

English | [中文](2026-08-24-document-intake-without-auto-submit.zh.md)

## Problem

Desktop drag-and-drop accepted only images, choosing a file started work before the user finished the prompt, and the native picker reopened at its default location. This made document intake inconsistent with a conversational draft.

## Decision

The desktop Host accepts regular files from the picker or drag-and-drop, rejects directories and symbolic links, and copies accepted files into the current enterprise workspace. Import success stores workspace-relative paths in product-owned, per-session attachment state and never invokes send or mutates the editable textarea. The visible card is the complete success indication; no duplicate banner or generated draft prose is added. Pending documents make the send action available even when the composer text is empty. Prompt preparation appends controlled references only to the model-facing text of a real submitted task. The current durable presentation is owned by the [document attachment message projection](../bug-fix/2026-08-31-document-attachment-message-projection.md): every imported document remains visible above the original composer text after submission and reload. Queued items, steering, reloaded history, copy actions, and chat bubbles never expose the generated model context. Failed sends retain attachments and successful sends consume them. Old product-generated draft blocks migrate into the same state, and already-sent legacy attachment suffixes are removed only from presentation. A pure drop of supported images keeps the image-attachment path; mixed or non-image drops use document intake.

The picker remembers the parent directory of the last successful selection. Intake is bounded to 20 files and 128 MiB per file, and shortened long names preserve their extension. Sandboxed renderers obtain native paths only through Electron `webUtils.getPathForFile` in the preload bridge.

## Alternatives considered

**Send immediately after import.** Rejected because file selection is only one part of the user's message and must not commit an incomplete task.

**Treat every file as an image attachment.** Rejected because arbitrary documents need a stable workspace path and should not inherit image-model requirements.

**Scan folders recursively.** Rejected because it expands scope and data exposure; directory intake is not a current requirement.

## Consequences

Users can finish instructions in an unmodified textarea after adding files or send only the attached files. The durable chat projection keeps compact file labels above any original instruction after submission and reload. Model-facing file references remain logged and imported paths remain auditable inside the enterprise workspace. The picker resumes from the prior location, and removing a card changes only the pending turn reference. Packaged-client acceptance still verifies real drag events, picker directory restoration, attachment-only send, model/display separation, legacy-draft and history presentation migration, and absence of an automatic send.
