# Agent Note: Keep digests only where a consumer verifies them

Status: implemented

English | [中文](2026-08-20-consumer-owned-digests.zh.md)

## Problem

Gongchuang client paths accumulated SHA-256 values that no later consumer checked, or used digest shape as a proxy for authority or page uniqueness. Those values added I/O, durable state, and failure conditions without preventing a concrete integrity failure. The same codebase also contains load-bearing digests inside signed release indexes, artifact bindings, content-addressed installation identities, and caches, so indiscriminate removal would weaken real security and correctness checks.

## Decision

A digest remains only when a named consumer verifies identity, integrity, cache ownership, or content addressing. Signed runtime and skill indexes, update manifests, formal-artifact bindings, archive installation identities, and OCR or attachment caches keep their digests.

Document import returns only the copied name, workspace-relative path, and byte count. Community-skill registry rows retain their source, archive identity, configuration state, and metadata, but no unused manifest digest or per-file digest inventory. Registry reads discard those legacy fields before the next write.

Professional source classification never treats a 64-character digest as evidence of authority. A government URL or a current-turn Host receipt plus the declared source class carries that decision. The Host-derived digest still binds the exact trusted-tool output, but it cannot upgrade an arbitrary source into an official one. Visual receipts continue to require valid page numbers, dimensions, and PNG digest syntax; different page numbers may legitimately render identical pixels and therefore may share a PNG digest.

The desktop skill stager omits each skill's standalone `release-manifest.json`, detached signature, publisher key, and signature metadata. Independent skill distributions retain and verify those files. Inside the client, the single Host-pinned Ed25519 bundle index covers every staged runtime file. A client-only projection also removes the managed portable-runtime block from staged `SKILL.md` files, so activation never asks the model to run a `prepare` command whose standalone proof files are intentionally absent. The current V1.6.7 source stages 550 client files, with all 204 standalone-attestation copies and all standalone `prepare` directives absent while the signed top-level inventory is preserved.

Device acceptance emits one JSON receipt plus its logs and screenshots. It does not emit a same-directory digest sidecar that can be rewritten together with the receipt. The JSON records the formal signing tier and the runtime and skill indexes actually checked on the device. The evidence directory is review material, not a cryptographically authentic device attestation after transfer.

## Alternatives considered

- **Remove every SHA-256 value.** Rejected because signed indexes, downloaded artifacts, formal files, caches, and content-addressed installations have real consumers and concrete mismatch failures.
- **Keep unused values for possible future consumers.** Rejected because a future integrity feature must define its producer, consumer, failure behavior, and recovery path when it is introduced.
- **Make the device receipt self-signed or ship a signing secret.** Rejected because an unenrolled local key proves no release identity, while distributing a private release key would destroy the signing boundary.
- **Remove standalone skill signatures from every distribution.** Rejected because Codex, CodeBuddy, and other independent installations still require per-skill publisher verification.

## Consequences

- Import avoids a second full-file read, and community registry writes are smaller without changing user-visible installed state.
- Existing registries remain readable; their obsolete digest inventories disappear on the next mutation.
- Local official documents and lists require a bound Host receipt, while government web sources remain recognizable by their government URL.
- Identical blank or intentionally repeated rendered pages no longer fail solely because their PNG bytes match.
- A newly staged client skill bundle and its acceptance inputs must use the 550-file signed index. Existing 752-file candidates and historical receipts remain historical evidence and are not rewritten.
- Standalone skill packages keep their existing Ed25519 preparation flow. The client receives a separately signed instruction projection and retains its top-level signed integrity boundary.
