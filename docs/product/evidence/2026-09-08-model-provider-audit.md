# V0.4.7 模型接口核对

核对日期：2026-09-08。范围为模型设置列表、模型目录请求、实际 SDK 请求组装与重启恢复。用户确认移除 GitHub Copilot，其余未配置提供方接受官方文档核对，不要求补充 API Key。本文不宣称所有账号、模型、推理强度、工具调用和图片请求均已真实验证。

## 已确认修复

| 编号 | 缺陷与修复 | 可复现验证 |
| --- | --- | --- |
| FIX-0908-01 | OpenCode Go 仅传 SDK sessionId，部分协议没有实际生成 x-opencode-session；公共请求出口按当前会话补齐，配置中的旧静态值不能覆盖 | [适配器请求捕获](../../../packages/llm/llm-pi-ai/tests/adapter.spec.ts)、[真实 Loader 组合](../../../packages/llm/llm-pi-ai/tests/loader-composition.spec.ts) |
| FIX-0908-02 | Anthropic 保存 /v1 根地址，SDK 再追加 /v1/messages；推理时规范化末尾版本段，保留网关路径，旧配置无需重填 | 同上适配器测试，API 根地址、末尾 /v1、斜杠及 /anthropic 前缀 |
| FIX-0908-03 | MiniMax 两区域的模型发现缺少 /v1；改为 /anthropic/v1/models | [提供方请求矩阵](../../../packages/product/gongchuang-model-connections/tests/model-connections.spec.ts) |
| FIX-0908-04 | Kimi Coding 订阅密钥被送到普通 Moonshot 地址；配置、刷新和重启统一识别 sk-kimi- 前缀并选择 Coding 地址 | 同上 Kimi 配置、刷新、重启用例；普通密钥保持 Moonshot 地址 |
| FIX-0908-05 | 删除 GitHub Copilot 列表与失效的配置分支，保留历史凭据不擅自清除 | [注册表测试](../../../packages/product/gongchuang-model-connections/tests/provider-registry.spec.ts) |
| FIX-0908-06 | Go 和 Zen 用一种协议覆盖所有模型；按底座内置目录复用各模型原生协议与地址，保持已存会话路由不变；显式清除旧协议与地址覆盖 | 提供方测试覆盖 Claude、GPT、Gemini、MiniMax、DeepSeek 四种协议，旧配置替换、刷新和重启；未知新模型不猜协议 |

## 官方来源

以下记录本轮读取的官方接口说明；“匹配”仅指文档中的地址、协议及基础鉴权与实现相符。区域和套餐密钥不能混用；未公开完整模型目录的端点仍需手工模型 ID，保留候选状态而不伪造推理通过。

| 提供方 | 官方来源与结论 |
| --- | --- |
| Fireworks AI | [OpenAI compatibility](https://docs.fireworks.ai/tools-sdks/openai-compatibility)：inference/v1、Chat Completions，匹配 |
| OpenRouter | [Quickstart](https://openrouter.ai/docs/quickstart)：api/v1、Bearer、Chat Completions，匹配 |
| Anthropic | [Models](https://platform.claude.com/docs/en/api/models/list)：原生 /v1/models、X-Api-Key；已修复推理路径重复 |
| xAI | [Chat API](https://docs.x.ai/developers/rest-api-reference/inference/chat)：/v1/chat/completions 仍受支持，匹配 |
| DeepSeek | [首次调用](https://api-docs.deepseek.com/)：api.deepseek.com、Bearer、Chat Completions，匹配 |
| MiniMax、MiniMax China | [模型目录](https://platform.minimax.io/docs/api-reference/models/anthropic/list-models)、[区域配置](https://platform.minimax.io/docs/token-plan/claude-code)：原生 Anthropic 协议；两区域目录路径已修复 |
| OpenCode Zen | [官方接口表](https://opencode.ai/docs/zen/)、[官方请求处理器](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/util/handler.ts)：模型存在不同协议，不能统一覆盖；已修复 |
| OpenCode Go | [接入要求及模型接口表](https://opencode.ai/docs/go/#where-can-i-use-it)：要求真实客户端 User-Agent、稳定会话头和逐模型协议；已修复，不伪装其他客户端 |
| NVIDIA NIM | [LLM APIs](https://docs.api.nvidia.com/nim/reference/llm-apis)：integrate.api.nvidia.com/v1/chat/completions，匹配 |
| Ollama Cloud | [官方集成](https://docs.ollama.com/integrations/droid)：ollama.com/v1 配合云端密钥，匹配 |
| LM Studio | [OpenAI endpoints](https://lmstudio.ai/docs/developer/openai-compat)：本机 1234/v1、模型目录和 Chat Completions，匹配 |
| Xiaomi MiMo | [Models](https://mimo.mi.com/docs/en-US/api/model/list-models)、[OpenAI API](https://mimo.mi.com/docs/en-US/api/chat/openai-api)：当前支持 /v1/models 和 Bearer；不采用 Hermes 旧注释的跳过目录做法 |
| Arcee AI | [Quick Start](https://docs.arcee.ai/)：api.arcee.ai/api/v1、Bearer，匹配 |
| GMI Cloud | [LLM API](https://docs.gmicloud.ai/inference-engine/api-reference/llm-api-reference)：/v1/models 与 /v1/chat/completions、Bearer，匹配 |
| Azure Foundry | [OpenAI v1](https://learn.microsoft.com/en-us/azure/foundry/openai/latest)：用户须填写自己资源的 /openai/v1 地址及部署模型名；不承诺任意 Azure 产品端点通用 |
| Actual Computer | [官方机器可读说明](https://actual.inc/llms.txt)：支持 Chat Completions，本机端点无需逐请求鉴权，托管中继需 ac_ 密钥；现有协议保留 |
| Alibaba Cloud Coding Plan | [Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan)：国际订阅专用地址和 sk-sp- 密钥，匹配 |
| CommandCode | [Provider API](https://commandcode.ai/docs/provider)：provider/v1/chat/completions，匹配 |
| DeepInfra | [API reference](https://docs.deepinfra.com/api-reference/introduction)：v1/openai、Bearer，匹配 |
| Google AI Studio | [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)：v1beta/openai，匹配 |
| HuggingFace | [官方 Chat UI](https://huggingface.co/docs/chat-ui/en/installation/local)：router.huggingface.co/v1、自动模型发现，匹配 |
| Kilo Code | [Gateway](https://kilo.ai/docs/gateway)：api.kilo.ai/api/gateway、OpenAI 兼容，匹配 |
| Kimi Coding、Moonshot 国际与中国 | [Coding 文档](https://www.kimi.com/code/docs/en/)、[国际](https://platform.moonshot.ai/docs/intro)、[中国](https://platform.moonshot.cn/docs/intro)：分别使用 Coding、moonshot.ai、moonshot.cn；前缀识别参考 [Hermes 官方实现](https://github.com/NousResearch/hermes-agent/blob/main/plugins/model-providers/kimi-coding/__init__.py) |
| Meta Model API | [官方 Responses 示例](https://github.com/meta-models/meta-model-cookbook/blob/main/01_api_fundamentals/10_search_grounding.ipynb)使用 api.meta.ai/v1、OpenAI SDK 及 responses.create，基础地址、协议与鉴权匹配；门户详情需登录，未覆盖账户权限和全部高级能力 |
| NovitaAI | [模型接口](https://novita.ai/docs/api-reference/model-apis-llm-retrieve-model)：openai/v1，匹配 |
| OpenAI API | [官方调用示例](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)：/v1/responses、Bearer，与已安装 SDK 请求组装一致 |
| Qwen Cloud | [区域地址](https://www.alibabacloud.com/help/en/model-studio/base-url)：国际共享域仍可用；中国区和专属工作区可使用自定义端点 |
| StepFun Step Plan | [国际 Step Plan](https://platform.stepfun.ai/docs/en/step-plan/integrations/reasoning-api)：api.stepfun.ai/step_plan/v1，匹配；中国站 .com 是另一地区 |
| Tencent TokenHub | [语言模型调用](https://cloud.tencent.com/document/product/1823/130079)：境内 tokenhub.tencentmaas.com/v1、Bearer、Chat Completions，匹配 |
| Upstage Solar | [官方示例](https://console.upstage.ai/api-keys)：api.upstage.ai/v1、OpenAI Chat Completions，匹配 |
| Vercel AI Gateway | [SDKs & APIs](https://vercel.com/docs/ai-gateway/sdks-and-apis)：ai-gateway.vercel.sh/v1，匹配 |
| Z.AI | [API introduction](https://docs.z.ai/api-reference/introduction)：当前入口为普通 API；Coding Plan 使用独立地址，可通过自定义端点配置 |
| 本地 / 自定义端点 | 由用户实际服务决定，支持三种既有协议；HTTPS 与本机 HTTP 限制、错误密钥、不可达端点和候选模型回归保持 |

## 发布状态

V0.4.7 已正式发布。2026-09-08 03:55:30 UTC 完成服务器事务，03:56:40 UTC 公开更新源整包回读通过；current/release_id=24，previous 为 V0.4.6/release_id=23，制品 ID 70、71、72。[正式事务](/Users/zsh/JiaotangData/release-candidates/gongchuang-client-v0.4.7/70c732c813-desktop-release/server-release-receipt.json)、[公网整包、签名、大小与 Range 验证](/Users/zsh/JiaotangData/release-candidates/gongchuang-client-v0.4.7/70c732c813-desktop-release/public-update-source-acceptance.json)。Mac 两架构 DMG/ZIP 和 Windows 安装包均已回读；GitHub 不发布安装包，受控门户仍为唯一客户端分发入口。旧 V0.4.5 制品移入服务器回收区，历史审计记录保留。后续文档与生产基线回填不改变已签名制品。

上游发布审阅：dsh-v0.1.3-alpha.2 于 2026-09-07 发布，标记为已审阅 `82a5fd61a7cf5c293cec4bdff68f455398d685e9`，并非已采用。核对官方发布说明及本次有关的 llm-pi-ai 差异，新的 adapter 只增加流转换的 model.id 参数，没有替代本次会话头修复。该版还更换 pi-ai 0.85.1、persona 前后缀及进程管理接口，完整迁移需要对应消费者和平台验证，不能混入此次接口热修版本并宣称通过。V0.4.7 继续采用 `d347e703908d0406b7a7ef80e3a0e594d86b2215`，后续升级仍按官方优先原则实施；本次未执行完整 alpha.2 迁移验收。[官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2)。

验证过程：首轮制品源码 `5123bbfc5ab5617177eebca96fa763a2a3b33430` 完成验证后，补充版本一致性测试发现内部产品外壳 package.json 遗留 V0.4.5，修正为 V0.4.7，并修正测试中的旧生产基线。6 项版本一致性测试通过，最终制品源码为 `70c732c813ade57958b7637bfc6a5539d9d132bf`；三端已重建，最终包、ARM 生命周期与真实模型重启验收均对新包重新通过，旧候选未发布。技能 V1.6.19 和 dsh 0.1.3-alpha.1 不变。

| 验证范围 | 结果与证据 |
| --- | --- |
| 接口与共享消费者 | 18 文件共 537 项通过；初次组合运行有一处状态文案变量错误，修正后该文件全部 75 项通过，不与前次重复累计。[组合日志](/Users/zsh/JiaotangData/release-candidates/gongchuang-client-v0.4.7/70c732c813-desktop-release/evidence/release-identity-tests.log)、[修正后日志](/Users/zsh/JiaotangData/release-candidates/gongchuang-client-v0.4.7/70c732c813-desktop-release/evidence/model-connections-tests.log) |
| 模型 UI 与文档 | 模型配置、切换与刷新 27 项通过；文档检查 33 项通过，上游审阅配置 8 项通过；类型检查及完整 Host/Client 构建通过。[UI 日志](/Users/zsh/JiaotangData/release-candidates/gongchuang-client-v0.4.7/70c732c813-desktop-release/evidence/provider-ui.log) |
| 最终安装包 | Mac arm64/x64 签名和载荷、DMG/ZIP 一致性通过；Windows x64 静态检查通过；Mac ARM 隔离安装、损坏拒绝、恢复和重装 13 阶段通过。[汇总](/Users/zsh/JiaotangData/release-candidates/gongchuang-client-v0.4.7/70c732c813-desktop-release/evidence/prepublish-acceptance-summary.json) |
| 真实 OpenCode Go | 最终 ARM 包从真实模型菜单选择 DeepSeek V4 Flash Vision Exp，首次启动与退出重启后均通过普通对话返回唯一测试文本，账号、提供方及模型保持。没有用目录请求或直接 API 调用代替客户端推理。[真实回执](/Users/zsh/JiaotangData/release-candidates/gongchuang-client-v0.4.7/70c732c813-desktop-release/evidence/real-model-acceptance-final.json) |

真实验收脚本原只复制 v1 密文且只识别 `session.jsonl`，不兼容当前 v2 钥匙串迁移记录和 `session.v2.jsonl.zstd`。修正隔离测试准备和文件发现后完整复测通过；保留前两次失败回执，不把测试夹具故障误报为正式客户端故障。脚本未读取、导出明文密钥，测试空间已移入系统废纸篓。

远程 [CI 34184702291](https://github.com/sakuruamayday-ops/gongchuang-enterprise-assistant/actions/runs/34184702291) 因 GitHub 账户计费限制未启动，步骤为空，不记为测试通过。平台原生复测范围沿用已确认豁免，不重新加入已免除的 Gatekeeper 重复验收；Windows 未签名风险接受范围不变。
