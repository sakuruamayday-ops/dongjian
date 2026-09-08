---
name: graphify
description: 将代码、政策、项目资料或知识库目录构建为可查询的持久知识图谱。仅在用户明确要求知识图谱、关系图、路径追踪、社区聚类、GraphRAG或明确点名graphify时使用。
---

# 知识图谱构建与查询


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


把用户指定目录转换为可持续更新的知识图谱，用于发现文件、政策、项目、企业、产品、技术、专利和证据之间的关系。

## 使用边界

- 普通文件搜索、政策关键词检索和知识库全文查询继续使用云端知识库，不自动触发本技能。
- 只有用户明确要求知识图谱、关系追踪、最短路径、社区聚类或GraphRAG时触发。
- 不默认生成Obsidian目录；标准输出为交互式HTML、图数据JSON和图谱报告。
- 图谱中的推断关系必须与原文提取关系分开标记，不把模型推断写成政策或企业事实。
- 只处理用户指定的单一客户、单一项目或单一专题目录，不扫描主目录、磁盘根、整个知识库或混合客户根目录。
- 每个客户或项目使用独立的 `graphify-out/`；除非用户明确要求集团或多主体对比，不合并不同客户图谱。
- Graphify只用于关系导航、证据链检查和异常发现，不替代政策现行性、企业登记、专利法律状态或财务原值核验。

## 项目与隐私门禁

1. 先读 `references/project-profiles.md`，选择 `application-evidence`、`policy-corpus`、`ip-evidence` 或 `client-dossier`。
2. 涉及专精特新或小巨人时，先确认申请书项目类型与审核版本；未确认时只能盘点资料和构图，不形成达标结论。
3. 客户项目默认 `privacy=restricted`。不得因环境中存在模型密钥就把客户资料发送给第三方后端。
4. 发现凭据、身份证件、银行账号、原始员工花名册或未脱敏客户名单时，排除相应文件并只报告数量。
5. 公开政策、公示名单和公开专利可使用 `privacy=public`，但仍须保留来源和采集日期。

完整规则见 `references/privacy-and-scope.md`。

## 前置能力

本技能调用开源 `graphifyy` 工具。首次使用时先检测：

```bash
command -v graphify || python3 -c "import graphify"
```

未安装时向用户说明将安装第三方依赖，再执行以下任一方式：

```bash
uv tool install graphifyy
```

或：

```bash
python3 -m pip install graphifyy
```

## 构建流程

1. 确认输入目录、业务 Profile、隐私级别和输出目的。
2. 至少10个相关文件、预计超过20,000字、需要跨材料证据核对或会持续更新时再构图；小任务直接使用现有检索与审查技能。
3. 初始化项目：

```bash
python3 scripts/init_project.py PROJECT_ROOT \
  --profile PROFILE \
  --project-name "项目名称" \
  --client-name "客户名称" \
  --privacy restricted
```

4. 生成业务语义提取规范：

```bash
python3 scripts/build_prompt.py \
  --overlay references/domain-overlay.md \
  --output PROJECT_ROOT/graphify-out/.project-extraction-spec.md
```

如宿主或已安装的 Graphify 提供基础提取规范，可额外传入 `--upstream 基础规范路径`，再叠加本技能规则。
5. 统计文件数量、类型和规模；超过500份文件时按一级目录分批。
6. 执行完整构建，输出到项目目录下的 `graphify-out/`，至少保留 `graph.json`、交互式HTML和 `GRAPH_REPORT.md`。
7. 审计图谱：

```bash
python3 scripts/audit_graph.py \
  PROJECT_ROOT/graphify-out/graph.json \
  --profile PROJECT_ROOT/.gongchuang-graphify.json \
  --output PROJECT_ROOT/graphify-out/EVIDENCE_GRAPH_AUDIT.md
```

8. 抽样核对实体、关系、来源文件、政策版本、专利状态和推断标记；审计告警不自动改图。
9. 后续文件变化时优先增量更新，不重复全量构建。

常用命令：

```bash
graphify <目录> --no-viz
graphify <目录> --update
graphify query "问题"
graphify path "实体A" "实体B"
graphify explain "实体名称"
```

需要交互图时移除 `--no-viz`。需要提供给其他Agent时，可使用工具支持的GraphRAG JSON或MCP模式，但不得替代团队知识库现有MCP。

## 政府项目场景

- 政策版本图：政策、废止依据、替代文件、申报通知和执行细则。
- 项目关系图：国家、省、市、区县项目及其上下级、别名和申报条件。
- 企业能力图：产品、技术、专利、客户验证、产业链和可申报项目。
- 专利关系图：申请人、权利人、同族、引证、技术特征和产品映射。

业务实体、关系方向、来源等级和申报四项判断规则见 `references/domain-overlay.md`；常用问题见 `references/query-templates.md`。

## 查询与交付

回答必须区分：

1. 图谱事实：附 `source_file` 或 `source_location`；
2. 图谱推断：标明关系置信度；
3. 待外部核验：政策现行性、企业登记、专利法律状态和财务原值；
4. 行动项：缺少的材料、冲突关系或补证任务。

正式申报文本仍须经过套件的真实性、数据溯源、关联一致性和交付门禁，图谱报告不能替代正式申报材料。

## 验收

- 每个关键节点可追溯到原文件。
- 抽样关系不存在方向颠倒或同名实体误合并。
- `EXTRACTED`、`INFERRED`和`AMBIGUOUS`关系明确区分。
- 不同客户资料未进入同一图谱，受限资料未静默发送到外部模型。
- 政策版本、专利状态和事实冲突被显式保留，不以共现关系替代核验。
- 更新后旧图谱可回滚，新增文件能够进入增量结果。

## 来源说明

本技能是企业全生命周期助手的原创适配说明，运行时依赖第三方开源包 `graphifyy`。第三方软件的安装、版本和许可证以其发布页面为准，不随本技能复制第三方源码。
