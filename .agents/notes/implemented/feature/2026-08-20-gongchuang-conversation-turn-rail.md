# Agent Note: Gongchuang conversation turn rail

Status: implemented

English | [中文](2026-08-20-gongchuang-conversation-turn-rail.zh.md)

## Problem

Long enterprise conversations make earlier requirements, corrections, and decisions difficult to revisit. A separate navigation page or persisted outline would duplicate the transcript, require synchronization and recovery rules, and consume scarce sidebar space even when the user only needs a quick jump within the current conversation.

## Decision

共创企业助手 registers the conversation locator through the existing `conversation.session.header.utilities` slot, then positions a transparent narrow rail at the left edge of the active transcript scrollport. Each ordinary user message that opens a turn becomes one short horizontal tick. Steering messages and injected context remain inside their owning turn and do not create navigation entries.

The rail derives from `ConversationSnapshot.chat.order` and `chat.nodes` on every restored or extended transcript. It stores no outline or durable navigation record. Each item keeps the Chat node key already rendered as `data-chat-anchor-key`; selection finds that exact row and uses the conversation scrollport's native scrolling, so existing scroll-position handling observes the move. Scroll and resize observations update the active tick and keep the rail aligned without changing transcript width.

Every tick is a keyboard-focusable button with a Chinese accessible label and a bounded message preview in its native tooltip. Hover and focus lengthen one tick, the current viewport turn uses the product active color, and an ARIA live region reports each jump. Two or more turns show the rail; a one-turn conversation stays visually empty.

This product component depends only on the existing header utility slot, transcript scrollport, and Chat row identifier. It adds no sidebar page, Session field, persistence format, service, or core conversation dispatch branch.

## Alternatives considered

**Add a permanent wide right-side timeline.** Rejected because it would reduce the reading width for every conversation and introduce another responsive pane. The narrow overlay rail preserves the reading column.

**Use a folded header menu.** Rejected because it hides the conversation outline and requires an extra click before every jump. The visible ticks provide location awareness and direct navigation without adding a panel.

**Persist a separate turn index.** Rejected because the Session transcript already determines both turn order and recovery; a second record could drift during history pagination, branching, or replay.

**Extend the generic conversation package with a product-specific rail.** Rejected because the header utility slot and stable Chat row identifier already provide the required composition and location interfaces. Keeping the rail in the product package preserves the upstream conversation package.

**Count steering and context rows as turns.** Rejected because they do not open a new assistant turn and would make the displayed count disagree with the user's mental model of one submitted prompt and its answer.

## Verification

Component tests pin turn derivation, steering and context exclusion, visible narrow presentation, Chinese accessible labels, exact-anchor scrolling, narrow-window long previews, and reconstruction from restored or prepended history. The product package TypeScript program verifies the existing slot and runtime snapshot types.

## Consequences

Users can revisit a long conversation without leaving its transcript, and history recovery automatically restores the same navigation choices. The rail can only locate rows currently rendered in the Chat view; when another conversation view owns the body, it announces that the user must return to the conversation view rather than creating cross-view navigation state.
