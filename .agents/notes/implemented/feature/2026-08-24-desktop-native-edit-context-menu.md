# Agent Note: desktop native edit context menu

Status: implemented

English | [中文](2026-08-24-desktop-native-edit-context-menu.zh.md)

## Problem

The desktop renderer did not provide editing commands when a user opened the context menu in the composer, and selected generated text had no reliable context-menu copy action. A renderer-owned imitation would need to reproduce platform clipboard enablement and could conflict with product menus already attached to sidebar rows.

## Decision

The Electron main process handles Chromium's `context-menu` event for the desktop window. An editable target receives native `cut`, `copy`, `paste`, and `selectAll` roles enabled by Chromium's edit flags. A non-editable target receives native `copy` only when Chromium reports selected text. Other page chrome receives no main-process menu, so renderer-owned product menus keep their existing behavior.

Native Electron roles remain attached to the focused control or document selection. Paste and cut therefore travel through the browser's ordinary input events and update the controlled composer draft; copy uses the current selected range without mirroring text into product state.

## Alternatives considered

**Build a custom renderer menu.** Rejected because it would duplicate platform clipboard rules, keyboard behavior, focus handling, and enablement that Electron already exposes.

**Open the editing menu on every right-click.** Rejected because empty page chrome does not have an editing action and a global menu would interfere with existing sidebar item menus.

## Consequences

Desktop text editing follows operating-system menu behavior and generated text can be copied without adding another toolbar. The feature is desktop-only; browser deployments continue to use their browser's native context menu. Unit coverage pins editable, selected-text, disabled-command, and empty-target templates, while packaged desktop acceptance verifies clipboard round trips.
