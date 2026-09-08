# Agent Note: Gongchuang verified model connections

Status: implemented

English | [中文](2026-08-15-gongchuang-verified-model-connections.zh.md)

The per-model selection probe, validation cache, and technical picker presentation described below are partially superseded by [probe-free model selection](../simplification/2026-08-23-gongchuang-model-selection-without-probes.md). Credential validation during configuration, authenticated directory discovery, transactional persistence, adapter adoption, and the credential-store boundary remain current.

## Problem

共创企业助手 offers DeepSeek, the OpenCode Go, SiliconFlow, and Orgarid relays, and one custom API route to people who should not need to understand Cordis composition, credential references, or pi-ai profiles. A form that marked itself complete after a click could not prove that the key authenticated, that the provider advertised a usable model, or that the mounted adapter could dispatch that model. Static adapter catalogs also made the connection receipt and model picker disagree when a relay added, renamed, or removed a model. Persisting first and discovering failure later left bad credentials and half-written custom profiles behind. The product needs one setup and discovery contract that distinguishes typed, stored, authenticated, currently advertised, and verified for conversation states.

## Decision

The private `@gongchuang/model-connections` Host service owns five product routes: `deepseek-official`, `opencode-go`, `siliconflow`, `orgarid`, and `custom-api`. The renderer sends a newly typed key once through a Remote call and never receives a stored key or credential reference. The Host validates the key with an authenticated `/models` request that refuses redirects, caps the response at 4 MB, times out after 20 seconds, and permits custom endpoints only over HTTPS or loopback HTTP.

DeepSeek and the three managed relays replace their adapter catalogs with the authenticated endpoint directory and then require the mounted adapter to report every adopted exact model id. The Host selects a product preference from that usable directory, writes the key to `@gongchuang/credentials-keychain`, and publishes only a redacted receipt containing phase, route, verification time, usable-model count, selected model, exact validated model ids, and a human-readable message. Startup reconciliation, picker opening, network recovery, and the explicit refresh action all use this same projection. DeepSeek refresh may overlap the relay group because it owns `llm-deepseek`; providers sharing `llm-pi-ai` commit in one revision sequence so a refresh-all operation cannot make its own sibling writes stale. An unchanged refresh retains an exact model validation; a credential, endpoint, adapter, capability, or model-membership change invalidates the affected result.

A custom route is transactional. The Host probes the endpoint, chooses an advertised model, writes the key under a random credential reference, commits one `llm-pi-ai` profile, and verifies that `ctx.llm` registered `custom-api`. An endpoint that returns 404, 405, or 501 for `/models` may register one explicitly entered model id as a text-only candidate; no id remains an error. Any failure restores the previous profile and removes the unused candidate key. If a concurrent settings change makes rollback unsafe, the Host preserves the candidate in the OS credential store and reports that explicit state instead of deleting a key a concurrent profile may reference.

The picker labels each exact row as verified or pending and independently presents text, image, reasoning, and provider-file capabilities from adapter metadata. A pending selection opens an explicit quota confirmation before the Host sends the fixed non-sensitive prompt `只回复 OK` with at most one output token and a 30-second timeout. Cancellation sends no request. Success promotes that exact model for the current connection identity; failure does not change the session model. A successful directory removal blocks the next send until the user chooses a replacement, while a transient directory failure clears selectable rows without pretending that the cached directory is current.

The model pane keeps an explicit refresh command at its bottom. It disables during refresh, spins the existing refresh icon, leaves the menu open, and updates the current session's shared directory. This interaction follows the scoped refresh pattern in Hermes Agent's `ModelMenuPanel`, while deliberately rejecting Hermes's stale-catalog fallback because the Gongchuang product requires a failed refresh to clear selectable rows.

The desktop composition fixes the official adapter identities before Cordis mounts. Host admission requires `@deepseek-ai/dsh-llm-deepseek`, the exact `OPENCODE_API_KEY` binding, `@gongchuang/model-connections`, and the `deepseek-official` / `deepseek-v4-flash` initial model. A composition-time DeepSeek endpoint, an extra OpenCode provider field, a missing row, or a replacement plugin fails launch. Runtime custom routes remain data in the settings service, not same-process community Cordis plugins.

This decision specializes the [general credential boundary](2026-07-30-credential-boundaries-and-atomic-registration.md) for the Gongchuang desktop product. It does not change `credentials-local` or the general DSH Models page.

## Alternatives considered

**Treat a successful form submission as configuration.** Rejected because it reproduces the false-completion state the product surface exists to remove.

**Persist a key before probing.** Rejected because invalid keys become durable state and custom profile writes can strand unusable routes.

**Trust `/models` without checking the mounted adapter.** Rejected because a profile update can fail to reach the mounted adapter. The service updates the dynamic catalog and then verifies exact adoption before publishing readiness.

**Send a paid chat completion as the configuration probe.** Rejected because model-directory authentication is sufficient to validate the credential. The separate first-selection request occurs only after the user confirms the exact pending model and is capped at one output token.

**Keep the stale model directory selectable after refresh failure.** Rejected because a cached row would look current precisely when deletion or rename cannot be ruled out. The current verified model may remain usable after a transient failure, but stale rows are not offered as fresh choices.

**Proxy provider credentials through the Gongchuang account server.** Rejected for V0.1 because it turns the server into a model-secret custodian without being necessary for desktop or cross-device product data synchronization.

## Consequences

The model selector distinguishes an installed adapter, an authenticated directory, a pending exact model, a verified exact model, a temporarily unavailable directory, and a removed model. A failed or incompatible endpoint remains visibly unavailable, and “use saved key to re-check” appears only when the Host reports that a credential or custom profile exists. Keys remain in the renderer only while the user types and submits them, then live in the operating-system credential store. Provider subscription, registration, and billing stay on the provider's official site.

The directory receipt proves authenticated discovery, and the one-token validation proves only that one exact text request reached a terminal response. Neither proves sufficient balance, every advertised capability, or production-task quality. Packaging acceptance therefore still exercises every required route and capability on the target device with test-owned credentials before a candidate installer can pass.

## Testing

The service and renderer suites cover all five product providers, dynamic relay adoption, refresh-all revision ordering, probe-before-commit, key redaction, transactional rollback, a custom endpoint without `/models`, confirmation before the one-token request, unchanged-directory reuse, key and removal invalidation, refresh failure clearing, current-model send blocking, four-state capability presentation, and the persistent refresh command. Host-admission tests mutate or remove every required model binding and require launch refusal. Real-provider and packaged-device receipts remain release evidence rather than unit-test substitutes.
