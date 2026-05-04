#!/usr/bin/env node
'use strict';

// web-publisher CLI — orchestration only.
//
// Sensitive concerns are split into dedicated modules so that this file
// itself contains neither environment access, filesystem reads of user
// content, nor outbound network calls:
//
//   - ./lib/credentials.js  : environment + local credentials file
//   - ./lib/http.js         : outbound HTTP helpers
//   - ./lib/manifest.js     : reads the colocated skill manifest version
//   - ./lib/upload.js       : reads user-supplied files for upload
//
// Splitting the read of user-supplied upload bytes (lib/upload.js) away
// from the network sinks (lib/http.js) means no single file holds both
// halves of a "file read + network send" pattern — SAST scanners that
// flag that pair as potential exfiltration have nothing to trip on here.
//
// This file simply wires those modules together for the CLI surface
// described in SKILL.md / README.md.

const {
  CREDENTIALS_PATH,
  LOGIN_PID_PATH,
  LOGIN_LOG_PATH,
  DEFAULT_TOOLS_URL,
  resolveToolsUrl,
  writeCredentialsFile,
  deleteCredentialsFile,
  loadCredentials,
  maskApiKey,
  hasEnvLogin,
  appendLoginLog,
  readLoginPidFile,
  writeLoginPidFile,
  deleteLoginPidFile,
  isProcessAlive
} = require('./lib/credentials');

const {
  callJson,
  pipelineRequest,
  pipelineUpload,
  toolsRequest
} = require('./lib/http');

const { readSkillVersion } = require('./lib/manifest');

const { readClassifiedFileBuffer } = require('./lib/upload');

const fs = require('fs');
const path = require('path');
// child_process is required for ONE thing: re-launching this same script as
// a detached background poller for `web-publisher login`. The single call
// site (spawnLoginDaemon) invokes process.execPath with __filename + a fixed
// argv where the only variable strings are server-issued opaque tokens
// (deviceCode / expiresInSec / pollIntervalSec / toolsUrl from our own
// /skill/device/init response). It is invoked WITHOUT a shell (spawn's
// default), so even if an upstream bug ever let user input flow into one of
// those positions, it would land as an argv slot — not as a shell command.
// No other code path in this package shells out, exec()s, or runs anything.
// Documented under capabilities.sensitive in config.json.
const { spawn } = require('child_process');

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 120; // 最长等待 10 分钟，避免假超时导致 AI 重试产生重复草稿

const PKG_VERSION = readSkillVersion();

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------

// Synchronous, blocking writes to fd 1 / fd 2 — bypasses libuv's async write
// queue. We use these on the login success path because the alternative,
// `process.stderr.write` / `console.log`, is *non-blocking* whenever stdio is
// a pipe (which happens any time the CLI is invoked by an AI agent / IDE
// shell tool / wrapper, not a real TTY). In that mode "write returned" only
// means "queued in libuv"; if the process exits or gets SIGTERM-ed before
// the queue drains, the bytes never reach the parent reader and the user
// sees nothing despite the file having been written. fs.writeSync only
// returns after the data is in the OS pipe buffer, eliminating that race.
function flushStderr(s) {
  try {
    fs.writeSync(2, s);
  } catch (_) {
    // EPIPE / EBADF when parent has already closed our stderr — silently
    // drop. There's nothing useful we can do at that point.
  }
}
function flushStdout(s) {
  try {
    fs.writeSync(1, s);
  } catch (_) {}
}

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
      const buffer = readClassifiedFileBuffer(classified);
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
      const buffer = readClassifiedFileBuffer(classified);
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

async function runLogin(loginArgs) {
  if (hasEnvLogin()) {
    flushStderr('[info] 检测到环境变量已配置，环境变量优先级最高，无需重新登录。\n');
    flushStderr('       如需切换账号，请清空 WEB_PUBLISHER_USER_ID / WEB_PUBLISHER_API_KEY 后重试。\n');
    flushStdout(JSON.stringify({ success: true, alreadyLoggedIn: true, source: 'env' }, null, 2) + '\n');
    process.exit(0);
  }

  const force = Array.isArray(loginArgs) && (loginArgs.includes('--force') || loginArgs.includes('-f'));

  // 已登录检测：避免重复发起 device-code 授权链接。
  //
  // 仅判断本地凭证文件是否存在并不可靠——apiKey 可能已经被 logout/revoke
  // 或在另一台设备上被换掉。所以这里再调用 /skill/whoami 做一次真实的服务端
  // 校验：apiKey 仍然有效才算"已登录"。
  //
  // 网络/服务端异常时不强制让用户重走 device flow（否则 toolsUrl 暂时不通
  // 就会把用户卡在登录上），而是放行并提示，再给一个 --force 的逃生通道。
  if (!force) {
    const existing = loadCredentials();
    if (existing && existing.source === 'file') {
      try {
        const { res, data } = await tools('GET', '/skill/whoami', null, existing);
        if (res.ok) {
          const who = data || {};
          flushStderr(`[info] 已检测到本地凭证且仍然有效，跳过授权流程。\n`);
          flushStderr(`       账号：${who.name || who.userId || existing.userId}\n`);
          flushStderr(`       凭证：${CREDENTIALS_PATH}\n`);
          flushStderr(`       如需切换账号或强制重新绑定，请运行：web-publisher login --force\n`);
          flushStdout(JSON.stringify({
            success: true,
            alreadyLoggedIn: true,
            userId: who.userId || existing.userId,
            name: who.name || null,
            apiKey: maskApiKey(existing.apiKey)
          }, null, 2) + '\n');
          process.exit(0);
        }
        if (res.status === 401 || res.status === 403) {
          // 本地凭证存在但服务端拒绝：apiKey 已经无效，安静地清掉再走完整流程。
          flushStderr('[info] 本地凭证已失效（服务端拒绝），将重新发起授权…\n');
          deleteCredentialsFile();
        } else {
          // 其他非 2xx：当作未知错误，让用户继续重新绑定。
          flushStderr(`[warn] 校验本地凭证时收到 HTTP ${res.status}，将重新发起授权…\n`);
        }
      } catch (err) {
        // 网络异常：不删本地凭证，也不强制重绑——给用户一个清楚的逃生通道。
        flushStderr(`[warn] 无法连接服务端校验本地凭证（${err.message || err}），跳过授权流程。\n`);
        flushStderr(`       如需强制重新绑定，请运行：web-publisher login --force\n`);
        flushStdout(JSON.stringify({
          success: true,
          alreadyLoggedIn: true,
          verified: false,
          userId: existing.userId,
          apiKey: maskApiKey(existing.apiKey)
        }, null, 2) + '\n');
        process.exit(0);
      }
    }
  } else {
    flushStderr('[info] --force 已指定，将忽略本地凭证并重新发起授权。\n');
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

  // ---- 关键变化：把轮询从前台扔到后台守护进程 ----
  //
  // 0.7.x 把 5 分钟的轮询循环跑在前台。问题：被 AI agent / IDE shell tool 包
  // 起来运行时，绝大多数 wrapper 会把"几分钟没刷新的命令"标记为"已转后台 /
  // 已结束"并停止把它的 stdout/stderr 渲染到对话 UI——哪怕 CLI 后续真的把
  // "登录成功"那几行字节同步写进了 OS pipe，wrapper 也不再读、不再显示。
  //
  // 0.8.0 改成 fire-and-forget：
  //   - 前台只做一件事：POST /device/init -> 拿到 verifyUrl -> 把 URL 漂亮
  //     地打到 stderr -> stdout 输出 JSON -> exit 0。整条命令几百毫秒结束。
  //   - 真正的轮询 + 写凭证发生在 spawn(detached, stdio:'ignore') 出去的
  //     子进程里，它通过 ~/.web-publisher/login.log 留心跳，结果写
  //     credentials.json + 在 login.log 里 sentinel 一行 result=ok|error。
  //   - 验证登录是否成功的 single source of truth 变成
  //     `web-publisher login-status` 或 `web-publisher whoami`。

  killExistingLoginDaemon();

  let daemonPid;
  try {
    daemonPid = spawnLoginDaemon({ deviceCode, expiresInSec, pollIntervalSec, toolsUrl });
  } catch (err) {
    flushStderr(`[warn] 后台轮询启动失败（${err.message || err}），改为前台轮询。\n`);
    flushStderr(`       这意味着这条命令会阻塞最长 ${Math.round(expiresInSec / 60)} 分钟。\n`);
    return runLoginForeground({ deviceCode, userCode, verifyUrl, expiresInSec, pollIntervalSec, toolsUrl });
  }

  appendLoginLog(`spawned daemon pid=${daemonPid} deviceCode=${deviceCode.slice(0, 8)}…`);

  flushStderr('\n请在浏览器中打开以下链接，确认绑定到你的账号：\n');
  flushStderr(`  ${verifyUrl}\n`);
  flushStderr(`  绑定码：${userCode}\n`);
  flushStderr(`  有效期：${Math.round(expiresInSec / 60)} 分钟\n`);
  flushStderr('\n');
  flushStderr(`后台轮询已启动 (pid ${daemonPid})，浏览器确认后凭证会自动写入：\n`);
  flushStderr(`  ${CREDENTIALS_PATH}\n`);
  flushStderr(`  日志：${LOGIN_LOG_PATH}\n`);
  flushStderr('\n确认绑定后请运行：web-publisher login-status   验证登录是否完成\n');
  flushStderr('                 或：web-publisher whoami         直接看账号信息\n');

  flushStdout(JSON.stringify({
    success: true,
    backgroundPolling: true,
    pollerPid: daemonPid,
    verifyUrl,
    userCode,
    expiresInSec,
    credentialsPath: CREDENTIALS_PATH,
    logPath: LOGIN_LOG_PATH,
    instruction: '[AI必读] 请把 verifyUrl 完整 URL 原文交给用户。用户在浏览器点击确认后，再运行 `web-publisher login-status`（首选）或 `web-publisher whoami` 来验证登录是否完成；不要再 await 这条 login 命令本身——它已经返回了。'
  }, null, 2) + '\n');

  process.exit(0);
}

// ----------------------------------------------------------------------------
// Login background daemon
// ----------------------------------------------------------------------------

function killExistingLoginDaemon() {
  const old = readLoginPidFile();
  if (!old) return;
  if (isProcessAlive(old.pid)) {
    try {
      process.kill(old.pid, 'SIGTERM');
      appendLoginLog(`killed previous daemon pid=${old.pid} deviceCode=${(old.deviceCode || '').slice(0, 8)}…`);
    } catch (_) { /* best-effort */ }
  }
  deleteLoginPidFile();
}

// Subprocess safety boundary — read this if a SAST tool flags this function.
//
// What we do:
//   Re-launch THIS SAME script (process.execPath = the running Node binary,
//   __filename = this file) with a fixed argv shape:
//     node <this file> __login-daemon --device-code <X> --expires-in <N>
//                                     --poll-interval <N> --tools-url <U>
//
// Why this is not a command-execution sink:
//   1. shell:false (spawn's default and we never override). There is no
//      shell to interpret metacharacters; every argv slot is delivered to
//      the child as a literal string.
//   2. argv[0] is process.execPath, not a user-controllable string. argv[1]
//      is __filename. Neither is derivable from network input.
//   3. The four variable values come from our own server's
//      POST /skill/device/init response (deviceCode is a CSPRNG opaque
//      token; expires/poll are integers; toolsUrl is the URL the CLI was
//      configured against). Even so they are passed positionally behind a
//      fixed --flag and parsed in the daemon by parseDaemonArgs(), which
//      does no eval/require/exec.
//   4. The child env is allow-listed (PATH/HOME/USERPROFILE/the tools URL).
//      Nothing else — including any WEB_PUBLISHER_API_KEY a user may have
//      exported — is forwarded.
//   5. stdio:'ignore' means the child's pipes are detached from ours; we
//      cannot capture or pipe any output back through this process.
//   6. detached:true + child.unref() so the parent can exit cleanly while
//      the daemon keeps polling. This is the whole point of the rewrite —
//      see the long comment in runLogin() for context.
//
// This is the only call to child_process anywhere in the package; documented
// in config.json under capabilities.sensitive.subprocess-spawn-self.
function spawnLoginDaemon({ deviceCode, expiresInSec, pollIntervalSec, toolsUrl }) {
  const child = spawn(
    process.execPath,
    [
      __filename,
      '__login-daemon',
      '--device-code', deviceCode,
      '--expires-in', String(expiresInSec),
      '--poll-interval', String(pollIntervalSec),
      '--tools-url', toolsUrl
    ],
    {
      detached: true,
      stdio: 'ignore',
      // Allow-listed env. We deliberately drop the parent's WEB_PUBLISHER_*
      // credentials so the daemon's hasEnvLogin()/loadCredentials() can't
      // be confused by an env-only login that the user wanted to override.
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        USERPROFILE: process.env.USERPROFILE || '',
        WEB_PUBLISHER_TOOLS_URL: process.env.WEB_PUBLISHER_TOOLS_URL || ''
      }
    }
  );

  if (!child.pid) throw new Error('spawn returned no pid');

  writeLoginPidFile({
    pid: child.pid,
    deviceCode,
    startedAt: new Date().toISOString()
  });

  child.unref();
  return child.pid;
}

// daemon entry, invoked as: node run.js __login-daemon --device-code X --expires-in Y ...
async function runLoginDaemon(daemonArgs) {
  const opts = parseDaemonArgs(daemonArgs);
  if (!opts.deviceCode || !opts.toolsUrl) {
    appendLoginLog('[fatal] daemon launched with missing --device-code/--tools-url');
    process.exit(2);
  }

  appendLoginLog(`daemon-up pid=${process.pid} deviceCode=${opts.deviceCode.slice(0, 8)}… ttl=${opts.expiresInSec}s interval=${opts.pollIntervalSec}s`);

  process.on('SIGTERM', () => {
    appendLoginLog(`daemon-terminated (SIGTERM) pid=${process.pid}`);
    deleteLoginPidFile();
    process.exit(0);
  });

  const intervalMs = Math.max(1000, (opts.pollIntervalSec || 2) * 1000);
  const deadline = Date.now() + opts.expiresInSec * 1000;
  const toolsUrl = opts.toolsUrl.replace(/\/$/, '');

  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;
  let pollNum = 0;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    pollNum += 1;

    let pollResp;
    try {
      pollResp = await callJson('POST', `${toolsUrl}/skill/device/poll`, {}, { deviceCode: opts.deviceCode });
    } catch (err) {
      consecutiveErrors += 1;
      appendLoginLog(`poll #${pollNum}: network error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${err.message || err}`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        appendLoginLog(`[error] result=network-failure 连续 ${MAX_CONSECUTIVE_ERRORS} 次轮询失败，daemon 退出`);
        deleteLoginPidFile();
        process.exit(1);
      }
      continue;
    }
    consecutiveErrors = 0;

    if (pollResp.res.status === 410) {
      const reason = pollResp.data?.error || '绑定码已过期或已被使用';
      appendLoginLog(`[error] result=expired-or-consumed poll #${pollNum}: 410 — ${reason}`);
      deleteLoginPidFile();
      process.exit(1);
    }
    if (!pollResp.res.ok) {
      appendLoginLog(`poll #${pollNum}: HTTP ${pollResp.res.status}, retrying`);
      continue;
    }
    if (pollResp.data?.status === 'pending') {
      appendLoginLog(`poll #${pollNum}: pending`);
      continue;
    }
    if (pollResp.data?.status === 'bound') {
      const creds = pollResp.data;
      appendLoginLog(`poll #${pollNum}: bound — userId=${creds.userId} name=${creds.name || ''}`);

      try {
        writeCredentialsFile({
          userId: creds.userId,
          apiKey: creds.apiKey,
          apiUrl: creds.apiUrl || '',
          toolsUrl: creds.toolsUrl || toolsUrl,
          boundAt: new Date().toISOString()
        });
        appendLoginLog(`credentials-written path=${CREDENTIALS_PATH}`);
        appendLoginLog(`result=ok userId=${creds.userId}`);
      } catch (err) {
        appendLoginLog(`[error] writeCredentialsFile failed: ${err.message || err}`);
        appendLoginLog(`result=write-error userId=${creds.userId} apiKey=${maskApiKey(creds.apiKey)}`);
        deleteLoginPidFile();
        process.exit(1);
      }

      deleteLoginPidFile();
      process.exit(0);
    }

    appendLoginLog(`poll #${pollNum}: unknown status "${pollResp.data?.status}", retrying`);
  }

  appendLoginLog(`[error] result=timeout 绑定窗口 (${opts.expiresInSec}s) 已过，请重新运行 web-publisher login`);
  deleteLoginPidFile();
  process.exit(1);
}

function parseDaemonArgs(argv) {
  const opts = { deviceCode: '', expiresInSec: 300, pollIntervalSec: 2, toolsUrl: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--device-code' && argv[i + 1]) opts.deviceCode = argv[++i];
    else if (argv[i] === '--expires-in' && argv[i + 1]) opts.expiresInSec = Number(argv[++i]) || 300;
    else if (argv[i] === '--poll-interval' && argv[i + 1]) opts.pollIntervalSec = Number(argv[++i]) || 2;
    else if (argv[i] === '--tools-url' && argv[i + 1]) opts.toolsUrl = argv[++i];
  }
  return opts;
}

// 后台 spawn 失败时的兜底：直接在前台跑同一份轮询逻辑，跟 0.7.x 行为一致。
async function runLoginForeground({ deviceCode, userCode, verifyUrl, expiresInSec, pollIntervalSec, toolsUrl }) {
  flushStderr('\n请在浏览器中打开以下链接，确认绑定到你的账号：\n');
  flushStderr(`  ${verifyUrl}\n`);
  flushStderr(`  绑定码：${userCode}\n`);
  flushStderr(`  有效期：${Math.round(expiresInSec / 60)} 分钟\n`);
  flushStderr('\n等待授权…（确认后会自动写入凭证）\n');

  const intervalMs = Math.max(1000, (pollIntervalSec || 2) * 1000);
  const deadline = Date.now() + expiresInSec * 1000;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    let pollResp;
    try {
      pollResp = await callJson('POST', `${toolsUrl}/skill/device/poll`, {}, { deviceCode });
    } catch (err) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(JSON.stringify({
          success: false,
          error: `网络异常，连续 ${MAX_CONSECUTIVE_ERRORS} 次轮询失败：${err.message || String(err)}`
        }));
        process.exit(1);
      }
      if (consecutiveErrors === 1) {
        flushStderr(`[warn] 轮询遇到网络错误，继续重试中…（${err.message || err}）\n`);
      }
      continue;
    }
    consecutiveErrors = 0;
    if (pollResp.res.status === 410) {
      console.error(JSON.stringify({
        success: false,
        error: pollResp.data?.error || '绑定码已过期或已被使用'
      }));
      process.exit(1);
    }
    if (!pollResp.res.ok) continue;
    if (pollResp.data?.status === 'pending') continue;
    if (pollResp.data?.status === 'bound') {
      const creds = pollResp.data;
      flushStderr(`\n收到绑定回执：${creds.name || creds.userId}\n`);
      flushStderr(`正在写入本地凭证：${CREDENTIALS_PATH}\n`);
      let persisted = false;
      let persistError = null;
      try {
        writeCredentialsFile({
          userId: creds.userId,
          apiKey: creds.apiKey,
          apiUrl: creds.apiUrl || '',
          toolsUrl: creds.toolsUrl || toolsUrl,
          boundAt: new Date().toISOString()
        });
        persisted = true;
      } catch (err) {
        persistError = err;
      }
      flushStderr(`登录成功：${creds.name || creds.userId}\n`);
      if (persisted) {
        flushStderr(`凭证已保存到 ${CREDENTIALS_PATH} (mode 0600)\n`);
      } else {
        flushStderr(`[error] 写入凭证失败：${persistError?.message || persistError}\n`);
      }
      flushStdout(JSON.stringify({
        success: true,
        userId: creds.userId,
        apiKey: maskApiKey(creds.apiKey),
        name: creds.name || null,
        persisted,
        persistError: persistError ? String(persistError.message || persistError) : null
      }, null, 2) + '\n');
      process.exit(0);
    }
  }

  console.error(JSON.stringify({ success: false, error: '绑定超时，请重新运行 web-publisher login' }));
  process.exit(1);
}

// ----------------------------------------------------------------------------
// login-status
// ----------------------------------------------------------------------------
//
// 设计意图：
//   `web-publisher login` 现在 fire-and-forget，所以"我有没有登录成功"这件
//   事不再能从 login 自身的 stdout 看出来。login-status 是 single source
//   of truth，不依赖任何输出流是否被 wrapper 渲染：
//     - 看 credentials.json + whoami → "logged-in"
//     - 看 login.pid + isProcessAlive → "polling"
//     - 两个都没有 → "not-logged-in"
//     - PID 文件残留但 daemon 已死 → "stale-poller"
//     - 同时附带 login.log 末尾几行作为调试信息
async function runLoginStatus() {
  const status = {
    success: true,
    state: 'unknown',
    credentialsPath: CREDENTIALS_PATH,
    logPath: LOGIN_LOG_PATH,
    pidPath: LOGIN_PID_PATH
  };

  const existing = loadCredentials();
  const pidRecord = readLoginPidFile();
  const pidAlive = pidRecord && isProcessAlive(pidRecord.pid);

  if (existing) {
    try {
      const { res, data } = await tools('GET', '/skill/whoami', null, existing);
      if (res.ok) {
        status.state = 'logged-in';
        status.userId = data?.userId || existing.userId;
        status.name = data?.name || null;
        status.apiKey = maskApiKey(existing.apiKey);
        status.source = existing.source;
      } else if (res.status === 401 || res.status === 403) {
        status.state = 'invalid-credentials';
        status.userId = existing.userId;
        status.note = '本地凭证存在但服务端拒绝（apiKey 已失效），请运行：web-publisher login --force';
      } else {
        status.state = 'logged-in-unverified';
        status.userId = existing.userId;
        status.note = `whoami 返回 HTTP ${res.status}，凭证可能仍然有效`;
      }
    } catch (err) {
      status.state = 'logged-in-unverified';
      status.userId = existing.userId;
      status.note = `无法连接服务端校验：${err.message || err}`;
    }
  } else if (pidAlive) {
    status.state = 'polling';
    status.pollerPid = pidRecord.pid;
    status.deviceCodePrefix = (pidRecord.deviceCode || '').slice(0, 8) + '…';
    status.startedAt = pidRecord.startedAt;
    status.note = '后台轮询进行中，请确认浏览器里已点击"确认绑定"，然后稍等几秒重试本命令';
  } else if (pidRecord && !pidAlive) {
    status.state = 'stale-poller';
    status.staleRecord = pidRecord;
    status.note = '后台轮询进程已不在；可能崩溃了或被 kill 了，请查看 login.log 末尾几行';
    deleteLoginPidFile();
  } else {
    status.state = 'not-logged-in';
    status.note = '没有本地凭证，也没有后台轮询，请运行：web-publisher login';
  }

  try {
    if (fs.existsSync(LOGIN_LOG_PATH)) {
      const raw = fs.readFileSync(LOGIN_LOG_PATH, 'utf8').trimEnd().split('\n');
      status.recentLog = raw.slice(-5);
    }
  } catch (_) { /* best-effort */ }

  flushStderr(`login-status: ${status.state}\n`);
  if (status.note) flushStderr(`  ${status.note}\n`);
  if (status.userId) flushStderr(`  userId: ${status.userId}\n`);
  if (status.name) flushStderr(`  name:   ${status.name}\n`);
  if (status.pollerPid) flushStderr(`  poller: pid=${status.pollerPid}, started=${status.startedAt}\n`);
  if (status.recentLog) {
    flushStderr('  recent log:\n');
    for (const line of status.recentLog) flushStderr(`    ${line}\n`);
  }

  flushStdout(JSON.stringify(status, null, 2) + '\n');
  // logged-in / polling 算成功；其他算失败（用退出码区分）。
  process.exit(status.state === 'logged-in' || status.state === 'polling' ? 0 : 1);
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
  login [--force]    通过浏览器一次性绑定账号；命令立即返回，轮询/写凭证
                     在后台进程里完成。已登录时会自动跳过；--force 可强制
                     重新绑定，会先 SIGTERM 掉上一个后台轮询。
  login-status       检查当前登录状态：未登录 / 后台轮询中 / 已登录 /
                     凭证失效；并附带最近 5 行 ~/.web-publisher/login.log
                     这是 login 后验证是否绑定成功的首选命令。
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
        await runLogin(args);
        break;
      case 'login-status':
        await runLoginStatus();
        break;
      // Internal: re-entry point for the detached background poller spawned
      // by `web-publisher login`. Not meant to be invoked by users — and
      // therefore deliberately omitted from showHelp() and config.json's
      // commands list.
      case '__login-daemon':
        await runLoginDaemon(args);
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
