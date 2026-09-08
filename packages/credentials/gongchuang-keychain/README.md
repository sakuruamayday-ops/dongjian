---
description: "Operating-system credential provider for the Gongchuang desktop client."
kind: "package-reference"
---

# @gongchuang/credentials-keychain

English | [中文](README.zh.md)

## Summary

Private credential provider for 共创企业助手. It keeps an inherited process environment value as the read-only highest-priority layer and stores user-entered model and MCP secrets in macOS Keychain or Windows Credential Manager.

## Table of Contents

- [Behavior](#behavior)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Behavior

Project and user `.env` files are intentionally excluded. Opening an enterprise directory therefore cannot inject credentials into the signed desktop product.

The stored-record plane admits only `client-connection/browser-session`, the internal grant available to compositions that persist the authenticated loopback browser cookie. Every model, connector, account, and OAuth record remains disabled. The shipped Electron composition uses a process-local browser-session secret, so Connection does not read or write this record; an existing `GONGCHUANG_INTERNAL_BROWSER_SESSION` entry can remain unused. Reference credentials continue to use the operating-system-protected backend.

When another composition explicitly selects a persistent browser session, a temporary macOS Keychain denial treats only this recoverable record as absent so BrowserAuth can rotate it. The fallback invalidates old loopback cookies but never reads, removes, or overwrites user-entered model, MCP, or account credentials; permanent store failures and failed replacement writes still fail closed.

The packaged macOS client reads and writes the `cn.gongchuang.enterprise-assistant.credentials.v2` Keychain service through a native broker whose signed bytes remain fixed. Re-signing the main application during an update does not change the broker's code identity, and new credentials no longer enter the Electron `safeStorage` ciphertext file. The broker accepts only a validly signed parent with the product bundle identifier that launches the broker from the same App bundle; requests and secrets travel only through standard-input and standard-output pipes.

On the first update from a legacy build, one shared migration operation decrypts the complete `credentials.secure.v1.json` snapshot sequentially and writes each entry through the broker. macOS can require authorization for the legacy `safeStorage` item; denial, timeout, or an incomplete migration fails closed, and an explicit user retry starts migration again. Legacy ciphertext remains available for rollback to the source application after an update failure. `credentials.keychain.v2.json` serializes migrated and removed reference updates so concurrent consumers cannot overwrite one another and a missing Keychain item cannot revive stale ciphertext. Explicit removal records the logical deletion before cleaning the broker item and its legacy entry, so a partial cleanup failure cannot make the old value readable again.

A temporarily unreadable reference rejects both resolution and description; it is not reported as an absent key. Consumers retain their saved state and expose a retry. References checked in the same event-loop turn share one temporary Keychain failure, while a later user retry attempts the native store again. Only the internal recoverable browser-session record has the separate absence fallback described above.

An OS credential store removes plaintext-file and ambient-environment exposure; it is not a security boundary against arbitrary programs running as the same signed-in OS user. The product keeps its signed Python runtime outside ordinary task command discovery and does not ship a runtime package installer, but allowed same-user process tools retain the operating-system user's own authority. This package does not claim process isolation when composed elsewhere.

On Windows, one hidden PowerShell host loads the Credential Manager adapter once per provider lifecycle. Credential requests stay serialized over UTF-8 standard input, secret values never enter command-line arguments, and provider disposal waits for the session to close. A failed or malformed session is discarded before a later request starts a fresh host.

## Dev Note

The signed desktop Host owns this provider's lifecycle and supplies credential references to consumers without exposing secret values to the renderer.

## Runtime Invariant

No runtime invariant companion is published because the credential service definition already owns update-event relations, while platform commands are covered by package tests.

## Model Experience

### Credential resolution for configured providers and connectors

#### What the model sees

No direct content. This package changes only whether an authorized Host adapter can resolve a credential reference such as `DEEPSEEK_API_KEY` and become available to its consumer.

#### Token effect

Zero direct tokens. A provider or connector consumer owns any prompt, tool schema, or result made available after credential resolution.

#### KV Cache effect

This package does not alter request content. Credential changes can cause the owning provider or connector to rebuild its own model-visible contribution.

## Known Limitations and Deferred Work

- Linux is not a supported desktop release platform and fails closed.
- A composition that exposes model-controlled same-user process execution can still invoke platform credential APIs; it must add a process policy instead of relying on this storage backend alone.
- Real-device release acceptance must make the exact target macOS package migrate legacy credentials, project account and model state in its UI, and read every value through the frozen broker; retaining the legacy ciphertext bytes alone is insufficient. Windows acceptance must still verify Credential Manager read, write, and delete behavior.
