# DeepSeek Harness RC.8 底座兼容矩阵与升级说明

[English](deepseek-harness-rc8-compatibility.md) | 中文

## 1. 文档定位

本文是共创企业助手的内部维护资产，只描述 V0.1.3 当前采用的 DeepSeek Harness 底座、共创扩展边界、必要补丁和可选升级时的检查顺序。它不是对上游未来版本的兼容承诺，不要求产品持续跟随上游，也不构成 V0.1.3 的发布门禁。

客户端稳定后由共创团队自行维护。未来是否吸收新的 DeepSeek Harness 版本，须由维护者主动立项、评估和验证；上游 developer preview、未来破坏性变更和版本节奏均不属于当前产品范围或当前发布风险。

## 2. 当前底座身份

| 项目 | 当前值 | 维护说明 |
| --- | --- | --- |
| 上游项目 | `deepseek-ai/deepseek-harness` | 仅记录来源，不向该仓库发布共创版本 |
| 底座版本 | `0.1.0-rc.8` | V0.1.3 本次固定架构 |
| 上游提交 | `141eb6fef83422698aef7a981029e843e8161531` | 内部差异审计起点 |
| 共创客户端 | `0.1.3` | 独立产品版本 |
| 共创技能套件 | `1.6.7` | 独立签名与更新 |

## 3. 共创扩展边界

| 边界 | 当前挂载方式 | 主要位置 | 回归重点 |
| --- | --- | --- | --- |
| 产品界面 | Client slot 注入侧栏、覆盖页和输入框工具 | `packages/client/ui-gongchuang-product` | 中文界面、企业空间、输入区、可访问性 |
| Client 启动 | inert boot manifest 与 CSP 安全 bootstrap | `packages/client/modules`、`packages/client/web` | `__ModuleLoader__`、`__DSH_BOOT__`、动态模块装载 |
| Host 能力 | Remote API 与产品 Host 组合 | `packages/api/remotes`、`packages/host`、`apps/desktop` | schema、挂载 namespace、Electron 预加载与 CSP |
| 产品身份 | 产品清单、Cordis patch 与版本源 | `product/gongchuang-client` | 客户端、策略、底座和技能版本一致 |
| 专业能力 | 签名技能套件及其运行时、市场投影 | `packages/product/gongchuang-signed-skill-runtime`、`packages/skill/gongchuang-skill-marketplace` | 签名、索引、安装、更新和来源许可 |
| 安全边界 | 既有 Host 确认、策略门禁与凭据隔离 | `packages/guard`、`apps/desktop` | 发布、提交、发送、删除和外部动作 |

## 4. 当前必要底座补丁

这些补丁只用于当前 RC.8 与共创产品组合，不建立自定义 ABI 或独立兼容层：

1. Electron Host 使用 `script-src 'self'`。boot manifest 必须保持 inert JSON，启动代码使用同源外部脚本或等价的 CSP 安全接口，禁止 `unsafe-inline`。
2. Client Modules 保留 RC.8 模块装载类型与启动入口，并用真实 Electron 启动冒烟验证 manifest、loader 和 boot 状态。
3. Remote API 必须挂载 RC.8 所需的文件引用与会话引用 namespace；schema 与实际 `$mount` 列表同时回归。
4. 共创 UI 对 RC.8 的 `openFile(): void`、Workspace `home`、输入错误展示等接口采用产品侧适配，不把共创业务逻辑写入没有扩展接口的上游核心。
5. Web Client 遵守 RC.8 动态插件边界，产品功能通过 slot、插件和产品清单进入。

## 5. 可选升级时的差异检查顺序

只有维护者主动决定评估新底座时，才执行以下顺序：

1. 记录拟评估的上游版本与提交，比较 `141eb6fef8` 至目标提交的模块装载、Remote schema、Client slot、Web bootstrap 和 Electron 安全变化。
2. 先运行未带共创产品扩展的上游启动与类型检查，区分上游回归和产品适配问题。
3. 逐层恢复 Remote API、模块 bootstrap、产品 slot、产品清单和签名技能运行时。
4. 执行下列启动兼容与共创插件回归；测试不通过时停止升级评估，现有 RC.8 产品线不受影响。
5. 只有新底座取得独立产品决定、完整回归和候选证据后，才修改产品版本文档。

## 6. 当前回归命令

```bash
pnpm exec vitest run \
  packages/client/web/tests/boot.client.spec.ts \
  packages/client/modules/tests/node-half.client.spec.ts \
  packages/host/apiproxy/tests/rpc-schemas.spec.ts

pnpm exec vitest run packages/client/ui-gongchuang-product/tests

pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json
pnpm exec tsc --noEmit -p packages/client/web/tsconfig.json
pnpm exec tsc --noEmit -p packages/client/ui-gongchuang-product/tsconfig.json

pnpm run test:gui
pnpm run typecheck
```

真实 Electron 或打包候选的 CSP 启动冒烟必须另行执行并回填产品文档 TST-13；普通 GUI 单元测试不模拟浏览器 CSP，不能替代该证据。
