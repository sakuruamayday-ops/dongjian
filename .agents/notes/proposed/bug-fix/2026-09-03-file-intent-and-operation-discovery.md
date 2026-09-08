# Agent Note: File intent and signed operation discovery

Status: proposed

English | [中文](2026-09-03-file-intent-and-operation-discovery.zh.md)

## Problem

Native testing of synthetic DOC and XLS attachments entered a professional workflow despite explicit exclusions. It then spent six steps searching the installation for parsers and an operation manifest without reading either file. Supplying the existing operation's exact parameters completed the same two reads in one PTC program; the native result records show 217 ms and 345 ms extraction durations. The complete response took 20 seconds.

The intent matcher did not recognize negated file actions, missed a negation immediately before an action marker, and carried exclusions across commas. The signed operation tool exposed operation ids without owning skills or argument definitions, making a registered capability difficult to discover.

## Proposal

Keep explicit negations within their clause and retain positive professional requests in following clauses. Render the verified manifest's operation, owning skill, purpose, and parameter definitions in the existing tool description and PTC SDK. Do not expose executable paths or add another registry. Keep PTC transport, skill activation, signed inventory checks, workspace confinement, process isolation, and bounded failure outcomes unchanged.

## Alternatives considered

Special-casing QA prompts would hide ordinary-user failures. Disabling professional validation would weaken real business workflows. Requiring users to supply tool calls or allowing the model to search installed executables would preserve the original usability defect.

## Verification

The initial focused reproduction failed 13 of 15 selected cases. The corrected policy, signed runtime, and real Loader composition pass 106 tests, including the PTC-visible operation description and both positive and negated intent cases. The native exact-call result establishes existing parser capability, not automatic routing after the fix. A rebuilt signed client still requires an ordinary-prompt native recheck before release.

### September 4 follow-up

The installed candidate read a mixed PDF in 116 seconds, but repeatedly passed parameter definitions as values and called unavailable root tools. A separate native financial calculation reproduced two direct `skill` calls before recovering through PTC; the arithmetic was correct, but the turn took 82 seconds. Both are ordinary consumer paths, not only attachment-specific failures.

The signed operation description now uses a `parameterSchema` of JSON value types, distinguishes schema from actual arguments, and documents the PTC activation sequence. Non-string input/output file arguments fail before process creation with a field-specific correction. The initial professional notice and newly expanded dependency notice also explain the conditional PTC entry point. The upstream transport, activation attribution, permissions, signatures, and bounded validation behavior remain unchanged.

The three argument/discovery reproductions pass after the change. The final policy, operation, and real Loader composition suite passes 109 tests. The initial notice test required adding the actual financial route to its synthetic rule fixture; its first missing-route failure was a test-fixture deficiency, not a production routing defect. The later passing suite uses that corrected fixture and an updated model-visible snapshot. Evidence is recorded under `professional-ptc-notice-final.json` and `operation-arguments-after.json` in the V0.4.4 evidence directory. These source changes have not been installed into the running App, so they do not establish an improved native latency result.

### Native follow-up after packaging

A single ARM candidate with ASAR `1b777a147ee249fd2bc8866a8aa98ac5f08902d572d68ec0549b52089c024aa0` includes the new client notices while retaining signed skill V1.6.16. The identical financial prompt completes in 58,780 ms with no root or nested tool errors, compared with 82,162 ms and two missing root tools before the change. Both runs calculate the three ratios correctly. This one-run comparison does not establish a general latency bound.

The same mixed PDF completes in 64,166 ms, down from 116,224 ms, but still omits the root `run_code.description` once and guesses the OCR argument as `image` once. It does not activate the fixed extraction operation. The final response also incorrectly describes remote OCR as no-network processing and model inspection as human review. Candidate skill guidance covers those fields and provenance distinctions, but remains unsigned and uninstalled; a text assertion does not establish model compliance. The native file workflow therefore remains partially unaccepted. Exact synthetic-session evidence is recorded in `native-financial-after-ptc-20260904.json` and `native-mixed-after-ptc-20260904.json`.

## Acceptance criteria

An ordinary native request reads the uploaded synthetic DOC and XLS files without exact tool instructions, parser discovery, or an unwanted professional workflow. The result must match the signed extraction receipts. Positive professional requests still activate their existing workflow, and no signature, activation, or workspace check is bypassed.

## Risks

The syntax-based intent matcher is not a general natural-language parser. These changes address the observed exclusions and their direct comma and semicolon variants. The unsigned skill-reader and template candidates have separate verification and release evidence.
