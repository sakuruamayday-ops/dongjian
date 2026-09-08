# Agent Note: Gongchuang ownership after DeepSeek Harness alpha.3

Status: implemented

English | [中文](2026-09-01-gongchuang-alpha3-ownership.zh.md)

## Problem

Gongchuang adds enterprise automation, relay model connections, accounts, attachments, signed skills, and desktop updating to DeepSeek Harness. A newer Harness release can add behavior with a similar name while covering only part of the product contract. Keeping both implementations creates competing owners, while deleting the product implementation by name alone breaks active consumers.

## Decision

V0.4.0 packages immutable Harness tag `dsh-v0.1.2-alpha.3` at commit `dd6322d604e00eec1ba5e0c8541159906a21094a`. This is the base for the current client version, not a permanent base. Each later client release audits the then-current official Harness release and advances when its public behavior can be integrated and verified. One client release packages one Harness base.

Harness owns physical connection recovery, Remote transport failures, Session read projections, loaded-turn navigation, prompt-content admission, steer and follow-up image delivery, deferred syntax highlighting, generic Windows atomic replacement, bounded stream queues, per-turn token and timing statistics, and JSONL Session persistence. Gongchuang does not carry a second implementation of those responsibilities. The product Session composition already uses JSONL, so alpha.3's removal of the unused upstream SQLite Session backend needs no user-data migration. Product graph-memory SQLite is a separate store and remains unchanged.

The product retains `@gongchuang/local-automation`, model connections, account and operating-system credential storage, enterprise workspace and attachment behavior, signed skills and policy, user-facing error redaction, model cost projection, and desktop updating. Alpha.3 does not supply their product contracts: durable task result conversations, the approved provider registry and refresh policy, device-bound login, enterprise deletion and draft references, Ed25519 admission, Chinese diagnostic guidance, list-price cost projection, or signed multi-platform installation.

Upstream Schedule remains a session-local reminder feature and is not Gongchuang automation's persistence or execution backend. Upstream generic model settings remain disabled as a second product entry; the product adapter consumes the shared model catalog and Remote APIs. Electron packaging validates required DeepSeek and Gongchuang workspace peers from the final `app.asar`; successful development-workspace resolution is not artifact evidence.

Ownership is behavioral. A product implementation is removed only when the official public interface, failure semantics, persistence lifetime, and packaged-device tests cover every active consumer. Design references and similar names are insufficient. Official ownership is preferred whenever that test passes; product code remains only for an uncovered current contract.

## Alternatives considered

- Keep alpha.2 for V0.4.0. Rejected because alpha.3 supplies reliable prompt-content and image admission, loaded-turn projection, deferred highlighting, and the current JSONL-only Session surface.
- Retain product duplicates of official alpha.3 behavior. Rejected because two owners can disagree on event order, retry lifetime, rendering, and persistence.
- Delete every Gongchuang package with a similarly named upstream feature. Rejected because the retained product contracts still have active consumers and no official equivalent.

## Consequences

Alpha.2 artifacts and receipts cannot prove the alpha.3 candidate. V0.4.0 rebuilds tests, package closure, old-session reopen and write-back, macOS arm64 and x64 lifecycles, Windows acceptance, document rendering, direct update, and public-release evidence from the frozen alpha.3 source commit.

The product remains one Harness runtime with product adapters, rather than a forked transport or persistence stack. Future Harness upgrades repeat the same ownership audit before product code is removed.

## Testing

The merge passes Remote and Controller tests, prompt and image admission, projections and turn navigation, product model, account, automation, workspace and attachment suites, complete Host and Client typechecks, final-archive workspace-peer closure, exact packaged boot, V0.3.3 media recovery, and the platform release matrix. Browser tests address the application shell through `data-app-frame`; CSS Module name fragments are not stable selectors once the official turn navigator contributes another `frame` class. A source-only green build does not prove an Electron packaging workaround removable or a downloadable application releasable.
