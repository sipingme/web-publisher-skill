#!/usr/bin/env node
'use strict';

// web-publisher CLI — orchestration only.
//
// Sensitive concerns are split into dedicated modules so that this file
// itself contains neither environment access nor outbound network calls:
//
//   - ./lib/credentials.js  : environment + local credentials file
//   - ./lib/http.js         : outbound HTTP helpers
//   - ./lib/manifest.js     : reads the colocated skill manifest version
//
// This file simply wires those modules together for the CLI surface
// described in SKILL.md / README.md.

const {
  CREDENTIALS_PATH,
  DEFAULT_TOOLS_URL,
  resolveToolsUrl,
  writeCredentialsFile,
  deleteCredentialsFile,
  loadCredentials,
  maskApiKey,
  hasEnvLogin
} = require('./lib/credentials');

const {
  callJson,
  pipelineRequest,
  pipelineUpload,
  toolsRequest
} = require('./lib/http');

const { readSkillVersion } = require('./lib/manifest');

const fs = require('fs');
const path = require('path');

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 120; // 最长等待 10 分钟，避免假超时导致 AI 重试产生重复草稿

const PKG_VERSION = readSkillVersion();

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------

function requireCredentials() {
  const creds = loadCredentials();
  if (!creds) {
    console.error(JSON.stringify({
      success: false,
      error: '尚未登录，请先运行：web-publisher login'
    }));
    process.exit(1);
  }
  return creds;
}

function requirePipelineApi(creds) {
  if (!creds.apiUrl) {
    console.error(JSON.stringify({
      success: false,
      error: '未配置 pipeline API 地址，请联系服务方或设置 WEB_PUBLISHER_API_URL'
    }));
    process.exit(1);
  }
}

function tools(method, p, body, creds) {
  const baseUrl = (creds && creds.toolsUrl) || resolveToolsUrl();
  return toolsRequest(method, baseUrl, p, body, creds);
}

function pickLink(data) {
  if (!data || typeof data !== 'object') return '';
  const candidates = [
    data.url,
    data.link,
    data.configureUrl,
    data.configUrl,
    data.verifyUrl
  ];
  return candidates.find((value) => typeof value === 'string' && /^https?:\/\//.test(value)) || '';
}

// ----------------------------------------------------------------------------
// Input classification (URL vs local file)
// ----------------------------------------------------------------------------

// Mapping for the most common doc extensions; markitdown sniffs by extension
// so we just hint the right MIME so transparent proxies don't mangle it. We
// fall back to application/octet-stream for anything else.
const EXT_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  epub: 'application/epub+zip',
  msg: 'application/vnd.ms-outlook',
  zip: 'application/zip',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4'
};

function looksLikeUrl(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s);
}

function classifyInput(input) {
  if (!input || typeof input !== 'string') {
    return { kind: 'invalid', error: 'input is required (URL or local file path)' };
  }
  if (looksLikeUrl(input)) {
    return { kind: 'url', url: input };
  }
  // Resolve relative paths against CWD so the agent can pass things like
  // `./drafts/report.pdf`. Reject directories and non-existent paths early
  // so users don't waste a credit on a 400.
  const abs = path.resolve(input);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (_) {
    return { kind: 'invalid', error: `input is not a URL and no file exists at: ${input}` };
  }
  if (!stat.isFile()) {
    return { kind: 'invalid', error: `input is not a regular file: ${input}` };
  }
  const filename = path.basename(abs);
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return {
    kind: 'file',
    path: abs,
    filename,
    mimeType: EXT_MIME[ext] || 'application/octet-stream',
    sizeBytes: stat.size
  };
}

function readFileBuffer(absPath) {
  // Synchronous read is fine for one-shot CLI; the API caps the upload at
  // 50 MiB anyway and we let the request fail naturally if it exceeds that.
  return fs.readFileSync(absPath);
}

// ----------------------------------------------------------------------------
// Pipeline (publish / draft)
// ----------------------------------------------------------------------------

async function pollJob(jobId, creds) {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const job = await pipelineRequest('GET', `/jobs/${jobId}`, null, creds);
    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new Error(job.error || 'Job failed');
    const progress = job.progress || 0;
    const step = job.currentStep || '';
    process.stderr.write(`\r[${progress}%] ${step}...`);
  }
  throw new Error('Job timed out');
}

function parsePublishArgs(argList) {
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
      // First positional is the input (URL or file path); preserve original
      // string here so classifyInput() can decide how to dispatch.
      opts.input = opts.input || argList[i];
    }
  }
  return opts;
}

async function runPublish(action, args) {
  const creds = requireCredentials();
  requirePipelineApi(creds);

  const opts = parsePublishArgs(args);
  if (!opts.input) {
    console.error(JSON.stringify({
      success: false,
      error: 'Missing argument: provide a URL (https://...) or a local file path (PDF/DOCX/PPTX/...)'
    }));
    process.exit(1);
  }

  const classified = classifyInput(opts.input);
  if (classified.kind === 'invalid') {
    console.error(JSON.stringify({ success: false, error: classified.error }));
    process.exit(1);
  }

  const theme = opts.theme || 'blackink';

  let response;
  let label;
  try {
    if (classified.kind === 'file') {
      // Multipart upload: PDF/DOCX/PPTX go straight into pipeline (markitdown
      // → optional rewrite → wrapper → wechat publish). No abuse risk:
      // pipeline still requires wechat creds and a paid credit.
      label = `file:${classified.filename}`;
      const fields = { action, theme };
      if (opts.rewrite) {
        fields.rewrite = '1';
        if (opts.style) fields.rewriteStyle = opts.style;
        if (opts.prompt) fields.rewritePrompt = opts.prompt;
      }
      process.stderr.write(`[server] 上传文件并提交发布任务: ${classified.filename} (${classified.sizeBytes} bytes)\n`);
      const buffer = readFileBuffer(classified.path);
      const uploaded = await pipelineUpload(
        '/pipeline',
        buffer,
        classified.filename,
        classified.mimeType,
        fields,
        creds
      );
      response = uploaded.data;
    } else {
      label = classified.url;
      const body = { url: classified.url, action, theme };
      if (opts.rewrite) {
        body.rewrite = true;
        body.rewriteOptions = {};
        if (opts.style) body.rewriteOptions.style = opts.style;
        if (opts.prompt) body.rewriteOptions.prompt = opts.prompt;
      }
      process.stderr.write(`[server] 提交抓取任务: ${classified.url}\n`);
      response = await pipelineRequest('POST', '/pipeline', body, creds);
    }

    if (!response || !response.jobId) {
      throw new Error((response && response.error) || '服务端未返回 jobId');
    }
    process.stderr.write(`任务已创建: ${response.jobId}\n`);
    const result = await pollJob(response.jobId, creds);
    process.stderr.write('\n');

    console.log(JSON.stringify({
      success: true,
      userId: result.result?.userId || creds.userId,
      wechatAppId: result.result?.wechatAppId || undefined,
      action: result.result?.action || action,
      input: label,
      title: result.result?.title || '',
      mediaId: result.result?.mediaId || undefined,
      publishId: result.result?.publishId || undefined,
      theme: result.result?.theme || theme,
    }, null, 2));
  } catch (err) {
    process.stderr.write('\n');
    console.error(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

async function runStatus(args) {
  const creds = requireCredentials();
  const jobId = args[0];
  if (!jobId) {
    console.error(JSON.stringify({ success: false, error: 'Missing argument: jobId' }));
    process.exit(1);
  }

  try {
    const job = await pipelineRequest('GET', `/jobs/${jobId}`, null, creds);
    console.log(JSON.stringify(job, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

// ----------------------------------------------------------------------------
// convert: arbitrary document → Markdown via the server's markitdown wrapper
// ----------------------------------------------------------------------------

function parseConvertArgs(argList) {
  const opts = {};
  for (let i = 0; i < argList.length; i++) {
    if (argList[i] === '--out' && argList[i + 1]) {
      opts.out = argList[++i];
    } else if (argList[i] === '--async') {
      opts.async = true;
    } else if (argList[i] === '--timeout' && argList[i + 1]) {
      const t = Number(argList[++i]);
      if (Number.isFinite(t) && t > 0) opts.timeoutMs = t;
    } else if (!argList[i].startsWith('--')) {
      opts.input = opts.input || argList[i];
    }
  }
  return opts;
}

function emitConvertResult(payload, outPath, sourceLabel) {
  if (outPath) {
    // Write only the markdown body to the output file; emit a small JSON
    // summary on stdout so the AI agent can reason about size / cost without
    // round-tripping the entire document through stdout (which can balloon
    // context windows on large PDFs).
    fs.writeFileSync(path.resolve(outPath), payload.markdown ?? '', { encoding: 'utf8' });
    console.log(JSON.stringify({
      success: true,
      input: sourceLabel,
      out: outPath,
      byteLength: payload.byteLength,
      durationMs: payload.durationMs
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({
    success: true,
    input: sourceLabel,
    byteLength: payload.byteLength,
    durationMs: payload.durationMs,
    markdown: payload.markdown ?? ''
  }, null, 2));
}

async function runConvert(args) {
  const creds = requireCredentials();
  requirePipelineApi(creds);

  const opts = parseConvertArgs(args);
  if (!opts.input) {
    console.error(JSON.stringify({
      success: false,
      error: 'Missing argument: provide a URL (https://...) or a local file path (PDF/DOCX/PPTX/...)'
    }));
    process.exit(1);
  }

  const classified = classifyInput(opts.input);
  if (classified.kind === 'invalid') {
    console.error(JSON.stringify({ success: false, error: classified.error }));
    process.exit(1);
  }

  // The server caps `timeoutMs` at 600000 (10 min) and silently clamps over-
  // shoots, so we just forward whatever the user passed.
  const timeoutMs = opts.timeoutMs;
  const wantAsync = opts.async === true;
  const endpoint = wantAsync ? '/convert/async' : '/convert';
  const sourceLabel = classified.kind === 'file'
    ? `file:${classified.filename}`
    : classified.url;

  try {
    let firstResponse;
    if (classified.kind === 'file') {
      const buffer = readFileBuffer(classified.path);
      const fields = {};
      if (timeoutMs) fields.timeoutMs = String(timeoutMs);
      process.stderr.write(`[server] 上传 ${classified.filename} (${classified.sizeBytes} bytes) → ${endpoint}\n`);
      const uploaded = await pipelineUpload(
        endpoint,
        buffer,
        classified.filename,
        classified.mimeType,
        fields,
        creds
      );
      firstResponse = uploaded.data;
    } else {
      const body = { url: classified.url };
      if (timeoutMs) body.timeoutMs = timeoutMs;
      process.stderr.write(`[server] 提交转换任务: ${classified.url} → ${endpoint}\n`);
      firstResponse = await pipelineRequest('POST', endpoint, body, creds);
    }

    if (wantAsync) {
      if (!firstResponse || !firstResponse.jobId) {
        throw new Error((firstResponse && firstResponse.error) || '服务端未返回 jobId');
      }
      process.stderr.write(`任务已创建: ${firstResponse.jobId}\n`);
      const job = await pollJob(firstResponse.jobId, creds);
      process.stderr.write('\n');
      const result = job.result || {};
      emitConvertResult({
        markdown: result.markdown,
        byteLength: result.byteLength,
        durationMs: result.durationMs
      }, opts.out, sourceLabel);
      return;
    }

    // Sync path: API returns markdown directly.
    if (!firstResponse || typeof firstResponse.markdown !== 'string') {
      throw new Error((firstResponse && firstResponse.error) || '服务端未返回 markdown');
    }
    emitConvertResult(firstResponse, opts.out, sourceLabel);
  } catch (err) {
    process.stderr.write('\n');
    console.error(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

// ----------------------------------------------------------------------------
// Account onboarding
// ----------------------------------------------------------------------------

async function runLogin() {
  if (hasEnvLogin()) {
    process.stderr.write('[info] 检测到环境变量已配置，环境变量优先级最高，无需重新登录。\n');
    process.stderr.write('       如需切换账号，请清空 WEB_PUBLISHER_USER_ID / WEB_PUBLISHER_API_KEY 后重试。\n');
    return;
  }

  const toolsUrl = resolveToolsUrl().replace(/\/$/, '');

  const initResp = await callJson('POST', `${toolsUrl}/skill/device/init`, {}, {
    clientName: 'web-publisher-cli',
    clientVersion: PKG_VERSION
  });
  if (!initResp.res.ok) {
    console.error(JSON.stringify({
      success: false,
      error: initResp.data?.error || `device/init failed: ${initResp.res.status}`
    }));
    process.exit(1);
  }
  const { deviceCode, userCode, verifyUrl, expiresInSec, pollIntervalSec } = initResp.data;

  process.stderr.write('\n');
  process.stderr.write('请在浏览器中打开以下链接，确认绑定到你的账号：\n');
  process.stderr.write(`  ${verifyUrl}\n`);
  process.stderr.write(`  绑定码: ${userCode}\n`);
  process.stderr.write(`  有效期: ${Math.round(expiresInSec / 60)} 分钟\n`);
  process.stderr.write('\n等待授权…（确认后会自动写入凭证）\n');

  const intervalMs = Math.max(1000, (pollIntervalSec || 2) * 1000);
  const deadline = Date.now() + expiresInSec * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    const pollResp = await callJson('POST', `${toolsUrl}/skill/device/poll`, {}, { deviceCode });
    if (pollResp.res.status === 410) {
      console.error(JSON.stringify({
        success: false,
        error: pollResp.data?.error || '绑定码已过期或已被使用'
      }));
      process.exit(1);
    }
    if (!pollResp.res.ok) {
      // Transient error, keep polling
      continue;
    }
    if (pollResp.data?.status === 'pending') continue;
    if (pollResp.data?.status === 'bound') {
      const creds = pollResp.data;
      writeCredentialsFile({
        userId: creds.userId,
        apiKey: creds.apiKey,
        apiUrl: creds.apiUrl || '',
        toolsUrl: creds.toolsUrl || toolsUrl,
        boundAt: new Date().toISOString()
      });
      process.stderr.write(`\n登录成功：${creds.name || creds.userId}\n`);
      process.stderr.write(`凭证已保存到 ${CREDENTIALS_PATH} (mode 0600)\n`);
      console.log(JSON.stringify({
        success: true,
        userId: creds.userId,
        apiKey: maskApiKey(creds.apiKey),
        name: creds.name || null
      }, null, 2));
      return;
    }
  }

  console.error(JSON.stringify({ success: false, error: '绑定超时，请重新运行 web-publisher login' }));
  process.exit(1);
}

async function runLogout() {
  const creds = loadCredentials();
  if (!creds) {
    process.stderr.write('当前未登录，无需注销。\n');
    return;
  }
  if (creds.source === 'env') {
    process.stderr.write('当前使用环境变量登录，请清除 WEB_PUBLISHER_USER_ID / WEB_PUBLISHER_API_KEY 环境变量。\n');
    return;
  }
  try {
    await tools('POST', '/skill/revoke', {}, creds);
  } catch (err) {
    process.stderr.write(`[warn] 远端撤销失败：${err.message}（仍会清理本地凭证）\n`);
  }
  deleteCredentialsFile();
  process.stderr.write('已清理本地凭证。\n');
  console.log(JSON.stringify({ success: true }, null, 2));
}

async function runWhoami() {
  const creds = requireCredentials();
  const { res, data } = await tools('GET', '/skill/whoami', null, creds);
  if (!res.ok) {
    console.error(JSON.stringify({ success: false, error: data?.error || `HTTP ${res.status}` }));
    process.exit(1);
  }
  console.log(JSON.stringify({
    success: true,
    source: creds.source,
    userId: data.userId,
    name: data.name,
    phone: data.phone,
    apiKey: data.apiKey,
    wechat: data.wechat,
    credits: data.credits
  }, null, 2));
}

async function runWechatConfig() {
  const creds = requireCredentials();
  const { res, data } = await tools('POST', '/skill/wechat/link', {}, creds);
  if (!res.ok) {
    console.error(JSON.stringify({ success: false, error: data?.error || `HTTP ${res.status}` }));
    process.exit(1);
  }
  const link = pickLink(data);
  if (!link) {
    console.error(JSON.stringify({
      success: false,
      error: '服务器没有返回可打开的 AppID/AppSecret 配置短链',
      responseKeys: data && typeof data === 'object' ? Object.keys(data) : []
    }, null, 2));
    process.exit(1);
  }
  const serverIps = Array.isArray(data.serverIps) ? data.serverIps : [];
  process.stderr.write('\n请在浏览器中打开以下链接填写 AppID / AppSecret：\n');
  process.stderr.write(`  ${link}\n`);
  process.stderr.write(`  有效期: ${Math.round((data.expiresInSec || 600) / 60)} 分钟\n`);
  if (serverIps.length > 0) {
    process.stderr.write('\n请把以下 IP 添加到微信公众平台 IP 白名单：\n');
    for (const ip of serverIps) process.stderr.write(`  ${ip}\n`);
  }
  console.log(JSON.stringify({
    success: true,
    url: link,
    instruction: `[AI必读] 你必须把下面这个完整 URL 原文粘贴给用户，不要改写、不要只输出 Markdown 超链接文字、不要用"点击此处"替代。用户需要在浏览器中打开这个 URL 填写 AppID/AppSecret。URL：${link}`,
    serverIps
  }, null, 2));
}

async function runWechatStatus() {
  const creds = requireCredentials();
  const { res, data } = await tools('GET', '/skill/whoami', null, creds);
  if (!res.ok) {
    console.error(JSON.stringify({ success: false, error: data?.error || `HTTP ${res.status}` }));
    process.exit(1);
  }
  console.log(JSON.stringify({
    success: true,
    configured: data.wechat?.configured ?? false,
    appId: data.wechat?.appId ?? null
  }, null, 2));
}

async function runWrapperConfig() {
  const creds = requireCredentials();
  const { res, data } = await tools('POST', '/skill/wrapper/link', {}, creds);
  if (!res.ok) {
    console.error(JSON.stringify({ success: false, error: data?.error || `HTTP ${res.status}` }));
    process.exit(1);
  }
  const link = pickLink(data);
  if (!link) {
    console.error(JSON.stringify({
      success: false,
      error: '服务器没有返回可打开的页眉/页脚配置短链',
      responseKeys: data && typeof data === 'object' ? Object.keys(data) : []
    }, null, 2));
    process.exit(1);
  }
  process.stderr.write('\n请在浏览器中打开以下链接编辑页眉/页脚：\n');
  process.stderr.write(`  ${link}\n`);
  process.stderr.write(`  有效期: ${Math.round((data.expiresInSec || 600) / 60)} 分钟\n`);
  console.log(JSON.stringify({
    success: true,
    url: link,
    instruction: `[AI必读] 你必须把下面这个完整 URL 原文粘贴给用户，不要改写、不要只输出 Markdown 超链接文字、不要用"点击此处"替代。用户需要在浏览器中打开这个 URL 填写页眉/页脚。URL：${link}`
  }, null, 2));
}

async function runWrapperStatus() {
  const creds = requireCredentials();
  const { res, data } = await tools('GET', '/skill/wrapper/status', null, creds);
  if (!res.ok) {
    console.error(JSON.stringify({ success: false, error: data?.error || `HTTP ${res.status}` }));
    process.exit(1);
  }
  console.log(JSON.stringify({
    success: true,
    configured: data.configured,
    enabled: data.enabled,
    headerLen: data.headerLen,
    footerLen: data.footerLen,
    version: data.version,
    updatedAt: data.updatedAt
  }, null, 2));
}

async function runWrapperToggle(enabled) {
  const creds = requireCredentials();
  const { res, data } = await tools('POST', '/skill/wrapper/toggle', { enabled }, creds);
  if (!res.ok) {
    console.error(JSON.stringify({ success: false, error: data?.error || `HTTP ${res.status}` }));
    process.exit(1);
  }
  process.stderr.write(`页眉页脚已${enabled ? '启用' : '关闭'}。\n`);
  console.log(JSON.stringify({ success: true, enabled: data.enabled }, null, 2));
}

// ----------------------------------------------------------------------------
// Help / dispatch
// ----------------------------------------------------------------------------

function showHelp() {
  console.log(`
web-publisher v${PKG_VERSION} — 将网页文章 / 本地文档发布到微信公众号

账号管理（首次使用）:
  login              通过浏览器一次性绑定账号，凭证写入本地
  logout             撤销当前 apiKey 并清除本地凭证
  whoami             查看当前账号、apiKey（已脱敏）与微信配置状态

公众号配置:
  wechat config      生成一次性短链，在浏览器里填写 AppID/AppSecret
  wechat status      查看是否已配置微信公众号

页眉页脚（专业版及以上可用，每篇文章自动加前后内容）:
  wrapper config     生成一次性短链，在浏览器里编辑页眉/页脚
  wrapper status     查看页眉页脚字数与是否启用
  wrapper on         启用页眉页脚（要求已配置页眉或页脚）
  wrapper off        关闭页眉页脚（保留已存内容，下次开启即可恢复）

发布（<input> 可以是 URL 或本地文件路径，本地文件支持 PDF/DOCX/PPTX/XLSX/EPUB/...）:
  draft   <input>    保存为草稿
  publish <input>    直接发布
  status  <jobId>    查询任务状态

文档转 Markdown（不发布，只把任意文档拿成 markdown 文本）:
  convert <input>    本地文件 / URL → markdown
                     选项: --out <file> 写到文件; --async 走异步任务;
                          --timeout <ms> 单次转换上限（封顶 600000）

发布选项:
  --theme <id>       主题（默认: blackink）
                     可选: blackink(墨黑) / default(默认) / orangesun(橙日)
                           redruby(红宝石) / greenmint(薄荷绿) / purplerain(紫雨)
  --rewrite          启用 AI 改写
  --style <style>    改写风格: casual / formal / technical / creative
  --prompt <text>    自定义改写提示

计费（与 /pipeline 一致）:
  draft / publish / convert 各 1 credit；失败不扣；不发用户通知

环境变量（可选，优先级高于本地凭证文件）:
  WEB_PUBLISHER_TOOLS_URL  账号 API 地址（默认 ${DEFAULT_TOOLS_URL}）
  WEB_PUBLISHER_API_URL    pipeline API 地址（登录后会自动写入凭证）
  WEB_PUBLISHER_USER_ID    用户 ID（如 usr_xxxx）
  WEB_PUBLISHER_API_KEY    API Key

凭证文件: ${CREDENTIALS_PATH} (mode 0600)
`);
}

const command = process.argv[2];
const subcommand = process.argv[3];
const args = process.argv.slice(3);

(async () => {
  try {
    switch (command) {
      case 'login':
        await runLogin();
        break;
      case 'logout':
        await runLogout();
        break;
      case 'whoami':
        await runWhoami();
        break;
      case 'wechat':
        if (subcommand === 'config') {
          await runWechatConfig();
        } else if (subcommand === 'status') {
          await runWechatStatus();
        } else {
          console.error(JSON.stringify({ success: false, error: `Unknown wechat subcommand: ${subcommand || '(none)'}\n用法：web-publisher wechat config|status` }));
          process.exit(1);
        }
        break;
      case 'wrapper':
        if (subcommand === 'config') {
          await runWrapperConfig();
        } else if (subcommand === 'status') {
          await runWrapperStatus();
        } else if (subcommand === 'on' || subcommand === 'enable') {
          await runWrapperToggle(true);
        } else if (subcommand === 'off' || subcommand === 'disable') {
          await runWrapperToggle(false);
        } else {
          console.error(JSON.stringify({ success: false, error: `Unknown wrapper subcommand: ${subcommand || '(none)'}\n用法：web-publisher wrapper config|status|on|off` }));
          process.exit(1);
        }
        break;
      case 'publish':
        await runPublish('publish', args);
        break;
      case 'draft':
        await runPublish('draft', args);
        break;
      case 'convert':
        await runConvert(args);
        break;
      case 'status':
        await runStatus(args);
        break;
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        showHelp();
        break;
      default:
        console.error(JSON.stringify({ success: false, error: `Unknown command: ${command}` }));
        process.exit(1);
    }
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: err.message || String(err) }));
    process.exit(1);
  }
})();
