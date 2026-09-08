# Agent Note: Professional user choice stops the turn

Status: implemented

English | [中文](2026-08-31-professional-user-choice-stop.zh.md)

## Problem

A professional skill can require the user to choose a report mode before research or file generation begins. A plain assistant question did not own the turn lifecycle: the professional completion guard saw missing receipts, steered the same turn forward, and allowed later work to continue without an answer. The late artifact validator could reject the resulting file, but only after research and document generation had already consumed time.

## Decision

The Gongchuang policy gate records an unresolved enterprise-panorama report mode as Host state. While that state is unresolved, only skill activation and `ask_user_question` may execute; research, evidence collection, validation, and file generation are denied. A successful structured answer containing A, B, or C clears the state. If the assistant presents the complete A/B/C choice in final text, turn stopping yields control to the user instead of injecting another correction into the same turn.

Formal Office delivery also validates the complete chat-mode structure against the active signed `deliveryProfileId` before creating DOCX, XLSX, or PPTX. Artifact-mode validation still reopens and verifies the produced file. The early check prevents a custom approximation from reaching the expensive generation path when required chapters, tables, fields, or ordering are absent.

## Alternatives considered

**Treat the first report mode as a default.** Rejected because the report mode changes scope, evidence depth, structure, and cost; it is a user decision rather than a deployment default.

**Rely only on final artifact validation.** Rejected because it detects the wrong structure after research and file creation, wasting the task while still failing to obtain the user's choice.

**Recognize a plain question but leave tools unrestricted.** Rejected because another model step in the same turn could still bypass the unresolved choice.

## Consequences

Enterprise-panorama work pauses before discovery until the user answers, so no report mode is inferred from ordering or recommendation text. Structured questioning is the primary path, while a complete plain-text A/B/C question remains a safe turn boundary. Formal Office generation pays for one additional deterministic prevalidation, then retains the existing artifact validation and evidence requirements.
