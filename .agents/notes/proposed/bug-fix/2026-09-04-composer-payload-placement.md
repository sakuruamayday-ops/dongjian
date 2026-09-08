# Agent Note: Keep Draft Files and Annotations Inside the Composer

Status: proposed

English | [中文](2026-09-04-composer-payload-placement.zh.md)

## Problem

The assembled desktop places the product's attachment and annotation rails above the input card because both use `conversation.input.dock`. Matching their horizontal dimensions to the card does not satisfy in-card placement. The browser regression checked only horizontal alignment and overflow, so it accepted this defect.

## Proposal

The resident InputBar declares and renders `conversation.input.payload` inside its card, before the editor. Only the product's draft file and annotation entries move there. Task, goal, and queue status retain the upstream dock; upstream image intake and previews remain unchanged. Payload rows inherit the card width without applying the outer side clearance a second time.

## Alternatives considered

**Keep the product rails in the outer dock and adjust margins.** This cannot place the payload inside the input card or give it the card's clipping and layout ownership.

**Move every dock contribution into the card.** Queue, task, and goal state belong to the upstream dock and must retain their existing composition point.

## Acceptance criteria

The Loader-composed browser scenario must prove that both rails descend from the composer card and remain within its horizontal and vertical bounds at desktop and mobile sizes. It also covers wrapping, source annotation numbers, reload persistence, removal, and sending an annotation-only message. Native acceptance must repeat mixed attachment and annotation placement on the rebuilt signed App. Browser fixtures do not establish Finder drag behavior or native file deletion.

## Risks

Payload rows can increase composer height and must remain scroll-safe on small viewports. The change does not alter the upstream image registry or move non-payload status rows.
