# macOS 打包直更候选验收

本流程验证一个已发布旧 ZIP 能否通过旧客户端自己的更新入口，直接安装一个已签名新 ZIP。演练只使用系统临时目录中的应用副本和用户数据副本，不访问 `/Applications` 中的正式客户端，不复制真实凭据，不切换生产更新源。演练结束后，临时根目录必须移入 macOS 废纸篓。

## 输入

- V0.4.0 对应架构的正式 ZIP、ZIP SHA-256 与解包后 `app.asar` SHA-256。
- V0.4.1 同一架构的候选 ZIP、ZIP SHA-256 与解包后 `app.asar` SHA-256。
- 同一 V0.4.1 候选生成的 `desktop-release-index.json` 与 `desktop-release-index.sig`。
- 尚不存在的 JSON 回执路径和日志路径。

候选清单必须由客户端固定的 Ed25519 发布者签名，并绑定目标架构、ZIP 文件名、体积、SHA-256、运行时索引和技能索引。脚本还会核验两端 Bundle ID、版本、单一架构、`app.asar` 与 `codesign --deep --strict`。

## arm64 直更

```sh
pnpm --dir apps/desktop run acceptance:mac-update \
  --source-archive /absolute/V0.4.0-arm64.zip \
  --source-version 0.4.0 \
  --source-archive-sha256 <sha256> \
  --source-app-asar-sha256 <sha256> \
  --target-archive /absolute/V0.4.1-arm64.zip \
  --target-version 0.4.1 \
  --target-archive-sha256 <sha256> \
  --target-app-asar-sha256 <sha256> \
  --manifest /absolute/desktop-release-index.json \
  --signature /absolute/desktop-release-index.sig \
  --target-keychain-access required \
  --arch arm64 \
  --receipt /absolute/new-arm64-update-receipt.json \
  --evidence-log /absolute/new-arm64-update.log
```

通过条件：旧包 UI 检查到 V0.4.1，下载、签名与包内运行时/技能验证、应用交换及新版本启动提交全部完成；同一 `persist:gongchuang-v0.1` cookie，以及活动、归档、删除和置顶状态，三类会话及其标题，附件对象，自定义模型连接配置，停用的社区技能及安装文件，企业分区长期记忆和停用的自动化任务逐文件保持。新包关闭并重启后须再次读取非机密状态，旧应用备份和暂存目录须移入废纸篓。

导航栏出现不代表企业空间目录 IPC 已完成。已配置用户的检查先只读确认根目录及 `needsInitialSetup=false`，再等待加载中的首次配置弹窗消失；全过程不点击保存、不选择目录，也不补写地区配置。真实未配置状态或持续不消失的弹窗仍使验收失败。

账号验收使用明确的 `signed-out` 隔离状态，不请求生产账号服务，也不写入 `GONGCHUANG_ACCOUNT_TOKEN`。`--target-keychain-access required` 是唯一允许的模式：目标包必须通过真实界面读取源包保存的用户名、密码、设备标识和模型凭据，完成一次旧 `safeStorage` 密文向固定签名原生 broker 的迁移，并由该 broker 逐项读回相同明文。迁移状态文件中的全部测试引用还必须标为 `present`。只验证旧密文文件字节未变、推迟系统授权或等待用户以后重试均判定失败。旧 `safeStorage` 数据在迁移后保留用于失败回滚；固定 broker 的签名字节跨后续版本保持不变，使已经迁移的凭据可在应用签名变化后继续读取。该隔离演练不证明生产账号登录态或设备绑定 token 已跨版本保留，这些结论仍由真实账号验收给出。

同一次验收还会在另一套隔离目录中执行失败恢复：旧包完成下载和安全替换，新包进入 `attempting` 后，只在可执行路径、事务参数和应用路径仍匹配时终止更新辅助程序记录的目标进程。通过条件是事务进入 `restored`，V0.4.0 回到当前应用路径并重新启动，V0.4.1 被隔离到失败槽，事务暂存目录和失败槽移入废纸篓；上述九类用户状态、持久分区 cookie 与源包凭据解密结果在恢复后再次保持。该故障注入不使用真实用户目录，也不触碰 `/Applications` 中的正式客户端。

无论演练在哪一步结束，`finally` 都会先关闭 Playwright 应用和本地 HTTPS 服务，再把源包与目标包的主程序、`Frameworks` Helper、crashpad 和打包运行时可执行清单按 `Contents` 相对路径映射到本次 `drillRoot` 下正常与回滚两套应用槽；因此目标版新增或改名的 Renderer、GPU、Utility、Python 与 MCP 子进程也属于同一清理范围。同时脚本从两套事务目录发现 job 路径并锁定携带该路径的 detached helper，先发送 `SIGTERM`，超时后仅对发送信号前仍符合这些精确身份的进程发送 `SIGKILL`，持续确认全部清零后才把 `drillRoot` 移入 macOS 废纸篓；清理失败时保留目录并把失败状态写入回执，不会先移动目录再声称清理完成。

## 更新器定向回归

候选打包前先运行完整更新器定向组：

```sh
pnpm exec vitest run \
  apps/desktop/tests/desktop-updater.spec.ts \
  apps/desktop/tests/macos-self-updater.spec.ts \
  apps/desktop/tests/signed-macos-update-manifest.spec.ts \
  apps/desktop/tests/update-metadata.spec.ts \
  apps/desktop/tests/preload-packaging.spec.ts \
  apps/desktop/tests/acceptance-user-data.spec.ts \
  apps/desktop/tests/macos-device-acceptance.spec.ts \
  apps/desktop/tests/desktop-update-persistence.spec.ts \
  apps/desktop/tests/loopback.spec.ts \
  apps/desktop/tests/runtime-bundle-path.spec.ts \
  apps/desktop/tests/windows-signing-config.spec.ts \
  apps/desktop/tests/windows-device-acceptance.spec.ts \
  apps/desktop/tests/skill-updater.spec.ts
```

该组分别验证：V0.3.3 可直接选择 V0.4.0；签名清单绑定固定发布者、目标架构、归档、运行时和技能；受限带宽下载可在进程重启后以 `Range` 与验证器继续并报告进度和剩余时间；过期或冲突的续传前缀不会混入候选；候选进程失败、应用启动失败、helper 接管失败、PID 复用或状态投影失败都会保留或恢复旧应用；Foundation 安全替换的安装与反向恢复参数均由定向测试固定。成功下载和失败回滚都不得改写账号凭据、企业空间及会话状态、附件、模型连接、技能、长期记忆、自动化任务或持久化分区。该组没有模拟突然断电，单元与静态回归通过后仍必须执行对应架构的打包直更演练，不能用本组结果替代候选包验收。

## x64 与 Rosetta

使用同一命令，把两端 ZIP 和哈希替换为 x64，并传入 `--arch x64`。脚本会拒绝非单一 x86_64 应用，实际启动旧 x64 客户端、执行直更并再次启动新 x64 客户端；当前 arm64 Mac 上该执行路径由 Rosetta 承载。

候选输入和打包运行时先分别验证：

```sh
pnpm --dir apps/desktop run verify:inputs:mac
pnpm --dir apps/desktop run verify:inputs:mac-intel
```

这两条命令会核对 formal 策略、技能包、对应架构运行时，并让对应 Python 文档运行时真实生成和重开 DOCX、XLSX、PPTX 与 PDF。`verify:inputs:mac-intel` 在 arm64 Mac 上执行 x64 Python 时形成 Rosetta 证据，不代表 Intel 物理设备验收。

## 候选生命周期

从 ZIP 解出候选应用后，arm64 运行：

```sh
pnpm --dir apps/desktop run acceptance:mac -- \
  --candidate-app /absolute/共创企业助手.app \
  --candidate-app-asar-sha256 <sha256> \
  --runtime-index-sha256 <sha256> \
  --skill-index-sha256 <sha256> \
  --skill-file-count <count> \
  --evidence-root /absolute/new-arm64-evidence \
  --arch arm64 \
  --confirm-isolated-device
```

x64 候选在当前 arm64 Mac 上的 Rosetta 生命周期使用相同参数并将 `--arch` 改为 `x64`，从 x86_64 shell 启动脚本：

```sh
/usr/bin/arch -x86_64 /bin/bash apps/desktop/scripts/macos-device-acceptance.sh <其余参数>
```

生命周期回执必须包含应用架构、`app.asar`、运行时索引、技能索引、formal 层级、正常启动、签名损坏失败关闭、恢复、可恢复卸载和重装；验收数据根进入废纸篓。

## Windows x64 静态边界

```sh
pnpm --dir apps/desktop run verify:inputs:win
pnpm --dir apps/desktop run dist:win
file apps/desktop/release/Gongchuang-Enterprise-Assistant-0.4.0-win-x64.exe
unzip -t apps/desktop/release/Gongchuang-Enterprise-Assistant-0.4.0-win-x64.zip
```

`verify:inputs:win` 核对正式策略、技能、Windows x64 运行时索引、PE Python 与文档依赖布局；`dist:win` 生成 NSIS、ZIP、blockmap 与 `latest.yml`。macOS 上只能据此记录 Windows x64 静态产物、架构、签名索引和归档完整性，不得表述为 Windows 真机安装、启动、托盘、凭据或更新通过。

## 发布边界

直更回执、设备生命周期和静态产物通过只表示候选验收完成。正式发布、服务器部署和生产更新源切换必须由独立发布事务执行。
