#!/usr/bin/env bash
set -euo pipefail

product_name='洞见'
bundle_name='洞见.app'
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
target_arch='arm64'
expected_macos_machine='arm64'
expected_binary_arch='arm64'
# 验收脚本直接读取桌面包版本，避免发布时再维护第二份候选版本号。
expected_client_version=$(node -p "require('${script_dir}/../package.json').version")
expected_window_title="$product_name V$expected_client_version"
# 验收目标来自同一发布配置，不能把上一次通过的版本继续写死在脚本里。
expected_skill_version=$(node -p "require('${script_dir}/../../../product/gongchuang-client/policy-template.json').product.skillBundleVersion")
expected_skill_count=''
expected_signing_tier='formal'
launch_timeout_seconds=300
fail_closed_exit_timeout_seconds=20
candidate_app=''
candidate_app_asar_sha256=''
expected_runtime_index_sha256=''
expected_skill_index_sha256=''
expected_skill_file_count=''
evidence_root=''
isolated_device_confirmed=0

usage() {
  printf '%s\n' \
    "用法：macos-device-acceptance.sh \\" \
    "  --candidate-app <V${expected_client_version}正式候选.app> --candidate-app-asar-sha256 <sha256> \\" \
    "  --runtime-index-sha256 <sha256> --skill-index-sha256 <sha256> --skill-file-count <数量> \\" \
    "  --evidence-root <新目录> --arch <arm64|x64> --confirm-isolated-device"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --candidate-app) candidate_app=${2-}; shift 2 ;;
    --candidate-app-asar-sha256) candidate_app_asar_sha256=${2-}; shift 2 ;;
    --runtime-index-sha256) expected_runtime_index_sha256=${2-}; shift 2 ;;
    --skill-index-sha256) expected_skill_index_sha256=${2-}; shift 2 ;;
    --skill-file-count) expected_skill_file_count=${2-}; shift 2 ;;
    --evidence-root) evidence_root=${2-}; shift 2 ;;
    --arch) target_arch=${2-}; shift 2 ;;
    --launch-timeout-seconds) launch_timeout_seconds=${2-}; shift 2 ;;
    --confirm-isolated-device) isolated_device_confirmed=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$target_arch" in
  arm64) expected_macos_machine='arm64'; expected_binary_arch='arm64' ;;
  x64) expected_macos_machine='x86_64'; expected_binary_arch='x86_64' ;;
  *) printf '架构必须是 arm64 或 x64\n' >&2; exit 2 ;;
esac

sha256_file() { shasum -a 256 "$1" | awk '{print tolower($1)}'; }
lowercase() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

process_is_running() {
  local process_pid=$1
  local process_state=''
  # kill -0 对尚未 wait 的 zombie 子进程仍返回成功；ps 的 Z 状态才表示它已经退出。
  process_state=$(ps -o stat= -p "$process_pid" 2>/dev/null | awk 'NR == 1 { print $1 }') || return 1
  [[ -n "$process_state" && "$process_state" != Z* ]]
}

assert_sha256() {
  [[ "$2" =~ ^[0-9a-fA-F]{64}$ ]] || { printf '%s 不是 SHA-256\n' "$1" >&2; return 1; }
}

canonical_directory() {
  (cd "$1" && pwd -P)
}

[[ $(uname -s) == 'Darwin' ]] || { printf '该脚本只能在 macOS 运行\n' >&2; exit 1; }
[[ $(uname -m) == "$expected_macos_machine" ]] || { printf '验收机架构与候选不匹配：需要 %s\n' "$expected_macos_machine" >&2; exit 1; }
[[ $isolated_device_confirmed -eq 1 ]] || { printf '必须显式传入 --confirm-isolated-device\n' >&2; exit 1; }
[[ -d "$candidate_app" && ${candidate_app##*/} == "$bundle_name" ]] || { printf 'V%s 正式候选 app 无效\n' "$expected_client_version" >&2; exit 1; }
[[ -n "$evidence_root" && "$evidence_root" == /* && ! -e "$evidence_root" ]] \
  || { printf '验收证据目录必须是尚不存在的绝对路径\n' >&2; exit 1; }
[[ "$launch_timeout_seconds" =~ ^[0-9]+$ && $launch_timeout_seconds -ge 60 && $launch_timeout_seconds -le 900 ]] \
  || { printf '启动等待时间必须为 60 至 900 秒\n' >&2; exit 1; }
assert_sha256 candidate_app_asar_sha256 "$candidate_app_asar_sha256"
assert_sha256 runtime_index_sha256 "$expected_runtime_index_sha256"
assert_sha256 skill_index_sha256 "$expected_skill_index_sha256"
[[ "$expected_skill_file_count" =~ ^[0-9]+$ && $expected_skill_file_count -gt 0 ]] \
  || { printf 'skill_file_count 必须是正整数\n' >&2; exit 1; }
candidate_app_asar_sha256=$(lowercase "$candidate_app_asar_sha256")
expected_runtime_index_sha256=$(lowercase "$expected_runtime_index_sha256")
expected_skill_index_sha256=$(lowercase "$expected_skill_index_sha256")

candidate_app=$(canonical_directory "$candidate_app")
candidate_skill_index="$candidate_app/Contents/Resources/product/skill-suite/skill-bundle-index.json"
[[ -f "$candidate_skill_index" ]] || { printf '候选技能索引不存在\n' >&2; exit 1; }
[[ $(sha256_file "$candidate_skill_index") == "$expected_skill_index_sha256" ]] \
  || { printf '候选技能索引 SHA-256 不一致\n' >&2; exit 1; }
# 技能数量属于已签名套件自身的事实，不能在产品清单里再维护一份固定值。
expected_skill_count=$(
  node - "$candidate_skill_index" <<'NODE'
const fs = require('node:fs')
const index = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (!Array.isArray(index.skills) || index.skills.length === 0) process.exit(1)
process.stdout.write(String(index.skills.length))
NODE
)
[[ "$expected_skill_count" =~ ^[0-9]+$ && $expected_skill_count -gt 0 ]] \
  || { printf '候选技能数量无效\n' >&2; exit 1; }
evidence_parent=$(dirname "$evidence_root")
[[ -d "$evidence_parent" ]] || { printf '验收证据父目录不存在\n' >&2; exit 1; }
evidence_root="$(canonical_directory "$evidence_parent")/$(basename "$evidence_root")"
mkdir -m 700 "$evidence_root"
timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
stage_file="$evidence_root/stages.jsonl"
receipt_path="$evidence_root/macos-device-acceptance.json"
acceptance_root=$(mktemp -d "${TMPDIR%/}/gongchuang-macos-acceptance.XXXXXX")
chmod 700 "$acceptance_root"
acceptance_home="$acceptance_root/home"
install_parent="$acceptance_root/Applications"
installed_app="$install_parent/$bundle_name"
mkdir -m 700 "$acceptance_home" "$install_parent"
acceptance_trash_root=${GONGCHUANG_ACCEPTANCE_TRASH_ROOT:-"$HOME/.Trash"}
[[ "$acceptance_trash_root" == /* ]] || { printf '验收废纸篓目录必须是绝对路径\n' >&2; exit 1; }
mkdir -m 700 -p "$acceptance_trash_root"
trash_container=$(mktemp -d "${acceptance_trash_root%/}/GongchuangAcceptance-$timestamp.XXXXXX")
current_pid=''
final_status='running'
failure_stage=''
failure_message=''
acceptance_root_trashed=0

append_stage() {
  node - "$stage_file" "$1" "$2" "$3" "$4" <<'NODE'
const fs = require('node:fs')
const [path, name, status, startedAtUtc, endedAtUtc] = process.argv.slice(2)
fs.appendFileSync(path, `${JSON.stringify({ name, status, startedAtUtc, endedAtUtc })}\n`)
NODE
}

write_receipt() {
  FINAL_STATUS="$final_status" FAILURE_STAGE="$failure_stage" FAILURE_MESSAGE="$failure_message" \
  ACCEPTANCE_ROOT_TRASHED="$acceptance_root_trashed" node - \
    "$stage_file" "$receipt_path" "$candidate_app" "$candidate_app_asar_sha256" \
    "$expected_runtime_index_sha256" "$expected_skill_index_sha256" "$expected_skill_file_count" \
    "$expected_signing_tier" "$target_arch" "$trash_container" "$expected_client_version" \
    "$expected_skill_version" <<'NODE'
const fs = require('node:fs')
const os = require('node:os')
const [stagesPath, receiptPath, candidateApp, candidateHash, runtimeHash, candidateSkillHash,
  candidateSkillFiles, candidateSigningTier, targetArch, trashPath, clientVersion,
  skillBundleVersion] = process.argv.slice(2)
const stages = fs.readFileSync(stagesPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const receipt = {
  schemaVersion: 2,
  productId: 'cn.dongjian.desktop',
  clientVersion,
  skillBundleVersion,
  status: process.env.FINAL_STATUS,
  generatedAtUtc: new Date().toISOString(),
  device: { hostname: os.hostname(), platform: process.platform, arch: process.arch, release: os.release() },
  candidate: {
    path: candidateApp,
    architecture: targetArch,
    appAsarSha256: candidateHash,
    runtimeIndexSha256: runtimeHash,
    skillIndexSha256: candidateSkillHash,
    skillFiles: Number(candidateSkillFiles),
    signingTier: candidateSigningTier,
  },
  boundaries: {
    isolatedDeviceConfirmed: true,
    isolatedUserData: true,
    noCredentialsCollected: true,
    cleanup: process.env.ACCEPTANCE_ROOT_TRASHED === '1' ? 'moved to macOS Trash' : 'pending',
    trashPath,
  },
  stages,
  failure: process.env.FAILURE_STAGE === '' ? null : {
    stage: process.env.FAILURE_STAGE,
    message: process.env.FAILURE_MESSAGE,
  },
}
fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
NODE
}

move_acceptance_root_to_trash() {
  if [[ $acceptance_root_trashed -eq 0 && -d "$acceptance_root" ]]; then
    mv "$acceptance_root" "$trash_container/isolation-root" || return 1
    acceptance_root_trashed=1
  fi
}

on_exit() {
  exit_code=$?
  if [[ -n "$current_pid" ]]; then
    if process_is_running "$current_pid"; then kill -TERM "$current_pid" 2>/dev/null || true; fi
    wait "$current_pid" 2>/dev/null || true
  fi
  if [[ $final_status != 'passed' ]]; then
    final_status='failed'
    [[ -n "$failure_stage" ]] || failure_stage='bootstrap'
    [[ -n "$failure_message" ]] || failure_message="脚本退出码 $exit_code"
    move_acceptance_root_to_trash
    write_receipt
  fi
}
trap on_exit EXIT

run_stage() {
  stage_name=$1
  shift
  stage_started=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  printf '[%s] 开始\n' "$stage_name"
  if "$@"; then
    append_stage "$stage_name" passed "$stage_started" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf '[%s] 通过\n' "$stage_name"
  else
    stage_exit=$?
    append_stage "$stage_name" failed "$stage_started" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    failure_stage=$stage_name
    failure_message="阶段退出码 $stage_exit"
    return "$stage_exit"
  fi
}

verify_source_candidate() {
  candidate_actual=$(sha256_file "$candidate_app/Contents/Resources/app.asar")
  [[ $candidate_actual == "$candidate_app_asar_sha256" ]] || return 1
}

install_candidate() {
  [[ ! -e "$installed_app" ]] || return 1
  cp -cR "$candidate_app" "$installed_app" || return 1
}

verify_installed_identity() {
  expected_asar=$1
  expected_skill_sha256=$2
  expected_skill_files=$3
  expected_runtime_sha256=$4
  expected_installed_client_version=$5
  expected_installed_skill_version=$6
  expected_installed_skill_count=$7
  expected_installed_signing_tier=$8
  [[ -x "$installed_app/Contents/MacOS/$product_name" ]] || return 1
  file "$installed_app/Contents/MacOS/$product_name" | grep -Eq "$expected_binary_arch" || return 1
  installed_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$installed_app/Contents/Info.plist") || return 1
  [[ $installed_version == "$expected_installed_client_version" ]] || return 1
  [[ $(sha256_file "$installed_app/Contents/Resources/app.asar") == "$expected_asar" ]] || return 1
  runtime_index="$installed_app/Contents/Resources/product/runtime/runtime-index.json"
  skill_index="$installed_app/Contents/Resources/product/skill-suite/skill-bundle-index.json"
  [[ $(sha256_file "$runtime_index") == "$expected_runtime_sha256" ]] || return 1
  [[ $(sha256_file "$skill_index") == "$expected_skill_sha256" ]] || return 1
  node - "$runtime_index" "$skill_index" "$expected_installed_client_version" \
    "$expected_installed_skill_version" "$expected_installed_skill_count" \
    "$expected_skill_files" "$target_arch" "$expected_installed_signing_tier" <<'NODE'
const fs = require('node:fs')
const [runtimePath, skillPath, clientVersion, skillVersion, skillCount, skillFiles, targetArch, signingTier] = process.argv.slice(2)
const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'))
const skills = JSON.parse(fs.readFileSync(skillPath, 'utf8'))
if (runtime.productId !== 'cn.dongjian.desktop') throw new Error('runtime productId mismatch')
if (runtime.clientVersion !== clientVersion || runtime.platform !== 'darwin' || runtime.arch !== targetArch
  || runtime.signingTier !== signingTier) {
  throw new Error('runtime identity mismatch')
}
if (skills.skillBundleVersion !== skillVersion || skills.skills.length !== Number(skillCount)
  || skills.signingTier !== signingTier) {
  throw new Error('skill identity mismatch')
}
if (Object.keys(skills.files).length !== Number(skillFiles)) throw new Error('skill file count mismatch')
if (Object.keys(runtime.files).length < 1) throw new Error('runtime file inventory is empty')
NODE
}

new_log_since() {
  log_path=$1
  offset=$2
  if [[ ! -f "$log_path" ]]; then return 0; fi
  tail -c "+$((offset + 1))" "$log_path" || return 1
}

normal_renderer_evidence_is_valid() {
  local launch_log=$1
  [[ "$launch_log" == *'desktop renderer CSP startup verified manifest=application/json loader=live inlineExecutableScripts=0 productUi=@gongchuang/client-ui bootPage=absent'* ]] || return 1
  [[ "$launch_log" != *'renderer error:'* ]] || return 1
  [[ "$launch_log" != *'Failed to load plugins'* ]] || return 1
}

expected_startup_failure_is_valid() {
  local launch_log=$1
  [[ "$launch_log" == *'GC-STARTUP-001'* ]] || return 1
  [[ "$launch_log" != *'desktop main window ready'* ]] || return 1
}

start_product() {
  label=$1
  expected_failure=${2-0}
  require_shutdown_receipt=${3-1}
  expected_launch_skill_files=${4-$expected_skill_file_count}
  expected_launch_runtime_sha256=${5-$expected_runtime_index_sha256}
  expected_launch_window_title=${6-$expected_window_title}
  expected_launch_skill_version=${7-$expected_skill_version}
  expected_launch_skill_count=${8-$expected_skill_count}
  expected_launch_signing_tier=${9-$expected_signing_tier}
  log_path="$acceptance_home/Library/Logs/$product_name/main.log"
  mkdir -m 700 -p "$(dirname "$log_path")" || return 1
  log_offset=0
  [[ ! -f "$log_path" ]] || log_offset=$(stat -f '%z' "$log_path") || return 1
  terminal_log="$evidence_root/$label-terminal.log"
  GONGCHUANG_ACCEPTANCE_MODE=1 \
  GONGCHUANG_ACCEPTANCE_USER_DATA_ROOT="$acceptance_home" \
    "$installed_app/Contents/MacOS/$product_name" > "$terminal_log" 2>&1 &
  current_pid=$!
  deadline=$(( $(date +%s) + launch_timeout_seconds ))
  observed=''
  while [[ $(date +%s) -lt $deadline ]]; do
    observed=$(new_log_since "$log_path" "$log_offset")
    if [[ $expected_failure -eq 0 && "$observed" == *"desktop main window ready title=$expected_launch_window_title"* ]]; then
      break
    fi
    if [[ $expected_failure -eq 1 && "$observed" == *'GC-STARTUP-001'* ]]; then
      break
    fi
    if ! process_is_running "$current_pid"; then break; fi
    sleep 1
  done
  # 启动质量只能由主动退出前的日志判定。DSH 在收到 SIGTERM 后会先关闭
  # 回环服务，渲染器随即记录连接断开；这类退出期日志不能反推已经通过的
  # CSP 与主窗口启动失败，但进程退出码和 runtime shutdown 回执仍须单独通过。
  startup_observed=$observed
  printf '%s' "$observed" > "$evidence_root/$label-main.log" || return 1
  validation_failed=0
  if [[ $expected_failure -eq 0 ]]; then
    if [[ $expected_launch_skill_files -gt 0 ]]; then
      [[ "$observed" == *"skill suite verified version=$expected_launch_skill_version tier=$expected_launch_signing_tier skills=$expected_launch_skill_count files=$expected_launch_skill_files"* ]] || validation_failed=1
    fi
    [[ "$observed" == *"product runtime verified tier=$expected_launch_signing_tier index=$expected_launch_runtime_sha256"* ]] || validation_failed=1
    normal_renderer_evidence_is_valid "$observed" || validation_failed=1
    [[ "$observed" != *'Refused to execute inline script'* ]] || validation_failed=1
    [[ "$observed" != *'violates the following Content Security Policy directive'* ]] || validation_failed=1
    [[ "$observed" == *"desktop main window ready title=$expected_launch_window_title"* ]] || validation_failed=1
    screencapture -x "$evidence_root/$label.png" || validation_failed=1
  else
    # Product logs intentionally sanitize local runtime paths. Bind the
    # fail-closed receipt to the stable public diagnostic code instead of the
    # private signature file name that triggered the startup rejection.
    expected_startup_failure_is_valid "$observed" || validation_failed=1
    screencapture -x "$evidence_root/$label.png" || true
  fi
  forced_exit=0
  if [[ $expected_failure -eq 1 ]]; then
    fail_closed_deadline=$(( $(date +%s) + fail_closed_exit_timeout_seconds ))
    while process_is_running "$current_pid" && [[ $(date +%s) -lt $fail_closed_deadline ]]; do sleep 1; done
    if process_is_running "$current_pid"; then
      forced_exit=1
      validation_failed=1
      printf '启动门禁失败后进程未在 %s 秒内主动退出\n' "$fail_closed_exit_timeout_seconds" >&2
      kill -TERM "$current_pid" 2>/dev/null || true
      cleanup_deadline=$(( $(date +%s) + 5 ))
      while process_is_running "$current_pid" && [[ $(date +%s) -lt $cleanup_deadline ]]; do sleep 1; done
      if process_is_running "$current_pid"; then kill -KILL "$current_pid" 2>/dev/null || true; fi
    fi
  elif process_is_running "$current_pid"; then
    kill -TERM "$current_pid" || validation_failed=1
    close_deadline=$(( $(date +%s) + 60 ))
    while process_is_running "$current_pid" && [[ $(date +%s) -lt $close_deadline ]]; do sleep 1; done
    if process_is_running "$current_pid"; then
      forced_exit=1
      kill -KILL "$current_pid"
    fi
  fi
  set +e
  wait "$current_pid"
  process_exit=$?
  set -e
  current_pid=''
  observed=$(new_log_since "$log_path" "$log_offset") || return 1
  printf '%s' "$observed" > "$evidence_root/$label-main.log" || return 1
  if [[ $expected_failure -eq 0 ]]; then
    normal_renderer_evidence_is_valid "$startup_observed" || validation_failed=1
    [[ "$startup_observed" != *'Refused to execute inline script'* ]] || validation_failed=1
    [[ "$startup_observed" != *'violates the following Content Security Policy directive'* ]] || validation_failed=1
    [[ $forced_exit -eq 0 && $process_exit -eq 0 ]] || validation_failed=1
    if [[ $require_shutdown_receipt -eq 1 ]]; then
      [[ "$observed" == *'desktop runtime shutdown complete'* ]] || validation_failed=1
    fi
  else
    expected_startup_failure_is_valid "$observed" || validation_failed=1
    [[ $forced_exit -eq 0 && $process_exit -ne 0 ]] || validation_failed=1
  fi
  [[ $validation_failed -eq 0 ]] || return 1
}

create_sentinel() {
  sentinel="$acceptance_home/Library/Application Support/$product_name/acceptance-user-state.txt"
  mkdir -m 700 -p "$(dirname "$sentinel")" || return 1
  printf 'retain-across-uninstall-and-reinstall\n' > "$sentinel" || return 1
}

assert_sentinel() {
  sentinel="$acceptance_home/Library/Application Support/$product_name/acceptance-user-state.txt"
  [[ -f "$sentinel" ]] || return 1
  grep -q '^retain-across-uninstall-and-reinstall$' "$sentinel" || return 1
}

corrupt_runtime_and_fail_closed() {
  signature="$installed_app/Contents/Resources/product/runtime/runtime-index.sig"
  held="$evidence_root/runtime-index.sig.held"
  mv "$signature" "$held" || return 1
  set +e
  start_product '02-runtime-signature-missing' 1
  failure_result=$?
  set -e
  mv "$held" "$signature" || return 1
  return "$failure_result"
}

uninstall_to_trash() {
  mv "$installed_app" "$trash_container/uninstalled-$bundle_name" || return 1
  [[ ! -e "$installed_app" ]] || return 1
  assert_sentinel || return 1
}

run_stage preflight verify_source_candidate
run_stage candidate_install install_candidate
run_stage candidate_identity verify_installed_identity "$candidate_app_asar_sha256" "$expected_skill_index_sha256" "$expected_skill_file_count" "$expected_runtime_index_sha256" "$expected_client_version" "$expected_skill_version" "$expected_skill_count" "$expected_signing_tier"
run_stage candidate_launch start_product 01-candidate-launch 0
run_stage candidate_user_state create_sentinel
run_stage corrupt_runtime_fail_closed corrupt_runtime_and_fail_closed
run_stage corrupt_runtime_recovery start_product 03-runtime-recovered 0
run_stage recoverable_uninstall uninstall_to_trash
run_stage final_reinstall install_candidate
run_stage final_identity verify_installed_identity "$candidate_app_asar_sha256" "$expected_skill_index_sha256" "$expected_skill_file_count" "$expected_runtime_index_sha256" "$expected_client_version" "$expected_skill_version" "$expected_skill_count" "$expected_signing_tier"
run_stage final_user_state_retained assert_sentinel
run_stage final_launch start_product 04-final-reinstall-launch 0
run_stage recoverable_cleanup move_acceptance_root_to_trash

final_status='passed'
write_receipt
printf 'macOS V%s 正式候选实机验收通过：%s\n' "$expected_client_version" "$receipt_path"
