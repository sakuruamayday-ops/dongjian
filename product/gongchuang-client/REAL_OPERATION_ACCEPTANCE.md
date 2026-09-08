# 共创企业助手 V0.1 真实可操作验收矩阵

本矩阵是 Windows/macOS 客户端测试安装包生成前的阻断清单。客户端版本固定为 V0.1；随两端客户端分发的是同一份 V1.6.6 通用技能包，不存在 Windows 版或 macOS 版技能包。

## 判定规则

- `AUTO-PASS`：代码、类型、构建或自动化测试通过，但还不能单独证明用户可用。
- `LIVE-PASS`：在真实客户端中由界面完成配置、执行、持久化与失败恢复，并留有脱敏回执或截图。
- `DEVICE-PASS`：在目标操作系统真实设备上完成安装生命周期验收。
- `BLOCKED`：缺少服务、凭据、设备或实现，阻止生成测试安装包。
- `PENDING`：尚未执行。A 至 I 任一核心项为 `BLOCKED` 或 `PENDING` 时，禁止构建内部设备测试候选；J 未全部通过时，禁止把安装包作为交付物输出。

每个功能必须同时满足：入口可见、操作可完成、结果可核验、错误可处理、重启后状态正确、敏感信息不出现在页面/日志/回执中。

## A. 账号、凭据与单设备登录

| ID | 用户操作与验收结果 | 自动化 | 真实操作 | 阻断说明 |
|---|---|---:|---:|---|
| A01 | 账号密码登录成功，返回当前用户且不是“资源不存在” | AUTO-PASS（本地服务与 6 项账号回归） | LIVE-PARTIAL（隔离 HTTPS 通过；生产 404） | 与最终客户端相同的账号插件已对正式服务器工作树完成真实 HTTPS 登录、回执校验与重启恢复；打包配置实际指向 `https://zshjiaotang.cn`，2026-08-17 对其 `/v1/client-login` 的无效账号探针真实返回 HTTP 404“资源不存在”，说明生产路由尚未部署。macOS 新候选会把该状态转译为“共创服务器尚未开放客户端登录接口”，不直接暴露原始错误 |
| A02 | 错误账号、错误密码、缺失账号均返回统一安全提示 | AUTO-PASS（本地服务） | LIVE-PASS（隔离 HTTPS） | 错误密码通过真实 HTTPS 返回统一“用户名称或密码错误”，且未写入用户名、密码或令牌；生产部署后仍需做一次线上复核 |
| A03 | 勾选保存后密码只进 macOS 钥匙串/Windows 凭据管理器，重启自动登录 | AUTO-PASS | LIVE-PARTIAL（隔离凭据提供器重启） | 保存密码后的令牌验证与自动恢复已通过，渲染状态不含密码或令牌；真实共创账号写入 macOS 钥匙串和 Windows 凭据管理器仍分别受生产部署与 J03 约束 |
| A04 | 同一账号在第二台设备登录后，第一台令牌立即失效并可重新登录 | AUTO-PASS（本地服务） | LIVE-PASS（隔离 HTTPS 双设备） | 第二设备登录后，第一设备下一次验证立即收到 superseded、删除旧令牌并阻止自动抢回；手动使用已保存密码可以重新取得唯一设备资格 |
| A05 | 退出登录清除会话令牌；选择不保存时不保留密码 | AUTO-PASS | LIVE-PASS（隔离 HTTPS） | 已分别验证“退出但保留已保存密码”“重启后不自动登录”“手动重新登录”及“退出并清除全部登录信息”；稳定设备身份保留，账号、密码和令牌清除 |
| A06 | 过期、撤销、设备不匹配、断网均有可理解提示和重试路径 | AUTO-PASS（部分） | LIVE-PASS（隔离 HTTPS 核心异常链） | 过期令牌会清除后用已保存密码重新验证；另一设备登录会进入 superseded；断网进入 offline、保留本机状态且不伪报在线。账号脱敏回执 `/Users/zsh/JiaotangData/client-candidates/acceptance/account-live-20260816-2310/account-live-receipt.json`，SHA-256 `73ac1a17bec2c98316a33c674a41069dbadb520b750ea38cfb065d0a0ac017a0` |
| A07 | 服务器下载页记录下载事件；管理端成员列表可查看下载与客户端登录状态 | AUTO-PASS（正式服务器工作树，门户 111 passed、5 skipped） | LIVE-PARTIAL（隔离真实产物通过；生产未部署） | 下载页真实列出当前 macOS DMG 与 Windows EXE；macOS Range 下载返回 206、完整大小与候选 SHA-256；随后管理端成员页同时显示“已请求下载”“已登录客户端”和 V0.1.0。回执 `/Users/zsh/JiaotangData/client-candidates/acceptance/download-live-20260816-2330/download-live-receipt.json`，SHA-256 `a6d97f10604be50d0e5b59eef95c7cbb59d64cd289ecb4ebd21fe2f2b795cd94`；2026-08-17 打包域名 `https://zshjiaotang.cn/downloads` 真实返回 HTTP 404，生产下载页仍待部署 |

## B. 模型与会话

| ID | 用户操作与验收结果 | 自动化 | 真实操作 | 阻断说明 |
|---|---|---:|---:|---|
| B01 | DeepSeek 填入密钥后真实验证、保存、切换模型并完成流式对话 | AUTO-PASS（模拟服务） | LIVE-PASS（macOS，原生 DeepSeek Flash 真实对话与增强预设均通过） | 最终候选在无环境变量启动时仍能由加密凭据存储恢复；回执 `/Users/zsh/JiaotangData/client-candidates/acceptance/model-flash-restart-20260816-0313.json`，SHA-256 `24ad60c3d87b66a36ede227e7a9b62ec8a0600b512d7c98581026b475c2fca2a` |
| B02 | OpenCode Go 填入密钥后不再出现 `OPENCODE_API_KEY` 缺失并完成真实对话 | AUTO-PASS（模拟服务） | LIVE-PASS（macOS） | 真实密钥经系统安全存储写入后完成 DeepSeek V4 Flash / Max 对话；退出并从新打包目录启动后仍可恢复，未再出现环境变量缺失。2026-08-17 机械刷新自动目录前的候选 `d3fc3610…` 再次真实请求并在 8 秒内返回指定中文结果，用量栏同步显示本轮、会话、缓存与估算花费；目录刷新未修改模型实现，刷新后的 Cordis 与产品界面定向回归 187 项通过 |
| B03 | 自定义 OpenAI 兼容 API 可配置地址、密钥、模型并完成对话 | AUTO-PASS（模拟服务） | LIVE-PASS（macOS） | 已用真实 OpenAI Chat Completions 兼容端点完成配置、对话、退出和无环境变量重启恢复；宿主、侧栏和模型选择器一致为 `custom-api/deepseek-v4-flash` |
| B04 | 三路模型来回切换不串用凭据，坏密钥不覆盖原可用配置 | AUTO-PASS | LIVE-PASS（macOS 真实三路 + 隔离故障注入） | 原生 DeepSeek、自定义 API 与 OpenCode Go 均已分别完成真实对话并跨重启恢复；另以真实本机 HTTP 模型服务完成有效目录发现、流式对话、错误密钥 401、旧凭据与旧路由保留、断网不伪绿及无须重填密钥的恢复。脱敏回执 `/Users/zsh/JiaotangData/client-candidates/acceptance/model-live-20260816-2255/model-live-fault-receipt.json`，SHA-256 `54f246dd94b1254cbd22244cfd410612c6ff264685a26fe97316cd09b31cfad7` |
| B05 | 运行错误正文与错误代码均可一键复制，不泄露密钥 | AUTO-PASS（组件复制精确值） | LIVE-PASS（macOS） | 实测可复制 `SEARCH_SCOPE_TOO_BROAD` 与界面实际错误正文；Windows 剪贴板仍计入 J03 |
| B06 | 输入框上方用量栏始终单行，显示本轮/会话/缓存/花费/今日，不显示模型与推理等级 | AUTO-PASS | LIVE-PASS（macOS） | 最终打包候选已在 1024×700、1280×720、1440×900 和 1920×1080 验证单行“本轮/会话/缓存/花费约/今日约”；未混入模型或推理等级，无横向溢出，证据与 I05 共用 `output/playwright/gongchuang-v01/visual-matrix/` |
| B07 | 官方价格估算标记为估算；缓存只使用提供商真实返回值，不虚构命中 | AUTO-PASS | LIVE-PASS（macOS） | DeepSeek 与 OpenCode Go 真实回执均展示提供商返回的缓存值，金额以“约”标记；自定义 API 未配置定价时明确显示“未配置定价”而不伪算 |
| B08 | 会话新建、重命名、切换、重启恢复、停止生成、重试均可用 | AUTO-PASS（基础 DSH） | LIVE-PASS（macOS） | 共创产品壳已实测新建、切换、跨重启恢复和停止生成；企业空间总览提供会话重命名，模型请求失败会自动重试并在黄金报告任务中实际出现 `2/2` 后恢复，记录均保留在原会话 |
| B09 | 首次安装默认选择 OpenCode Go 的 DeepSeek V4 Flash，推理等级为 Max；历史会话保留用户原选择 | AUTO-PASS（Host admission） | LIVE-PASS（macOS 隔离首次启动 + 最终包切换回归） | 在全新、0700 权限且无凭据存储的隔离用户数据中完成首次城市选择并创建企业空间后，提供方实际为 `OpenCode Go`，模型按钮实际显示 `DeepSeek V4 Flash / Max`；旧验收会话中的 `High` 仅属于既有会话持久化状态，不覆盖首次安装默认值。最终 `app.asar` 候选又实测从 OpenCode Go 切到原生 DeepSeek、再切回 OpenCode Go，推理等级保持 `Max` 而不回落到 `Default`，并用同一真实包返回指定响应。最终回执 `/Users/zsh/JiaotangData/client-candidates/acceptance/dogfood-final-20260817-0600/opencode-provider-max-receipt.json`，SHA-256 `b730f0b3b700fe79261494a5ce3a443d5199cf34b20cf191369401a0784e8c59` |

## C. 图片、附件与 OCR

| ID | 用户操作与验收结果 | 自动化 | 真实操作 | 阻断说明 |
|---|---|---:|---:|---|
| C01 | DeepSeek 收到图片时明确走 OCR，不把文本模型伪装成视觉模型 | AUTO-PASS | LIVE-PASS（macOS） | OpenCode Go 的 DeepSeek V4 Flash 真实图片会话先由宿主调用 PaddleOCR，再把带来源与哈希的识别结果注入模型；界面未把文本模型标成视觉模型 |
| C02 | PaddleOCR 未连接时给出连接入口；连接后能识别图片/PDF并把结构化结果送入会话 | AUTO-PASS（适配层） | LIVE-PASS（macOS） | 官方 PaddleOCR MCP 0.8.5 已完成图片和扫描 PDF 实测；扫描 PDF 先返回 `needs_ocr`，随后识别出标题、验收标记、企业名称和 2468 万元，并以工具回执 ID 绑定专业校验。截图 `output/playwright/gongchuang-v01/scanned-pdf-ocr-structured-evidence-pass.jpeg` |
| C03 | OCR 失败、超时、空结果、页数过大均有可操作错误，不静默猜测 | AUTO-PASS（空文件、无效 PDF、24MB 超限、越界路径与符号链接） | LIVE-PASS（macOS 核心恢复链） | 实机停用 OCR 后错误正文、代码与原因常驻且可复制，重连后恢复；空结果、无效 PDF、超大 PDF 和目录逃逸均由预检失败关闭，不进入模型猜测 |
| C04 | DOCX/XLSX/PDF/TXT 附件能读取或明确说明不支持，输出文件能打开 | AUTO-PASS | LIVE-PASS（macOS） | 同一打包客户端已实际导入并读取 DOCX、XLSX、文本 PDF、TXT 及扫描 PDF。最新 DOCX 实机验收先因证据值未与来源逐字绑定而被门禁拒绝，随后基于同一签名回执精简证据并通过，准确返回企业名称、申报方向和验收标记；回执见 `acceptance/document-live-20260816-2307/document-live-receipt.json` |

## D. 技能中心

| ID | 用户操作与验收结果 | 自动化 | 真实操作 | 阻断说明 |
|---|---|---:|---:|---|
| D01 | “技能市场/已安装技能”分开，安装后的卡片不消失并显示“已安装” | AUTO-PASS | LIVE-PASS（macOS） | 隔离实机确认两个独立页面；顶部分类卡仅保留标题与数量；50 项内置技能加 2 项社区技能在重启后仍为 52 项，市场卡保留并显示“已安装” |
| D02 | 共创精选、魔搭、腾讯 SkillHub、第三方仓库四入口同级，点击即切换目录 | AUTO-PASS | LIVE-PASS（macOS） | 实机确认四入口同级、仅保留标题与状态且可切换；第三方仓库新增与安装链仍分别计入 D05/D07 |
| D03 | 魔搭与 SkillHub 实时检索、分页、详情、安装均可用，失败可重试 | AUTO-PASS（接口与 UI） | LIVE-PASS（macOS） | 已从魔搭安装 `handsomestWei/patent-disclosure-skill`、从 SkillHub 安装 `@user_9c63fdb4/patent-drafting-cn`；详情、安装状态、SkillHub 第 2/6377 页与重启持久化均通过 |
| D04 | 共创精选可多页并按业务价值轮换，不固定七个；已安装项自动标记 | AUTO-PASS（UI 与目录策略） | LIVE-PASS（macOS） | 实机显示 13 项业务精选，支持分页和按当前目录轮换；已安装项自动标记，不再固定七张卡 |
| D05 | 第三方 HTTPS 仓库可添加、检索、查看详情、安装；非法清单和摘要不匹配失败关闭 | AUTO-PASS | LIVE-PASS（macOS） | 打包客户端已真实验证公网 HTTPS 清单添加、仓库技能详情和 DNS 解析至回环地址时失败关闭。2026-08-17 最终 `app.asar` 候选又在隔离用户目录添加公开 HTTPS 测试仓库，实际下载公网内容后因清单 SHA-256 与下载内容不一致明确拒绝；已安装页仍为 50 项，社区安装注册表仍为 0。回执 `/Users/zsh/JiaotangData/client-candidates/acceptance/skill-digest-mismatch-live-20260817/receipt.json`，SHA-256 `a97cebad71a6eec3dac0fe46e91a242c9ce8dfdfd59cf5999691e5bcf09ea57c`；隔离数据已移入废纸篓，可恢复 |
| D06 | 需要第三方账号或工具的技能点击添加后打开官方授权/配置页，成功验证后才标记可用 | AUTO-PASS（导航） | LIVE-PARTIAL（macOS） | 已安装 PatSeek 详情可重新打开经审查的 `https://patseek.cn/`，Safari 真实加载厂商 HTTPS 页面且未误跳 SkillHub；打开页面不会虚假标记工具可用。凭据授权和工具就绪仍需对应连接器支持后逐项验收，证据见 `acceptance/skill-config-live-20260817-001130/skill-configuration-navigation-receipt.json`，SHA-256 `18c711d5d381cc8e20233afcf41b8f9b54fe2efd8e6fada42d75a1ea71ea9ea4` |
| D07 | 技能安装后卡片不移除并显示“已安装”，重启后状态保持；V1.6.6 内置技能不可被普通市场覆盖 | AUTO-PASS（安装持久化、摘要失败关闭、内置保护） | LIVE-PASS（macOS） | 魔搭与 SkillHub 两项社区技能安装后仍留在原市场并显示“已安装”，重启后保持 52 项；内置 50 项继续使用签名来源，市场不能覆盖 |

## E. MCP 与外部连接

| ID | 用户操作与验收结果 | 自动化 | 真实操作 | 阻断说明 |
|---|---|---:|---:|---|
| E01 | 企查查从官方页面取得凭据，粘贴后真实连接并至少发现一个工具才显示已就绪 | AUTO-PASS（模拟服务） | LIVE-PASS（macOS） | 真实连接 9/10 个官方 MCP 服务并发现 169 个工具，企业登记信息查询成功；`history` 因当前账号权限不可用且界面明确显示部分可用 |
| E02 | 天眼查从官方页面取得凭据，粘贴后真实最小查询成功才显示已就绪 | AUTO-PASS（模拟服务） | LIVE-PASS（macOS） | 已改用天眼查官方远程 MCP，发现 17 个入口工具并完成企业搜索；能力目录可继续下钻 162 项业务能力 |
| E03 | 粘贴原始 Token、Bearer、Authorization 或平台包装格式时能规范化；坏凭据不覆盖旧凭据 | AUTO-PASS | LIVE-PASS（macOS 真实凭据 + 隔离故障注入） | 实际复制的天眼查原始 Token、企查查 Bearer 与 Paddle Access Token 均成功规范化、加密保存并跨重启恢复；另以真实 Streamable HTTP MCP 完成有效连接、`initialize`、`tools/list`、`tools/call`、错误候选拒绝、旧凭据与旧工具挂载自动恢复。脱敏回执 `/Users/zsh/JiaotangData/client-candidates/acceptance/mcp-live-20260816-2257/mcp-live-fault-receipt.json`，SHA-256 `cfcddb136d64ff7c633759e42301088bd68e8b4daa9db8eefe2a94aec892f5e0` |
| E04 | MCP 详情展示实际验证方法、最近验证时间、工具列表、数据边界和部分可用状态 | AUTO-PASS | LIVE-PASS（macOS） | 详情页按真实发现结果展示工具数、验证状态、数据去向和企查查 `history` 不可用，不以全绿掩盖部分能力缺失 |
| E05 | PaddleOCR 和共创联网检索 MCP 均能从详情查看具体工具、用途与连接状态 | AUTO-PASS（详情 UI） | LIVE-PASS（macOS） | 联网检索发现 3 个工具；PaddleOCR 发现 1 个官方工具，并明确提示图片或扫描 PDF 将上传百度 AI Studio。真实 OCR 调用见 C01/C02 |
| E06 | 重启、网络中断、令牌失效后状态不伪绿，刷新可恢复 | AUTO-PASS（部分） | LIVE-PARTIAL（macOS） | OpenCode Go、企查查、天眼查与 Paddle 凭据均跨进程重启恢复；Paddle 实测停用后不伪绿、重新授权后恢复。真实断网与令牌过期仍待验 |

## F. 联网检索

| ID | 用户操作与验收结果 | 自动化 | 真实操作 | 阻断说明 |
|---|---|---:|---:|---|
| F01 | `web_search` 能返回查询结果，`web_fetch` 能读取允许的网页 | AUTO-PASS（适配层与签名预算回归） | LIVE-PASS（macOS） | 打包客户端已通过共创证据检索发现浙江省经信厅 2026 年通知，再由 `web_fetch` 读取官方原文并完成专业校验；最终链接中文标点边界已在打包后复核 |
| F02 | 联网检索不显示独立入口或页面；共创联网检索 MCP 在 MCP 详情中展示实际工具，专业任务按需调用 | AUTO-PASS | LIVE-PASS（macOS） | 新候选侧栏仅保留新对话、企业空间、技能中心、MCP 与自动化；联网检索无独立入口，共创联网检索详情实际发现 3 个工具 |
| F03 | 政策任务优先本地知识库/官方来源并保留链接与时间，不把“未命中”说成“不存在” | AUTO-PASS（规则） | LIVE-PASS（macOS） | 真实样例保留通知标题、页面发布日期、正文落款、发布机关与官方链接，并按省级通知明确杭州、绍兴、金华、宁波共享；未命中口径由签名门禁固定 |
| F04 | 超时、403、robots、非文本、恶意跳转、内网地址均安全失败且可解释 | AUTO-PASS（网络策略与外链矩阵） | LIVE-PASS（macOS 核心路径） | 公网 HTTPS 官方原文可读取；localhost、内网地址、凭据 URL、非标准端口与解析到回环地址均失败关闭，动态页按受控路径降级 |

## G. 自动化任务

| ID | 用户操作与验收结果 | 自动化 | 真实操作 | 阻断说明 |
|---|---|---:|---:|---|
| G01 | 可新建任务，可在主会话确认后创建，也可在自动化页面用中文一句话或手动方式设置首次执行时间、预设周期、5 分钟至 365 天自定义间隔与完整提示词 | AUTO-PASS | LIVE-PASS（macOS） | 新目录包已实测一句话“每隔 90 分钟”识别、手动首次时间、自定义 120 分钟、保存启用与重启保留；主会话确认卡由自动化回归覆盖，Windows 待 J03 |
| G02 | 可查看详情、编辑、暂停、恢复、立即运行、查看最近 20 次记录 | AUTO-PASS | LIVE-PASS（macOS） | 已实测详情、编辑、立即运行、停用、恢复、最近记录及“打开结果会话”；新候选真实等待模型终态后才显示“已完成”，旧版仅派发记录保持“已提交”；Windows 待 J03 |
| G03 | 到点后在所选企业空间创建正常会话并执行，不发送云端任务 | AUTO-PASS（调度/接线） | LIVE-PASS（macOS） | 20:40:00 准点认领并在绑定企业空间创建普通本机会话，完成后生成可打开结果回执，下次推进至次日 08:40；Windows 待 J03 |
| G04 | 暂停后不运行，恢复后沿原计划推进；重启后计划与历史保留且不重复执行 | AUTO-PASS | LIVE-PASS（macOS） | 退出并重启候选后任务仍为 1 项、20:40 计划回执仍在、下次仍为 08:40 且未重复；随后停用并恢复，原计划未漂移；Windows 待 J03 |
| G05 | 自动任务同样经过专业规则门禁，失败有记录、可重试，不绕过用户权限 | AUTO-PASS（12 项定向回归） | LIVE-PASS（macOS） | 打包客户端已真实运行锁定 `high-tech-enterprise-preassessment` 的自动任务：V1.6.6 专业执行链与受信任证据上下文均由宿主注入；主动中断后立即显示“失败”，最近运行持久化为失败并恢复“立即运行”，不再把中间助手步骤误记为完成。脱敏回执 `/Users/zsh/JiaotangData/client-candidates/acceptance/automation-professional-live-20260817/receipt.json`，SHA-256 `5e2a8e46d2ff243341b894403f9544bed48228214ba7888b565f1ed9e681a584`；Windows 待 J03 |

## H. 企业空间与专业规则门禁

| ID | 用户操作与验收结果 | 自动化 | 真实操作 | 阻断说明 |
|---|---|---:|---:|---|
| H01 | 创建、切换、重命名、归档企业空间；不同企业资料和会话严格隔离 | AUTO-PASS | LIVE-PASS（macOS） | 实机创建 A/B 两个具体企业目录：B 仅有自己的 1 条初始会话且暂无模型回执，A 保持 8 条会话与独立缓存回执；A 重命名后侧栏和主界面同步，B 归档后列表移除但本机目录保留，重启后名称、会话与归档状态均保持；Windows 待 J03 |
| H02 | 同一企业复用稳定上下文，只有模型真实返回 `cacheReadTokens` 才显示缓存命中 | AUTO-PASS | LIVE-PASS（macOS） | 同一企业同一会话连续追问时，OpenCode Go 真实回执先显示 `缓存 151K（100%）`，下一轮显示 `缓存 151K（66%）`；数值来自提供商 `cacheReadTokens`，未返回时客户端不会自行补造 |
| H03 | 找同行、评分、体检、出报告均调用锁定的 V1.6.6 技能与规则版本 | AUTO-PASS（路由/签名） | LIVE-PASS（macOS） | 找同行、评分、体检已通过专业黄金样例；本轮出报告以 OpenCode Go / DeepSeek V4 Flash / Max 生成 16 页 PDF，专业正文、证据、可打开性、正文一致性、品牌水印与逐页视觉全部通过；回执 `acceptance/professional-golden-live-20260816.json` |
| H04 | 首轮请求、工具调用、MCP、第三方技能、自动任务和交付物全部经过签名策略门禁 | AUTO-PASS（38 项门禁/宿主/市场故障注入） | LIVE-PARTIAL（macOS） | 首轮三类模型、未知第三方工具、可变原生插件、自动任务与交付物回执均已做集成故障注入；打包应用已验证签名门禁不可缺失。2026-08-17 自动目录刷新前的打包候选又以真实 OpenCode Go 首轮激活 `high-tech-enterprise-preassessment`：客户端注入技能输出契约、锁定专业执行链并生成受信任证据回执；第一次因政策数字未逐字绑定而失败关闭，模型按错误清单修复后第二次校验通过，最终只输出“必补证据清单”并明确不形成资格或评分结论、不编造企业事实。同一候选从模型能力注册表真实加载来源为“魔搭社区”、状态为“摘要已锁定”的已安装 `xlsx` 技能；在没有表格文件时仅索取输入，未创建文件或调用外部工具；另以公网下载内容验证第三方仓库摘要不一致时拒绝注册。真实 MCP 越权仍待端到端复核 |
| H05 | 策略签名缺失、技能摘要变化、规则版本漂移或门禁服务异常时失败关闭 | AUTO-PASS | LIVE-PASS（macOS） | 打包应用已分别验证策略签名缺失、策略正文篡改和高企技能正文篡改均无法进入主界面，恢复原文件后可正常启动；又以同一宿主信任的开发公钥重新签发技能包版本 1.6.7 的策略，宿主在主窗口创建前因期望版本 1.6.6 不匹配主动退出。运行中故障首轮实测发现局部作用域监听缺口后，已把签名策略锁到全局模型适配器派发、全局会话步骤与单调工具拒绝三个真实边界；重新打包后，未配置 OpenCode Go 凭据的隔离客户端在 `request/header`、凭据读取和任何助手回复产生前即以“运行中策略服务不可用，已保持关闭”终止。版本漂移回执 `acceptance/policy-version-drift-live-20260817/receipt.json`，SHA-256 `21f051007c8b9b9e3894e79f92d95ae0a14a15d10addf60806f3a590b27347f7`；运行中故障回执 `acceptance/policy-runtime-outage-live-20260817/receipt.json`，SHA-256 `618027f58f69e1a27ed17754cfdf0c2aadff63ba036e219a2a7c92608b87f57d` |
| H06 | 高企、专精特新等固定结构、事实边界、禁写项和去 AI 味规则在最终文件中保持 | AUTO-PASS（技能回归） | LIVE-PARTIAL（macOS） | 企业全景报告的事实边界、待补项、来源清单和最终 PDF 产物审计已通过；高企、专精特新正式材料端到端仍待验 |
| H07 | 规则拒绝时显示原因、证据缺口与修复建议，不把内部堆栈暴露给普通用户 | AUTO-PASS | LIVE-PASS（macOS） | 扫描 PDF 首次校验因同轮证据回执不唯一而明确提示需填写 `toolCallId`，模型按提示补齐后重新提交通过；界面无内部堆栈 |
| H08 | 打包客户端的 Glob/Grep 使用随包 ripgrep；指定企业目录能完成检索，Home/Documents 等宽目录未限定 path 时快速失败并给出修复提示 | AUTO-PASS（24 项定向回归） | LIVE-PASS（macOS：限定目录 4 秒命中；宽目录 3 秒拒绝） | Windows 随包二进制仍纳入 J02/J03 真机复核 |
| H09 | 左侧可按企业名称或会话标题筛选并展开最近会话、直接打开；企业空间总览页继续保留且两入口共用同一索引 | AUTO-PASS（4 项界面回归） | LIVE-PASS（macOS） | 最新打包候选已显示“最近对话”、企业与会话筛选和当前企业最近 5 条；空白“新任务（未开始）”不再进入最近会话或企业任务清单，当前空白会话输入框仍可使用；总览入口保留并共用同一索引，Windows 待 J03 复核。回执 `acceptance/ui-rebuild-live-20260817/receipt.json` |
| H10 | 侧栏只有一个“新对话”，无独立联网检索、常驻门禁状态或单选项 Agent 预设；专业预设和策略仍由宿主强制执行 | AUTO-PASS（界面与 Host admission） | LIVE-PASS（macOS） | 新候选实机侧栏已确认无重复新建入口、联网检索入口、门禁状态卡或 Agent 单选项；篡改失败关闭仍分别计入 H04/H05 |

## I. 桌面安全、持久化与视觉

| ID | 用户操作与验收结果 | 自动化 | 真实操作 | 阻断说明 |
|---|---|---:|---:|---|
| I01 | 密钥、密码、令牌不出现在 DOM、配置文件、会话、控制台、主进程日志和回执 | AUTO-PASS（静态/单测） | LIVE-PASS（macOS） | 对候选工作树、日志和回执扫描 8964 个文件、509,213,581 字节，通用明文凭据模式 0 命中；加密凭据库权限 0600，4 个条目均不是明文外观 |
| I02 | 所有外部注册链接只打开系统浏览器；非法协议、本地文件与内网目标被拒绝 | AUTO-PASS（HTTPS、DNS 与协议矩阵） | LIVE-PASS（macOS） | 企查查、天眼查、PaddleOCR 官方页由系统浏览器打开；`file:`、`javascript:`、localhost、内网、非标准端口和公网域名解析到私网均拒绝 |
| I03 | 强制退出、应用崩溃、断网、服务重启后会话/任务/技能/连接状态恢复一致 | AUTO-PASS（部分） | LIVE-PARTIAL（macOS） | OpenCode Go 真实生成中对主进程执行 SIGKILL 后，同一会话在重启时自动补齐 `interrupted` 终态，保留部分输出并明确显示“已停止”，随后同会话继续请求成功返回“恢复正常”；会话日志无 torn tail、未伪造完成且未重复轮次。断网与外部服务中断仍待验。回执 `acceptance/session-crash-recovery-live-20260817/receipt.json`，SHA-256 `6292c5c1b5e2a703b50036212a66e43f6150089cbd35d3c453127ae7de73e7a1` |
| I04 | 登录、会话、技能、MCP、自动化、企业空间、个人资料和设置各页无假按钮和死链接 | AUTO-PASS（部分） | LIVE-PARTIAL（macOS） | 会话、技能、MCP、自动化、企业空间、个人资料和设置均已实机操作；生产登录路由尚未开放，不能把登录页计为通过 |
| I05 | 1280×720、1440×900、1920×1080 和最小窗口下无遮挡、无横向溢出、弹窗可滚动 | AUTO-PASS（DOM 几何检查） | LIVE-PASS（macOS 核心页面） | 会话、企业空间、技能中心、MCP、自动化、个人资料与设置已覆盖 1024×700 和 1920×1080，技能中心另覆盖 1280×720、1440×900；无横向溢出，弹窗可滚动。证据 `output/playwright/gongchuang-v01/visual-matrix/` |
| I06 | 键盘导航、焦点、回车/空格、Esc、复制、错误提示和加载状态可用 | AUTO-PASS | LIVE-PASS（macOS）/ PENDING（Windows） | 最终 macOS 候选已实测 PaddleOCR 鉴权失败常驻显示错误代码与原因，错误正文可一键复制并原样粘贴；MCP 详情与配置弹窗均可用 Esc 关闭且不会误退页面。所有产品弹窗现共用焦点锁定与可见焦点环；隔离首次启动中，初始焦点自动落在“默认（全部）”，Tab 按杭州、绍兴、金华、宁波、进入按钮顺序循环并回到首项，Shift+Tab 可从首项回到末项，焦点未穿透到侧栏。中文界面对英文占优的模型思考只显示“正在处理…”或“思考已完成”，中文思考仍完整展示。键盘回执 `/Users/zsh/JiaotangData/client-candidates/acceptance/keyboard-focus-live-20260817/receipt.json`，SHA-256 `e22e04027b5133823f6ecd6bba8e16d11a4f9a3fbb8191cd977a3cc17adab7ed`；Windows 剪贴板与键盘遍历随主人实机验收 |
| I07 | 用户可选择、裁切保存和恢复本机头像；设置可检查、下载并重启安装更新，未配置正式源时不伪报最新版 | AUTO-PASS（组件、控制器、主进程头像存储与 IPC） | LIVE-PARTIAL（macOS） | 实机选择头像后已写入主进程本地资料库，跨进程重启恢复且可恢复默认；未配置更新源时明确提示“正式更新通道尚未配置”而不伪报最新版。正式更新源尚未提供，故下载与重启安装仍待验。回执 `acceptance/profile-settings-live-20260816-0459/receipt.json`，SHA-256 `3fc8481bc60feb32c7d5456a02fca49078d71485b168ca029e6a4b357ce98557` |

## J. 双平台设备生命周期

| ID | 用户操作与验收结果 | 自动化 | 真实设备 | 阻断说明 |
|---|---|---:|---:|---|
| J01 | macOS arm64 安装、首次启动、升级、回滚、损坏失败关闭、恢复、移入废纸篓卸载、重装 | AUTO-PASS（24 阶段脚本与隔离契约） | DEVICE-PASS（macOS 26.5 arm64） | 2026-08-17 最终候选 `731e6cd3…` 对上一候选 `6a401722…` 完成 24/24 阶段；升级从旧 742 文件索引切换到当前 744 文件通用包，损坏时失败关闭，恢复、回滚、再次恢复、可恢复卸载与重装均通过，用户状态全程保留。DMG SHA-256 `b57e1b4813119be84388a537c6943c75f4103c7f4fa1f4bcae5394cf9c7129ad`，ZIP SHA-256 `53c69e0b7dd55ae8becb85031318648d7d43c3d882f514d7032f81135c3384bc`；回执 `/Users/zsh/JiaotangData/client-candidates/acceptance/macos-20260817-provider-max-final-0640/macos-device-acceptance.json`，SHA-256 `5d6b052f1ca512ddfc73831c9d03bafa1f972ca3660e8e233b1ffed502861c8f` |
| J02 | Windows 10 x64 完整生命周期及截图/日志/SHA-256 回执 | AUTO-PASS（脚本契约、ZIP 完整性、PE x64 主程序及最新候选身份） | DEVICE-PENDING（由主人实测） | 2026-08-17 最终内部验收安装器 SHA-256 `ee6adcd0e80b91e29df2f9be49f758a16de2ac86352e1d32b02b032815417577`，ZIP SHA-256 `c1fe7e211cf0758ab0a1fc5d421ff1560d157e45d5f8bfd93d15f93dbfaac9cb`；主程序为 PE32+ x86-64，ZIP 压缩数据无错误，包内 Windows x64 运行时为 32,356 个文件，V1.6.6 通用技能包为 50 个技能、744 个文件，索引 SHA-256 `5f5f6b332bf9efca35df48d2a6d82f0c3fff8e48e9b4bc7c5c1bc23b9d92cd59`。已生成只含 ASCII 路径的完整真机验收包 `Windows-Device-Acceptance.zip`，SHA-256 `69f90d09fbe7ec7450010849dea14644a8d94503513229d6d523ca6bfea42f0e`，内含 742 文件旧基线、当前安装器、双击入口、完整脚本、正确入口说明、分项哈希及三路模型、技能、MCP、自动化、企业空间和门禁的手工冒烟清单；入口契约 5/5 通过。尚未在真实 Windows 10 x64 设备执行该脚本与清单 |
| J03 | Windows 11 x64 首次安装、启动、自动登录、模型/技能/MCP/自动化冒烟 | AUTO-PASS（跨平台契约与打包输入） | DEVICE-PENDING（由主人实测） | 需要主人在真实 Windows 11 x64 设备执行安装和使用测试；生产登录路由未部署前，账号登录仍会按真实状态失败，不能计为通过 |
| J04 | 两端用户数据迁移、旧版回滚、损坏恢复后都不泄露或错误复用凭据 | AUTO-PASS（部分） | LIVE-PARTIAL（macOS） | macOS 隔离数据根目录、状态跨升级/回滚/卸载保留及无凭据回执已通过；真实钥匙串迁移与 Windows 仍待验 |

## 当前放行结论

2026-08-17 最终低并发全仓回归为 859 个测试文件通过、8 个跳过；13,775 项测试通过、109 项跳过、0 项失败。TypeScript 全量类型检查、`lint:contracts-ready`，客户端、配置、Cordis 与工具目录生成一致性及 `git diff --check` 均通过；Cordis 93 项生成内容无漂移。最终 macOS 应用 `app.asar` SHA-256 为 `731e6cd36687eed40aae5870904a6eee437fcb3177cfa8ec55e536a4f20c17c2`，DMG SHA-256 为 `b57e1b4813119be84388a537c6943c75f4103c7f4fa1f4bcae5394cf9c7129ad`，ZIP SHA-256 为 `53c69e0b7dd55ae8becb85031318648d7d43c3d882f514d7032f81135c3384bc`；DMG 校验、ZIP 完整解压与新的 24 阶段设备生命周期均通过。最终 Windows 应用 `app.asar` SHA-256 为 `a7b2ac3292257eed7f8452a3f2c7ad8485fbb083528ce5ffe2701a2bb993b7ce`，安装器 SHA-256 为 `ee6adcd0e80b91e29df2f9be49f758a16de2ac86352e1d32b02b032815417577`，ZIP SHA-256 为 `c1fe7e211cf0758ab0a1fc5d421ff1560d157e45d5f8bfd93d15f93dbfaac9cb`，ZIP 压缩数据无错误，打包主程序为 PE32+ x86-64。macOS 运行时索引 SHA-256 为 `eaa7642230d506a003a4895491c4d608f3a18f13f668b32f22b4ef371e3100f0`，Windows 运行时索引 SHA-256 为 `d6509dd7bee1c79d5b3f88e38a22eb2e2ba0b8907a1734136c63e129d216c8b0`。两端引用同一份 V1.6.6 通用技能包索引 `5f5f6b332bf9efca35df48d2a6d82f0c3fff8e48e9b4bc7c5c1bc23b9d92cd59`，均为 50 个技能、744 个文件；没有双端技能包，只有双端客户端安装文件。

**安装文件只作为未发布内部测试候选，不冒充可登录正式版。** 正式服务器工作树的账号、双设备、断网恢复、下载记录和管理端客户端状态已在隔离真实 HTTP/HTTPS 服务中通过；打包客户端实际固定的生产入口是 `https://zshjiaotang.cn`，其 DNS 与 TLS 正常，但 2026-08-17 对 `/v1/client-login` 和 `/downloads` 的真实请求均返回 HTTP 404，生产路由尚未部署。在获得单独生产部署授权并完成线上复核前，账号登录主链仍是明确阻断。Windows 真机安装和使用按用户要求由主人执行。企查查 `history` 已按用户确认从必验能力中移除；OpenCode Go、原生 DeepSeek Flash、自定义 API 的真实对话与重启恢复，企查查/天眼查最小真实查询，Paddle 图片与扫描 PDF OCR、鉴权失败不伪绿、错误复制，macOS 自动化到点执行、企业空间完整操作、专业黄金样例出报告和最终 macOS 安装生命周期均已通过。

放行顺序固定为：全量代码回归 → 本机未打包与 unpacked 打包目录真实操作 → 服务端生产验证 → 真实凭据与业务黄金样例 → 视觉与故障注入 → 仅为设备生命周期生成内部验收候选 → macOS/Windows 客户端真机安装、升级、卸载与回滚 → 验收通过后才把两端客户端安装包、同一份通用技能包版本标识和哈希回执作为交付物输出。客户端不得发布或上传。
