# Agent Note: Gongchuang bounded PDF preview and explicit update install

Status: implemented

English | [中文](2026-08-23-gongchuang-bounded-pdf-preview-and-explicit-update-install.zh.md)

## Problem

The desktop PDF renderer retained up to 32 complete sets of page PNGs without a byte limit, and the PyMuPDF comparison request temporarily duplicated one set as base64 and JSON. A document with many image-heavy pages could therefore consume memory according to content size rather than a product limit. The Windows updater also left electron-updater's install-on-quit behavior enabled after a download. If the Host failed to close active work before installation, the controller reported a download error while a later ordinary application quit could still install the pending update.

## Decision

The renderer limits one same-source preview to 32 MiB and the in-memory preview cache to 64 MiB and 32 records. It rejects an oversized preview while capturing pages, evicts the oldest retained records before admitting another bounded record, and consumes the matching record when automatic comparison begins. PDF bytes, page count, source-text equality, output digest, and per-page comparison remain mandatory.

The desktop updater disables `autoInstallOnAppQuit`. Download failure clears the pending state; successful download preserves it. A failure in the Host's pre-install shutdown returns a distinct preparation error, does not call `quitAndInstall`, and leaves installation available only through another explicit install action. The compatibility install entrypoint applies the same preparation failure handling. Once shutdown completes, the main-process handoff owns recovery: if electron-updater rejects `quitAndInstall`, the macOS helper fails to start, or either controller returns an installation error, Electron relaunches the unchanged current application before exiting the stopped process.

## Alternatives considered

**Keep only the 32-record count.** Rejected because record count does not bound PNG bytes or base64 serialization memory.

**Write source previews to an unmanaged temporary directory.** Rejected because it adds file lifecycle and cleanup obligations while the current source-preview comparison can stay within a measured in-memory limit.

**Leave install-on-quit enabled as a recovery path.** Rejected because an update must not install during a later unrelated quit after the product reported that installation preparation failed.

## Consequences

Image-heavy HTML that exceeds the preview limit fails before producing a visual-pass receipt and must be reduced or split. A consumed preview cannot be replayed against the same PDF without exporting again. An already downloaded Windows update can be retried without another network download, but installation occurs only after a successful explicit pre-install shutdown and `quitAndInstall` call. A native handoff failure briefly restarts the current version instead of leaving its window connected to a stopped Host runtime. A shutdown operation that rejects is not treated as complete and does not trigger this relaunch path.

## Testing

Desktop tests pin both byte limits and preview consumption, distinguish download and pre-install failures, require `autoInstallOnAppQuit` to remain false, and prove that a failed preparation neither calls `quitAndInstall` nor discards the downloaded retry state. Handoff tests cover controller error snapshots and thrown native failures after shutdown, and reject relaunch when shutdown itself did not complete.
