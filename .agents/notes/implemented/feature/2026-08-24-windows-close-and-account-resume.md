# Agent Note: Windows close preference and account resume

Status: implemented

English | [中文](2026-08-24-windows-close-and-account-resume.zh.md)

## Problem

Windows users could not choose whether the title-bar close button exited or kept the application in the tray. Separately, startup could project an unauthenticated account snapshot before operating-system credential recovery settled, making a remembered user appear logged out on every launch.

## Decision

Windows stores a local close behavior with three values: ask, minimize to tray, or quit directly. First close and old silent-tray preference files migrate to ask. The Host emits one renderer request for ask mode, and a compact modal presents tray and quit as a plain vertical radio list without selected-row frames, plus remember, cancel, and confirm controls. Only an explicit remembered response persists tray or quit atomically to `desktop-preferences.json`; Settings exposes the same three values in a compact selector. Direct quit flows through `app.quit()` and the existing orderly runtime shutdown; macOS retains its menu-bar close behavior.

Account startup calls the serialized Host refresh path and waits for Keychain or Credential Manager recovery before projecting identity. Remember-password defaults to enabled but remains user-controlled. Only credential references and behavior preferences are persisted outside the operating-system credential store.

## Alternatives considered

**Keep tray behavior mandatory on every platform.** Rejected because the Windows user explicitly needs a direct-close choice and the two operating systems have different conventions.

**Cache the password in renderer settings.** Rejected because it weakens the existing credential boundary and does not solve the startup race.

## Consequences

An explicitly remembered Windows close behavior survives restarts, cancel leaves the window open, and direct exit remains orderly. Remembered identity is projected only after credential recovery settles. Unit tests cover preference migration, persistence, request-response correlation, prompt actions, and the refresh race; packaged Windows dialog and tray interaction plus real Keychain/Credential Manager restarts remain device acceptance items.
