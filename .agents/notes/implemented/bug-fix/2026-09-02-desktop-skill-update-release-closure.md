# Agent Note: Desktop skill update release closure

Status: implemented

English | [中文](2026-09-02-desktop-skill-update-release-closure.zh.md)

## Problem

The desktop client and the independently released skill suite have separate version lifecycles, but a formal skill release could finish on GitHub, the knowledge portal, and the local installation without advancing the desktop update feed. The client then correctly reported its bundled suite as current even when a newer formal suite existed. A generic distribution archive could not repair the feed because it has a wrapper directory and a different projection contract. An early recovery archive also carried the bundled-only `config/common.yaml`; server-side signature checks accepted it while the released V0.4.1 updater rejected the extra root entry.

## Decision

An independent desktop update is built from the formal client projection with an explicit expected version. Its ZIP contains exactly `skill-bundle-index.json`, `skill-bundle-index.sig`, `skill-bundle-index.pub.pem`, `staging-receipt.json`, and the files declared by the signed index under `skills/`. Bundled-only resources do not enter this archive.

Every formal generic skill release supplies this desktop archive as a separate participant in the signed release transaction. After the generic portal release, GitHub publication, and local synchronization succeed, the server publisher verifies the transaction binding, pinned Ed25519 public key, version, complete file inventory, and existing generic portal release before atomically advancing the desktop feed. The release command then downloads the public manifest and exact archive, compares the transaction-bound digest, and runs the same archive validator before completing.

The released client remains the final compatibility authority. Recovery and regression acceptance therefore run the V0.4.1 `SkillUpdaterController` through discovery, download, verification, activation preparation, and commit; a server-only validator is necessary but not sufficient. This decision extends the independent update boundary recorded in [Gongchuang focused sidebar and desktop settings](../feature/2026-08-15-gongchuang-focused-sidebar-and-desktop-settings.md).

The settings page reads the active local suite through a separate read-only desktop IPC call. Online discovery never substitutes a compiled bundled version when the active suite cannot be read. A failed discovery, including HTTP 404, is an unavailable source, not evidence that the installed suite is latest; a previously known installed version remains visible without a green latest claim.

Independent ZIP generation fixes entry timestamps to the ZIP epoch in local DOS time so identical signed inputs produce identical bytes across build timezones. The server holds one channel-wide filesystem lock from reading `latest.json` through the immutable archive check and atomic manifest replacement. Per-version leases do not serialize different versions competing for that shared pointer. The lock file remains in place so contenders cannot acquire different inodes.

Device acceptance reads the candidate skill identity from release configuration or explicit manifest arguments. Neither platform's runner defaults to the last released skill version or file count. Product identity tests also distinguish the candidate from the still-active production release until the publishing transaction succeeds.

## Alternatives considered

**Advance the feed manually after each release.** Rejected because the omitted V1.6.13 through V1.6.16 feed updates showed that an unbound follow-up step can silently drift from the formal release transaction.

**Serve the generic GitHub ZIP to the client.** Rejected because its wrapper layout, standalone distribution contents, and signature boundary do not match the desktop updater contract.

**Accept every file covered by the staging directory.** Rejected because the V0.4.1 consumer intentionally accepts a closed archive shape; including an unsigned or bundled-only root resource turns a valid download into an unusable update.

## Consequences

Future formal skill releases cannot complete without a separately signed desktop projection and a successful public readback. The same-version archive is immutable and feed downgrades are rejected. Operators must build one additional artifact and preserve its transaction evidence, but clients can discover a newer suite without requiring a new desktop binary. The public feed is still an availability dependency, while signature and file-inventory verification remain local fail-closed protections.

The 2026-09-03 local correction is tested separately from the historical V0.4.1 release receipt. Local controller, browser, reproducible-archive, and concurrent-publisher results do not constitute a new deployed client or server release.
