# DeepSeek Harness RC.8 Base Compatibility Matrix and Upgrade Guide

English | [中文](deepseek-harness-rc8-compatibility.zh.md)

## 1. Purpose

This is an internal maintenance asset for Gongchuang Enterprise Assistant. It describes only the DeepSeek Harness base used by V0.1.3, the Gongchuang extension boundaries, the required patches, and the review sequence for an optional future upgrade. It is not a compatibility promise for future upstream releases, does not require the product to track upstream continuously, and is not a V0.1.3 release gate.

After the client stabilizes, the Gongchuang team maintains it independently. Adopting a later DeepSeek Harness version requires a deliberate maintenance project, evaluation, and validation. Upstream developer previews, future breaking changes, and upstream release cadence are outside the current product scope and are not current release risks.

## 2. Current Base Identity

| Item | Current value | Maintenance note |
| --- | --- | --- |
| Upstream project | `deepseek-ai/deepseek-harness` | Provenance only; never publish the Gongchuang product to this repository |
| Base version | `0.1.0-rc.8` | Fixed architecture for V0.1.3 |
| Upstream commit | `141eb6fef83422698aef7a981029e843e8161531` | Starting point for internal difference review |
| Gongchuang client | `0.1.3` | Independent product version |
| Gongchuang skill suite | `1.6.7` | Independently signed and updated |

## 3. Gongchuang Extension Boundaries

| Boundary | Current attachment mechanism | Main location | Regression focus |
| --- | --- | --- | --- |
| Product UI | Client slots inject the sidebar, overlay pages, and composer tools | `packages/client/ui-gongchuang-product` | Chinese UI, enterprise spaces, composer, accessibility |
| Client startup | Inert boot manifest and CSP-safe bootstrap | `packages/client/modules`, `packages/client/web` | `__ModuleLoader__`, `__DSH_BOOT__`, dynamic module loading |
| Host capabilities | Remote API and product Host composition | `packages/api/remotes`, `packages/host`, `apps/desktop` | Schemas, mounted namespaces, Electron preload, CSP |
| Product identity | Product manifest, Cordis patch, and version source | `product/gongchuang-client` | Matching client, policy, base, and skill versions |
| Professional capabilities | Signed skill suite, runtime, and marketplace projection | `packages/product/gongchuang-signed-skill-runtime`, `packages/skill/gongchuang-skill-marketplace` | Signature, index, install, update, provenance, and license |
| Security boundary | Existing Host confirmations, policy gate, and credential isolation | `packages/guard`, `apps/desktop` | Release, submit, send, delete, and external actions |

## 4. Required Patches for the Current Base

These patches apply only to the current RC.8 and Gongchuang product composition. They do not create a custom ABI or a separate compatibility layer:

1. The Electron Host uses `script-src 'self'`. The boot manifest must remain inert JSON, and executable bootstrap code must use a same-origin external script or an equivalent CSP-safe interface. `unsafe-inline` is prohibited.
2. Client Modules retain the RC.8 module-loading types and startup entry, while a real Electron startup smoke verifies the manifest, loader, and boot state.
3. Remote API mounts the file-reference and session-reference namespaces required by RC.8. Both the schemas and the actual `$mount` list are covered by regression tests.
4. The Gongchuang UI adapts RC.8 interfaces such as `openFile(): void`, Workspace `home`, and input-error presentation in the product layer. Gongchuang business logic is not written into upstream core code that has no extension interface.
5. The Web Client respects the RC.8 dynamic-plugin boundary. Product features enter through slots, plugins, and the product manifest.

## 5. Difference Review Sequence for an Optional Upgrade

Run this sequence only after maintainers deliberately decide to evaluate a new base:

1. Record the candidate upstream version and commit, then compare module loading, Remote schemas, Client slots, Web bootstrap, and Electron security changes from `141eb6fef8` to the target commit.
2. Run upstream startup and type checks without Gongchuang product extensions first, separating upstream regressions from product-adaptation issues.
3. Restore Remote API, module bootstrap, product slots, the product manifest, and the signed-skill runtime one layer at a time.
4. Run the startup-compatibility and Gongchuang-plugin regressions below. If they fail, stop the upgrade evaluation; the existing RC.8 product line remains unaffected.
5. Change the product-version documentation only after the new base receives an independent product decision, full regression evidence, and candidate evidence.

## 6. Current Regression Commands

```bash
pnpm exec vitest run \
  packages/client/web/tests/boot.client.spec.ts \
  packages/client/modules/tests/node-half.client.spec.ts \
  packages/host/apiproxy/tests/rpc-schemas.spec.ts

pnpm exec vitest run packages/client/ui-gongchuang-product/tests

pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json
pnpm exec tsc --noEmit -p packages/client/web/tsconfig.json
pnpm exec tsc --noEmit -p packages/client/ui-gongchuang-product/tsconfig.json

pnpm run test:gui
pnpm run typecheck
```

A CSP startup smoke against real Electron or a packaged candidate must be run separately and recorded under TST-13 in the product document. Ordinary GUI unit tests do not emulate browser CSP and cannot replace that evidence.
