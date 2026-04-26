---
name: web-publisher
version: 0.3.5
description: 输入文章 URL，自动提取正文并发布到微信公众号。支持头条、微信、知乎、36kr、CSDN、小红书等平台提取。可配合 browser-web-search skill 先搜索拿到 URL 再批量发布。
author: Ping Si <sipingme@gmail.com>
tags: [publish, wechat, article, content]
requiredEnvVars:
  - WEB_PUBLISHER_API_URL
  - WEB_PUBLISHER_USER_ID
  - WEB_PUBLISHER_API_KEY
---

# Web Publisher

将任意网页文章自动提取、处理并发布到微信公众号。

## 功能

- **文章提取**: 从 URL 自动提取文章内容、标题、作者、封面图
- **图片处理**: 自动下载文章图片，上传到微信
- **AI 改写**: 可选的 AI 内容改写（Minimax）
- **平台发布**: 创建草稿或直接发布到微信公众号

## 前置要求

### 1. 注册并获取凭证

在 [tools.siping.me](https://tools.siping.me) 注册账号，获取用户 ID 和 API Key。

### 2. 微信公众号 IP 白名单

在微信公众平台 → 设置与开发 → 基本配置 → IP白名单 中，添加服务器 IP（在 [tools.siping.me](https://tools.siping.me) 中查看）。

### 3. 安装本地依赖

`scripts/run.js` 通过 `require('news-to-markdown')` 调用正文提取库，必须全局安装：

```bash
npm install -g news-to-markdown@^3.2.0
```

**可选**：如果需要"搜索关键词 → 批量发布"功能，还需安装 `browser-web-search`（同时需要 OpenClaw）：

```bash
npm install -g browser-web-search@^0.3.9
```

### 4. 配置环境变量

在 ClawHub 的 Skill 设置中配置以下环境变量：

| 变量 | 说明 |
|------|------|
| `WEB_PUBLISHER_API_URL` | API 服务地址（在 tools.siping.me 中查看） |
| `WEB_PUBLISHER_USER_ID` | 用户 ID |
| `WEB_PUBLISHER_API_KEY` | API Key |

## 给 AI 的使用说明

### 🔗 与其他 Skill 配合的完整流水线

当用户想"搜索 + 发布"时，需要两个 Skill 协作：

```
browser-web-search  →  (URL 列表)  →  web-publisher
      搜索                               提取 + 发布
```

**典型例子**：用户说"帮我把今日头条最新 3 篇关于 AI Search 的文章发布到公众号"

```bash
# Step 1：用 browser-web-search 搜索，拿到 URL 列表
bws toutiao/search "ai search" --count 3 --sort time
# 返回: [{ title, url }, { title, url }, { title, url }]

# Step 2：对每个 url 调用 web-publisher 发布
scripts/run.js draft <url1>
scripts/run.js draft <url2>
scripts/run.js draft <url3>
```

**注意**：如果用户只给了关键词（没有 URL），必须先调用 `browser-web-search` 获取 URL，再调用本 Skill。如果用户直接给了 URL，跳过第一步。

---

### 单篇发布

当用户要求将网页文章发布或保存到微信公众号时，使用以下命令：

- 创建草稿: `scripts/run.js draft <url>`
- 直接发布: `scripts/run.js publish <url>`
- 可选参数: `--theme blackink`, `--rewrite`, `--style casual`

**注意**：
- 默认创建草稿，不会自动发布。用户明确说「发布」时才使用 publish 命令。
- 本地提取内容可能需要 30-60 秒，属正常现象。
- 若提示未安装依赖，请提醒用户运行 `npm install -g news-to-markdown@^3.2.0`。

## 使用示例

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

### 示例 4：搜索后批量发布（配合 browser-web-search）

> 用户：帮我把今日头条最新 3 篇关于「AI Search」的文章发布到公众号草稿

```bash
# Step 1：搜索（调用 browser-web-search skill）
bws toutiao/search "AI Search" --count 3 --sort time

# Step 2：对每个 url 创建草稿（调用本 skill）
scripts/run.js draft https://www.toutiao.com/article/111
scripts/run.js draft https://www.toutiao.com/article/222
scripts/run.js draft https://www.toutiao.com/article/333
```

### 示例 5：直接发布

> 用户：把这篇文章直接发布到公众号 https://example.com/article

```bash
scripts/run.js publish https://example.com/article
```

### 示例 6：查询任务状态

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

**可用主题**（`--theme` 参数值）：

| 主题 ID | 名称 | 风格 |
|---------|------|------|
| `blackink` | Black Ink | 深色模式，靛蓝点缀（默认） |
| `default` | 默认主题 | 简洁清爽，适合各类文章 |
| `orangesun` | Orange Sun | 温暖明亮，橙色系 |
| `redruby` | Red Ruby | 优雅大气，宝石红 |
| `greenmint` | Green Mint | 清新薄荷绿 |
| `purplerain` | Purple Rain | 梦幻紫色渐变 |

## 支持平台

**发布目标**（内容发布到哪里）：

| 平台 | 状态 | 说明 |
|------|------|------|
| 微信公众号 | ✅ 支持 | 创建草稿或直接发布 |
| 更多平台 | 🚧 规划中 | - |

**内容来源**（文章从哪里提取）：

`news-to-markdown` 负责从以下平台提取正文，`web-publisher` 在本地通过 `require` 调用它：

| 平台 | 提取 | 搜索支持 | 备注 |
|------|------|----------|------|
| 今日头条 | ✅ | ✅ `bws toutiao/search` | 可配合 browser-web-search 批量搜索后发布 |
| 微信公众号 | ✅ | ✅ `bws weixin/search` | |
| 知乎 | ✅ | ✅ `bws zhihu/search` | |
| 36kr | ✅ | ✅ `bws 36kr/search` | |
| CSDN | ✅ | ✅ `bws csdn/search` | |
| 小红书 | ✅ | ✅ `bws xiaohongshu/search` | 部分内容需登录 |
| 人人都是产品经理 | ✅ | - | 暂无 bws 搜索支持 |
| 任意网页 | ✅ | - | 通用提取，效果不保证 |

> **搜索支持** 列表示：可先用 `browser-web-search` skill 搜索该平台，拿到 URL 后再交给本 Skill 发布。

## 工作原理

**单篇模式**（直接给 URL）：
```
URL → 本地 news-to-markdown（提取 Markdown）
    → 服务器 markdown-ai-rewriter（可选，AI 改写）
    → wechat-md-publisher（上传图片 + 发布）
```

**搜索发布模式**（配合 browser-web-search）：
```
关键词 → browser-web-search（搜索，产出 URL 列表）
       → 本地 news-to-markdown（提取正文）
       → 服务器 markdown-ai-rewriter（可选，AI 改写）
       → wechat-md-publisher（上传图片 + 发布）
```

## 安全与信任说明

### 数据流

1. **本地**：`news-to-markdown` 从目标网页提取 Markdown 文本
2. **发送到服务器**：原始 URL + 提取的 Markdown 内容 + 你的 API Key
3. **服务器端**：从 Markdown 中的图片 URL 下载图片，上传到微信，最终调用微信 API 创建草稿或发布

> ⚠️ 服务器会收到原始 URL 和全文内容，并在发布时从原图片地址下载图片。

### API 凭证与授权

- `WEB_PUBLISHER_API_KEY` 允许远程服务以你的身份向微信公众号发布内容——这是高权限操作
- IP 白名单（第 2 步）授权远程服务器 IP 直接调用微信 API，请确认你信任该 IP 归属方
- 服务提供方为 [tools.siping.me](https://tools.siping.me)，源码可在 [github.com/sipingme/web-publisher-skill](https://github.com/sipingme/web-publisher-skill) 查看

### 其他

- API Key 通过环境变量传递，不硬编码在代码中
- 默认使用 `draft` 模式，不会自动发布；`publish` 模式需用户明确指定
- 所有操作记录可在 tools.siping.me 个人页面查看
