import { expect, it } from 'vitest'
import { projectSkillSuiteText } from '../src/skill-suite-policy.ts'

it('projects the same input-scope and SDK argument instructions for every desktop skill', () => {
  const text = '# Skill\n<!-- BEGIN MANAGED PORTABLE SKILL RUNTIME -->\nstandalone prepare\n<!-- END MANAGED PORTABLE SKILL RUNTIME -->\n## Business\nKeep this workflow.'
  for (const name of ['third-party-data-indexing', 'project-rule-manager', 'local-knowledge-retrieval']) {
    const projected = projectSkillSuiteText(`${name}/SKILL.md`, text)
    expect(projected).toContain('不读取其他会话成果或相邻项目')
    expect(projected).toContain('即使 SDK 提供 glob')
    expect(projected).toContain('不得用 pwd、glob、find、ls 或目录枚举重新发现')
    expect(projected).toContain('也传入空对象 {}')
    expect(projected).toContain('不把 skill、read、write、edit、apply_patch 或 bash 当根工具')
    expect(projected).toContain('tools.read({ file_path: "..." })')
    expect(projected).toContain('不得把参数名写成 path')
    expect(projected).toContain('不得只定义未调用的包装函数')
    expect(projected).toContain('只返回 null')
    expect(projected).toContain('不得返回原始工具结果、Promise、undefined')
    expect(projected).toContain('时间由运行进程读取系统时钟')
    // 脚本路径是执行入口，不是让模型先读源码和示例的许可。
    expect(projected).toContain('表示应按文档直接执行该命令')
    expect(projected).toContain('首次执行前不得读取 `scripts/**`')
    expect(projected).toContain('与该失败直接相关的一个源码文件')
    expect(projected).toContain('在一个 run_code 中按依赖顺序连续执行')
    expect(projected).toContain('不得每成功一条命令就返回模型重新规划')
    // 打包客户端不携带可供外部 Node 脚本解析的 Playwright，PDF 必须走宿主原生渲染器。
    expect(projected).toContain('统一使用宿主提供的 gongchuang_render_pdf')
    expect(projected).toContain('不得在客户端运行 render_pdf_stdout.js')
    expect(projected).toContain('查找或安装 Playwright 或 Chromium')
    expect(projected).toContain('必须显式传入宿主支持的 timeoutMs')
    expect(projected).toContain('不得改成无超时后台运行')
    expect(projected).toContain('## Business\nKeep this workflow.')
    expect(projected).not.toContain('standalone prepare')
  }
})
