# Agent Note: Desktop process-local browser session

Status: implemented

English | [中文](2026-08-29-desktop-process-local-browser-session.zh.md)

## Problem

The generic Web application persists its browser-cookie signing secret so an existing browser can reconnect after a Host restart. The Electron desktop shell opens a fresh authenticated loopback URL on every launch, so cross-process cookie reuse provides no desktop workflow benefit. Persisting that transport-only secret through the product credential provider makes Connection activation depend on operating-system credential access. An ad-hoc signed macOS build has a changing code identity, and Keychain authorization for the previous identity can hold profile activation until a person answers the prompt. Account, model, MCP, and connector secrets still require protected persistent storage, but the recoverable loopback-cookie secret does not.

## Decision

`dsh-client-connection` exposes `persistentBrowserSession`, defaulting to `true`. The default preserves the credential-backed secret and cross-restart cookie behavior for Web, CLI, and existing compositions.

When the option is `false`, `BrowserAuth` creates a 32-byte cryptographically random signing secret and retains it in a `WeakMap` owned by the root application context. Connection reloads under the same root retain the launch token and signing secret. A new root receives both a new token and a new secret, rejects cookies from the prior root, and exchanges its fresh token for a new authority-bound cookie. Cookie HMAC verification, absolute expiry, Host and Origin checks, and uniform authentication of the complete Host API are unchanged.

The 共创 Electron product sets `persistentBrowserSession: false`. Connection activation in this composition does not read or modify the browser-session credential record. The credential provider remains mounted and continues to protect user account, model, MCP, and connector references through its existing operating-system backend; this decision does not change their format, lifecycle, or authorization behavior.

This decision partially supersedes the persistent-secret choice in [browser launch-token authentication](2026-08-24-browser-token-authentication.md) for desktop compositions only. That note remains authoritative for the token exchange, cookie semantics, request trust, and default persistent behavior.

## Verification

BrowserAuth tests prove that one root retains a process-local cookie across Connection reloads, a different root rejects it, and the new root can exchange its launch token immediately. Host Connection tests seed an unrelated credential record and prove that process-local activation neither reads, modifies, nor replaces it; the default activation still creates the persistent browser-session record. The product composition test proves that only the desktop overlay selects process-local mode and pins its trusted-host list to the product's loopback-only configuration.

## Alternatives considered

**Keep the signing secret persistent and rely on stable application signing.** A stable distribution identity is the correct long-term way to avoid repeated authorization for user credentials, but it is not available to every local or ad-hoc build. The desktop loopback secret has no persistence requirement that justifies blocking startup on that dependency.

**Load the persistent secret after the profile becomes ready.** Deferring authentication introduces a period in which the frontend URL cannot be exchanged or requires a second readiness state. A process-local secret is ready synchronously and preserves the existing authentication sequence.

**Store the desktop signing secret in plaintext or weaken operating-system credential checks.** This would retain cross-process cookies by weakening secret storage. Process-local rotation gives up only unnecessary desktop cookie reuse and leaves persistent user secrets protected.

**Delete or rotate the stored browser-session record after a credential denial.** Reading or replacing the record still enters the operating-system credential path that can prompt before failure is reported. Avoiding that path for the desktop transport key removes the startup dependency directly.

## Consequences

An Electron process restart invalidates its prior loopback cookie even when the browser retains it until the advertised expiry. The desktop shell immediately replaces it through the new launch-token URL, so no user login or model credential is involved. A stolen desktop cookie also loses authority when the root application context ends.

Web and CLI cookies continue to survive Host restarts by default. Compositions that disable persistence must own a reliable launch-token exchange for every new root; otherwise their browser receives 401 until reopened with the authenticated URL.

Operating-system authorization for actual account, model, MCP, or connector secrets remains possible and must not be bypassed. This decision removes only the transport-key credential operation from the synchronous desktop profile-activation path.
