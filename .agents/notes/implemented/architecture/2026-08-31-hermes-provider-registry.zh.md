# Agent Note: 范围化 Hermes 提供方注册表

Status: implemented

[English](2026-08-31-hermes-provider-registry.md) | 中文

## 问题

当前产品使用五个提供方专用分支。继续为每个提供方扩展这套分支，会重复地址、凭据、协议和刷新逻辑；直接复制 Hermes 全量清单，又会超出用户已经确认的产品范围。只增加名称更不可接受：界面可能保存了密钥，实际请求却通过错误协议或地址发送。

## 决策

V0.4.0 使用一份经过审计的提供方注册表，统一驱动 Host 快照、配置界面、凭据引用、适配器画像、刷新行为和测试。可见集合严格等于产品截图确认的 35 个提供方，加一个本地/自定义端点：

Fireworks AI、OpenRouter、Anthropic、xAI、DeepSeek、MiniMax、MiniMax China、OpenCode Zen、OpenCode Go、NVIDIA NIM、Ollama Cloud、LM Studio、Xiaomi MiMo、Arcee AI、GMI Cloud、Azure Foundry、Actual Computer、Alibaba Cloud Coding Plan、CommandCode、DeepInfra、GitHub Copilot、Google AI Studio、HuggingFace、Kilo Code、Kimi Coding Plan、Kimi/Moonshot China、Meta Model API、NovitaAI、OpenAI API、Qwen Cloud、StepFun Step Plan、Tencent TokenHub、Upstage Solar、Vercel AI Gateway 和 Z.AI GLM；附加入口为本地/自定义 OpenAI 兼容端点。

Hermes 只作为已经审阅的定义来源，用于提供方标识、固定基础地址、凭据字段、协议和特殊授权语义。不复制确认清单以外的提供方。协议或授权特殊的提供方必须使用真实适配器，或者明确显示尚不可配置；不能为了让列表看起来完整而伪装成普通 API Key 连接。

现有 DeepSeek、OpenCode Go 和自定义凭据无需用户重新输入即可沿用。硅基流动和 Orgarid 从新配置界面移除，但不擦除其既有操作系统凭据。迁移必须幂等，密钥值不得进入渲染器、设置文件、日志或回执。

注册表只负责连接元数据。图片输入、推理强度、文件传输、上下文和输出上限继续来自精确的已安装适配器与模型目录。能力元数据缺失时不显示相应控件，不能从 `vision`、`reasoning` 等模型名称推断能力。

## 考虑过的替代方案

- 复制 Hermes 当前全部提供方。未采用，因为用户选择了有边界的清单，额外集成还会扩大测试和凭据范围。
- 服务和界面继续使用提供方分支。未采用，因为每个新增分支都可能在显示、密钥存储、端点探测和请求发送之间独立漂移。
- 把所有提供方都当成使用 API Key 的 OpenAI 兼容服务。未采用，因为 Anthropic Messages、Responses API、本机无密钥端点、用户提供 Azure 地址和委托授权不是同一合同。

## 后果

以后新增或修改可见提供方，需要审阅注册表和适配器，不再增加另一套产品分支。部分清单内提供方在真实授权流程完成前可以明确显示授权前置条件，这优于伪造就绪状态。移除的旧入口保留休眠凭据，便于恢复或以后由用户手动清理。

## 测试

快照测试锁定准确的 36 项可见集合和顺序。矩阵验证路由唯一性、允许协议、固定与用户填写地址、本机无密钥、特殊授权、目录降级、提供方隔离刷新、旧凭据沿用、已移除凭据保留、脱敏和精确模型能力投影。
