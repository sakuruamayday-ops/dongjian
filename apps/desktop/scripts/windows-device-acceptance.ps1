[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$CandidateInstaller,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{64}$')]
  [string]$CandidateInstallerSha256,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$CandidateVersion,
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ExpectedPublisher,
  # 由发布清单传入，不使用上一版的默认值。
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$CandidateSkillVersion,
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 1000)]
  [int]$CandidateSkillCount,
  [ValidatePattern('^[0-9a-fA-F]{64}$')]
  [Parameter(Mandatory = $true)]
  [string]$ExpectedRuntimeIndexSha256,
  [ValidatePattern('^[0-9a-fA-F]{64}$')]
  [Parameter(Mandatory = $true)]
  [string]$ExpectedSkillIndexSha256,
  [ValidateRange(1, 1000000)]
  [Parameter(Mandatory = $true)]
  [int]$ExpectedSkillFiles,
  [ValidateRange(0, 1000000)]
  [int]$ExpectedRuntimeFiles = 0,
  [string]$InstallRoot = '',
  [string]$EvidenceRoot = '',
  [ValidateRange(60, 900)]
  [int]$LaunchTimeoutSeconds = 300,

  [Parameter(Mandatory = $true)]
  [switch]$ConfirmIsolatedDevice
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Utf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8
$OutputEncoding = $Utf8

$ProductName = '洞见'
$ProductExeName = 'Gongchuang.exe'
$UninstallerName = 'Uninstall Gongchuang.exe'
$ExpectedWindowTitle = '洞见'
$ExpectedSigningTier = 'formal'
$OriginalAppData = $env:APPDATA
$OriginalLocalAppData = $env:LOCALAPPDATA
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = Join-Path $OriginalLocalAppData 'GongchuangAcceptance\App'
}
if ([string]::IsNullOrWhiteSpace($EvidenceRoot)) {
  $EvidenceRoot = Join-Path $OriginalLocalAppData "GongchuangAcceptance\Evidence-$Timestamp"
}

$CandidateInstaller = (Resolve-Path -LiteralPath $CandidateInstaller).Path
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
$AcceptanceRoaming = Join-Path $EvidenceRoot 'AppData\Roaming'
$ReceiptPath = Join-Path $EvidenceRoot 'windows-device-acceptance.json'
$script:Stages = [Collections.Generic.List[object]]::new()
$script:FinalState = 'running'
$script:Failure = $null
$script:SignToolPath = $null

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Equal([object]$Actual, [object]$Expected, [string]$Label) {
  if ($Actual -ne $Expected) {
    throw "$Label 不一致：实际=$Actual，期望=$Expected"
  }
}

function Assert-IsolatedTarget {
  if (-not $ConfirmIsolatedDevice.IsPresent) {
    throw '必须显式传入 -ConfirmIsolatedDevice，且只能在无正式共创客户端的 Windows 测试机执行'
  }
  if (-not [Environment]::Is64BitOperatingSystem) {
    throw '验收机不是 64 位 Windows'
  }
  $localRoot = [IO.Path]::GetFullPath($OriginalLocalAppData).TrimEnd('\') + '\'
  if (-not $InstallRoot.StartsWith($localRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw '安装验收目录必须位于当前用户 LOCALAPPDATA 之内'
  }
  if (Test-Path -LiteralPath $InstallRoot) {
    throw "安装验收目录已存在，拒绝覆盖：$InstallRoot"
  }
  if (Test-Path -LiteralPath $EvidenceRoot) {
    throw "验收证据目录已存在，拒绝覆盖：$EvidenceRoot"
  }
  $installed = @(Get-InstalledProductRows)
  if ($installed.Count -gt 0) {
    throw '当前 Windows 用户已安装洞见，请改用干净测试账号或测试机'
  }
}

function Get-InstalledProductRows {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  $rows = @()
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($key in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
      $value = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
      if ($null -ne $value -and $value.DisplayName -eq $ProductName) {
        $rows += [pscustomobject][ordered]@{
          key = $key.PSPath
          displayVersion = [string]$value.DisplayVersion
          installLocation = [string]$value.InstallLocation
          uninstallString = [string]$value.UninstallString
        }
      }
    }
  }
  return $rows
}

function Write-Receipt([string]$Status) {
  $os = Get-CimInstance Win32_OperatingSystem
  $computer = Get-CimInstance Win32_ComputerSystem
  $receipt = [ordered]@{
    schemaVersion = 2
    productId = 'cn.dongjian.desktop'
    clientVersion = $CandidateVersion
    skillBundleVersion = $CandidateSkillVersion
    status = $Status
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    device = [ordered]@{
      computerName = $env:COMPUTERNAME
      manufacturer = [string]$computer.Manufacturer
      model = [string]$computer.Model
      osCaption = [string]$os.Caption
      osVersion = [string]$os.Version
      osBuild = [string]$os.BuildNumber
      osArchitecture = [string]$os.OSArchitecture
      processArchitecture = $env:PROCESSOR_ARCHITECTURE
      interactive = [Environment]::UserInteractive
    }
    candidate = [ordered]@{
      installer = [ordered]@{
        path = $CandidateInstaller
        sha256 = (Get-Sha256 $CandidateInstaller)
        version = $CandidateVersion
        publisher = $ExpectedPublisher
      }
      runtimeIndexSha256 = $ExpectedRuntimeIndexSha256
      skillBundle = [ordered]@{
        version = $CandidateSkillVersion
        indexSha256 = $ExpectedSkillIndexSha256
        skillCount = $CandidateSkillCount
        fileCount = $ExpectedSkillFiles
        signingTier = $ExpectedSigningTier
      }
    }
    boundaries = [ordered]@{
      installRoot = $InstallRoot
      evidenceRoot = $EvidenceRoot
      appDataRoot = $AcceptanceRoaming
      noCredentialsCollected = $true
      isolatedDeviceConfirmed = $ConfirmIsolatedDevice.IsPresent
      uninstallFileRemoval = 'Windows Recycle Bin'
    }
    stages = @($script:Stages)
    failure = $script:Failure
  }
  [IO.Directory]::CreateDirectory($EvidenceRoot) | Out-Null
  [IO.File]::WriteAllText($ReceiptPath, ($receipt | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}

function Invoke-Stage([string]$Name, [scriptblock]$Action) {
  $started = Get-Date
  Write-Host "[$Name] 开始"
  try {
    $details = & $Action
    $ended = Get-Date
    $script:Stages.Add([pscustomobject][ordered]@{
      name = $Name
      status = 'passed'
      startedAtUtc = $started.ToUniversalTime().ToString('o')
      endedAtUtc = $ended.ToUniversalTime().ToString('o')
      durationSeconds = [Math]::Round(($ended - $started).TotalSeconds, 3)
      details = $details
    })
    Write-Receipt 'running'
    Write-Host "[$Name] 通过"
    return $details
  }
  catch {
    $ended = Get-Date
    $script:Stages.Add([pscustomobject][ordered]@{
      name = $Name
      status = 'failed'
      startedAtUtc = $started.ToUniversalTime().ToString('o')
      endedAtUtc = $ended.ToUniversalTime().ToString('o')
      durationSeconds = [Math]::Round(($ended - $started).TotalSeconds, 3)
      error = $_.Exception.Message
    })
    $script:Failure = [ordered]@{ stage = $Name; message = $_.Exception.Message }
    Write-Receipt 'failed'
    throw
  }
}

function Wait-ForFile([string]$Path, [int]$TimeoutSeconds = 120) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "等待文件超时：$Path"
}

function Invoke-Installer([string]$Installer) {
  $arguments = @('/S', "/D=$InstallRoot")
  $process = Start-Process -FilePath $Installer -ArgumentList $arguments -Wait -PassThru
  Assert-Equal $process.ExitCode 0 '安装程序退出码'
  $exe = Join-Path $InstallRoot $ProductExeName
  Wait-ForFile $exe
  return [pscustomobject][ordered]@{
    installer = $Installer
    arguments = @('/S', '/D=<isolated-install-root>')
    exitCode = $process.ExitCode
    installedExecutable = $exe
  }
}

function Get-PeMachine([string]$Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $reader = [IO.BinaryReader]::new($stream)
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw "非 PE 文件：$Path" }
    $stream.Position = 0x3C
    $peOffset = $reader.ReadInt32()
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw "PE 签名无效：$Path" }
    return $reader.ReadUInt16()
  }
  finally {
    $stream.Dispose()
  }
}

function Resolve-SignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    throw '缺少 Windows SDK signtool.exe，不能核验 SHA-256 Authenticode 与 RFC 3161 时间戳'
  }
  return $command.Source
}

function Assert-AuthenticodeFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label 缺失：$Path" }
  $null = Get-PeMachine $Path
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  Assert-Equal ([string]$signature.Status) 'Valid' "$Label Authenticode 状态"
  if ($null -eq $signature.SignerCertificate) { throw "$Label 缺少签名证书：$Path" }
  Assert-Equal ([string]$signature.SignerCertificate.Subject) $ExpectedPublisher "$Label 发布者身份"
  if ($null -eq $signature.TimeStamperCertificate) { throw "$Label 缺少 RFC 3161 时间戳：$Path" }
  $timestampAlgorithm = [string]$signature.TimeStamperCertificate.SignatureAlgorithm.FriendlyName
  if ($timestampAlgorithm -notmatch '(?i)sha256') {
    throw "$Label 时间戳证书不是 SHA-256：实际=$timestampAlgorithm，文件=$Path"
  }
  if ([string]::IsNullOrWhiteSpace([string]$script:SignToolPath)) {
    $script:SignToolPath = Resolve-SignTool
  }
  $signToolOutput = & $script:SignToolPath verify /pa /all /v $Path 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "$Label SignTool 验证失败：$Path`n$signToolOutput" }
  if ($signToolOutput -notmatch '(?i)sha256') {
    throw "$Label SignTool 输出未确认 SHA-256 摘要：$Path"
  }
  return [pscustomobject][ordered]@{
    label = $Label
    path = $Path
    sha256 = Get-Sha256 $Path
    status = [string]$signature.Status
    publisher = [string]$signature.SignerCertificate.Subject
    signerThumbprint = ([string]$signature.SignerCertificate.Thumbprint).ToLowerInvariant()
    timeStamper = [string]$signature.TimeStamperCertificate.Subject
    timeStamperThumbprint = ([string]$signature.TimeStamperCertificate.Thumbprint).ToLowerInvariant()
    timeStampSignatureAlgorithm = $timestampAlgorithm
    signTool = $script:SignToolPath
  }
}

function Assert-InstalledAuthenticodeTree {
  $extensions = @('.exe', '.dll', '.node', '.pyd')
  $paths = @(Get-ChildItem -LiteralPath $InstallRoot -Recurse -File | Where-Object {
    $extensions -contains $_.Extension.ToLowerInvariant()
  } | Sort-Object FullName)
  if ($paths.Count -eq 0) { throw '安装目录内没有可执行文件，无法执行 Authenticode 验收' }
  $rows = foreach ($entry in $paths) {
    $relativePath = [IO.Path]::GetRelativePath($InstallRoot, $entry.FullName)
    Assert-AuthenticodeFile $entry.FullName "随包可执行文件 $relativePath"
  }
  return [pscustomobject][ordered]@{
    publisher = $ExpectedPublisher
    fileCount = $paths.Count
    extensions = $extensions
    files = @($rows)
  }
}

function Inspect-InstalledProduct(
  [string]$ExpectedVersion,
  [string]$RequiredRuntimeIndexSha256,
  [int]$RequiredRuntimeFiles,
  [string]$RequiredSkillIndexSha256,
  [int]$RequiredSkillFiles,
  [string]$RequiredSkillVersion,
  [int]$RequiredSkillCount
) {
  $exe = Join-Path $InstallRoot $ProductExeName
  $asar = Join-Path $InstallRoot 'resources\app.asar'
  $runtimeIndexPath = Join-Path $InstallRoot 'resources\product\runtime\runtime-index.json'
  $skillIndexPath = Join-Path $InstallRoot 'resources\product\skill-suite\skill-bundle-index.json'
  foreach ($path in @($exe, $asar, $runtimeIndexPath, $skillIndexPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "安装文件缺失：$path" }
  }
  $machine = Get-PeMachine $exe
  Assert-Equal $machine 0x8664 '客户端 PE 架构'
  $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion
  if (-not $version.StartsWith($ExpectedVersion, [StringComparison]::Ordinal)) {
    throw "客户端产品版本不一致：实际=$version，期望=$ExpectedVersion"
  }
  $runtimeIndexHash = Get-Sha256 $runtimeIndexPath
  $skillIndexHash = Get-Sha256 $skillIndexPath
  Assert-Equal $runtimeIndexHash $RequiredRuntimeIndexSha256.ToLowerInvariant() '产品运行时索引 SHA-256'
  Assert-Equal $skillIndexHash $RequiredSkillIndexSha256.ToLowerInvariant() '技能包索引 SHA-256'
  $runtimeIndex = Get-Content -LiteralPath $runtimeIndexPath -Raw | ConvertFrom-Json
  $skillIndex = Get-Content -LiteralPath $skillIndexPath -Raw | ConvertFrom-Json
  Assert-Equal $runtimeIndex.productId 'cn.dongjian.desktop' '运行时产品 ID'
  Assert-Equal $runtimeIndex.clientVersion $ExpectedVersion '运行时客户端身份'
  Assert-Equal $runtimeIndex.platform 'win32' '运行时平台'
  Assert-Equal $runtimeIndex.arch 'x64' '运行时架构'
  Assert-Equal $runtimeIndex.signingTier $ExpectedSigningTier '运行时签名层级'
  $runtimeFiles = @($runtimeIndex.files.PSObject.Properties).Count
  if ($RequiredRuntimeFiles -gt 0) { Assert-Equal $runtimeFiles $RequiredRuntimeFiles '运行时文件数' }
  Assert-Equal $skillIndex.skillBundleVersion $RequiredSkillVersion '技能包版本'
  Assert-Equal $skillIndex.signingTier $ExpectedSigningTier '技能包签名层级'
  Assert-Equal @($skillIndex.skills).Count $RequiredSkillCount '技能数'
  Assert-Equal @($skillIndex.files.PSObject.Properties).Count $RequiredSkillFiles '技能文件数'
  $authenticode = Assert-InstalledAuthenticodeTree
  return [pscustomobject][ordered]@{
    productVersion = $version
    peMachine = ('0x{0:X4}' -f $machine)
    executableSha256 = Get-Sha256 $exe
    appAsarSha256 = Get-Sha256 $asar
    runtimeIndexSha256 = $runtimeIndexHash
    runtimeFiles = $runtimeFiles
    skillIndexSha256 = $skillIndexHash
    skillCount = $RequiredSkillCount
    skillFiles = $RequiredSkillFiles
    authenticode = $authenticode
  }
}

function Get-MainLogPath {
  return Join-Path $AcceptanceRoaming "$ProductName\logs\main.log"
}

function Read-LogTail([string]$Path, [long]$Offset) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    if ($stream.Length -lt $Offset) { $Offset = 0 }
    $stream.Position = $Offset
    $buffer = [byte[]]::new($stream.Length - $Offset)
    if ($buffer.Length -gt 0) { $null = $stream.Read($buffer, 0, $buffer.Length) }
    return [Text.Encoding]::UTF8.GetString($buffer)
  }
  finally {
    $stream.Dispose()
  }
}

if (-not ('GongchuangWindowCapture.NativeMethods' -as [type])) {
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition @'
namespace GongchuangWindowCapture {
  using System;
  using System.Runtime.InteropServices;
  public static class NativeMethods {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  }
}
'@
}

function Save-WindowScreenshot([Diagnostics.Process]$Process, [string]$Path) {
  $Process.Refresh()
  $handle = $Process.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { throw '进程没有可截图的主窗口' }
  $rect = [GongchuangWindowCapture.NativeMethods+RECT]::new()
  if (-not [GongchuangWindowCapture.NativeMethods]::GetWindowRect($handle, [ref]$rect)) {
    throw '无法读取客户端窗口范围'
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { throw '客户端窗口尺寸无效' }
  $bitmap = [Drawing.Bitmap]::new($width, $height)
  try {
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
      $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
      $graphics.Dispose()
    }
  }
  finally {
    $bitmap.Dispose()
  }
}

function Close-Product([Diagnostics.Process]$Process, [bool]$RequireBackgroundRetention) {
  $Process.Refresh()
  if ($Process.HasExited) {
    if ($RequireBackgroundRetention) { throw '关闭主窗口后客户端错误退出，未保持系统托盘运行' }
    return [pscustomobject][ordered]@{ backgroundRetained = $false; processExited = $true }
  }
  if (-not $Process.CloseMainWindow()) { throw '无法向客户端发送正常关闭请求' }
  $deadline = (Get-Date).AddSeconds(60)
  $hidden = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $Process.Refresh()
    if ($Process.HasExited) { break }
    if ($Process.MainWindowHandle -eq [IntPtr]::Zero -or [string]::IsNullOrWhiteSpace($Process.MainWindowTitle)) {
      $hidden = $true
      break
    }
  }
  if ($RequireBackgroundRetention -and ($Process.HasExited -or -not $hidden)) {
    throw '关闭主窗口后未观测到客户端隐藏并保持系统托盘运行'
  }
  $backgroundRetained = -not $Process.HasExited
  if (-not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force
    $Process.WaitForExit(30000)
  }
  return [pscustomobject][ordered]@{
    backgroundRetained = $backgroundRetained
    processExited = $Process.HasExited
    cleanup = 'test process terminated after lifecycle assertion'
  }
}

function Start-VerifiedProduct(
  [string]$Label,
  [string]$RequiredRuntimeIndexSha256,
  [int]$RequiredSkillFiles,
  [string]$RequiredSkillVersion,
  [int]$RequiredSkillCount,
  [bool]$RequireBackgroundRetention
) {
  $exe = Join-Path $InstallRoot $ProductExeName
  $logPath = Get-MainLogPath
  $offset = 0
  if (Test-Path -LiteralPath $logPath -PathType Leaf) { $offset = (Get-Item -LiteralPath $logPath).Length }
  [IO.Directory]::CreateDirectory($AcceptanceRoaming) | Out-Null
  $previousAppData = $env:APPDATA
  try {
    $env:APPDATA = $AcceptanceRoaming
    $process = Start-Process -FilePath $exe -WorkingDirectory $InstallRoot -PassThru
  }
  finally {
    $env:APPDATA = $previousAppData
  }
  $deadline = (Get-Date).AddSeconds($LaunchTimeoutSeconds)
  $windowTitle = ''
  $logText = ''
  while ((Get-Date) -lt $deadline) {
    $process.Refresh()
    if (-not $process.HasExited) { $windowTitle = $process.MainWindowTitle }
    $logText = Read-LogTail $logPath $offset
    $hasSkill = $logText.Contains("skill suite verified version=$RequiredSkillVersion tier=$ExpectedSigningTier skills=$RequiredSkillCount files=$RequiredSkillFiles")
    $hasRuntime = $logText.Contains("product runtime verified tier=$ExpectedSigningTier index=$RequiredRuntimeIndexSha256")
    if ($windowTitle -eq $ExpectedWindowTitle -and $hasSkill -and $hasRuntime) { break }
    if ($process.HasExited) { throw "客户端在出现主窗口前退出，退出码=$($process.ExitCode)`n$logText" }
    Start-Sleep -Seconds 1
  }
  if ($windowTitle -ne $ExpectedWindowTitle) { throw "未在限时内出现主窗口：$windowTitle" }
  if (-not $logText.Contains("skill suite verified version=$RequiredSkillVersion tier=$ExpectedSigningTier skills=$RequiredSkillCount files=$RequiredSkillFiles")) {
    throw '未观测到技能包完整性验证日志'
  }
  if (-not $logText.Contains("product runtime verified tier=$ExpectedSigningTier index=$RequiredRuntimeIndexSha256")) {
    throw '未观测到产品运行时完整性验证日志'
  }
  $screenshot = Join-Path $EvidenceRoot "$Label.png"
  Save-WindowScreenshot $process $screenshot
  $closeResult = Close-Product $process $RequireBackgroundRetention
  $logEvidence = Join-Path $EvidenceRoot "$Label-main.log"
  [IO.File]::WriteAllText($logEvidence, $logText, [Text.UTF8Encoding]::new($false))
  return [pscustomobject][ordered]@{
    windowTitle = $windowTitle
    screenshot = $screenshot
    screenshotSha256 = Get-Sha256 $screenshot
    log = $logEvidence
    logSha256 = Get-Sha256 $logEvidence
    closeLifecycle = $closeResult
  }
}

function Start-ExpectedGateFailure([string]$Label) {
  $exe = Join-Path $InstallRoot $ProductExeName
  $logPath = Get-MainLogPath
  $offset = 0
  if (Test-Path -LiteralPath $logPath -PathType Leaf) { $offset = (Get-Item -LiteralPath $logPath).Length }
  $previousAppData = $env:APPDATA
  try {
    $env:APPDATA = $AcceptanceRoaming
    $process = Start-Process -FilePath $exe -WorkingDirectory $InstallRoot -PassThru
  }
  finally {
    $env:APPDATA = $previousAppData
  }
  $deadline = (Get-Date).AddSeconds($LaunchTimeoutSeconds)
  $failureTitle = ''
  $normalWindowObserved = $false
  $logText = ''
  while ((Get-Date) -lt $deadline) {
    $process.Refresh()
    if (-not $process.HasExited) {
      $failureTitle = $process.MainWindowTitle
      if ($failureTitle -eq $ExpectedWindowTitle) { $normalWindowObserved = $true }
    }
    $logText = Read-LogTail $logPath $offset
    if ($logText.Contains('runtime-index.sig') -and ($process.HasExited -or $failureTitle.Contains('启动失败'))) { break }
    Start-Sleep -Seconds 1
  }
  if ($normalWindowObserved) { throw '运行时签名缺失时错误显示了正常主窗口' }
  if (-not $logText.Contains('runtime-index.sig')) { throw '未观测到签名缺失的失败日志' }
  $screenshot = $null
  $screenshotHash = $null
  $process.Refresh()
  if (-not $process.HasExited -and $process.MainWindowHandle -ne [IntPtr]::Zero) {
    $screenshot = Join-Path $EvidenceRoot "$Label.png"
    Save-WindowScreenshot $process $screenshot
    $screenshotHash = Get-Sha256 $screenshot
    Close-Product $process $false | Out-Null
  }
  elseif (-not $process.HasExited) {
    throw '失败门禁进程未退出且没有可关闭窗口'
  }
  $logEvidence = Join-Path $EvidenceRoot "$Label-main.log"
  [IO.File]::WriteAllText($logEvidence, $logText, [Text.UTF8Encoding]::new($false))
  return [pscustomobject][ordered]@{
    normalWindowObserved = $normalWindowObserved
    failureWindowTitle = $failureTitle
    signaturePathObserved = $logText.Contains('runtime-index.sig')
    screenshot = $screenshot
    screenshotSha256 = $screenshotHash
    log = $logEvidence
    logSha256 = Get-Sha256 $logEvidence
  }
}

function Get-ShortcutState {
  $desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) "$ProductName.lnk"
  $startMenu = Join-Path $OriginalAppData "Microsoft\Windows\Start Menu\Programs\$ProductName.lnk"
  return [pscustomobject][ordered]@{
    desktopPath = $desktop
    desktopExists = Test-Path -LiteralPath $desktop -PathType Leaf
    startMenuPath = $startMenu
    startMenuExists = Test-Path -LiteralPath $startMenu -PathType Leaf
  }
}

function Invoke-RecoverableUninstall {
  $uninstaller = Join-Path $InstallRoot $UninstallerName
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw "卸载程序缺失：$uninstaller" }
  $uninstallerCopy = Join-Path $EvidenceRoot 'uninstaller-under-test.exe'
  Copy-Item -LiteralPath $uninstaller -Destination $uninstallerCopy
  $beforeRows = @(Get-InstalledProductRows)
  $beforeShortcuts = Get-ShortcutState
  $recycleLabel = "GongchuangAcceptance-App-$Timestamp"
  $recycleStaging = Join-Path (Split-Path -Parent $InstallRoot) $recycleLabel
  Move-Item -LiteralPath $InstallRoot -Destination $recycleStaging
  Add-Type -AssemblyName Microsoft.VisualBasic
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
    $recycleStaging,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
  )
  if (Test-Path -LiteralPath $recycleStaging) { throw '测试安装目录未进入 Windows 回收站' }
  $arguments = @('/S', "_?=$InstallRoot")
  $process = Start-Process -FilePath $uninstallerCopy -ArgumentList $arguments -Wait -PassThru
  Assert-Equal $process.ExitCode 0 '卸载程序退出码'
  $afterRows = @(Get-InstalledProductRows | Where-Object {
    $_.installLocation -eq $InstallRoot -or $_.uninstallString.Contains($InstallRoot)
  })
  $afterShortcuts = Get-ShortcutState
  if ($afterRows.Count -ne 0) { throw '卸载后仍残留指向验收目录的注册表项' }
  if ($afterShortcuts.desktopExists -or $afterShortcuts.startMenuExists) { throw '卸载后仍残留共创客户端快捷方式' }
  return [pscustomobject][ordered]@{
    uninstallerSha256 = Get-Sha256 $uninstallerCopy
    exitCode = $process.ExitCode
    fileRemoval = 'moved to Windows Recycle Bin before uninstaller metadata cleanup'
    recycleLabel = $recycleLabel
    registryRowsBefore = $beforeRows.Count
    registryRowsAfter = $afterRows.Count
    shortcutsBefore = $beforeShortcuts
    shortcutsAfter = $afterShortcuts
  }
}

try {
  Assert-IsolatedTarget
  [IO.Directory]::CreateDirectory($EvidenceRoot) | Out-Null
  [IO.Directory]::CreateDirectory($AcceptanceRoaming) | Out-Null

  Invoke-Stage 'preflight' {
    $candidateHash = Get-Sha256 $CandidateInstaller
    Assert-Equal $candidateHash $CandidateInstallerSha256.ToLowerInvariant() '候选安装包 SHA-256'
    $script:SignToolPath = Resolve-SignTool
    $installerAuthenticode = Assert-AuthenticodeFile $CandidateInstaller 'V0.2.0 NSIS 安装器'
    [pscustomobject][ordered]@{
      candidateSha256 = $candidateHash
      signTool = $script:SignToolPath
      installerAuthenticode = $installerAuthenticode
    }
  } | Out-Null

  Invoke-Stage 'candidate_install' { Invoke-Installer $CandidateInstaller } | Out-Null
  $candidateIdentity = Invoke-Stage 'candidate_identity' {
    Inspect-InstalledProduct $CandidateVersion $ExpectedRuntimeIndexSha256 $ExpectedRuntimeFiles $ExpectedSkillIndexSha256 $ExpectedSkillFiles $CandidateSkillVersion $CandidateSkillCount
  }
  Invoke-Stage 'candidate_launch' { Start-VerifiedProduct '01-candidate-launch' $ExpectedRuntimeIndexSha256 $ExpectedSkillFiles $CandidateSkillVersion $CandidateSkillCount $true } | Out-Null
  $sentinelPath = Join-Path $AcceptanceRoaming "$ProductName\acceptance-user-state.txt"
  Invoke-Stage 'candidate_user_state' {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $sentinelPath)) | Out-Null
    [IO.File]::WriteAllText($sentinelPath, 'retain-across-uninstall-and-reinstall', [Text.UTF8Encoding]::new($false))
    [pscustomobject][ordered]@{ sentinel = $sentinelPath; created = $true }
  } | Out-Null

  Invoke-Stage 'corrupt_runtime_fail_closed' {
    $signature = Join-Path $InstallRoot 'resources\product\runtime\runtime-index.sig'
    $held = Join-Path $EvidenceRoot 'runtime-index.sig.held'
    Move-Item -LiteralPath $signature -Destination $held
    try {
      Start-ExpectedGateFailure '02-runtime-signature-missing'
    }
    finally {
      if (Test-Path -LiteralPath $held -PathType Leaf) {
        Move-Item -LiteralPath $held -Destination $signature
      }
    }
  } | Out-Null
  Invoke-Stage 'corrupt_runtime_recovery' { Start-VerifiedProduct '03-runtime-recovered' $ExpectedRuntimeIndexSha256 $ExpectedSkillFiles $CandidateSkillVersion $CandidateSkillCount $true } | Out-Null

  Invoke-Stage 'recoverable_uninstall' { Invoke-RecoverableUninstall } | Out-Null
  Invoke-Stage 'uninstall_state_retention' {
    if (Test-Path -LiteralPath $InstallRoot) { throw '卸载后安装目录仍存在' }
    if (-not (Test-Path -LiteralPath $sentinelPath -PathType Leaf)) { throw '卸载后用户状态未保留' }
    [pscustomobject][ordered]@{ installedFilesAbsent = $true; userStateRetained = $true; sentinel = $sentinelPath }
  } | Out-Null

  Invoke-Stage 'final_reinstall' { Invoke-Installer $CandidateInstaller } | Out-Null
  Invoke-Stage 'final_identity' {
    $identity = Inspect-InstalledProduct $CandidateVersion $ExpectedRuntimeIndexSha256 $ExpectedRuntimeFiles $ExpectedSkillIndexSha256 $ExpectedSkillFiles $CandidateSkillVersion $CandidateSkillCount
    Assert-Equal $identity.appAsarSha256 $candidateIdentity.appAsarSha256 '重装后 app.asar SHA-256'
    $identity
  } | Out-Null
  Invoke-Stage 'final_user_state_retained' {
    if (-not (Test-Path -LiteralPath $sentinelPath -PathType Leaf)) { throw '重装后用户状态丢失' }
    [pscustomobject][ordered]@{ userStateRetained = $true; sentinel = $sentinelPath }
  } | Out-Null
  Invoke-Stage 'final_launch' { Start-VerifiedProduct '04-final-reinstall-launch' $ExpectedRuntimeIndexSha256 $ExpectedSkillFiles $CandidateSkillVersion $CandidateSkillCount $true } | Out-Null

  $script:FinalState = 'passed'
  Write-Receipt 'passed'
  Write-Host "Windows 单候选实机验收通过：$ReceiptPath"
}
catch {
  $script:FinalState = 'failed'
  if ($null -eq $script:Failure) { $script:Failure = [ordered]@{ stage = 'bootstrap'; message = $_.Exception.Message } }
  if (Test-Path -LiteralPath $EvidenceRoot) {
    Write-Receipt 'failed'
  }
  throw
}
