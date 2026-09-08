---
name: financial-verification
description: 核验政府项目申报中的营收、利润、研发投入、资产、负债、增长率和专项财务指标。用户提供可靠财务资料后使用。
---

# 财务核验


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


只使用用户提供或明确授权的可靠数据。读取 `references/source-and-normalization-rules.md`，先确认主体、年度、币种、单位、合并范围和审计口径，再登记原始值。无可靠数据时不推算企业财务，不用第三方过期数据补造。

## 固定流程

1. 建立来源台账，区分审计报告、财务报表、纳税申报表、专项审计、企业台账和外部线索；外部线索不得覆盖企业原始资料。
2. 统一年度、币种、单位和合并范围。无法无损转换或来源口径冲突时保留并列版本，不静默选值。
3. 按 `references/reconciliation-and-formulas.md` 执行表内、表间和跨年度勾稽；研发费用必须区分财务核算、加计扣除和项目申报口径。
4. 每个计算展示公式、原始值、单位、结果和复核状态。缺少分母、期间不连续或口径不同，不计算比例或增长率。
5. 将结果标为“verified、computed、missing、conflicting、not-applicable”；只有前两类可以传递给资格判断。
6. 输出可复用事实、计算指标、证据、质量状态、冲突和缺口；不输出税务违法或申报资格结论。

需要完整解读资产负债表、利润表和现金流量表时，读取 `references/financial-statement-analysis.md`。指标阈值和行业基准必须带来源、年度和样本口径；没有可靠基准时只做企业自身趋势与结构分析，不使用固定健康值或统一十分制。

需要评估短期资金安全、回款、备货、供应商账期、资本开支或压力情景时，读取 `references/cash-flow-and-working-capital-review.md`。13周现金流、现金跑道和现金转换周期只使用用户资料或明确测算假设，不套用创业公司、SaaS或美元金额基准。

## 共享财务事实

读取 `references/financial-facts-contract.md`。发现 `enterprise-financial-facts/v1` 文件时：

1. 运行 `python3 scripts/validate_financial_facts.py <文件> --company <企业名称>`。
2. 校验企业名称或统一社会信用代码、期间、币种、单位、合并范围和来源证据。
3. 只向其他 Skill 传递 `facts`、`metrics`、`evidence` 和 `quality`；不传递税务违法或申报资格结论。
4. 新财务文件与旧事实冲突时，保留两版来源并停止自动覆盖，直至用户确认正确口径。

形成结构化核验结果后运行：

`python3 scripts/validate_financial_assessment.py <结果.json>`

企业不一致、单位缺失、计算无公式、冲突被静默覆盖或指标缺乏来源时，验证必须失败。
