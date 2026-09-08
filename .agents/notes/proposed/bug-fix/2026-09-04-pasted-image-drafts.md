# Agent Note: Pasted Image Draft Continuity

Status: proposed

English | [中文](2026-09-04-pasted-image-drafts.zh.md)

## Problem

The signed V0.4.4 App restores a PNG added through the file picker after a loopback-port change, but loses the same image pasted from Preview. Only its text survives. Browser-owned image ids and object URLs cannot survive a cold renderer.

## Proposal

Expose image-id observation, serialization, and empty-only restoration from the existing conversation owner. Mirror validated PNG, JPEG, WebP, and GIF payloads through the existing private atomic native draft store. Preserve the existing aggregate storage bound and surface failed saves in the composer. Cache encoding while ids remain unchanged. Capture pending values before disposal and suppress late writes after conversation deletion. Do not replace the ordinary image registry, send lifecycle, or provider-consent path.

## Alternatives considered

- Treat pasted images as file references: rejected because they have no filesystem source and would bypass ordinary vision submission.
- Persist object URLs or browser-local ids: rejected because neither identifies live bytes after restart.
- Add another image database or filesystem cache: deferred because the current bounded draft record already owns this local reversible state.

## Acceptance criteria

- Native storage retains an image-only draft and rejects malformed, unsupported, or oversized payloads before replacing valid records.
- A cold Loader-composed browser restores the same image bytes and visible thumbnail; removal persists across another cold renderer.
- Typing reuses the existing encoding; a pending encoding cannot recreate a deleted draft or discard the last captured shutdown edit.
- A rebuilt signed App passes real paste, normal exit, restart, image-only submission, and removal using synthetic data.

## Risks

The existing 4 MiB aggregate draft-file limit includes image payloads. Larger unsent drafts remain usable in memory but require an explicit save warning rather than an unqualified persistence claim. Native UI acceptance and formal publication remain separate from source tests.
