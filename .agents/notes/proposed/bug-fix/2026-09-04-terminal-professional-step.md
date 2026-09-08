# Agent Note: Stop Model Steps After Terminal Professional Validation

Status: proposed

English | [中文](2026-09-04-terminal-professional-step.zh.md)

## Problem

Native synthetic session `session-288bc507-8b6a-486a-86c7-2775c30a93f7` received `repairable` at step 27 and `draft` at step 28, then continued through step 45. The validator consistently returned the frozen draft result. The model ignored its stop instruction, switched tools and attempted additional evidence binding. The existing turn-stop listener could not run while the model kept requesting tools.

## Proposal

Use the existing pre-step decision to reject the next request after a terminal draft or failure. Persist the Host-owned issue notice after the completed tool exchange, including a no-file diagnostic and the instruction that the result is not ready for formal use. Keep the original files and the existing explicit user-revision path. No new contract, counter, lifecycle controller or publication exception is introduced.

A cancellation after the terminal result preserves its phase. Restoring a legacy paused checkpoint with a draft or failed outcome treats an explicit continuation as a new user revision. Loading the shared reader's coordinator or router in an ordinary turn does not activate professional dependencies: B07 read both PDF pages correctly, then spent three unnecessary steps activating business dependencies and validating the transcription. Concrete professional skills and actual business requests still activate the existing checks.

B08 still failed ordinary-reader acceptance because the real Client appended its document-reading instructions to the user message. Routing matched business words in that product context before the first model step. The Host uses the existing `source.displayText` projection for intent, excluding attachment rows and annotation quotations while retaining current comments. The Loader regression uses the captured native user message and its display projection, rather than a shortened hand-written input. Separate projection tests cover business-named attachments.

## Alternatives considered

**Depend on the model to follow a terminal tool message.** The captured session continued for seventeen steps after the terminal result, so text alone does not settle the turn.

**Retry validation until it passes.** This recreates the unbounded correction loop and can spend tools or tokens without a new user revision.

## Acceptance criteria

Focused tests cover a repairable step remaining admissible, terminal chat and artifact steps being rejected, deduplicated no-file diagnostics and a later explicit revision. A real Loader composition covers PTC execution. Native acceptance must observe idle after the second failed validation, visible diagnostics and no third automatic validation; tests alone do not establish that UI result.

## Current implementation

`repairable` opens exactly one model step. That step may reread the exact candidate rejected by the validator, modify it in the existing `run_code`, and resubmit validation. It may not restart directory listing, research, skill loading, or unrelated file reads. If the step does not submit a second validation, the following step enters the draft terminal state instead of allowing further exploration. Chat mode now also preserves an exact `candidateArtifactPath`; after the repair is exhausted, the Host exposes the candidate as a marked draft file card with its issues, never as a formal deliverable.

Numeric evidence validation also fixes the related false classifications. Thousands-separated values bind as a single number. Page labels emitted by PDF extraction, remediation-plan time coordinates, and the `x365` constant in turnover-day formulas are not customer facts. Independent monetary values, metrics, or an independent `365` still require evidence. The professional tool contract now requires every derived numeric value to be bound, rather than a representative subset.

The shared portable-execution block in all 51 signed skills now states that hidden tools must be invoked inside `run_code` as `await tools.<name>(...)`. It also forbids prereading scripts, templates, examples, or tests merely to discover usage; directly relevant source may be inspected only after an actual command failure leaves the contract ambiguous. This reduces purposeless tool steps without changing business requirements, signature verification, or professional terminal behavior.

As of 2026-09-05, 155 focused policy tests and 325 focused product-version tests pass. The V1.6.18 candidate passes 13/13 prerelease checks, 51/51 signatures, isolated installation, and the skill repository suite with 380 passes and 4 skips. The first full repository run found that the product UI still advertised `1.6.17`; it has been corrected to `1.6.18`. After that correction, the full repository passes 1,199 files and 19,484 tests, with 9 files and 118 tests skipped; GUI passes 331 files and 4,423 tests with 1 skip; built Web replay passes 96 files and 334 tests with 1 file and 7 tests skipped. Repackaging and installed-client native acceptance remain incomplete, so this Note stays `proposed` and is not release evidence.

## Successful File Validation

Native B18 catalog session `session-8c943363-beb6-4bd1-882f-d80e559a4d12` passed artifact validation, then claimed completed delivery without the remaining receipts. Its durable tool card contained the chat-only instruction to end with the candidate text. PTC does not forward that card to the model: it returns the structured value, whose `formal` status omitted the next action. The shared tool description and search-budget notice also failed to distinguish file preflight from chat completion. The record establishes incorrect and incomplete guidance, not proof that the model read the card text.

The tool returns a mode-specific `nextStep` in the existing structured result and renders the card from that same field. Chat-only success retains exact final-text output; Office and PDF preflight continue with generation and artifact validation; artifact success continues with existing file checks. Failure and draft next steps retain the existing one-correction limit and terminal behavior. No receipt is synthesized, no validation is removed, and no loop or PTC mode change is introduced.

A real Loader test covers the four successful modes, asserts the returned PTC value and durable tool text match, and snapshots their instructions. The native early-probe sequence is also reproduced: a probe succeeds before professional binding, but that success does not satisfy the bound delivery's openability receipt. Existing rejection tests continue to cover premature publication and terminal stopping. Installed-client acceptance remains required for the native catalog failure; source tests do not establish that the model followed the new instructions.

## Risks

Rejecting the next request too early could suppress a legitimate repairable correction or explicit user revision. The phase check therefore distinguishes repairable from terminal outcomes and preserves the existing user-controlled revision path.
