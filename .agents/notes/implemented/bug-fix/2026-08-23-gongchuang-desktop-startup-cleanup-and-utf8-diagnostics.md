# Agent Note: Gongchuang desktop startup cleanup and UTF-8 diagnostics

Status: implemented

English | [中文](2026-08-23-gongchuang-desktop-startup-cleanup-and-utf8-diagnostics.zh.md)

## Problem

The V0.2.2 desktop could retain an obsolete V1.6.8 activation failure in `skill-updates/state.json` after a newer signed suite became bundled, and an interrupted or completed download could leave a 12.5 MiB `skill-suite.zip` under `staging`. Windows PowerShell 5.1 and legacy log readers also interpreted BOM-less UTF-8 Chinese as the active ANSI code page, producing mojibake in acceptance output and the main-window title log. On the reported Windows device, startup spent about 97 seconds verifying the 10,508-file signed runtime because directory classification and file reads were fully synchronous.

These are separate symptoms of startup ownership. The bundled suite owns whether an older update failure is still actionable, the updater owns its transient downloads, the desktop owns the encoding of its diagnostics, and the runtime verifier owns startup I/O without relaxing the signed file contract.

## Decision

Skill update failures carry the exact failed semantic version. `resolveSkillBundleForLaunch` selects and verifies the effective suite but does not clear an obsolete error before that suite has actually started. After the complete runtime starts, `commitSkillBundleLaunch` reconciles every launch, records `lastSuccessVersion` and `enabledAt`, clears errors at or below the effective version, and retains failures and downloads for strictly newer versions. The atomic state rewrite is explicitly UTF-8, so a successful launch also replaces a legacy ANSI or GBK error record with canonical UTF-8 JSON.

Downloaded ZIP bytes remain in memory through verification and extraction; no `skill-suite.zip` is written to staging. A verified download leaves a UTF-8 `activation-receipt.json` in its transaction directory until the suite starts successfully. After successful launch reconciliation, the host moves receipt-bearing transactions for the effective version and all older historical staging transactions through Electron's recoverable operating-system trash API. A failed transaction for the effective or a newer version remains available for retry and diagnosis. Installed `versions/*` directories are never cleanup targets and remain available for recovery.

The desktop prefixes `main.log` with a UTF-8 BOM before its first application log line and repeats that preparation after log rotation. The Windows acceptance PowerShell scripts themselves carry a UTF-8 BOM, set console input and output encoding to UTF-8, and read their JSON manifest explicitly as UTF-8. Product text remains Chinese Unicode; it is not transcoded to GBK.

Startup runtime verification still validates the Ed25519 signature, pinned public-key fingerprint, product identity, version, platform, architecture, signing tier, exact file and link sets, every file's SHA-256 digest, executable identity, PaddleOCR MCP, and document dependency closure. Directory traversal uses `Dirent` metadata, and startup file hashing uses a bounded worker set derived from `availableParallelism()`. The synchronous verifier remains available to packaging and release scripts.

## Verification

Unit coverage reproduces the V1.6.8 failure record, old version directory, staged ZIP, and legacy non-UTF-8 error bytes. It proves that the record remains untouched until V1.6.9 completes startup, then becomes UTF-8 success state while the installed V1.6.8 directory remains. Download coverage proves that a verified transaction carries a success receipt without a persisted ZIP, successful and historical transactions enter recoverable test trash, and failed current or newer transactions remain. Separate tests pin exactly one BOM for fresh and existing logs, UTF-8 PowerShell envelopes, normal concurrent runtime verification, and fail-closed behavior after file tampering.

On the existing formally signed Windows x64 runtime copy, both verifier paths accepted the same 10,508 files and index SHA-256. The first local synchronous run took about 1,092 ms and the concurrent run about 350 ms; warm-cache runs took about 371 ms and 345 ms. This measurement proves local improvement and equivalent identity, not the reported Windows device's cold-start result. That device must measure the V0.2.3 candidate before the 97-second defect can be called closed in production.

## Alternatives considered

**Cache or skip full-tree verification after one successful launch.** Rejected because files can drift between launches through disk corruption, antivirus quarantine, or modification. A cache would weaken an existing integrity boundary and would not prove the current bytes.

**Verify only executables or a sample of runtime files.** Rejected because Python source, metadata, licenses, and imported modules are part of the signed runtime contract. Sampling would turn exact integrity into probabilistic detection.

**Move every staging and installed version directory to trash after launch.** Rejected because failed staging is needed for retry and diagnosis, while installed versions preserve recovery material. Only successful or superseded staging transactions are cleanup candidates, and cleanup remains recoverable through operating-system Trash or Recycle Bin.

**Clear an obsolete error as soon as the bundled suite verifies.** Rejected because signature verification alone does not prove that the complete runtime can start with that suite. Success state is committed only after runtime startup returns successfully.

**Write logs and scripts as GBK on Windows.** Rejected because GBK cannot represent the product's full Unicode text consistently and would create a platform-specific diagnostic format. A UTF-8 BOM addresses the legacy reader ambiguity while preserving one encoding across platforms.

## Consequences

Obsolete skill failures no longer survive a successful launch of the same or a newer suite, while a real newer failure remains visible. Historical staging does not accumulate after an upgrade, but current failed transactions and installed rollback versions consume disk until a later successful upgrade or user recovery action. Chinese diagnostics and state files use UTF-8, and BOM-aware legacy readers open the main log correctly. Startup performs the same complete cryptographic and file-set checks with fewer filesystem round trips and overlapping reads, at the cost of holding the downloaded skill archive in memory and allowing several runtime files to be read concurrently. The exact Windows cold-start improvement remains a candidate acceptance measurement rather than a source-code assertion.
