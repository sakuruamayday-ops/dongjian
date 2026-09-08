# Agent Note: 手动真实 API e2e 回执

Status: implemented

[English](2026-08-20-manual-real-api-e2e-receipts.md) | 中文

## Problem

真实 DeepSeek API e2e 套件能够证明确定性测试无法复现的提供方行为，但会使用外部凭据，并依赖远端服务的可用性与非确定性输出。若每次 push、拉取请求、夜间定时或 GitHub Release 都自动运行，就会把普通源码与发布工作流耦合到这些操作本不需要的 secret。此时缺少 secret 会显得像发布前提，即使全部发布产物都可以在不进行模型推理（inference）的情况下完成构建与验证。

测试套件在缺少 `DEEPSEEK_API_KEY` 时会自行跳过，因此人工请求的回执仍可能出现虚假绿色，除非工作流在套件启动前拒绝缺失或错误配置的 secret。

## Decision

专用的[真实 API 工作流](../../../../.github/workflows/e2e.yml)只通过 `workflow_dispatch` 运行。当需要当前外部提供方回执时，发布操作员手动触发该工作流，包括提供方适配器、模型协议、组装提示词或真实工具使用路径发生变化之后。普通 push、拉取请求、确定性 CI、构建和 GitHub Release 都不会调用该工作流，也不需要 `DEEPSEEK_API_KEY_EXTERNAL`。

工作流为每次手动触发保留无条件 preflight。它把仓库 secret `DEEPSEEK_API_KEY_EXTERNAL` 映射为步骤级 `DEEPSEEK_API_KEY` 变量，值为空时明确失败；随后构建正式 library 模式应用，将 `DEEPSEEK_BASE_URL` 固定为 `https://api.deepseek.com`，并运行完整 `pnpm run test:e2e` 套件。checkout、Node 与 pnpm 设置及依赖安装都不会收到 API 密钥。日志只报告密钥存在，不报告值或长度；job 继续使用只读仓库权限。

本决定部分取代[在 CI 中对外部 DeepSeek API 运行真实 API e2e 测试](2026-06-19-real-api-e2e-ci.zh.md)中的自动触发频率。旧记录仍负责独立的携带 secret 工作流、明确失败的 preflight、secret 映射与卫生，以及禁止 `pull_request_target` 的决定；本记录负责工作流何时运行，以及普通 GitHub 操作是否需要密钥。

## Alternatives considered

**每个可信拉取请求与 push 都运行。** 不采用，因为它会让确定性 CI 足以验证的代码和发布改动也进入携带 secret 的执行路径，而远端可用性与模型差异可能阻断无关工作。

**保留夜间定时作为提供方漂移监控。** 不采用，因为本产品不要求以周期性外部模型健康状态决定源码是否可合并或发布。提供方敏感行为发生变化，或发布证据需要时，由发布操作员请求回执。

**移除真实 API 路径。** 不采用，因为确定性 fixture（测试前置数据）不能证明身份验证、线上模型协议、流式回复或真实提供方工具交互。该路径继续作为显式证据，而不是自动门禁。

**允许手动工作流在无密钥时自行跳过。** 不采用，因为全部跳过会虚假声称已经取得真实提供方回执。每次请求手动工作流时，preflight 都保持必需。

## Consequences

源码 push、拉取请求与 GitHub Release 不再依赖 DeepSeek 凭据或远端服务健康状态。真实提供方回执具有明确的操作员、ref、运行时间和工作流结果，不再从无关的自动事件中推断。

由于没有定时任务刷新，真实 API 信号可能变得陈旧。因此，发布或适配器评审需要当前提供方证据时必须重新手动触发。仓库 secret 仍需要最小权限处理与轮换，但缺少它不会阻断确定性 CI 或产物发布，只会阻断明确请求的真实 API 回执。
