# 待发送注释删除后重排

日期：2026-09-07。需求：FIX-0907-08。状态：代码、组装浏览器和最终包验证通过，已随 [V0.4.6 发布](2026-09-07-v0.4.6-release.md)。

## 行为与边界

待发送条目始终按当前顺序显示为 1 至 N。删除中间条目时保留引文和评论的对应关系；清空后下一条为 1；原消息标记同步编号。浏览器和桌面原生草稿恢复时，旧的非连续编号也归一化。已发送消息中的编号及用户手写的正文、评论保持原样。

重排不会被当作用户编辑。发送成功时消费已提交的引文，保留发送期间新增、修改和重新添加的条目，并对剩余草稿重排。未修改 Session 格式、权限、签名、模型路由或文件打开方式。

## 验证

- 定向单元测试：`pnpm exec vitest run packages/client/ui-gongchuang-product/tests/annotation-drafts.client.spec.ts packages/client/ui-gongchuang-product/tests/annotation-markers.client.spec.ts packages/client/ui-gongchuang-product/tests/composer-draft-persistence.client.spec.ts`，3 文件、40 项通过。
- 客户端与 Host 界面回归：`pnpm run test:gui`，331 文件、4439 项通过、1 项跳过，日志 `/private/tmp/gongchuang-annotation-renumber-gui.log`。40 项定向测试包含在此范围内，不重复累计。
- Host 与 Client TypeScript 构建通过；完整 Web 构建通过。最终执行 `DSH_SNAPSHOT=replay pnpm run test:web:built apps/web/tests/annotation-message.e2e.ts`，1 项组装浏览器场景通过，日志 `/private/tmp/gongchuang-annotation-renumber-web-final.log`。
- 浏览器场景真实操作三段选文、移除、清空、重新添加、刷新恢复、评论编辑、仅注释发送、历史回放、浅深色原消息标记及桌面和窄窗口布局。已查看 `annotation-panel-1280.png` 和 `composer-390.png`：重排后显示注释 1，引文和评论对应，文件与注释在输入框内；手写正文中的编号原样保留。
- 改动的 5 个代码和测试文件通过定向 Oxlint；`git diff --check` 通过；两组说明文档配对检查通过。

首次浏览器启动因 `fs-ext` 留有 x86_64 原生依赖而失败，使用 `npm rebuild fs-ext` 恢复当前 ARM 测试环境。第二次失败是新增测试动作未把原文滚动到可见位置，已在选文助手中补上滚动后再执行真实鼠标选择。两次失败原日志保留在 `/private/tmp/gongchuang-annotation-renumber-web.log` 和 `/private/tmp/gongchuang-annotation-renumber-web-retry.log`，不记作通过。

浏览器测试使用合成文本及具名附件测试入口，不上传客户资料，其本身不代表新安装包验收或正式发布。截图输出在仓库 `.artifacts/numbered-annotations/`。后续三端最终包验收及服务器正式事务已完成，见上述发布记录；用户升级到 V0.4.6 后生效。
