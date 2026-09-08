[CmdletBinding()]
param(
  [string]$ManifestPath = (Join-Path $PSScriptRoot 'windows-test-package.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Utf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8
$OutputEncoding = $Utf8

$acceptanceScript = Join-Path $PSScriptRoot 'windows-device-acceptance.ps1'

if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  throw "缺少 Windows 测试包清单：$ManifestPath"
}
$ManifestPath = (Resolve-Path -LiteralPath $ManifestPath).Path
$manifestRoot = Split-Path -Parent $ManifestPath
$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.productId -ne 'cn.dongjian.desktop') {
  throw 'Windows 测试包清单身份无效'
}
if ([string]::IsNullOrWhiteSpace([string]$manifest.candidate.publisher)) {
  throw 'Windows 测试包清单缺少固定发布者身份'
}
function Resolve-ManifestInstaller([object]$Entry) {
  $path = Join-Path $manifestRoot ([string]$Entry.installer)
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "清单安装包不存在：$path" }
  return (Resolve-Path -LiteralPath $path).Path
}
$candidateInstaller = Resolve-ManifestInstaller $manifest.candidate

try {
  & $acceptanceScript `
    -CandidateInstaller $candidateInstaller `
    -CandidateInstallerSha256 ([string]$manifest.candidate.sha256) `
    -CandidateVersion ([string]$manifest.candidate.version) `
    -ExpectedPublisher ([string]$manifest.candidate.publisher) `
    -ExpectedRuntimeIndexSha256 ([string]$manifest.candidate.runtimeIndexSha256) `
    -ExpectedRuntimeFiles ([int]$manifest.candidate.runtimeFiles) `
    -ExpectedSkillIndexSha256 ([string]$manifest.candidate.skillIndexSha256) `
    -ExpectedSkillFiles ([int]$manifest.candidate.skillFiles) `
    -CandidateSkillVersion ([string]$manifest.candidate.skillVersion) `
    -CandidateSkillCount ([int]$manifest.candidate.skillCount) `
    -ConfirmIsolatedDevice

  $evidenceBase = Join-Path $env:LOCALAPPDATA 'GongchuangAcceptance'
  $latestEvidence = Get-ChildItem -LiteralPath $evidenceBase -Directory -Filter 'Evidence-*' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  Write-Host ''
  Write-Host '洞见 Windows 真机生命周期验收通过。' -ForegroundColor Green
  if ($null -ne $latestEvidence) {
    $checklistSource = Join-Path $PSScriptRoot 'WINDOWS-MANUAL-SMOKE-CHECKLIST-zh.md'
    $checklistCopy = Join-Path $latestEvidence.FullName 'WINDOWS-MANUAL-SMOKE-CHECKLIST-zh.md'
    if (-not (Test-Path -LiteralPath $checklistSource -PathType Leaf)) {
      throw '缺少 Windows 手工冒烟验收清单，不能形成完整验收回执'
    }
    Copy-Item -LiteralPath $checklistSource -Destination $checklistCopy
    Write-Host '请将以下目录中的 windows-device-acceptance.json、截图和日志发回：'
    Write-Host $latestEvidence.FullName -ForegroundColor Cyan
    Start-Process explorer.exe $latestEvidence.FullName
    Start-Process notepad.exe $checklistCopy
  }
}
catch {
  Write-Host ''
  Write-Host 'Windows 真机验收失败，不能标记通过。' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host '请保留 %LOCALAPPDATA%\GongchuangAcceptance 下的回执、截图和日志。'
  exit 1
}
