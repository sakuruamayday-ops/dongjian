---
description: "The product-specific Host service family for the Gongchuang desktop client, including account, memory, automation, model connection, signed skill, and user-error ownership."
kind: "package-group"
---

# product/ — Gongchuang product services

English | [中文](README.zh.md)

## Summary

The product group contains the Host-owned services that make the Gongchuang desktop composition a coherent product. These packages keep account material, local graph memory, automation state, verified model routes, signed skill execution, and redacted user errors behind typed Cordis services. Browser packages consume sanitized snapshots and commands; they do not take ownership of credentials, databases, executable runtimes, or diagnostic details.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | Primary service |
|---|---|---|
| [`gongchuang-account/`](gongchuang-account/README.md) | Server account authentication and sanitized personalization snapshots | `ctx.gongchuangAccount` |
| [`gongchuang-graph-memory/`](gongchuang-graph-memory/README.md) | Partitioned local graph memory owned by the desktop Host | `ctx.gongchuangGraphMemory` |
| [`gongchuang-local-automation/`](gongchuang-local-automation/README.md) | Persistent local schedules, run claims, and result-session binding | `ctx.gongchuangLocalAutomation` |
| [`gongchuang-model-connections/`](gongchuang-model-connections/README.md) | Credential-backed model endpoint verification and catalog publication | `ctx.gongchuangModelConnections` |
| [`gongchuang-signed-skill-runtime/`](gongchuang-signed-skill-runtime/README.md) | Constrained execution of operations declared by the verified skill bundle | `ctx.gongchuangSignedSkillRuntime` |
| [`gongchuang-user-errors/`](gongchuang-user-errors/README.md) | Stable user-facing diagnostic codes and redacted local-log details | shared formatter API |

-----

<a id="related-documentation"></a>
## Related documentation

Read the subsystem pages for the shared runtime contracts used by these product services.

- [Credentials subsystem reference](../../docs/subsystems/credentials.md) — Host-owned secret resolution and provider boundaries.
- [Storage subsystem reference](../../docs/subsystems/storage.md) — persistence ownership and coordinated writes.
- [Jobs subsystem reference](../../docs/subsystems/jobs.md) — durable background work and lifecycle semantics.
- [LLM streaming subsystem reference](../../docs/subsystems/llm-streaming.md) — model adapters, catalogs, and request usage.
- [Skills subsystem reference](../../docs/subsystems/skills.md) — skill providers, catalogs, and model-facing loading.
- [Tools subsystem reference](../../docs/subsystems/tools.md) — tool publication and invocation ownership.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep product-specific state and trust boundaries in these Host services. Client packages should consume typed snapshots and commands instead of reimplementing credential, persistence, or execution ownership.

</details>
