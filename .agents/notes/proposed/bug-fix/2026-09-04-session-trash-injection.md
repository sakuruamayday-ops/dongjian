# Agent Note: Session Trash Persistence Access

Status: proposed

English | [中文](2026-09-04-session-trash-injection.zh.md)

## Problem

The installed V0.4.4 candidate fails to delete an archived synthetic Session with `cannot get property "sessionPersistence" without inject`. Direct-constructor tests supplied a root Context and missed the scoped Cordis access rule. The same access is present in cold and owned-live disposal.

## Proposal

Keep persistence optional for the controller's other supported APIs. The Host artifact-deletion method resolves it with `ctx.get` and requires it before lifecycle changes, then retains the exact service through writer retirement. Do not bypass flush, ownership checks, retirement, or the recoverable Trash transaction.

## Alternatives considered

Requiring persistence for the whole controller would narrow unrelated in-memory APIs. Catching the injection failure and moving files would bypass writer retirement and risk data loss. Neither is needed.

## Acceptance criteria

Verification uses the shipped Loader composition for cold and live Sessions, focused lifecycle tests, and installed-client deletion of authorized synthetic data. Native success requires absence from the archive list and a matching recoverable artifact in the system Trash. Source checks are not native acceptance or publication evidence.

## Risks

The native tests must not delete customer data. Missing persistence must continue to reject artifact deletion before flushing or disposing a live Session.
