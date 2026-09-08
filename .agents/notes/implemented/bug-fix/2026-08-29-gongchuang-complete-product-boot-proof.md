# Agent Note: Gongchuang complete product boot proof

Status: implemented

English | [中文](2026-08-29-gongchuang-complete-product-boot-proof.zh.md)

## Problem

The Electron shell can complete its CSP bootstrap and create a ready window even when the product plugin fails during activation. A lifecycle check that observes only the boot manifest, live module loader, CSP console, and window title therefore accepts an error page as a working product. The product plugin also reads the nested `remote.llm` service; Cordis authorizes that property separately from the parent `remote` service, so omitting the exact injection prevents the product shell from mounting.

## Decision

The Gongchuang product plugin declares both `remote` and `remote.llm`. Its real-composition regression loads Typert, API Gateway, Remote contributions, and the product plugin through Loader and a test-only `cordis.yml`; removing the nested injection causes Loader activation to fail, while the production declaration renders the visible product shell.

Packaged macOS acceptance and an uncommitted in-client update wait for the product body marker and a non-zero, visible `ProductSidebar` root, require the boot page to be absent, and reject a visible plugin failure. The update transaction cannot commit before those conditions hold. The lifecycle script evaluates the complete launch log again after shutdown. A renderer error, a plugin failure page, a missing or hidden product root, a CSP rejection, or an unexpected ready window in the controlled startup-failure case invalidates the run.

## Verification

The Loader composition test mutates only the product namespace in its negative case and observes the exact nested-service authorization failure. The positive case observes the body marker, sidebar contribution, and visible product name. The actual sidebar element carries the stable product-root marker used by packaged acceptance. Desktop tests pin the complete renderer receipt and execute the lifecycle helpers against valid and invalid logs, including late log entries.

## Alternatives considered

**Treat a ready BrowserWindow as product readiness.** Electron window readiness proves that the document loaded, not that all Loader entries activated or that the product UI replaced the boot page.

**Declare only the parent `remote` service.** Cordis nested property authorization is exact, so the parent declaration does not authorize `ctx.remote.llm`.

**Search only the first observed log prefix.** Renderer and CSP errors can arrive after the first success line. Rechecking the complete launch log keeps the acceptance result tied to the full process lifetime.

## Consequences

Packaged acceptance takes up to fifteen additional seconds when the product UI never completes, then fails with the observed probe state instead of accepting the boot document. The product's exact Remote dependency is visible in its injection declaration and executable composition test. The lifecycle receipt remains specific to the Gongchuang product marker and is not a generic readiness signal for other desktop compositions.
