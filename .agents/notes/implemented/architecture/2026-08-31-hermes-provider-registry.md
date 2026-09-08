# Agent Note: Scoped Hermes provider registry

Status: implemented

English | [中文](2026-08-31-hermes-provider-registry.zh.md)

## Problem

The product currently implements five provider-specific branches. Extending that switch for every provider would duplicate endpoint, credential, protocol, and refresh logic, while copying the complete Hermes inventory would exceed the product scope the user selected. A label-only implementation would be worse: it could save a key while dispatching through the wrong protocol or endpoint.

## Decision

V0.4.0 uses one audited provider registry to drive the Host snapshot, configuration UI, credential reference, adapter profile, refresh behavior, and tests. The visible set is exactly the 35 providers confirmed in the product screenshots plus one local/custom endpoint:

Fireworks AI, OpenRouter, Anthropic, xAI, DeepSeek, MiniMax, MiniMax China, OpenCode Zen, OpenCode Go, NVIDIA NIM, Ollama Cloud, LM Studio, Xiaomi MiMo, Arcee AI, GMI Cloud, Azure Foundry, Actual Computer, Alibaba Cloud Coding Plan, CommandCode, DeepInfra, GitHub Copilot, Google AI Studio, HuggingFace, Kilo Code, Kimi Coding Plan, Kimi/Moonshot China, Meta Model API, NovitaAI, OpenAI API, Qwen Cloud, StepFun Step Plan, Tencent TokenHub, Upstage Solar, Vercel AI Gateway, and Z.AI GLM; the additional entry is Local/custom OpenAI-compatible endpoint.

Hermes is a reviewed definition source for provider ids, fixed base URLs, credential fields, protocols, and special authorization semantics. Providers outside the confirmed list are not copied. Protocol-specific and authorization-specific providers must use a real adapter or display an unavailable setup action; no provider is represented as a generic API-key connection merely to make the row look complete.

Existing DeepSeek, OpenCode Go, and custom credentials are adopted without asking the user to re-enter them. SiliconFlow and Orgarid disappear from the new configuration surface, but their existing OS credential entries are not erased. Migration is idempotent and does not expose secret values to the renderer, settings file, logs, or receipts.

The registry owns connectivity metadata only. Image input, reasoning levels, file transport, context size, and output size continue to come from exact installed adapter/model metadata. Missing capability metadata means the control is absent; names such as `vision` or `reasoning` are never parsed as evidence.

## Alternatives considered

- Copy all current Hermes providers. Rejected because the user selected a bounded list and because unneeded integrations enlarge the test and credential surface.
- Keep a provider switch in the service and UI. Rejected because each added branch can drift independently across display, key storage, endpoint probing, and dispatch.
- Treat every provider as OpenAI-compatible with an API key. Rejected because Anthropic Messages, Responses API, local no-key endpoints, user-supplied Azure endpoints, and delegated authorization do not share that contract.

## Consequences

Adding or changing a visible provider becomes a registry and adapter review rather than another product branch. Some listed providers may initially show an explicit authorization prerequisite until their real flow is implemented; that is preferable to a false ready state. Removed legacy entries keep their secrets dormant for recovery or later manual cleanup.

## Testing

A snapshot test locks the exact 36-entry visible set and order. The matrix validates route uniqueness, allowed protocols, fixed versus user-provided endpoints, keyless loopback, special authorization, directory fallback, provider-isolated refresh, legacy credential adoption, removed-credential retention, redaction, and exact model capability projection.
