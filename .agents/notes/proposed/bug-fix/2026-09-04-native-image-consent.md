# Agent Note: Native Image Transfer Consent

Status: proposed

English | [中文](2026-09-04-native-image-consent.zh.md)

## Problem

The desktop dialog promises to remember an explicitly approved provider, but origin-local storage loses that approval when a restart assigns another loopback port. Native testing reproduced another OpenCode Go confirmation after restart.

## Proposal

Keep the current provider-specific confirmation and browser fallback. The Electron owner persists only approved provider IDs in a private atomic file under user data. Its IPC accepts calls only from the current main window. Read or write errors reject the send while preserving its draft. Pending sends remain cancelled if the user cancels, closes the controller, or changes providers before storage completes.

## Alternatives considered

- Pin the renderer port: rejected because unrelated port availability must not determine whether a privacy choice survives.
- Remove the confirmation: rejected because persistence does not authorize image transfer to an unapproved provider.
- Move credentials or image bodies into consent storage: rejected because neither is needed to remember the decision.

## Acceptance criteria

- A fresh store restores only explicitly approved providers; invalid persisted data cannot be overwritten by an implicit grant.
- Storage failures, concurrent writes, cancellation, disposal, and provider changes have focused regression tests.
- The Loader-composed UI cancels without consuming the draft, saves after approval, and sends from a cold browser without asking again.
- The signed native candidate repeats this sequence across a normal exit and a changed loopback port; credentials remain unchanged.

## Risks

This change does not infer earlier approvals from inaccessible browser origins. The first send on the new native store can ask once. It adds no permission for a different provider and does not change the upstream image lifetime or delivery pipeline.
