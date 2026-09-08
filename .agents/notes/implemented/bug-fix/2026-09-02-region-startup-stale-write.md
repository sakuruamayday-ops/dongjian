# Agent Note: Region startup stale-write protection

Status: implemented

English | [中文](2026-09-02-region-startup-stale-write.zh.md)

## Problem

The renderer initially projects `All` before the Host returns the persisted connector region. The selector draft could retain that placeholder after the Host restored a confirmed city. A delayed action from the placeholder could then write `All` back during application-update startup, making user-state retention depend on process timing.

## Decision

The closed selector draft follows the latest Host region, while an explicitly opened selector retains the user's in-progress choice. Every region mutation carries the region and confirmation state from the last Host snapshot visible when the action was composed. The Host treats an already-achieved destination as idempotent, otherwise rejects the mutation when its expected prior state differs from current persisted state.

This comparison belongs in the Host operation that persists the choice. Renderer synchronization reduces stale actions, while Host comparison prevents delayed or alternate callers from committing one.

## Alternatives considered

**Accept the second successful update run as sufficient.** Rejected because the earlier exact-package failure demonstrated a reachable timing-dependent overwrite; another favorable schedule does not remove it.

**Synchronize only the renderer draft.** Rejected because an asynchronous renderer cannot make the durable write atomic with the Host state it observed.

**Serialize all connector reads and UI activity behind startup.** Rejected because ordinary startup and connector discovery do not need a global wait. A state-specific expected-value comparison addresses the conflicting mutation without blocking unrelated work.

## Consequences

Region changes fail visibly when another committed value supersedes the snapshot that produced them, and the user can reopen the selector to retry from current state. First-run and ordinary changes remain immediate when their baseline is current. Component and Host tests pin both request metadata and stale-write refusal; packaged update acceptance verifies the persisted region across update, relaunch, and rollback.

Packaged acceptance observes restored state without writing region or workspace settings. Navigation can render before the workspace-root IPC resolves, so acceptance reads the root and its confirmed state before waiting for the loading dialog to disappear. A deferred component fixture distinguishes that loading interval from a genuinely unconfigured root; a persistent setup requirement still fails acceptance.
