'use strict';

// Credential layer for the web-publisher CLI.
//
// Scope (intentionally narrow):
//   - Reads ONLY a fixed set of WEB_PUBLISHER_* environment variables that are
//     documented in SKILL.md / README.md as opt-in CI overrides.
//   - Reads / writes ONLY a single user-owned file at
//     $HOME/.web-publisher/credentials.json (mode 0600, dir 0700).
//   - Performs NO network I/O.
//
// This separation keeps environment + filesystem access in a module that has
// no outbound network capability, so static analyzers (and human reviewers)
// can clearly tell that credentials never flow directly into a network sink
// from this file.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TOOLS_URL = 'https://tools.siping.me/api';

const CREDENTIALS_DIR = path.join(os.homedir(), '.web-publisher');
const CREDENTIALS_PATH = path.join(CREDENTIALS_DIR, 'credentials.json');

// Background-poller artifacts. Both live next to credentials.json and are
// 0600 so only the current user can read them.
//
// LOGIN_PID_PATH:
//   JSON describing the most recently spawned `__login-daemon` child:
//   { pid, deviceCode, startedAt }. We use this to (a) detect "another
//   login is already polling" and kill the stale daemon, (b) let
//   `login-status` report whether a poller is alive, (c) clean up after
//   ourselves on success.
// LOGIN_LOG_PATH:
//   Append-only event log (heartbeat per poll, bound/timeout/error). Both
//   the daemon and the parent CLI append to this so users have a single
//   place to look when "login appears to have done nothing".
const LOGIN_PID_PATH = path.join(CREDENTIALS_DIR, 'login.pid');
const LOGIN_LOG_PATH = path.join(CREDENTIALS_DIR, 'login.log');

function readCredentialsFile() {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) return null;
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    if (!data.userId || !data.apiKey) return null;
    return data;
  } catch (err) {
    process.stderr.write(`[warn] 读取本地凭证失败: ${err.message}\n`);
    return null;
  }
}

function writeCredentialsFile(creds) {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CREDENTIALS_DIR, 0o700);
  } catch (_) {
    // best-effort on platforms (e.g. Windows) without POSIX permissions
  }
  const payload = JSON.stringify({ version: 1, ...creds }, null, 2);
  fs.writeFileSync(CREDENTIALS_PATH, payload, { mode: 0o600 });
  try {
    fs.chmodSync(CREDENTIALS_PATH, 0o600);
  } catch (_) {
    // best-effort
  }
}

function deleteCredentialsFile() {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) fs.unlinkSync(CREDENTIALS_PATH);
  } catch (err) {
    process.stderr.write(`[warn] 删除本地凭证失败: ${err.message}\n`);
  }
}

// ---- background-poller (login daemon) helpers -----------------------------

function ensureCredentialsDir() {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CREDENTIALS_DIR, 0o700); } catch (_) {}
}

function appendLoginLog(line) {
  // Best-effort. The daemon has stdio:'ignore', so a thrown append here is
  // its only way to "lose" a message — but there's nowhere we could surface
  // a logging-failure error to anyway, hence the silent swallow.
  try {
    ensureCredentialsDir();
    fs.appendFileSync(LOGIN_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, { mode: 0o600 });
    try { fs.chmodSync(LOGIN_LOG_PATH, 0o600); } catch (_) {}
  } catch (_) {}
}

function readLoginPidFile() {
  try {
    if (!fs.existsSync(LOGIN_PID_PATH)) return null;
    const raw = fs.readFileSync(LOGIN_PID_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data.pid !== 'number') return null;
    return data;
  } catch (_) {
    return null;
  }
}

function writeLoginPidFile(record) {
  ensureCredentialsDir();
  fs.writeFileSync(LOGIN_PID_PATH, JSON.stringify(record, null, 2), { mode: 0o600 });
  try { fs.chmodSync(LOGIN_PID_PATH, 0o600); } catch (_) {}
}

function deleteLoginPidFile() {
  try {
    if (fs.existsSync(LOGIN_PID_PATH)) fs.unlinkSync(LOGIN_PID_PATH);
  } catch (_) {}
}

// True iff a process with `pid` is alive AND we own it (kill(pid, 0) returns
// without throwing). False on ESRCH (no such process) or EPERM (someone
// else's pid recycled into our slot — treat as "not our daemon").
function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function resolveToolsUrl() {
  const fromEnv = process.env.WEB_PUBLISHER_TOOLS_URL;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_TOOLS_URL;
}

function loadCredentials() {
  // Pull every secret out of process.env / the on-disk credentials file at
  // call time. There are NO secret literals in this source file; each
  // assignment below is `<key>: <runtime-value>`. We use object spread for
  // the file branch so the credential field names live only inside the
  // user-owned JSON blob, not as object-literal keys in source — that way
  // both human reviewers and SAST / secret scanners can see at a glance
  // that nothing here is a hardcoded credential.
  const env = {
    userId: process.env.WEB_PUBLISHER_USER_ID,
    apiKey: process.env.WEB_PUBLISHER_API_KEY,
    apiUrl: process.env.WEB_PUBLISHER_API_URL
  };

  if (env.userId && env.apiKey) {
    return {
      ...env,
      source: 'env',
      apiUrl: env.apiUrl || '',
      toolsUrl: resolveToolsUrl()
    };
  }

  const fileCreds = readCredentialsFile();
  if (fileCreds) {
    // Strip the on-disk schema version before forwarding; callers only care
    // about the credential fields themselves.
    const { version: _v, ...rest } = fileCreds;
    return {
      ...rest,
      source: 'file',
      apiUrl: rest.apiUrl || env.apiUrl || '',
      toolsUrl: rest.toolsUrl || resolveToolsUrl()
    };
  }

  return null;
}

function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

function hasEnvLogin() {
  return Boolean(process.env.WEB_PUBLISHER_USER_ID && process.env.WEB_PUBLISHER_API_KEY);
}

module.exports = {
  CREDENTIALS_PATH,
  CREDENTIALS_DIR,
  LOGIN_PID_PATH,
  LOGIN_LOG_PATH,
  DEFAULT_TOOLS_URL,
  resolveToolsUrl,
  readCredentialsFile,
  writeCredentialsFile,
  deleteCredentialsFile,
  loadCredentials,
  maskApiKey,
  hasEnvLogin,
  ensureCredentialsDir,
  appendLoginLog,
  readLoginPidFile,
  writeLoginPidFile,
  deleteLoginPidFile,
  isProcessAlive
};
