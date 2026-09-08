# Agent Note: 桌面端进程级浏览器会话

Status: implemented

[English](2026-08-29-desktop-process-local-browser-session.md) | 中文

## 问题

通用 Web 应用会持久化浏览器 cookie 签名密钥，使已有浏览器可在 Host 重启后继续连接。Electron 桌面壳每次启动都会打开新的已认证 loopback URL，因此跨进程复用 cookie 对桌面工作流没有收益。通过产品凭据提供器持久化这一传输专用密钥，会使 Connection 激活依赖操作系统凭据访问。临时签名的 macOS 构建具有变化的代码身份，钥匙串对旧身份的授权可能一直阻塞 profile 激活，直至用户回应提示。账号、模型、MCP 和连接器密钥仍需受保护的持久存储，但可重新生成的 loopback cookie 密钥不需要。

## 决策

`dsh-client-connection` 提供 `persistentBrowserSession`，默认值为 `true`。默认行为为 Web、CLI 和既有组合保留凭据支持的密钥与跨重启 cookie。

该选项为 `false` 时，`BrowserAuth` 生成 32 字节的密码学随机签名密钥，并存入由应用根 context 持有的 `WeakMap`。同一根 context 下的 Connection 重载会保留启动令牌与签名密钥。新根 context 会取得新令牌与新密钥，拒绝此前根 context 的 cookie，并用本次启动令牌交换新的 authority 绑定 cookie。cookie HMAC 校验、绝对有效期、Host 与 Origin 检查，以及完整 Host API 的统一认证均不改变。

共创 Electron 产品将 `persistentBrowserSession` 设为 `false`。该组合中的 Connection 激活不读取或修改浏览器会话凭据记录。凭据提供器仍保持挂载，并继续通过既有操作系统后端保护用户账号、模型、MCP 与连接器引用；本决策不改变这些凭据的格式、生命周期或授权行为。

本决策仅对桌面组合部分取代[浏览器启动令牌认证](2026-08-24-browser-token-authentication.zh.md)中的持久密钥选择。启动令牌交换、cookie 语义、请求信任及默认持久行为仍由该说明约束。

## 验证

BrowserAuth 测试证明同一根 context 能在 Connection 重载后继续使用进程级 cookie，不同根 context 会拒绝该 cookie，并能立即交换本次启动令牌。Host Connection 测试预置一条无关凭据记录，证明进程级激活既不读取、修改，也不替换该记录；默认激活仍会创建持久浏览器会话记录。产品组合测试证明只有桌面覆盖层选择进程级模式，并把 trusted-host 列表固定为产品的 loopback-only 配置。

## 曾考虑的替代方案

**继续持久化签名密钥并依赖稳定应用签名。** 稳定分发身份是避免用户凭据重复授权的正确长期方案，但并非所有本地或临时构建都具备该条件。桌面 loopback 密钥没有足以阻塞启动的持久化需求。

**在 profile ready 后加载持久密钥。** 延后认证会产生前端 URL 无法交换的阶段，或需要引入第二套就绪状态。进程级密钥可同步就绪，并保留现有认证顺序。

**以明文保存桌面签名密钥或弱化操作系统凭据检查。** 这会通过降低密钥保护来保留跨进程 cookie。进程级轮换只放弃桌面端不需要的 cookie 复用，同时继续保护持久化用户密钥。

**凭据访问被拒后删除或轮换浏览器会话记录。** 读取或替换该记录仍会进入可能在报告失败前弹出提示的操作系统凭据路径。桌面传输密钥不进入该路径，才能直接移除这项启动依赖。

## 后果

Electron 进程重启会使此前的 loopback cookie 失效，即使浏览器在其标注的过期时间前仍保留该 cookie。桌面壳会通过新的启动令牌 URL 立即替换它，不涉及用户登录或模型凭据。被窃取的桌面 cookie 也会在应用根 context 结束时失去权限。

Web 与 CLI cookie 默认仍可跨 Host 重启。禁用持久化的组合必须为每个新根 context 提供可靠的启动令牌交换，否则浏览器会持续收到 401，直至以已认证 URL 重新打开。

真实账号、模型、MCP 或连接器密钥仍可能要求操作系统授权，且不得绕过。本决策只从同步桌面 profile 激活路径中移除传输密钥的凭据操作。
