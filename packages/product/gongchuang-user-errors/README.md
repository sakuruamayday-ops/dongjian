---
description: "Redacted user-facing error catalog and diagnostic formatter for the Gongchuang desktop client."
kind: "package-reference"
---

# @gongchuang/user-errors

English | [中文](README.zh.md)

## Summary

Shared error presentation for the 共创 desktop Host, account and model services, and product UI. User-visible failures are classified into a small Chinese message catalog with diagnostic codes. The returned values never copy an upstream message, stack, cause, local path, or credential.

## Table of Contents

- [Behavior](#behavior)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Behavior

`gongchuangDiagnostic` is for existing trusted local logs only. It retains enough error structure for diagnosis while redacting common API keys, authorization values, secret-bearing query fields, and macOS, Linux, or Windows user paths.

## Dev Note

Callers choose a stable diagnostic code and keep full technical details only in the existing trusted local log path.

## Runtime Invariant

No runtime invariant companion is published because this package is pure error classification and redaction with no mutable state or events.

## Model Experience

### Redacted user errors

#### What the model sees

Nothing. The `gongchuangDiagnostic` formatter classifies and sanitizes errors for the Host, trusted local logs, and product UI without registering model context or tools.

#### Token effect

None. Error presentation and diagnostic logging do not create model requests.

#### KV Cache effect

None. Error presentation and diagnostic logging do not alter model requests or session history.

## Known Limitations and Deferred Work

- Classification is intentionally conservative. Unknown failures use a surface-specific recovery message and diagnostic code; support staff must use the redacted local log for technical diagnosis.
