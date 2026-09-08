---
description: "Host-owned model endpoint configuration and verified model catalog for the Gongchuang desktop client."
kind: "package-reference"
---

# @gongchuang/model-connections

English | [中文](README.zh.md)

## Summary

Provider configuration catches credential reads as part of the configuration attempt. Even when the subsequent credential diagnostic also fails, the provider leaves `checking` for a visible transient error; existing secrets are not replaced by this recovery.

Host-owned model setup for 共创企业助手. The client exposes 34 approved providers plus one local/custom endpoint. One registry owns labels, fixed endpoints, protocols and credential fields across Host and renderer. Provider capabilities remain adapter-owned and are never inferred from a model name. Existing credentials are reused during migration; removed UI choices are not shown and their stored secrets are not erased.

## Table of Contents

- [Behavior](#behavior)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Behavior

Configuration is not considered ready when a key is merely present. Providers with a model-directory endpoint are authenticated and probed before the service commits their key to the operating-system credential provider. Providers without a model directory require a user-entered model id. Local endpoints may omit a key. Renderer snapshots contain status, model ids and saved editable endpoint fields, never secrets or credential references. Editable forms restore the saved display name, validated base URL, protocol and model id after reopening or restart; API key fields remain empty.

Anthropic-compatible discovery uses `/v1/models` relative to the API root, preserving gateway prefixes such as `/anthropic`. Kimi subscription keys beginning with `sk-kimi-` use `https://api.kimi.com/coding/v1`; ordinary Kimi keys use the selected Moonshot region. Configuration and restoration resolve the same endpoint from the stored key.

Saved credentials are restored after the desktop shell mounts. A slow or temporarily unavailable macOS Keychain can delay only the affected provider status; it cannot delay the main window or ordinary local conversations. Manual configure and refresh operations remain serialized behind that provider's background restore, while one provider's failure does not clear another provider's healthy catalog.

A temporary Keychain read failure is a retryable connection error, not a missing or invalid API key. Refresh reads the existing reference again without requiring replacement input or writing credentials. The renderer keeps this Host error visible even before the adapter route is registered.

The adapter uses the same credential reference, endpoint and protocol as discovery. Refresh repairs legacy managed profiles while retaining explicitly configurable endpoint addresses. DeepSeek rollback restores the prior connection and model catalog together. A failed profile rollback cannot skip credential recovery or leave a `checking` state. A manually entered model whose endpoint has no directory remains an unverified `candidate` on later refreshes; it never gains a fabricated verification timestamp.

## Dev Note

OpenCode Go and Zen preserve their durable route ids while inheriting the corresponding installed native provider through `catalogProvider`. They offer the intersection of the live directory and the installed native catalog. Explicit null API and URL values clear old composition-layer overrides across refresh and restart. Models not yet described by that catalog need a client update; their protocol is never guessed from a name.

The Host commits a provider configuration only after authenticated model discovery succeeds; renderer snapshots never contain secrets or credential references.

## Runtime Invariant

No runtime invariant companion is published because each Remote response is the commit receipt for one serialized credential or settings operation and excludes secret values.

## Model Experience

### Verified provider configuration

#### What the model sees

This service registers no model-visible prompt or tools. Later requests use the committed adapter route and model catalog. Authenticated directory results are distinct from manually entered, unverified candidates. Missing, rejected, unreachable, malformed or unserviceable endpoints receive no verified-success receipt.

#### Token effect

Connection probes use `GET /models` and consume no model tokens. Ordinary model requests pay only their selected provider's normal usage.

#### KV Cache effect

Probing does not alter an existing session prefix. Selecting a different verified provider changes the request route and therefore cannot reuse a provider-specific KV cache from the previous route.

## Known Limitations and Deferred Work

- An authenticated directory proves model discovery, not successful inference or access to every listed model. Account-specific quotas and model permissions are enforced by the provider at request time.
