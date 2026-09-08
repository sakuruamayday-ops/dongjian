# Agent Note: Keep End-of-Transcript Paragraph Annotations Available

Status: proposed

English | [中文](2026-09-04-selection-composer-boundary.zh.md)

## Problem

In the installed ARM candidate, a real triple-click on the final assistant paragraph selected its action row and the next composer's leading attachment icon. Existing normalization handled message actions and context icons, but the composer is outside the transcript column, so the annotation action disappeared. A precise drag and a double-click still worked.

## Proposal

Only when the endpoint reaches an empty leading prefix of the following composer in the same scroll container, resolve the endpoint back to the transcript end. Never ignore selected filenames, draft text, or another message's prose. No model prompt or publication behavior changes.

## Alternatives considered

**Accept every selection that enters the composer.** This would quote filenames and pending user text that were never part of the assistant message.

**Support only precise drag selections.** Whole-paragraph selection is a standard interaction and should not depend on pixel-perfect dragging.

## Acceptance criteria

The leading-icon case failed before the change; filename and draft-text rejection already passed. The Chat view suite and assembled browser triple-click regression cover the supported boundaries. Final installed-App triple-click acceptance remains required.

The final installed ARM App with ASAR `2cb59e6ea571dcee567e57ffd048cb3e05e980543253380245697bb02a79d4db` passed the same native triple-click with a pending attachment and an existing annotation. Annotation 2 stored only the exact source text, with no clock, usage or action text. The full GUI suite passed 4274 tests with one skip; the assembled browser test also passed. Evidence: `native-selection-final-20260904.json` under the V0.4.4 evidence root. No formal release occurred.

## Risks

Overly broad endpoint normalization could include composer content in a quotation. The supported empty-prefix case stays narrow and requires final-App acceptance.
