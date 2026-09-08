# Agent Note: Tianyancha Device Flow keeps OAuth tokens in the Host

Status: implemented

English | [中文](2026-08-26-tianyancha-device-authorization.zh.md)

## Problem

The product's Tianyancha connector accepted only a manually pasted `TYC_API_TOKEN`, while Tianyancha's current AI entry point directs agent clients to its OAuth Device Flow, official CLI, and scenario skills. The public page still offers free access, but calls consume an account quota shared by MCP and CLI. Removing the connector would discard a working source; keeping key-only setup would leave new users on a legacy path and tempt the renderer to own renewable tokens.

## Decision

`@gongchuang/connectors` owns Tianyancha authentication. It verifies the fixed protected-resource and authorization-server metadata, dynamically registers a native client, starts Device Flow, and exposes only the official authorization URL, user code, and opaque transaction id through the generated Remote. Token exchange occurs only after explicit user confirmation.

Access and refresh tokens plus dynamic-client metadata remain in the operating-system credential service. The Host refreshes an access token within one minute of expiry, restores every prior credential on a failed refresh or connection verification, and reports readiness only after the official MCP returns at least one tool. A manually pasted key remains a fallback and removes stale OAuth refresh state. Quota exhaustion and invalid authentication have separate product error codes.

The product consumes Tianyancha's official MCP directly. It does not vendor the official CLI or copy the separate scenario-skill repository into the signed product skill suite.

Token exchange and refresh stay bound to the supported fixed official Token endpoint. Discovery rejects a different advertised Token address before registration instead of accepting it and later ignoring it. This keeps the existing endpoint boundary; it does not add arbitrary endpoint routing or claim that the live service has changed addresses.

Client authorization waits for earlier configuration writes but does not occupy the shared connector mutation queue while a person approves in the browser. Cancel, Escape, closing the dialog and leaving the page terminate the exact local Host transaction, including registration, callback waiting, polling, exchange and credential verification. The transaction id is known before discovery starts. Cancellation waits for owned work to quiesce and preserves previous credentials; partial rollback reports an actionable error and disables only that connector. Late responses cannot overwrite a newer attempt. A short pending device poll remains explicitly retryable, as does a lost cancellation acknowledgement. Unrelated connector and region settings remain usable. Older Host revisions cannot rewind newer settings.

## Alternatives considered

**Remove Tianyancha.** Rejected because the official AI page and an authenticated account still expose free quota. The accurate limitation is quota-bound access, not absence of free access.

**Keep API-key-only setup.** Rejected because it no longer matches the preferred official agent flow and cannot provide renewable access without manual replacement.

**Store OAuth material in renderer state or browser storage.** Rejected because access tokens, refresh tokens, and dynamic-client secrets must not cross the Remote into a browser-controlled persistence surface.

**Bundle `tyc-cli` and Tianyancha's scenario skills.** Rejected because the current consumer needs the remote MCP, while bundling duplicates an independently updated product and expands the signed runtime without a current use case.

## Verification

Coordinator tests cover official metadata discovery, dynamic registration, Device Flow, abandoned-flow replacement, token exchange, refresh, and endpoint mismatch rejection. Host integration tests cover Bearer connection, operating-system credential writes, manual-key migration, `tools/list`, quota diagnosis, and refresh rollback. Client tests prove that opening the official page does not exchange tokens until the user explicitly confirms. Deterministic cancellation barriers cover registration, callback waiting, late token responses and paused credential writes, including partial restoration failures. Controller and dialog tests cover explicit retry, lost cancellation acknowledgement, unrelated writes, Escape and late settlement without disturbing a later dialog.

## Consequences

Tianyancha login now follows its maintained official path while renewable secrets remain Host-owned. Users can still paste a key when needed. The connector depends on Tianyancha's authorization service and account quota, and a completed browser login remains a user action. Starting authorization again replaces the prior unfinished Host transaction, so closing the dialog does not create a local lockout; Tianyancha may still retain abandoned dynamic-client registrations under its own lifecycle policy.
