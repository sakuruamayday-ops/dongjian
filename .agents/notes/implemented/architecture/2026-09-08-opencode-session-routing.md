# Agent Note: OpenCode conversation routing headers

Status: implemented

English | [中文](2026-09-08-opencode-session-routing.zh.md)

## Problem

[OpenCode Go requires a stable conversation header](https://opencode.ai/docs/go/#where-can-i-use-it). Passing pi-ai's session option alone does not send that header across all supported protocols, producing `MissingSessionID` failures.

## Decision

Named routes can select an installed `catalogProvider` without changing durable route ids. OpenCode Go and Zen use their native providers and only endpoint-listed models present in those catalogs. Null API and URL settings mask legacy composition-layer overrides, preserving native per-model protocols across restart. Other configurations retain explicit overrides. Guessing a protocol from the model name or forcing Chat Completions fails the gateway's format check. No new protocol implementation is introduced.

The pi-ai adapter's common header hook sends the existing session id for named OpenCode routes and the exact official endpoint hostname. It overrides case-insensitive profile collisions and omits the header when no session exists. Main turns, titles, and compaction retain caller-owned session ids without new state or log formats. The [application attribution decision](2026-06-21-mandatory-app-attribution-headers.md) remains applicable: public `User-Agent` identity and provider-specific conversation routing are separate. No existing note is superseded.

## Alternatives considered

**Static configuration.** Rejected because unrelated conversations would share one routing identity.

**SDK session option alone.** Rejected because the completion protocol omits the required wire header.

**All-provider header.** Rejected because unrelated providers do not require the extra conversation identifier.

## Consequences

Named OpenCode routes retain the header through configured proxies. Differently named proxies without the official endpoint hostname are not detected. HTTP capture tests cover three protocols, stable ids, distinct conversations, custom endpoints, and Loader composition; official service and packaged-release acceptance remain separate evidence.
