---
name: web-publisher
version: 0.2.3
description: 将网页文章提取并发布到平台（微信公众号等）
author: Ping Si <sipingme@gmail.com>
tags: [publish, wechat, article, content]
requiredEnvVars:
  - WEB_PUBLISHER_API_URL
  - WEB_PUBLISHER_USER_ID
  - WEB_PUBLISHER_API_KEY
---

# Web Publisher

将任意网页文章自动提取、处理并发布到内容平台。

## 功能

- **文章提取**: 从 URL 自动提取文章内容、标题、作者、封面图
- **图片处理**: 自动下载文章图片，上传到目标平台
- **AI 改写**: 可选的 AI 内容改写（Minimax）
- **平台发布**: 发布到微信公众号（更多平台即将支持）

## 前置要求

### 1. 注册并获取凭证

在 [tools.siping.me](https://tools.siping.me) 注册账号，获取用户 ID 和 API Key。

### 2. 微信公众号 IP 白名单

在微信公众平台 → 设置与开发 → 基本配置 → IP白名单 中，添加服务器 IP（在 [tools.siping.me](https://tools.siping.me) 中查看）。

### 3. 配置环境变量

在 ClawHub 的 Skill 设置中配置以下环境变量：

| 变量 | 说明 |
|------|------|
| `WEB_PUBLISHER_API_URL` | API 服务地址（在 tools.siping.me 中查看） |
| `WEB_PUBLISHER_USER_ID` | 用户 ID |
| `WEB_PUBLISHER_API_KEY` | API Key |

## 给 AI 的使用说明

当用户要求将网页文章发布到微信公众号时，使用以下命令：

- 创建草稿: `scripts/run.js draft <url>`
- 直接发布: `scripts/run.js publish <url>`
- 可选参数: `--theme blackink`, `--rewrite`, `--style casual`

默认创建草稿，不会自动发布。用户明确要求发布时才使用 publish 命令。

## 使用示例

以下是在 OpenClaw 中与 AI 对话使用本 Skill 的示例：

### 示例 1：创建草稿

> 用户：帮我把这篇文章存到公众号草稿 https://mp.weixin.qq.com/s/xxxxx

AI 执行：
```bash
scripts/run.js draft https://mp.weixin.qq.com/s/xxxxx
```

输出：
```json
{
  "success": true,
  "action": "draft",
  "title": "文章标题",
  "mediaId": "media_id_xxx",
  "theme": "blackink"
}
```

### 示例 2：改写后创建草稿

> 用户：把这篇文章改写成轻松的风格，存到草稿 https://example.com/article

AI 执行：
```bash
scripts/run.js draft https://example.com/article --rewrite --style casual
```

### 示例 3：直接发布

> 用户：把这篇文章直接发布到公众号 https://example.com/article

AI 执行：
```bash
scripts/run.js publish https://example.com/article
```

### 示例 4：查询任务状态

> 用户：上次那个发布任务完成了吗？

AI 执行：
```bash
scripts/run.js status job_abc123
```

### 可用选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--theme <name>` | 发布主题 | blackink |
| `--rewrite` | 启用 AI 改写 | 关闭 |
| `--style <style>` | 改写风格 | casual |
| `--prompt <text>` | 自定义改写提示 | - |

## 支持平台

| 平台 | 提取 | 发布 | 状态 |
|------|------|------|------|
| 微信公众号 | ✅ | ✅ | 已支持 |
| 今日头条 | ✅ | - | 计划中 |
| 小红书 | ✅ | - | 计划中 |

## 工作原理

```
URL → news-to-markdown（提取+下载图片）
    → markdown-ai-rewriter（可选，AI 改写）
    → wechat-md-publisher（上传图片+发布）
```

## 安全说明

- 此 Skill 不安装任何本地包，仅通过 HTTP API 调用远程服务
- API Key 通过环境变量传递，不硬编码
- 默认使用 draft 模式，不会自动发布
- 所有操作可在 tools.siping.me 审计
