# Agent Note: 桌面端生成输出打包排除

Status: implemented

[English](2026-08-21-desktop-generated-output-packaging-exclusion.md) | 中文

## Problem

Electron Builder 会通过不同的最终规则列表处理应用根目录文件与依赖文件。平台级 `files` 列表若只排除 `release/**`，即使公共列表已有更宽的排除规则，仍可能纳入 `release.previous-*` 这类改名后的同级目录。此时 `app.asar` 会递归嵌入上一版应用、DMG、ZIP、运行时与技能包，导致每个制品在源码和依赖均未变化的情况下膨胀数 GB。

源码测试、类型、Git 状态和依赖锁文件无法观察这一故障，因为被纳入的是未跟踪的生成输出，错误文件集合只在 Electron Builder 解析平台规则后形成。

## Decision

桌面端构建在 macOS 和 Windows 应用根目录列表开头显式列出 `dist/**` 与 `package.json`，随后排除 `release*/**`、`output/**` 和平台不兼容的原生依赖。正向条目会阻止 Electron Builder 补入宽泛的默认根目录匹配。平台列表中的重复排除是有意保留的，因为 Electron Builder 使用这些列表匹配应用根目录，而不是只以公共列表为准。

`afterPack` 钩子在生成 DMG、ZIP 或 NSIS 目标前检查已经完成的 `app.asar`。归档缺失、物理归档或头部声明的逻辑负载超过 512 MiB，或顶层出现 `dist`、`package.json` 与 `node_modules` 之外的条目时，构建立刻失败。逻辑负载统计同时覆盖放入 `app.asar.unpacked` 的原生文件。该白名单会阻止生成输出、桌面端源码、测试、脚本和贡献者文档进入发布包。体积上限相对正常应用负载保留了充分余量，同时能在大型制品占用磁盘或进入发布渠道前阻止递归纳入。

归档检查使用显式声明的 `@electron/asar` 依赖，只读取头部而不解压负载。macOS 与 Windows 执行同一检查。macOS 钩子只校验内容，不能签名或改动应用包；Electron Builder 在钩子结束后处理 Electron fuses，再通过 `mac.identity: "-"` 执行唯一一次原生最终 ad-hoc 签名。由于 ad-hoc 身份没有稳定 Team，hardened runtime 的 entitlements 明确关闭库验证。签名产品运行时已经包含有效的 Mach-O 签名，Ed25519 索引同时绑定其精确字节，因此 `mac.signIgnore` 只排除 Builder 对 `Contents/Resources/product/runtime/files` 内嵌代码的重签，外层 App 仍会把该目录作为资源封存。

只读 `afterSign` 钩子在生成 DMG 与 ZIP 前，对最终 App 执行共享的运行时和技能验签，并运行 `codesign --verify --deep --strict`。新增该门禁是因为真实候选曾同时通过源码测试与代码签名校验，但 Builder 在 Ed25519 索引生成后改写了运行时动态库；普通源码测试和签名前输入校验无法观察这一顺序故障。DMG 与 ZIP 只消费通过校验且未再变动的 App。Windows ConPTY 隔离仍是仅限 Windows 的目标生成前准备。

## Alternatives considered

**每次构建前都把旧发布目录移出仓库。** 未采用，因为打包正确性会依赖操作人员清理步骤，中断或续跑发布时仍可能重现故障。

**只在单元测试中断言 package 配置字符串。** 未采用，因为原公共排除规则已经存在，但 Electron Builder 的最终应用根目录规则仍然纳入了该目录。

**仅在目标生成后拒绝过大的 DMG 与 ZIP。** 未采用，因为此时嵌套应用已经消耗构建时间与磁盘，而且压缩后目标体积不如直接检查致因的应用归档明确。

**在 `afterPack` 内运行 `codesign --deep`。** 未采用，因为它绕过 Electron Builder 的嵌套代码签名计划，并发生在 Builder 的最终 fuse 阶段之前。最终签名顺序由打包器负责，钩子只负责应用内容校验。

## Consequences

未批准的应用根目录条目进入 `app.asar`、应用代码异常超过上限，或 macOS 最终签名改写索引内产品载荷时，桌面端打包会在生成分发制品前失败。未来若合法新增顶层应用目录或负载超过 512 MiB，必须显式评审并调整。定向测试覆盖正常归档、意外目录、体积上限、钩子接线以及正向和排除文件规则；发布验收仍继续检查最终架构、摘要、内嵌运行时、内嵌技能包、启动和文档生成。
