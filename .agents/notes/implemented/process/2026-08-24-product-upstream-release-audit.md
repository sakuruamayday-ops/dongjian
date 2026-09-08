# Agent Note: product upstream release audit

Status: implemented

English | [中文](2026-08-24-product-upstream-release-audit.zh.md)

## Problem

The product adapts source or interaction decisions from several GitHub projects, but those relationships were scattered through prose and could drift before a release. Treating every moving reference branch as a packaging blocker would make unrelated documentation or design changes halt releases, while ignoring the shipped foundation or routing adaptation could miss applicable fixes.

## Decision

`product/gongchuang-client/upstream-products.json` is the product-level inventory of reviewed GitHub projects. Each entry records the repository, tracked release or branch, reviewed commit, adopted commit, relationship, and release policy. Desktop packaging input checks query GitHub immediately before each platform package. The query resolves authentication once for the complete audit: `GITHUB_TOKEN` takes precedence over `GH_TOKEN`, a locally authenticated `gh auth token` is the desktop-release fallback, and only a machine with neither uses GitHub's anonymous allowance.

The exact DeepSeek Harness source foundation and the adapted `dsh-routing-suite` behavior use `must-match`: movement requires review and an inventory update before packaging. Design references that are not shipped code use `report-change`: movement is printed for review but does not block a package by itself. The audit does not update source automatically and does not replace dependency-lock or security review.

## Alternatives considered

**Pin every reference branch as a package blocker.** Rejected because a documentation-only or unrelated design-reference commit does not change shipped product behavior.

**Check upstreams on a schedule.** Rejected because the required decision point is the irreversible release package, and routine development does not need a network-dependent check.

**Automatically merge the newest upstream commit.** Rejected because source foundation updates and adapted methods require product-specific compatibility review and tests.

## Consequences

Each release reports the current upstream identities and stops packaging when a shipped foundation or required adapted baseline moved without review. Reference projects stay visible without making their active branches an availability dependency. GitHub availability is therefore a release-input dependency, and a failed query must be resolved before packaging rather than silently treated as current.
