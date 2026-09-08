---
description: "Trusted MCP connector manager for the Gongchuang desktop client."
kind: "package-reference"
---

# @gongchuang/connectors

English | [中文](README.zh.md)

## Summary

Workspace PDF OCR accepts an optional one-based `pages` list from the signed reader's `ocr_pages`. The verified bundled PyMuPDF selects those pages in memory, without model-written splitting scripts or temporary files; the result identifies the original page numbers and cache entries are page-list-specific. File publication accepts absolute paths or paths relative to the active Session workspace, never the desktop process working directory. Its tool description identifies local file cards separately from uploads, software releases and skill releases; it does not perform those external actions.

Private trusted connector manager for 共创企业助手. It exposes a generated Remote status/configuration API and mounts only fixed, reviewed integrations: official QCC Streamable HTTP MCP endpoints, official Tianyancha Streamable HTTP MCP, official PaddleOCR MCP, and the built-in 共创 evidence-search wrapper.

## Table of Contents

- [Behavior](#behavior)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Behavior

Secrets are credential references. Their values are resolved by the host for a connection or request and are never returned to the browser.

Failure to describe a stored credential publishes a retryable error on that connector, retains its saved enablement and credential metadata, and does not prevent the other connectors from reconciling. Refresh can recover the same reference after operating-system access is restored; it does not require a new API key.

Startup reconciliation runs after the connector service mounts. Independent connector definitions are reconciled concurrently, and QCC's ten fixed service endpoints perform connection and tool discovery concurrently before their results are folded back in deterministic order. A slow or temporarily unavailable credential store affects only the matching connector card and cannot block the desktop window, ordinary conversations, or connectors that do not need that credential. Explicit configuration and refresh still await a real credential result. All executable connector dependencies ship in the signed runtime; first use never installs them into a user cache.

The manager consumes the MCP supervisor's credential-free connection lifecycle. A transport loss immediately projects as reconnecting or unavailable instead of retaining a stale ready state; successful discovery restores readiness, while an exhausted retry budget requires the user's explicit refresh. For QCC's multi-service aggregate, surviving services remain available and the failed subset is shown as partial rather than all-green.

QCC uses the official OAuth flow by default. The Host dynamically registers a local client, uses PKCE and a short-lived loopback listener bound only to `127.0.0.1`, and stores access tokens, refresh tokens, and expiry metadata in the system credential store. The Host refreshes an expiring access token automatically. Pasting an official API key remains a fallback and clears stale OAuth refresh state so the two credential sources cannot overwrite each other. Either path becomes ready only after the official MCP `tools/list` returns at least one tool.

Tianyancha uses its official OAuth Device Flow by default. The Host verifies the fixed protected-resource and authorization-server metadata, dynamically registers a native client, and returns only the official authorization URL, user code, and an opaque transaction id to the renderer. Access and refresh tokens plus dynamic-client metadata stay in the system credential store; the Host refreshes expiring access and verifies `tools/list` before reporting readiness. Pasting a key from `My Key` remains a fallback and clears stale OAuth state. Tianyancha MCP and CLI calls share the account quota; quota exhaustion is reported separately from invalid authentication.

The connector manager also owns the user-confirmed four-city search scope. Hangzhou, Shaoxing, Jinhua, or Ningbo is sent to the knowledge service through `X-Jiaotang-Region`; `Default (all)` does not narrow by city. City- and county-level content narrows to the current city, while Zhejiang provincial and national projects and notices remain shared across all four cities. List queries still narrow to the current city so provincial or national enterprise rosters are not mistaken for local rosters. Changing the city remounts only the knowledge connector, and an explicit geography in the task overrides this default. A change carries the last Host region shown to the renderer; the Host rejects a stale mutation so a delayed startup action cannot replace a region restored from disk.

## Dev Note

Connector secrets remain credential references, and readiness is published only after the Host validates credentials and discovers tools from the official endpoint.

## Runtime Invariant

No runtime invariant companion is published because connector discovery and calls are request-scoped Host operations with no durable event relation owned by this package.

## Model Experience

### Ready connector tool set

#### What the model sees

Ready connectors register server-qualified tools under `mcp__*`. Disabled, unconfigured, or failed connectors contribute no model-visible tool schema.

#### Token effect

Each ready connector adds its MCP tool schemas and adds result tokens only when the model calls those tools. Disabled or failed connectors add zero tokens.

#### KV Cache effect

An unchanged ready-tool set preserves the repeated system-prompt prefix. Enabling, disabling, reconnecting, or changing an upstream tool list rebuilds that contribution and may invalidate provider reuse after the changed prefix.

### OCR fallback for text-only model routes

#### What the model sees

For each resolved image, the model receives the PaddleOCR text under `图片 OCR 文字识别结果`, followed by a fixed capability limitation and an audit line containing the source-image SHA-256, chunk count, and resumed-chunk count; unresolved images reject the request before model dispatch. Images taller than 3,400 pixels with a portrait ratio of at least 2.6 are split locally before upload. The splitter prefers low visual-energy rows, keeps bounded overlap, and removes only exactly repeated OCR boundary lines; it never fuzzy-merges policy numbers, names, or dates. Each chunk has a deterministic SHA-256, and up to 64 successful chunk texts are retained only in process memory so an interrupted long screenshot can resume without a second persistent cache. PaddleOCR stays disabled until the user explicitly configures AI Studio. Each mount first validates the credential against Baidu AI Studio's official API, then starts the signed, pinned PaddleOCR MCP runtime and executes `tools/list`; credentials are committed and readiness is shown only after both checks pass. Startup validation creates no OCR job, uploads no probe image, and consumes no recognition task; real OCR is covered by a separate functional acceptance test. When enabled in V0.1, user-selected image chunks leave the device for Baidu's official service and this is not local inference.

#### Token effect

OCR text and the limitation add data-dependent user-message tokens, capped by the Host at 120,000 characters per image result.

#### KV Cache effect

The fallback replaces image bytes with text in the pending user-message suffix. Earlier session history remains stable; a different OCR result changes only that suffix.

## Known Limitations and Deferred Work

- Tianyancha connects to the current official `https://mcp.tianyancha.com/mcp` endpoint. The small public tool surface handles entity anchoring and capability discovery; deeper business dimensions remain available through the server's capability catalog and proxy tools without registering 162 tools into every model turn.
- Tianyancha Device Flow still requires the user to complete login and consent on the official page. Free access is quota-limited by the Tianyancha account and is not an unlimited product entitlement. The client consumes the official MCP instead of copying Tianyancha's separate scenario-skill repository into the bundled skill suite.
- PaddleOCR V0.1 runs the reviewed `paddleocr-mcp` 0.8.5 module through the exact Python executable in the signed product runtime. The command line pins `aistudio` as the inference source, so this path does not import `paddlepaddle`, load a local model, or silently fall back to the upstream local engine. It never resolves `uvx`, downloads a package at first use, or falls back to `PATH`; the desktop release gate must verify the embedded module, distribution metadata, Python tree, cloud-mode `tools/list`, and a real OCR result on both platforms.
- QCC browser authorization still requires the user to complete the official login and consent in the system browser. The client neither fills account credentials nor embeds the authorization page in its renderer.
