# Agent Note: Gongchuang client signed policy boundary

Status: implemented

English | [中文](2026-08-14-gongchuang-signed-policy-gate.zh.md)

## Problem

共创企业助手 must not degrade into generic chat when switching among DeepSeek, OpenCode, and custom API providers. V1.6.6 defines factual limits, calculation rules, structures, and validation for high-tech drafting, enterprise identity, policy retrieval, peer comparison, scoring, checkups, reports, and Chinese humanization. Merely placing `SKILL.md` in model context still depends on voluntary model compliance.

## Decision

The client and skill suite keep independent versions: client `V0.1` and bundled skill suite `V1.6.6`. A signed desktop host owns the process, publishes only a controlled Cordis composition, and supplies an exact-byte Ed25519 policy envelope to the private `@gongchuang/client-policy-gate` package.

The native plugin verifies signature and product identity synchronously during load. The awaited `agent/pre-step` waterfall gates every provider before the first request. The `tools/pre-execute` waterfall applies deny-first, ask-second, allow-last matching with deny-by-default semantics, denies unattributed calls unless the signed policy opts in, and preserves stricter downstream decisions. A missing, malformed, tampered, or version-drifted envelope fails closed.

The plugin pins the three product provider families, deny-by-default attribution rule, required product tools, raw-command denials, professional receipt, and four formal-artifact receipt identities in code as well as in the signed manifest. A valid signature cannot authorize a weaker V0.1 policy. Raw shell, PowerShell, terminal, background-job, subagent, and workflow tools are denied; browser and computer automation remain approval-gated.

Compatibility hooks are migration adapters only. They are not part of the trust boundary. The production host must make the gate non-removable and keep every filesystem, process, browser, network, and third-party-plugin action behind the same broker.

The desktop host verifies the skill suite's file-by-file Ed25519 index, then gives the gate immutable paths to `delivery-contracts.json` and `skill-call-graph.json`. The gate routes from the user's original task, recursively expands `requires` and `quality_gate` relationships, and records activation only after the real `skill` tool succeeds. Task-owning skills determine response structure and task-specific identity checks; supporting dependencies contribute their factual and source checks without reclassifying the deliverable. If the turn lacks a required skill, output marker, or trusted delivery receipt, the host appends corrective steering and keeps the same turn open.

`@gongchuang/signed-skill-runtime` is the only model-callable process path for bundled skill scripts. Its tool accepts an operation id and closed structured parameters, never a command or script path. The Host rechecks the signed operation registry, every owned skill file, the embedded Python executable, workspace containment, sanitized environment, no-network sandbox, timeout, output bounds, and declared exit codes for every invocation. An operation additionally requires same-turn activation of its owning skill.

The Host records successful same-turn output from trusted read, search, fetch, and fixed MCP tools under the live call id and a Host-derived SHA-256. Every model-declared `verified` evidence row must bind one of those records; declared values and URLs must occur in its output, while user-provided values must occur in the current user input. This prevents a model from minting an attested source, but it does not establish source authority or prove semantic entailment; the active skill's source-selection, calculation, conflict, and review rules still decide professional acceptability.

Formal delivery activates from prompt triggers or a formal extension in a path-bearing tool argument. The professional kernel binds the extracted content and file digest; every later file mutation clears all content-bound receipts, and turn stopping reopens and rehashes the file. V0.1 accepts one formal artifact path per turn so each file receives an independent professional, openability, content, branding, and page-by-page visual receipt.

## Consequences

DeepSeek, OpenCode, and custom API routes traverse the same professional chain. Turn-level enforcement blocks structural drift such as missing high-tech innovation-capability sections, unbound verified evidence, stale formal-file receipts, or humanization without consistency review. Trusted producer tools are still required for real Word, PDF, PPT, and Excel content, openability, branding, and page-by-page visual receipts. Signed bundled scripts run through the Host-owned constrained runner while ordinary command execution remains unavailable; code signing, notarization, upgrade/rollback, and clean-device acceptance remain release gates.

## Alternatives considered

**Prompt-only enforcement.** Rejected because it is advisory and model-dependent.

**Codex or Claude compatibility hooks as the primary boundary.** Rejected because they cover only part of the lifecycle and specialized paths can bypass them.

**Asynchronous detached session-start verification.** Rejected because it can miss the first request.

**Allow-by-default tool matching.** Rejected because a newly installed third-party tool could escape review.

**OS credential storage without command denial.** Rejected because an arbitrary process running as the same signed-in user may still call platform credential APIs.
