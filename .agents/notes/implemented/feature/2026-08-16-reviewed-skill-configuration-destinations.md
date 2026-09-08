# Agent Note: Reviewed skill configuration destinations

Status: implemented

English | [中文](2026-08-16-reviewed-skill-configuration-destinations.zh.md)

## Problem

Community catalogues can mark a skill as service-backed or credential-dependent, but their skill detail page is not necessarily the vendor's login, authorization, or key-management destination. Treating a marketplace detail URL as a configuration URL made an `Install and configure` action navigate to the wrong page and could leave users believing that installation completed external setup.

## Decision

ModelScope and SkillHub detail URLs remain provenance links only. A community skill receives automatic post-install configuration navigation only when its exact coordinate is mapped to a reviewed official vendor URL in the Host. Platform metadata can still set `requiresConfiguration`, but without a reviewed destination the client labels the skill `manual configuration required`, installs it normally, and performs no automatic navigation.

Custom repository manifests may carry a public-HTTPS `configurationUrl` because the repository author explicitly owns that data contract and it is validated with the manifest. Installed ModelScope and SkillHub records ignore old persisted configuration URLs and re-project the current reviewed mapping, which migrates earlier installations that incorrectly stored a community detail page.

## Alternatives considered

**Use catalogue detail pages as configuration destinations.** A catalogue page records provenance but may not provide vendor login, authorization, or key management, so automatic navigation there can misrepresent external setup as complete.

## Consequences

Skill cards and details distinguish three states: no additional configuration, manual configuration without a trusted destination, and automatic entry into a reviewed official destination. When an installed skill has a reviewed destination, its detail keeps an `Open official configuration` action so users can reconfigure it later. Installation and configuration remain separate states; opening a vendor page never marks an external tool ready. Adding another automatic destination requires a coordinate-specific review and regression test.
