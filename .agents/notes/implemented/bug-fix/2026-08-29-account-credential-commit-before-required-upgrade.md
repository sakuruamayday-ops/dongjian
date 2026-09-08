# Agent Note: Account credential commit before required upgrade

Status: implemented

English | [中文](2026-08-29-account-credential-commit-before-required-upgrade.zh.md)

## Problem

The account server can authenticate a password login and simultaneously require a newer client. Returning on the compatibility result before storing the verified token made the newly installed application ask for the password again, even though the same server response had already admitted the device.

## Decision

Password login first validates the login receipt and its device-bound `/v1/me` response, then commits the username, optional password, automatic-login flag, and token through the operating-system credential service. Only after that complete success path does it publish either `connected` or `upgrade-required`. The required-upgrade state still rejects agent requests until a supported binary verifies the retained token.

## Alternatives considered

**Do not save any material for an unsupported client.** Rejected because authentication already succeeded and the token is required to make the signed application update preserve login state.

**Publish `connected` until the update starts.** Rejected because it would weaken the server's minimum-version decision and allow model work from an unsupported client.

## Consequences

An application update can resume the verified account without another password prompt. A rejected or inconsistent login still commits nothing, and a required upgrade remains a hard model-request block. The account test rebuilds the service from the committed credential records and proves both restoration and continued blocking.
