# Agent Note: Bounded convergence for routed Flash tasks

Status: implemented

English | [中文](2026-08-31-bounded-flash-task-convergence.zh.md)

## Problem

DeepSeek Harness can dispatch sibling concurrency-safe tool calls in parallel, but it cannot make a model group independent reads into one assistant step. Product sessions showed long document tasks issuing many sequential model steps and retrying unchanged failed approaches, so available Host concurrency did not reduce wall-clock time.

## Decision

The product-owned DeepSeek V4 Flash and Pro routing guidance tells the model to batch independent read, search, and parse operations into one tool call while preserving sequential order for writes, external actions, and dependent work. An unchanged failed path gets one evidence-backed alternative; a second result with no progress ends that path, preserves the original input, and reports the minimum condition needed to continue.

These instructions supplement the Harness scheduler instead of changing AgentLoop ordering or tool safety declarations. They do not change the user-selected reasoning effort, impose a wall-clock deadline, or turn an unsupported input into a successful result.

## Verification

The routing composition tests assert that the persistent system section carries both rules and that complex near-field guidance asks for batched independent reads. The same tests boot the real SystemPrompt composition for every admitted DeepSeek V4 Flash and Pro route and verify that existing persona, skills, contexts, and tools remain present.

## Alternatives considered

**Make every tool concurrent.** Rejected because writes, shell commands, external actions, and dependent reads cannot safely overlap merely to reduce latency.

**Lower the OpenCode Go reasoning effort.** Rejected as an implicit product-policy change. Reasoning effort remains a user-visible quality and latency choice rather than a hidden performance workaround.

**Add a total turn timeout.** Rejected because a deadline would also terminate healthy long document work and would not prevent repeated short model steps before the deadline.

## Consequences

Routed models receive a direct instruction to use concurrency already provided by the Host and to stop unchanged failure loops. Tasks may still be slow when model generation itself is slow, an exclusive tool is legitimately long-running, or an external service does not return; those cases remain observable failures rather than being reported as completed work.
