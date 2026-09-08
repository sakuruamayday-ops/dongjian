/** Parser for a signed model-callable operation registry. */

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const OPERATION_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_]*$/u

/** Scalar or workspace-path input accepted by one signed operation. */
export type SignedSkillParameter =
  | { readonly type: 'text'; readonly minLength: number; readonly maxLength: number }
  | { readonly type: 'enum'; readonly values: readonly string[] }
  | { readonly type: 'integer'; readonly minimum: number; readonly maximum: number }
  | { readonly type: 'boolean' }
  | {
    readonly type: 'workspace-input-file'
    readonly extensions: readonly string[]
    readonly maxBytes: number
  }
  | {
    readonly type: 'workspace-output-file'
    readonly extensions: readonly string[]
  }

/** One fixed literal or validated parameter position in the child argv. */
export type SignedSkillArgument =
  | { readonly literal: string }
  | { readonly parameter: string }

/** One immutable first-party operation from the signed skill bundle. */
export interface SignedSkillOperation {
  readonly id: string
  readonly skill: string
  readonly description: string
  readonly script: string
  readonly additionalFiles: readonly string[]
  readonly sandboxMode: 'read-only' | 'workspace-write'
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly resultExitCodes: readonly number[]
  readonly passingExitCodes: readonly number[]
  readonly stdoutJsonSchemaVersion?: string
  readonly parameters: Readonly<Record<string, SignedSkillParameter>>
  readonly argv: readonly SignedSkillArgument[]
}

/** Complete operation registry covered by the selected skill-suite signature. */
export interface SignedSkillRuntimeManifest {
  readonly schemaVersion: 'gongchuang-signed-skill-operations/v1'
  readonly skillBundleVersion: string
  readonly operations: readonly SignedSkillOperation[]
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`受签名技能运行清单 ${field} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new Error(`受签名技能运行清单 ${field} 必须是非空短文本`)
  }
  return value
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`受签名技能运行清单 ${field} 超出允许范围`)
  }
  return value
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(row).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`受签名技能运行清单 ${field} 包含未知字段 ${unknown}`)
}

function extensions(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error(`受签名技能运行清单 ${field} 必须声明文件扩展名`)
  }
  const rows = value.map((item, index) => {
    const extension = text(item, `${field}[${String(index)}]`, 16).toLowerCase()
    if (!/^\.[a-z0-9]+$/u.test(extension)) throw new Error(`受签名技能运行清单 ${field} 扩展名无效`)
    return extension
  })
  if (new Set(rows).size !== rows.length) throw new Error(`受签名技能运行清单 ${field} 包含重复扩展名`)
  return Object.freeze(rows)
}

function parameter(value: unknown, field: string): SignedSkillParameter {
  const row = record(value, field)
  const type = text(row.type, `${field}.type`, 64)
  if (row.required !== true) throw new Error(`受签名技能运行清单 ${field}.required 在 v1 中必须为 true`)
  switch (type) {
    case 'text': {
      exactKeys(row, ['type', 'required', 'min_length', 'max_length'], field)
      const minLength = integer(row.min_length, `${field}.min_length`, 0, 8_192)
      const maxLength = integer(row.max_length, `${field}.max_length`, 1, 8_192)
      if (minLength > maxLength) throw new Error(`受签名技能运行清单 ${field} 文本长度范围无效`)
      return Object.freeze({ type, minLength, maxLength })
    }
    case 'enum': {
      exactKeys(row, ['type', 'required', 'values'], field)
      if (!Array.isArray(row.values) || row.values.length === 0 || row.values.length > 64) {
        throw new Error(`受签名技能运行清单 ${field}.values 无效`)
      }
      const values = row.values.map((item, index) => text(item, `${field}.values[${String(index)}]`, 256))
      if (new Set(values).size !== values.length) throw new Error(`受签名技能运行清单 ${field}.values 包含重复值`)
      return Object.freeze({ type, values: Object.freeze(values) })
    }
    case 'integer': {
      exactKeys(row, ['type', 'required', 'minimum', 'maximum'], field)
      const minimum = integer(row.minimum, `${field}.minimum`, -1_000_000_000, 1_000_000_000)
      const maximum = integer(row.maximum, `${field}.maximum`, -1_000_000_000, 1_000_000_000)
      if (minimum > maximum) throw new Error(`受签名技能运行清单 ${field} 整数范围无效`)
      return Object.freeze({ type, minimum, maximum })
    }
    case 'boolean':
      exactKeys(row, ['type', 'required'], field)
      return Object.freeze({ type })
    case 'workspace-input-file':
      exactKeys(row, ['type', 'required', 'extensions', 'max_bytes'], field)
      return Object.freeze({
        type,
        extensions: extensions(row.extensions, `${field}.extensions`),
        maxBytes: integer(row.max_bytes, `${field}.max_bytes`, 1, 256 * 1024 * 1024),
      })
    case 'workspace-output-file':
      exactKeys(row, ['type', 'required', 'extensions'], field)
      return Object.freeze({ type, extensions: extensions(row.extensions, `${field}.extensions`) })
    default:
      throw new Error(`受签名技能运行清单 ${field}.type 不受支持`)
  }
}

function exitCodes(value: unknown, field: string): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error(`受签名技能运行清单 ${field} 必须是非空退出码数组`)
  }
  const rows = value.map((item, index) => integer(item, `${field}[${String(index)}]`, 0, 255))
  if (new Set(rows).size !== rows.length) throw new Error(`受签名技能运行清单 ${field} 包含重复退出码`)
  return Object.freeze(rows)
}

function operation(value: unknown, index: number): SignedSkillOperation {
  const field = `operations[${String(index)}]`
  const row = record(value, field)
  exactKeys(row, [
    'id', 'skill', 'description', 'script', 'files', 'sandbox_mode', 'network', 'timeout_ms',
    'max_output_bytes', 'result_exit_codes', 'passing_exit_codes', 'stdout_json_schema_version', 'parameters', 'argv',
  ], field)
  const id = text(row.id, `${field}.id`, 160)
  const skill = text(row.skill, `${field}.skill`, 128)
  const script = text(row.script, `${field}.script`, 512)
  if (!OPERATION_ID.test(id) || !SKILL_NAME.test(skill)
    || !script.startsWith(`${skill}/scripts/`) || !script.endsWith('.py')
    || script.startsWith('/') || script.includes('\\') || script.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`受签名技能运行清单 ${field} 的操作、技能或脚本身份无效`)
  }
  if (!Array.isArray(row.files) || row.files.length > 32) {
    throw new Error(`受签名技能运行清单 ${field}.files 无效`)
  }
  const additionalFiles = row.files.map((candidate, fileIndex) => {
    const path = text(candidate, `${field}.files[${String(fileIndex)}]`, 512)
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
      throw new Error(`受签名技能运行清单 ${field}.files 包含无效路径`)
    }
    return path
  })
  if (new Set(additionalFiles).size !== additionalFiles.length) {
    throw new Error(`受签名技能运行清单 ${field}.files 包含重复路径`)
  }
  const sandboxMode = row.sandbox_mode
  if (sandboxMode !== 'read-only' && sandboxMode !== 'workspace-write') {
    throw new Error(`受签名技能运行清单 ${field}.sandbox_mode 无效`)
  }
  if (row.network !== 'none') throw new Error(`受签名技能运行清单 ${field} 不得启用脚本网络访问`)
  const parameterRows = record(row.parameters, `${field}.parameters`)
  if (Object.keys(parameterRows).length > 32) throw new Error(`受签名技能运行清单 ${field} 参数过多`)
  const parameters: Record<string, SignedSkillParameter> = {}
  for (const [name, candidate] of Object.entries(parameterRows)) {
    if (!PARAMETER_NAME.test(name)) throw new Error(`受签名技能运行清单 ${field} 参数名 ${name} 无效`)
    parameters[name] = parameter(candidate, `${field}.parameters.${name}`)
  }
  if (sandboxMode === 'read-only'
    && Object.values(parameters).some(candidate => candidate.type === 'workspace-output-file')) {
    throw new Error(`受签名技能运行清单 ${field} 只读操作不得声明输出文件`)
  }
  if (!Array.isArray(row.argv) || row.argv.length === 0 || row.argv.length > 64) {
    throw new Error(`受签名技能运行清单 ${field}.argv 无效`)
  }
  const used = new Set<string>()
  const argv = row.argv.map((candidate, argumentIndex): SignedSkillArgument => {
    const argumentField = `${field}.argv[${String(argumentIndex)}]`
    const argument = record(candidate, argumentField)
    const keys = Object.keys(argument)
    if (keys.length !== 1) throw new Error(`受签名技能运行清单 ${argumentField} 必须恰好声明一个来源`)
    if ('literal' in argument) {
      return Object.freeze({ literal: text(argument.literal, `${argumentField}.literal`, 256) })
    }
    if ('parameter' in argument) {
      const name = text(argument.parameter, `${argumentField}.parameter`, 128)
      if (!(name in parameters)) throw new Error(`受签名技能运行清单 ${argumentField} 引用了未知参数 ${name}`)
      used.add(name)
      return Object.freeze({ parameter: name })
    }
    throw new Error(`受签名技能运行清单 ${argumentField} 来源无效`)
  })
  const unused = Object.keys(parameters).find(name => !used.has(name))
  if (unused !== undefined) throw new Error(`受签名技能运行清单 ${field} 参数 ${unused} 未进入 argv`)
  const resultExitCodes = exitCodes(row.result_exit_codes, `${field}.result_exit_codes`)
  const passingExitCodes = exitCodes(row.passing_exit_codes, `${field}.passing_exit_codes`)
  if (passingExitCodes.some(code => !resultExitCodes.includes(code))) {
    throw new Error(`受签名技能运行清单 ${field} 通过退出码不属于结果退出码`)
  }
  return Object.freeze({
    id,
    skill,
    description: text(row.description, `${field}.description`, 300),
    script,
    additionalFiles: Object.freeze(additionalFiles),
    sandboxMode,
    timeoutMs: integer(row.timeout_ms, `${field}.timeout_ms`, 1_000, 120_000),
    maxOutputBytes: integer(row.max_output_bytes, `${field}.max_output_bytes`, 1_024, 1024 * 1024),
    resultExitCodes,
    passingExitCodes,
    ...(row.stdout_json_schema_version === undefined
      ? {}
      : { stdoutJsonSchemaVersion: text(row.stdout_json_schema_version, `${field}.stdout_json_schema_version`, 160) }),
    parameters: Object.freeze(parameters),
    argv: Object.freeze(argv),
  })
}

/**
 * Parse and freeze an untrusted persisted operation registry.
 * @param value - JSON value read from the verified skill tree.
 * @param expectedSkillBundleVersion - Exact version from the Host-verified skill bundle.
 * @returns Closed V1 registry accepted by the Host runner.
 */
export function parseSignedSkillRuntimeManifest(
  value: unknown,
  expectedSkillBundleVersion: string,
): SignedSkillRuntimeManifest {
  const row = record(value, 'root')
  exactKeys(row, ['schema_version', 'skill_bundle_version', 'operations'], 'root')
  if (row.schema_version !== 'gongchuang-signed-skill-operations/v1'
    || row.skill_bundle_version !== expectedSkillBundleVersion
    || !Array.isArray(row.operations) || row.operations.length === 0 || row.operations.length > 128) {
    throw new Error('受签名技能运行清单版本或操作集合无效')
  }
  const operations = row.operations.map(operation)
  const ids = operations.map(candidate => candidate.id)
  if (new Set(ids).size !== ids.length) throw new Error('受签名技能运行清单包含重复操作 ID')
  return Object.freeze({
    schemaVersion: 'gongchuang-signed-skill-operations/v1',
    skillBundleVersion: expectedSkillBundleVersion,
    operations: Object.freeze(operations),
  })
}
