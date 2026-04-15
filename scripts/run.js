#!/usr/bin/env node

// 将全局 node_modules 注入 NODE_PATH，解决运行环境（如 ClawHub）未设置 NODE_PATH 的问题
// 必须在任何 require() 之前执行
;(function initGlobalModulePaths() {
  const path = require('path');
  const Module = require('module');
  const globalModules = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules');
  const existing = (process.env.NODE_PATH || '').split(':').filter(Boolean);
  if (!existing.includes(globalModules)) {
    process.env.NODE_PATH = [globalModules, ...existing].join(':');
    Module._initPaths(); // 重新初始化 require 搜索路径
  }
})();

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 60;

function loadNewsToMarkdown() {
  try {
    return require('news-to-markdown');
  } catch {
    throw new Error('news-to-markdown 未安装。请运行: npm install -g news-to-markdown');
  }
}

async function extractMarkdownLocally(url) {
  const { NewsToMarkdownConverter } = loadNewsToMarkdown();
  const conv = new NewsToMarkdownConverter();

  // 显示计时进度（本地提取可能需要 30-60 秒）
  let elapsed = 0;
  const timer = setInterval(() => {
    elapsed += 3;
    process.stderr.write(`\r[local] 正在提取... ${elapsed}s`);
  }, 3000);

  try {
    const r = await conv.convert({ url, timeout: 60000, includeMetadata: true });
    clearInterval(timer);
    process.stderr.write('\r');
    if (!r.markdown || r.markdown.length < 100) throw new Error('提取内容为空');
    return r.markdown;
  } catch (e) {
    clearInterval(timer);
    process.stderr.write('\r');
    throw new Error('本地提取失败: ' + e.message);
  }
}

const API_URL = process.env.WEB_PUBLISHER_API_URL;
const USER_ID = process.env.WEB_PUBLISHER_USER_ID;
const API_KEY = process.env.WEB_PUBLISHER_API_KEY;

const command = process.argv[2];
const args = process.argv.slice(3);

if (!command) {
  showHelp();
  process.exit(0);
}

function checkEnv() {
  const missing = [];
  if (!API_URL) missing.push('WEB_PUBLISHER_API_URL');
  if (!USER_ID) missing.push('WEB_PUBLISHER_USER_ID');
  if (!API_KEY) missing.push('WEB_PUBLISHER_API_KEY');
  if (missing.length > 0) {
    console.error(JSON.stringify({
      success: false,
      error: `Missing environment variables: ${missing.join(', ')}`,
    }));
    process.exit(1);
  }
}

function parseArgs(argList) {
  const opts = {};
  for (let i = 0; i < argList.length; i++) {
    if (argList[i] === '--theme' && argList[i + 1]) {
      opts.theme = argList[++i];
    } else if (argList[i] === '--rewrite') {
      opts.rewrite = true;
    } else if (argList[i] === '--style' && argList[i + 1]) {
      opts.style = argList[++i];
    } else if (argList[i] === '--prompt' && argList[i + 1]) {
      opts.prompt = argList[++i];
    } else if (!argList[i].startsWith('--')) {
      opts.url = opts.url || argList[i];
    }
  }
  return opts;
}

async function apiRequest(method, path, body) {
  const url = `${API_URL}${path}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': USER_ID,
      'X-Api-Key': API_KEY,
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok && !data.jobId) {
    throw new Error(data.error || `API error: ${res.status}`);
  }
  return data;
}

async function pollJob(jobId) {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const job = await apiRequest('GET', `/jobs/${jobId}`);
    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new Error(job.error || 'Job failed');
    const progress = job.progress || 0;
    const step = job.currentStep || '';
    process.stderr.write(`\r[${progress}%] ${step}...`);
  }
  throw new Error('Job timed out');
}

async function runPublish(action) {
  checkEnv();

  const opts = parseArgs(args);
  if (!opts.url) {
    console.error(JSON.stringify({ success: false, error: 'Missing argument: url' }));
    process.exit(1);
  }

  const body = {
    url: opts.url,
    action,
    theme: opts.theme || 'blackink',
  };

  if (opts.rewrite) {
    body.rewrite = true;
    body.rewriteOptions = {};
    if (opts.style) body.rewriteOptions.style = opts.style;
    if (opts.prompt) body.rewriteOptions.prompt = opts.prompt;
  }

  try {
    process.stderr.write(`[local] 本地提取内容: ${opts.url}\n`);
    body.markdown = await extractMarkdownLocally(opts.url);
    process.stderr.write(`[local] 提取成功，提交任务...\n`);
    process.stderr.write(`[0%] 提交任务...\n`);
    const response = await apiRequest('POST', '/pipeline', body);
    process.stderr.write(`任务已创建: ${response.jobId}\n`);
    const result = await pollJob(response.jobId);
    process.stderr.write('\n');

    console.log(JSON.stringify({
      success: true,
      action: result.result?.action || action,
      title: result.result?.title || '',
      mediaId: result.result?.mediaId || undefined,
      publishId: result.result?.publishId || undefined,
      theme: result.result?.theme || body.theme,
    }, null, 2));
  } catch (err) {
    process.stderr.write('\n');
    console.error(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

async function runStatus() {
  checkEnv();

  const jobId = args[0];
  if (!jobId) {
    console.error(JSON.stringify({ success: false, error: 'Missing argument: jobId' }));
    process.exit(1);
  }

  try {
    const job = await apiRequest('GET', `/jobs/${jobId}`);
    console.log(JSON.stringify(job, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
web-publisher-skill v0.3.4 — 将网页文章发布到微信公众号

用法:
  scripts/run.js <command> <url> [选项]

命令:
  draft   <url>     保存为草稿
  publish <url>     直接发布
  status  <jobId>   查询任务状态

选项:
  --theme <name>    主题（默认: blackink）
  --rewrite         启用 AI 改写
  --style <style>   改写风格: casual / formal / technical / creative
  --prompt <text>   自定义改写提示

示例:
  scripts/run.js draft https://m.toutiao.com/is/xxx/
  scripts/run.js publish https://mp.weixin.qq.com/s/xxx --theme blackink
  scripts/run.js draft https://example.com/article --rewrite --style casual
  scripts/run.js status job_abc123

环境变量（在 tools.siping.me 个人资料页获取）:
  WEB_PUBLISHER_API_URL   API 服务地址
  WEB_PUBLISHER_USER_ID   用户 ID
  WEB_PUBLISHER_API_KEY   API Key
`);
}

switch (command) {
  case 'publish':
    runPublish('publish');
    break;
  case 'draft':
    runPublish('draft');
    break;
  case 'status':
    runStatus();
    break;
  case 'help':
    showHelp();
    break;
  default:
    console.error(JSON.stringify({ success: false, error: `Unknown command: ${command}` }));
    process.exit(1);
}
