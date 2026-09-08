---
name: dsh-agent-behavior-evaluation
description: Use when evaluating multi-turn agent behavior, answer scope, tool routing, clarification convergence, or model/provider differences in deepseek-harness; organizes bounded synthetic scenarios around the repository's existing deterministic and real-API test paths.
---

# Evaluating agent behavior

Use scenario evaluation for behavior that one unit test cannot establish: multi-turn continuity, answer depth, tool choice, clarification termination, recovery after a failed action, or differences between model/provider routes. GUI interaction, packaging, signing, updater behavior, native credentials, and startup performance stay with their owning browser, package, or device tests.

## Evidence order

1. Start with the narrowest deterministic Vitest, property, snapshot, or scripted mock-LLM scenario that can reproduce the behavior. Extend the existing harness instead of adding a parallel test runtime when it can express the case.
2. Use a real-provider receipt only when authentication, provider protocol, model behavior, or live tool use is the fact under test. Follow the repository's manual real-API workflow and never treat a self-skip as a passing receipt.
3. Use an external simulator such as [Plurai IntellAgent](https://github.com/plurai-ai/intellagent) only when generated user variation or an independent conversational critic adds information that deterministic cases cannot supply. Keep it outside production dependencies and release artifacts.

## Scenario record

Keep each scenario reviewable and bounded:

- stable scenario id and the user goal;
- synthetic setup and only the tools or data needed by the case;
- initial message plus any planned user correction or interruption;
- observable required behavior and forbidden behavior;
- maximum turns, external spend limit, and terminal conditions;
- exact model/provider identity for nondeterministic runs;
- transcript or session-log reference and the final judgment source.

Turn limits and spend limits terminate the evaluator; they do not prove the product behaved correctly. The product's exact-repeat fuse, professional correction ceiling, and agent-loop recursion limit remain independently tested at their owning layers.

## Data and external harnesses

Use synthetic or irreversibly sanitized content. Do not upload customer documents, credentials, enterprise-space data, production logs, or raw conversation history to an external evaluator. Pin the reviewed upstream commit, run it in an isolated environment, set `PLURAI_DO_NOT_TRACK=true`, and configure an explicit cost limit before any model call. Record deprecation warnings and adapter limitations instead of hiding them.

IntellAgent currently accepts its default tool-calling agent or a compatible LangGraph graph. Do not claim that it tests the shipped DSH application unless the scenario actually traverses a maintained adapter into the assembled product. A dummy graph proves the evaluator works, not that the client works.

## Judgment

Make deterministic assertions and product-owned validators authoritative for protocol, state, security, limits, and exact visible behavior. An LLM critic may discover or cluster failures, but its score alone does not block a release. Promote a discovered failure into the narrowest reproducible repository test before relying on it as regression coverage.

Report the scenarios run, model identities, limits, commands, failures, warnings, and which findings became deterministic tests. Do not summarize an exploratory run as comprehensive coverage.
