---
name: web-publisher
version: 0.7.1
description: 输入文章 URL **或本地文档（PDF/DOCX/PPTX/XLSX/EPUB/图片/音频/...）**，自动提取正文、可选 AI 改写、并发布到微信公众号；也可只把任意文档转成 Markdown 文本（不发布）。抓取 / 转换 / 改写 / 发布都在服务端 (tools.siping.me) 完成，CLI 不装任何 npm 依赖；登录、公众号配置全部通过对话 + 一次性浏览器跳转完成。⚠️ 服务端走云端固定 IP，**对小红书、部分知乎专栏、登录墙文章、海外站点经常被反爬挡掉**——此时由 AI Agent（Hermes / Cursor / OpenClaw 等）改调用**用户本地安装的 `news-to-markdown-skill`** 把 URL 抓成 Markdown，然后人工复核 / 归档。也可配合 `browser-web-search` 先搜索拿到 URL 再批量发布。
author: Ping Si <sipingme@gmail.com>
tags: [publish, wechat, article, content, onboarding, pdf, docx, markitdown]
---

# Web Publisher

输入文章 URL **或本地文档（PDF / DOCX / PPTX / XLSX / EPUB / 图片 / 音频 / ...）**，自动提取正文、可选 AI 改写、并发布到微信公众号；也支持只把文档转成 Markdown（不发布）。**纯 HTTP 调用，无本地依赖**——抓取、文档转换 (markitdown)、图片处理、AI 改写、发布全部由服务端完成。

## 给 AI 的使用说明（核心）

### 用户意图 → 命令

| 用户说什么 | 调用 | 然后做什么 |
|---|---|---|
| 帮我登录 / 注册 / 绑定账号 | `scripts/run.js login` | 把 CLI 输出的浏览器链接和绑定码**原文**交给用户；CLI 自己轮询并保存凭证，**不要自己重试** |
| 配置/绑定公众号 / 配 AppID | `scripts/run.js wechat config` | 读取 stdout JSON 里的 `url` 字段，把该完整 URL **原文粘贴**给用户（不包装 Markdown 链接、不用"点击此处"替代），并附上 IP 白名单列表 |
| 我现在是谁 / 看看账号 / 余额 | `scripts/run.js whoami` | 报告账号、apiKey 脱敏摘要、微信配置状态 |
| 公众号配好了吗 | `scripts/run.js wechat status` | 报告 `configured` 与当前 AppID |
| 退出登录 / 注销 | `scripts/run.js logout` | 报告"已清除本地凭证" |
| 配置页眉页脚 / 关注引导 / 文末二维码 | `scripts/run.js wrapper config` | 专业版及以上可用；读取 stdout JSON `url` 字段，把完整 URL **原文粘贴**给用户（同 wechat config 规则，不包装 Markdown 链接）；AI **不要替用户编 Markdown 内容** |
| 我的 wrapper 配好了吗 / 现在还启用吗 | `scripts/run.js wrapper status` | 报告 `configured` / `enabled` / 字符数 |
| 关掉页眉页脚 / 暂停 wrapper | `scripts/run.js wrapper off` | 报告"已关闭，下次开启即恢复" |
| 重新启用页眉页脚 | `scripts/run.js wrapper on` | 若返回 409 提示先运行 `wrapper config` 填内容 |
| 把这篇文章存到草稿 `<url>` | `scripts/run.js draft <url>` | 等待返回，转告标题与 mediaId |
| 把这个 PDF / DOCX 存到草稿 `<file>` | `scripts/run.js draft <path>` | `<input>` 不是 `http(s)://` 时按本地文件处理；CLI 走 multipart 把文件喂给服务端 markitdown→公众号流程，等价于 URL 模式但跳过抓取 |
| 把这篇文章发布到公众号 `<url>` | `scripts/run.js publish <url>` | 仅当用户**明确说"发布"** 才用 publish；默认走 draft |
| 把这个 PDF 直接发布到公众号 `<file>` | `scripts/run.js publish <path>` | 同上，只有用户明确说"发布"才用 publish |
| 改写后存草稿 / 发布 | `... draft <input> --rewrite [--style casual]` | `<input>` 同样可以是 URL 或文件路径 |
| 把这个文档转成 markdown / 提取这个 PDF 的文字 | `scripts/run.js convert <input>` | 默认同步返回 `markdown / byteLength / durationMs`；想保存成文件加 `--out path.md`；大文件 / 学术 PDF 加 `--async`，CLI 自动轮询 |
| 上次那个任务完成了吗 | `scripts/run.js status <jobId>` | 转告 status / progress / result |

### 关键约束（必须遵守）

1. **AppSecret 永不进入对话上下文**。`wechat config` 只输出短链，用户在浏览器表单提交，AI 不要询问、不要展示、不要日志化 AppSecret。
   **URL 必须原文输出**：读取 stdout JSON 的 `url` 字段后，必须把完整 URL 原封不动发给用户，例如：
   ```
   请在浏览器中打开以下链接填写 AppID / AppSecret：
   https://tools.siping.me/skill/wechat?t=XXXX
   ```
   ❌ 错误写法（会导致用户拿不到链接）：
   - `[点击填写 AppID/AppSecret](https://...)` ← Markdown 链接，某些 Agent UI 只显示文字
   - `请点击此处填写 AppID/AppSecret` ← 完全丢失 URL
   - 不输出 URL，仅说"已生成配置链接" ← 用户无法打开
2. **默认 draft，不要主动 publish**。除非用户原话里明确说了"发布 / 直接发到公众号 / publish"，否则一律用 `draft`。`convert` 不发布，只把文档转成 markdown，可以放心调。
3. **`<input>` 是 URL 还是本地文件 CLI 自动判断**：以 `http://` / `https://` 开头当 URL；否则当成本地路径（`fs.statSync` 验证存在且是 regular file，不存在直接 400 给用户，不会浪费 credit）。AI **不要**把本地路径包装成 `file://` URL，CLI 不接受 `file://`。
4. **本地文件上限 50 MiB**（服务端 `MARKITDOWN_MAX_INPUT_BYTES`）。超过先让用户裁剪 / 压缩；学术 PDF 太大时建议加 `--async` 走异步。
5. **`convert` 输出体积大时务必用 `--out path.md`**：把整个 PDF 的 markdown 塞进 stdout 会撑爆 AI 的上下文窗口；AI 应主动建议用户加 `--out` 然后再读那个文件。
6. **耗时正常**。URL 抓取整体 30–90 秒（带 `--rewrite` 更久），文档转换看体积（学术 PDF 可达 5 分钟）。CLI 每 5 s 打一次进度。**不要超时重试**——重复调用会创建多个草稿；需要更长时间用 `--async`。
7. **错误恢复对照**：

   | CLI 错误 | 正确处置 |
   |---|---|
   | `尚未登录` | 提示用户跑 `scripts/run.js login` |
   | `WeChat credentials not configured` | 提示用户跑 `scripts/run.js wechat config`（仅 draft/publish 需要；`convert` 不需要微信配置） |
   | `发布额度不足 / 余额不足 / insufficient credits` | 提示用户去 [tools.siping.me](https://tools.siping.me) 充值 |
   | `input is not a URL and no file exists at: ...` | 用户给的路径不存在 / 拼错；让用户重确认本地路径 |
   | `Uploaded file exceeds the 52428800-byte server limit` | 超过 50 MiB；让用户压缩 / 拆分 PDF 后重试 |
   | `markitdown 转换失败 (cli_missing)` | 服务端 markitdown 未安装；联系服务方，用户侧无法解决 |
   | 任务 `failed`，error 含 `抓取失败` / `403` / `登录` | 把原 error 转给用户；提示**用本地 `news-to-markdown` 重新抓取**，常见反爬站（小红书 / 知乎 / 海外站）这样能救回来 |

### 与 browser-web-search 配合（搜索 + 发布）

用户只给关键词没有 URL 时，先用 `browser-web-search` 拿 URL 列表，再逐条调本 skill：

```bash
# Step 1：搜索拿 URL（browser-web-search skill）
bws toutiao/search "AI Search" --count 3 --sort time

# Step 2：对每个 URL 调本 skill
scripts/run.js draft <url1>
scripts/run.js draft <url2>
scripts/run.js draft <url3>
```

如果用户已经给了 URL，**跳过 Step 1**。

### 与 news-to-markdown-skill 配合（必看：服务端抓不到时的回退路径）

本 skill 的抓取**只在服务端（tools.siping.me）发生**，CLI 自身不抓任何网页。服务端走云端固定 IP，**以下站点经常拿不到正文**：

- 小红书 `xiaohongshu.com`（全站强反爬）
- 部分知乎专栏 `zhuanlan.zhihu.com`（zse-ck 反爬）
- 登录墙文章（部分公众号 token 链接、内部专栏）
- 海外站点（被云厂商出口 IP 直接 403）

这种站点服务端一律返回 `failed` + `抓取失败 / 403 / 登录 / 内容为空`。**唯一可靠的兜底是用用户本地（家庭 / 办公 IP，可装真实 Chrome）抓取**——这就是为什么强烈要求用户额外安装 [`news-to-markdown-skill`](https://github.com/sipingme/news-to-markdown-skill)。

#### AI Agent (Hermes / Cursor / OpenClaw) 的回退步骤

1. 收到「发到公众号 `<url>`」请求 → 先尝试本 skill：`scripts/run.js draft <url>`。
2. 任务返回 `failed` 且 `error` 含 `抓取失败 / 403 / forbidden / 登录 / 内容为空`，**或**用户预先声明该站反爬严重 → 切到 `news-to-markdown-skill`：

   ```bash
   # news-to-markdown-skill 的标准调用入口（在用户本机）
   node <path-to>/news-to-markdown-skill/scripts/run.js convert \
     --url "<原始 URL>" \
     --download-images \
     --output-dir ./drafts/<safe-slug>
   # 产出：./drafts/<slug>/article.md + ./drafts/<slug>/images/*
   ```

3. 把本地产出（Markdown 路径 + 图片目录）**如实回报给用户**，并明确告知：

   - 服务端为什么抓不到（云 IP 被该站挡了）
   - 已经在本地抓到了正文（路径 + 图片张数）
   - **本 skill 当前 CLI 只接受 URL，不接受本地 Markdown 文件**——所以无法直接把本地稿件再次走 `draft|publish` 上传到公众号；下一步由用户决定（人工复核归档、手动粘贴到公众号后台、或等待服务端开放本地稿件入口）

⚠️ **AI Agent 必须遵守的硬约束**：

- **不要**把本地 markdown 文件路径当作 URL 参数喂给 `scripts/run.js draft|publish`。当前 CLI 只支持 `https?://` URL，传文件路径会让服务端 404 / 抓不到，浪费用户额度。
- **不要**自己重新调用 `draft|publish` 重试同一个失败 URL（多次尝试也会失败，并占额度）。
- **不要**伪装成服务端抓到了——必须明确告诉用户「服务端抓不到，已在本地抓到 X」。

#### 搜索 + 抓取 + 发布（三个 skill 串起来）

```bash
# Step 1：browser-web-search 拿 URL 列表
bws zhihu/search "AI Search" --count 3

# Step 2：先试服务端（多数站能成）
scripts/run.js draft <url1>

# Step 3：服务端失败的 URL，转用本地 news-to-markdown-skill 抓
node <path-to>/news-to-markdown-skill/scripts/run.js convert \
  --url <url-failed> --download-images --output-dir ./drafts/x
```

## 前置要求

本 skill 自身只做凭证管理 + HTTP，对话式两步接入即可（见下面 1 / 2）。但要让 AI Agent 在「服务端抓不到」时能正常回退，**用户必须另外在本机安装 `news-to-markdown-skill`**：

| 配套 skill | 作用 | 安装方式（用户本机） | 是否硬依赖 |
|---|---|---|---|
| [`news-to-markdown-skill`](https://github.com/sipingme/news-to-markdown-skill) | 用本机 IP / 真实 Chrome 把 URL 抓成 Markdown，绕开云端 IP 被反爬挡的问题 | `npm install -g news-to-markdown@3.3.1` + 把 skill 仓库 clone 到本地，由 Hermes / Cursor / OpenClaw 等 AI Agent 直接 `node scripts/run.js convert ...` 调用 | **强烈推荐**（不装则反爬站点完全无法发布） |
| [`browser-web-search`](https://github.com/sipingme/browser-web-search-skill) | 关键词 → URL 列表 | 见 skill 文档 | 可选（用户只有话题没具体 URL 时） |

> AI Agent 注意：`news-to-markdown-skill` 一定要装在 **用户本机**，不能在云端环境里跑——否则就跟 web-publisher 服务端一样被反爬挡。Hermes 之类的本地 Agent 会直接拿到用户家庭 / 办公出口 IP，是这条回退路径的关键。

### 1. 首次登录

用户说「帮我登录」→ AI 调 `scripts/run.js login` → CLI 打印一次性短链：

```
请在浏览器中打开以下链接，确认绑定到你的账号：
  https://tools.siping.me/skill/bind?code=ABCD-EFGH
  绑定码: ABCD-EFGH
  有效期: 5 分钟
```

用户在浏览器完成注册/登录 + 点「确认绑定」。CLI 自动轮询，凭证写入 `~/.web-publisher/credentials.json`（mode 0600，仅当前用户可读）。

### 2. 配置微信公众号

用户说「帮我配置公众号」→ AI 调 `scripts/run.js wechat config` → CLI 打印短链 + 需加白名单的服务器 IP。用户在浏览器表单填 AppID/AppSecret 提交（**AppSecret 直接 POST 到服务端 AES-256-GCM 加密落库，永不进入对话上下文**）。

加 IP 白名单只能在 mp.weixin.qq.com 后台完成，无法绕过。

### 3.（专业版及以上可选）配置页眉页脚

用户说「每篇文章末尾自动加我的二维码」「文章开头加关注引导」→ AI 调 `scripts/run.js wrapper config` → 把短链交给用户，让用户在浏览器表单里编辑 **Markdown 格式**的页眉（拼到正文最前）和页脚（拼到正文最后），保存后默认启用。

页眉页脚会在 `--rewrite` **之后**、推送给微信草稿/发布之前由 pipeline 拼接：用户页眉/页脚不会被 AI 改写。`wrapper off` 不删内容，只是临时停用；下次 `wrapper on` 即恢复。

### （可选）环境变量

仅 CI / 无浏览器场景使用，优先级高于本地凭证：

| 变量 | 说明 |
|---|---|
| `WEB_PUBLISHER_TOOLS_URL` | 账号 API（默认 `https://tools.siping.me/api`） |
| `WEB_PUBLISHER_API_URL` | pipeline API（登录后凭证文件里也会带） |
| `WEB_PUBLISHER_USER_ID` | 用户 ID（如 `usr_xxxx`） |
| `WEB_PUBLISHER_API_KEY` | API Key |

## 命令参考

```bash
# 账号
scripts/run.js login              # 浏览器一次性绑定
scripts/run.js logout             # 撤销 apiKey + 删本地凭证
scripts/run.js whoami             # 当前账号 + 微信配置 + 余额

# 公众号
scripts/run.js wechat config      # 浏览器表单填 AppID/AppSecret
scripts/run.js wechat status      # configured ? appId

# 页眉页脚（每篇文章自动拼接前后内容）
scripts/run.js wrapper config     # 浏览器表单编辑页眉/页脚
scripts/run.js wrapper status     # configured / enabled / 字符数 / 版本
scripts/run.js wrapper on         # 启用页眉页脚
scripts/run.js wrapper off        # 关闭页眉页脚（保留内容）

# 发布（<input> 可以是 URL 或本地文件路径）
scripts/run.js draft   <input> [options]   # 创建草稿（默认）
scripts/run.js publish <input> [options]   # 直接发布
scripts/run.js status  <jobId>             # 查任务进度

# 文档转 Markdown（不发布）
scripts/run.js convert <input> [--out <file>] [--async] [--timeout <ms>]

# 帮助
scripts/run.js help
```

### 发布选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `--theme <id>` | `blackink` | 主题 ID（见下表） |
| `--rewrite` | 关闭 | 启用 AI 分段改写 |
| `--style <name>` | `casual` | 配合 `--rewrite`：`casual` / `formal` / `technical` / `creative` |
| `--prompt "<text>"` | — | 自定义改写提示，覆盖 `--style` |

### convert 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `--out <file>` | — | 把 markdown 写到该文件（stdout 只回 JSON 摘要 `{success, input, out, byteLength, durationMs}`，不灌大段正文） |
| `--async` | 关闭 | 走 `/convert/async`，CLI 自动轮询；适合学术 PDF / 扫描件等可能跑 5–10 分钟的转换 |
| `--timeout <ms>` | 服务端 5min | 单次转换超时；服务端封顶 600000 (10min)，超过仍按 600000 处理 |

**可用主题**（用户说"墨黑/橙日/紫雨"等中文名时，自动映射到对应 ID）：

| ID | 中文名 | 风格 |
|---|---|---|
| `blackink` | 墨黑（默认） | 深色模式，靛蓝点缀，适合夜间 / 科技类 |
| `default` | 默认主题 | 简洁清爽，适合各类文章 |
| `orangesun` | 橙日 | 温暖明亮的橙色阳光主题 |
| `redruby` | 红宝石 | 优雅大气的宝石红主题 |
| `greenmint` | 薄荷绿 | 清新舒缓的薄荷绿主题 |
| `purplerain` | 紫雨 | 梦幻渐变的紫色主题 |

### 调用样例

```bash
# URL → 草稿 / 发布
scripts/run.js draft   https://mp.weixin.qq.com/s/xxxxx
scripts/run.js draft   https://zhuanlan.zhihu.com/p/xxx --theme orangesun
scripts/run.js draft   https://36kr.com/p/xxx --rewrite --style casual
scripts/run.js publish https://example.com/article

# 本地文档 → 草稿（multipart 上传，跳过抓取，复用 markitdown→改写→封面→发布全流程）
scripts/run.js draft   ./drafts/report.pdf
scripts/run.js draft   ~/Downloads/slide.pptx --rewrite --style technical --theme blackink
scripts/run.js publish ./papers/whitepaper.pdf

# 任意文档 → markdown（不发布）
scripts/run.js convert ./report.pdf                    # markdown 全文回到 stdout
scripts/run.js convert ./report.pdf --out report.md    # 写文件，stdout 只回摘要
scripts/run.js convert https://arxiv.org/pdf/2401.00001.pdf --async --out paper.md
scripts/run.js convert ./meeting.mp3 --async           # 音频转录（服务端装了对应插件时）

# 查状态
scripts/run.js status  job_abc123
```

## 支持平台

**发布目标**：微信公众号（草稿 / 直接发布）。其他平台规划中。

**内容来源 1：URL**（服务端 news-to-markdown 自动选适配器）：

| 平台 | 适配器 | 配合 `bws <平台>/search` |
|---|---|---|
| 微信公众号 | ✅ | ✅ |
| 今日头条 | ✅ | ✅ |
| 知乎 | ✅ | ✅ |
| 36kr | ✅ | ✅ |
| CSDN | ✅ | ✅ |
| 小红书 | ✅ | ✅（部分内容需登录） |
| 人人都是产品经理 | ✅ | — |
| 任意网页 | ✅ 通用 readability | — |

**内容来源 2：本地文件 / 文档型 URL**（服务端 [Microsoft markitdown](https://github.com/microsoft/markitdown) 处理）：

`.pdf` / `.docx` / `.pptx` / `.xlsx` / `.epub` / `.csv` / `.tsv` / `.html` / `.md` / `.txt` / 常见图片 (`.png` `.jpg` `.webp` `.gif`) / 常见音频 (`.mp3` `.wav` `.m4a`，服务端装了 markitdown 音频插件时)；URL 末尾扩展名命中文档格式时自动走 markitdown 而不是 readability。

## 工作原理

```
draft / publish:                    convert:
  URL ──▶ POST /pipeline              URL 或文件 ──▶ POST /convert (sync)
  文件 ──▶ POST /pipeline (multipart)                    /convert/async (async)
         │                                       │
         ├─ news-to-markdown  (URL 路径)         └─ markitdown subprocess
         ├─ markitdown        (文件 / 文档型 URL)        │
         ├─ markdown-ai-rewriter   (可选，--rewrite)     ▼
         ├─ user-wrapper           (可选)         返回 markdown / jobId
         └─ wechat-md-publisher    上传图片 → 草稿/发布
                ▼
         返回 jobId，CLI 轮询 GET /jobs/<jobId> 至 completed / failed
```

CLI 端只做**凭证管理 + HTTP 调用 + 本地文件读字节 + multipart 上传**，没有任何抓取 / 解析 / 图片下载 / 文档转换逻辑，也不安装任何 npm 包；本地文件通过 Node 18 内建的 `FormData` / `Blob` 流式上传到服务端，basename 之外的本地路径不会出网络。

## 安全与信任

- **数据流**：
  - URL 模式：CLI 把 `{url, action, theme, rewrite?}` + 你的 API Key 发给服务端；服务端自行抓取目标网页全文与图片，并发布到微信。⚠️ **服务端会接收原始 URL 并下载全文 + 图片**。
  - 本地文件模式（`draft|publish|convert <path>`）：CLI 读你提供的那个文件的字节流，**只把 basename 和文件内容**通过 multipart 上传到服务端 `/pipeline` 或 `/convert`；不上传你的本地绝对路径，也不读你没明确传的其他文件。
- **AppSecret**：永不进入对话上下文；浏览器表单直传服务端，AES-256-GCM 加密落库。
- **apiKey**：device_code 在绑定成功后立刻 consumed，一次性下发；`logout` 远端撤销 + 删本地。
- **本地凭证**：`~/.web-publisher/credentials.json`（mode 0600）。
- **IP 白名单**：mp.weixin.qq.com 后台授权远程服务器 IP 直接调微信 API；请确认你信任该 IP 归属方（[tools.siping.me](https://tools.siping.me)）。
- **审计**：所有操作记录可在 tools.siping.me 个人页面查看；源码 [github.com/sipingme/web-publisher-skill](https://github.com/sipingme/web-publisher-skill)。
