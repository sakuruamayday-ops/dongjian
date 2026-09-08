# Agent Note: Desktop workspace, delete, and drag corrections

Status: implemented

English | [中文](2026-08-26-desktop-workspace-delete-and-drag.zh.md)

## Problem

The workspace-root picker rejected valid macOS file-provider aliases and collapsed settings, directory, and access failures into one generic message. A deleted conversation stayed visible because product lists filtered archived ids but not deleted ids, while Settings also presented deletion as another recoverable archive. The empty conversation hero hid its normal title bar and therefore left no draggable area across the white desktop surface.

## Decision

Workspace roots resolve to a canonical directory before installation-location and broad-directory checks. The store verifies read and write access before persisting a selection, and product error projection distinguishes settings-write, invalid-directory, and permission failures without exposing local paths.

Archive and delete remain separate actions. Archived workspaces and conversations retain their restore controls and also expose a direct delete action. Deleted workspaces and conversations keep durable tombstones so a stale Host scan cannot reintroduce them, but every product list and the archive page omit them and expose no restore action. This changes client visibility only: enterprise directories, generated files, and session logs are not removed.

The conversation root owns a 44-pixel macOS drag strip for the blank hero. The regular header remains above it for active sessions, and the model controls explicitly remain outside the drag region.

## Alternatives considered

**Treat every selected alias as invalid.** Rejected because file-provider and user-selected macOS folders can legitimately resolve through symbolic links; policies should inspect the canonical target.

**Continue restoring deleted conversations from Archived.** Rejected because it duplicates archive and contradicts the product command selected by the user.

**Make the entire blank page draggable.** Rejected because it would intercept composer, model, and file interactions.

## Consequences

Valid redirected folders work, access failures name the corrective action, delete immediately disappears from workspace and conversation lists without becoming an archive, and the top white strip can move the macOS window. Durable tombstones intentionally remain a storage-level anti-resurrection mechanism rather than a user-facing archive.
