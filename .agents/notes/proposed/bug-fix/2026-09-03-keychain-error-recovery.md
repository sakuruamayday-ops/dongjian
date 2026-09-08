# Agent Note: Recover unreadable credentials without replacing them

Status: proposed

English | [中文](2026-09-03-keychain-error-recovery.zh.md)

## Problem

The signed native candidate displayed missing model keys and a logged-out account after an ad-hoc identity change. The encrypted credential file remained unchanged with its saved references and private permissions. The credential provider swallowed temporary Keychain errors into absence, which concealed retry controls and prevented the consumers from exposing an actionable failure. Repeated reference reads could each wait for the native authorization timeout. Connector reconciliation also failed to publish a per-connector error when credential description rejected.

A real scheduled run on September 4 reached its existing conversation and terminated, but admission-time credential reads escaped the account error conversion and became an English `UNKNOWN` turn failure. Password or device-id read failures also incorrectly cleared the saved-password presentation flag.

On September 5, a native model response succeeded while the shell retained its startup Keychain error. The recovery listener subscribed to the Host-only `session/event` on the Client Context, so neither recovery nor runtime model failures reached it.

## Proposal

Propagate temporary user-reference read failures through the existing credential API. Preserve the separate recoverable browser-cookie behavior. Share a temporary failure only through the current event-loop turn so the startup batch cannot repeatedly prompt, and permit later explicit retries to read the native store again. Keep model errors visible before adapter activation, show model and account retry actions without requiring new input, and isolate connector credential failures on their own cards. Do not erase stored keys, infer authorization, or bypass native consent.

Packaged macOS clients use a frozen native broker whose signed bytes and Keychain service remain identical across application releases. The broker accepts requests only from the valid product executable in the same App bundle, and secrets travel only over process pipes. One shared first-upgrade operation decrypts the complete legacy `safeStorage` snapshot sequentially, writes every entry through the broker, and records migrated or removed references. State updates are serialized across concurrent consumers. A failed authorization leaves the legacy ciphertext intact and permits an explicit retry. A reference already recorded as migrated never falls back to legacy ciphertext when its Keychain item is missing. Explicit removal commits the logical removal before broker cleanup and clears the legacy entry after cleanup, so a partial failure or rollback cannot revive it.

A model may recover access after the startup directory probe has failed. On the first real response of a turn, recheck only that response's provider if its visible failure is still `GC-MODEL-KEYCHAIN`. The existing Host probe owns the result; a response alone cannot assert catalog readiness. This is event-triggered once per turn, not periodic retries, and it cannot change the selected provider or stored key.

Observe live appends in the selected SessionBinding event source. Use its request header or model response for provider attribution, release the feed when selection changes, and ignore historical replacements and prepends. Do not add a second Host event stream or assert an unforwarded event type.

## Alternatives considered

**Report the key as absent.** This preserves startup but gives the wrong recovery instruction and conceals the saved-key retry action.

**Block application activation on Keychain.** A system prompt would hold the whole desktop profile. Consumers already support background restoration and can publish an error without blocking the window.

**Clear credentials or cache failure indefinitely.** Clearing destroys valid saved state. A permanent cached error prevents recovery after the user grants access. A fixed-duration cooldown also introduces a retry delay unrelated to the user's action.

**Retain only the legacy `safeStorage` file across releases.** Byte-identical ciphertext does not prove that a newly signed ad-hoc application can decrypt it. Deferring target authorization therefore cannot pass update acceptance.

## Acceptance criteria

The real Loader composition mounts with a denied native store, exposes controlled model and account errors, and refreshes the retained model key and account token after access recovers without writing or removing them. Provider tests cover genuine absence, temporary denial, same-turn coalescing, later recovery, corrupt storage, and browser-cookie behavior. Explicit account refresh returns an offline snapshot on credential failure; it cannot reject into a permanent checking state. Account and MCP consumers retain their distinct recovery states. UI tests activate retry without filling password or key fields, including a checking snapshot with a transport error, and disable duplicate refreshes while loading. A newly signed native package must still complete real authorization, account restoration, and an actual model request before release.

Request admission must retain a structured `GC-ACCOUNT-KEYCHAIN` failure for token, username, password, and device-id reads. The account snapshot keeps the known username and saved-password state, never dispatches the denied model request, and permits a later request to recover without rewriting credentials. A rebuilt native package must verify the displayed turn error; source tests alone do not close the scheduled-run finding.

Cross-version acceptance must make the exact target UI project the retained account and model state, confirm every synthetic reference as migrated, and read each exact value through the frozen broker. A ciphertext-only result fails acceptance. A second valid App signature must read the already migrated broker entries without a password re-entry or another legacy migration.

## Risks

The one-time legacy migration can still require native authorization because the old `safeStorage` item belongs to the previous App identity. Tests with a simulated native-store denial verify software behavior, not macOS authorization or production model service health. References read in a later event-loop turn can legitimately attempt native access again until migration succeeds; this is not a persistent prompt suppression mechanism.
