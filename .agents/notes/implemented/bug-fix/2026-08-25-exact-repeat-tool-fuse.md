# Agent Note: Exact-repeat tool fuse

Status: implemented

English | [中文](2026-08-25-exact-repeat-tool-fuse.zh.md)

## Problem

The advisory repeat-call reminder could not stop an agent from issuing an unavailable or unchanged tool call indefinitely. Each identical attempt consumed another model turn and could repeat external side effects or keep a desktop task visibly running without adding evidence. Git history, semantic versions, TypeScript, and ordinary tests cannot prevent this runtime model behavior; the existing reminder text also could not veto dispatch.

OpenCode uses a three-call doom-loop threshold around identical tool input, while OpenAI Agents and LangGraph expose broader turn or graph-step limits. The product needs the narrower control first: stop the exact operation known to make no progress without imposing a global turn budget on legitimate long tasks.

## Decision

`@deepseek-ai/dsh-repeat-tool-reminder` accepts an optional integer `blockAt` of at least two. For each live agent, the plugin compares the current tool name and fully canonicalized JSON arguments with the previous tracked chain. If the prospective count reaches `blockAt`, `tools/pre-execute` preserves any downstream ask or deny and otherwise returns a deny decision before the tool implementation runs.

`tools/post-execute` remains the single counter update point, so accepted and denied attempts advance the same chain and configured reminders remain reconstructable from the session log. A different tracked tool, different canonical arguments, or a new user-authored message provides an explicit recovery path. Excluded calls remain transparent, direct executions without an agent remain untracked, and separate agents never share a chain.

The Gongchuang desktop composition sets reminders at 2, 3, and 5 and sets `blockAt: 3`. The second identical attempt executes and receives a reminder; the third and later identical attempts are denied before dispatch until the agent changes its action or the user starts a new turn. The denial is returned directly to the model instead of opening an interactive approval prompt that could itself wait forever in a headless or hidden UI.

## Alternatives considered

**Global turn budget.** Deferred because it stops every long run, including progressing work, and does not identify which repeated operation caused the failure. A separate complete-run limit remains useful only if real tasks show loops that deliberately vary tools or arguments.

**Fuzzy comparison.** Rejected because whitespace, paths, polling parameters, and generated payload differences can represent real progress. Exact canonical equality is deterministic and explainable; expanding it requires observed false negatives.

**Approval dialog on the third call.** Rejected because the affected agent may run while the window is hidden or no approval surface is available. Waiting for that dialog would replace one non-terminating state with another.

**Delete the advisory tier.** Rejected because the second-call reminder gives the model a chance to recover without blocking a legitimate retry, while the third-call denial provides the hard upper bound.

## Consequences

The product cannot execute the exact same tracked tool and canonical arguments more than twice consecutively in one user turn. The fuse does not claim to detect semantic loops that vary arguments, and it does not replace the professional correction limit or the deep-clarification no-progress rule. Deployments that omit `blockAt` keep the package's advisory-only behavior.

## Verification

Package tests execute four identical calls through the real agent loop and assert that only the first two reach the tool implementation, the later tool results are errors, downstream policy decisions retain priority, changed calls recover, user turns reset state, and invalid `blockAt` values fail at load. The product composition test pins `blockAt: 3`. A keyless assembled-application snapshot replays the repeated-call sequence and records both the reminder and pre-dispatch denial.
