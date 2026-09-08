---
name: third-party-data-indexing
description: 实验性第三方数据索引技能。将企策顾问等用户有权访问的第三方政策、申报项目、申报条件及通过或公示企业名单增量写入本地SQLite索引，支持漏采补采、断点、限速、去重、版本记录、官方链接健康检查及Markdown或JSONL导出。仅在用户明确启用并要求更新政策库、采集企策顾问、建立项目索引、查询当日申报通知、公示名单或配置定时补采时使用。
---

# 第三方数据增量索引


## 客户端运行环境

本技能由客户端整包验签后加载，不执行其他宿主的独立安装、准备或二次验签流程。不得因客户端未携带独立安装清单而反复查找、安装或重试。

工具以本轮工具目录为准。若只开放 run_code，提供 description 与 code，在 code 内通过 await tools.skill、await tools.read、await tools.write、await tools.bash 等当前 SDK 绑定调用，不把 skill、read、write、edit、apply_patch 或 bash 当根工具。run_code 不是 Node.js：不可使用 require、process 或 fs；文件和进程操作使用 SDK 中的工具。读取文件固定调用 tools.read({ file_path: "..." })，不得把参数名写成 path。所有调用必须在 code 顶层实际 await，不得只定义未调用的包装函数。

run_code 只返回 null 或由字符串、数字、布尔值、数组和普通对象组成的纯 JSON；不得返回原始工具结果、Promise、undefined 或其他不可无损序列化的值。需要继续使用工具结果时在同一段 code 内完成处理，只返回后续决策必需的字段。

SDK 工具没有业务参数时也传入空对象 {}，不省略参数，不传 undefined。

用户限定读取指定文件或目录时，该范围优先于学习已有格式、复用历史案例和工作区探索。不读取其他会话成果或相邻项目来补齐答案，也不先扫描整个工作区。用户已经给出精确输入或输出路径时直接使用该路径；即使 SDK 提供 glob，也不得用 pwd、glob、find、ls 或目录枚举重新发现。来源未给出的字段保持未知；采集和写入时间由运行进程读取系统时钟，不复制示例日期。

技能说明中出现脚本名或命令，表示应按文档直接执行该命令，不表示可以先读取脚本源码。首次执行前不得读取 `scripts/**`、`examples/**`、`tests/**`、`*.example.*`、`package.json`，也不得列出技能目录来理解用法；只有文档给出的命令已经真实失败，且错误信息仍不足以确定调用契约时，才可定向读取与该失败直接相关的一个源码文件。此限制避免把生成任务退化为源码研读，也避免示例值污染用户事实。

技能文档已经给出连续的确定性命令时，在一个 run_code 中按依赖顺序连续执行相邻的输入校验、生成、导出和成品检查；除非前一步结果会改变下一步参数，不得每成功一条命令就返回模型重新规划。

客户端生成 PDF 时，统一使用宿主提供的 gongchuang_render_pdf：先按宿主要求对真实 HTML 源完成对话内预校验，再调用该工具。即使技能业务说明列有独立渲染脚本，也不得在客户端运行 render_pdf_stdout.js、直接启动 Chrome 或 Edge、查找或安装 Playwright 或 Chromium；这些独立渲染入口仅供未提供 gongchuang_render_pdf 的其他宿主。

调用可能持续运行的外部命令时，必须显式传入宿主支持的 timeoutMs，并保留真实退出状态。命令超时或失败后不得改成无超时后台运行，也不得用管道吞掉退出码。


> 当前状态：实验性。默认不启用，不作为项目匹配或正式政策判断的必需依赖。

启用前读取 `first-run-configuration` 生成的能力报告；浏览器能力未确认时回到统一向导，不单独保存或重复询问企策顾问登录信息。

用户已提供离线数据时，直接使用现有索引引擎处理，不为入库先启动浏览器、联网或专业政策校验。只在实际采集或作正式政策判断时执行对应步骤。

## 执行边界

1. 只处理用户使用自有账号和合法权限取得的数据。
2. 调用 `web-task-operator` 完成扫码登录、列表检索、翻页、详情读取和人工接管；本Skill不保存密码、Cookie、Token或认证Header。
3. 浏览器将脱敏业务数据导出到入箱，再运行 `scripts/index_engine.py ingest`。
4. 第三方数据只是发现线索；进入正式推荐前调用政策检索Skill核验官方原文。
5. 遇到登录失效、验证码、付费限制、访问拒绝或服务条款限制时停止，不规避。

## 每日工作流

1. 仅在用户明确配置后，由宿主自动化按用户选择的时间调用 `scripts/daily_update.py`；每日17:00只是可选示例，不是强制默认值。
2. 读取上次成功日期，生成当日与缺失日期的补采计划。
3. 如入箱已有 `aiqice-YYYY-MM-DD.json` 或 `.jsonl`，自动写入SQLite。
4. 如缺少数据，输出标准采集请求；宿主自动化继续调用 `web-task-operator` 取得数据后再执行当日更新。
5. 采集成功后写入批次、日期、新增、变更、重复、失败和官方链接缺失数。
6. 只对新增、变更或缺少官方原文的记录打开详情页。
7. 申报通知必须采集申报条件；公示公告必须采集页面或附件明确列出的通过、公示企业名单。
8. 使用 `scripts/quality_monitor.py` 记录翻页、限频、验证码、登录失效和官方链接有效率。

宿主自动化提示词见 `references/daily-automation-prompt.md`。宿主不支持自动化时，本地调度器会产生待采集请求并可打开企策顾问页面，但不得声称已完成无人值守取数。

## 默认路径

- 根目录：`~/.project-application-assistant/index/`
- SQLite：`policy-index.sqlite3`
- 浏览器导出入箱：`inbox/`
- 待执行采集请求：`requests/`
- Markdown归档视图：`markdown/`

用户不需要手工编辑多份配置。需要改路径时使用命令参数或 `PROJECT_APPLICATION_ASSISTANT_INDEX_ROOT`。

## 命令

```bash
python3 scripts/index_engine.py init
python3 scripts/index_engine.py ingest --input <browser-export.jsonl> --source aiqice
python3 scripts/index_engine.py query --region 浙江省 --keyword 申报 --limit 20
python3 scripts/index_engine.py query --year 2026 --include-inactive
python3 scripts/index_engine.py status
python3 scripts/index_engine.py export --format markdown
python3 scripts/daily_update.py --open-browser
```

## 数据规范

字段、去重、版本和授权规则见 `references/index-schema.md`。企策顾问浏览器导出字段与本Skill字段一致，不包含认证信息。

离线记录的 `id/year/version/status/source` 可直接导入，分别保留为源记录 ID、年度、源版本、申报状态和逐条来源。不要把 ID 伪造成网址，也不要把年度补成不存在的发布日期。`--source` 是整批采集来源的命名空间，重复导入同一来源时保持不变。按年度使用 `query --year`，不是标题关键词；检查失效记录时加 `--include-inactive`。若输入按 initial/update 分批，分别原样导出数组再依次导入，不改业务字段。

采集日期默认由引擎读取当前系统日期。只有来源明确记载实际采集日或用户要求历史回填时才传 `--collection-date`；不能为 initial/update 自行编造两个历史日期。只读取指定输入和技能自身脚本说明，不借阅同目录中的旧任务结果作为输入或格式依据。
