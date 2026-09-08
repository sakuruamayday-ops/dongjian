# Agent Note: Bound macOS Native Teardown After Keychain Waits

Status: proposed

English | [中文](2026-09-04-native-exit-deadline.zh.md)

## Problem

The installed arm64 candidate completed runtime disposal at 01:07:48 on September 4, but its main process remained alive. A native sample one minute later showed a thread waiting in `SecItemCopyMatching` and Keychain decryption. Electron native exit had stopped dispatching the existing JavaScript deadline. The helpers had already exited; runtime shutdown success was not process exit success.

## Proposal

Keep the existing ten-second durable disposal deadline and twelve-second absolute exit deadline. On macOS, arm `alarm(12)` through the already bundled Koffi binding at the start of quitting, alongside the existing JavaScript fallback. The kernel alarm does not need a live JavaScript event loop and expires with this process, so it cannot signal a reused PID. Normal shutdown still uses Electron exit and finishes before the alarm. This does not run during ordinary application use or bypass Keychain consent.

## Alternatives considered

**Rely only on a JavaScript timer.** A blocked native Keychain call can stop the event loop from dispatching that timer.

**Terminate immediately when Keychain is unavailable.** This would skip ordinary durable runtime disposal and could lose pending state.

## Acceptance criteria

An isolated process arms the real native deadline, then blocks JavaScript for twenty seconds. It must terminate by `SIGALRM`, not the JavaScript callback or the test's later cleanup. Existing successful disposal, timeout, signal, and window-lifecycle cases remain covered. The rebuilt signed App must also exit while its real Keychain authorization remains unavailable; source tests alone do not prove native acceptance.

## Risks

The native alarm is process-wide. It must arm only during quit, expire with the process, and leave the normal shutdown path enough time to finish first.
