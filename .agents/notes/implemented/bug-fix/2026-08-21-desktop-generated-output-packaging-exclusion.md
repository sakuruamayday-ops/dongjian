# Agent Note: Desktop generated-output packaging exclusion

Status: implemented

English | [中文](2026-08-21-desktop-generated-output-packaging-exclusion.zh.md)

## Problem

Electron Builder evaluates application-root files and dependency files through different effective pattern lists. A platform-specific `files` list that excludes only `release/**` can admit a renamed sibling such as `release.previous-*`, even when the common list contains a broader exclusion. The resulting `app.asar` recursively embeds an earlier application, DMG, ZIP, runtime, and skill suite, so each distributable grows by gigabytes without a source or dependency change.

Source tests, types, Git status, and dependency locks cannot observe this failure because the admitted directory is untracked generated output and the faulty file set exists only after Electron Builder resolves platform-specific patterns.

## Decision

The desktop build starts the macOS and Windows application-root lists with the positive `dist/**` and `package.json` entries, then excludes `release*/**`, `output/**`, and platform-incompatible native dependencies. The positive entries prevent Electron Builder from supplying its broad default root match. Repeated platform exclusions are intentional because Electron Builder uses those lists for application-root matching instead of treating the common list as the sole authority.

The `afterPack` hook inspects the completed `app.asar` before DMG, ZIP, or NSIS targets are generated. It rejects a missing archive, a physical archive or header-declared logical payload above 512 MiB, or any top-level entry other than `dist`, `package.json`, and `node_modules`. Counting the logical payload covers native files placed in `app.asar.unpacked`. The allowlist prevents generated output, desktop source, tests, scripts, and contributor documentation from entering a release. The size ceiling leaves substantial headroom over the packaged application while stopping recursive artifact inclusion before large distributables consume disk or reach a release channel.

The archive inspection uses the declared `@electron/asar` dependency and reads the header without extracting payloads. The same check runs for macOS and Windows. On macOS the hook only verifies content: it never signs or changes the application bundle. Electron Builder applies any Electron fuses after the hook and then performs the one final native ad hoc signing pass through `mac.identity: "-"`; hardened-runtime entitlements disable library validation because an ad hoc identity has no stable team. The signed product runtime already contains valid Mach-O signatures and an Ed25519 index over its exact bytes, so `mac.signIgnore` excludes only `Contents/Resources/product/runtime/files` from Builder's nested-code rewrite while the outer App still seals that tree as resources.

The verification-only `afterSign` hook runs the shared runtime and skill verifiers against the final App and checks `codesign --verify --deep --strict` before DMG and ZIP generation. This gate exists because a real package passed source tests and code-sign verification while Builder had changed runtime dylib bytes after the Ed25519 index was made; ordinary source tests and pre-sign input verification cannot observe that ordering failure. DMG and ZIP targets consume the verified sealed application without another bundle mutation. Windows ConPTY quarantine remains a Windows-only pre-target preparation.

## Alternatives considered

**Always move earlier release directories outside the repository before building.** Rejected because packaging correctness would depend on an operator cleanup step, and an interrupted or resumed release could recreate the same fault.

**Assert only the package configuration strings in unit tests.** Rejected because the original common exclusion was already present while Electron Builder's effective application-root list still admitted the directory.

**Reject only oversized DMG and ZIP files after target generation.** Rejected because the nested application has already consumed build time and disk by then, and compressed target size is a weaker diagnostic than the application archive that caused it.

**Run `codesign --deep` inside `afterPack`.** Rejected because it bypasses Electron Builder's nested-code signing plan and signs before the builder's final fuse stage. The packager owns the final signing order; the hook owns only application-content validation.

## Consequences

Desktop packaging fails before distributable generation when an unapproved application-root entry enters `app.asar`, application code unexpectedly exceeds the ceiling, or final macOS signing changes an indexed product payload. A legitimate future top-level application directory or payload above 512 MiB requires an explicit reviewed change. Focused tests cover accepted archives, unexpected directories, the size limit, hook wiring, and the positive and negative file-list rules; release acceptance still checks final architecture, digest, embedded runtime, embedded skills, launch, and document generation.
