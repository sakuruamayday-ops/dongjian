# Agent Note: CSP 安全的客户端启动

Status: implemented

[English](2026-08-20-csp-safe-client-bootstrap.md) | 中文

## Problem

RC.8 浏览器启动流程通过可执行的内联脚本安装 `window.__ModuleLoader__` 并写入宿主图。桌面宿主有意发送不含 `unsafe-inline` 的 `script-src 'self'`，因此 Chromium 会在 parser 预载模块 bundle 登记前拒绝这两个脚本。单元测试直接执行源码，没有覆盖生产 CSP。

CSP 安全的标记仍然依赖完整的打包客户端图。`ClientModuleRegistry` 在输出该图之前会同步定位包清单。如果打包宿主解析器只提供 `internal.import`，却没有 Loader v2 的 `resolveSync` 操作，registry 就会退回隔离 profile 的入口 URL；该位置创建的 `createRequire` 无法看到 `app.asar` 中的包。组合结果因而没有客户端 entry 或 batch，外部登记门面停留在 `queue` 模式，也不会预载任何客户端模块。

## Decision

`@deepseek-ai/dsh-client-modules` 通过现有同源路由把响应无关的登记门面提供为 `/plugins/bootstrap.js`。其 index 转换依次输出阻塞式外部脚本、不可执行的 `#dsh-boot-manifest` `application/json` 元素和 modules/runtime parser 预载项。Web 内核读取不可执行元素，只把 `window.__DSH_BOOT__` 保留为嵌入兼容输入。

打包宿主安装 Loader v2 内部解析器，其 `import` 与 `resolveSync` 操作共用同一个以宿主为锚点的解析函数。相对 specifier 保留 `parentUrl` 语义，文件 URL 与绝对路径保留其直接身份，裸 specifier 则通过宿主包的 `createRequire` 锚点解析，包括存放在 `app.asar` 中的包；Node 内置模块通过 `isBuiltin` 识别，并规范为 `node:` URL。因此，同步清单发现与异步模块加载看到的是同一个包图。

fallback 会报告 Node 的实际格式，而不是把所有已解析 URL 都视为 ESM：`.mjs` 为 `module`，`.cjs` 为 `commonjs`，`.json` 为 `json`，`.wasm` 为 `wasm`，`.js` 或无扩展名文件则服从最近的包 `type`。受支持的 JavaScript、JSON 与 Wasm `data:` 媒体类型也取得对应格式。JSON 必须携带 `type: json` import attribute；其他 attribute、不受支持的 data 媒体类型或文件扩展名，以及非 evaluation phase 都会明确失败，因为这个打包 fallback 不宣称实现完整的 Node 内部 loader 协议。

桌面生命周期验收会在打包渲染器完成 `loadURL` 后探测启动状态：图元素必须是不可执行 JSON，loader 必须进入 `live` 模式，文档不得包含可执行内联脚本。打包验收还会捕获渲染器错误，并拒绝内联脚本 CSP 违规。

## Verification

App-boot 回归测试覆盖裸、相对、文件 URL、绝对和内置 specifier 的 `resolveSync` 与 `import`，并固定 CJS、受包类型约束的 JavaScript、JSON、Wasm 与 `data:` 格式，以及 import attribute 和 phase 的拒绝行为。使用真实桌面 `app.asar` 直接组合 Loader、WebServer 与 ClientModules 后，结果包含一个客户端 entry 和一个含 `@deepseek-ai/dsh-client-modules` 的 bootstrap batch；生命周期验收仍是最终的打包 Chromium/CSP 检查。

## Alternatives considered

- **在桌面 CSP 中允许 `unsafe-inline`。** 这能让 RC.8 启动，但会削弱整个渲染器的可执行脚本策略，并掩盖后续内联回归。
- **增加逐响应 nonce 或源码哈希。** 启动源码不随响应变化，可以作为普通同源资源提供，因此 nonce 生成与传递只会增加策略状态，不会提供必需能力。
- **只把登记门面放进产品外壳公共资源。** Modules 包拥有登记协议，也负责提供 parser 预载 bundle；让每个外壳维护对应启动副本会造成协议与实现的版本漂移。
- **保留仅支持 import 的宿主解析器并依赖 registry fallback。** fallback 以 profile 入口 URL 为锚点，而该位置有意与打包应用隔离。它无法发现 `app.asar` 包清单，并会静默组合出空客户端图。

## Consequences

启动流程会在 parser 预载前增加一次阻塞式同源请求。启动图数据不再可执行，桌面端继续使用不含内联例外的 `script-src 'self'`。打包解析器必须让同步发现、格式分类与异步加载使用同一个宿主锚点；单独修改其中一项，都可能把有效的 CSP 文档变成空启动图或错误类型的启动图。不受支持的 loader 功能会在解析器处停止，而不会取得误导性的 `module` 语义。Node 侧、Web、app-boot、直接 ASAR 组合和生命周期验收共同覆盖从源码到打包产物的路径。
