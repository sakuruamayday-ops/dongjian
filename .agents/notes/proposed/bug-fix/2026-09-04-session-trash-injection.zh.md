# Agent Note: 会话废纸篓操作的持久化服务访问

Status: proposed

[English](2026-09-04-session-trash-injection.md) | 中文

## Problem

已安装的 V0.4.4 候选删除合成归档会话时，返回 `cannot get property "sessionPersistence" without inject`。直接构造控制器的测试使用根 Context，没有覆盖 Cordis 作用域访问规则。冷会话和自有活动会话的销毁均存在同一访问错误。

## Proposal

其他接口继续允许持久化服务缺席。Host 产物删除通过 `ctx.get` 获取持久化服务，要求其在生命周期变化前存在，并保留该实例直至写入器退出。刷新、归属检查、写入器退出和可恢复废纸篓事务均不绕过。

## Alternatives considered

将持久化设为整个控制器的必需依赖会收窄无关的内存接口。捕获依赖错误后直接移动文件会绕过写入器退出，可能丢失数据。两者均无必要。

## Acceptance criteria

实际 Loader 组合覆盖冷会话和活动会话，并执行定向生命周期回归及已安装客户端的授权合成数据删除。原生通过必须同时看到归档列表移除和系统废纸篓内的可恢复产物。源码检查不等于原生验收或正式发布。

## Risks

原生测试不得删除客户数据。缺少持久化服务时，必须在刷新或销毁活动会话前拒绝产物删除。
