import type { LoggerType, Message } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createHostRuntimeDiagnosticsExporter,
  redactedHostRuntimeDiagnostic,
} from '../src/host-runtime-diagnostics.ts'

function message(name: string, type: LoggerType, ...args: unknown[]): Message {
  return { sn: 1, ts: 1, name, type, level: type === 'error' ? 0 : type === 'info' ? 1 : 2, args }
}

describe('Host runtime diagnostic persistence', () => {
  it('mounts the exporter into the desktop Host and bounds the persisted log', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/main.ts'), 'utf8')
    expect(source).toContain('ctx.logger.exporter(createHostRuntimeDiagnosticsExporter')
    expect(source).toContain('log.transports.file.maxSize = DESKTOP_LOG_MAX_BYTES')
  })

  it('keeps a product diagnostic code while discarding raw account data', () => {
    const raw = [
      '[GC-ACCOUNT-UNKNOWN] login failed',
      'username=wangyudi password=top-secret',
      'prompt=private customer text',
      'path=C:\\Users\\34121\\secret.docx',
    ].join(' ')
    const line = redactedHostRuntimeDiagnostic(message('gongchuang-account', 'warn', raw))

    expect(line).toBe(
      'host runtime event component=account operation=request status=warn code=GC-ACCOUNT-UNKNOWN',
    )
    expect(line).not.toMatch(/wangyudi|top-secret|private customer|34121|secret\.docx/u)
  })

  it('classifies MCP reconnects and retains only a numeric elapsed time', () => {
    const line = redactedHostRuntimeDiagnostic(message(
      'gongchuang-connectors',
      'info',
      'mcp-client(enterprise-private-server): reconnected elapsedMs=%d token=secret-token',
      1842,
    ))

    expect(line).toBe(
      'host runtime event component=mcp operation=reconnect status=info code=GC-HOST-MCP elapsedMs=1842',
    )
    expect(line).not.toMatch(/enterprise-private-server|secret-token/u)
  })

  it('ignores debug and unrelated records instead of persisting their payloads', () => {
    expect(redactedHostRuntimeDiagnostic(message('gongchuang-account', 'debug', 'password=secret')))
      .toBeUndefined()
    expect(redactedHostRuntimeDiagnostic(message('user-plugin', 'error', 'customer document body')))
      .toBeUndefined()
  })

  it('writes only redacted supported records to the provided desktop sink', () => {
    const write = vi.fn()
    const exporter = createHostRuntimeDiagnosticsExporter(write)
    exporter.export(message('gongchuang-model-connections', 'warn', 'credential rollback failed', 'api-key'))
    exporter.export(message('unrelated-plugin', 'error', 'private content'))

    expect(write).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith(
      'warn',
      'host runtime event component=model operation=rollback status=warn code=GC-HOST-MODEL',
    )
    expect(JSON.stringify(write.mock.calls)).not.toContain('api-key')
    expect(JSON.stringify(write.mock.calls)).not.toContain('private content')
  })
})
