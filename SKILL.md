---
name: web-publisher
version: 0.3.4
description: 本地提取网页文章内容，发布到微信公众号（支持知乎、头条、36kr、CSDN 等）
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

### 3. 安装本地依赖

```bash
npm install -g news-to-markdown
```

### 4. 配置环境变量

在 ClawHub 的 Skill 设置中配置以下环境变量：

| 变量 | 说明 |
|------|------|
| `WEB_PUBLISHER_API_URL` | API 服务地址（在 tools.siping.me 中查看） |
| `WEB_PUBLISHER_USER_ID` | 用户 ID |
| `WEB_PUBLISHER_API_KEY` | API Key |

## 给 AI 的使用说明

当用户要求将网页文章发布或保存到微信公众号时，使用以下命令：

- 创建草稿: `scripts/run.js draft <url>`
- 直接发布: `scripts/run.js publish <url>`
- 可选参数: `--theme blackink`, `--rewrite`, `--style casual`

**注意**：
- 默认创建草稿，不会自动发布。用户明确说「发布」时才使用 publish 命令。
- 本地提取内容可能需要 30-60 秒，属正常现象。
- 若提取失败提示未安装 news-to-markdown，请提醒用户运行 `npm install -g news-to-markdown`。

## 使用示例

以下是在 OpenClaw 中与 AI 对话使用本 Skill 的示例：

### 示例 1：知乎/头条文章存为草稿

> 用户：把这篇知乎文章存到公众号草稿 https://zhuanlan.zhihu.com/p/xxx

```bash
scripts/run.js draft https://zhuanlan.zhihu.com/p/xxx
```

### 示例 2：微信文章存草稿

> 用户：帮我把这篇微信文章存到公众号草稿 https://mp.weixin.qq.com/s/xxxxx

```bash
scripts/run.js draft https://mp.weixin.qq.com/s/xxxxx
```

### 示例 3：改写后存草稿

> 用户：把这篇文章改写成轻松的风格，存到草稿 https://36kr.com/p/xxx

```bash
scripts/run.js draft https://36kr.com/p/xxx --rewrite --style casual
```

### 示例 4：直接发布

> 用户：把这篇文章直接发布到公众号 https://example.com/article

```bash
scripts/run.js publish https://example.com/article
```

### 示例 5：查询任务状态

> 用户：上次那个发布任务完成了吗？

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

| 平台 | 提取 | 发布 | 备注 |
|------|------|------|------|
| 微信公众号 | ✅ | ✅ | |
| 今日头条 | ✅ | - | |
| 知乎 | ✅ | - | |
| 36kr | ✅ | - | |
| 人人都是产品经理 | ✅ | - | |
| CSDN | ✅ | - | |
| 小红书 | ✅ | - | 部分内容需登录 |

## 工作原理

```
URL → 本地 news-to-markdown（提取 Markdown）
    → 服务器 markdown-ai-rewriter（可选，AI 改写）
    → wechat-md-publisher（上传图片+发布）
```

## 安全与信任说明

### 数据流

1. **本地**：`news-to-markdown` 从目标网页提取 Markdown 文本
2. **发送到服务器**：原始 URL + 提取的 Markdown 内容 + 你的 API Key
3. **服务器端**：从 Markdown 中的图片 URL 下载图片（会访问原始网页的图床），上传到微信，最终调用微信 API 创建草稿或发布

> ⚠️ 服务器会收到原始 URL 和全文内容，并在发布时从原图片地址下载图片。

### API 凭证与授权

- `WEB_PUBLISHER_API_KEY` 允许远程服务以你的身份向微信公众号发布内容——这是高权限操作
- IP 白名单（第 2 步）授权远程服务器 IP 直接调用微信 API，请确认你信任该 IP 归属方
- 服务提供方为 [tools.siping.me](https://tools.siping.me)，源码可在 [github.com/sipingme/web-publisher-skill](https://github.com/sipingme/web-publisher-skill) 查看

### 其他

- API Key 通过环境变量传递，不硬编码在代码中
- 默认使用 `draft` 模式，不会自动发布；`publish` 模式需用户明确指定
- 所有操作记录可在 tools.siping.me 个人页面查看
