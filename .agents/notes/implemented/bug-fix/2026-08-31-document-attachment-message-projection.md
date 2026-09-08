# Agent Note: document attachment message projection

Status: implemented

English | [中文](2026-08-31-document-attachment-message-projection.zh.md)

## Problem

Document intake preserved controlled file references for the model, but the product prompt aggregator replaced the user-facing attachment projection whenever the composer also contained text. The sent and reloaded conversation therefore showed the instruction alone even though the attachment remained part of the request.

## Decision

Document preparation contributes a presentation-only prefix containing ordered controlled import references. The product aggregator combines that prefix with the original composer text while keeping model-facing prompt composition unchanged. Pending submission echoes, queued steering, and durable user messages consume the same persisted display text.

The product provider recognizes only consecutive leading rows in the exact product-import form `@"共创导入资料/<name>"`; the generic Chat renderer consumes that structured projection without learning the product's path convention. Each valid row becomes a compact file button above the original body. The button shows only the basename and delegates activation to the same product provider. The provider reserves the whole controlled import namespace, so malformed paths cannot fall back to the generic workspace opener, and the Electron Host re-resolves the current enterprise workspace before enforcing containment, regular-file, and symbolic-link checks in `openImportedDocument`. Inline references, another directory, nested paths, traversal segments, control characters, and invalid file-name characters remain ordinary text and never become file-open controls. A file-only message has no empty text bubble, and copy actions receive only the original body.

## Alternatives considered

**Show the complete model-facing prompt.** Rejected because it would expose product-generated context and deep-clarification wrappers in the user's message.

**Infer attachments from arbitrary references in sent text.** Rejected because ordinary user references are not proof that a path came from the controlled importer and must not acquire an open-file action.

**Add a new durable attachment schema.** Deferred because the current durable `displayText` already crosses local echo, queue, steering, and reload without a wire-format change. A structured field becomes justified only if a later consumer needs stable attachment identity beyond this controlled presentation.

## Consequences

New text-plus-document messages keep every imported file visible above the instruction before and after durable admission, including multiple files in import order. Clicking uses the existing file-open error handling, copying excludes file references, and malformed references stay inert. Messages created by older clients whose durable display text omitted attachment references cannot be reconstructed by this projection and retain their historical appearance.
