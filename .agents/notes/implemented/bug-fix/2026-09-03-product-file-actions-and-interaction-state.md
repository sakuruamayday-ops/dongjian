# Agent Note: Product file actions and interaction state

Status: implemented

English | [中文](2026-09-03-product-file-actions-and-interaction-state.zh.md)

## Problem

The product needs recognizable document controls and stable source references. A successful native open alone does not establish that the filename, file type, application menu, or annotation origin is usable. An admitted automation can also fail before model execution when its Client plugin accesses a sibling service absent from its Cordis inject declaration.

## Decision

The shared FileCard primitive renders complete filenames, file types and optional quality states. The product supplies narrow native actions. The desktop main process checks the sender and resolves each file inside the selected workspace before enumerating installed applications, opening with one, revealing a file or copying it. LaunchServices supplies macOS application identities; the Windows system chooser owns application selection. Copying does not replace an existing document.

The product derives source-message annotation markers from the existing durable user display metadata and current drafts. It consumes event-window deltas and exposes stable per-message observables to Chat's keyed hooks. Selection boundaries treat an unselected offset-zero endpoint as part of the preceding selected paragraph. A genuinely cross-message selection remains excluded.

Annotation intent uses current comments and the message body, excluding quoted history. Pure transcription without an affirmative analysis or creation request stays outside professional routing. Explicitly negated continuation and tool invocation do not revive an earlier task. Actual professional instructions retain the same validation and permission requirements.

Delivery notices are published only at model-step boundaries. The tool completion hook persists the checkpoint but cannot insert a user message before its corresponding tool result. A provider that requires contiguous tool exchanges can therefore consume a completed artifact check without a protocol-level 400 error. No tool result or historical message is removed.

Native B04 retesting also reproduced the 400 when resuming an older stored exchange. The LLM adapter projection now defers only plugin text notices across a complete set of matching tool results. It leaves user messages and incomplete exchanges unchanged, preserves message identities and content, and does not rewrite stored history.

The mixed-PDF run repeatedly omitted the outer PTC display description and truncated loaded skill output. `run_code` now defaults a missing or blank display label while retaining code and nested-argument validation. Successful nested skill loads contribute their full rendered instructions through the existing additional-context queue after the root result. Native evidence, rather than a new blocking validator, determines whether these changes resolve the workflow.

The next native PDF run skipped the reader skill entirely and improvised extraction scripts. Office/PDF attachment prompts now name the installed reader and its actual relative-path argument; plain text stays unchanged. The instruction is model context, not a new delivery barrier.

The follow-up run used the reader but the OCR wrapper had no page-selection parameter, leaving the model to construct a temporary PDF. `workspace_pdf` now takes the reader's one-based page list, selects pages in memory with the verified bundled PyMuPDF, caches by source plus page list, and returns original page provenance. The source PDF is unchanged; malformed, encrypted and out-of-range selections never reach OCR. Another native business run exposed relative publication paths being resolved from the desktop process cwd (`/`) instead of the Session cwd. File publication now resolves relative paths from that Session and rejects unattributed relative paths.

A digitalization run invoked `cd /tmp && rm -rf digpre` despite the no-delete request. The existing pre-dispatch policy now rejects direct Bash and PowerShell deletion commands and tells the model to preserve files and use a fresh authorized directory, never another deletion API. Git, version numbers, types and tests cannot recover an untracked file after a live destructive command; the existing tool-name deny list did not inspect an allowed shell tool's command. This check only covers direct command syntax, not arbitrary script effects or encoded commands; it does not replace OS confinement or claim a complete no-delete sandbox. Template instructions now point to the existing selector/filler instead of manual XML reconstruction. The failed run is retained and was stopped; no file restoration is claimed.

Desktop skill projection identifies the Host-verified package as its execution boundary and does not ask the model to run standalone installer self-checks whose manifests are absent from that package. Staging reuses the Host operation-manifest parser before signing, so a version mismatch is found before the application is assembled rather than at startup.

Desktop download and installation are separate explicit operations. A completed download stays ready across checks of the same release. The macOS controller verifies the staged application again before installation and retains the signed archive for resume. The notification displays actual Host states and signed release notes without automatic download or shutdown.

Personalization settings and the conversation tool share the isolated DSH home AGENTS.md through one serialized writer. Defaults initialize only an absent file; an explicitly empty or customized file is preserved. Upstream agent-instructions owns instruction reload. Editor limits do not become a pre-step gate. Pending-user state comes from the existing interaction projection. The automation plugin declares its uiConversation dependency.

Electron search resolves ripgrep to its physical ASAR-unpacked location. Both glob and grep use that resolver; the virtual path readable through Electron's filesystem cannot be passed to an OS subprocess. Ordinary Node and single-file SDK sidecar resolution remain unchanged. Chinese Chat reasoning presentation evaluates the visible preview as well as the complete text, so Chinese filenames inside English prose do not expose an English summary.

## Alternatives considered

**In-client document preview.** The confirmed interaction uses system applications. An additional preview engine would change that choice and duplicate mature document applications.

**Hard-coded application rows.** Installed applications and defaults differ between machines. Native enumeration and a system chooser avoid offering nonexistent handlers.

**A second annotation database or preferences file.** Existing display metadata and AGENTS.md already provide durable identities. Duplicating either adds synchronization failures without a current consumer.

**Automatic installation after download.** Download completion is not user consent to interrupt work. An explicit restart action preserves that distinction while keeping integrity verification.

## Consequences

The renderer remains presentation-only. File actions require local desktop support; standalone browsers retain the existing open action. Windows exposes its native chooser rather than a fabricated app list. Existing release signatures, account authorization and rollback remain independent from document-quality checks.

Unit and component tests cover native path containment, preservation of existing files, annotation replay and selection, explicit update transitions, and preference readback. Actual packaged-client, system-application and upgrade evidence belongs to the product release record; source tests do not stand in for those observations.
