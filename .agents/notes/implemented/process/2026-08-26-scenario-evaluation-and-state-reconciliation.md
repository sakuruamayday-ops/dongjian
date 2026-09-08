# Agent Note: Optional scenario evaluation and state reconciliation

Status: implemented

English | [中文](2026-08-26-scenario-evaluation-and-state-reconciliation.zh.md)

## Problem

The repository has deterministic unit, property, snapshot, browser, real-API, packaging, and device tests, but a broad request to test an agent can still turn into an unbounded collection of model conversations with no stable scenario identity, stop condition, or distinction between exploratory judgment and regression evidence. An external conversational simulator can generate useful user variation, but adding its Python and LangChain dependency graph to the product would duplicate existing test infrastructure and enlarge the shipped or contributor runtime without proving the assembled DSH application was exercised.

Release work also changes facts across the product manifest, `CONTEXT.md`, product documentation, immutable receipts, tests, and Agent Notes. Updating the leading version paragraph without reconciling later current-state prose allows a document to name two production versions at once. Introducing a generic project-state directory would create another authority beside the files that already own these facts.

## Decision

Agent behavior evaluation is an optional, scenario-driven workflow. Each scenario records the user goal, synthetic setup, relevant turns, required and forbidden observable behavior, maximum turns, spend limit, model identity, terminal conditions, and evidence location. The narrowest deterministic repository test remains the primary regression evidence. Real-provider runs remain manually requested evidence, and an LLM critic remains exploratory until a finding is reproduced by a product-owned assertion or validator.

[Plurai IntellAgent](https://github.com/plurai-ai/intellagent) is an external evaluation aid, not a production or mandatory development dependency. External runs pin a reviewed commit, disable Plurai telemetry, use synthetic or irreversibly sanitized data, and set explicit cost and turn limits. A dummy or LangGraph-compatible test agent proves only that IntellAgent's evaluator runs; a claim about the product requires a maintained adapter that reaches the assembled DSH application. GUI, native integration, signing, updates, and performance continue through their owning tests.

Project-state reconciliation is also optional and runs after releases, long implementations, branch integrations, or reviews when durable facts may have moved. It adapts the semantic-diff lifecycle from [Project State Governor](https://github.com/Ghost011118/project-state-governor) while retaining this repository's existing authorities: machine-readable product identity and immutable receipts for released facts, `CONTEXT.md` for current cross-cutting terminology, the Chinese product document for product scope and evidence, active Agent Notes for rationale, and code/tests for implemented behavior. The workflow does not create `PROJECT_STATE.md`, `.project/`, a status archive, or a new CI gate.

State reconciliation distinguishes current claims from historical release rows, verifies completion at the level actually supported by evidence, and updates the smallest owning surface. Archived Agent Notes remain frozen. Implemented Agent Notes stay current or move through the existing triplet archive procedure. Conversation chronology, unverified reviewer claims, and transient debugging theories do not become durable state.

## Verification

IntellAgent commit `4125d1c18ec351655b2e37df5d396d08eaa4fa60` installed in an isolated Python 3.12 environment and passed its 60 upstream tests with telemetry disabled; the run emitted eight Pydantic v2 deprecation warnings. A separate monkey-patched check verified that `PLURAI_DO_NOT_TRACK=true` prevents the analytics HTTP call. These results establish that the evaluated upstream test paths run, not that IntellAgent covers the DSH product.

Project State Governor commit `9cae9694bc9c5042ba515b9d971e640f71c382c3` passed the Codex skill structure validator. Applying its reconciliation method to the V0.3.1 repository found current-state text that still named V0.2.9 or V0.3.0 as production despite `product-manifest.json`, release_id 14, and the immutable V0.3.1 receipts. Correcting those existing owners demonstrates a useful semantic diff without introducing another state file.

Both adapted skills pass the Codex skill structure validator, while the repository's existing checks cover this note and the corrected current-state prose. Neither external project supplies or replaces the repository's product tests.

## Alternatives considered

**Vendor IntellAgent into the repository or client runtime.** Rejected because its large pinned Python dependency graph, external model costs, telemetry default, and LangGraph-oriented chatbot interface do not replace the existing assembled-product test paths.

**Make an LLM critic score a release gate.** Rejected because model judgment is nondeterministic and can be useful for discovery without being authoritative for protocol, security, version identity, or exact visible behavior.

**Adopt Project State Governor's default `PROJECT_STATE.md` or scaled `.project/` layout.** Rejected because `CONTEXT.md`, product metadata, product documentation, receipts, and Agent Notes already have explicit ownership. A second state tree would move the conflict rather than resolve it.

**Run both workflows for every change.** Rejected because local reversible changes already have focused tests and Git history. Scenario evaluation and state reconciliation run only when their additional evidence answers a concrete uncertainty.

## Consequences

Future broad agent evaluations have bounded scenarios and a clear path from exploratory discovery to deterministic regression coverage. External simulator dependencies and customer data stay outside the product, while an adapter can still be added later if a real evaluation need justifies it.

Release and long-task state updates compare existing authorities before writing. This adds an explicit reconciliation step when durable facts move, but no new canonical file or mandatory gate. The workflow can report that no semantic state changed, which is preferable to creating documentation churn.
