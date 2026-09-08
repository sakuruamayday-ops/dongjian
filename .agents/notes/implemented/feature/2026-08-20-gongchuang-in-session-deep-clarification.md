# Agent Note: Gongchuang in-session deep clarification

Status: implemented

English | [中文](2026-08-20-gongchuang-in-session-deep-clarification.zh.md)

## Problem

Complex enterprise work often reaches file changes or formal deliverables before the user and assistant agree on the goal, scope, dependencies, risks, and acceptance criteria. Exposing upstream developer workflow names would make that discipline discoverable only to technical users, while a separate wizard or hidden interview record would split one task across two histories and create recovery semantics the Session domain does not own.

## Decision

共创企业助手 presents the capability as `深度澄清`. A keyboard-accessible button with a tooltip occupies the existing conversation input tool row; it does not add a sidebar page, window, or product-level workflow store. Selecting the button only arms a one-shot mode for the addressed Session. It creates no empty conversation turn and does not mutate or submit the current draft. The next ordinary non-empty user message is submitted once with a concise explicit activation wrapped around the real task. The signed skill, not the Client, owns the dependency-ordered rounds, recommendation format, fact-verification split, checklist, and pre-confirmation workflow constraint. This keeps one authoritative workflow source instead of copying the skill into a Client prompt.

The one-shot armed state is held per Session in the Client and is settled transactionally by the ordinary composer sink. It clears only after the Host accepts the prepared send; rejection or transport failure leaves both the user draft and the armed mode available for retry. Once the real task is sent, the request and every answer are ordinary conversation messages, so Session history is the only durable interview record and existing refresh, restart, replay, and recovery paths retain it without another persistence format.

Draft classification may show one optional suggestion only after the same Session already contains five user prompts and the user is composing a high-confidence formal deliverable, multi-action task, or materially ambiguous scope. The suggestion offers `为下一条消息启用` and `直接继续`; it never submits or blocks the draft on its own. The Client records the suggestion as consumed when it first becomes visible, before either action is chosen, so closing, accepting, rejecting, remounting, or restarting cannot show it again for that Session. This small local receipt is not interview content or a second workflow state; the conversation remains the only durable record of any clarification that actually starts. Greetings, ordinary or polite questions, questions that merely mention dangerous actions such as delete or send, short rewrites, searches, and local reversible fixes do not trigger it.

User-visible copy never names the upstream engineering skills or internal dispatcher terminology. The product package owns the Chinese entry, one-shot armed state, suggestion and refusal state, and presentation. The signed skill disables implicit invocation and owns the complete workflow. The generic conversation package continues to own message admission and durable history. Shared-understanding confirmation is a workflow constraint; existing Host confirmations remain reserved for high-impact release, submit, send, and delete boundaries.

The skill also owns explicit convergence. The user may choose `按推荐继续`, `跳过澄清`, or `取消任务` in any round. Recommendations may settle only reversible, low-impact choices; high-impact choices remain explicit. A round advances only when it confirms or removes a decision branch or verified facts unlock another branch. After two consecutive rounds without such progress, the skill stops repeating the same questions and presents one compact choice among safe recommended defaults, skipping clarification, or cancellation. An unavailable tool or external condition blocks only its dependent branches and is not called repeatedly.

## Alternatives considered

**Force clarification whenever a heuristic matches.** Rejected because classification cannot know user urgency or intent with enough certainty to block ordinary work. The classifier only offers a choice.

**Add a dedicated interview wizard and persisted decision-tree record.** Rejected because it would duplicate Session history, require independent restart and migration behavior, and make the user switch away from the conversation where the task will be executed.

**Expose the upstream skill names and controls directly.** Rejected because they contain developer-facing concepts and broader engineering documentation behavior that does not belong in an enterprise assistant. The product keeps the underlying questioning discipline but presents only the business capability.

**Rely only on automatic detection.** Rejected because a user may want clarification for a short but high-stakes request that no lexical classifier can recognize. The explicit tool-row entry remains available for every live Session.

## Verification

Component tests exercise keyboard focus and tooltip presentation, arming from an empty composer without submission, cancellation, the five-prior-prompt threshold, permanent one-suggestion consumption across a reconstructed mode, formal, multi-step, and ambiguous classification, ordinary-task exclusions including polite and dangerous-keyword questions, and dismissal without submission. Input-service tests verify that the next real task is wrapped without mutating the visible draft, that successful submission disarms the mode, and that failed submission preserves it. Skill tests verify that implicit invocation is disabled, explicit exit choices remain available, two no-progress rounds forbid a third repeated round, unreachable capabilities are not retried, and the complete workflow remains in the signed skill. Type checking and type-aware lint cover the conversation and product packages.

## Consequences

Users can prepare a deliberate decision phase before they have typed a task without generating a meaningless empty turn, and the complete interview survives wherever conversation history survives. The suggestion classifier is intentionally conservative and can miss complex tasks; delaying it until five prior prompts and consuming it on first display prevents repeated interruption, while the explicit entry remains available at any time. An interview may span more than two rounds when each round resolves real dependencies, but it cannot repeat an unchanged question set indefinitely. The pre-send armed flag is intentionally transient Client state and the per-Session suggestion receipt contains no task content; neither becomes a second workflow record. The durable workflow starts only when a real task becomes a Session message.
