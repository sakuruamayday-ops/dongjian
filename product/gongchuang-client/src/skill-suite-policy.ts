/** Path policy shared by the desktop stager and the signed host verifier. */

const FORBIDDEN_SEGMENTS = new Set([
  '.DS_Store',
  '.git',
  '.hg',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.svn',
  'Thumbs.db',
  '__pycache__',
])

const STANDALONE_SKILL_ATTESTATION_FILES = new Set([
  'publisher-ed25519.pub',
  'release-manifest.json',
  'release-manifest.json.sig',
  'release-signature.json',
])

const PORTABLE_RUNTIME_BEGIN = '<!-- BEGIN MANAGED PORTABLE SKILL RUNTIME -->'
const PORTABLE_RUNTIME_END = '<!-- END MANAGED PORTABLE SKILL RUNTIME -->'
const DESKTOP_RUNTIME_NOTICE = `## 客户端运行环境

本技能由客户端整包验签后加载，不执行其他宿主的独立安装、准备或二次验签流程。不得因客户端未携带独立安装清单而反复查找、安装或重试。

工具以本轮工具目录为准。若只开放 run_code，提供 description 与 code，在 code 内通过 await tools.skill、await tools.read、await tools.write、await tools.bash 等当前 SDK 绑定调用，不把 skill、read、write、edit、apply_patch 或 bash 当根工具。run_code 不是 Node.js：不可使用 require、process 或 fs；文件和进程操作使用 SDK 中的工具。读取文件固定调用 tools.read({ file_path: "..." })，不得把参数名写成 path。所有调用必须在 code 顶层实际 await，不得只定义未调用的包装函数。

run_code 只返回 null 或由字符串、数字、布尔值、数组和普通对象组成的纯 JSON；不得返回原始工具结果、Promise、undefined 或其他不可无损序列化的值。需要继续使用工具结果时在同一段 code 内完成处理，只返回后续决策必需的字段。

SDK 工具没有业务参数时也传入空对象 {}，不省略参数，不传 undefined。

用户限定读取指定文件或目录时，该范围优先于学习已有格式、复用历史案例和工作区探索。不读取其他会话成果或相邻项目来补齐答案，也不先扫描整个工作区。用户已经给出精确输入或输出路径时直接使用该路径；即使 SDK 提供 glob，也不得用 pwd、glob、find、ls 或目录枚举重新发现。来源未给出的字段保持未知；采集和写入时间由运行进程读取系统时钟，不复制示例日期。

技能说明中出现脚本名或命令，表示应按文档直接执行该命令，不表示可以先读取脚本源码。首次执行前不得读取 \`scripts/**\`、\`examples/**\`、\`tests/**\`、\`*.example.*\`、\`package.json\`，也不得列出技能目录来理解用法；只有文档给出的命令已经真实失败，且错误信息仍不足以确定调用契约时，才可定向读取与该失败直接相关的一个源码文件。此限制避免把生成任务退化为源码研读，也避免示例值污染用户事实。

技能文档已经给出连续的确定性命令时，在一个 run_code 中按依赖顺序连续执行相邻的输入校验、生成、导出和成品检查；除非前一步结果会改变下一步参数，不得每成功一条命令就返回模型重新规划。

客户端生成 PDF 时，统一使用宿主提供的 gongchuang_render_pdf：先按宿主要求对真实 HTML 源完成对话内预校验，再调用该工具。即使技能业务说明列有独立渲染脚本，也不得在客户端运行 render_pdf_stdout.js、直接启动 Chrome 或 Edge、查找或安装 Playwright 或 Chromium；这些独立渲染入口仅供未提供 gongchuang_render_pdf 的其他宿主。

调用可能持续运行的外部命令时，必须显式传入宿主支持的 timeoutMs，并保留真实退出状态。命令超时或失败后不得改成无超时后台运行，也不得用管道吞掉退出码。

`

/**
 * Decide whether one repository-relative skill-suite file is portable.
 * @param path - POSIX-style path relative to the staged `skills` root.
 * @returns `true` only for canonical, non-cache, cross-platform paths.
 */
export function isPortableSkillSuitePath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  if (path === 'local-skill-reconciliation.json') return false
  const segments = path.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..'
    || FORBIDDEN_SEGMENTS.has(segment))) return false
  if (segments.length > 1 && STANDALONE_SKILL_ATTESTATION_FILES.has(segments.at(-1) ?? '')) return false
  const leaf = segments.at(-1)?.toLowerCase() ?? ''
  return !leaf.endsWith('.pyc') && !leaf.endsWith('.pyo')
}

/**
 * Project standalone skill instructions into the desktop Host trust boundary.
 * Standalone packages keep their own prepare/Ed25519 workflow; the desktop
 * bundle is already verified as one signed index and must not ask the model to
 * re-enter the standalone lifecycle after activation.
 */
export function projectSkillSuiteText(path: string, value: string): string {
  if (!path.endsWith('/SKILL.md')) return value
  const begin = value.indexOf(PORTABLE_RUNTIME_BEGIN)
  const end = value.indexOf(PORTABLE_RUNTIME_END)
  if ((begin === -1) !== (end === -1) || (begin !== -1 && end < begin)) {
    throw new Error(`skill ${path} has an incomplete standalone prepare contract`)
  }
  if (begin === -1) return value
  const afterEnd = end + PORTABLE_RUNTIME_END.length
  const suffix = value.startsWith('\n', afterEnd) ? value.slice(afterEnd + 1) : value.slice(afterEnd)
  return `${value.slice(0, begin)}${DESKTOP_RUNTIME_NOTICE}${suffix}`
}
