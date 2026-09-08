---
description: "共创桌面客户端的脱敏用户错误目录与诊断格式化器。"
kind: "package-reference"
---

# @gongchuang/user-errors

[English](README.md) | 中文

## 概述

共创桌面宿主、账号与模型服务、产品界面共用的错误呈现模块。用户可见失败会归入一组受控中文提示和诊断码；返回值不会复制上游异常原文、堆栈、原因链、本机路径或凭据。

## 目录

- [行为](#behavior)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="behavior"></a>
## 行为

`gongchuangDiagnostic` 仅供现有可信本地日志使用。它保留排障所需的异常结构，同时脱敏常见 API Key、授权值、含密钥的查询字段，以及 macOS、Linux 或 Windows 用户路径。

<a id="dev-note"></a>
## 开发备注

调用方选择稳定诊断码，并只在现有可信本地日志路径保留完整技术细节。

<a id="runtime-invariant"></a>
## 运行时不变式

不发布运行时不变式伴随入口，因为本包只执行纯错误分类与脱敏，不持有可变状态或事件。

<a id="model-experience"></a>
## 模型体验

### 已脱敏的用户错误

#### 模型看到的内容

无。`gongchuangDiagnostic` 格式化器仅为宿主、可信本地日志和产品界面归类并脱敏错误，不注册模型上下文或工具。

#### Token 影响

无。错误呈现和诊断日志不会产生模型请求。

#### KV 缓存影响

无。错误呈现和诊断日志不会改变模型请求或会话历史。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 分类有意采用保守策略。未知失败仅显示所属界面的恢复建议和诊断码；技术定位需要支持人员查看已脱敏的本地日志。
