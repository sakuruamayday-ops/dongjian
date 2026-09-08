---
description: "Host-owned recurring task registry and execution receipts for the Gongchuang desktop client."
kind: "package-reference"
---

# @gongchuang/local-automation

English | [中文](README.zh.md)

## Summary

Host-owned local automation registry for 共创企业助手 V0.1. The service stores recurring task definitions and execution receipts under the Electron application data directory. It never submits a task to a 共创 cloud queue.

## Table of Contents

- [Behavior](#behavior)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Behavior

The trusted client polls for due work while the desktop application is running. A claimed task is dispatched through the normal workspace conversation API, so the signed request, tool, and delivery gates still apply and the model-visible prompt enters the ordinary Session log. Prompt admission alone is not recorded as success: the trusted client waits for the ordinary result Session to finalize or fail before settling the claim. The legacy wire value `dispatched` therefore denotes a terminal successful run in V0.1 and is presented to users as `已完成`. Only a hashed one-time run token is persisted.

Each task owns one dedicated result conversation. The first manual or scheduled run creates and durably binds that conversation before admitting the prompt; later runs append to the same history, restore it when merely archived, and reveal the current execution in the recent-conversation UI. If the user deleted the bound conversation or its local Session record disappeared, the next claim creates a replacement and atomically compare-and-rebinds from the missing id. A conversation that still exists in another workspace is not moved or replaced implicitly.

Users may also ask the assistant to create a schedule in an ordinary conversation. The bounded `gongchuang_create_automation` tool can write only one fixed-interval task into the enterprise workspace that owns the current Session. The signed product policy classifies every call as `ask`, so the approval card must show the task name, cadence, and first run before persistence or enablement.

A narrow completion-claim check covers explicit create-schedule requests. It tracks individual same-turn creation outcomes and saved task ids, so one success cannot authorize an all-created claim after another call failed or a fabricated task id. A correction is requested at most once per turn; partial success asks for a truthful explanation, not repeated creation or retries of rejected calls. It does not inspect unrelated conversation text, and truthful partial, cancellation, or failure messages pass unchanged. The client refreshes the Host snapshot when the user opens the Automation page, so a confirmed conversation-created task appears from the committed registry revision.

First-run datetimes require a valid calendar date and explicit timezone. Approval and task display derive cadence from the stored interval instead of trusting an arbitrary label. Create and update require a workspace that still exists. A running claim prevents workspace migration, but the existing delete action can stop and delete it. Deletion persists scheduling as disabled, removes only the owned queued message or cancels the exact owned turn, then removes the task after termination. Failed stops remain disabled and retryable; conversations and files are preserved. Prompt admission uses the upstream Session API under the same short mutation queue as deletion, with the run id as the request identity. Receipt retention removes only settled runs. Model waits and stop waits do not occupy the shared mutation queue or page-wide busy state, and successful polling clears only errors raised by polling itself.

## Dev Note

The trusted client dispatches each claimed run through the ordinary workspace Session API and records success only after that result Session settles.

## Runtime Invariant

No runtime invariant companion is published because the validated JSON registry is private state and model-visible dispatch is recorded in the conversation session log.

## Model Experience

### Claimed local task dispatch

#### What the model sees

No direct content from the registry. After the trusted client claims a due or manual run, the client sends the `【本机自动化任务】` wrapper, task name, scheduled time, gate reminder, and stored prompt as one ordinary user message in the selected enterprise workspace.

#### Token effect

The registry adds zero direct tokens. Dispatch adds data-dependent user-message tokens equal to the task wrapper and stored prompt.

#### KV Cache effect

Dispatch appends a user message to the selected session, preserving the earlier reusable prefix. Editing a task does not affect model context until a later dispatch.

### Conversation-created task

#### What the model sees

The tool schema accepts a task name, complete prompt, timezone-aware first run, fixed interval, user-facing cadence label, and enabled state. Ambiguous time or task content must be clarified before calling the tool. The approval card presents the first run in the desktop's local timezone. No task id is authoritative until the successful tool result returns it.

#### Token effect

The model receives the bounded tool schema and one compact structured result. The durable registry is not injected into later prompts.

#### KV Cache effect

Tool guidance is stable for the fixed professional preset. Per-call arguments and the result append after the reusable prefix.

## Known Limitations and Deferred Work

- V0.1 executes overdue work when the desktop client is running or next starts; it does not install an operating-system background daemon.
- Recurrence is a fixed local interval of at least five minutes. Calendar and file-event triggers are deferred until their platform-specific wake and permission behavior can be tested on both Windows and macOS.
- Deleting a task removes its retained run receipts after owned execution stops. Legacy active runs without a recorded request identity require stopping in the result conversation before retrying deletion, rather than guessing ownership and cancelling a manual turn. Deleting only its result conversation keeps the task and causes the next run to start one replacement conversation.
