# Agent Note: quote selected conversation text into the composer

Status: implemented

English | [中文](2026-08-21-gongchuang-quote-selection-into-composer.zh.md)

## Problem

Users reading a long answer often need to ask about one sentence or paragraph. Copying, scrolling to the composer, pasting, and manually marking the excerpt breaks reading flow, while auto-sending a selection would remove the user's chance to add the actual question.

## Decision

Double-clicking, pointer-dragging, or keyboard-selecting non-empty native text inside one settled user or assistant prose row shows a compact menu-surface action near the selection. `Add to conversation` appends the selected lines to the current draft as Markdown quotes, preserves every existing draft character, leaves a blank line for the follow-up question, focuses the current composer at the end, and never submits.

The action is owned by ChatView because that component can prove the Selection endpoints belong to the same keyed conversation row and can use the session-scoped input actions. Ordinary prose, visible link and code text, and visible text in a disclosure row are quotable. Tool rows, actual buttons and custom button controls, inputs, textareas, editable surfaces, cross-row selections, and empty selections are rejected. Escape, outside pointer press, or scrolling dismisses the action. The visual surface reuses the standard menu background, inverted hairline, radius, shadow, hover, and focus tokens instead of adding product-specific colors.

## Alternatives considered

**Always show actions beside every message.** Rejected because it adds permanent chrome to every row even when the user is only reading.

**Send the selection immediately.** Rejected because an excerpt is context, not a complete user request, and sending it would create accidental turns.

**Use the clipboard as an intermediate store.** Rejected because it overwrites unrelated clipboard content and still requires paste/focus choreography.

## Verification

ChatView tests create native Selections in assistant prose, link text, code text, and the reasoning disclosure, append the exact quoted text after an existing draft, verify that submit is never called, and confirm that focus returns to the composer. They also verify Escape dismissal, cross-row rejection, and that Tool rows cannot trigger the action. The assembled Web regression drives Chromium's native double-click selection in a reasoning disclosure and checks the resulting composer draft.

## Consequences

Follow-up questions keep the cited text and the user's draft in one ordinary composer transaction, with no new message type or persisted selection state. Native text-selection gestures remain platform-standard; long selections can create a long quoted draft, but the user still reviews and edits it before sending.
