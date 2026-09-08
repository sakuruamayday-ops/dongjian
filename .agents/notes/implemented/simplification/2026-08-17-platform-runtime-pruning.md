# Agent Note: Platform runtime pruning

Status: implemented

English | [中文](2026-08-17-platform-runtime-pruning.zh.md)

The LibreOffice retention and link-verification parts are superseded by [Packaged LibreOffice removal](2026-08-21-packaged-libreoffice-removal.md); the Python and target-native pruning decisions remain current.

## Problem

The desktop package copied Python build caches, native modules for platforms other than the package target, and a macOS LibreOffice directory symlink as a second physical directory. Those copies increased installer size without adding runtime capability. Removing Python or LibreOffice entirely would also remove skill-script execution or local Office conversion and rendering.

## Decision

Desktop packaging excludes native module variants that cannot load on the selected platform and architecture. Runtime staging omits Python `__pycache__`, `.pyc`, and `.pyo` files.

The macOS stager preserves relative LibreOffice links whose resolved targets remain inside the staged runtime. Runtime index schema version 2 signs separate exact maps for regular-file digests and link targets. Startup verification rejects missing, extra, changed, absolute, self-referential, broken, or escaping links before exposing the Python and LibreOffice executables. Windows staging continues to materialize source links because Windows installation environments do not provide one reliable symlink contract.

The Python overlay pins one closed wheel set for each supported installer target. It retains the reviewed DOCX, XLSX, PPTX, and PDF libraries, including `python-pptx` and its required Pillow and XlsxWriter dependencies. The wheel-provided licenses for those three distributions remain inside their `.dist-info` directories and the signed runtime index; preparation, staging, and startup verification reject a missing license file. Staging and startup verification also require the exact module and distribution identities. Packaging preflight then uses the signed Python executable to generate and reopen all four document formats; the PPTX smoke includes an image, a chart, and its embedded workbook so it exercises the complete `python-pptx` dependency path.

## Alternatives considered

**Remove LibreOffice and Python from the client.** This saves more space but breaks direct DOCX generation workflows, Office-to-PDF conversion, rendered document checks, skill scripts, and the reviewed PaddleOCR connector.

**Keep every dependency copy.** This minimizes packaging logic but ships redundant data, including a physical copy of the LibreOffice `Frameworks` tree under `Contents/MacOS/urelibs`.

**Delete selected runtime files after signing.** This reduces size without changing staging but invalidates the signed file set and makes dependency pruning an unauditable list of paths.

## Consequences

The staged macOS arm64 runtime retains Python, LibreOffice, and PaddleOCR MCP while decreasing from about 2.1 GB to 1.5 GB in the V0.1 candidate. Python source caches are absent from both platform candidates, and each packaged native dependency set contains only the target variants declared by Electron Builder. Electron Builder smart-unpacks native packages as a unit, so the Windows x64 after-pack step moves the unused ARM64 ConPTY helper into an auditable quarantine beside the output while retaining the reviewed win32-x64 prebuild.

The runtime index format is intentionally incompatible with schema version 1. Every runtime candidate must be restaged and signed before packaging. Focused staging and verifier tests cover internal links, link drift, file drift, platform identity, cache omission, and runtime capability identity. Packaging input verification additionally rejects a signed runtime that cannot generate and reopen DOCX, XLSX, PPTX, or PDF artifacts.
