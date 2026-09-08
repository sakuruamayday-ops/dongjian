# Agent Note: Model-exact list-price ledger

Status: implemented

English | [中文](2026-08-14-model-cost-estimate-ledger.zh.md)

## Problem

The conversation surface needs compact session and daily spend feedback without pretending that a client-side estimate is a provider invoice. Providers expose different usage shapes, custom routes may have no trustworthy price metadata, zero can mean either a genuinely free model or missing information, and a renderer-only counter would lose replacement semantics when a settled usage update supersedes an earlier chunk.

## Decision

**Usage carries an optional estimate.** `TokenUsage.estimatedCostUsd` is present only when the adapter knows the applicable list price. A numeric zero means a model is known to be free; an absent field means the request is unpriced and must not be displayed as free.

**The DeepSeek adapter prices exact official model identifiers at the request instant.** The adapter owns the [current official USD-per-million-token schedule](https://api-docs.deepseek.com/quick_start/pricing/) for `deepseek-v4-flash`, `deepseek-v4-pro`, and `deepseek-v4-flash-vision-exp`, including distinct cache-read, cache-miss, and output rates. Monday through Friday, 01:00-04:00 and 06:00-10:00 UTC use peak rates; every other instant uses off-peak rates. Each actual chat fetch captures its own instant and uses it for that complete response, including a fetch made after stale-file recovery. The estimate is omitted unless prompt, completion, and cache-read counts are safe non-negative integers and cache reads do not exceed prompt tokens. An unknown or aliased model identifier remains unpriced instead of inheriting a rate by name similarity.

**The pi-ai adapter trusts only installed catalog metadata.** Catalog-resolved model identifiers may use the cost total returned by the installed model catalog. Hand-declared custom routes and identifiers absent from that catalog remain unpriced, even when their names resemble a known model.

**Token-meter owns durable cost aggregation.** The `modelCost` projection replaces an earlier usage observation for the same session, turn, and step instead of double-counting stream updates. It records priced and unpriced request counts, aggregates per session, and groups all listed sessions by the host's local calendar day.

**The compact stats row presents estimates conservatively.** It shows session and local-day estimates, appends `+` when the total also contains unpriced requests, and uses an explicit unpriced message when no priced value exists. Model name and reasoning effort do not appear in the one-line row.

## Alternatives considered

**Infer price by model-name fragments.** Rejected because aliases and third-party routes can reuse a familiar name with different billing.

**Treat every zero as either unknown or free.** Rejected because both meanings are required. Optionality represents unknown pricing; numeric zero represents a known-free request.

**Rely on provider invoices or account endpoints.** Rejected because BYOK and subscription providers do not share a common billing API, and some integrations expose no account balance at all.

**Keep the ledger in renderer local storage.** Rejected because the projection needs Host replay, cross-session daily aggregation, and deterministic replacement of repeated settled usage chunks.

## Consequences

The displayed values are API list-price estimates, not invoices, subscription balances, or guarantees of provider-side rounding. DeepSeek's UTC price schedule requires maintenance when the official page changes. Local-day grouping is recomputed from stored timestamps in the current host time zone. Tests lock the three exact DeepSeek model ids, request-time peak-window boundaries and stale-file retry, cache-hit/cache-miss/output arithmetic, invalid-counter omission, unknown and free semantics, same-step replacement, mixed totals, and the one-line UI labels.
