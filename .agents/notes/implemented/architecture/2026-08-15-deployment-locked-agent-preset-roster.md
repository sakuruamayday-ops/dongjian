# Agent Note: Deployment-locked agent preset rosters

Status: implemented

English | [中文](2026-08-15-deployment-locked-agent-preset-roster.zh.md)

## Problem

An agent preset controls the model-facing prompt and tool catalog, so choosing a different preset is a capability change rather than a visual preference. `includeUserRoot: false` prevents a deployment from discovering user-authored presets, but it does not constrain which directories from a shared shipped root can be selected. A desktop product that shares DSH's shipped root could therefore default to a reviewed preset while still listing and resolving the coding, terminal, subagent, and Cordis-authoring presets beside it.

Tool-dispatch policy would still reject forbidden calls, but the model would receive irrelevant schemas and coding guidance, spend context on calls guaranteed to fail, and could start a session under a prompt that does not describe the product's professional evidence rules. A stale `agent-presets.default` setting could also select a preset the product did not intend to expose.

## Decision

`dsh-agent-presets` accepts an optional deployment-owned `allowedIds` list. When configured, the list must be non-empty, contain unique valid preset ids, and include the deployment's configured `default`. `list()` filters the discovered roster before every resolver and authoring operation, so a disallowed id cannot be listed, resolved, read, copied, removed, mounted, recomposed, or used for a standing host view. A saved default outside the list is ignored in favor of the deployment default; the ordinary DSH app omits `allowedIds` and keeps its extensible behavior unchanged.

共创企业助手 sets the exact roster to `gongchuang`. That preset contains the professional persona, sandboxed filesystem tools, the signed V1.6.6 skill root, Web search, and compaction. It deliberately omits shell and PowerShell tools, jobs, plan and goal tools, Todo, user-authored instructions, subagents, workflows, Cordis authoring, and arbitrary native plugin loading. The host admission check pins the default, the one-item allowlist, and the disabled user root together, while the signed tool-dispatch policy remains the independent enforcement layer for every tool that is visible globally.

## Testing

The agent-preset package tests prove invalid allowlists fail construction, disallowed presets disappear from discovery and explicit resolution, and a stale user default falls back to the configured allowed default. The shipped Web composition mounts `gongchuang` and asserts its exact model-facing tool catalog and persona while proving terminal, delegation, workflow, goal, Todo, and Cordis-authoring tools are absent. Product host-admission tests reject a writable root, a different default, or an expanded allowlist.

## Alternatives considered

**Use only `includeUserRoot: false`.** Rejected because the shared system root still contains every shipped DSH preset.

**Keep every preset visible and rely only on the signed dispatch gate.** Rejected because rejected tools and mismatched prompt sections still consume model context and create deterministic failure paths. Dispatch policy remains necessary, but it is the last boundary rather than the catalog design.

**Package a second physical preset root containing one copied directory.** Rejected because it duplicates an app-owned asset tree and can drift from the source layout. An exact logical roster lets a deployment share the app's immutable root while selecting the reviewed subset.

## Consequences

Product sessions have a stable professional prompt and smaller tool prefix, improving cache stability and reducing model drift. Disallowed directories may still exist on disk as ordinary DSH assets, but they are not capabilities of the locked deployment. A deployment using `allowedIds` cannot author a new preset and use it until its signed or trusted composition also updates the allowlist; that deliberate review step is the cost of a closed product roster.
