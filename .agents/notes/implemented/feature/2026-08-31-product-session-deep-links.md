# Agent Note: Product-owned Session deep links

Status: implemented

English | [中文](2026-08-31-product-session-deep-links.zh.md)

## Problem

The product copied `codex://threads/<session-id>` even though the Gongchuang desktop application did not own or register that scheme. The URL exposed another product's identity and could not reliably reopen a Gongchuang conversation from a cold or already-running application.

## Decision

The desktop application owns and registers `gongchuang://threads/<session-id>`. Its parser accepts only that exact host and one bounded local Session identifier, rejects credentials, query strings, fragments, extra path segments, and foreign schemes, and sends the validated identifier to the sandboxed renderer through a fixed IPC channel.

Cold-start arguments, macOS `open-url`, and second-instance arguments share the same parser. Main and preload each hold one pending identifier until their downstream consumer exists. The client opens only a Session present in its local list, restores an archived Session before opening it, and refuses deleted or unknown Sessions.

## Alternatives considered

**Keep the Codex scheme as a compatibility alias.** Rejected because the application never owned that protocol and advertising it would preserve the product-identity leak.

**Copy an HTTP URL.** Rejected because conversations are device-local and the product has no authenticated public conversation route.

**Place an absolute session path in the URL.** Rejected because it would expose local filesystem details and expand the protocol beyond the opaque identifier needed by the application.

## Consequences

Copied links identify Gongchuang and work through packaged desktop protocol registration. They remain local-device references rather than share links: another device or a deleted Session cannot resolve them. Protocol input is validated before it reaches client navigation.
