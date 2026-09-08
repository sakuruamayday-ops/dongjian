# Agent Note: Gongchuang model selection without probes

Status: implemented

English | [中文](2026-08-23-gongchuang-model-selection-without-probes.zh.md)

## Problem

The Gongchuang model picker coupled ordinary selection to a paid one-token conversation probe. It also refreshed mutable relay catalogs while opening the picker, on network recovery, and after connection events. Those requests spent user quota, made a local choice depend on external availability, and exposed validation, synchronization, and inferred capability labels that did not help users choose a model. Dynamic relay metadata could additionally override an installed exact-model catalog and remove reasoning-effort controls. The usage strip was registered in an unrendered input slot, and a Chinese interface displayed English-dominant provider reasoning verbatim.

## Decision

The Host refreshes configured provider directories once during client startup. The first Renderer snapshot awaits that same reconciliation promise, so a fast mount cannot retain the transient `checking` projection after the Host has already settled. It does not start a second request or block the Electron main window. A user click on the persistent `Refresh models` command performs the only later directory refresh. Opening the picker reads the settled Host snapshot, and switching either model or reasoning effort only commits the session selection. Neither action refreshes a directory, validates a model, sends a chat completion, or changes another session. Connection, settings, credential, adapter, and Session-change notifications update availability and project the current Session's durable provider into the product shell without calling `session.selectModel`. The product declares the nested Session Remote required by `ModelDirectoryResolver` before binding this projection; otherwise the first Session can reach the resolver before that namespace is authorized and silently lose its initial subscription. Only an explicit provider selection, configuration, or connection recheck may commit a route, so a transient Host default observed before Session replay cannot replace the saved model during restart.

The product removes the per-model validation Remote, cache, confirmation dialog, technical validation states, synchronization times, and text, image, reasoning, or file badges from the picker. A normal conversation request is the proof that a selected model works; its ordinary error remains visible so the user can retry, refresh the directory, or choose another model. Configuration-time credential authentication and authenticated `/models` discovery remain owned by `@gongchuang/model-connections`, and credentials remain in the operating-system credential store.

An explicit refresh settles every configured provider independently. A failed provider keeps its own error receipt while another provider with a ready or explicitly registered non-empty directory keeps the refresh successful and remains selectable. The selector clears all rows only when the Host call fails, the replacement catalog cannot be read, or no configured provider returns a usable directory.

When one successful directory does not list the current model, the selector may report that fact, but it does not treat omission as proof that the model is unusable, lock the composer, or require a replacement first. Private, manually entered, or not-yet-advertised models may continue through the normal conversation path. Sending is blocked only when the Host explicitly reports no adapter for the current route or when the product connection itself is unavailable.

Provider-grouped rows show only provider names, model names, the selected mark, and the refresh command. Each provider header expands or collapses its local rows. Entering the model pane focuses a search field that filters the resident catalog by provider or model id and name; searching temporarily reveals matching rows without changing the saved collapsed set. Search, expand, and collapse never refresh or validate. Reasoning effort remains a separate control when the installed exact-model catalog declares it. Authenticated OpenCode Go directory rows inherit that installed catalog instead of retaining stale dynamic overrides, so DeepSeek V4 Pro exposes the adapter-supported `off`, `high`, and `max` choices.

The conversation usage strip is registered below the composer through `conversation.composer.dock`. In a Chinese interface, English-dominant reasoning is locally collapsed to the neutral Chinese progress labels already used by the reasoning row; Chinese or meaningfully mixed reasoning remains inspectable. This classification performs no translation request and spends no additional model tokens.

This decision partially supersedes the selection-probe and technical-presentation portions of [verified model connections](../architecture/2026-08-15-gongchuang-verified-model-connections.md). Its credential, discovery, transactional persistence, adapter-adoption, and security decisions remain in force.

## Alternatives considered

**Keep the one-token probe but remove its confirmation dialog.** Rejected because it would still spend quota on a model-selection action and turn a local preference change into an external request.

**Refresh on every picker open or connection event.** Rejected because startup and explicit refresh cover the supported freshness moments without duplicate network traffic or catalog churn during ordinary selection.

**Reconcile the model route from every background connectivity event.** Rejected because Session replay can briefly expose the Host default before the durable selection. Writing that transitional value creates a self-triggering settings refresh and makes the wrong route persistent.

**Translate English reasoning with another model request.** Rejected because translation adds latency, token cost, and another disclosure of reasoning content. Local suppression is deterministic and keeps normal answers untouched.

**Hide all reasoning in Chinese.** Rejected because Chinese reasoning and mixed technical reasoning remain useful when the provider supplies them.

## Consequences

Model search, provider folding, and model choice are immediate and quota-free, while catalog freshness is visibly controlled by startup and explicit refresh. The picker no longer claims capability or validation certainty that the current interaction does not establish. A selected model can still fail on its first real task; that failure is intentional product truth rather than a hidden preflight request. Exact installed catalogs once again own reasoning levels. The usage strip occupies the rendered composer slot, and English-dominant reasoning no longer breaks the Chinese reading experience.

Focused tests pin one startup load, a first snapshot that settles with that load, background refresh without model-write authority, durable provider projection, no load on open, one remote refresh per explicit click, focused local search, provider folding, selection without validation, the simple model row, restored OpenCode Go reasoning levels, the composer usage slot, and local English-reasoning suppression. Packaged acceptance exercises a real provider response before restart, a stable provider and model window after restart, and a second real response before it records persistence as passed.
