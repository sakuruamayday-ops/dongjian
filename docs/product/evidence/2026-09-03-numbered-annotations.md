# 编号注释与附件排列验证

日期：2026-09-03。关联需求：REQ-85，测试编号：TST-80。

状态：候选实现已验证，未发布。正式安装包仍为 V0.4.2；本记录不替代安装包、真实模型或正式发布验收。

## 实现范围

- 选文“添加到对话”进入独立编号注释，不向输入框插入 Markdown 引用。数量入口可展开、评论和逐条移除；移除前项不改变其他编号。
- 附件和注释共用输入框最大宽度、左右留白和换行规则；长文件名省略显示，窄窗口自动换行。
- 文件卡片继续调用现有受控系统应用打开链，不新增客户端预览，不创建对话。
- 注释按会话保存，刷新后恢复；仅注释也可发送。失败保留，成功只消费本次快照，发送期间的新内容和编辑保留。
- 已发送消息、发送回显与插话回显重建相同注释；排队摘要只显示文件名、注释数量和正文，不显示元数据。
- 带独立显示文本的排队消息不允许纯文本原位编辑，避免丢失模型上下文；普通消息编辑、删除和插话操作保留。
- 专业意图识别只读取本次正文和评论，不把引文当成新指令或新事实；原有权限、专业校验和交付检查不变。

## 可复现验证

以下命令在客户端仓库根目录运行。[原始日志](/Users/zsh/JiaotangData/test-evidence/gongchuang-v0.4.3-20260903/source-tests/)与[截图](2026-09-03-numbered-annotations/)分别保留；日志未作格式改写。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 完整构建 | `pnpm run build` | Host、Client 类型和产物构建通过 |
| 客户端与 Host GUI 回归 | `pnpm run test:gui` | 319 个文件通过，4222 项通过、1 项跳过 |
| 注释与专业意图、队列状态 | `pnpm exec vitest run packages/guard/gongchuang-policy-gate/tests/annotation-intent.spec.ts packages/guard/gongchuang-policy-gate/tests/gongchuang-policy-gate.spec.ts packages/client/ui-gongchuang-product/tests/annotation-drafts.client.spec.ts packages/api/session-controller/tests/queue-store.client.spec.ts` | 4 个文件、115 项通过 |
| 排队摘要与附件组合 | `pnpm exec vitest run packages/client/ui-gongchuang-product/tests/annotation-drafts.client.spec.ts packages/client/ui-conversation/tests/queue-dock.client.spec.tsx packages/api/session-controller/tests/queue-store.client.spec.ts` | 3 个文件、57 项通过，亦被后续 GUI/状态回归覆盖 |
| 组装浏览器 | `DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/annotation-message.e2e.ts` | 1 项通过，覆盖 1280×900 与 390×844；页面错误为 0 |
| 修改文件静态检查 | `pnpm exec tsx scripts/run-oxlint.ts <本轮修改的 TypeScript 文件>` | 通过，无诊断 |
| UI 文案归属 | `pnpm exec tsx scripts/verify-client-ui-i18n.ts` | 483 个 Client UI 源文件通过 |

浏览器使用真实 Loader、构建后的产品组件、原生文本选择手势及持久化 Session。覆盖选择器导入、拖入文件、点击打开调用、附件与注释共存、删前项后编号稳定、评论、刷新恢复、仅注释发送、回执消费及历史回看。模型采用录制响应；系统文件导入和打开接口使用受控文件名及调用记录，不调用用户的真实账户或企业文件。

## 实际截图

以下为测试页面实际截图，使用脱敏测试文件名，不是正式安装包或真实业务交付截图。

### 宽窗口

![附件与注释同列排列](2026-09-03-numbered-annotations/composer-1280.png)

### 窄窗口

![附件自动换行且与输入框对齐](2026-09-03-numbered-annotations/composer-390.png)

### 注释展开

![编号、引文和评论](2026-09-03-numbered-annotations/annotation-panel-1280.png)

首次缩窗截图位于侧栏收起动画中途。后续场景使用系统“减少动态效果”偏好并重新核对布局，附件与注释均在输入框列内；没有因此修改侧栏行为。

## 验证与发布边界

- 本轮没有覆盖安装、升级、签名和生产发布，不更改版本号，不修改已发布制品。
- 本轮证明文件卡点击仍进入既有系统打开回调，不等于新版安装包已在 WPS、Word、Excel 上重新验收。V0.4.2 的原生打开证据保持为历史版本证据。
- 草稿保存在本机同一会话，不提供跨设备同步。历史 Markdown 引用不自动迁移为编号注释。
- 初次完整构建错误生成在源码旁的 356 个编译文件已按本轮时间与源码对应关系移入 `/Users/zsh/.Trash/gongchuang-annotation-tsc-emissions-20260903-1426`；未永久删除文件。

## 四问复盘

1. **最没有把握的事项**：新安装包与各系统默认应用的组合尚未在本轮重测，不能用浏览器回调测试代替。
2. **遗漏检查**：同类扫描补到了附件导入、拖入、排队和历史回看；排队中的附加内容暂不支持原位纯文本编辑，限制已明确。
3. **最有价值的改进**：让发送前、发送后和排队摘要共用同一消息投影，避免文件或注释在某一状态退回内部文本。本轮已落实。
4. **效率改进**：沿用同一个产品 Loader 场景，同时验证状态流转与宽窄布局；先区分外部接口模拟、录制模型和真实产品组件，避免重复调试测试环境。
