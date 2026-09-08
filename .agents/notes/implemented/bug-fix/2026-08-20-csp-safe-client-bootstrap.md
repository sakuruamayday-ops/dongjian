# Agent Note: CSP-safe client bootstrap

Status: implemented

English | [中文](2026-08-20-csp-safe-client-bootstrap.zh.md)

## Problem

The RC.8 browser bootstrap installed `window.__ModuleLoader__` and assigned the Host graph through executable inline scripts. The desktop Host deliberately sends `script-src 'self'` without `unsafe-inline`, so Chromium rejected both scripts before the parser-preloaded module bundles could register. Unit tests executed the source directly and therefore did not exercise the production CSP.

CSP-safe markup still requires a complete packaged client graph. `ClientModuleRegistry` locates package manifests synchronously before it emits that graph. A packaged Host resolver that exposes `internal.import` without the Loader v2 `resolveSync` operation makes the registry fall back to the isolated profile entry URL, where `createRequire` cannot see packages in `app.asar`; composition then produces no client entries or batches, so the external facade remains in `queue` mode and no client module is preloaded.

## Decision

`@deepseek-ai/dsh-client-modules` serves the response-invariant registration facade as `/plugins/bootstrap.js` through its existing same-origin route. Its index transform emits that blocking external script first, an inert `#dsh-boot-manifest` `application/json` element second, and the modules/runtime parser preloads last. The web kernel reads the inert element and retains `window.__DSH_BOOT__` only as an embedding compatibility input.

The packaged Host installs a Loader v2 internal resolver whose `import` and `resolveSync` operations use the same Host-anchored resolution function. Relative specifiers retain their `parentUrl` semantics, file URLs and absolute paths retain their direct identities, bare specifiers resolve through the Host package's `createRequire` anchor, including packages stored in `app.asar`, and Node built-ins are recognized with `isBuiltin` and normalized to `node:` URLs. Synchronous manifest discovery and asynchronous module loading therefore observe the same package graph.

The fallback reports Node's format instead of treating every resolved URL as ESM: `.mjs` is `module`, `.cjs` is `commonjs`, `.json` is `json`, `.wasm` is `wasm`, and `.js` or extensionless files follow the nearest package `type`. Supported JavaScript, JSON, and Wasm `data:` media types receive the corresponding format. JSON requires its `type: json` import attribute; other attributes, unsupported data media types or file extensions, and non-evaluation phases fail explicitly because this packaged fallback does not claim the full Node internal-loader protocol.

The desktop lifecycle acceptance launch probes the packaged renderer after `loadURL`: the graph element is inert JSON, the loader has entered `live` mode, and the document contains no executable inline script. Packaged acceptance also captures renderer errors and rejects inline-script CSP violations.

## Verification

The app-boot regression covers `resolveSync` and `import` for bare, relative, file-URL, absolute, and built-in specifiers; it also pins CJS, package-typed JavaScript, JSON, Wasm and `data:` formats plus import-attribute and phase rejection. Direct composition from an actual desktop `app.asar` with Loader, WebServer, and ClientModules produced one client entry and one bootstrap batch containing `@deepseek-ai/dsh-client-modules`; the lifecycle acceptance remains the final packaged Chromium/CSP check.

## Alternatives considered

- **Allow `unsafe-inline` in the desktop CSP.** This would make RC.8 start but weaken the executable-script policy for the entire renderer and hide future inline regressions.
- **Add a per-response nonce or source hash.** The bootstrap source is response-invariant and can be served as an ordinary same-origin resource, so nonce generation and propagation add policy state without enabling a required behavior.
- **Put the facade only in the product shell's public assets.** The modules package owns the registration protocol and also serves the parser-preloaded bundles; making each shell carry a matching bootstrap copy would create version skew between the protocol and its implementation.
- **Keep an import-only Host resolver and rely on registry fallback.** The fallback is anchored to the profile entry URL, which is intentionally isolated from the packaged application. It cannot discover `app.asar` package manifests and silently composes an empty client graph.

## Consequences

The bootstrap adds one blocking same-origin request before parser preloads. Boot graph data is no longer executable, and the desktop keeps `script-src 'self'` without an inline exception. The packaged resolver must keep synchronous discovery, format classification, and asynchronous loading on one Host anchor; changing one independently can turn a valid CSP document into an empty or incorrectly typed boot graph. Unsupported loader features stop at the resolver rather than acquiring misleading `module` semantics. Node-half, web, app-boot, direct ASAR composition, and lifecycle acceptance cover the source-to-packaged path.
