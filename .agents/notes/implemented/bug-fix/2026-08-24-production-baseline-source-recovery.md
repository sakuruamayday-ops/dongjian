# Agent Note: production baseline and source-history recovery

Status: implemented

English | [中文](2026-08-24-production-baseline-source-recovery.zh.md)

## Problem

Production receipts and artifacts identified V0.2.3 from source `cf827c8624…`, but the canonical review repository still exposed V0.1.4 package and manifest identities and could not resolve that source object. The GitHub main branch stopped before the V0.2.3 release chain, so a correct binary release was not reproducible from the declared source repository.

## Decision

The exact published source object is restored to `gongchuang/main`. The canonical documentation branch and release chain are joined by a two-parent commit so neither history is discarded. `product-manifest.json` owns a machine-readable `productionBaseline` containing client 0.2.3, formal skill 1.6.9, RC.2 commit `b150a551…`, source `cf827c8624…`, and server release id 6. Contract tests compare desktop/package/product constants against that baseline instead of another hard-coded version string.

## Alternatives considered

**Change only documentation labels.** Rejected because the published source object would still be absent and future builds could not recover the release.

**Rebuild and republish V0.2.3.** Rejected because the existing production artifacts and update manifests already agree; the defect was repository history and version consumption, not binary identity.

**Name the dirty next candidate V0.2.4.** Rejected because no version decision, artifacts, or release transaction exists.

## Consequences

The remote repository resolves the published V0.2.3 source, current product consumers share one production baseline, and the divergent Chinese documentation history remains intact. The repair does not create a GitHub Release, deploy the server, switch update sources, or require a V0.2.3 republish. Future candidate versioning remains an explicit release decision.
