# Agent Note: 分平台运行时精简

Status: implemented

[English](2026-08-17-platform-runtime-pruning.md) | 中文

其中保留 LibreOffice 及其链接验签的内容已由[移除安装包内置 LibreOffice](2026-08-21-packaged-libreoffice-removal.zh.md)取代；Python 与目标平台原生依赖精简的决策仍然有效。

## 问题

桌面端打包会复制 Python 构建缓存、目标平台之外的原生模块，还会把 macOS LibreOffice 的目录符号链接展开为第二份实体目录。这些副本增加安装包体积，却没有增加运行能力。若直接移除 Python 或 LibreOffice，又会失去技能脚本执行或本地 Office 转换与渲染能力。

## 决策

桌面端打包排除无法在目标平台和架构上加载的原生模块变体。运行时暂存会忽略 Python 的 `__pycache__`、`.pyc` 和 `.pyo` 文件。

macOS 暂存器保留目标仍位于暂存运行时内部的相对 LibreOffice 链接。运行时索引格式第 2 版分别签署普通文件摘要和链接目标的精确映射。启动验签会拒绝缺失、多出、变化、绝对路径、自引用、断裂或越界的链接，之后才暴露 Python 与 LibreOffice 可执行文件。Windows 安装环境没有统一可靠的符号链接约定，因此 Windows 暂存仍会将来源链接实体化。

Python 叠加层为每个受支持的安装包目标固定一组闭合 wheel。它保留经过审查的 DOCX、XLSX、PPTX 和 PDF 代码库，包括 `python-pptx` 及其必需的 Pillow 与 XlsxWriter 依赖。这三个发行版随 wheel 提供的许可证会留在各自的 `.dist-info` 目录并进入签名运行时索引；准备、暂存和启动验签都会拒绝缺失许可证文件的运行时。暂存与启动验签还要求模块和发行元数据身份完全一致。打包预检随后使用已签名的 Python 可执行文件生成并重新打开上述四种文档格式；PPTX smoke 包含图片、图表及其内嵌工作簿，因而会执行完整的 `python-pptx` 依赖路径。

## 考虑过的备选方案

**从客户端移除 LibreOffice 和 Python。**这样能节省更多空间，但会破坏直接生成 DOCX、Office 转 PDF、文档渲染检查、技能脚本以及经过固定版本的 PaddleOCR 连接器。

**保留每一份依赖副本。**这样能减少打包逻辑，但会分发冗余数据，其中包括 LibreOffice `Frameworks` 目录在 `Contents/MacOS/urelibs` 下的实体副本。

**签名后再删除指定运行时文件。**这样无需修改暂存逻辑即可减小体积，但会使已签名文件集合失效，并把依赖精简变成一份无法验证的路径清单。

## 影响

V0.1 候选中的 macOS arm64 暂存运行时保留 Python、LibreOffice 和 PaddleOCR MCP，同时从约 2.1 GB 降至 1.5 GB。双平台候选均不包含 Python 源码缓存，Electron Builder 声明的每套原生依赖只保留目标平台变体。Electron Builder 会把原生模块作为整体智能解包，因此 Windows x64 的打包后步骤会将未使用的 ARM64 ConPTY 辅助目录移入输出旁可审计的隔离区，同时保留已审核的 win32-x64 预编译组件。

运行时索引格式第 2 版有意不兼容第 1 版。每个运行时候选都必须重新暂存并签名后才能打包。定向暂存与验签测试覆盖内部链接、链接漂移、文件漂移、平台身份、缓存省略和运行能力身份。打包输入验签还会拒绝无法生成并重新打开 DOCX、XLSX、PPTX 或 PDF 文件的签名运行时。
