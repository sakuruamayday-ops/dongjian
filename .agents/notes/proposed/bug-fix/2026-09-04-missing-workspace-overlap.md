# Agent Note: Missing Historical Workspace Overlap Paths

Status: proposed

English | [中文](2026-09-04-missing-workspace-overlap.zh.md)

## Problem

Native V0.4.4 acceptance reproduced archived workspace deletion failing with ENOENT. The selected synthetic workspace exists, but five old registrations reference directories already removed outside the current deletion. Main-process overlap validation canonicalizes every registration; one absent unrelated path aborts the whole transaction before Trash begins.

## Proposal

Resolve an absent overlap candidate through its nearest existing ancestor and retain its missing suffix. Continue checking the resulting path for nesting. Only ENOENT receives this treatment. Target existence, target identity, system-wide directory protection, installation separation, other filesystem errors, and the existing recoverable Trash journal are unchanged. No registry records or user files are silently removed during validation.

## Alternatives considered

- Ignore all canonicalization failures: rejected because permissions and malformed paths must remain failures.
- Filter absent registrations: rejected because a missing nested registration should still prevent deleting its parent.
- Recreate old directories: rejected because validation must not alter unrelated data.

## Acceptance criteria

- An unrelated absent registration does not prevent the selected workspace deletion.
- An absent nested path, including one below a symlinked ancestor, still blocks parent deletion before journal creation.
- Missing targets and non-directory paths remain rejected.
- A real-directory composition preserves attachment bytes through a simulated Trash move; the signed installed App must additionally complete the authorized native workspace deletion.

## Risks

Filesystem changes during a deletion remain subject to existing final target validation. Source tests and native acceptance are reported separately. This note does not authorize formal publication or any deletion outside the approved synthetic data.
