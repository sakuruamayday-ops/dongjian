# Agent Note: connector parallel startup and Windows footprint

Status: implemented

English | [中文](2026-08-24-connector-parallel-startup-and-windows-footprint.zh.md)

## Problem

Independent MCP connections were reconciled serially, and QCC repeated connection and discovery across ten endpoints in sequence. On Windows this accumulated network latency. The package also shipped every Electron locale, while the large signed Python runtime and application archive were sometimes mistaken for disposable cache.

## Decision

Independent top-level connectors reconcile concurrently. QCC connects and discovers its ten endpoints concurrently, then folds results in a deterministic configured order. Failures remain isolated per connector and no first-use dependency installation is added.

Windows packages retain only `zh-CN` and `en-US` Electron locales. The signed Python runtime, `app.asar`, and one updater pending installer remain because they provide offline document/OCR execution, application code, integrity verification, and recoverable updates.

## Alternatives considered

**Remove the bundled Python runtime.** Rejected because it would break offline Office/PDF, OCR, and signed-runtime guarantees.

**Delete update cache aggressively.** Rejected because one pending installer is part of recoverable update behavior and permanent deletion conflicts with workspace safety rules.

**Publish connector results in completion order.** Rejected because network timing would make tool order nondeterministic.

## Consequences

Connection latency can overlap while the projected tool order remains stable. The Windows unpacked package drops about 46 MiB of unused locales; remaining size is mostly real offline capability. Unit tests and cross-build measurements are complete, while native Windows startup/MCP timing and installed-size measurements remain device evidence.
