# Agent Note: Model connection persistence semantics

Status: implemented

English | [中文](2026-08-31-model-connection-persistence-semantics.zh.md)

## Problem

Model connection setup, model selection, and default-model persistence are separate commits. Three paths previously blurred those boundaries. A transient provider probe during startup could select and persist a different ready provider. Session model selection returned success after its default settings write failed. Connection setup could commit a new endpoint and credential, then report the later automatic-selection failure as though the whole setup had failed.

These paths made a restart appear to restore an old model or made the UI disagree with the Host even though the new connection had already been saved.

## Decision

Startup reconciliation preserves every durable active route that still maps to a product provider, including `loading`, `error`, `missing`, and `unavailable` states. It attempts automatic selection only when that route is `ready`. The existing ready-provider fallback is used only when no durable route maps to a product provider, so a temporary probe or credential-store classification cannot rewrite the durable choice.

Session model selection now persists the cross-Session default before appending the Session-local `model/selection` event. If that write fails, the Remote returns an observable error and leaves the Session log unchanged. The client therefore cannot claim a durable switch that a fresh Session would not restore.

Provider configuration keeps its already-committed connection when automatic selection fails. The product returns a partial-success result, clears the renderer's password field because the credential is already protected by the Host, and displays `连接已保存，自动切换失败` with the actionable selection error. It does not relabel the verified connection as unsaved.

Discovery and dispatch share the committed credential reference, endpoint and protocol. Official DeepSeek configuration writes all three adapter inputs, and rollback restores the prior connection together with its catalog. Managed preset refresh replaces legacy credential names and obsolete fixed endpoints with the registry values while preserving user-approved optional or required endpoints. A directory-less manual model remains a `candidate` after refresh; a local adapter catalog is not evidence of remote authentication. Profile rollback failure cannot skip credential compensation or leave the provider permanently `checking`.

## Alternatives considered

**Choose the first ready provider whenever the active provider is not ready.** Rejected because temporary network, quota, credential-store availability, and even a repairable missing credential are not user intent and must not overwrite a durable route.

**Keep Session selection successful and only log a failed default write.** Rejected because logs are not an observable product contract and a later fresh Session would silently use another default.

**Roll back a verified connection when automatic selection fails.** Rejected because the endpoint and credential commit already succeeded and can be selected or retried without asking the user to enter the secret again.

## Consequences

Restart behavior now follows durable user intent through transient provider failures. A successful model-selection Remote means both the default and Session intent were accepted. Connection setup can still succeed independently of automatic selection, and the UI names that partial outcome without retaining or exposing the submitted API key.

Regression coverage exercises transient startup status, default-write refusal without a Session event, and visible partial success after a saved connection.

Same-id DeepSeek directory rows update explicitly advertised names and capacity while preserving previously trusted capabilities and omitted metadata. Both configuration and refresh propagate these values into the real adapter, not only the settings page. Independent compensation reports incomplete profile or credential recovery to the user instead of silently hiding a residual new configuration.

Real adapter tests also cover replacement keys, legacy credential names, endpoint and protocol correction, and a new runtime mounted from the persisted configuration. Fault injection covers catalog adoption, independent profile and credential rollback failure, and refresh recovery. Network responses are controlled fixtures in these tests, not evidence of a live provider account or a newly published desktop binary.
