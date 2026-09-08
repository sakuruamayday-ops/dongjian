# Agent Note: Gongchuang partitioned graph memory

Status: implemented

English | [中文](2026-08-17-gongchuang-partitioned-graph-memory.zh.md)

## Problem

Ordinary and professional conversations need to reuse stable methods, corrections, and task context without turning the client into a professional-only assistant or mixing information between unrelated enterprises. A cloud memory service would add account-side storage and network dependency, while one shared local graph could surface one enterprise's history in another enterprise space.

## Decision

The desktop composition mounts `@gongchuang/graph-memory`, adapted from the MIT-licensed Graph Memory Community Core. It stores one personal SQLite graph and one independent graph for each enterprise Workspace. Every extraction, recall, search, and record operation resolves the partition from the active Session; neither the model nor the renderer supplies a database path or enterprise identifier.

Completed user and assistant messages are extracted asynchronously with the model already selected for that Session. Tool results participate only when the user enables that setting. Extraction and graph maintenance cannot block the visible response, and retrieval uses Node's built-in SQLite FTS5 without an embedding credential or separate service.

Relevant history enters `system-prompt/assemble` as a bounded, request-specific suffix that identifies itself as untrusted reference material. It cannot replace the current instruction, establish a current policy or enterprise fact, or add a professional restriction to an ordinary conversation. The model also receives four Chinese memory tools scoped to the active partition: status, search, record, and statistics.

The Settings page can disable extraction and recall immediately, control tool-result participation, display aggregate counts, and clear all local graph data. Clearing waits for active extraction work and preserves original conversations and enterprise files. The renderer receives only preferences and counts, never graph content or database paths.

## Alternatives considered

**Use the upstream Pro interface.** Rejected because version 1.6.0-beta.1 documents the Community core as available while its DSH Pro management interface is not delivered. The client implements only the controls backed by its Host service.

**Run Graph Memory as an MCP server.** Rejected for the built-in default because it adds a second process and connection lifecycle for data that is device-local and already has Cordis Session and Workspace identity. Users can still add independent memory MCP servers through the generic MCP page.

**Use one database for all conversations.** Rejected because query filtering would become the only barrier between enterprise histories. Separate files make the enterprise isolation property independent of model behavior and query wording.

**Require embeddings.** Rejected because FTS5 provides a useful local default without another model, credential, download, or packaged runtime. Embedding support remains optional and is not enabled by the product composition.

## Consequences

Long-term memory is available to general conversations and professional workflows without changing the Agent Loop or professional template defaults. A user's correction can be reused later, while current instructions and freshly verified evidence remain authoritative. Local graphs do not synchronize across devices in V0.1, and the settings page does not edit individual nodes or relationships. Focused package, Remote-controller, service-composition, and enterprise-isolation tests cover the shipped operations; packaged macOS and Windows runtime tests remain part of installer acceptance.
