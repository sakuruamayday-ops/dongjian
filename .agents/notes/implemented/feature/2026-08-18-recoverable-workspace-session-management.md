# Agent Note: recoverable Workspace and Session management

Status: implemented

English | [中文](2026-08-18-recoverable-workspace-session-management.zh.md)

## Problem

A Session's stored cwd is immutable, and Workspace attachment accepts a Session only when that cwd resolves to the Workspace's canonical path. Reassigning an existing Session would either rewrite durable identity or create a membership record that the Workspace must reject. Workspace and Session removal also needs a recoverable visibility state so product actions never delete enterprise directories, user files, or persisted logs.

## Decision

Workspace and Session archive and delete are separate, recoverable visibility states. The Workspace domain persists four mutually constrained id sets: archived and soft-deleted Workspaces, and archived and soft-deleted Sessions. Soft-delete never removes a Workspace record, enterprise directory, user file, workspace session account, or persisted session log.

The Host exposes complete management snapshots through `workspace.list`, the management unary methods, and `host/workspace-management-changed`. Client runtime projects active, archived, and deleted Workspace rows separately and hides archived or deleted Sessions without removing their list/log data. `listArchived`, unarchive, and restore callbacks give Settings a real recovery path instead of a visual-only page.

Moving a Session to another Workspace is a recoverable copy operation. `session.fork` accepts an optional target `workspaceId`; an active target gives the child its canonical path while the source header remains unchanged. The child retains the completed seed history, latest logged model selection, title events, and `parentSession` lineage. Unknown, archived, or soft-deleted targets and running sources fail before child publication.

`WorkspaceRuntime.moveSessionToWorkspace` returns the source id for an already-accounted target. Otherwise it forks into the target and archives the source only after the Host confirms target attachment. Fork or attachment failure leaves the source active. Archive failure leaves both the attached child and source active, so recovery never depends on reconstructing deleted data.

The older `workspace.delete` remains an explicit registration-removal operation for existing callers. Product UI delete actions use `deleteWorkspace` and `deleteSession`; they do not call the registration-removal operation and do not touch source files.

## Alternatives considered

**Rewrite the existing Session cwd.** Rejected because cwd is durable creation identity used by replay, tools, and Workspace validation; mutating it would make historical execution context ambiguous.

**Attach the existing Session directly to the target Workspace.** Rejected because the Workspace correctly refuses a canonical cwd mismatch, and bypassing that check would corrupt grouping semantics.

**Archive the source before creating the child.** Rejected because fork or attachment failure would hide the only usable Session. Source archival is the final commit point.

**Permanently delete archived or moved records.** Rejected because the product requires restoration and must preserve enterprise files and session logs.

## Consequences

Moving produces a new Session id and explicit lineage instead of preserving object identity. A failed target attachment may leave a published ungrouped child, and a failed source archive leaves two active Sessions; both outcomes retain all data and are visible to reconciliation rather than hiding the source. Running Sessions must finish or stop before a move can capture their full completed history.

## Validation

- Workspace domain persistence and restart-safe defaults, including archive/delete mutual exclusion.
- Host schema, target-aware fork behavior, immutable source cwd, lineage, active-target rejection, running-source rejection, and attachment failure reporting.
- Client manager/runtime projections, target-cwd reconciliation, same-Workspace no-op, source archival ordering, stale-baseline protection, current-session clearing, and recovery callbacks.
- Fixture and test-runtime doubles implement the same action surface.
