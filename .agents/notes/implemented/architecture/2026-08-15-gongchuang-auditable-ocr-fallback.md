# Agent Note: Auditable OCR fallback for text-only product models

Status: implemented

English | [中文](2026-08-15-gongchuang-auditable-ocr-fallback.zh.md)

## Problem

DeepSeek's V0.1 route is text-only, while enterprise work routinely arrives as scans, screenshots, long chat captures, and image-only PDFs. Sending those bytes to a text-only model either fails or encourages the model to guess. Installing an arbitrary vision plugin would add a second remote model endpoint, mutable package resolution, and a broad visual interpretation path that is inappropriate for policy numbers, company names, dates, and intellectual-property status.

The initial PaddleOCR connector also launched `uvx --from paddleocr-mcp` on first use. That command resolves package content at runtime through `PATH` and the network, outside the desktop candidate's signed file tree. A plain tall-image upload could exceed service limits, while retrying after a middle chunk failed repeated every completed upload and had no source identity to audit.

## Decision

V0.1 uses the official PaddleOCR MCP in AI Studio mode as the opt-in OCR fallback. It is text extraction only, not general visual understanding: charts, spatial relationships, colors, objects, and status inferred from appearance remain outside the evidence boundary. The connection screen must disclose that enabled image chunks leave the device for Baidu's official service; the product must not call this local inference.

The product runtime embeds the reviewed `paddleocr-mcp` 0.8.5 distribution. Runtime staging and startup require exactly one `paddleocr_mcp/__main__.py` and matching distribution metadata inside the signed Python tree. The connector starts that module with the verified absolute Python executable and fixed `-B -E -s -m paddleocr_mcp` arguments. It never invokes `uvx`, downloads code at first use, or falls back to `PATH`.

Long screenshots are processed locally before upload. Images over the fixed height and aspect-ratio threshold are downsampled only for row-energy analysis, cut near low-content rows within bounded size windows, and cropped at original resolution with a small overlap. Every source and chunk receives SHA-256 identity. Merge removes only an exact normalized line overlap of at most 24 lines; fuzzy matching is deliberately forbidden because a one-character difference may change a policy fact. Up to 64 successful chunk texts are retained in process memory so a retry can resume completed chunks; the cache is cleared when the connector service stops and is never persisted. The durable fallback records the source digest, chunk count, and resumed count beside the capability limitation.

## Testing

Unit tests prove ordinary images preserve their original bytes, tall images yield bounded overlapping PNG chunks with hashes, and exact duplicate boundaries disappear without collapsing near-matching policy facts. Connector tests prove a repeated image reuses the successful chunk text, emits the audit digest, and never exposes credential values. Product-runtime tests prove a missing module or unreviewed distribution version cannot be promoted, the full signed tree verifies, and the connector command is the signed Python path rather than `uvx`. Client tests prove the remote-data disclosure is visible before configuration, consent is required, and a failed Host tool-discovery result cannot present a ready state. Windows and macOS candidate acceptance still requires a real OCR smoke image after installation.

## Alternatives considered

**Adopt the complete third-party vision toolkit as the default.** Rejected for V0.1 because its OCR is remote vision-model inference, not deterministic local OCR, and it introduces another credential, data recipient, model behavior, and plugin supply chain. Its useful engineering ideas—smart cuts, chunk identity, resume, and conservative merging—are adopted behind the product boundary.

**Bundle full local PaddlePaddle inference.** Deferred. It keeps image bytes on-device but substantially increases platform-specific runtime size, cold-start time, model distribution, and Windows/macOS compatibility work. The architecture can add a reviewed local source later without changing the image-description evidence boundary.

**Use fuzzy OCR-line deduplication.** Rejected because policy identifiers, amounts, dates, and enterprise names can differ by one character. A duplicate line may remain, but a fact is never silently deleted on similarity alone.

## Consequences

Text-only models receive explicit OCR evidence instead of guessed vision, and retries cost less without creating a second durable enterprise-data store. Signed installers become larger because the Python runtime must carry the reviewed MCP package and dependencies. OCR still cannot establish non-text visual facts, and AI Studio mode has an external data boundary that the connection UI and privacy documentation must present before authorization.
