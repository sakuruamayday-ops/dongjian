# Agent Note: 旧式 Office 容器分流

Status: implemented

[English](2026-08-31-legacy-office-container-dispatch.md) | 中文

## 问题

受签名企业空间文档操作原先能读取 DOCX、XLS 与 XLSX，但不能读取 Word 97-2003 DOC。把 `.doc` 或 `.wps` 后缀直接当作格式不安全：Word 与 Excel 都使用 OLE 复合文件容器，WPS 后缀又可能对应 OOXML、RTF、兼容 OLE、专有、损坏或加密内容。如果直接在 Electron 主进程解析不可信 OLE，还会把文档解析器风险带入桌面宿主信任边界。

## 决策

V1 受签名操作 schema 保持不变。已验证 Python 文档检测器先在现有无网络、只读沙箱中运行。只有它返回精确的结构化结果，同时声明 `detected_kind: doc`、`.doc` 或 `.wps` 后缀且状态为 `conversion_required`，宿主才可选择旧式 Word 适配器。改错后缀的 Excel、未知 OLE、加密 Office、OOXML 与 RTF 都继续走 Python 路径。

V1 schema 保持稳定，同时把单个文件参数的扩展名允许清单容量从 16 提升到 32，以容纳现有 Office 与模板格式族，包括 `.dotm`、`.xltx` 与 `.xltm`。这不会把后缀变成格式断言，也不会绕过内容检测。

适配器在第二个固定 Node/Electron 子进程中运行 `word-extractor` 1.0.4，两个子进程共用同一沙箱、超时、取消、输出、企业空间和签名脚本回执边界。模型不能控制源码、模块路径、环境或参数形状。`ELECTRON_RUN_AS_NODE=1` 使同一启动方式可用于打包后 Electron。解析器依赖不可用属于宿主错误；不受支持的旧式 Word 内容返回不重试的转换结果。

子进程使用 Python 提取结果 schema，不自造后缀字段，不执行宏、公式或外部链接，并把文档文字限制为 400,000 个 UTF-8 字节。这为 JSON 转义与回执元数据预留了足够空间，保持在受签名的 1 MiB 进程输出上限之内。

## 曾考虑的替代方案

**内置 LibreOffice 或自动操作已安装 Office。** 不采用，因为运行时与缓存成本高达数百 MB，不能保证每台设备都已安装，GUI 或 COM 自动化具有平台局限，并且都会扩大可信执行面。

**仅按后缀与 OLE 魔数分流。** 不采用，因为改名后的 XLS 具有相同文件头，会被错误移出现有 Excel 提取器。

**在 Electron 主进程加载解析器。** 不采用，因为格式损坏的客户文档必须与桌面宿主进程保持隔离。

## 影响

真实 Word 97-2003 文件可以在不安装 Word、LibreOffice、不联网且不加载原生扩展的条件下读取。实际为 Word 兼容 OLE 的 `.wps` 文件可复用同一路径，专有 WPS 二进制文件则会获得明确转换结果。该功能不承诺通用恢复加密、损坏或厂商私有格式。

回归测试会在子进程中运行非敏感的真实 DOC 样例，证明真实 Excel OLE 样例即使改名为 `.wps` 也不能进入 Word 子进程，核对两个子进程共用受签名只读回执，并用最坏转义输出验证不超过 1 MiB 上限。
