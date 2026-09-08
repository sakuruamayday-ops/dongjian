# Agent Note: Gongchuang immutable Python and Windows startup

Status: implemented

English | [中文](2026-08-25-gongchuang-immutable-python-and-windows-startup.zh.md)

## Problem

The desktop put its formally signed embedded Python directory at the front of the process-wide `PATH`. An allowed PowerShell task could therefore resolve the bundled `pip` and install packages into the application resources. The exact signed-file verifier correctly rejected the resulting extra files on the next launch, but the damaged client could not reach its updater because integrity verification intentionally runs before update configuration. The reported Windows installation also opened a new PowerShell process and compiled the Credential Manager adapter for every credential read, while the packaged application retained source maps and generated development output that increased unpack and antivirus work.

The integrity failure was not a reason to weaken verification. The runtime needed to become unavailable as a general command-line environment, and a failed startup needed a verified full-installer recovery path that did not depend on the damaged runtime.

## Decision

The desktop no longer exports the embedded Python executable or prepends its directory to `PATH`. Owned document and OCR operations continue to receive the absolute signed interpreter path through their typed runtime binding. The child environment disables user site packages and bytecode writes and requires a virtual environment for any separately invoked `pip`. Formal runtime staging removes `pip`, its distribution metadata and launchers, and `ensurepip` before computing the exact signed file index. It retains the Python standard library, document dependencies, PaddleOCR dependencies, and setuptools modules required by shipped consumers.

Packaged startup failures continue to fail closed. Their dialog now offers a full repair installer from a stable portal route for the current published macOS arm64, macOS x64, or Windows x64 artifact. The server selects only the current published release, verifies the registered path, size, SHA-256, and signature status, and streams the full DMG or EXE with no-cache headers. The old application does not install an unverified archive or bypass startup integrity; the user runs the verified full installer through the normal operating-system flow.

Windows Credential Manager uses one lazily started hidden PowerShell session per provider lifecycle. The session loads the native adapter once, accepts serialized newline-delimited JSON operations on standard input, never places secret values in process arguments, bounds every request, and restarts after a malformed response or process failure. Provider disposal closes the session after queued credential operations complete.

The desktop archive excludes source maps, TypeScript compiler state, coverage directories, and nested generated output. The package verifier rejects those paths if they reappear. Native editable context menus keep Paste enabled even when Chromium's clipboard capability probe incorrectly reports an empty Windows clipboard; Chromium remains responsible for the actual paste operation and an empty clipboard remains a no-op.

## Verification

Runtime staging tests prove that the signed index excludes `pip`, `ensurepip`, their metadata and launchers while retaining required Python modules. Startup tests prove that packaged integrity failure offers only the stable platform repair route and does not weaken the original failure. Portal tests accept the three supported artifacts and reject unsupported architectures or an artifact whose signature status is not releasable. Credential tests cover one session, serialized secret-safe requests, failure restart, timeout, and lifecycle close. Archive and context-menu tests reject development payloads and preserve Paste when the clipboard probe is false.

Formal release acceptance still verifies the full runtime and skill file sets, every SHA-256 digest, Ed25519 identities, native architecture, archive contents, and macOS application signatures. macOS arm64 runs on the current device and macOS x64 runs under Rosetta; Windows receives cross-built static acceptance and post-release owner feedback under the existing unsigned-release exception.

## Alternatives considered

**Cache a previous verification result or tolerate extra runtime files.** Rejected because either choice would weaken the existing exact integrity guarantee and make package mutation indistinguishable from corruption or quarantine.

**Keep bundled `pip` but hide it only from the interface.** Rejected because any allowed shell that inherits the process environment could still resolve and mutate the signed runtime.

**Repair individual runtime files in place.** Rejected because partial repair would need a second trusted dependency resolver and could leave the application with a mixture of versions. The full installer already carries one signed, exact application image.

**Start PowerShell once for every credential request.** Rejected because it repeats process creation and `Add-Type` compilation during startup without adding isolation: all requests already execute under the same desktop user and Credential Manager authority.

**Disable Paste when the clipboard probe is false.** Rejected because the probe is not authoritative on reported Windows configurations. Letting Chromium execute Paste preserves native semantics without reading clipboard contents in application code.

## Consequences

Model tasks cannot install packages into the signed embedded runtime through ordinary `python` or `pip` resolution, and the formal runtime contains fewer small files. A damaged pre-V0.2.7 installation still needs one manual full reinstall because old binaries do not contain the new repair action; V0.2.7 and later can open the stable verified installer route after a fail-closed startup error. Windows startup avoids repeated PowerShell initialization, and archives omit development-only bytes, but cold-start time on a real Windows device remains an observed post-release measurement rather than a source-code promise. The decision extends, and does not replace, the exact startup reconciliation described in [Gongchuang desktop startup cleanup and UTF-8 diagnostics](2026-08-23-gongchuang-desktop-startup-cleanup-and-utf8-diagnostics.md).
