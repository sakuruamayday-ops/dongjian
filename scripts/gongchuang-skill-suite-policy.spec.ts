import { describe, expect, it } from 'vitest'
import {
  isPortableSkillSuitePath,
  projectSkillSuiteText,
} from '../product/gongchuang-client/src/skill-suite-policy.ts'

describe('共创客户端技能包可携带路径策略', () => {
  it('保留正式技能资源', () => {
    expect(isPortableSkillSuitePath('high-tech-enterprise-application-drafting/SKILL.md')).toBe(true)
    expect(isPortableSkillSuitePath('_runtime/gongchuang-branding/assets/brand-mark.png')).toBe(true)
    expect(isPortableSkillSuitePath('patent-router/scripts/cnipa_epub_search.py')).toBe(true)
  })

  it.each([
    '__pycache__/module.cpython-313.pyc',
    'skill/scripts/__pycache__/module.pyc',
    'skill/.pytest_cache/state.json',
    'skill/module.pyo',
    'local-skill-reconciliation.json',
    'skill/publisher-ed25519.pub',
    'skill/release-manifest.json',
    'skill/release-manifest.json.sig',
    'skill/release-signature.json',
    '.DS_Store',
    '../outside.txt',
    '/absolute.txt',
    'skill\\windows-only.txt',
  ])('拒绝缓存或非规范路径 %s', (path) => {
    expect(isPortableSkillSuitePath(path)).toBe(false)
  })

  it('keeps standalone attestation outside the client bundle while retaining skill runtime files', () => {
    expect(isPortableSkillSuitePath('skill/scripts/portable_skill_runtime.py')).toBe(true)
    expect(isPortableSkillSuitePath('skill/scripts/verify_skill_installation.py')).toBe(true)
  })

  it('removes the standalone prepare contract only from the desktop projection', () => {
    const source = [
      '# Skill',
      '<!-- BEGIN MANAGED PORTABLE SKILL RUNTIME -->',
      '## 便携运行门禁',
      '!`python3 "${CODEBUDDY_SKILL_DIR}/scripts/portable_skill_runtime.py" prepare`',
      '',
      '每次触发先执行`prepare`并应用`active_preferences`。',
      '<!-- END MANAGED PORTABLE SKILL RUNTIME -->',
      '',
      '正文',
    ].join('\n')
    const projected = projectSkillSuiteText('skill/SKILL.md', source)

    expect(projected).toContain('# Skill')
    expect(projected).toContain('正文')
    expect(projected).not.toContain('portable_skill_runtime.py')
    expect(projected).not.toContain('每次触发先执行上述命令')
    expect(projectSkillSuiteText('skill/references/example.md', source)).toBe(source)
  })

  it('rejects a partially copied standalone prepare contract', () => {
    expect(() => projectSkillSuiteText(
      'skill/SKILL.md',
      '<!-- BEGIN MANAGED PORTABLE SKILL RUNTIME -->\nprepare\n',
    )).toThrow('incomplete standalone prepare contract')
  })
})
