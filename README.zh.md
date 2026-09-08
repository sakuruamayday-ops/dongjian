# 洞见

[English](README.md) | 中文

面向项目申报、企业咨询和知识产权工作的桌面 AI 客户端。

## 功能

- 企业空间：按企业组织资料、项目对话和交付文件。
- 资料阅读：导入文档和图片，整理信息、核对差异。
- 项目申报辅助：通过内置专业技能辅助政策检索、项目匹配、材料撰写和一致性检查。
- 文件交付：生成文档与表格，在本机打开并继续编辑。
- 自动任务：处理定时工作；需要客户端保持运行。
- 模型与 MCP：自行配置模型服务，按需接入知识库和其他 MCP 服务。

## 使用与限制

<a id="run"></a>

无需注册产品账号。首次使用配置自己的模型；知识库需要单独配置 MCP 地址和访问凭据。

资料与会话保存在本机；模型和外部工具调用会向所选服务发送相关任务内容，不是完全离线运行。AI 输出需要人工复核。

0.1.0 是测试候选。macOS Apple Silicon 包已通过隔离首次启动与设置检查；Windows、Intel Mac 和真实外部模型调用尚未验证。当前 Mac 包采用 ad-hoc 签名，未做 Apple 公证，下载后可能被系统安全机制拦截。安装文件通过本仓库 Releases 提供，不通过产品网站分发。

## 项目资料

[功能介绍](docs/product/洞见-功能简介.md) · [验证记录](docs/product/洞见-验证记录.md) · [产品文档](docs/product/洞见-产品文档.md)

## 开源基础与许可

<a id="run-from-source"></a>

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 Cordis 构建。保留上游版权与许可声明；桌面产品发行不等同于上游官方发行。

[MIT 许可](LICENSE) · [第三方许可声明](THIRD_PARTY_NOTICES.md) · [开发文档](docs/development.zh.md)
