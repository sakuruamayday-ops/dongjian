import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const scriptPath = resolve(import.meta.dirname, '../scripts/macos-device-acceptance.sh')
const script = readFileSync(scriptPath, 'utf8')
const processIsRunning = script.match(/process_is_running\(\) \{[\s\S]*?\n\}/u)?.[0]
const normalRendererEvidenceIsValid = script.match(/normal_renderer_evidence_is_valid\(\) \{[\s\S]*?\n\}/u)?.[0]
const expectedStartupFailureIsValid = script.match(/expected_startup_failure_is_valid\(\) \{[\s\S]*?\n\}/u)?.[0]

describe('macOS formal candidate device acceptance contract', () => {
  test('remains valid Bash before any device action starts', () => {
    // 帮助文本包含中文和续行符，必须先做语法检查，避免发布时才发现引号未闭合。
    expect(() => execFileSync('bash', ['-n', scriptPath])).not.toThrow()
  })

  test('stops launch polling when a child is exited or in zombie state', () => {
    expect(processIsRunning).toBeDefined()
    const check = `${processIsRunning}
ps() { printf 'S+\\n'; }
process_is_running 123
ps() { printf 'Z+\\n'; }
if process_is_running 123; then exit 41; fi
ps() { return 1; }
if process_is_running 123; then exit 42; fi
`
    expect(() => execFileSync('bash', ['-c', check])).not.toThrow()
    expect(script).not.toContain('kill -0 "$current_pid"')
  })

  test('requires an isolated device and one exact formal candidate identity', () => {
    expect(script).toContain('--confirm-isolated-device')
    expect(script).toContain('--candidate-app-asar-sha256')
    expect(script).toContain('--runtime-index-sha256')
    expect(script).toContain('--skill-index-sha256')
    expect(script).toContain("expected_macos_machine='arm64'")
    expect(script).toContain("x64) expected_macos_machine='x86_64'; expected_binary_arch='x86_64'")
    expect(script).toContain('[[ $(uname -m) == "$expected_macos_machine" ]]')
    expect(script).toContain("require('${script_dir}/../package.json').version")
    expect(script).toContain('expected_window_title="$product_name V$expected_client_version"')
    expect(script).toContain("expected_signing_tier='formal'")
    expect(script).toContain('skillBundleVersion,')
    expect(script).not.toMatch(/skillBundleVersion:\s*'\d+\.\d+\.\d+'/u)
  })

  test('isolates user data and checks the signed runtime and current release skill suite', () => {
    expect(script).toContain('GONGCHUANG_ACCEPTANCE_MODE=1')
    expect(script).toContain('GONGCHUANG_ACCEPTANCE_USER_DATA_ROOT="$acceptance_home"')
    expect(script).not.toContain('HOME="$acceptance_home"')
    expect(script).toContain("expected_signing_tier='formal'")
    expect(script).toContain('product runtime verified tier=$expected_launch_signing_tier')
    expect(script).toContain("policy-template.json').product.skillBundleVersion")
    expect(script).toContain('candidate_skill_index="$candidate_app/Contents/Resources/product/skill-suite/skill-bundle-index.json"')
    expect(script).toContain('[[ $(sha256_file "$candidate_skill_index") == "$expected_skill_index_sha256" ]]')
    expect(script).toContain("const index = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))")
    expect(script).not.toContain("product-manifest.json').bundledSkillSuite.skillCount")
    expect(script).not.toMatch(/expected_skill_(?:version|count)=['"]?\d/u)
    expect(script).toContain("expected_skill_file_count=''")
    expect(script).not.toMatch(/expected_skill_file_count=\d+/u)
    expect(script).toContain('skill suite verified version=$expected_launch_skill_version tier=$expected_launch_signing_tier skills=$expected_launch_skill_count files=$expected_launch_skill_files')
    expect(script).toContain('runtime.signingTier !== signingTier')
    expect(script).toContain('skills.signingTier !== signingTier')
    expect(script).toContain('desktop runtime shutdown complete')
    expect(script).toContain('skills.skillBundleVersion !== skillVersion')
    expect(script).toContain('Object.keys(skills.files).length !== Number(skillFiles)')
  })

  test('proves packaged startup under the desktop CSP without inline executable scripts', () => {
    expect(script).toContain('desktop renderer CSP startup verified manifest=application/json loader=live inlineExecutableScripts=0 productUi=@gongchuang/client-ui bootPage=absent')
    expect(script).toContain("[[ \"$observed\" != *'Refused to execute inline script'* ]]")
    expect(script).toContain("[[ \"$observed\" != *'violates the following Content Security Policy directive'* ]]")
  })

  test('rejects a renderer error, plugin failure page, or missing product UI despite a ready window', () => {
    expect(normalRendererEvidenceIsValid).toBeDefined()
    const verified = 'desktop renderer CSP startup verified manifest=application/json loader=live inlineExecutableScripts=0 productUi=@gongchuang/client-ui bootPage=absent'
    const legacyCspOnly = 'desktop renderer CSP startup verified manifest=application/json loader=live inlineExecutableScripts=0'
    const check = `${normalRendererEvidenceIsValid}
normal_renderer_evidence_is_valid '${verified}'
if normal_renderer_evidence_is_valid '${verified} renderer error: failed to apply @gongchuang/client-ui'; then exit 51; fi
if normal_renderer_evidence_is_valid '${verified} Failed to load plugins'; then exit 52; fi
if normal_renderer_evidence_is_valid '${legacyCspOnly} desktop main window ready'; then exit 53; fi
`
    expect(() => execFileSync('bash', ['-c', check])).not.toThrow()
  })

  test('keeps the controlled runtime-signature failure independent from renderer success', () => {
    expect(expectedStartupFailureIsValid).toBeDefined()
    const check = `${expectedStartupFailureIsValid}
expected_startup_failure_is_valid '[GC-STARTUP-001] runtime signature missing'
if expected_startup_failure_is_valid '[GC-STARTUP-001] desktop main window ready'; then exit 61; fi
if expected_startup_failure_is_valid 'renderer error: Failed to load plugins'; then exit 62; fi
`
    expect(() => execFileSync('bash', ['-c', check])).not.toThrow()
  })

  test('keeps startup validation separate from shutdown connection noise', () => {
    expect(script).toContain('startup_observed=$observed')
    expect(script.match(/normal_renderer_evidence_is_valid "\$observed"/gu)).toHaveLength(1)
    expect(script.match(/normal_renderer_evidence_is_valid "\$startup_observed"/gu)).toHaveLength(1)
    expect(script.match(/expected_startup_failure_is_valid "\$observed"/gu)).toHaveLength(2)
    expect(script.match(/"\$observed" != \*'Refused to execute inline script'\*/gu)).toHaveLength(1)
    expect(script.match(/"\$startup_observed" != \*'Refused to execute inline script'\*/gu)).toHaveLength(1)
    expect(script.match(/"\$observed" != \*'violates the following Content Security Policy directive'\*/gu))
      .toHaveLength(1)
    expect(script.match(/"\$startup_observed" != \*'violates the following Content Security Policy directive'\*/gu))
      .toHaveLength(1)
  })

  test('covers install, visual launch, fail-closed recovery of the current candidate, uninstall, and reinstall', () => {
    for (const stage of [
      'candidate_install',
      'candidate_launch',
      'candidate_user_state',
      'corrupt_runtime_fail_closed',
      'corrupt_runtime_recovery',
      'recoverable_uninstall',
      'final_reinstall',
      'final_identity',
      'final_user_state_retained',
      'final_launch',
    ]) expect(script).toContain(`run_stage ${stage}`)
    expect(script).toContain('screencapture -x')
  })

  test('has no V0.1.1 baseline or old-version rollback workflow', () => {
    expect(script).not.toContain('0.1.1')
    expect(script).not.toContain('1.6.6')
    expect(script).not.toContain('development-candidate')
    expect(script).not.toContain('--baseline-')
    expect(script).not.toMatch(/\bbaseline[_-]/u)
    expect(script).not.toMatch(/\brollback[_-]/u)
    expect(script).not.toMatch(/\bcandidate_restore[_-]/u)
  })

  test('never permanently removes acceptance data and emits one reviewable JSON receipt', () => {
    expect(script).not.toMatch(/\brm\b/u)
    expect(script).not.toMatch(/\bunlink\b/u)
    expect(script).toContain('mv "$acceptance_root" "$trash_container/isolation-root"')
    expect(script).toContain('macos-device-acceptance.json')
    expect(script).not.toContain('macos-device-acceptance.sha256')
    expect(script).not.toContain('receipt_hash')
    expect(script).toContain('schemaVersion: 2')
    expect(script).toContain('clientVersion,')
    expect(script).toContain('candidate: {')
    expect(script).not.toContain('candidates: {')
    expect(script).toContain('noCredentialsCollected: true')
    expect(script).not.toMatch(/sk-[a-zA-Z0-9]{16,}/u)
  })

  test('does not rely on errexit inside run_stage conditional functions', () => {
    expect(script).toContain('validation_failed=0')
    expect(script).toContain('[[ $validation_failed -eq 0 ]] || return 1')
    expect(script).toContain('[[ $candidate_actual == "$candidate_app_asar_sha256" ]] || return 1')
    expect(script).toContain('[[ $forced_exit -eq 0 && $process_exit -eq 0 ]] || validation_failed=1')
  })

  test('requires a tampered-runtime launch to terminate itself instead of accepting forced cleanup', () => {
    expect(script).toContain('fail_closed_exit_timeout_seconds=20')
    expect(script).toContain("\"$launch_log\" == *'GC-STARTUP-001'*")
    expect(script).not.toContain("\"$observed\" == *'runtime-index.sig'*")
    expect(script).toContain('启动门禁失败后进程未在 %s 秒内主动退出')
    expect(script).toContain('[[ $forced_exit -eq 0 && $process_exit -ne 0 ]] || validation_failed=1')
  })
})
