# Ponytail integration decision

Date: 2026-08-16

Upstream reviewed: `DietrichGebert/ponytail` 4.9.0. The review used the
`v4.9.0` tag (`0a4dd63ad4541f4f655c4108a295916f3c1d8fda`) and current `main`
(`2ed6c52c9d7e5e56942508591085fd45dea277d3`). Upstream is MIT licensed.

## Product decision

The upstream plugin is designed for coding tasks. It injects YAGNI,
standard-library-first, native-platform-first, and minimum-code instructions
through host-specific lifecycle adapters. Its MCP server only exposes a prompt
and a read-only instruction tool; it cannot portably inject rules on every turn.

The V0.1 enterprise client therefore does not load the upstream Node package as
same-process Cordis code and does not enable the original coding persona in
professional business sessions. Doing so would conflict with mandatory policy
version checks, evidence collection, signed Skill contracts, accessibility,
security, and formal-delivery gates.

The useful principle is adopted as the signed product-owned “minimum sufficient
execution” rule:

1. Reuse confirmed conversation facts, successful current-turn tool receipts,
   enterprise-space material with the same scope, verified Skills, and existing
   Host capabilities before doing new work.
2. Execute only missing steps. A successful read, search, calculation, Skill
   activation, or validation is repeated only after failure, source/version
   drift, or a new evidence conflict.
3. When a Skill expands required dependencies, notify the model immediately and
   activate all of them before candidate construction and validation.
4. When professional validation fails, retain `candidateText`, `evidence`, and
   `calculations`; patch only the listed gaps and do not restart discovery.
5. Reuse DSH's existing `repeat-tool-reminder` at product thresholds `[2, 3, 5]`
   instead of adding another loop-detector dependency.
6. Never minimize away professional evidence, current policy verification,
   signed delivery contracts, input validation, security, accessibility, or
   error handling that prevents data loss.

## Optional upstream packaging

If a future client release exposes a dedicated coding workspace, the original
Ponytail Skill can appear as an optional third-party development Skill. It must
be version- and digest-pinned, carry the upstream MIT notice, remain outside the
V1.6.6 professional bundle, and never receive native plugin or command execution
rights through the community marketplace. V0.1 has no coding workspace, so an
always-on upstream installation would add no customer value and is not shipped.

## Acceptance criteria

- No identical successful read/search call is repeated without an explicit
  failure, version change, or conflict.
- Newly expanded Skill dependencies are visible before the first professional
  validation call.
- Percentage calculations use the validator's declared `ratio` semantics.
- A validator retry reuses existing evidence and changes only reported gaps.
- The next scoring, checkup, peer, and report golden runs record tool-call and
  validation-attempt counts so regression is measurable.
