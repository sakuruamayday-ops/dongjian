# 2026-09-03 功能审查与修复证据

阶段记录：以下为首次审查结束时的本地修复与测试事实，不代表正式发布。后续已确认的授权取消、停止并删除和文件质量展示决定及 V0.4.2 发布进展见 [V0.4.2 修复与发布证据](2026-09-03-v0.4.2-release.md)。当前基座仍为 DeepSeek Harness alpha.4。

## 审查范围

独立审查使用已登录的 [网页版 ChatGPT](https://chatgpt.com/c/6a98c174-0ee0-83ee-89e2-34accabace0b)。第一批核对文件交付与技能更新问题；第二批收到自动任务 Host 和 Client 两份完整源码；第三批收到模型连接、提供方注册表、目录刷新、附件状态、拖放控件、桌面文件导入、连接器控制器和两套 OAuth 共九份完整源码。只发送源代码，不发送凭据、客户文件或客户会话日志。

三批独立审查均已完成。自动任务批次提出七项问题；第三批最终提出六项：托管配置补偿中断、同 ID 模型元数据陈旧、发送后新附件被误清、合法点前缀文件打不开、授权占住全局队列、Token 发现地址被接受后忽略。这些问题均已有对应修复和回归；其中天眼查端点继续采用现有固定官方地址，拒绝不一致元数据，不新增任意地址路由。网页中未经完整调用链支持的其他疑点没有直接当成结论；混合拖放和实际适配器元数据消费由本地补齐源码并验证。此记录不声称完成全仓所有功能的真实服务验收。

## 已修复问题

| 需求 | 可达缺陷 | 实现与验证边界 |
| --- | --- | --- |
| REQ-74 | alpha.4 移除旧事件数组后，PTC 子调用缺少轮次位置，成功交付不能归入文件栏 | 新事件读取真实 Session 的 `snapshotEvents()`；历史读取只恢复当前 Step 内唯一根调用的位置，不改原始日志、不猜相邻文字、不跨轮归属 |
| REQ-74 | 只调用 `gongchuang_artifact_probe` 的成功文件没有打开入口 | 与显式 publish 一样消费结构化参数和成功回执，失败及畸形记录不生成入口；去重并排除中间文件 |
| REQ-75 | 远端更新检查未完成或失败时，设置页退回旧内嵌技能版本；404 被解释为最新版 | 增加主进程活动版本只读通道，网络检查独立；读取失败不伪造旧版本；404 返回检查错误 |
| REQ-76 | 相同输入在不同时区重建 ZIP 字节不同；并发旧版发布覆盖新版 latest | 固定 ZIP DOS 时间；服务器以现有文件锁串行化共享 latest 比较、不可变归档和清单替换，保留原签名与降级限制 |
| REQ-77 | 自动任务领取后尚未绑定会话时可被删除或移空间；历史裁剪会删掉活跃令牌 | 迁移仍被拒绝；删除按后续 REQ-83 先停后删，未绑定领取不再发送消息；只裁剪终态历史，保留全部活跃领取；创建与更新拒绝已不存在的空间 |
| REQ-77 | 任意周期文案与实际间隔不同；无时区或无效日期被 Date 静默解释 | 周期从实际间隔生成，审批与页面使用同一实际值；首跑时间校验有效日期和明确时区 |
| REQ-77 | 一次创建成功便允许宣称全部成功或虚构任务编号 | 按本轮每个调用结果和实际任务 ID 判断；允许如实说明部分成功，最多纠正一次，不重建任务 |
| REQ-77 | 手工执行占住设置队列和整页；轮询异常未收尾 | 领取串行、长任务在队列外等待，同一任务防重复；可停用后续计划；轮询捕获异常且成功空轮询清理自己的旧错误 |
| REQ-78 | 探测使用新密钥，但实际请求仍用旧密钥名、地址或协议 | DeepSeek 和托管提供方将目录、密钥引用、端点和协议保持一致；真实适配器完成请求序列化及流式回复，重建运行时后仍一致 |
| REQ-78 | 配置回滚异常中断密钥恢复；目录不支持时刷新伪造已验证状态 | 补偿独立收尾并退出 checking；配置或密钥恢复失败都明确要求重新配置；无目录的手工模型保持 candidate 和空验证时间；可配置端点保留用户实际地址 |
| REQ-78 | 同一 DeepSeek 模型 ID 的名称和容量永远保留旧值 | 明确返回的名称、上下文和输出上限更新至真实适配器；缺省元数据保留，可信图片等能力不被目录降级 |
| REQ-79 | 浏览器授权等待阻塞其他连接器操作，迟到结果可关闭另一个配置框 | QCC 和天眼查仅限制自身重复操作，其他设置继续可用；按后续 REQ-82，关闭、取消和 Esc 均取消精确本次授权；迟到结果不清空另一个窗口，旧快照不覆盖新版本 |
| REQ-79 | 天眼查 Token 发现地址被接受，但实际换证和续期仍使用固定端点 | 注册前验证发现地址与现有固定官方端点一致，偏离时明确拒绝；这项为故障注入验证，没有证据显示线上官方地址已经变化 |
| REQ-80 | 发送完成误清刚导入的下一条附件；混合拖放将图片当文档 | 仅消费发送快照，保留新附件及重新添加的同一路径；图片走上游图片入口、限制和预览，文档走受控导入；整页输入锁同步到文件入口 |
| REQ-80 | 同名长文件加后缀后超出草稿恢复上限；合法 `..evidence.docx` 无法打开 | 同名后缀计入 160 字符上限；区分父目录段和合法文件名，继续拒绝目录穿越及符号链接；发送结束不复活已删除会话草稿 |

## 本轮执行结果

运行目录为客户端仓库，除非另行说明。自动生成的报告保存在 `/Users/zsh/JiaotangData/test-evidence/gongchuang-functional-review-20260903`。

| 验证 | 命令 | 实际结果 |
| --- | --- | --- |
| 完整构建与类型检查 | `pnpm run build`；`pnpm exec tsc -b tsconfig.host.json tsconfig.client.json apps/desktop/tsconfig.json` | 最终修改后通过；构建登记 224 个客户端产物、3 个公开值 |
| 完整客户端/Host UI 回归 | `node node_modules/vitest/vitest.mjs run packages/client packages/host --reporter=default --reporter=json --outputFile=/Users/zsh/JiaotangData/test-evidence/gongchuang-functional-review-20260903/gui.json` | 316 文件，4,181 通过，1 跳过；[原始报告](/Users/zsh/JiaotangData/test-evidence/gongchuang-functional-review-20260903/gui.json) |
| PTC、历史、自动任务、模型、技能更新、桌面导入与授权 | `node node_modules/vitest/vitest.mjs run packages/core/tools/tests/ptc.spec.ts packages/session/session-persistence-jsonl/tests/jsonl.spec.ts packages/product/gongchuang-local-automation/tests/local-automation.spec.ts packages/product/gongchuang-model-connections/tests/model-connections.spec.ts apps/desktop/tests/skill-updater.spec.ts apps/desktop/tests/stage-skill-suite.spec.ts apps/desktop/tests/document-import.spec.ts packages/mcp/gongchuang-connectors/tests/connectors.spec.ts packages/mcp/gongchuang-connectors/tests/tianyancha-oauth.spec.ts packages/mcp/gongchuang-connectors/tests/qcc-oauth.spec.ts --reporter=default --reporter=json --outputFile=/Users/zsh/JiaotangData/test-evidence/gongchuang-functional-review-20260903/host-final.json` | 10 文件，349 通过；[最终报告](/Users/zsh/JiaotangData/test-evidence/gongchuang-functional-review-20260903/host-final.json) |
| 最终测试类型修正后的 UI 联动回归 | `node node_modules/vitest/vitest.mjs run packages/client/ui-gongchuang-product/tests/automation-page.client.spec.tsx packages/client/ui-gongchuang-product/tests/automations.client.spec.ts packages/client/ui-gongchuang-product/tests/connectors.client.spec.ts packages/client/ui-gongchuang-product/tests/mcp-connection-dialog.client.spec.tsx packages/client/ui-gongchuang-product/tests/document-import-control.client.spec.tsx packages/client/ui-conversation/tests/input-bar.client.spec.tsx --reporter=default --reporter=json --outputFile=/Users/zsh/JiaotangData/test-evidence/gongchuang-functional-review-20260903/gui-final-targeted.json` | 6 文件，131 通过，属于上述完整 UI 覆盖，不重复计入总数；[最终报告](/Users/zsh/JiaotangData/test-evidence/gongchuang-functional-review-20260903/gui-final-targeted.json) |
| 构建后的真实浏览器回放 | `DSH_SNAPSHOT=replay node node_modules/vitest/vitest.mjs run --config vitest.web.config.ts apps/web/tests/produced-files.e2e.ts apps/web/tests/default-model.e2e.ts apps/web/tests/models-settings.e2e.ts --reporter=default --reporter=json --outputFile=/Users/zsh/JiaotangData/test-evidence/gongchuang-functional-review-20260903/web-final.json` | 最终构建后 3 文件，15 通过；[最终报告](/Users/zsh/JiaotangData/test-evidence/gongchuang-functional-review-20260903/web-final.json) |
| 服务器共享 latest 及发布调用方 | 在技能仓库执行 `PYTHONPATH=services/knowledge-portal .venv/bin/python -m pytest services/knowledge-portal/tests/test_skill_update_feed.py services/knowledge-portal/tests/test_publish_client_skill_update.py services/knowledge-portal/tests/test_release_transaction.py -q` | 19 通过；并发用例实际观察旧发布者被文件锁阻塞后再释放新版写入，没有以固定 sleep 推断锁生效 |
| 差异检查 | 两个仓库分别执行 `git diff --check` | 通过 |

变更的产品源码、包内测试和 Web 测试通过仓库类型感知 Oxlint。桌面测试及打包脚本不在既有 TypeScript aggregate 的测试收集范围内，直接跑全量类型感知 lint 会把 Node API 误报为 error 类型；这四个文件改用仓库已有 `.oxlintrc.staged.json` 普通检查并通过，桌面生产源码另行通过 TypeScript。没有关闭仓库规则，也没有把桌面测试的类型感知 lint 记为已通过。

关键新增故障用例先在未修实现上复现，再通过修复验证。早期测试脚手架中的提供方 ID、定位器和冻结设置副本问题已修正，不作为产品缺陷计数。全部界面回归包含有意触发错误边界的用例，不能把其 stderr 当成通过或失败结论；以报告状态和退出码为准。

## 真实数据与界面验证

对用户指定会话只调用官方 JSONL 持久化层的 `inspect`，不调用 load/resume，不追加事件。读取 240,769 条事件，恢复出两条成功的交付记录；末条记录序号 239,323 正确归入第 10 轮第 14 步，引用文件实际存在。读取前后原始压缩日志逐字节摘要一致。客户正文、隐藏推理和文件内容不进入本记录或网页审查。

浏览器回放使用独立种子会话验证冷启动、历史 publish/probe 按钮、刷新后保留，以及按钮点击到 Host Remote 的准确路径。十文件布局在 1800 和 780 像素窗口保持单行且不溢出。CI 中原生打开调用被替身接收，因此这不是最终安装包调用系统文档应用的验收。

模型测试使用真实适配器和受控 HTTP/SSE 响应，证明新密钥引用、协议、端点与重启恢复的请求一致性，不冒充本轮真实云端账户推理。QCC 和天眼查等待用例使用受控授权响应，不声称本轮重新完成了第三方实号授权。

## 技能版本与数量口径

本轮只读核对的活动技能为 V1.6.16、51 项正式技能、556 个签名文件；另有 3 项社区安装，展示总量为 54。V0.4.1 安装包内嵌 V1.6.15、51 项、554 个文件是历史封装事实，独立更新后不应覆盖活动版本。数量没有变化不代表版本没有更新；正式技能数与含社区安装总数不能混为一项。

## 发布边界

- 没有改写历史安装包、旧发布证据、客户文件和原始会话日志；没有读取、上传或替换实际 API 密钥。
- 本次没有升版、打新安装包、替换 Applications 中客户端或部署服务器。正式版本仍按原发布记录识别，不能把本地回归写成已上线。
- 下一次正式发布仍须绑定最终源码和三端制品，执行最终包的文件打开、技能活动版本和真实模型收发验收。沿用已确认的 macOS 图形放行逻辑，不重复要求“仍要打开”实机演练，也不降低签名、完整性和回滚边界。
- 未确认的网页候选不擅自改安全或授权协议；只在受支持调用链中得到证据后修复。

## 四问复盘

1. 最不确定：最终安装包与真实第三方服务的表现，本轮没有新的打包或实号验收。
2. 最大遗漏：此前“源码测试通过”被扩展理解为交付闭环，历史 PTC 与独立技能更新的真实消费者覆盖不足。
3. 最有价值的改进：把已有真实故障录制成脱敏冷启动回放，复用现有测试设施，不再叠加运行期门禁。
4. 提效方式：一次提供完整调用链源码，网页独立审查与本地复现同步推进，只对可达缺陷及实际联动范围复查。
