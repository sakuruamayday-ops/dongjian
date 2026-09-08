# Agent Note: One-shot recovery for pruned skill instructions

Status: implemented

English | [中文](2026-08-29-skill-prune-one-shot-reload.zh.md)

## Problem

The tool-result pruner treated a long `skill` loader result like arbitrary command output. Its generic middle marker disclosed that some text was absent but did not identify the missing material as instructions or tell the model how to recover it, so a formal skill could remain partially loaded without an actionable continuation path.

## Decision

The pruner identifies a skill result from its paired durable `tool/call`, never from output text. The first pruned load of a named skill after the latest direct user message carries a recognizable `reload="available"` marker with the exact existing `skill` call needed to reload the complete instructions. Another pruned load of that skill before a new direct user message carries `reload="used"` and tells the model not to reload again solely because of the marker. When several long results for the same skill already exist in one pruning snapshot, only the latest offers recovery.

The recovery path reuses the existing `skill` tool and its exact `name` argument. It adds no pagination protocol, instruction store, automatic call, or compatibility layer. Ordinary tools retain the generic marker even when their text resembles a `<skill_content>` block.

## Alternatives considered

**Make every prune marker recommend the `skill` tool.** Rejected because ordinary tools cannot be recovered through `skill`, and text resemblance is not durable tool identity.

**Automatically reload until a complete body survives pruning.** Rejected because a long body can repeatedly cross the same threshold and create an unbounded tool loop.

**Add offset and page parameters to `skill`.** Rejected because no current caller consumes paginated skill instructions; the existing full-load operation is sufficient for one explicit recovery attempt.

## Consequences

A model can distinguish incomplete skill instructions from ordinary truncated output and has one bounded recovery attempt per direct-user continuation. The second marker gives up further automatic recovery in that continuation and leaves the retained head and tail as the available instructions. A custom threshold too small for the recovery text falls back to the generic validated marker rather than exceeding its configured limit. Unit coverage pins the exact reload path, the one-off stop, and unchanged ordinary-tool behavior; the keyless `skill-prune-recovery` recorded session proves the shipped `skill` and compaction path emits the visible recovery marker.
