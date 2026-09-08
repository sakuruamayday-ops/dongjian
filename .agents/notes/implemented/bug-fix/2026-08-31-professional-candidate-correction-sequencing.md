# Agent Note: Professional candidate correction sequencing

Status: implemented

English | [中文](2026-08-31-professional-candidate-correction-sequencing.zh.md)

## Problem

Professional content validation and execution-chain completion are independent checks. A skill activated after validation can expand required dependencies, leaving the accepted candidate intact while the activation set is incomplete. Turn stopping previously reported that activation gap and final-text mismatch together, attaching the entire accepted candidate on every stop. The model then alternated between activating dependencies and reposting unchanged content, consuming context without closing the missing activation.

## Decision

The policy gate treats late dependency closure and final candidate comparison as ordered phases. When an accepted chat candidate exists and required skills remain inactive, turn stopping labels content validation as complete, retains the normalized candidate in Host state, emits only its character count and SHA-256, and names the missing skills. Candidate comparison waits until every required skill has a successful same-turn activation.

After activation closes, exact comparison remains fail-closed. The first mismatch for one candidate digest may include the complete retained candidate so the model can recover exact text. Later stops for that digest contain only a concise replay instruction. A newly validated digest is eligible for one complete correction again. Existing no-progress and total-correction limits still terminate an unresolved turn without a success receipt.

The dependency notice lists only skills that are actually inactive. Activation is never inferred from graph expansion or a validation receipt; only a successful `skill` tool result records it.

## Alternatives considered

**Automatically mark expanded dependencies active.** Rejected because graph membership does not prove that the model loaded or followed a skill, and it would weaken the execution-chain invariant.

**Compare and attach the candidate while dependencies are missing.** Rejected because it presents two mutually competing next actions and repeats a body that has already passed content validation.

**Never attach an accepted candidate after mismatch.** Rejected because the first exact recovery would then depend on the model reconstructing whitespace and punctuation from older context. One digest-bound expansion preserves deterministic recovery without repeated payloads.

## Consequences

Late dependency repair uses a short, unambiguous step and preserves the accepted content checkpoint. Exact candidate, evidence, receipt, and artifact checks remain enforced. A repeated mismatch spends substantially fewer tokens, while an unresolved activation or drift still reaches the existing bounded incomplete result.
