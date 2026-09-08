import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const scriptPath = resolve(import.meta.dirname, '../scripts/windows-device-acceptance.ps1')
const script = readFileSync(scriptPath, 'utf8')
const runnerPath = resolve(import.meta.dirname, '../scripts/run-windows-device-acceptance.ps1')
const runner = readFileSync(runnerPath, 'utf8')
const commandPath = resolve(import.meta.dirname, '../scripts/run-windows-device-acceptance.cmd')
const command = readFileSync(commandPath, 'utf8')
const readmePath = resolve(import.meta.dirname, '../scripts/WINDOWS-DEVICE-ACCEPTANCE-README-zh.md')
const readme = readFileSync(readmePath, 'utf8')
const checklistPath = resolve(import.meta.dirname, '../scripts/WINDOWS-MANUAL-SMOKE-CHECKLIST-zh.md')
const checklist = readFileSync(checklistPath, 'utf8')

describe('Windows x64 device acceptance contract', () => {
  test('requires explicit isolated-device confirmation and one exact candidate hash', () => {
    expect(script).toContain('[switch]$ConfirmIsolatedDevice')
    expect(script).toContain('$CandidateInstallerSha256')
    expect(script).toContain("throw '当前 Windows 用户已安装洞见")
    expect(script).toContain("'/S', \"/D=$InstallRoot\"")
    expect(script).toContain('[string]$CandidateVersion,')
    expect(script).toContain('[string]$ExpectedPublisher')
    expect(script).toContain("$ExpectedSigningTier = 'formal'")
  })

  test('checks the installed x64 executable and signed runtime identities', () => {
    expect(script).toContain("$ProductExeName = 'Gongchuang.exe'")
    expect(script).toContain("$UninstallerName = 'Uninstall Gongchuang.exe'")
    expect(script).toContain('Assert-Equal $machine 0x8664')
    expect(script).toContain('Get-AuthenticodeSignature -LiteralPath $Path')
    expect(script).toContain("Assert-Equal ([string]$signature.Status) 'Valid'")
    expect(script).toContain('Assert-Equal ([string]$signature.SignerCertificate.Subject) $ExpectedPublisher')
    expect(script).toContain('TimeStamperCertificate')
    expect(script).toContain("$timestampAlgorithm -notmatch '(?i)sha256'")
    expect(script).toContain('verify /pa /all /v $Path')
    expect(script).toContain("@('.exe', '.dll', '.node', '.pyd')")
    expect(script).toContain('Assert-AuthenticodeFile $CandidateInstaller')
    expect(script).toContain('Assert-InstalledAuthenticodeTree')
    expect(script).toContain('$ExpectedRuntimeFiles = 0')
    expect(script).toContain('[string]$CandidateSkillVersion,')
    expect(script).toContain('[int]$ExpectedSkillFiles,')
    expect(script).toContain('[int]$CandidateSkillCount,')
    expect(script).not.toMatch(/\$(?:CandidateSkillVersion|ExpectedSkillFiles|CandidateSkillCount)\s*=\s*['"]?\d/u)
    expect(script).toContain('Assert-Equal $runtimeIndex.signingTier $ExpectedSigningTier')
    expect(script).toContain('Assert-Equal $skillIndex.signingTier $ExpectedSigningTier')
    expect(script).toContain('product runtime verified tier=$ExpectedSigningTier')
    expect(script).toContain('skill suite verified version=$RequiredSkillVersion tier=$ExpectedSigningTier skills=$RequiredSkillCount files=$RequiredSkillFiles')
    expect(script).toContain('Inspect-InstalledProduct $CandidateVersion $ExpectedRuntimeIndexSha256 $ExpectedRuntimeFiles $ExpectedSkillIndexSha256 $ExpectedSkillFiles $CandidateSkillVersion $CandidateSkillCount')
  })

  test('covers install, visual launch, fail-closed recovery, uninstall, and same-candidate reinstall', () => {
    for (const stage of [
      'candidate_install',
      'candidate_launch',
      'candidate_user_state',
      'corrupt_runtime_fail_closed',
      'corrupt_runtime_recovery',
      'recoverable_uninstall',
      'uninstall_state_retention',
      'final_reinstall',
      'final_identity',
      'final_user_state_retained',
      'final_launch',
    ]) expect(script).toContain(`'${stage}'`)
    expect(script).toContain('Save-WindowScreenshot')
    expect(script).toContain('SendToRecycleBin')
    expect(script).toContain('finally {')
    expect(script).toContain('Move-Item -LiteralPath $held -Destination $signature')
  })

  test('has no V0.1.1 baseline, old signing tier, or user-version rollback workflow', () => {
    for (const content of [script, runner, readme]) {
      expect(content).not.toContain('0.1.1')
      expect(content).not.toContain('1.6.6')
      expect(content).not.toContain('development-candidate')
      expect(content).not.toMatch(/\bbaseline[_-]/u)
      expect(content).not.toMatch(/\brollback[_-]/u)
      expect(content).not.toMatch(/\bcandidate_restore[_-]/u)
    }
  })

  test('never permanently removes acceptance files and emits one reviewable JSON receipt', () => {
    expect(script).not.toMatch(/\bRemove-Item\b/u)
    expect(script).not.toMatch(/\b(?:del|erase|rmdir|rd)\b/iu)
    expect(script).toContain("'windows-device-acceptance.json'")
    expect(script).not.toContain("'windows-device-acceptance.sha256'")
    expect(script).not.toContain('$ReceiptHashPath')
    expect(script).toContain('ConvertTo-Json -Depth 12')
    expect(script).toContain('schemaVersion = 2')
    expect(script).toContain('candidate = [ordered]@{')
    expect(script).not.toContain('installers = [ordered]@{')
    expect(script).not.toContain('runtimeIndexes = [ordered]@{')
    expect(script).toContain('noCredentialsCollected = $true')
    expect(script).not.toMatch(/sk-[a-zA-Z0-9]{16,}/u)
  })

  test('ships a double-click runner bound to a generated test-package manifest', () => {
    expect(readFileSync(scriptPath).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(readFileSync(runnerPath).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    for (const content of [script, runner]) {
      expect(content).toContain('[Console]::InputEncoding = $Utf8')
      expect(content).toContain('[Console]::OutputEncoding = $Utf8')
      expect(content).toContain('$OutputEncoding = $Utf8')
    }
    expect(runner).toContain("'windows-test-package.json'")
    expect(runner).toContain("$manifest.productId -ne 'cn.dongjian.desktop'")
    expect(runner).toContain('Resolve-ManifestInstaller $manifest.candidate')
    expect(runner).toContain('-CandidateVersion ([string]$manifest.candidate.version)')
    expect(runner).toContain('-ExpectedPublisher ([string]$manifest.candidate.publisher)')
    expect(runner).toContain('Windows 测试包清单缺少固定发布者身份')
    expect(runner).toContain('-CandidateSkillVersion ([string]$manifest.candidate.skillVersion)')
    expect(runner).not.toContain('$manifest.baseline')
    expect(runner).toContain('-ConfirmIsolatedDevice')
    expect(runner).toContain("Join-Path $env:LOCALAPPDATA 'GongchuangAcceptance'")
    expect(runner).toContain('windows-device-acceptance.json')
    expect(runner).toContain("Join-Path $PSScriptRoot 'WINDOWS-MANUAL-SMOKE-CHECKLIST-zh.md'")
    expect(runner).toContain('Copy-Item -LiteralPath $checklistSource -Destination $checklistCopy')
    expect(runner).toContain('Start-Process notepad.exe $checklistCopy')
    expect(command).toContain('-ExecutionPolicy Bypass')
    expect(command).toContain('run-windows-device-acceptance.ps1')
    expect(command).toContain('exit /b %GONGCHUANG_EXIT_CODE%')
    expect(command).not.toMatch(/[^\x00-\x7F]/u)
    expect(readFileSync(commandPath).includes(Buffer.from('\r\n'))).toBe(true)
    expect(readme).toContain('acceptance/run-windows-device-acceptance.cmd')
    expect(readme).not.toContain('双击运行Windows真机验收.cmd')
    expect(readme).toContain('生产登录、下载和更新状态以测试时服务端的真实响应为准')
    expect(checklist).toContain('三路模型真实对话')
    expect(checklist).toContain('技能中心与 MCP')
    expect(checklist).toContain('自动化与企业空间')
    expect(checklist).toContain('门禁、恢复与可访问性')
  })

  test('expects current close-to-tray behavior before terminating only the test process', () => {
    expect(script).toContain('[bool]$RequireBackgroundRetention')
    expect(script).toContain("throw '关闭主窗口后未观测到客户端隐藏并保持系统托盘运行'")
    expect(script).toContain('backgroundRetained = $backgroundRetained')
    expect(script).toContain('Stop-Process -Id $Process.Id -Force')
    expect(script).toContain('$CandidateSkillVersion $CandidateSkillCount $true')
  })
})
