# Agent Note: Native selection and saved connection recovery

Status: proposed

English | [中文](2026-09-03-native-selection-and-connection-recovery.zh.md)

## Problem

Native paragraph selection can include the following action bar, causing an otherwise quotable assistant paragraph to lose its annotation action. A rejected replacement API key preserves the Host credential but clears the renderer's configured flag, hiding stored-key recovery. Reopening a saved custom connection also loses its editable endpoint fields.

## Proposal

Clip selected prose before the message action bar and source-annotation controls. A native selection ending in the following non-prose row's leading icons also clips back when it contains no text from that row. Preserve the known connection configuration during failed replacement, refresh, and snapshot requests. Return only validated editable endpoint fields in the existing redacted connection snapshot; never return keys or credential references. Initialize reopened forms from those fields without filling their key input.

Source fixes have focused regression coverage. Candidate-package native rechecks remain pending and this note does not represent a formal release.

## Alternatives considered

Disabling paragraph selection would remove an expected interaction. Treating a rejected replacement as an unconfigured provider contradicts the retained credential. Returning raw settings to populate the form would expose credential references and potentially secret-bearing legacy URLs.

## Acceptance criteria

Native paragraph selection offers an annotation containing prose only. A rejected replacement leaves stored-key recovery available. Reopened custom and editable managed connections retain the saved address and model id, with empty key fields. Valid key replacement survives process restart and subsequent dispatch. Connection transport failures settle visibly instead of retaining a loading state.

## Risks

These are source changes pending native candidate verification. The existing signing, release, credential rollback, and provider-probe requirements remain unchanged.
