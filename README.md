# Web Publisher Skill

将任意网页文章自动提取、处理并发布到内容平台的 OpenClaw Skill。

## 功能

- **文章提取**: 从 URL 自动提取文章内容、标题、作者、封面图
- **图片处理**: 自动下载文章图片，上传到目标平台
- **AI 改写**: 可选的 AI 内容改写（Minimax）
- **平台发布**: 发布到微信公众号（更多平台即将支持）

## 快速开始

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

## 使用示例

在 OpenClaw 中与 AI 对话：

> 帮我把这篇文章存到公众号草稿 https://mp.weixin.qq.com/s/xxxxx

> 把这篇文章改写成轻松的风格，存到草稿 https://example.com/article

> 把这篇文章直接发布到公众号 https://example.com/article

## 可用选项

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

## License

MIT
