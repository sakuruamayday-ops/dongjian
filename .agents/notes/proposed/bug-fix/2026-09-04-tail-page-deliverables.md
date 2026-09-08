# Agent Note: Deliverables in partial turn history

Status: proposed

English | [中文](2026-09-04-tail-page-deliverables.zh.md)

## Problem

Native B20 reopened synthetic session `session-8c943363-beb6-4bd1-882f-d80e559a4d12` without a file card. Loading the preceding history page restored the marked draft card, which opened the exact DOCX in WPS. The durable tail already contained the successful probe and Host-owned draft file mapping. The deliverables definition withheld all turn data until pagination supplied `turn/start`.

## Proposal

Keep the existing definition, turn identity and event reducers. When the engine has no started state, derive deliverables only from this context's loaded matches using the same reducer. A complete PTC publication or Host quality notice is self-contained; a root result needs its loaded call arguments. Do not scan other contexts, infer paths from prose, load the entire transcript automatically or fabricate a start event. Ordinary full-turn updates retain their incremental state path.

This applies the existing fallback rule in [Conversation assembly](../../../../docs/subsystems/conversation.md) without superseding its [ownership decision](../../implemented/architecture/2026-08-09-client-conversation-node-assembly.md).

## Alternatives considered

**Load the entire turn before rendering.** This would make access to an already-published file depend on additional history requests and would hide useful terminal receipts already in the loaded page.

**Synthesize a start or infer paths from model prose.** Neither creates trustworthy publication evidence; both blur the existing event ownership and replay semantics.

## Acceptance criteria

Native reproduction and focused tests cover missing turn starts, marked file replacement, multiple PTC files, text-only drafts, failed and orphan results, untrusted metadata and turn isolation. Prepending the true start must preserve deduplication and latest classification. Package and assembled-client tests plus a newly packaged native replay are required; this change does not certify report content or reset a model's validation budget.

## Risks

The fallback can only reconstruct complete facts in the loaded context. A root result without its call arguments still cannot produce a card. Pending contexts replay their own matches when updated; started contexts retain ordinary incremental reduction. File openability does not imply professional content approval.
