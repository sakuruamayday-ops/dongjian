# Agent Note: Manual real-API e2e receipts

Status: implemented

English | [中文](2026-08-20-manual-real-api-e2e-receipts.zh.md)

## Problem

The real DeepSeek API e2e suite proves provider behavior that deterministic tests cannot reproduce, but it consumes an external credential and depends on the availability and nondeterministic output of a remote service. Running it automatically for every push, pull request, nightly interval, or GitHub Release couples ordinary source and publication workflows to a secret that those operations do not need. A missing secret then looks like a release prerequisite even when every release artifact is built and verified without model inference.

The test suite self-skips without `DEEPSEEK_API_KEY`, so a manually requested receipt can still become a false green unless the workflow rejects an absent or misconfigured secret before the suite starts.

## Decision

The dedicated [real-API workflow](../../../../.github/workflows/e2e.yml) runs only through `workflow_dispatch`. A release operator dispatches it when a current external-provider receipt is required, including after a provider adapter, model protocol, assembled prompt, or real tool-use path changes. Ordinary pushes, pull requests, deterministic CI, builds, and GitHub Releases neither invoke this workflow nor require `DEEPSEEK_API_KEY_EXTERNAL`.

The workflow retains an unconditional preflight for a dispatched run. It maps the repository secret `DEEPSEEK_API_KEY_EXTERNAL` into the step-scoped `DEEPSEEK_API_KEY` variable, fails explicitly when the value is empty, builds the official library-mode application, pins `DEEPSEEK_BASE_URL` to `https://api.deepseek.com`, and runs the complete `pnpm run test:e2e` suite. Checkout, Node and pnpm setup, and dependency installation never receive the API key. Logs report only presence, never the value or its length, and the job retains read-only repository permissions.

This decision partially supersedes the automatic trigger cadence in [Real-API e2e in CI against the external DeepSeek API](2026-06-19-real-api-e2e-ci.md). That earlier record remains authoritative for the separate secret-bearing workflow, fail-loud preflight, secret mapping and hygiene, and prohibition on `pull_request_target`; this record owns when the workflow runs and whether ordinary GitHub operations need the key.

## Alternatives considered

**Run on every trusted pull request and push.** Rejected because it expands secret-bearing execution to code and publication changes that deterministic CI can validate, while remote availability and model variance can block unrelated work.

**Keep a nightly schedule as provider-drift monitoring.** Rejected because this product does not require periodic external-model health to merge or publish source. A release operator requests a receipt when provider-sensitive behavior changes or release evidence calls for it.

**Remove the real-API lane.** Rejected because deterministic fixtures do not prove authentication, live model protocol, streamed replies, or real provider tool interaction. The lane remains available as explicit evidence rather than an automatic gate.

**Allow the dispatched workflow to self-skip without a key.** Rejected because an all-skipped result would falsely claim a real-provider receipt. Preflight remains mandatory whenever the manual workflow is requested.

## Consequences

Source pushes, pull requests, and GitHub Releases remain independent of the DeepSeek credential and remote service health. A real-provider receipt has an explicit operator, ref, run time, and workflow result instead of being inferred from an unrelated automatic event.

The real-API signal can become stale because no schedule refreshes it. Release or adapter review must therefore request a new dispatch when current provider evidence matters. The repository secret still requires least-privilege handling and rotation, but its absence does not block deterministic CI or artifact publication; it blocks only an explicitly requested real-API receipt.
