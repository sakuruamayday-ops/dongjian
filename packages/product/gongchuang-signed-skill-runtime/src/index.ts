/** Host-owned executor for model-callable scripts in the active signed suite. */

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RunnerFailureRule, SandboxEnforcement } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { GongchuangPolicyService } from '@gongchuang/client-policy-gate'
import {
  parseSignedSkillRuntimeManifest,
  type SignedSkillOperation,
  type SignedSkillParameter,
  type SignedSkillRuntimeManifest,
} from './manifest.ts'
import { legacyWordWorkerCommand } from './legacy-word.ts'

export {
  parseSignedSkillRuntimeManifest,
  type SignedSkillArgument,
  type SignedSkillOperation,
  type SignedSkillParameter,
  type SignedSkillRuntimeManifest,
} from './manifest.ts'

const MANIFEST_PATH = 'client-runtime-operations.json'
const TOOL_NAME = 'gongchuang_skill_operation'
const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL|AUTH|COOKIE|PROXY|DSH_/iu
const PYTHON_ENV = /^(?:PYTHON|PIP|VIRTUAL_ENV|CONDA|UV_)/iu

/** PaddleOCR MCP release reviewed and embedded in the V0.1 signed runtime. */
export const GONGCHUANG_PADDLEOCR_MCP_VERSION = '0.8.5'

/** Immutable Host facts produced only after skill and runtime verification. */
export interface GongchuangSkillRuntimeBinding {
  readonly skillsRoot: string
  readonly skillBundleVersion: string
  readonly skillBundleIndexSha256: string
  readonly skillFileHashes: Readonly<Record<string, string>>
  readonly signingTier: 'development-candidate' | 'formal'
  readonly pythonExecutable: string
  readonly pythonExecutableSha256: string
  readonly runtimeIntegrity: 'development-external' | 'signed'
  readonly runtimeIndexSha256: string
  /** Reviewed PaddleOCR MCP distribution in the same verified Python tree. */
  readonly paddleOcrMcpVersion: string
}

/** Model-visible result of one fixed signed operation. */
export interface GongchuangSkillOperationResult {
  readonly operation: string
  readonly skill: string
  readonly status: 'passed' | 'rejected'
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly sandboxEnforcement: SandboxEnforcement
  readonly scriptSha256: string
  readonly skillBundleIndexSha256: string
  readonly runtimeIntegrity: 'development-external' | 'signed'
  readonly runtimeIndexSha256: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gongchuangPolicy: GongchuangPolicyService
    gongchuangSkillRuntimeBinding: GongchuangSkillRuntimeBinding
    gongchuangSignedSkillRuntime: GongchuangSignedSkillRuntime
    subprocess: SubprocessRuntime
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function regularFile(path: string, label: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label}必须是普通文件且不能是符号链接`)
}

function verifiedFile(path: string, expectedSha256: string, label: string): string {
  regularFile(path, label)
  const digest = sha256File(path)
  if (digest !== expectedSha256) throw new Error(`${label}完整性与宿主验签结果不一致`)
  return digest
}

function verifyOperationFiles(binding: GongchuangSkillRuntimeBinding, operation: SignedSkillOperation): string {
  const ownedPrefix = `${operation.skill}/`
  const paths = Object.keys(binding.skillFileHashes)
    .filter(path => path.startsWith(ownedPrefix))
    .concat(operation.additionalFiles)
  if (paths.length === 0 || !paths.includes(operation.script)) {
    throw new Error(`受签名技能操作 ${operation.id} 缺少完整技能文件集合`)
  }
  for (const path of new Set(paths)) {
    const expected = binding.skillFileHashes[path]
    if (expected === undefined) throw new Error(`技能包索引未登记操作依赖：${path}`)
    verifiedFile(join(binding.skillsRoot, path), expected, `受签名技能文件 ${path}`)
  }
  const scriptSha256 = binding.skillFileHashes[operation.script]
  if (scriptSha256 === undefined) throw new Error(`技能包索引未登记脚本：${operation.script}`)
  return scriptSha256
}

function workspaceRoot(agent: Agent | undefined): string {
  const cwd = agent?.session.header.cwd
  if (cwd === undefined || !isAbsolute(cwd)) throw new Error('受签名技能操作缺少绝对企业工作区')
  const info = lstatSync(cwd)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('企业工作区必须是普通目录且不能是符号链接')
  return realpathSync(cwd)
}

function fileExtension(path: string, parameter: SignedSkillParameter): void {
  if (!('extensions' in parameter) || parameter.extensions.includes(extname(path).toLowerCase())) return
  throw new Error(`文件扩展名不在受签名操作允许范围：${parameter.extensions.join('、')}`)
}

function inputFile(root: string, value: unknown, parameter: Extract<SignedSkillParameter, { type: 'workspace-input-file' }>): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || value.includes('\0')) {
    throw new Error('工作区输入文件路径无效')
  }
  const candidate = resolve(root, value)
  regularFile(candidate, '工作区输入文件')
  const canonical = realpathSync(candidate)
  if (!contained(root, canonical)) throw new Error('工作区输入文件越出当前企业空间')
  fileExtension(canonical, parameter)
  const size = statSync(canonical).size
  if (size <= 0 || size > parameter.maxBytes) throw new Error('工作区输入文件大小超出受签名操作范围')
  return canonical
}

function outputFile(root: string, value: unknown, parameter: Extract<SignedSkillParameter, { type: 'workspace-output-file' }>): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || value.includes('\0')) {
    throw new Error('工作区输出文件路径无效')
  }
  const candidate = resolve(root, value)
  if (!contained(root, candidate)) throw new Error('工作区输出文件越出当前企业空间')
  // 受签名脚本经常一次生成多类产物，模型可以直接给出工作区内尚未
  // 存在的嵌套输出目录。先做字面边界检查，再由宿主创建父目录并以
  // realpath 复核，避免首次执行因 ENOENT 失败后迫使模型重试。
  mkdirSync(dirname(candidate), { recursive: true })
  const parent = realpathSync(dirname(candidate))
  if (!contained(root, parent)) throw new Error('工作区输出文件越出当前企业空间')
  if (lstatExists(candidate)) regularFile(candidate, '工作区输出文件')
  const canonical = join(parent, candidate.slice(dirname(candidate).length + 1))
  fileExtension(canonical, parameter)
  return canonical
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function scalar(value: unknown, parameter: Exclude<SignedSkillParameter, { type: 'workspace-input-file' | 'workspace-output-file' }>): string {
  switch (parameter.type) {
    case 'text':
      if (typeof value !== 'string' || value.length < parameter.minLength || value.length > parameter.maxLength || value.includes('\0')) {
        throw new Error('文本参数不符合受签名操作长度范围')
      }
      return value
    case 'enum':
      if (typeof value !== 'string' || !parameter.values.includes(value)) throw new Error('枚举参数不在受签名操作允许范围')
      return value
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)
        || value < parameter.minimum || value > parameter.maximum) throw new Error('整数参数不在受签名操作允许范围')
      return String(value)
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error('布尔参数类型无效')
      return value ? 'true' : 'false'
    default:
      return assertNever(parameter)
  }
}

function assertNever(value: never): never {
  throw new Error(`未知受签名技能参数：${String(value)}`)
}

interface RenderedOperationArguments {
  readonly argv: readonly string[]
  readonly parameters: ReadonlyMap<string, string>
}

function operationArguments(operation: SignedSkillOperation, values: unknown, root: string): RenderedOperationArguments {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error('技能操作参数必须是对象')
  const input = values as Record<string, unknown>
  const expected = Object.keys(operation.parameters).sort()
  const actual = Object.keys(input).sort()
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw new Error(`技能操作参数必须严格匹配：${expected.join('、')}`)
  }
  const rendered = new Map<string, string>()
  for (const [name, parameter] of Object.entries(operation.parameters)) {
    const value = input[name]
    if ((parameter.type === 'workspace-input-file' || parameter.type === 'workspace-output-file') && typeof value !== 'string') {
      throw new Error(`技能操作参数 ${name} 必须是文件路径字符串；不要传参数定义或带 path 的对象。使用当前工作区的实际路径。`)
    }
    rendered.set(name, parameter.type === 'workspace-input-file'
      ? inputFile(root, value, parameter)
      : parameter.type === 'workspace-output-file'
        ? outputFile(root, value, parameter)
        : scalar(value, parameter))
  }
  const argv = operation.argv.map(argument => 'literal' in argument
    ? argument.literal
    : rendered.get(argument.parameter) ?? (() => { throw new Error(`技能操作参数 ${argument.parameter} 未渲染`) })())
  return Object.freeze({ argv: Object.freeze(argv), parameters: rendered })
}

function childEnvironment(pythonExecutable: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    PATH: dirname(pythonExecutable),
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONHASHSEED: '0',
    PYTHONNOUSERSITE: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  }
  for (const name of Object.keys(process.env)) {
    if (SENSITIVE_ENV.test(name) || PYTHON_ENV.test(name)) env[name] = undefined
  }
  // The scrub also matches the fixed entries initialized above. Restore every
  // Host-owned Python control afterwards; otherwise imported Office libraries
  // can write __pycache__ into the signed App and make the next launch fail its
  // runtime file-set check.
  env.PYTHONDONTWRITEBYTECODE = '1'
  env.PYTHONHASHSEED = '0'
  env.PYTHONNOUSERSITE = '1'
  env.PYTHONUTF8 = '1'
  env.PYTHONIOENCODING = 'utf-8'
  return env
}

function runnerFailure(exitCode: number, stderr: string, rules: readonly RunnerFailureRule[]): string | undefined {
  const lines = stderr.split(/\r?\n/u)
  for (const rule of rules) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) continue
    const ignored = new Set((rule.informationalLines ?? []).map(line => line.toLowerCase()))
    for (const line of lines) {
      const lowered = line.toLowerCase()
      if (ignored.has(lowered)) continue
      if (rule.fatalSignatures.some(signature => signature.trim() !== '' && lowered.includes(signature.toLowerCase()))) return line
    }
  }
  return undefined
}

function assertStructuredStdout(stdout: string, expectedSchemaVersion: string | undefined, operationId: string): void {
  if (expectedSchemaVersion === undefined) return
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch (error) {
    throw new Error(`受签名技能操作 ${operationId} 未返回单一有效 JSON 结果`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || (parsed as Record<string, unknown>).schema_version !== expectedSchemaVersion) {
    throw new Error(`受签名技能操作 ${operationId} 返回的 JSON schema_version 不匹配`)
  }
}

function parseManifest(binding: GongchuangSkillRuntimeBinding): SignedSkillRuntimeManifest {
  const expected = binding.skillFileHashes[MANIFEST_PATH]
  if (expected === undefined) throw new Error('宿主验签技能包未登记运行清单')
  const path = join(binding.skillsRoot, MANIFEST_PATH)
  verifiedFile(path, expected, '受签名技能运行清单')
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error: unknown) {
    throw new Error('受签名技能运行清单不是有效 JSON', { cause: error })
  }
  return parseSignedSkillRuntimeManifest(value, binding.skillBundleVersion)
}

function parameterSchema(parameter: SignedSkillParameter): Record<string, unknown> {
  switch (parameter.type) {
    case 'workspace-input-file':
    case 'workspace-output-file': {
      const { type, ...constraints } = parameter
      return { type: 'string', format: type, ...constraints }
    }
    case 'text':
      return { type: 'string', minLength: parameter.minLength, maxLength: parameter.maxLength }
    case 'enum':
      return { type: 'string', enum: parameter.values }
    case 'integer':
    case 'boolean':
      return { ...parameter }
    default:
      return assertNever(parameter)
  }
}

/** Concrete Host service and sole executor for signed first-party skill scripts. */
export class GongchuangSignedSkillRuntime extends Service {
  static inject = ['tools', 'subprocess', 'sandbox', 'gongchuangPolicy', 'gongchuangSkillRuntimeBinding']

  private readonly binding: GongchuangSkillRuntimeBinding
  private readonly manifest: SignedSkillRuntimeManifest
  private readonly operations: ReadonlyMap<string, SignedSkillOperation>

  constructor(ctx: Context) {
    super(ctx, 'gongchuangSignedSkillRuntime')
    this.binding = ctx.gongchuangSkillRuntimeBinding
    this.validateBinding()
    this.manifest = parseManifest(this.binding)
    this.operations = new Map(this.manifest.operations.map(operation => [operation.id, operation]))
  }

  protected [Service.init](): void {
    // 清单类型描述与调用值分开，避免模型把 {type, extensions} 当作文件路径传入。
    const operationDescriptions = this.manifest.operations.map(operation => JSON.stringify({
      operation: operation.id,
      skill: operation.skill,
      description: operation.description,
      parameterSchema: Object.fromEntries(
        Object.entries(operation.parameters).map(([name, parameter]) => [name, parameterSchema(parameter)]),
      ),
    }))
    this.ctx.tools.register(defineTool({
      name: TOOL_NAME,
      description: [
        `执行 V${this.binding.skillBundleVersion} 已验签技能的固定操作。先用 skill 激活该操作的 skill，再按清单调用；无需寻找运行清单、脚本或解释器。`,
        '若当前只开放 run_code，在其中先 await tools.skill({name: skill})，成功后 await tools.gongchuang_skill_operation({operation, parameters})。skill 与 operation 使用下面逐字列出的值，不要直接调用未开放的根工具。',
        'parameters 的所有参数均必填，不得添加未列出的参数。text 和 enum 传字符串；integer 和 boolean 传对应 JSON 类型。workspace-input-file 和 workspace-output-file 传当前工作区内的文件路径字符串。专业正文预校验已通过时，evidence-ledger.create-docx 的 content 由宿主以已验收检查点覆盖并自行校验字符串长度；直接调用一次，不要用 Bash、wc 或脚本预先统计字符数或字节数，防止二次读取和拼写漂移。',
        'parameterSchema 只描述类型和约束，不是参数值。文件参数直接传路径字符串，不传 {type, path, extensions} 对象。提取成功后读取 stdout 的 JSON；needs_ocr 时保留已提取文字，只补 ocr_pages，不要重复提取同一文件或猜测工具参数。',
        '不接受命令、脚本路径、解释器、环境变量或网址。',
        ...operationDescriptions,
      ].join('\n'),
      parameters: {
        operation: {
          type: 'string', required: true, description: '清单中的完整 operation ID。',
          enum: this.manifest.operations.map(operation => operation.id),
        },
        parameters: { type: 'object', additionalProperties: true, required: true, description: '与该操作签名参数严格一致的对象。' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            operation: { type: 'string', required: true },
            skill: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: ['passed', 'rejected'] },
            exitCode: { type: 'integer', required: true },
            stdout: { type: 'string', required: true },
            stderr: { type: 'string', required: true },
            sandboxEnforcement: { type: 'string', required: true, enum: ['full', 'partial'] },
            scriptSha256: { type: 'string', required: true },
            skillBundleIndexSha256: { type: 'string', required: true },
            runtimeIntegrity: { type: 'string', required: true, enum: ['development-external', 'signed'] },
            runtimeIndexSha256: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: 125_000,
      isConcurrencySafe: () => false,
      execute: (args, exec) => this.run(exec, args.operation, args.parameters),
      presentCall: args => ({ card: 'generic', title: `执行受签名技能操作 ${args.operation}`, kind: 'read', rawInput: args.operation }),
    }))
  }

  /**
   * Execute one registry operation after skill activation, hash, argv, path, environment, sandbox, timeout, and output checks.
   * @param exec - Attributed model tool execution from the central broker.
   * @param operationId - Exact signed operation identity.
   * @param parameters - Closed structured values rendered by the Host.
   * @returns Bounded diagnostic output and immutable execution identity.
   */
  async run(exec: ToolExecution, operationId: string, parameters: unknown): Promise<GongchuangSkillOperationResult> {
    const operation = this.operations.get(operationId)
    if (operation === undefined) throw new Error(`未登记的受签名技能操作：${operationId}`)
    this.ctx.gongchuangPolicy.assertSkillActivated(exec, operation.skill)
    const root = workspaceRoot(exec.agent)
    const scriptPath = join(this.binding.skillsRoot, operation.script)
    const scriptSha256 = verifyOperationFiles(this.binding, operation)
    verifiedFile(this.binding.pythonExecutable, this.binding.pythonExecutableSha256, '受控 Python 解释器')
    const acceptedSubject = operationId === 'evidence-ledger.create-docx'
      ? this.ctx.gongchuangPolicy.professionalSubjectIfPresent(exec)
      : undefined
    // create-docx 过去要求模型把已校验正文再传一次，一个标题或
    // 标点被重写就会造成文件与回执不一致。一旦存在当前轮已验收
    // 检查点，由宿主替换 content；普通非专业文档仍使用调用方参数。
    const effectiveParameters = acceptedSubject === undefined
      || typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)
      ? parameters
      : { ...parameters, content: acceptedSubject }
    const rendered = operationArguments(operation, effectiveParameters, root)
    const pythonCommand = {
      argv: [
        this.binding.pythonExecutable,
        // -E deliberately ignores inherited PYTHON* variables. Pin UTF-8 on
        // the interpreter command line so redirected Chinese stdout/stderr is
        // deterministic on Windows as well as POSIX hosts.
        '-B', '-E', '-s', '-X', 'utf8',
        scriptPath,
        ...rendered.argv,
      ],
      env: childEnvironment(this.binding.pythonExecutable),
    }
    const deadline = new AbortController()
    const timeoutState = { fired: false }
    const forwardAbort = (): void => { deadline.abort(exec.signal.reason) }
    if (exec.signal.aborted) forwardAbort()
    else exec.signal.addEventListener('abort', forwardAbort, { once: true })
    const timer = setTimeout(() => {
      timeoutState.fired = true
      deadline.abort(new Error('受签名技能操作超时'))
    }, operation.timeoutMs)
    try {
      const runCommand = async (command: { readonly argv: readonly string[]; readonly env: NodeJS.ProcessEnv }) => {
        const confined = this.ctx.sandbox.confine(command.argv, {
          mode: operation.sandboxMode,
          workspaceRoot: root,
          ...(exec.agent === undefined ? {} : { sessionId: exec.agent.session.id }),
        })
        const handle = this.ctx.subprocess.spawn({
          argv: confined.argv,
          cwd: root,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: operation.maxOutputBytes },
            stderr: { maxBytes: operation.maxOutputBytes },
          },
          graceMs: 2_000,
          signal: deadline.signal,
          env: command.env,
        })
        const outcome = await handle.done
        await handle.waitForExit()
        const stdout = handle.collected.stdout?.readFrom(0)
        const stderr = handle.collected.stderr?.readFrom(0)
        const stdoutText = stdout?.text ?? ''
        const stderrText = stderr?.text ?? ''
        if (timeoutState.fired) throw new Error(`受签名技能操作 ${operation.id} 在 ${String(operation.timeoutMs)} 毫秒后超时`)
        if (exec.signal.aborted) throw new Error(`受签名技能操作 ${operation.id} 已取消`)
        if (stdout?.lossy === true || stderr?.lossy === true) throw new Error(`受签名技能操作 ${operation.id} 输出超过签名上限`)
        if (outcome.signal !== null || outcome.exitCode === null) throw new Error(`受签名技能操作 ${operation.id} 被信号终止`)
        const runnerProblem = runnerFailure(outcome.exitCode, stderrText, confined.runnerFailureRules)
        if (runnerProblem !== undefined) throw new Error(`受签名技能沙箱未能启动：${runnerProblem}`)
        if (!operation.resultExitCodes.includes(outcome.exitCode)) {
          throw new Error(`受签名技能操作 ${operation.id} 异常退出 ${String(outcome.exitCode)}：${stderrText.trim()}`)
        }
        assertStructuredStdout(stdoutText, operation.stdoutJsonSchemaVersion, operation.id)
        return Object.freeze({
          exitCode: outcome.exitCode,
          stdoutText,
          stderrText,
          enforcement: confined.enforcement,
        })
      }
      const detected = await runCommand(pythonCommand)
      const legacyWord = legacyWordWorkerCommand(operation, rendered.parameters, detected.stdoutText)
      const extracted = legacyWord === undefined ? detected : await runCommand(legacyWord)
      return Object.freeze({
        operation: operation.id,
        skill: operation.skill,
        status: operation.passingExitCodes.includes(extracted.exitCode) ? 'passed' : 'rejected',
        exitCode: extracted.exitCode,
        stdout: extracted.stdoutText,
        stderr: extracted.stderrText,
        sandboxEnforcement: detected.enforcement === 'full' && extracted.enforcement === 'full' ? 'full' : 'partial',
        scriptSha256,
        skillBundleIndexSha256: this.binding.skillBundleIndexSha256,
        runtimeIntegrity: this.binding.runtimeIntegrity,
        runtimeIndexSha256: this.binding.runtimeIndexSha256,
      })
    } finally {
      clearTimeout(timer)
      exec.signal.removeEventListener('abort', forwardAbort)
    }
  }

  private validateBinding(): void {
    if (!isAbsolute(this.binding.skillsRoot) || !isAbsolute(this.binding.pythonExecutable)
      || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(this.binding.skillBundleVersion)
      || !/^[0-9a-f]{64}$/u.test(this.binding.skillBundleIndexSha256)
      || !/^[0-9a-f]{64}$/u.test(this.binding.pythonExecutableSha256)
      || !/^[0-9a-f]{64}$/u.test(this.binding.runtimeIndexSha256)
      || !['development-external', 'signed'].includes(this.binding.runtimeIntegrity)) {
      throw new Error('受签名技能运行宿主绑定无效')
    }
    const skillsInfo = lstatSync(this.binding.skillsRoot)
    if (skillsInfo.isSymbolicLink() || !skillsInfo.isDirectory()) throw new Error('受签名技能根目录无效')
    regularFile(this.binding.pythonExecutable, '受控 Python 解释器')
    for (const [path, digest] of Object.entries(this.binding.skillFileHashes)) {
      if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '' || part === '.' || part === '..')
        || !/^[0-9a-f]{64}$/u.test(digest)) throw new Error('受签名技能文件摘要绑定无效')
    }
  }
}

export default GongchuangSignedSkillRuntime
