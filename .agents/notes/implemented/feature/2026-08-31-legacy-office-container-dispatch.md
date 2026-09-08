# Agent Note: Legacy Office container dispatch

Status: implemented

English | [中文](2026-08-31-legacy-office-container-dispatch.zh.md)

## Problem

The signed workspace-document operation could read DOCX, XLS, and XLSX but not Word 97-2003 DOC. Treating `.doc` or `.wps` as a format was unsafe because Word and Excel both use the OLE compound-file container, while WPS extensions may name OOXML, RTF, Microsoft-compatible OLE, proprietary, damaged, or encrypted content. Parsing untrusted OLE directly in the Electron main process would also move document-parser risk into the desktop trust boundary.

## Decision

The V1 signed-operation schema remains unchanged. The verified Python document detector runs first inside the existing no-network read-only sandbox. Only its exact structured result for `detected_kind: doc`, a `.doc` or `.wps` declared suffix, and `conversion_required` may select the Host-owned legacy Word adapter. Renamed Excel, unknown OLE, encrypted Office, OOXML, and RTF stay on the Python path.

The V1 schema stays stable while one file parameter's extension allow-list capacity increases from 16 to 32. This accommodates the existing Office and template families, including `.dotm`, `.xltx`, and `.xltm`; it does not make an extension a format assertion or bypass content detection.

The adapter launches `word-extractor` 1.0.4 in a second fixed Node/Electron subprocess under the same sandbox, timeout, cancellation, output, workspace, and signed-script receipt. The model controls neither source code, module path, environment, nor argv shape. `ELECTRON_RUN_AS_NODE=1` makes the same launch portable to packaged Electron. Parser dependency failure is a Host error; unsupported legacy Word content returns a non-retrying conversion result.

The worker uses the Python extraction schema, does not invent a suffix field, does not execute macros, formulas, or links, and limits document text to 400,000 UTF-8 bytes. This leaves material headroom below the signed one-megabyte process cap after JSON escaping and receipt metadata.

## Alternatives considered

**Bundle LibreOffice or automate installed Office.** Rejected because the runtime and cache cost is hundreds of megabytes, installation is not reliable on every host, GUI or COM automation is platform-specific, and both expand the trusted execution surface.

**Dispatch from extension plus the OLE magic bytes.** Rejected because a renamed XLS has the same header and would be removed from the existing Excel extractor.

**Load the parser in Electron main.** Rejected because malformed customer documents must remain outside the desktop Host process.

## Consequences

Real Word 97-2003 files can be read without Word, LibreOffice, network access, or a native add-on. An actual Word-compatible OLE file named `.wps` can use the same path, while proprietary WPS binaries receive a clear conversion outcome. The feature does not promise universal recovery of encrypted, damaged, or vendor-private formats.

Regression coverage runs a non-sensitive real DOC fixture in a child process, proves a real Excel OLE fixture renamed to `.wps` cannot enter the Word worker, checks the two subprocesses share the signed read-only receipt, and exercises a worst-case escaped output below the one-megabyte cap.
