---
description: "Constrained executor for operations declared by the active signed Gongchuang skill suite."
kind: "package-reference"
---

# @gongchuang/signed-skill-runtime

English | [中文](README.zh.md)

## Summary

Host-owned executor for fixed operations in the active signed 共创 skill suite. It binds the operation registry version to the exact suite version already verified by the desktop Host, verifies every referenced skill file against that immutable file inventory, accepts only the manifest's closed parameters, confines paths to the active enterprise workspace, sanitizes the child environment, and invokes a fixed isolated runtime without a shell or network access. Manifest scripts use the bundled verified Python interpreter. After that signed detector identifies an OLE Word document, the exact workspace-document read operation may use a Host-owned Node subprocess for text extraction; the untrusted document is never parsed in the Electron main process.

## Table of Contents

- [Behavior](#behavior)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Behavior

The model cannot submit a command, script path, interpreter, environment variable, URL, or arbitrary argument vector. An operation runs only after the policy gate confirms that the owning skill was activated in the current turn; ordinary file reading does not require a professional-report workflow.

The tool description separates `parameterSchema` from call values and projects workspace-file parameters as strings. In PTC mode, the model loads the owning skill through `tools.skill` inside `run_code`, then calls the operation with actual workspace paths. A copied schema or `{path: ...}` object is rejected with the offending parameter name before a subprocess starts. Partial extraction keeps readable text and identifies OCR pages; it does not justify repeating a successful extraction.

## Dev Note

The signed desktop Host supplies the verified suite inventory, bundled Python interpreter, and fixed legacy-Word adapter; this package accepts neither arbitrary commands nor ambient runtimes.

One V1 file parameter may declare up to 32 distinct extensions so the signed Office intake registry can include template families such as `.dotm`, `.xltx`, and `.xltm`. This is an allow-list capacity, not a format claim: the signed detector still decides the actual container kind and whether a safe extractor exists.

## Runtime Invariant

No runtime invariant companion is published because the existing tool call and tool result records already capture each operation and its bounded Host result.

## Model Experience

### Signed skill operation

#### What the model sees

The package registers one `gongchuang_skill_operation` tool. Its description projects each verified operation's id, owning skill, purpose, and complete required parameter names, types, and limits into both the native schema and the PTC SDK. The model activates the named skill and calls the operation with workspace paths; it does not need to locate an installed manifest, script, or interpreter. Executable paths and environment values remain private. A successful call returns the operation and skill identities, pass or reject status, bounded stdout and stderr, sandbox enforcement level, script and suite hashes, and embedded-runtime integrity. Operations that declare `stdout_json_schema_version` must emit exactly one JSON object with the matching `schema_version`; warning-only output, a prefixed warning, malformed JSON, or a mismatched schema is rejected even when the process exits zero. An unregistered operation, inactive skill, changed file, invalid parameter, path escape, sandbox failure, timeout, cancellation, unlisted exit code, or invalid structured stdout returns a tool error instead of falling back to a command runner.

#### Token effect

The fixed tool schema and verified operation instructions add a request-prefix contribution bounded by the manifest's operation and parameter limits. Only a model-invoked operation adds its bounded result tokens; local hash, path, sandbox, and process checks consume no model tokens.

#### KV Cache effect

An unchanged signed operation registry preserves the tool-schema prefix. Updating the active signed suite or its operation registry changes that prefix and intentionally prevents reuse after the changed position.

## Known Limitations and Deferred Work

- V0.1 accepts only operations declared by `client-runtime-operations.json`. Its scripts run in Python, except for the exact legacy Word document-read adapter, which uses a fixed Host-owned Node/Electron subprocess. Native helpers, package installers, arbitrary scripts, and networked operations remain excluded.
- The legacy adapter reads Word 97-2003 OLE documents. A `.wps` name is not treated as proof of format: an OLE container must successfully expose Word's `WordDocument` and selected `0Table` or `1Table` streams. Proprietary or damaged WPS binaries return a conversion-required or rejected result instead of guessed text.
- Workspace confinement relies on the platform sandbox's reported enforcement. A partial enforcement result is exposed in the operation receipt and cannot be represented as full isolation.
- The runner returns bounded process output and deterministic identities; each owning skill and the professional policy gate remain responsible for interpreting whether a rejected business result can be revised or must stop delivery.
