# Agent Note: OpenCode 会话路由标头

Status: implemented

[English](2026-09-08-opencode-session-routing.md) | 中文

## Problem

[OpenCode Go 要求稳定的会话标头](https://opencode.ai/docs/go/#where-can-i-use-it)。仅传入 pi-ai 的会话选项不能让所有支持的协议发送该标头，因此会产生 `MissingSessionID` 失败。

## Decision

具名路由通过 `catalogProvider` 选择已安装目录，不改变持久会话中的路由编号。OpenCode Go 和 Zen 复用对应的原生提供方，仅采用端点已列出且内置目录已收录的模型。API 与 URL 的 null 设置屏蔽旧组合配置的覆盖，使重启后仍保留原生逐模型协议；其他配置仍支持显式覆盖。按模型名称猜协议或统一使用 Chat Completions 会触发网关的格式拒绝。不新增协议实现。

pi-ai 适配器的公共标头入口为具名 OpenCode 路由及精确官方端点主机名发送已有会话编号。它覆盖配置中不区分大小写的同名标头，并在没有会话时省略标头。主对话、标题和压缩沿用调用方会话编号，不引入新状态或日志格式。[应用归因决策](2026-06-21-mandatory-app-attribution-headers.zh.md) 仍然适用：公开 `User-Agent` 身份与提供方专属会话路由相互独立。没有既有决策被取代。

## Alternatives considered

**静态配置。** 不采用，因为无关会话会共用一个路由身份。

**仅使用 SDK 会话选项。** 不采用，因为 completion 协议没有发送必需的网络标头。

**发送给所有提供方。** 不采用，因为无关提供方不需要额外的会话标识。

## Consequences

具名 OpenCode 路由通过配置代理时仍携带标头。不同名称且没有官方端点主机名的代理不会被识别。HTTP 捕获测试覆盖三种协议、稳定编号、不同会话、自定义端点及 Loader 组合；官方服务与安装包发布验收仍使用独立证据。
