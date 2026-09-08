---
description: "共创桌面客户端的产品专属 Host 服务家族，涵盖账号、记忆、自动化、模型连接、签名技能与用户错误归属。"
kind: "package-group"
---

# product/ — 共创产品服务

[English](README.md) | 中文

## 概述

product 组包含由 Host 持有、共同组成共创桌面产品的服务。这些包通过带类型的 Cordis 服务持有账号材料、本地图记忆、自动化状态、已验证模型路由、签名技能执行和已脱敏用户错误。浏览器包只消费经过脱敏的快照与命令，不取得凭据、数据库、可执行运行时或诊断详情的所有权。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | 主要服务 |
|---|---|---|
| [`gongchuang-account/`](gongchuang-account/README.zh.md) | 服务器账号认证与脱敏个性化快照 | `ctx.gongchuangAccount` |
| [`gongchuang-graph-memory/`](gongchuang-graph-memory/README.zh.md) | 由桌面 Host 持有的分区本地图记忆 | `ctx.gongchuangGraphMemory` |
| [`gongchuang-local-automation/`](gongchuang-local-automation/README.zh.md) | 持久化本地计划、运行认领与结果会话绑定 | `ctx.gongchuangLocalAutomation` |
| [`gongchuang-model-connections/`](gongchuang-model-connections/README.zh.md) | 基于凭据的模型端点验证与目录发布 | `ctx.gongchuangModelConnections` |
| [`gongchuang-signed-skill-runtime/`](gongchuang-signed-skill-runtime/README.zh.md) | 受限执行已验签技能包声明的操作 | `ctx.gongchuangSignedSkillRuntime` |
| [`gongchuang-user-errors/`](gongchuang-user-errors/README.zh.md) | 稳定的用户诊断码与脱敏本地日志详情 | 共享格式化 API |

-----

<a id="related-documentation"></a>
## 相关文档

以下子系统页面说明这些产品服务复用的运行时契约。

- [凭据子系统参考](../../docs/subsystems/credentials.zh.md)——Host 持有的密钥解析与提供方边界。
- [存储子系统参考](../../docs/subsystems/storage.zh.md)——持久化所有权与协调写入。
- [任务子系统参考](../../docs/subsystems/jobs.zh.md)——持久后台工作与生命周期语义。
- [LLM 流式子系统参考](../../docs/subsystems/llm-streaming.zh.md)——模型适配器、目录与请求用量。
- [skill 子系统参考](../../docs/subsystems/skills.zh.md)——skill 提供方、目录与面向模型的加载。
- [工具子系统参考](../../docs/subsystems/tools.zh.md)——工具发布与调用所有权。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

产品专属状态与信任边界应保留在这些 Host 服务中。客户端包应消费带类型的快照与命令，而不是重新实现凭据、持久化或执行所有权。

</details>
