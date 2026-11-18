// JarvisVoice 帳號（選用的一種設定方式，跟自己的 key、本機辨識並列）：登入後轉寫、AI 整理、語音指令的判斷都走 JarvisVoice 伺服器，
// 用帳號的點數（在選單「購買點數…」買），不用準備任何 key。沒登入的人完全用不到這個檔。
//
//   - 登入：OAuth 2.1 授權碼＋PKCE（S256）。在 127.0.0.1 開一個隨機 port 等回呼（RFC 8252），打開瀏覽器登入後按允許。
//     scope=voice：拿到的 token 只能用在語音輸入（/ws/transcription、/voice/check、/voice/ai_prompt），
//     看不到、也改不了帳號裡的其他資料；帳號設定頁「已連線的 AI 工具」隨時可以撤銷。
//   - token：access 1 小時、refresh 30 天（每次換新，30 天內用過就一直有效）。macOS 存在鑰匙圈，不寫進設定檔；
//     其他系統（測試）存在狀態資料夾裡只有自己讀得到的檔案。換到的新 token 先存再用。
//   - 狀態資料夾的 account.json 只記「登入了哪個伺服器、哪個帳號」（不是秘密），常駐程式與選單用它判斷有沒有登入。
//   - 點數不足：轉寫連線前先問 /voice/check（60 秒內問過就不再問），AI 整理收到 quota_exceeded，都丟 AccountError，
//     訊息說點數用完、可以換回本機辨識或自己的 key。

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { STATE_DIR } from './config.mjs';

export const SCOPE = 'voice';
export const ACCOUNT_FILE = 'account.json';
const KEYCHAIN_SERVICE = 'JarvisVoice';
const REFRESH_EARLY_MS = 5 * 60_000; // access token 剩不到 5 分鐘就先換
const CHECK_CACHE_MS = 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

const zh = () => /^zh/i.test(process.env.VOICE_DICTATION_LANG || process.env.LANG || '');
const t = (zhText, enText) => (zh() ? zhText : enText);

// code：not_logged_in（還沒登入）、login_expired（登入失效：過期、被撤銷）、quota_exceeded（點數不足）、denied（按了拒絕）、
// unsupported（這個伺服器還沒開放語音輸入登入）
export class AccountError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
  }
}

const notLoggedIn = () => new AccountError('not_logged_in', t('還沒登入 JarvisVoice：從選單按「登入 JarvisVoice…」，或換回本機辨識／自己的 key',
  'Not signed in to JarvisVoice: choose "Sign in to JarvisVoice…" in the menu, or switch back to on-device / your own key'));
const loginExpired = () => new AccountError('login_expired', t('JarvisVoice 登入已失效：從選單重新「登入 JarvisVoice…」',
  'Your JarvisVoice sign-in has expired: choose "Sign in to JarvisVoice…" in the menu again'));
const unsupported = () => new AccountError('unsupported', t('這個伺服器還沒開放「登入 JarvisVoice」：先用本機辨識或自己的 key',
  'This server does not support "Sign in to JarvisVoice" yet: use on-device recognition or your own key for now'));
const quotaExceeded = () => new AccountError('quota_exceeded', t('點數用完了：從選單「購買點數…」加值，或換回本機辨識／自己的 key',
  'Out of credits: choose "Buy credits…" in the menu, or switch back to on-device / your own key'));

export const trimUrl = (url) => String(url || '').replace(/\/+$/, '');
const hostOf = (apiUrl) => new URL(apiUrl).host;

// ── 登入了哪個伺服器（不是秘密）──

export function readAccount(stateDir = STATE_DIR) {
  try {
    return JSON.parse(readFileSync(join(stateDir, ACCOUNT_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function writeAccount(stateDir, account) {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, ACCOUNT_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(account, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

function removeAccount(stateDir) {
  try { unlinkSync(join(stateDir, ACCOUNT_FILE)); } catch { /* 本來就沒有 */ }
}

// ── token 放哪：macOS 鑰匙圈，其他系統放只有自己讀得到的檔案（VOICE_DICTATION_TOKEN_STORE=file／keychain 可以指定）──

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
  });
}

export function tokenStore(apiUrl, { stateDir = STATE_DIR, kind = process.env.VOICE_DICTATION_TOKEN_STORE || (process.platform === 'darwin' ? 'keychain' : 'file') } = {}) {
  const account = hostOf(apiUrl);
  const security = process.env.VOICE_DICTATION_SECURITY_BIN || '/usr/bin/security';
  if (kind === 'keychain') {
    return {
      kind,
      async read() {
        try {
          return JSON.parse((await run(security, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'])).trim());
        } catch {
          return null; // 沒有這筆（exit 44）或讀不懂，都當成沒登入
        }
      },
      async write(tokens) {
        try {
          await run(security, ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-l', KEYCHAIN_SERVICE, '-w', JSON.stringify(tokens)]);
        } catch (err) {
          throw new Error(t(`JarvisVoice 登入存不進鑰匙圈：${String(err.stderr || err.message).trim()}`, `Couldn't save the JarvisVoice sign-in to the Keychain: ${String(err.stderr || err.message).trim()}`));
        }
      },
      async clear() {
        try { await run(security, ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]); } catch { /* 本來就沒有 */ }
      },
    };
  }
  const file = join(stateDir, `account-token-${account.replace(/[^\w.-]/g, '_')}.json`);
  return {
    kind: 'file',
    async read() {
      try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
    },
    async write(tokens) {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(tokens), { mode: 0o600 });
      chmodSync(`${file}.tmp`, 0o600);
      renameSync(`${file}.tmp`, file);
    },
    async clear() {
      try { unlinkSync(file); } catch { /* 本來就沒有 */ }
    },
  };
}

// ── HTTP ──

async function request(url, { method = 'POST', headers = {}, body, form, json, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  let payload = body;
  const h = { ...headers };
  if (form) { payload = new URLSearchParams(form).toString(); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
  if (json) { payload = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
  let res;
  try {
    res = await fetch(url, { method, headers: h, body: payload, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(t(`連不到 JarvisVoice 伺服器（${new URL(url).host}）：${err.cause?.code || err.message}`, `Can't reach the JarvisVoice server (${new URL(url).host}): ${err.cause?.code || err.message}`));
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 不是 JSON */ }
  return { status: res.status, headers: res.headers, data, text };
}

const tokensFrom = (data, clientId) => ({
  accessToken: data.access_token,
  refreshToken: data.refresh_token,
  expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  clientId,
});

// ── 登入 ──

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const page = (title, body) => `<!doctype html><html lang="${zh() ? 'zh-Hant' : 'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px -apple-system,BlinkMacSystemFont,sans-serif;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#f5f5f7;color:#1d1d1f}
main{max-width:420px;padding:32px;text-align:center}h1{font-size:22px;margin:0 0 12px}p{margin:0;color:#555;line-height:1.6}
@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}p{color:#aaa}}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

// 登入：開瀏覽器登入後按允許，拿到 token 存好，回傳 { email }。openUrl(url) 負責打開瀏覽器（測試換成假的）。
// onWaiting(url)：瀏覽器打開了、等使用者按允許。signal：取消（選單再按一次、結束小程式）。
export async function login({ apiUrl, stateDir = STATE_DIR, openUrl, onWaiting = () => {}, signal, timeoutMs = LOGIN_TIMEOUT_MS, store } = {}) {
  apiUrl = trimUrl(apiUrl);
  store ??= tokenStore(apiUrl, { stateDir });
  // 先確認伺服器認得 voice scope：不認得的舊版會把它當成外部 MCP 的授權（要 Max、可以讀寫資料），不能讓使用者按到那個同意頁
  const meta = await request(`${apiUrl}/.well-known/oauth-authorization-server`, { method: 'GET' });
  if (meta.status !== 200 || !Array.isArray(meta.data?.scopes_supported) || !meta.data.scopes_supported.includes(SCOPE)) throw unsupported();
  // 每次登入都重新登記一次 client（public client，沒有秘密）：不用記 client_id，伺服器那邊清過資料也不會卡住
  const reg = await request(`${apiUrl}/oauth/register`, {
    json: { client_name: 'JarvisVoice', redirect_uris: ['http://127.0.0.1/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
  });
  const clientId = reg.data?.client_id;
  if (reg.status !== 201 || !clientId) throw new Error(t(`JarvisVoice 登入失敗（登記 HTTP ${reg.status}）`, `JarvisVoice sign-in failed (register HTTP ${reg.status})`));

  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString('base64url');
  let finish;
  const done = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const reply = (status, title, body) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page(title, body));
    };
    if (u.searchParams.get('state') !== state) {
      reply(400, t('登入沒有完成', 'Sign-in not completed'), t('這個網址不是這次登入的，回到 JarvisVoice 選單重新按一次「登入 JarvisVoice…」。', 'This link is not from this sign-in. Choose "Sign in to JarvisVoice…" in the JarvisVoice menu again.'));
      return;
    }
    const error = u.searchParams.get('error');
    if (error) {
      reply(200, t('沒有登入', 'Not signed in'), t('你沒有允許，JarvisVoice 照原本的設定用。可以關掉這頁。', 'You did not allow it; JarvisVoice keeps your current setup. You can close this page.'));
      finish.reject(error === 'access_denied'
        ? new AccountError('denied', t('你按了拒絕，沒有登入', 'You chose Deny; not signed in'))
        : new Error(t(`JarvisVoice 登入失敗：${u.searchParams.get('error_description') || error}`, `JarvisVoice sign-in failed: ${u.searchParams.get('error_description') || error}`)));
      return;
    }
    reply(200, t('JarvisVoice 已登入', 'JarvisVoice is signed in'),
      t('轉寫與 AI 整理改用你的帳號點數。可以關掉這頁，回去講話了。', 'Transcription and AI cleanup now use your credits. You can close this page and start talking.'));
    finish.resolve(u.searchParams.get('code') || '');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const timer = setTimeout(() => finish.reject(new Error(t('等太久沒有完成登入（5 分鐘），再按一次「登入 JarvisVoice…」', 'Sign-in timed out (5 minutes); choose "Sign in to JarvisVoice…" again'))), timeoutMs);
  const onAbort = () => finish.reject(new AccountError('cancelled', t('取消登入', 'Sign-in cancelled')));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const authorize = `${apiUrl}/oauth/authorize?${new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: SCOPE,
      code_challenge: challenge, code_challenge_method: 'S256', state,
    })}`;
    await openUrl(authorize);
    onWaiting(authorize);
    const code = await done;
    const res = await request(`${apiUrl}/oauth/token`, {
      form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier },
    });
    if (res.status !== 200 || !res.data?.access_token) {
      throw new Error(t(`JarvisVoice 登入失敗（換 token HTTP ${res.status}：${res.data?.error_description || res.data?.error || ''}）`, `JarvisVoice sign-in failed (token HTTP ${res.status}: ${res.data?.error_description || res.data?.error || ''})`));
    }
    if (res.data.scope !== SCOPE) {
      // 發的不是語音輸入的 token（不該發生）：立刻撤銷，不存
      await request(`${apiUrl}/oauth/revoke`, { form: { token: res.data.refresh_token || res.data.access_token, client_id: clientId } }).catch(() => null);
      throw unsupported();
    }
    const tokens = tokensFrom(res.data, clientId);
    await store.write(tokens);
    // 順便問一次 /voice/check：拿帳號 email 給選單顯示；點數不足也算登入成功
    const check = await request(`${apiUrl}/voice/check`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } }).catch(() => null);
    const email = check?.headers.get('x-user-email') || '';
    writeAccount(stateDir, { apiUrl, email, at: new Date().toISOString() });
    return { email, quotaExceeded: check?.status === 403 && check.data?.error === 'quota_exceeded' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    server.close();
    server.closeAllConnections?.();
  }
}

// 登出：撤銷這條連線（帳號設定頁的那一列跟著消失），清掉 token 與帳號紀錄。撤銷失敗（沒網路）照樣清本機的。
export async function logout({ apiUrl, stateDir = STATE_DIR, store } = {}) {
  apiUrl = trimUrl(apiUrl);
  store ??= tokenStore(apiUrl, { stateDir });
  const tokens = await store.read();
  if (tokens?.refreshToken) {
    await request(`${apiUrl}/oauth/revoke`, { form: { token: tokens.refreshToken, client_id: tokens.clientId || '' } }).catch(() => null);
  }
  await store.clear();
  removeAccount(stateDir);
  sessions.delete(apiUrl);
}

// ── 登入後：token 自動更新、檢查點數、AI 整理、轉寫連線（常駐程式用）──

const sessions = new Map();

// 同一個伺服器共用一份（token 快取、換 token 不重複）
export function accountSession(apiUrl, options = {}) {
  apiUrl = trimUrl(apiUrl);
  if (!sessions.has(apiUrl)) sessions.set(apiUrl, createSession(apiUrl, options));
  return sessions.get(apiUrl);
}

export function createSession(apiUrl, { stateDir = STATE_DIR, store, now = Date.now } = {}) {
  apiUrl = trimUrl(apiUrl);
  store ??= tokenStore(apiUrl, { stateDir });
  let tokens = null;
  let refreshing = null;
  let checked = null; // { at, email }

  // token 不能用了（過期、撤銷）：清掉，讓選單變回「登入 JarvisVoice…」
  const forget = async () => {
    tokens = null;
    checked = null;
    await store.clear();
    removeAccount(stateDir);
  };

  const load = async () => {
    if (!tokens) tokens = await store.read();
    if (!tokens?.refreshToken) throw notLoggedIn();
    return tokens;
  };

  const refresh = async (stale) => {
    if (!refreshing) {
      refreshing = (async () => {
        const res = await request(`${apiUrl}/oauth/token`, {
          form: { grant_type: 'refresh_token', refresh_token: stale.refreshToken, client_id: stale.clientId || '' },
        });
        if (res.status === 400 && res.data?.error === 'invalid_grant') {
          // 寬限期內重送（另一個程序剛換過）：鑰匙圈裡已經是新的就用新的
          const latest = await store.read();
          if (latest?.refreshToken && latest.refreshToken !== stale.refreshToken) { tokens = latest; return latest; }
          await forget();
          throw loginExpired();
        }
        if (res.status !== 200 || !res.data?.access_token) throw new Error(t(`JarvisVoice 換 token 失敗（HTTP ${res.status}）`, `JarvisVoice token refresh failed (HTTP ${res.status})`));
        const next = tokensFrom(res.data, stale.clientId);
        await store.write(next); // 先存再用：換了沒存到，下次拿舊的去換會被當成重放
        tokens = next;
        return next;
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  };

  const accessToken = async ({ force = false } = {}) => {
    const current = await load();
    if (!force && current.accessToken && current.expiresAt - now() > REFRESH_EARLY_MS) return current.accessToken;
    return (await refresh(current)).accessToken;
  };

  // 以 access token 打一次，401／403 invalid_token 時換一次 token 再打
  const withToken = async (call) => {
    let res = await call(await accessToken());
    if (res.status === 401 || (res.status === 403 && ['invalid_token', 'token_expired', 'unauthorized'].includes(res.data?.error))) {
      res = await call(await accessToken({ force: true }));
      if (res.status === 401 || (res.status === 403 && ['invalid_token', 'token_expired', 'unauthorized'].includes(res.data?.error))) {
        await forget();
        throw loginExpired();
      }
    }
    // 403 quota_exceeded：語音檢查說點數用完或超過方案上限；402：ai_prompt 自己查到餘額不足
    if ((res.status === 403 && res.data?.error === 'quota_exceeded') || res.status === 402) { checked = null; throw quotaExceeded(); }
    return res;
  };

  // token 能不能用、點數夠不夠（60 秒內問過就不再問）
  const check = async ({ fresh = false } = {}) => {
    if (!fresh && checked && now() - checked.at < CHECK_CACHE_MS) return checked;
    const res = await withToken((token) => request(`${apiUrl}/voice/check`, { headers: { Authorization: `Bearer ${token}` } }));
    if (res.status !== 200) throw new Error(t(`JarvisVoice 伺服器暫時不能用（HTTP ${res.status}）`, `The JarvisVoice server is temporarily unavailable (HTTP ${res.status})`));
    checked = { at: now(), email: res.headers.get('x-user-email') || '' };
    return checked;
  };

  // AI 整理與第三層決策的 complete（同網頁版：模型 auto、關推理）。不雙發：每一份都扣點數
  const complete = async ({ system, user, signal, timeoutMs = 6000 }) => {
    const res = await withToken((token) => request(`${apiUrl}/voice/ai_prompt`, {
      headers: { Authorization: `Bearer ${token}` },
      json: { action: 'voice_polish', system_prompt: system, prompt: user, model: 'auto', temperature: 0.2, max_tokens: 2048, thinking: { type: 'disabled' } },
      signal,
      timeoutMs,
    }));
    if (res.status !== 200) {
      const detail = res.data?.message || res.data?.detail?.message || (typeof res.data?.detail === 'string' ? res.data.detail : '') || res.text.slice(0, 160);
      throw new Error(t(`JarvisVoice AI 整理失敗（HTTP ${res.status}）：${detail}`, `JarvisVoice AI cleanup failed (HTTP ${res.status}): ${detail}`));
    }
    return res.data?.content ?? '';
  };

  // 轉寫連線：先確認 token 與點數，再連 /ws/transcription（後端轉給 OpenAI、轉台灣正體字形，照分鐘扣點）。
  // turns=local：斷句在本機、每講完一句 commit（同網頁版與平行沙盒），後端用 gpt-transcribe；language 是 zh-Hant／en／ja，空的讓模型自己判斷。
  // token 放 Authorization header，不放網址（網址會進伺服器的 access log）
  const transcriptionTarget = async ({ language = '' } = {}) => {
    await check();
    const token = await accessToken();
    const query = new URLSearchParams({ turns: 'local', ...(language ? { language } : {}) });
    return { url: `${apiUrl.replace(/^http/, 'ws')}/ws/transcription?${query}`, headers: { Authorization: `Bearer ${token}` } };
  };

  // 帳號：剩幾點、每分鐘扣幾點、可以買的點數包（GET /voice/account）
  const account = async () => {
    const res = await withToken((token) => request(`${apiUrl}/voice/account`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }));
    if (res.status === 404) throw new AccountError('unsupported', t('這個伺服器還沒開放在 JarvisVoice 裡買點數', 'Buying credits in JarvisVoice is not available on this server yet'));
    if (res.status !== 200) throw new Error(t(`查不到點數（HTTP ${res.status}）`, `Couldn't get your credits (HTTP ${res.status})`));
    return res.data;
  };

  // 買點數：開 Stripe 付款頁（POST /voice/checkout），回付款頁網址；付完後端照包加點（跟網頁版買的同一種點數）
  const checkout = async (packageId) => {
    const res = await withToken((token) => request(`${apiUrl}/voice/checkout`, { headers: { Authorization: `Bearer ${token}` }, json: { package_id: packageId } }));
    if (res.status === 404) throw new AccountError('unsupported', t('這個伺服器還沒開放在 JarvisVoice 裡買點數', 'Buying credits in JarvisVoice is not available on this server yet'));
    if (res.status !== 200 || !res.data?.url) throw new Error(t(`付款頁開不起來（HTTP ${res.status}）`, `Couldn't open the payment page (HTTP ${res.status})`));
    return res.data.url;
  };

  return { apiUrl, check, complete, transcriptionTarget, accessToken, forget, store, account, checkout };
}
