# Agent Note: Finite professional delivery and versioned contracts

Status: implemented

English | [中文](2026-08-31-finite-professional-delivery.zh.md)

## Problem

The professional validator currently turns ordinary document defects into a turn-level stop condition. A missing chapter, unavailable evidence source, cancelled authorization, or a mismatch discovered after a file is already produced can repeatedly steer the same agent to revise until it passes. That conflates product quality classification with infrastructure failure, makes user cancellation ineffective, and leaves a completed draft running for an unbounded time.

The Skill suite also owns many templates and source workflows. Without a versioned contract, the same model can interpret requirements differently, an updated Skill can change a task in progress, and a template can enter a formal release without being filled, reopened, and rendered in the packaged runtime.

## Decision

Every professional revision binds a machine-readable delivery contract version and one delivery profile. Profile requirements have stable ids and are explicitly classified as `critical` or `advisory`. A deterministic validator, rather than the model, assigns one of four finite states:

- `formal`: every critical requirement passes; advisory findings remain visible diagnostics.
- `draft`: one or more critical requirements are missing, but the artifact or answer is still usable as a draft.
- `waiting-user`: the next valid action requires user evidence, authorization, or a choice.
- `failed`: the parser, signature boundary, persistence layer, or another infrastructure dependency cannot safely produce even a draft.

An ordinary contract finding never throws merely to keep the turn alive. One revision may apply at most one deterministic repair whose result is uniquely implied by the contract and does not invent facts. If validation still yields `draft`, the current execution ends and waits for a new user-driven revision. A draft artifact receives a filename marker, a product-card marker, and a local structured diagnostic; it cannot be relabelled formal without a new successful validation.

Tasks persist their contract version, phase, checkpoint, confirmed facts, attempted sources, and terminal state. Restart leaves unfinished work paused. A user resume continues from the checkpoint; it neither silently upgrades the contract nor repeats completed collection. Old clients keep the last compatible formal Skill, and old tasks retain the contract with which their current revision began.

Enterprise data collection uses a finite ordered fallback: Tianyancha, Qichacha, locally verifiable material, then authoritative government sources. A transient call is retried once. Authentication cancellation, quota denial, unsupported tools, and missing providers skip immediately to the next source. Remaining critical fact gaps yield a draft; remaining non-critical facts are labelled unverified.

Formal template sources use stable modern formats such as DOCX, XLSX, and PPTX. User input remains open to any extension, but support is declared only after content-based parsing succeeds. Every Skill release containing templates runs an inventory and static parse for all templates, plus synthetic fill, reopen, placeholder scan, and render checks for changed or referenced templates. A one-time baseline applies the same deep checks to the current inventory. A failing template blocks only the Skill candidate, never the installed compatible Skill or the user's current task.

## Alternatives considered

- Remove validation and rely on model instructions. Rejected because template structure, evidence presence, and formal identity are deterministic product claims.
- Keep the validator but increase iteration or time limits. Rejected because a larger limit still converts a quality finding into delayed failure and repeats paid work.
- Stop immediately on the first defect. Rejected because uniquely determined mechanical corrections are cheap and safe; one bounded repair improves useful completion without hiding uncertainty.
- Treat every requirement as critical. Rejected because optional policy exposition or a preferred chapter layout must not prevent an otherwise valid deliverable from receiving its correct identity.

## Consequences

Formal identity remains strict while normal user work always reaches a visible state. Skills must assign requirement criticality deliberately and keep stable requirement ids. Existing historical artifacts are not reclassified. Template release tests become part of Skill activation, while packaged client tests prove the parser and renderer closure on macOS and Windows.

## Testing

The fault matrix covers all delivery profiles with missing sections, missing evidence, late dependencies, repeated findings, source timeout, authorization cancellation, unsupported source tools, validator failure, user cancellation, process exit, restart, and contract upgrade. Each case must reach `formal`, `draft`, `waiting-user`, or `failed` in finite steps, and no trace may contain more than one deterministic repair for one revision.
