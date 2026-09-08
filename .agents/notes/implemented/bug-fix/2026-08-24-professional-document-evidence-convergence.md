# Agent Note: Professional document evidence converges on displayed values

Status: implemented

English | [中文](2026-08-24-professional-document-evidence-convergence.zh.md)

## Problem

A real Windows spreadsheet task exposed four connected failures. Legacy `.xls` was accepted by the desktop import surface but absent from the signed document extractor and embedded Python runtime. XLSX artifact inspection stripped raw OOXML, so shared-string indexes and stored percentage values entered numeric evidence instead of the values users saw. The numeric gate also treated standard identifiers, mobile numbers, and identity-card numbers as business quantities. Finally, a professional artifact created through an opaque signed operation could reach publication without activating the openability receipt, while an exit-zero operation that printed only a warning could masquerade as successful extraction.

These failures amplified one another: the model installed ad hoc dependencies or rewrote documents, then tried to bind internal tokens one by one, and could still publish without proving that the resulting file opened.

## Decision

- The signed extractor accepts `.xls` and the product runtime pins `xlrd 2.0.2` on all three targets. XLS and XLSX extraction returns displayed percentages and dates.
- XLSX artifact inspection parses workbook relationships, shared strings, rich text, cell styles, percentages, and dates. It never validates raw shared-string indexes as document facts.
- Numeric fact extraction excludes recognized standard identifiers, mobile numbers, and identity-card numbers. Percent display notation uses numeric equivalence for evidence binding; substantive quantities remain bound.
- Enterprise-profile subject anchoring and the high-tech four-section contract apply only to formal response depth. Explicitly scoped questions remain query or analysis tasks.
- A signed operation may declare one stdout schema version. The runtime requires an exact JSON object with that version and rejects warning-only or prefixed output even on exit zero.
- Binding a professional artifact activates formal receipts, and publication is denied until the real artifact passes openability inspection.

## Alternatives considered

**Install missing Python packages during each task.** This makes identical documents depend on network availability and mutable user environments, and repeats setup cost on every machine. The product instead pins the supported extractor dependency in its signed runtime.

**Keep binding raw OOXML tokens and teach prompts to repair each mismatch.** Shared-string indexes, stored percentages, and style-dependent dates are implementation details rather than document facts. Prompt workarounds would preserve the wrong semantics and keep producing repair loops.

**Allow publication when extraction or openability evidence is unavailable.** That would turn an exit-zero warning or an unreadable artifact into a successful formal delivery. The existing fail-closed delivery boundary remains in place and is activated by the actual professional artifact.

## Consequences

Users no longer need task-time `xlrd` or `pdfplumber` installation for supported extraction paths, and Excel evidence follows visible cell semantics. Standard and personal identifiers no longer generate irrelevant numeric repair loops. Formal document safety remains fail closed: the narrower chat contract does not weaken evidence, signature, file identity, branding, visual, permission, or rollback checks.

## Verification

Focused tests cover a real BIFF8 XLS fixture, XLSX shared strings and styled percentages, a non-date `[Red]0` format, percentage evidence equivalence, standard and personal identifier exclusion, scoped enterprise/high-tech validation, structured stdout success and failure, and publish denial before artifact probing. The product's real Loader composition and the full release suites own the assembled-path proof.
