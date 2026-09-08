# V0.4.4 发布后问题修复

状态：代码修复与下列定向验证完成，已随 V0.4.5/V1.6.19 正式发布；[正式事务与公网验收](2026-09-07-v0.4.5-release.md)。历史 V0.4.4 发布证据保持不变。

| 编号 | 修复范围 | 验证 | 发布 |
| --- | --- | --- | --- |
| FIX-0907-01 | 旧会话的显示文本、费用、调度位置、交付状态和旧模型续接记录迁移 | 本机119份v0日志只读转换至v2通过；[兼容与拒绝测试](../../../packages/session/session-format-v0-to-v1/tests/product-migration.spec.ts)通过 | [正式发布](2026-09-07-v0.4.5-release.md) |
| FIX-0907-02 | 长消息原位注释编号、跨轮次同号区分 | [浏览器回放](../../../apps/web/tests/annotation-message.e2e.ts)通过，1280和390宽度截图确认；[编号测试](../../../packages/client/ui-gongchuang-product/tests/annotation-markers.client.spec.ts)通过 | [正式发布](2026-09-07-v0.4.5-release.md) |
| FIX-0907-03 | 文件路径精确去重与跨空间附件引用 | [文件卡测试](../../../packages/client/ui-deliverables/tests/produced-files.client.spec.tsx)、[附件复制测试](../../../packages/guard/gongchuang-policy-gate/tests/fork-imports.spec.ts)、[创建前失败测试](../../../packages/api/session-controller/tests/commands-create-fork.host.spec.ts)通过 | [正式发布](2026-09-07-v0.4.5-release.md) |
| FIX-0907-04 | 归档空间深链接、自动任务结果导航及失败反馈 | [深链接](../../../packages/client/ui-gongchuang-product/tests/session-deep-link.client.spec.ts)、[结果导航](../../../packages/client/ui-gongchuang-product/tests/automation-result-navigation.client.spec.ts)和GUI回归通过；未声称原生协议回调重新验收 | [正式发布](2026-09-07-v0.4.5-release.md) |
| FIX-0907-05 | 自动任务区分轮次结束与业务结果待处理 | [等待、草稿、暂停、失败及正式状态](../../../packages/client/ui-gongchuang-product/tests/automation-session.client.spec.ts)和[产品插件装配](../../../packages/client/ui-gongchuang-product/tests/client-plugin-injection.invariant.client.spec.ts)通过；不代表重新执行所有真实定时业务 | [正式发布](2026-09-07-v0.4.5-release.md) |
| FIX-0907-06 | 模型凭据读取失败后的配置状态收尾 | [凭据读取与诊断同时失败的故障注入](../../../packages/product/gongchuang-model-connections/tests/model-connections.spec.ts)通过；未修改真实密钥 | [正式发布](2026-09-07-v0.4.5-release.md) |
| FIX-0907-07 | 财税报告合法指标被数量限制拒绝、来源表静默截断 | 技能仓库16项测试及16个子测试通过；19条合成指标完整进入18页PDF，[交付检查](/Users/zsh/JiaotangData/test-evidence/review-repairs-20260907/gc-review-source-pages/delivery.json)通过，来源页无重叠 | [正式发布](2026-09-07-v0.4.5-release.md) |

原始会话不覆写、不删除；正式升级仍由相邻迁移器生成新版文件。自动任务保持有界结束，不因未达到正式交付状态自动重跑。修复不更换当前底座、不修改密钥；正式发布事务已切换线上更新源。

## 验证记录

- 定向迁移、文件、导航、自动任务、模型配置：17个测试文件355项通过；最后的迁移类型与附件语法调整另以4个文件34项复测通过，统计不相加。
- GUI及Host界面支持回归：331个文件，4433项通过、1项既有跳过、0失败；[JSON报告](../../../.artifacts/review-repairs-gui.json)。初轮1项测试夹具遗漏真实Turn数据容器，补齐后重跑全组通过。
- `pnpm run build`通过；最后的Host与Client `tsc -b`通过。改动源文件Lint扫描余下2条既有错误，均位于policy-gate原有未改行：字符串码点展开及不必要可选链；不声称仓库Lint全绿。
- 桌面和窄屏注释截图：[1280](../../../.artifacts/numbered-annotations/long-reply-markers-1280.png)、[390](../../../.artifacts/numbered-annotations/long-reply-markers-390.png)。浏览器使用合成回放和OS边界替身，不冒充真实模型、Finder或安装包测试。
- 财税验证命令：技能仓库内 `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest tests/test_financial_facts.py tests/test_portable_report.py -q`。PDF来源页：[第一页](/Users/zsh/JiaotangData/test-evidence/review-repairs-20260907/gc-review-source-pages/pdf-page-16.png)、[续页](/Users/zsh/JiaotangData/test-evidence/review-repairs-20260907/gc-review-source-pages/pdf-page-17.png)。17个基础页面不变，仅来源表按容量加页；PDF页数与生成器回执一致，每页水印仍须通过检查。
- 后续三端打包、ARM 隔离安装生命周期、正式发布与公网回读已完成，见本版发布记录；未声称对原生历史会话逐一打开或重新覆盖全部技能业务。
