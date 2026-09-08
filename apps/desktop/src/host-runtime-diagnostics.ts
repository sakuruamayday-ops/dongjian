import type { Exporter, LoggerType, Message } from '@deepseek-ai/cordis'

type PersistedRuntimeLevel = Exclude<LoggerType, 'debug'>

interface ComponentRule {
  component: string
  markers: readonly string[]
  fallbackCode: string
}

const COMPONENT_RULES: readonly ComponentRule[] = [
  { component: 'account', markers: ['gongchuang-account'], fallbackCode: 'GC-HOST-ACCOUNT' },
  {
    component: 'model',
    markers: ['gongchuang-model-connections', 'llm-deepseek', 'llm-pi-ai', 'llm-retry'],
    fallbackCode: 'GC-HOST-MODEL',
  },
  { component: 'mcp', markers: ['gongchuang-connectors', 'mcp-client'], fallbackCode: 'GC-HOST-MCP' },
  {
    component: 'skill',
    markers: ['gongchuang-skill-marketplace', 'gongchuang-signed-skill-runtime'],
    fallbackCode: 'GC-HOST-SKILL',
  },
  { component: 'memory', markers: ['gongchuang-graph-memory'], fallbackCode: 'GC-HOST-MEMORY' },
  { component: 'automation', markers: ['gongchuang-local-automation'], fallbackCode: 'GC-HOST-AUTOMATION' },
  {
    component: 'credential',
    markers: ['gongchuang-credentials-keychain'],
    fallbackCode: 'GC-HOST-CREDENTIAL',
  },
]

const OPERATION_MARKERS: readonly [operation: string, markers: readonly string[]][] = [
  ['reconciliation', ['reconciliation', 'reconcile']],
  ['rollback', ['rollback']],
  ['cleanup', ['cleanup']],
  ['reconnect', ['reconnect', 're-sync', 'connection', 'generation']],
  ['tools', ['tool list', 'tool registration']],
  ['retry', ['retry']],
  ['credential', ['credential']],
  ['shutdown', ['shutdown', 'disposal', 'dispose']],
]

function stringArguments(message: Message): string {
  return message.args
    .filter((argument): argument is string => typeof argument === 'string')
    .map(argument => argument.slice(0, 4096))
    .join(' ')
}

function componentRule(name: string, text: string): ComponentRule | undefined {
  const searchable = `${name} ${text}`.toLowerCase()
  return COMPONENT_RULES.find(rule => rule.markers.some(marker => searchable.includes(marker)))
}

function operationName(text: string): string {
  const searchable = text.toLowerCase()
  return OPERATION_MARKERS.find(([, markers]) => markers.some(marker => searchable.includes(marker)))?.[0]
    ?? 'request'
}

function diagnosticCode(text: string, fallback: string): string {
  return text.match(/\bGC-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/u)?.[0] ?? fallback
}

function elapsedMilliseconds(message: Message, text: string): number | undefined {
  const inline = text.match(/\belapsedMs\s*(?:=|:)\s*(\d{1,9})\b/iu)?.[1]
  if (inline !== undefined) return Number(inline)
  const args = message.args as unknown[]
  for (let index = 0; index < args.length - 1; index += 1) {
    const argument = args[index]
    const value = args[index + 1]
    if (typeof argument !== 'string' || !/\belapsedMs\s*=\s*%[dif]\b/iu.test(argument)) continue
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value)
  }
  return undefined
}

/**
 * Reduce one Cordis Host log record to a fixed-field diagnostic line.
 *
 * Raw arguments are used only for allowlisted classification. They are never
 * rendered, so prompts, file contents, credentials, paths and upstream error
 * text cannot cross into the desktop log through this exporter.
 *
 * @param message - Cordis structured log record.
 * @returns A redacted line for supported runtime components, otherwise undefined.
 */
export function redactedHostRuntimeDiagnostic(message: Message): string | undefined {
  if (message.type === 'debug') return undefined
  const text = stringArguments(message)
  const rule = componentRule(message.name, text)
  if (rule === undefined) return undefined
  const elapsedMs = elapsedMilliseconds(message, text)
  return [
    'host runtime event',
    `component=${rule.component}`,
    `operation=${operationName(text)}`,
    `status=${message.type}`,
    `code=${diagnosticCode(text, rule.fallbackCode)}`,
    ...(elapsedMs === undefined ? [] : [`elapsedMs=${String(elapsedMs)}`]),
  ].join(' ')
}

/**
 * Create the Cordis exporter used by the packaged Electron Host.
 *
 * @param write - Destination that persists an already-redacted line.
 * @returns A Cordis exporter that ignores debug and unrelated component logs.
 */
export function createHostRuntimeDiagnosticsExporter(
  write: (level: PersistedRuntimeLevel, line: string) => void,
): Exporter {
  return {
    levels: { default: 2 },
    export(message) {
      const line = redactedHostRuntimeDiagnostic(message)
      if (line === undefined || message.type === 'debug') return
      write(message.type, line)
    },
  }
}
