# Agent Note: Client password recovery entry

Status: proposed

English | [中文](2026-09-04-account-password-recovery.zh.md)

## Problem

The account login dialog has no recovery action when a user forgets the password. Website and desktop authentication share an account, so a separate desktop recovery implementation would duplicate account policy.

## Proposal

The candidate adds a localized Forgot password link to the existing login form. The Host-validated portal origin owns its destination; an empty origin hides the action. Opening the link neither submits the login nor transfers its username or password. The website owns company-name matching, password replacement and login-session revocation.

This is a new entry path, not a replacement for startup credential restoration or the existing keychain retry decision. Those notes remain active.

## Alternatives considered

A native reset form would duplicate the website's validation and lifecycle. A hardcoded public URL would ignore the Host's account configuration. Neither is used.

## Acceptance criteria

The product sidebar suite passes 56 tests, including disconnected, offline and superseded recovery links, unchanged login input and an unloaded portal origin. A published client artifact and native external-browser verification are still required before this note becomes implemented. No B18/B19 installation is replaced by this change.

## Risks

The owner explicitly selected username plus registered company name instead of administrator review or a private recovery code. Company names are public information and do not prove account ownership. The website retains rate limits and CSRF checks, but these do not remove that takeover risk. This client candidate is not a formal installer release.
