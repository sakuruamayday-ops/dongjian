# Dongjian

English | [中文](README.zh.md)

A desktop AI client for project applications, enterprise consulting, and intellectual-property work.

## Features

- Enterprise spaces: organize each enterprise's materials, conversations, and deliverables.
- Document reading: import documents and images to organize information and compare changes.
- Application assistance: use bundled professional skills for policy research, project matching, drafting, and consistency checks.
- File delivery: generate documents and spreadsheets for local review and editing.
- Scheduled tasks: run recurring work while the desktop client remains running.
- Models and MCP: configure your own model service and connect optional knowledge bases and other MCP services.

## Usage and limitations

<a id="run"></a>

No product account is required. Configure your own model on first use; knowledge services require a separate MCP address and access credentials.

Materials and conversations are stored locally. Model and external-tool calls send relevant task content to the selected services, so this is not a fully offline application. AI output requires human review.

Version 0.1.0 is a test candidate. The macOS Apple Silicon package has passed isolated first-launch and settings checks. Windows, Intel Mac, and live external-model calls remain unverified. The Mac package is ad-hoc signed and is not Apple-notarized; macOS may block downloaded copies. Distribution archives are provided through this repository's Releases, not through a product website.

## Project references

[Features](docs/product/洞见-功能简介.md) · [Verification](docs/product/洞见-验证记录.md) · [Product document](docs/product/洞见-产品文档.md)

## Upstream and license

<a id="run-from-source"></a>

Built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and Cordis. Upstream copyright and license notices are retained. This desktop product is not an official upstream release.

[MIT license](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md) · [Development](docs/development.md)
