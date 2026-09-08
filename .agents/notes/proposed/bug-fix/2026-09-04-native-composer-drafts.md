# Agent Note: Preserve Desktop Composer Drafts Across Loopback Ports

Status: proposed

English | [中文](2026-09-04-native-composer-drafts.zh.md)

## Problem

A real cold restart changed the desktop loopback port and lost an unsent document card and numbered annotation. The browser stores were keyed by session but still lived under an origin containing the random port. Ordinary text used the same origin-local mechanism, so a reload test did not establish desktop restart continuity.

## Proposal

Keep the random authenticated loopback transport. The desktop stores one mixed text, document-reference, and annotation snapshot per session in its private user-data directory through the existing preload/main IPC pattern and atomic writer. The renderer batches rapid edits, flushes on page exit, validates restored product data, and does not overwrite edits made during hydration. The conversation package exposes only a text observable and empty-only restore operation; the product owns native persistence. File bodies and credentials do not enter this file. Conversation deletion clears its native draft record. Upstream runtime-only image drafts remain outside this change.

## Alternatives considered

**Pin the desktop loopback port.** Port availability is unrelated to draft ownership and would make startup depend on stale local state.

**Store only file references.** Text, images, and annotations would still disappear together after an origin change.

## Acceptance criteria

Storage tests cover a fresh store instance, private permissions, malformed references, size limits, and session cleanup. Client tests cover mixed restoration, in-flight user edits, and cleanup. Native acceptance must enter a synthetic mixed draft, quit, reopen on a different port, and confirm the text, file card, and numbered annotation remain visible. Browser reload or source tests alone are insufficient.

On September 4, the installed ARM App restored all three after the loopback port changed from 63376 to 63748; the restored PPTX opened in WPS. Native storage was mode 0600. A subsequent signed App replacement also retained the draft. Evidence: `native-draft-restart-20260904.json` and `native-selection-final-20260904.json` under the V0.4.4 evidence root. Keychain recovery and complete release acceptance remain separate.

## Risks

Native draft storage contains unsent user content and must remain private, bounded, atomic, and removable with its conversation. Existing candidate evidence must be repeated on the final rebuilt App.
