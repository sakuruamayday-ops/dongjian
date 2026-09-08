---
description: "Community skill catalog and isolated installer for the Gongchuang desktop client."
kind: "package-reference"
---

# @gongchuang/skill-marketplace

English | [中文](README.zh.md)

## Summary

Host service for the 共创企业助手 skill center. It reads the bundled V1.6.7 skills and searches ModelScope and Tencent SkillHub through their public APIs. A user click installs a community skill directly into the current user's separate community-skill directory. Installation does not require license, code, command, platform-signature, or digest-lock review, and community skills cannot overwrite bundled skills. The downloaded archive digest derives the content-addressed installation identity; the registry does not persist unused repository-manifest or per-file digest inventories, so user-local edits remain available.

## Table of Contents

- [Behavior](#behavior)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Behavior

The client can also add a public HTTPS repository manifest. This is a data-only protocol: it cannot load Cordis packages or native code. A compatible manifest uses this shape:

```json
{
  "schemaVersion": 1,
  "id": "example.skills",
  "name": "Example Skills",
  "homepage": "https://example.com/skills/",
  "skills": [
    {
      "coordinate": "@example/report-writer",
      "name": "Report Writer",
      "description": "Create a structured report.",
      "category": "office",
      "version": "1.0.0",
      "archiveUrl": "./report-writer.zip",
      "configurationUrl": "https://example.com/account/integrations/report-writer"
    }
  ]
}
```

Manifest and archive URLs use HTTPS. A manifest needs the skill identity, version, description, and archive URL. `archiveSha256` may remain as upstream metadata but is not an installation requirement. The client performs only the ZIP reading, directory writing, and `SKILL.md` handling needed to complete installation.

Search requests retain the upstream market's `page`, `pageSize`, and `total` fields so the client can render real pagination instead of truncating the catalogue to its first page. Marketplace cards expose a details view before installation. A platform configuration marker does not make its community detail page a credential destination: ModelScope and SkillHub skills open a vendor page only when that exact coordinate has a confirmed official URL. Otherwise the client installs the skill and says that configuration must be completed from its documentation without navigating automatically. A custom manifest may declare its own public-HTTPS `configurationUrl`. Every automatic navigation happens after installation completes. Opening the page is not treated as proof of authorization; tool availability still depends on the connector or credential verification result.

The 共创精选 feed is not a fixed first-page snapshot. It combines a stable core of office, policy, legal, OCR, and document-delivery skills with a deterministic daily window of business-relevant enterprise, intellectual-property, finance, patent, and Chinese-writing skills. Missing upstream entries are omitted and installed entries are marked by the Host, so the client can show accurate installed state without inventing local catalogue state.

Downloaded skills are exposed through a separate community Skill provider. The browser never receives ZIP bytes or local filesystem paths.

## Dev Note

Community skills remain separate from the signed bundled suite and cannot overwrite its files or acquire connector access by installation alone.

## Runtime Invariant

No runtime invariant companion is published because signed installation transactions and services own their checks, and this package has no durable event relation of its own.

## Model Experience

### Installed community skill catalogue

#### What the model sees

Installed community skills with a readable `SKILL.md` enter the shared `ctx.skills` provider. The owning Skill consumer decides when their name, description, instructions, or bundled references become visible.

#### Token effect

Search, details, pagination, and download checks add zero model tokens. An installed skill adds only the tokens projected by the Skill consumer when that skill is eligible or invoked.

#### KV Cache effect

An unchanged installed-skill set preserves existing request prefixes. Installing or replacing a skill invalidates the provider snapshot so a later request may receive a changed skill contribution.

## Known Limitations and Deferred Work

- Community skills are stored in a separate user directory and cannot overwrite bundled skills; a downloaded community ZIP is not executed as an application installer.
- ModelScope, SkillHub, and custom repositories remain external availability dependencies. Cached installed skills remain local when a catalogue search is unavailable.
- Only community skills with an explicitly configured vendor URL receive automatic post-install configuration navigation; other service skills remain installable and use their documentation for manual configuration.
- Opening a post-install configuration URL does not grant tool access; a separate connector or credential verification must still succeed.
