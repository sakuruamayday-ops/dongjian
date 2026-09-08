---
description: "共创桌面客户端的社区技能目录与隔离安装器。"
kind: "package-reference"
---

# @gongchuang/skill-marketplace

[English](README.md) | 中文

## 概述

共创企业助手技能中心的 Host 服务。它读取内置的 V1.6.7 通用技能包，通过公开 API 检索魔塔 ModelScope 和腾讯 SkillHub。用户点击安装后，社区技能直接写入当前用户的社区技能目录并显示“已安装”，不执行许可证、代码、命令、平台签名或摘要锁定审查，也不会覆盖客户端内置技能。下载归档的摘要只用于生成内容寻址安装身份；注册表不保存未使用的仓库清单摘要或逐文件摘要清单，因此用户本地修改仍保持可用。

## 目录

- [行为](#behavior)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="behavior"></a>
## 行为

客户端还可以添加公开 HTTPS 仓库清单。这是一种纯数据协议，不能加载 Cordis 包或原生代码。兼容清单使用如下结构：

```json
{
  "schemaVersion": 1,
  "id": "example.skills",
  "name": "Example Skills",
  "homepage": "https://example.com/skills/",
  "skills": [
    {
      "coordinate": "@example/report-writer",
      "name": "Report Writer",
      "description": "Create a structured report.",
      "category": "office",
      "version": "1.0.0",
      "archiveUrl": "./report-writer.zip",
      "configurationUrl": "https://example.com/account/integrations/report-writer"
    }
  ]
}
```

清单和归档地址使用 HTTPS。清单只需提供技能名称、版本、简介和压缩包地址；`archiveSha256` 可以保留为上游元数据，但不是安装前提。客户端只完成 ZIP 可读取、目录可写入和 `SKILL.md` 存在等安装所需处理。

搜索请求保留上游市场的 `page`、`pageSize` 和 `total` 字段，让客户端显示真实翻页，而不是把目录截断在第一页。安装前可以从市场卡片进入详情。平台标注“需要配置”不等于社区详情页就是凭据配置地址：魔搭与 SkillHub 技能只有在该精确坐标已经确认官方厂商地址时才自动打开；其余技能只完成安装并提示用户按技能说明自行配置，不自动跳转。自定义仓库清单可以声明公开 HTTPS `configurationUrl`。所有自动跳转均发生在安装完成后。打开网页不会被当成授权成功；工具是否可用仍取决于连接器或凭据验证结果。

共创精选不是固定的第一页快照。它把办公、政策、法律、OCR 和文档交付等稳定核心技能，与企业、知识产权、财务、专利和中文写作等业务相关技能的每日轮换窗口组合起来。上游缺失的条目会被略过，已安装状态由 Host 标记，因此客户端可以准确显示“已安装”，不会虚构本地目录状态。

下载后的技能由独立的社区 Skill 提供器暴露。浏览器不会收到 ZIP 字节或本机文件系统路径。

<a id="dev-note"></a>
## 开发备注

社区技能与已签名内置技能包分离，不能覆盖其文件，也不能仅凭安装获得连接器访问权。

<a id="runtime-invariant"></a>
## 运行时不变式

不发布运行时不变式伴随入口，因为检查由已签名安装事务和服务持有，本包没有自身的持久事件关系。

<a id="model-experience"></a>
## 模型体验

### 已安装社区 Skill 目录

#### 模型看到的内容

已安装且 `SKILL.md` 可读取的社区 skill 会进入共享 `ctx.skills` 提供器。所属 Skill 消费方决定何时向模型提供其名称、说明、指令或随包引用。

#### Token 影响

搜索、详情、翻页和下载检查不增加模型 token。只有 Skill 消费方判定某个已安装 skill 可用或被调用时，该 skill 才会增加相应投影内容的 token。

#### KV Cache 影响

已安装 skill 集合不变时，现有请求前缀保持稳定。安装或替换 skill 会使提供方快照失效，因此后续请求可能收到变化后的 skill 内容。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 社区技能写入独立的用户目录，不覆盖客户端内置技能；客户端不会把社区压缩包当作应用安装包执行。
- ModelScope、SkillHub 和自定义仓库仍是外部可用性依赖。市场搜索不可用时，已缓存的已安装 skill 仍保留在本机。
- 只有已经配置明确厂商地址的社区技能才会在安装后自动进入配置页；其余服务型技能仍可安装，并按技能说明手动配置。
- 打开安装后配置地址不会授予工具访问权；独立的连接器或凭据验证仍须成功。
