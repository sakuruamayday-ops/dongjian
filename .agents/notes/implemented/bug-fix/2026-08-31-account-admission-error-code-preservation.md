# Agent Note: Account admission error code preservation

Status: implemented

English | [中文](2026-08-31-account-admission-error-code-preservation.zh.md)

## Problem

Account admission classified transport, login, upgrade, and device conflicts into stable `GC-ACCOUNT-*` diagnostics, but `requireCurrentDevice()` threw a plain `Error` after classification. The agent loop preserves typed `LlmError` failures and maps other errors to `UNKNOWN`, so one turn displayed both the useful account diagnostic and an unrelated terminal code.

## Decision

Every account-admission rejection that can terminate a model request crosses the agent-loop boundary as an `LlmError`. Network classification retains `GC-ACCOUNT-NETWORK`; login, required upgrade, and device-conflict paths retain dedicated account codes and the product-safe message. Original failures remain attached as causes for Host diagnostics.

The renderer's background account refresh runs immediately on load, when the window becomes visible, and at a sixty-second visible-window interval. Every model request still performs its own current-device verification, so reducing presentation polling does not weaken single-device admission.

## Alternatives considered

**Teach the agent loop to parse account message text.** Rejected because product-specific substring matching would duplicate the structured error taxonomy and remain fragile under copy changes.

**Suppress the terminal `UNKNOWN` in the renderer.** Rejected because the session log and non-renderer consumers would still receive the wrong failure identity.

**Remove per-request verification and rely on polling.** Rejected because renderer polling is a presentation refresh, not the security check that enforces the active device at request time.

## Consequences

One account failure produces one stable code in the turn result and logs while preserving a diagnostic cause chain. Background traffic is lower, and request-time account security remains unchanged.
