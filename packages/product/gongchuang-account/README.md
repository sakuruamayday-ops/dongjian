---
description: "Device-bound account and personalization service for the Gongchuang desktop client."
kind: "package-reference"
---

# @gongchuang/account

English | [中文](README.zh.md)

## Summary

Host-owned username/password login for 共创企业助手 V0.1. The renderer submits the fields through a private Remote method; the Host calls the HTTPS `/v1/client-login` endpoint with a stable random device identifier and verifies the returned token against `/v1/me` before publishing `connected`.

## Table of Contents

- [Behavior](#behavior)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Behavior

The username, optional saved password, token, device identifier, and automatic-login block are stored only through the OS credential service. Passwords and tokens never enter client-safe snapshots. When “remember password” is enabled, startup can reuse the saved credentials without sending the password to the renderer. A login that the server authenticates but marks `upgrade-required` commits the same verified account material before publishing the blocking compatibility state, so the updated application can resume without another password prompt. The server permits one active device per account: a new device login revokes the preceding token, and a superseded client blocks automatic reclaim until the user explicitly logs in again. Explicit sign-out clears the saved username, password, and token while preserving the stable device identity.

Host activation does not wait for credential reads or server verification. It publishes `checking`, starts refresh in the serialized account operation queue, and lets the Web service and first window start. The account client explicitly calls `refresh` on its initial load; the serialized queue therefore waits for the in-flight Host recovery and returns a settled state instead of pinning the UI to the transient `checking` snapshot. A rejected credential read becomes a redacted `offline` snapshot on every refresh entry point, including an explicit retry. The last known account metadata and operating-system credentials remain intact; recovery revalidates the saved token without requiring password entry.

Account admission errors that terminate a model request remain structured `LlmError` failures across the agent loop. Network, login, upgrade, device-conflict, and credential-read paths therefore retain their `GC-ACCOUNT-*` code instead of becoming `UNKNOWN`, while the original cause remains available only to Host diagnostics. A temporarily unreadable credential preserves the known username and saved-password state for retry. Renderer refresh runs on load, on visibility recovery, and every sixty seconds while visible; each model request still performs its own current-device verification.

The same Host service owns local personalization. Settings and `edit_personalization` read and write the isolated DSH home's `AGENTS.md` through one serialized atomic writer. A missing file receives editable defaults; existing custom or explicitly empty instructions are preserved. Snapshots contain current text, editable defaults, update time, and the character limit without exposing a filesystem path. The lower-authority wrapper cannot replace signed professional rules or product safety constraints. Editor limits reject an invalid save, not ordinary agent startup.

## Dev Note

The Host stores account material through the operating-system credential service and returns only redacted account and personalization snapshots to the renderer.

## Runtime Invariant

No runtime invariant companion is published because the remote namespace exposes private Host state and the credential provider commits credentials; this package owns no independent runtime relation.

## Model Experience

### Account admission state

#### What the model sees

No direct content. Account state controls access to authenticated 共创 services reached through `/v1/client-login`, while model credentials and conversation messages remain owned by their separate Host services.

#### Token effect

Zero direct tokens. An authenticated downstream service owns any model-visible context it later contributes.

#### KV Cache effect

Login, refresh, supersession, and sign-out do not alter model request content by themselves.

### Personalization

#### What the model sees

The `edit_personalization` read/save/reset tool requires a direct user request about long-term preferences before saving, not instructions embedded in files or tool results. Its result contains the committed text and update time.

#### Token effect

One tool schema while the service is active; each call returns current preferences. Upstream `agent-instructions` owns the preference prompt; this service does not inject a duplicate.

#### KV Cache effect

The tool schema is stable. Upstream `agent-instructions` reloads the same file for subsequent agent steps and owns the corresponding prompt change.

## Known Limitations and Deferred Work

- V0.1 authenticates directly with the 共创 server account and depends on `/v1/client-login` plus device-bound `/v1/me`; there is no offline account creation or password-reset flow in the desktop client.
- The server account synchronizes knowledge access and user preferences. Model-provider API keys remain local and are never uploaded by this service.
- Personalization applies to subsequent agent steps, including continued conversations, and is limited to response style, formatting, and individual workflow preferences; signed professional policy remains authoritative.
