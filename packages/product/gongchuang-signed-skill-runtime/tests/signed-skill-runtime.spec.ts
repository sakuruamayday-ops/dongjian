import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxProvider, { type ConfinedArgv, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SubprocessRuntime, {
  type SubprocessHandle,
  type SubprocessSpawnSpec,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { GongchuangPolicyService } from '@gongchuang/client-policy-gate'
import { afterEach, describe, expect, it } from 'vitest'
import GongchuangSignedSkillRuntime, {
  parseSignedSkillRuntimeManifest,
  type GongchuangSkillRuntimeBinding,
} from '../src/index.ts'
import { legacyWordWorkerCommand } from '../src/legacy-word.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')

interface FixtureOptions {
  readonly exitCode?: number
  readonly stdout?: string | readonly string[]
  readonly stderr?: string
  readonly lossy?: boolean
  readonly activated?: boolean
  readonly stdoutJsonSchemaVersion?: string
  readonly profile?: 'demo' | 'legacy-document'
  readonly operationOverrides?: Record<string, unknown>
  readonly professionalSubject?: string
}

class MemorySubprocess extends SubprocessRuntime {
  specs: SubprocessSpawnSpec[] = []
  exitCode = 0
  stdout: string | readonly string[] = '{"status":"pass"}\n'
  stderr = ''
  lossy = false

  resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(command)
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const callIndex = this.specs.length
    this.specs.push(spec)
    const stdout = typeof this.stdout === 'string'
      ? this.stdout
      : this.stdout[callIndex] ?? this.stdout.at(-1) ?? ''
    const output = (text: string) => ({
      readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: this.lossy }),
    })
    return {
      pid: 100,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: { stdout: output(stdout), stderr: output(this.stderr) },
      done: Promise.resolve({ exitCode: this.exitCode, signal: null }),
      terminate() {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error('terminal execution is unavailable in this fixture')
  }
}

class MemorySandbox extends SandboxProvider {
  policies: SandboxPolicy[] = []

  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    this.policies.push(policy)
    return {
      argv: [...argv],
      enforcement: 'full',
      denialSignatures: ['operation not permitted'],
      runnerFailureRules: [{ fatalSignatures: ['fixture-runner: '] }],
    }
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function runtimeManifest(
  overrides: Record<string, unknown> = {},
  profile: 'demo' | 'legacy-document' = 'demo',
): Record<string, unknown> {
  const legacy = profile === 'legacy-document'
  return {
    schema_version: 'gongchuang-signed-skill-operations/v1',
    skill_bundle_version: '1.6.11',
    operations: [{
      id: legacy
        ? 'project-application-assistant.extract-workspace-document'
        : 'demo-skill.validate-input',
      skill: legacy ? 'project-application-assistant' : 'demo-skill',
      description: legacy ? 'Extract one workspace document.' : 'Validate one JSON input.',
      script: legacy
        ? 'project-application-assistant/scripts/extract_workspace_document.py'
        : 'demo-skill/scripts/validate.py',
      files: [],
      sandbox_mode: 'read-only',
      network: 'none',
      timeout_ms: 5_000,
      max_output_bytes: 4_096,
      result_exit_codes: [0, 2],
      passing_exit_codes: [0],
      parameters: legacy
        ? {
          document: {
            type: 'workspace-input-file', required: true, extensions: ['.doc', '.wps'], max_bytes: 134_217_728,
          },
        }
        : {
          input: {
            type: 'workspace-input-file', required: true, extensions: ['.json'], max_bytes: 4_096,
          },
        },
      argv: legacy ? [{ parameter: 'document' }] : [{ literal: '--input' }, { parameter: 'input' }],
      ...overrides,
    }],
  }
}

async function fixture(options: FixtureOptions = {}): Promise<{
  readonly ctx: Context
  readonly agent: Agent
  readonly workspace: string
  readonly skillsRoot: string
  readonly subprocess: MemorySubprocess
  readonly sandbox: MemorySandbox
  readonly dispose: () => Promise<void>
}> {
  const legacy = options.profile === 'legacy-document'
  const skill = legacy ? 'project-application-assistant' : 'demo-skill'
  const root = mkdtempSync(join(tmpdir(), 'gongchuang-signed-skill-runtime-'))
  const workspace = join(root, 'workspace')
  const skillsRoot = join(root, 'skills')
  const scriptDirectory = join(skillsRoot, skill, 'scripts')
  const scriptName = legacy ? 'extract_workspace_document.py' : 'validate.py'
  mkdirSync(workspace)
  mkdirSync(scriptDirectory, { recursive: true })
  const input = join(workspace, 'input.json')
  const script = join(scriptDirectory, scriptName)
  const helper = join(scriptDirectory, 'helper.py')
  const manifest = join(skillsRoot, 'client-runtime-operations.json')
  const python = join(root, 'python-runtime')
  writeFileSync(input, '{"company":"共创"}\n')
  writeFileSync(script, '# signed fixture\n')
  writeFileSync(helper, '# imported signed fixture\n')
  const stdoutJsonSchemaVersion = options.stdoutJsonSchemaVersion
    ?? (legacy ? 'gongchuang-document-extraction/v1' : undefined)
  writeFileSync(manifest, `${JSON.stringify(runtimeManifest({
    ...(stdoutJsonSchemaVersion === undefined ? {} : { stdout_json_schema_version: stdoutJsonSchemaVersion }),
    ...options.operationOverrides,
  }, options.profile), null, 2)}\n`)
  writeFileSync(python, 'fixed interpreter bytes\n')
  const binding: GongchuangSkillRuntimeBinding = Object.freeze({
    skillsRoot,
    skillBundleVersion: '1.6.11',
    skillBundleIndexSha256: 'a'.repeat(64),
    skillFileHashes: Object.freeze({
      'client-runtime-operations.json': sha256(manifest),
      [`${skill}/scripts/${scriptName}`]: sha256(script),
      [`${skill}/scripts/helper.py`]: sha256(helper),
    }),
    signingTier: 'development-candidate',
    pythonExecutable: python,
    pythonExecutableSha256: sha256(python),
    runtimeIntegrity: 'development-external',
    runtimeIndexSha256: 'b'.repeat(64),
    paddleOcrMcpVersion: 'development-unverified',
  })
  const id = SessionId(`signed-skill-${randomUUID()}`)
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    cwd: workspace,
    isSeeded: false,
  })
  const agent = { options: { provider: 'deepseek-official', model: 'test' }, session } as Agent
  const active = new Set(options.activated === false ? [] : [skill])
  const policy = {
    assertSkillActivated(exec: { agent?: Agent }, skill: string) {
      if (exec.agent !== agent || !active.has(skill)) throw new Error(`skill ${skill} is not activated`)
    },
    professionalSubjectIfPresent(exec: { agent?: Agent }) {
      return exec.agent === agent ? options.professionalSubject : undefined
    },
  } as GongchuangPolicyService
  const ctx = new Context()
  ctx.provide('gongchuangPolicy', policy)
  ctx.provide('gongchuangSkillRuntimeBinding', binding)
  const fibers: Fiber[] = []
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(MemorySubprocess))
  fibers.push(await ctx.plugin(MemorySandbox))
  fibers.push(await ctx.plugin(GongchuangSignedSkillRuntime))
  const subprocess = ctx.subprocess as MemorySubprocess
  subprocess.exitCode = options.exitCode ?? 0
  subprocess.stdout = options.stdout ?? '{"status":"pass"}\n'
  subprocess.stderr = options.stderr ?? ''
  subprocess.lossy = options.lossy ?? false
  return {
    ctx,
    agent,
    workspace: realpathSync(workspace),
    skillsRoot,
    subprocess,
    sandbox: ctx.sandbox as MemorySandbox,
    dispose: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() },
  }
}

async function execute(
  ctx: Context,
  agent: Agent,
  parameters: unknown = { input: 'input.json' },
  operation = 'demo-skill.validate-input',
) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('signed-operation'),
    rootCallId: ToolCallId('signed-operation'),
    name: 'gongchuang_skill_operation',
    arguments: { operation, parameters },
    agent,
  })
}

afterEach(() => {
  delete process.env.GONGCHUANG_TEST_SECRET
  delete process.env.VISIBLE_CREDENTIAL_PROFILE
})

describe('signed skill manifest', () => {
  it('accepts only closed no-network operation definitions', () => {
    const parsed = parseSignedSkillRuntimeManifest(runtimeManifest({
      stdout_json_schema_version: 'gongchuang-document-extraction/v1',
    }), '1.6.11')
    expect(parsed.operations[0]?.id).toBe('demo-skill.validate-input')
    expect(parsed.operations[0]?.stdoutJsonSchemaVersion).toBe('gongchuang-document-extraction/v1')
    expect(() => parseSignedSkillRuntimeManifest(runtimeManifest({ network: 'allow' }), '1.6.11')).toThrow(/不得启用脚本网络访问/)
    expect(() => parseSignedSkillRuntimeManifest(runtimeManifest({ script: '../escape.py' }), '1.6.11')).toThrow(/身份无效/)
    expect(() => parseSignedSkillRuntimeManifest(runtimeManifest({ extra: true }), '1.6.11')).toThrow(/未知字段 extra/)
    expect(() => parseSignedSkillRuntimeManifest(runtimeManifest(), '1.6.8')).toThrow(/版本或操作集合无效/)
  })

  it('accepts up to 32 distinct file extensions without changing the V1 schema', () => {
    const officeExtensions = [
      '.doc', '.docx', '.docm', '.dot', '.dotx', '.dotm', '.rtf', '.odt', '.xls',
      '.xlsx', '.xlsm', '.xlt', '.xltx', '.xltm', '.ods', '.pdf', '.txt',
    ]
    const parsed = parseSignedSkillRuntimeManifest(runtimeManifest({
      parameters: {
        input: {
          type: 'workspace-input-file', required: true, extensions: officeExtensions, max_bytes: 4_096,
        },
      },
    }), '1.6.11')
    expect(parsed.operations[0]?.parameters.input).toMatchObject({ extensions: officeExtensions })

    const tooMany = Array.from({ length: 33 }, (_, index) => `.f${String(index)}`)
    expect(() => parseSignedSkillRuntimeManifest(runtimeManifest({
      parameters: {
        input: {
          type: 'workspace-input-file', required: true, extensions: tooMany, max_bytes: 4_096,
        },
      },
    }), '1.6.11')).toThrow(/必须声明文件扩展名/)
  })
})

describe('isolated legacy Word worker', () => {
  const operation = parseSignedSkillRuntimeManifest(runtimeManifest({
    stdout_json_schema_version: 'gongchuang-document-extraction/v1',
  }, 'legacy-document'), '1.6.11').operations[0]

  function detectorResult(path: string, detectedKind = 'doc'): string {
    return JSON.stringify({
      schema_version: 'gongchuang-document-extraction/v1',
      name: path.split('/').at(-1),
      declared_suffix: path.slice(path.lastIndexOf('.')).toLowerCase(),
      detected_kind: detectedKind,
      contains_macros: false,
      detail: '',
      status: detectedKind === 'doc' ? 'conversion_required' : 'extracted',
      message: '',
      action: detectedKind === 'doc' ? 'convert_to_supported_format' : '',
      retryable: false,
      text: '',
      truncated: false,
    })
  }

  function run(path: string): { readonly exitCode: number | null; readonly payload: Record<string, unknown> } {
    if (operation === undefined) throw new Error('legacy document fixture operation is missing')
    const command = legacyWordWorkerCommand(operation, new Map([['document', path]]), detectorResult(path))
    if (command === undefined) throw new Error('legacy Word worker was not selected')
    const [executable, ...argv] = command.argv
    if (executable === undefined) throw new Error('legacy Word worker command is empty')
    const completed = spawnSync(executable, argv, {
      encoding: 'utf8',
      env: command.env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 10_000,
    })
    if (completed.error !== undefined) throw completed.error
    return { exitCode: completed.status, payload: JSON.parse(completed.stdout) as Record<string, unknown> }
  }

  it('extracts a real Word 97-2003 OLE document in a separate process', () => {
    const path = join(FIXTURES, 'word-extractor-test01.doc')
    const result = run(path)
    expect(result.exitCode).toBe(0)
    expect(result.payload).toMatchObject({
      schema_version: 'gongchuang-document-extraction/v1',
      name: 'word-extractor-test01.doc',
      kind: 'doc',
      declared_suffix: '.doc',
      detected_kind: 'doc',
      status: 'extracted',
      retryable: false,
      macro_policy: 'not-present',
      formula_policy: 'not-applicable',
      external_links: 'not-followed',
      truncated: false,
    })
    expect(result.payload.text).toContain('A second test of reviewing')
    expect(result.payload.text).toContain('This text has been inserted')
  })

  it('keeps escaped JSON output below the signed one-megabyte process cap', () => {
    if (operation === undefined) throw new Error('legacy document fixture operation is missing')
    const path = join(FIXTURES, 'word-extractor-test01.doc')
    const command = legacyWordWorkerCommand(operation, new Map([['document', path]]), detectorResult(path))
    if (command === undefined) throw new Error('legacy Word worker was not selected')
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-legacy-word-output-'))
    const module = join(root, 'large-word-extractor.cjs')
    writeFileSync(module, `
module.exports = class {
  async extract() {
    const blank = () => ''
    return {
      getBody: () => '\\\\'.repeat(600000),
      getHeaders: blank,
      getFooters: blank,
      getFootnotes: blank,
      getEndnotes: blank,
      getTextboxes: blank,
      getAnnotations: blank,
    }
  }
}
`)
    const argv = [...command.argv]
    argv[3] = module
    const [executable, ...arguments_] = argv
    if (executable === undefined) throw new Error('legacy Word worker command is empty')
    const completed = spawnSync(executable, arguments_, {
      encoding: 'utf8', env: command.env, maxBuffer: 2 * 1024 * 1024, timeout: 10_000,
    })
    expect(completed.status).toBe(0)
    expect(Buffer.byteLength(completed.stdout, 'utf8')).toBeLessThan(1_048_576)
    expect(JSON.parse(completed.stdout)).toMatchObject({ status: 'extracted', truncated: true })
  })

  it('keeps an Excel OLE container renamed as WPS on the signed Python path', () => {
    if (operation === undefined) throw new Error('legacy document fixture operation is missing')
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-legacy-word-xls-'))
    const disguised = join(root, 'not-a-word-document.wps')
    copyFileSync(join(FIXTURES, 'document-extraction-sample.xls'), disguised)
    expect(legacyWordWorkerCommand(
      operation,
      new Map([['document', disguised]]),
      detectorResult(disguised, 'xls'),
    )).toBeUndefined()
  })

  it('leaves OOXML, RTF, XLS and other non-candidates on the signed Python path', () => {
    if (operation === undefined) throw new Error('legacy document fixture operation is missing')
    expect(legacyWordWorkerCommand(
      operation,
      new Map([['document', join(FIXTURES, 'document-extraction-sample.xls')]]),
      detectorResult(join(FIXTURES, 'document-extraction-sample.xls'), 'xls'),
    )).toBeUndefined()
    const root = mkdtempSync(join(tmpdir(), 'gongchuang-legacy-word-non-ole-'))
    const rtf = join(root, 'document.wps')
    writeFileSync(rtf, '{\\rtf1 controlled text}\n')
    expect(legacyWordWorkerCommand(
      operation,
      new Map([['document', rtf]]),
      detectorResult(rtf, 'rtf'),
    )).toBeUndefined()
  })
})

describe('GongchuangSignedSkillRuntime', () => {
  it('publishes the owning skill and complete document parameters without exposing executable paths', async () => {
    const { ctx, skillsRoot, dispose } = await fixture({ profile: 'legacy-document' })
    try {
      const schema = ctx.tools.schemas().find(tool => tool.name === 'gongchuang_skill_operation')
      expect(schema?.description).toContain('await tools.skill({name: skill})')
      expect(schema?.description).toContain('parameterSchema 只描述类型和约束，不是参数值')
      expect(schema?.description).toContain('无需寻找运行清单、脚本或解释器')
      expect(schema?.description).toContain('所有参数均必填')
      expect(schema?.description).toContain('不要用 Bash、wc 或脚本预先统计字符数或字节数')
      expect(schema?.description).toContain(JSON.stringify({
        operation: 'project-application-assistant.extract-workspace-document',
        skill: 'project-application-assistant',
        description: 'Extract one workspace document.',
        parameterSchema: {
          document: { type: 'string', format: 'workspace-input-file', extensions: ['.doc', '.wps'], maxBytes: 134_217_728 },
        },
      }))
      expect(schema?.parameters).toMatchObject({
        properties: { operation: { enum: ['project-application-assistant.extract-workspace-document'] } },
      })
      expect(schema?.description).not.toContain(skillsRoot)
      expect(schema?.description).not.toContain('extract_workspace_document.py')
      expect(schema?.description).not.toContain('python-runtime')
    } finally {
      await dispose()
    }
  })

  it.each([
    { type: 'workspace-input-file', extensions: ['.doc'] },
    { type: 'workspace-input-file', path: 'legacy.doc', extensions: ['.doc'] },
  ])('rejects a copied path schema with an actionable field error before starting a process', async (document) => {
    const state = await fixture({ profile: 'legacy-document' })
    try {
      const result = await execute(state.ctx, state.agent, { document }, 'project-application-assistant.extract-workspace-document')
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('参数 document 必须是文件路径字符串')
      expect(JSON.stringify(result.content)).toContain('不要传参数定义或带 path 的对象')
      expect(state.subprocess.specs).toHaveLength(0)
    } finally {
      await state.dispose()
    }
  })

  it('renders fixed argv, confines read-only, and scrubs credential-shaped environment names', async () => {
    process.env.GONGCHUANG_TEST_SECRET = 'must-not-leak'
    process.env.VISIBLE_CREDENTIAL_PROFILE = 'must-not-leak'
    const state = await fixture()
    const result = await execute(state.ctx, state.agent)
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      operation: 'demo-skill.validate-input', skill: 'demo-skill', status: 'passed', exitCode: 0,
      sandboxEnforcement: 'full', skillBundleIndexSha256: 'a'.repeat(64),
      runtimeIntegrity: 'development-external', runtimeIndexSha256: 'b'.repeat(64),
    })
    const spec = state.subprocess.specs[0]
    expect(spec?.argv.slice(1, 8)).toEqual([
      '-B', '-E', '-s', '-X', 'utf8', join(state.skillsRoot, 'demo-skill/scripts/validate.py'), '--input',
    ])
    expect(spec?.argv.at(-1)).toBe(join(state.workspace, 'input.json'))
    expect(spec?.cwd).toBe(state.workspace)
    expect(spec?.env?.GONGCHUANG_TEST_SECRET).toBeUndefined()
    expect(spec?.env?.VISIBLE_CREDENTIAL_PROFILE).toBeUndefined()
    expect(spec?.env?.PYTHONDONTWRITEBYTECODE).toBe('1')
    expect(spec?.env?.PYTHONHASHSEED).toBe('0')
    expect(spec?.env?.PYTHONNOUSERSITE).toBe('1')
    expect(spec?.env?.PYTHONUTF8).toBe('1')
    expect(spec?.env?.PYTHONIOENCODING).toBe('utf-8')
    expect(state.sandbox.policies).toEqual([expect.objectContaining({ mode: 'read-only', workspaceRoot: state.workspace })])
    await state.dispose()
  })

  it('creates a missing workspace output parent before the first signed operation attempt', async () => {
    const state = await fixture({
      operationOverrides: {
        sandbox_mode: 'workspace-write',
        parameters: {
          output: { type: 'workspace-output-file', required: true, extensions: ['.json'] },
        },
        argv: [{ literal: '--output' }, { parameter: 'output' }],
      },
    })
    try {
      const output = 'nested/artifacts/metrics.json'
      const result = await execute(state.ctx, state.agent, { output })
      expect(result.isError).toBe(false)
      expect(existsSync(join(state.workspace, 'nested/artifacts'))).toBe(true)
      expect(state.subprocess.specs[0]?.argv.at(-1)).toBe(join(state.workspace, output))
    } finally {
      await state.dispose()
    }
  })

  it('injects the accepted professional candidate into generic DOCX generation', async () => {
    const accepted = '总体结论\n整改行动表\n这是已通过预校验的唯一正文。'
    const state = await fixture({
      professionalSubject: accepted,
      operationOverrides: {
        id: 'evidence-ledger.create-docx',
        sandbox_mode: 'workspace-write',
        parameters: {
          content: { type: 'text', required: true, min_length: 1, max_length: 8_192 },
          output: { type: 'workspace-output-file', required: true, extensions: ['.docx'] },
        },
        argv: [
          { literal: '--content' }, { parameter: 'content' },
          { literal: '--output' }, { parameter: 'output' },
        ],
      },
    })
    try {
      const result = await execute(
        state.ctx,
        state.agent,
        { content: '重新拼写后已漂移的正文', output: 'report.docx' },
        'evidence-ledger.create-docx',
      )
      expect(result.isError).toBe(false)
      expect(state.subprocess.specs[0]?.argv).toContain(accepted)
      expect(state.subprocess.specs[0]?.argv).not.toContain('重新拼写后已漂移的正文')
    } finally {
      await state.dispose()
    }
  })

  it('does not create or follow output parents outside the workspace', async () => {
    const operationOverrides = {
      sandbox_mode: 'workspace-write',
      parameters: {
        output: { type: 'workspace-output-file', required: true, extensions: ['.json'] },
      },
      argv: [{ parameter: 'output' }],
    }
    const state = await fixture({ operationOverrides })
    try {
      const escaped = await execute(state.ctx, state.agent, { output: '../outside/new/result.json' })
      expect(escaped.isError).toBe(true)
      expect(existsSync(join(state.workspace, '..', 'outside', 'new'))).toBe(false)

      const outside = join(state.workspace, '..', 'linked-output')
      mkdirSync(outside)
      symlinkSync(outside, join(state.workspace, 'linked'))
      const linked = await execute(state.ctx, state.agent, { output: 'linked/result.json' })
      expect(linked.isError).toBe(true)
      expect(JSON.stringify(linked)).toContain('越出当前企业空间')
      expect(state.subprocess.specs).toHaveLength(0)
    } finally {
      await state.dispose()
    }
  })

  it('returns a rejected receipt for a declared validator rejection code', async () => {
    const state = await fixture({ exitCode: 2, stdout: '{"status":"fail"}\n' })
    const result = await execute(state.ctx, state.agent)
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ status: 'rejected', exitCode: 2 })
    await state.dispose()
  })

  it('keeps legacy Word parsing inside the same signed read-only subprocess receipt', async () => {
    process.env.GONGCHUANG_TEST_SECRET = 'must-not-leak'
    const state = await fixture({
      profile: 'legacy-document',
      stdout: [
        '{"schema_version":"gongchuang-document-extraction/v1","name":"legacy.doc","declared_suffix":".doc","detected_kind":"doc","contains_macros":false,"detail":"","status":"conversion_required","message":"convert","action":"convert_to_supported_format","retryable":false,"text":"","truncated":false}\n',
        '{"schema_version":"gongchuang-document-extraction/v1","name":"legacy.doc","declared_suffix":".doc","detected_kind":"doc","contains_macros":false,"detail":"","status":"extracted","text":"fixture","truncated":false,"retryable":false,"macro_policy":"not-present","formula_policy":"not-applicable","external_links":"not-followed"}\n',
      ],
    })
    copyFileSync(join(FIXTURES, 'word-extractor-test01.doc'), join(state.workspace, 'legacy.doc'))
    const result = await execute(
      state.ctx,
      state.agent,
      { document: 'legacy.doc' },
      'project-application-assistant.extract-workspace-document',
    )
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      operation: 'project-application-assistant.extract-workspace-document',
      skill: 'project-application-assistant',
      status: 'passed',
      exitCode: 0,
      sandboxEnforcement: 'full',
    })
    expect(state.subprocess.specs).toHaveLength(2)
    const pythonSpec = state.subprocess.specs[0]
    expect(pythonSpec?.argv[0]).toBe(state.ctx.gongchuangSkillRuntimeBinding.pythonExecutable)
    const spec = state.subprocess.specs[1]
    expect(spec?.argv[0]).toBe(process.execPath)
    expect(spec?.argv[1]).toBe('-e')
    expect(spec?.argv.at(-3)).toBe(join(state.workspace, 'legacy.doc'))
    expect(spec?.argv.at(-2)).toBe('.doc')
    expect(spec?.argv.at(-1)).toBe('false')
    expect(spec?.env?.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(spec?.env?.GONGCHUANG_TEST_SECRET).toBeUndefined()
    expect(state.sandbox.policies).toHaveLength(2)
    expect(state.sandbox.policies).toEqual(expect.arrayContaining([expect.objectContaining({
      mode: 'read-only', workspaceRoot: state.workspace,
    })]))
    await state.dispose()
  })

  it('rejects warning-only stdout when an operation declares a JSON result schema', async () => {
    const state = await fixture({
      stdout: '[WARNING] Ignore caches that are heterogeneous\n',
      stdoutJsonSchemaVersion: 'gongchuang-document-extraction/v1',
    })
    const result = await execute(state.ctx, state.agent)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('未返回单一有效 JSON 结果')
    await state.dispose()
  })

  it('accepts one matching structured result without stdout prefixes', async () => {
    const state = await fixture({
      stdout: '{"schema_version":"gongchuang-document-extraction/v1","status":"extracted"}\n',
      stdoutJsonSchemaVersion: 'gongchuang-document-extraction/v1',
    })
    const result = await execute(state.ctx, state.agent)
    expect(result.isError).toBe(false)
    await state.dispose()
  })

  it('rejects a script call until its owning skill is active in the same turn', async () => {
    const state = await fixture({ activated: false })
    const result = await execute(state.ctx, state.agent)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('is not activated')
    expect(state.subprocess.specs).toHaveLength(0)
    await state.dispose()
  })

  it('rejects extra parameters and workspace traversal before subprocess creation', async () => {
    const state = await fixture()
    const extra = await execute(state.ctx, state.agent, { input: 'input.json', command: 'whoami' })
    expect(extra.isError).toBe(true)
    const outside = join(state.workspace, '..', 'outside.json')
    writeFileSync(outside, '{}\n')
    const escaped = await execute(state.ctx, state.agent, { input: outside })
    expect(escaped.isError).toBe(true)
    expect(JSON.stringify(escaped)).toContain('越出当前企业空间')
    expect(state.subprocess.specs).toHaveLength(0)
    await state.dispose()
  })

  it('rejects symlinked inputs and imported-module drift on every call', async () => {
    const state = await fixture()
    symlinkSync(join(state.workspace, 'input.json'), join(state.workspace, 'linked.json'))
    const linked = await execute(state.ctx, state.agent, { input: 'linked.json' })
    expect(linked.isError).toBe(true)
    writeFileSync(join(state.skillsRoot, 'demo-skill/scripts/helper.py'), '# drifted\n')
    const drifted = await execute(state.ctx, state.agent)
    expect(drifted.isError).toBe(true)
    expect(JSON.stringify(drifted)).toContain('完整性与宿主验签结果不一致')
    expect(state.subprocess.specs).toHaveLength(0)
    await state.dispose()
  })

  it('fails closed when output exceeds the signed byte cap or the sandbox runner refuses', async () => {
    const overflow = await fixture({ lossy: true })
    const overflowResult = await execute(overflow.ctx, overflow.agent)
    expect(overflowResult.isError).toBe(true)
    expect(JSON.stringify(overflowResult)).toContain('输出超过签名上限')
    await overflow.dispose()

    const refused = await fixture({ exitCode: 127, stderr: 'fixture-runner: profile rejected\n' })
    const refusedResult = await execute(refused.ctx, refused.agent)
    expect(refusedResult.isError).toBe(true)
    expect(JSON.stringify(refusedResult)).toContain('沙箱未能启动')
    await refused.dispose()
  })
})
