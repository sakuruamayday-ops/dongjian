# Agent Note: Gongchuang global policy execution boundaries

Status: implemented

English | [中文](2026-08-17-gongchuang-global-policy-execution-boundaries.zh.md)

## Problem

The signed Gongchuang policy gate originally registered its first-step and tool-policy listeners in the plugin's local Cordis context. Unit tests that dispatched through that context passed, but a packaged macOS acceptance run proved that a real child-agent conversation could answer a plain-text first request while an injected gate outage was active. The signed policy loaded correctly; the interception scope was not a sufficient product trust boundary.

## Decision

The same verified policy is now enforced at three global execution boundaries:

1. A prepended global `llm/stream` listener checks the signed provider allowlist at the final same-process boundary before an adapter receives any request.
2. The existing `agent/pre-step` listener is global and prepended so professional routing, evidence state, and the acceptance outage apply to the first and later steps in child agent scopes.
3. Tool dispatch keeps the global prepended `tools/pre-execute` policy and adds a monotonic `tools.guard()` denial for unattributed, denied, or unknown tools. A later plugin cannot turn that denial into an allow decision.

The isolated `GONGCHUANG_ACCEPTANCE_GATE_FAULT=pre-step` mode may only throw or deny. Ordinary launches reject the mode unless the validated temporary acceptance root is active, and the mode is absent from the normal composition.

Professional prompt routing is intentionally narrower than runtime admission. Ambiguous words such as `checkup`, `score`, and `report` only activate the professional chain when the same request also identifies a business subject such as an enterprise, policy application, intellectual property, finance, or peer comparison. Technical requests such as a client engineering checkup remain ordinary product-development conversations. If a business skill is actually invoked later in the turn, its signed dependency chain and delivery requirements still activate at that point.

The Host also derives one response depth from the user's actionable request: `query`, `analysis`, or `formal`. A single question receives the shortest sufficient answer, a scoped analysis stays inside the requested dimensions, and only an explicit artifact or full-report action activates every signed delivery marker. Business vocabulary and runtime skill activation do not independently raise the depth. Formal artifact activation does raise the turn to `formal`, so alternate execution paths cannot bypass the complete delivery requirements.

## Alternatives considered

- Treat every occurrence of a business-domain word as professional work. This protected business tasks but incorrectly routed ordinary engineering and product-support conversations.
- Remove prompt routing and rely only on the model to select a skill. This reduced false positives but allowed a business request to begin without the required professional context.
- Keep subject-qualified prompt routing and add runtime skill observation. This is the adopted balance: explicit business requests are protected before the first model step, while unusual phrasing is protected when the selected business skill is observed.
- Apply every formal delivery marker to every professional answer. This preserved maximum structure but turned narrow questions into reports and caused unrelated delivery profiles to reject valid concise answers.
- Let each skill decide response depth independently. This allowed conflicting structures when several skills participated and made a later skill invocation expand the answer without a user request.

## Verification

The packaged macOS client was launched with an empty isolated user-data root and no OpenCode Go credential. Sending a plain-text message ended the turn with the Chinese fail-closed error before any `request/header`, credential lookup, assistant message, or tool event was created. The failure persisted after reopening the session. The live receipt is `acceptance/policy-runtime-outage-live-20260817/receipt.json`. Host-composition tests cover all three response depths, including a single patent-suitability query with no full enterprise-profile markers and a formal artifact path that restores the complete signed profile.

## Consequences

Prompt instructions, `AGENTS.md`, skills, and hooks still shape professional behavior, but they are not the final enforcement layer. Provider admission, first-step policy, tool admission, and response depth now remain inside signed Host-controlled runtime boundaries. Concise professional answers retain factual, calculation, policy-source, integrity, and permission checks while avoiding unrequested report structure. Any future provider or tool route must satisfy all applicable boundaries and add both integration and packaged-app fault-injection coverage. New ambiguous professional markers must include a subject-qualified regression case and a non-business counterexample.
