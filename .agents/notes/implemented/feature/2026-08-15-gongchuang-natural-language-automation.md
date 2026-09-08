# Agent Note: Gongchuang natural-language automation schedules

Status: implemented

English | [中文](2026-08-15-gongchuang-natural-language-automation.zh.md)

## Problem

The first automation editor exposed only four fixed intervals and described its enable action as “save then enable local scheduling.” Business users needed to state common schedules in ordinary Chinese or choose a custom interval, and the technical scheduling copy did not explain the resulting behavior.

## Decision

The automation editor provides two equivalent setup paths. `一句话设置` deterministically recognizes daily times, weekdays, and fixed intervals from five minutes through 365 days, then fills reviewable form fields without saving. `手动选择` exposes the first local run, the existing presets, and the same bounded custom interval. A third entry point lets the user request a schedule in the ordinary assistant conversation: the bounded model tool resolves the current Session to exactly one enterprise workspace and writes only a fixed-interval task.

Saving remains explicit. An editor-created enabled task uses the `保存并启用` action and runs in the desktop-local scheduler; a disabled task uses `仅保存，暂不启用`. Every conversation tool call is in the signed policy's `ask` set, so it persists only after the user approves a card showing the name, cadence, and first run. Closing or sleeping the computer does not create a cloud run, and the next client launch processes work that became due.

The approval requirement alone did not prevent one concrete failure: a model could bypass the tool, fabricate an `automation-*` id in ordinary assistant prose, and claim success. Type checking, tool registration, the registry's unique task ids, and signed `ask` policy protect only a real tool execution; none can observe or constrain a natural-language completion claim when no call exists. The local-automation service therefore applies one narrow same-turn consistency check: only an explicit create-automation request followed by a positive created/enabled claim is examined. Native and code-mode calls retain individual outcomes and saved task ids. A partial success cannot authorize an explicit all-created claim or a fabricated task id. Truthful partial results, cancellation, and failure explanations pass. At most one correction is requested per turn; a partial success requests a factual explanation, not recreation of saved tasks or retries of rejected calls. It does not scan unrelated answers or freeze model wording.

The approval card resolves nested code-mode tool calls as well as native calls, renders the name, cadence, and first run in the desktop's local timezone, and sends `allowed-once` only from the explicit create action. Entering the Automation page reloads the Host snapshot, so a successful conversation-created task appears from the newly committed registry revision rather than the page's startup snapshot.

The first run must be a valid ISO datetime with a timezone. Approval and task display derive their cadence from the actual interval, including old records with a misleading label. Create and update verify that the selected enterprise workspace still exists. Active runs refuse workspace changes. The existing delete action instead disables future scheduling, stops only the owned queued message or active turn, then removes the task and its receipts while preserving conversations and files. Unbound claims are cancelled without admitting a prompt. A stop timeout leaves the task disabled and retryable, and a late receipt after deletion returns no task rather than resurrecting it. Receipt trimming evicts only settled runs and preserves live claim tokens.

Every task also owns one durable result conversation shared by manual and scheduled runs. The client binds the first dedicated Session before prompt admission, appends later executions to it, unarchives it when necessary, and opens the current execution in the assistant surface. If that conversation was explicitly deleted, its local Session record disappeared, or it belongs to a different workspace, the active claim creates a replacement in the task workspace and uses the old id as a compare-and-replace guard while updating both the task and run. This prevents deleted or legacy cross-workspace bindings from blocking the schedule without moving old history or allowing a stale client to overwrite a newer binding. The client settles a signed-policy rejection that removes an admitted message before turn allocation from the matching idle, no-longer-queued Host agent error instead of leaving the run active until the stale-claim timeout.

Manual dispatch awaits the model outside the registry mutation queue and outside page-wide busy state. The task alone remains marked running, allowing the user to disable future runs or manage other tasks during execution. Poll failures are caught; a later successful poll clears its own stale error even when no work is due, without clearing an unrelated action error.

The fixed professional persona asks models to use Chinese for visible progress, tool-call descriptions, concise reasoning summaries, and final answers when serving Chinese users. Source names, model names, code, technical identifiers, and raw tool errors remain unchanged. The persona explicitly does not request hidden chain-of-thought disclosure.

## Alternatives considered

**Treat assistant prose as a saved schedule without a bounded tool or approval.** Rejected because prose is neither a durable action receipt nor user authorization. The implemented tool has a closed schema, resolves one current enterprise workspace, and remains fail-closed behind a signed per-call approval.

**Rely on stronger prompt wording to forbid fabricated completion claims.** Rejected because provider behavior can drift and a prompt has no durable action receipt. The narrow runtime check observes only the precise mismatch between an explicit creation request, a completion claim, and the absence of a successful result.

**Add only more fixed menu choices.** Rejected because it still cannot represent common business intervals such as 90 minutes or two days.

**Expose cron syntax.** Rejected because it is developer-facing, difficult to validate for ordinary users, and would imply calendar semantics that the current interval scheduler does not implement.

## Consequences

Natural-language recognition in the editor is deterministic and therefore cannot silently reinterpret unsupported wording. It returns an actionable validation message and leaves the user's task unsaved. Conversation creation adds model interpretation only before a human-confirmed, closed-schema tool call. The scheduler continues to store an interval plus a local-time anchor, so V0.1 does not claim cron, holiday-calendar, or cloud execution semantics.

Rejected and failed calls leave the registry revision unchanged and may be explained normally. A successful approval advances the durable revision once; the Automation page refresh is an extra local snapshot read when entered, not a cloud synchronization or a second write.

Existing V0.1 registry files migrate additively without a schema bump. A task missing the new conversation field adopts the latest non-null Session id from its retained run receipts; tasks without such a receipt bind on their next run. When an adopted Session belongs to the task's former workspace, the first run atomically replaces that binding in the current workspace. Historical receipts remain unchanged.
