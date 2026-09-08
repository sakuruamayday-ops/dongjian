# Agent Note: Gongchuang signed macOS update resume

Status: implemented

English | [中文](2026-08-29-gongchuang-signed-macos-update-resume.zh.md)

## Problem

The self-managed macOS updater downloaded each signed application archive into a random transaction directory. Closing the client during a slow transfer left bytes that a later launch could not identify or reuse, while the settings page displayed only an indeterminate busy label. The localhost release drill completed too quickly to exercise interruption, restart, HTTP range semantics, or useful progress reporting. Replacing the application bundle must also remain independent from account credentials stored under Electron user data and macOS Keychain.

## Decision

An incomplete archive lives under a stable directory derived from the exact signed manifest SHA-256 and the selected artifact URL, architecture, filename, size, and SHA-256. A resumable state file repeats that signed identity and records a strong HTTP `ETag` or valid `Last-Modified` value. A later controller hashes the existing prefix before sending `Range` and `If-Range`, then accepts only the exact `206`, `Content-Range`, `Content-Length`, identity content encoding, response URL, and validator for that prefix. The completed bytes still require the signed total size and SHA-256 before extraction and application verification.

A server without a usable validator may still serve a complete `200` download. That transfer receives the same final size and SHA-256 verification, but an interrupted prefix is not advertised or reused as resumable. A range request answered with a complete `200` retires the old prefix and verifies the complete replacement from byte zero.

The archive writer owns an error listener for its complete open, transfer, backpressure, and finish lifecycle. An asynchronous disk failure therefore rejects the controlled download and preserves only a validator-bound prefix instead of terminating the Electron main process. Runtime shutdown must complete before the install helper starts, and the main process exits only after helper startup succeeds; a shutdown failure cannot leave a helper waiting to commit the update on a later ordinary exit.

The main process projects bounded download progress to the renderer. Settings displays the percentage, estimated remaining minutes, verification phase, and whether bytes came from the previous attempt. An interrupted resumable transfer returns to an available `Continue update` action, and the startup check recovers the same action after a process restart. The client does not resume and install silently on startup: another explicit click preserves the existing user decision before an update may shut down the active runtime.

The update helper replaces only the verified `.app` directory beside the installed application. Electron user data, the encrypted credential store, Keychain material, account token, saved username, saved password, device identity, conversations, and enterprise files are outside that replacement transaction. Normal runtime shutdown closes the credential backend without calling account disconnect or removing saved credentials.

## Verification

The macOS updater suite drives a throttled stream that fails after a prefix, creates a new controller over the same user-data directory, rejects a mismatched `Content-Range`, and then completes from the recorded offset with exact `Range` and `If-Range` headers. It verifies the final signed digest, progress resume offset, and helper handoff. A complete response without a validator remains accepted. Regression cases inject an asynchronous `ENOSPC` write failure and a runtime shutdown failure; both return a controlled error, and the latter proves that no helper starts. A unit test proves that the updater does not delete a credential-store file under Electron user data during download, staging, verification, and helper preparation. It does not exercise `safeStorage` or prove cross-version Keychain access or automatic sign-in; those remain pending for a packaged real-device lifecycle test. Renderer coverage observes the resumed action, live percentage, and remaining-time copy.

## Alternatives considered

**Always start from byte zero.** Rejected because slow or unstable links repeatedly discard hundreds of megabytes even when the signed artifact and server representation have not changed.

**Resume by filename and local length only.** Rejected because the same filename or version label does not prove that the signed manifest, artifact digest, architecture, URL, or server representation is unchanged.

**Automatically resume and install immediately after startup.** Rejected because download completion triggers runtime shutdown and application replacement. Persisting that side effect across a later launch would bypass the explicit update action and could interrupt new work.

**Require a validator for every update.** Rejected because validators are necessary for safe prefix reuse, not for a complete signed download whose final size and SHA-256 are verified. Servers without one retain full-download compatibility.

## Consequences

Interrupted transfers can continue without weakening manifest, archive, runtime, skill, architecture, or application verification. Progress becomes visible and a restarted client exposes a clear continuation action. Prefix hashing adds one local sequential read before a resumed request, and exact HTTP checks may discard a prefix when a server changes or omits the representation validator. Users still confirm continuation once after reopening the client, while saved login material remains outside the application replacement lifecycle.
