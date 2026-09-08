---
name: skill-curator
description: 安装企业全生命周期助手后自动启用。根据任务使用记录、用户纠正和四问复盘检查技能重复、触发冲突、过期规则、使用情况和质量问题，提出合并、拆分、归档或保留建议。
---

# 技能策展


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


默认只生成报告。任何合并、删除、归档和覆盖操作必须先创建快照并取得用户批准。核心规则不得因使用频率低而删除。

首次配置后无需用户再次开启其分析能力；这不授予常驻调度、周期巡检或日志写入权限。进入已授权的技能审计任务时读取 `experience-recorder` 已有脱敏记录；只有发现可复现问题时才提出调整，避免为追求变化而变化。

以下阈值只约束自主发现与自动聚合。用户明确要求修复已经复现或已核验的问题时，不等待累计阈值，直接把该问题作为有界候选交给 `skill-authoring` 与 `evolution-governance`；仍须遵守快照、影响范围、测试、签名和正式发布授权。

## 高频纠正聚合

自主进化不要因单次纠正立即启动。先运行：

```bash
python3 scripts/aggregate_corrections.py \
  --input ~/.config/project-assistant/evolution/corrections.jsonl
```

默认只有同一技能、同一规则键累计至少3条已核验纠正，且来自至少2个不同任务时，才进入批量候选。每批最多选择2个技能，同一技能进入候选后冷却7天。缺少字段、未经核验、含敏感信息或处于冷却期的信号不参与计数。阈值从 `config/common.yaml` 读取。

输出 `correction-summary.json` 和 `evolution-batch.json`。只有批次清单的 `ready=true` 时才交给 `skill-evolution`；这一步仍不运行GEPA、不修改正式Skill。

用户批准开始处理该批次后，使用同一输入追加 `--mark-planned` 写入冷却状态，防止下次巡检重复生成同一批候选。未批准或仅查看报告时不要写状态。

## 技能变更影响图

修改任何规则、技能、模板、脚本或交付门禁前运行：

```bash
python3 scripts/build_impact_graph.py --changed <变更文件>
python3 scripts/build_impact_graph.py --query <规则关键词>
```

脚本输出可查询的 `skill-impact-graph.json` 和人类可审查的 `skill-impact-report.md`，按下游关系列出受影响技能、模板、脚本和门禁。关系方向、节点类型和发布要求见 [impact-graph-schema.md](references/impact-graph-schema.md)。影响图没有覆盖到的隐式业务关系必须在报告中人工补充，不得把关键词共现当成确定依赖。
