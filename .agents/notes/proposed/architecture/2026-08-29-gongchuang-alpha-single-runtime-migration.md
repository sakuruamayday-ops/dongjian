# Agent Note: Gongchuang alpha single-runtime migration

Status: proposed

English | [中文](2026-08-29-gongchuang-alpha-single-runtime-migration.zh.md)

## Problem

Gongchuang V0.3.3 runs on DeepSeek Harness `dsh-v0.1.1-rc.2` and extends its profile boot, Remote APIs, workspace and session projections, desktop lifecycle, and product UI. DeepSeek Harness `dsh-v0.1.2-alpha.1` replaces several of those APIs. Updating package versions without moving the product extensions would either fail to start or silently lose enterprise workspaces, archived and pinned conversations, attachments, automation sessions, model connections, or signed runtime policy. Keeping RC.2 beside Alpha would preserve behavior temporarily but would create two runtime owners for the same durable data and update lifecycle.

## Proposal

V0.4.0 uses `dsh-v0.1.2-alpha.1` as its only Harness source and runtime. Gongchuang product services move onto the Alpha profile composition, Remote mount, session projection, workspace controller, conversation input, and slot APIs. Product-specific durable fields remain explicit extensions of the Alpha workspace and session contracts instead of a second client runtime.

The candidate keeps the existing desktop user-data directory, `persist:gongchuang-v0.1` Electron partition, credential stores, enterprise workspace roots, signed product policy, signed runtime and skill verification, and authenticated loopback origin. A V0.3.3 installation upgrades through the existing signed update transaction. Upgrade verification compares the pre-upgrade and post-upgrade account state, workspace and conversation identities, archive and pin state, attachments, automation bindings, credentials, and update history before production metadata may select V0.4.0.

The product manifest owns both identities: `productionBaseline` remains the published V0.3.3 release, while the candidate client and upstream fields identify V0.4.0 and the exact Alpha commit. Runtime request attribution derives from the candidate version source instead of embedding a product version in individual connectors.

## Alternatives considered

**Remain on RC.2 until a stable upstream tag.** Rejected because the product decision is to follow each upstream release, including Alpha, and validate it as a product candidate rather than treating prerelease status as an automatic blocker.

**Ship RC.2 and Alpha together.** Rejected because two profile boots, client runtimes, or persistence owners could disagree about session projection, credentials, updates, and enterprise workspace state. It would also turn a bounded migration into an indefinite compatibility burden.

**Add a long-lived RC.2 compatibility layer over Alpha.** Rejected because all current consumers can move to Alpha's native APIs. A compatibility layer would retain deleted interfaces without an independent consumer or removal condition.

## Acceptance criteria

- Host and client TypeScript aggregates compile with one Alpha dependency graph and no `dsh-client-runtime` import.
- Product tests cover profile trust, mounted product Remotes, workspace and session extensions, model refresh, attachments, automation, MCP connectors, signed policy, and desktop update behavior.
- A sanitized copy of real V0.3.3 durable data opens and rewrites under the Alpha storage backend without losing any product-owned state.
- An isolated packaged V0.3.3 client completes the signed in-client upgrade to the V0.4.0 candidate while preserving login and product data.
- macOS arm64, macOS x64 under Rosetta, and Windows x64 candidate artifacts pass their architecture, integrity, runtime, skill, document, and lifecycle checks before production metadata changes.

## Risks

Alpha APIs may change again, so the next upstream update can require another direct migration. The single-runtime decision keeps that cost visible and bounded but gives up the ability to defer it behind a compatibility facade. Direct-update evidence must come from isolated packaged applications because source-level tests cannot prove application replacement, credential persistence, or restart behavior.
