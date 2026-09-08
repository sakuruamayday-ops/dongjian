# Agent Note: Gongchuang V0.2.4 release candidate identity

Status: implemented

English | [中文](2026-08-24-gongchuang-v024-release-candidate-identity.zh.md)

## Problem

The desktop packages and product constants previously carried the production version while new user-visible behavior was already present in source. Reusing the production identity for a new package would make update comparison and release evidence ambiguous, but replacing the production record before deployment would falsely report an unreleased build as current.

## Decision

The product manifest records two independent facts. `productionBaseline` remains the verified V0.2.3 release, including its source commit and server release id, until the production transaction finishes. `client` and every build-facing version source identify the new V0.2.4 candidate. Contract tests require this separation and require package, application, policy, and acceptance-script versions to follow the candidate identity.

V0.2.4 macOS packages require local arm64 and Rosetta x64 acceptance before deployment. Acceptance uses isolated install and user-data locations; after evidence is archived, temporary applications, mounted images, user data, and drill directories move to the macOS Trash. The Windows package is released after static architecture and embedded-integrity acceptance under the owner's unsigned-risk exception; a pre-release Windows device receipt is not required, and device feedback is recorded after release.

After the server transaction succeeds, the release evidence supplies the immutable V0.2.4 source commit and server release id, and `productionBaseline` advances in a follow-up metadata commit. GitHub installer assets are not part of this release authority.

## Alternatives considered

**Change `productionBaseline` to V0.2.4 before packaging.** Rejected because it would erase the accurate current-production fact before the server accepted any V0.2.4 artifacts.

**Keep all package versions at V0.2.3 until deployment.** Rejected because the updater would treat materially different artifacts as the existing release and could not establish a unique candidate identity.

**Wait for a Windows device receipt.** Rejected by the owner for this release; static package evidence and explicit unsigned-risk disclosure remain required.

## Consequences

Candidate packages have one semantic version across platforms while production metadata remains truthful during preparation. The follow-up baseline update is an evidence backfill, not a second client release. Local Mac acceptance no longer leaves installed test applications or temporary user data behind.
