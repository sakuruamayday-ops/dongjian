# Agent Note: Packaged LibreOffice removal

Status: implemented

English | [中文](2026-08-21-packaged-libreoffice-removal.zh.md)

## Problem

The desktop runtime bundled a complete LibreOffice installation for Office-to-PDF conversion and page rendering. The signed Python document runtime already generates and reopens DOCX, XLSX, PPTX, and PDF files directly, while LibreOffice accounted for most of the platform runtime size and extended verification and startup work on every launch. Treating its absence as a fatal delivery error also made formal-file turns retry a visual operation that the Host could not perform.

## Decision

The V0.1.4 desktop runtime contains the signed Python document and OCR dependencies but no packaged LibreOffice tree, executable, font copy, environment variable, or `PATH` entry. Runtime staging, the signed index, startup verification, and packaging preflight expose and verify Python as the only document-runtime executable. The four-format smoke continues to generate and reopen real DOCX, XLSX, PPTX, and PDF files through the pinned Python libraries.

Office page rendering is an optional Host capability rather than an implied property of OOXML generation. When a reviewed renderer is registered, formal delivery still requires its page receipts. When no renderer is registered, the policy injects one limitation notice, continues to require openability, content, branding, professional validation, and final-file publication, and requires the final response to disclose that page-by-page visual acceptance did not run. A missing renderer never becomes a successful visual receipt.

This decision partially supersedes the LibreOffice retention and link-verification portions of [Platform runtime pruning](2026-08-17-platform-runtime-pruning.md). Its Python dependency, cache removal, native-module selection, signed-tree, and four-format generation decisions remain current.

## Alternatives considered

**Keep LibreOffice in every platform package.** Rejected because the Python chain already owns document generation and structural reopening, while the bundled office suite dominates runtime size and startup verification cost. Exact page rendering does not justify imposing that payload on every installation when the product can state the missing visual acceptance honestly.

**Treat successful OOXML generation as page-by-page visual acceptance.** Rejected because archive structure and application-level reopening do not prove pagination, clipping, font substitution, chart layout, or other rendered-page behavior.

**Remove the visual receipt requirement without a disclosure.** Rejected because that would silently weaken a formal-delivery claim. The unavailable capability must remain explicit in the model instruction and final user-facing result.

## Verification

Focused staging and verifier tests reject obsolete multi-executable indexes and accept the exact Python-only signed tree. Packaging-input verification runs the pinned Python dependency and four-format generation smoke for every target. Policy tests prove that a missing renderer causes one limitation notice, retains all actionable receipts, and does not create an unbounded continuation loop. Final package acceptance records runtime file counts, signed index identities, package sizes, and the absence of a LibreOffice executable.

## Consequences

Platform runtimes and installers become substantially smaller, and startup performs no LibreOffice tree verification. The client still generates and reopens the four supported document formats and retains signed skill-script and OCR execution. It does not provide local Office-to-PDF conversion or page rendering by default, so page-by-page visual acceptance remains unverified unless a reviewed Host renderer is added later.
