---
name: dsh-project-state-reconciliation
description: Use after a release, long-running implementation, branch integration, or review when current project facts may conflict across CONTEXT.md, product metadata, evidence, tests, and Agent Notes; produces and verifies a minimal semantic state update without creating another state store.
---

# Reconciling project state

Use this workflow only when meaningful work may have changed durable project facts. Ordinary code inspection, passing commands, repeated facts, and transient debugging theories do not justify a state write.

The method is adapted from [Project State Governor](https://github.com/Ghost011118/project-state-governor), but this repository keeps its existing state owners. Do not create `PROJECT_STATE.md`, `.project/`, a status archive, or another canonical index unless the owner explicitly changes the repository design.

## Existing authorities

Resolve a claim from the narrowest authoritative source:

- product version and production baseline: `product/gongchuang-client/product-manifest.json` and the shared product-version source;
- published artifact and server state: immutable release receipts and signed manifests;
- current cross-cutting terminology and release facts: `CONTEXT.md`;
- product scope, requirements, verification, risks, and historical release rows: the Chinese product document;
- engineering rationale: active Agent Notes;
- implementation and test behavior: current code, configuration, focused tests, and Git history.

Archived Agent Notes are frozen historical evidence, never current authority. An implemented Agent Note stays current or moves through the established archive workflow as a complete triplet. This workflow must not edit, delete, translate, or relocate archived notes.

## Reconciliation

1. **Recall:** read applicable `AGENTS.md` files, the current branch and worktree, then only the state sources relevant to the changed area.
2. **Propose:** list only durable facts that were created, invalidated, completed, clarified, or superseded. Separate current-state prose from append-only historical release rows.
3. **Verify:** check each material claim against machine-readable identity, immutable receipts, current code, focused tests, and Git objects. Mark unresolved interpretations instead of converting them into owner decisions.
4. **Apply:** update the existing owning file with the smallest semantic change. Low-risk evidence-backed corrections may be applied directly; mission, scope, risk acceptance, external mutation, or uncertain deletion requires existing authorization.
5. **Consolidate:** remove duplicate current claims and stale active wording while preserving decision-relevant history and all required release evidence.

Do not copy conversation transcripts into repository state. Preserve a recurring pitfall only when it changes future decisions, and record its verified result rather than the chronology used to discover it.

## Verification and report

Run checks for the files actually changed. Product metadata changes require their focused contract tests; documentation changes require the applicable link, format, and pairing checks; a release-state correction must be compared with the referenced receipt. Do not add a new CI gate merely to run this workflow.

Report the current focus, changed state claims, unresolved blockers or decisions, files updated, and material evidence. State explicitly when reconciliation found no durable change so a future agent does not create status churn.
