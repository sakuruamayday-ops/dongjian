# Agent Note: high-tech application document convergence

Status: implemented

English | [中文](2026-08-31-hightech-document-convergence.zh.md)

## Problem

A real high-tech application task spent 110 minutes without completing. Thirteen legacy binary Word files triggered repeated COM, dependency-installation, and encoding-guess experiments. The DOCX writer then traversed python-docx's grid-expanded `row.cells` and deduplicated proxies with `id(cell._tc)`, so merged cells could be silently skipped. The skill also reversed the template's "maximum 400 characters" instruction into a minimum and lacked one batch path for the four staged-result rows.

## Decision

The high-tech drafting skill inventories every input once by extension and file header. Legacy `.doc` is an explicit unsupported format: supporting files are skipped while supported application material continues, and essential files produce one consolidated DOCX-conversion request. An unchanged essential-input failure stops on the second attempt without modifying source files.

RD targeting now walks physical OOXML `w:tc` nodes and finds fields by semantic labels, never by a fixed row number or Python proxy identity. One batch transaction can write two core technologies, two innovations, and four staged results. Before the output is accepted, the writer reopens the DOCX and compares every target cell with the structured input.

All fields labelled "maximum 400 characters" use 400 as a hard upper bound. Boundary coverage accepts 399 and 400 characters and rejects 401.

## Alternatives considered

**Install another legacy Word parser at task time.** Rejected because availability varies by host and retrying installation or decoding does not establish reliable evidence.

**Address merged tables by fixed row indexes.** Rejected because customer templates can retain the same semantic labels while inserting or moving rows.

**Keep core technology and staged results as separate write passes.** Rejected because a late second pass can leave a partially updated application and requires another full document traversal.

## Consequences

Legacy `.doc` material must be converted outside the skill when it is essential. Supported evidence remains usable when the legacy files are merely supplementary. Batch writes either satisfy their exact postcondition or fail without overwriting the input; output and recovery copies remain available for diagnosis. The skill source must be released and signed as a new formal skill-suite version before the client can embed this behavior.
