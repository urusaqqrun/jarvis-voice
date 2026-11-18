// JarvisVoice 帳號登入：node --test tests/account.spec.mjs
// 假的 JarvisVoice 伺服器（OAuth、/voice/check、/voice/ai_prompt、/ws/transcription）在本機起，不碰真的伺服器、不扣任何點數。
// 也確認沒登入的人照舊：預設本機辨識、AI 整理只挑有 key 的那家。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const stateDir = mkdtempSync(join(tmpdir(), 'voice-dictation-backend-'));
process.env.VOICE_DICTATION_STATE_DIR = stateDir;
process.env.VOICE_DICTATION_TOKEN_STORE = 'file';
process.env.VOICE_DICTATION_LANG = 'zh';
delete process.env.OPENAI_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.VOICE_DICTATION_ACCOUNT_URL;
const configFile = join(stateDir, 'config.json');
const repo = fileURLToPath(new URL('..', import.meta.url));

const { loadConfig, aiAvailable, migrateConfig, signedInAccount, ACCOUNT_STATE } = await import('../bin/config.mjs');
const { login, logout, createSession, tokenStore, AccountError, readAccount } = await import('../bin/account.mjs');
const { useAccount, stopUsingAccount } = await import('../bin/login.mjs');
const { editSegment, service } = await import('../bin/editor.mjs');
const { createDecider, intentQuestion } = await import('../bin/decide.mjs');
const { createRealtimeEngine, accountConnector } = await import('../bin/engines/realtime.mjs');

// ── 假的 JarvisVoice 伺服器 ──
async function fakeBackend() {
  const state = {
    codes: new Map(), // code → { challenge, redirectUri, clientId }
    access: new Map(), // token → { expired }
    refresh: new Map(), // token → { used }
    legacy: false, // 舊版伺服器：不認得 voice scope
    broke: false, // 點數不足（語音檢查擋）
    aiStatus: 0, // 402：ai_prompt 自己擋
    calls: [],
    revoked: [],
    prompts: [],
    wsTokens: [],
    seq: 0,
  };
  const issue = () => {
    state.seq += 1;
    const access = `cvoice_at_${state.seq}`;
    const refresh = `cvoice_rt_${state.seq}`;
    state.access.set(access, { expired: false });
    state.refresh.set(refresh, { used: false });
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'voice' };
  };
  const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');
  const validAccess = (token) => state.access.has(token) && !state.access.get(token).expired;
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const u = new URL(req.url, 'http://x');
    state.calls.push({ method: req.method, path: u.pathname, auth: req.headers.authorization || '' });
    const form = req.headers['content-type']?.includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
    if (u.pathname === '/.well-known/oauth-authorization-server') return json(res, 200, { scopes_supported: state.legacy ? ['account'] : ['account', 'voice'] });
    if (u.pathname === '/oauth/register') return json(res, 201, { client_id: 'client-1', redirect_uris: form.redirect_uris });
    if (u.pathname === '/oauth/authorize') {
      // 使用者按允許：直接帶 code 導回（真的伺服器會先到網頁版同意頁）
      const q = u.searchParams;
      assert.equal(q.get('scope'), 'voice');
      assert.equal(q.get('code_challenge_method'), 'S256');
      const code = `code-${state.seq + 1}`;
      state.codes.set(code, { challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri'), clientId: q.get('client_id') });
      res.writeHead(302, { Location: `${q.get('redirect_uri')}?code=${code}&state=${q.get('state')}` });
      return res.end();
    }
    if (u.pathname === '/oauth/token') {
      if (form.grant_type === 'authorization_code') {
        const entry = state.codes.get(form.code);
        const ok = entry && entry.redirectUri === form.redirect_uri && entry.clientId === form.client_id
          && createHash('sha256').update(form.code_verifier).digest('base64url') === entry.challenge;
        if (!ok) return json(res, 400, { error: 'invalid_grant' });
        state.codes.delete(form.code);
        return json(res, 200, issue());
      }
      const entry = state.refresh.get(form.refresh_token);
      if (!entry || entry.used) return json(res, 400, { error: 'invalid_grant' });
      entry.used = true;
      return json(res, 200, issue());
    }
    if (u.pathname === '/oauth/revoke') { state.revoked.push(form.token); return json(res, 200, {}); }
    if (u.pathname === '/voice/check') {
      if (!validAccess(bearer(req))) return json(res, 401, { error: 'invalid_token' });
      if (state.broke) return json(res, 403, { error: 'quota_exceeded' });
      return json(res, 200, { success: true }, { 'X-User-ID': 'member-1', 'X-User-Email': 'voice@example.com' });
    }
    if (u.pathname === '/voice/ai_prompt') {
      // router 的 @auth_error 一律回 403＋error 代碼
      if (!validAccess(bearer(req))) return json(res, 403, { success: false, error: 'invalid_token' });
      if (state.broke) return json(res, 403, { success: false, error: 'quota_exceeded' });
      if (state.aiStatus === 402) return json(res, 402, { detail: { error: 'INSUFFICIENT_CREDITS', message: 'Insufficient credits. Current balance: -1.00', balance: -1 } });
      state.prompts.push(form);
      const content = /指令|台積電/.test(form.prompt) && /intent/.test(form.system_prompt + form.prompt)
        ? JSON.stringify({ answers: { intent: { choice: 'command', probabilities: { command: 0.95, dictation: 0.05 } } } })
        : JSON.stringify({ mode: 'insert', text: '明天四點開會，記得帶筆電。', goal: '', app: '', message: '' });
      return json(res, 200, { content, token_usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    }
    if (u.pathname === '/health') return json(res, 200, 'OK');
    json(res, 404, { error: 'not_found' });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/ws/transcription') { socket.destroy(); return; }
    state.wsTokens.push({ query: u.searchParams.get('token'), header: req.headers.authorization || '', turns: u.searchParams.get('turns') });
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => {
        const event = JSON.parse(String(data));
        if (event.type === 'input_audio_buffer.commit') {
          ws.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item_1' }));
          ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', transcript: '今天天氣很好' }));
        }
      });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, state, close: () => {
      for (const client of wss.clients) client.terminate();
      server.closeAllConnections?.();
      server.close();
    },
  };
}

// 假瀏覽器：打開授權網址、跟著 302 回到小程式的 127.0.0.1 回呼
const browser = async (url) => {
  const res = await fetch(url, { redirect: 'manual' });
  setTimeout(() => fetch(res.headers.get('location')).catch(() => {}), 10);
};

test('沒登入 JarvisVoice 帳號的人照舊：預設本機辨識，AI 整理只挑有 key 的那家，帳號不會被自動選上', () => {
  writeFileSync(configFile, '{}');
  let { config } = loadConfig();
  assert.equal(config.engine, 'local');
  assert.equal(config.account.apiUrl, 'https://app-api.jarvis-voice.com');
  assert.notEqual(config.ai.provider, 'account');
  assert.equal(aiAvailable(config, 'account'), false);
  // 就算登入了，沒指定 provider 時也只挑有 key 的
  writeFileSync(ACCOUNT_STATE, JSON.stringify({ apiUrl: 'https://app-api.jarvis-voice.com', email: 'x@example.com' }));
  writeFileSync(configFile, JSON.stringify({ ai: { keys: { claude: 'sk-ant-test' } } }));
  ({ config } = loadConfig());
  assert.equal(config.ai.provider, 'claude');
  assert.equal(aiAvailable(config, 'account'), true);
  // 登入的是別的伺服器（apiUrl 換了）不算
  writeFileSync(configFile, JSON.stringify({ account: { apiUrl: 'https://dev-api.astockteam.ai/' } }));
  ({ config } = loadConfig());
  assert.equal(config.account.apiUrl, 'https://dev-api.astockteam.ai');
  assert.equal(signedInAccount(config), null);
  writeFileSync(configFile, JSON.stringify({ engine: 'account', ai: { provider: 'account' } }));
  const loaded = loadConfig();
  assert.equal(loaded.error, '');
  assert.equal(loaded.config.engine, 'account');
  assert.equal(loaded.config.ai.provider, 'account');
});

test('1.1.0 以前的設定檔：讀進來就搬成新格式存回去；舊的登入紀錄與 token 刪掉（要重新登入）', () => {
  const oldAccount = join(stateDir, 'cubelv-account.json');
  const oldToken = join(stateDir, 'cubelv-token-app-api.cubelv.com.json');
  const before = existsSync(ACCOUNT_STATE) ? readFileSync(ACCOUNT_STATE, 'utf8') : null;
  if (before !== null) unlinkSync(ACCOUNT_STATE);
  writeFileSync(configFile, JSON.stringify({
    engine: 'cubelv',
    cubelv: { apiUrl: 'https://app-api.cubelv.com', previous: { engine: 'openai', ai: { provider: 'deepseek', enabled: false } } },
    ai: { enabled: true, provider: 'cubelv', keys: { deepseek: 'k' } },
  }));
  writeFileSync(oldAccount, JSON.stringify({ apiUrl: 'https://app-api.cubelv.com', email: 'x@example.com' }));
  writeFileSync(oldToken, '{}');
  const { config, error } = loadConfig();
  assert.equal(error, '');
  assert.equal(config.engine, 'account');
  assert.equal(config.ai.provider, 'account');
  assert.equal(config.account.apiUrl, 'https://app-api.jarvis-voice.com'); // 舊的預設網址不搬，用新的
  assert.equal('cubelv' in config, false);
  // 設定檔本身也改寫成新格式（previous 照留，登出時換得回來）
  assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), {
    engine: 'account',
    account: { previous: { engine: 'openai', ai: { provider: 'deepseek', enabled: false } } },
    ai: { enabled: true, provider: 'account', keys: { deepseek: 'k' } },
  });
  assert.equal(existsSync(oldAccount), false);
  assert.equal(existsSync(oldToken), false);
  assert.equal(signedInAccount(config), null); // 選單顯示「登入 JarvisVoice…」
  // 自己指定的網址照搬；已經是新格式的不動
  const custom = { cubelv: { apiUrl: 'https://dev-api.astockteam.ai' } };
  assert.equal(migrateConfig(custom), true);
  assert.deepEqual(custom, { account: { apiUrl: 'https://dev-api.astockteam.ai' } });
  const empty = { cubelv: { apiUrl: 'https://app-api.cubelv.com/' }, engine: 'local' };
  assert.equal(migrateConfig(empty), true);
  assert.deepEqual(empty, { engine: 'local' });
  const current = { engine: 'account', account: { apiUrl: 'https://x.example' }, ai: { provider: 'account' } };
  assert.equal(migrateConfig(current), false);
  assert.deepEqual(current, { engine: 'account', account: { apiUrl: 'https://x.example' }, ai: { provider: 'account' } });
  if (before !== null) writeFileSync(ACCOUNT_STATE, before);
});

test('登入切到 JarvisVoice 帳號、登出換回原本的設定；只切轉寫或只切 AI 整理', () => {
  const mine = { engine: 'openai', openai: { apiKeyFile: '~/.openai' }, ai: { enabled: false, provider: 'deepseek', keys: { deepseek: 'k' } } };
  const signedIn = useAccount(structuredClone(mine));
  assert.equal(signedIn.engine, 'account');
  assert.deepEqual({ enabled: signedIn.ai.enabled, provider: signedIn.ai.provider }, { enabled: true, provider: 'account' });
  assert.deepEqual(signedIn.account.previous, { engine: 'openai', ai: { provider: 'deepseek', enabled: false } });
  // 已經在用帳號又登入一次（token 失效後重新登入）：原本記的不會被蓋成 account
  assert.deepEqual(useAccount(structuredClone(signedIn)).account.previous, signedIn.account.previous);
  assert.deepEqual(stopUsingAccount(structuredClone(signedIn)), mine);
  // 原本什麼都沒寫：登出回到預設
  assert.deepEqual(stopUsingAccount(useAccount({})), {});
  // 只切轉寫：AI 整理不動，登出也不動
  const engineOnly = useAccount(structuredClone(mine), 'engine');
  assert.equal(engineOnly.engine, 'account');
  assert.equal(engineOnly.ai.provider, 'deepseek');
  assert.deepEqual(stopUsingAccount(engineOnly), mine);
  // 只切 AI 整理：轉寫不動
  const aiOnly = useAccount({ engine: 'local' }, 'ai');
  assert.equal(aiOnly.engine, 'local');
  assert.equal(aiOnly.ai.provider, 'account');
  assert.deepEqual(stopUsingAccount(aiOnly), { engine: 'local' });
  // 登入後自己從選單換回 OpenAI：登出不會把它改掉
  const switchedBack = { ...useAccount(structuredClone(mine)), engine: 'openai' };
  assert.equal(stopUsingAccount(switchedBack).engine, 'openai');
});

test('登入：PKCE＋127.0.0.1 回呼拿到 voice token，存進只有自己讀得到的檔案；登出撤銷並清掉', async () => {
  const backend = await fakeBackend();
  try {
    let waiting = '';
    const result = await login({ apiUrl: `${backend.url}/`, stateDir, openUrl: browser, onWaiting: (url) => { waiting = url; } });
    assert.deepEqual(result, { email: 'voice@example.com', quotaExceeded: false });
    assert.match(waiting, /scope=voice/);
    const store = tokenStore(backend.url, { stateDir });
    const tokens = await store.read();
    assert.match(tokens.accessToken, /^cvoice_at_/);
    assert.match(tokens.refreshToken, /^cvoice_rt_/);
    assert.equal(tokens.clientId, 'client-1');
    const file = join(stateDir, `account-token-127.0.0.1_${new URL(backend.url).port}.json`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual({ ...readAccount(stateDir), at: undefined }, { apiUrl: backend.url, email: 'voice@example.com', at: undefined });
    assert.ok(!readFileSync(configFile, 'utf8').includes('cvoice_')); // token 不寫進設定檔

    await logout({ apiUrl: backend.url, stateDir });
    assert.deepEqual(backend.state.revoked, [tokens.refreshToken]);
    assert.equal(await store.read(), null);
    assert.equal(readAccount(stateDir), null);
  } finally {
    backend.close();
  }
});

test('登入：還沒部署語音輸入的伺服器不開瀏覽器，直接說還沒開放', async () => {
  const backend = await fakeBackend();
  backend.state.legacy = true;
  let opened = false;
  try {
    await assert.rejects(login({ apiUrl: backend.url, stateDir, openUrl: async () => { opened = true; } }),
      (err) => err.code === 'unsupported' && /還沒開放/.test(err.message));
    assert.equal(opened, false);
    assert.ok(!backend.state.calls.some((c) => c.path === '/oauth/register'));
  } finally {
    backend.close();
  }
});

test('登入：按拒絕就不登入，也不留任何東西', async () => {
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/.well-known/oauth-authorization-server') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"scopes_supported":["account","voice"]}'); return; }
    if (u.pathname === '/oauth/register') { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{"client_id":"c"}'); return; }
    res.writeHead(302, { Location: `${u.searchParams.get('redirect_uri')}?error=access_denied&state=${u.searchParams.get('state')}` });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(login({ apiUrl, stateDir, openUrl: browser }), (err) => err instanceof AccountError && err.code === 'denied');
    assert.equal(await tokenStore(apiUrl, { stateDir }).read(), null);
    assert.equal(readAccount(stateDir), null);
  } finally {
    server.close();
  }
});

test('token 快到期先換、換到的先存再用；refresh 失效就登出並說要重新登入', async () => {
  const backend = await fakeBackend();
  try {
    await login({ apiUrl: backend.url, stateDir, openUrl: browser });
    const store = tokenStore(backend.url, { stateDir });
    const first = await store.read();
    await store.write({ ...first, expiresAt: Date.now() + 60_000 }); // 剩 1 分鐘
    const session = createSession(backend.url, { stateDir });
    const fresh = await session.accessToken();
    assert.notEqual(fresh, first.accessToken);
    assert.equal((await store.read()).accessToken, fresh);
    assert.equal(backend.state.refresh.get(first.refreshToken).used, true);

    // 後端說 access token 不能用（例如被撤銷後又發新的）：換一次再打
    backend.state.access.get(fresh).expired = true;
    assert.equal((await session.check()).email, 'voice@example.com');

    // refresh token 也不能用了：清掉、說要重新登入
    const current = await store.read();
    backend.state.refresh.get(current.refreshToken).used = true;
    backend.state.access.get(current.accessToken).expired = true;
    await assert.rejects(session.check({ fresh: true }), (err) => err.code === 'login_expired' && /重新/.test(err.message));
    assert.equal(await store.read(), null);
    assert.equal(readAccount(stateDir), null);
    await assert.rejects(session.complete({ system: 's', user: 'u' }), (err) => err.code === 'not_logged_in');
  } finally {
    backend.close();
  }
});

test('AI 整理與第三層決策走 /voice/ai_prompt（模型 auto、關推理、不雙發）；點數不足清楚說', async () => {
  const backend = await fakeBackend();
  try {
    await login({ apiUrl: backend.url, stateDir, openUrl: browser });
    const r = await editSegment({
      provider: 'account', accountUrl: backend.url, hedge: 2, timeoutMs: 5000,
      transcript: '嗯那個我們明天三點開會，不對，四點開會，然後記得帶那個筆電', context: { app: 'Slack' },
    });
    assert.equal(r.text, '明天四點開會，記得帶筆電。');
    assert.equal(r.model, 'JarvisVoice');
    assert.equal(backend.state.prompts.length, 1); // hedge 2 也只送一份：每份都扣點數
    const sent = backend.state.prompts[0];
    assert.equal(sent.action, 'voice_polish');
    assert.equal(sent.model, 'auto');
    assert.deepEqual(sent.thinking, { type: 'disabled' });
    assert.ok(sent.system_prompt && sent.prompt.includes('四點'));
    const aiCall = backend.state.calls.find((c) => c.path === '/voice/ai_prompt');
    assert.match(aiCall.auth, /^Bearer cvoice_at_/);

    const decider = createDecider(() => ({ jevKey: '', ai: { provider: 'account', accountUrl: backend.url, apiKey: '' } }));
    assert.equal(decider.available(), true);
    await decider.decide({ transcript: '進到台積電的個股頁', app: '看盤', window: '自選股', field: '' }, { intent: intentQuestion() });
    assert.equal(backend.state.prompts.length, 2);

    // ai_prompt 自己查到餘額不足回 402（detail 是物件）：一樣說點數用完
    backend.state.aiStatus = 402;
    await assert.rejects(service({ provider: 'account', accountUrl: backend.url }).complete({ system: 's', user: 'u' }),
      (err) => err.code === 'quota_exceeded' && /點數用完/.test(err.message));
    backend.state.aiStatus = 0;
    backend.state.broke = true;
    await assert.rejects(service({ provider: 'account', accountUrl: backend.url }).complete({ system: 's', user: 'u' }),
      (err) => err.code === 'quota_exceeded' && /點數用完/.test(err.message));
  } finally {
    await logout({ apiUrl: backend.url, stateDir });
    backend.close();
  }
});

test('轉寫：先確認登入與點數，再連 /ws/transcription（token 放 header）；沒登入、點數不足直接說明', async () => {
  const backend = await fakeBackend();
  const run = async () => {
    const finals = [];
    const errors = [];
    const engine = createRealtimeEngine({
      connector: accountConnector({ apiUrl: backend.url }),
      onFinal: (text) => finals.push(text),
      onError: (message) => errors.push(message),
      log: () => {},
    });
    engine.append(Buffer.alloc(4800));
    engine.commit();
    for (let i = 0; i < 60 && !finals.length && !errors.length; i += 1) {
      engine.flush();
      await new Promise((r) => setTimeout(r, 30));
    }
    engine.close();
    return { finals, errors };
  };
  try {
    let { errors } = await run();
    assert.match(errors[0], /還沒登入 JarvisVoice/);

    await login({ apiUrl: backend.url, stateDir, openUrl: browser });
    const ok = await run();
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.finals, ['今天天氣很好']);
    assert.match(backend.state.wsTokens.at(-1).header, /^Bearer cvoice_at_/);
    assert.equal(backend.state.wsTokens.at(-1).query, null); // token 不放網址（會進 access log）
    assert.equal(backend.state.wsTokens.at(-1).turns, 'local'); // 本機斷句，後端用 gpt-transcribe
    assert.ok(backend.state.calls.some((c) => c.path === '/voice/check'));

    backend.state.broke = true;
    const { accountSession } = await import('../bin/account.mjs');
    await assert.rejects(accountSession(backend.url).check({ fresh: true }), (err) => err.code === 'quota_exceeded');
    ({ errors } = await run());
    assert.match(errors[0], /點數用完/);
  } finally {
    await logout({ apiUrl: backend.url, stateDir });
    backend.close();
  }
});

test('macOS 鑰匙圈：用 security 存取，token 不落在狀態資料夾', async () => {
  const fakeBin = mkdtempSync(join(tmpdir(), 'fake-security-'));
  const vault = join(fakeBin, 'vault');
  const log = join(fakeBin, 'calls');
  const security = join(fakeBin, 'security');
  // 假的 /usr/bin/security：記下參數，-w 的值存進檔案
  writeFileSync(security, `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  add-generic-password) while [ $# -gt 0 ]; do if [ "$1" = "-w" ]; then printf '%s' "$2" > "${vault}"; fi; shift; done ;;
  find-generic-password) [ -f "${vault}" ] && cat "${vault}" && echo || exit 44 ;;
  delete-generic-password) rm -f "${vault}" ;;
esac
`);
  chmodSync(security, 0o755);
  process.env.VOICE_DICTATION_SECURITY_BIN = security;
  try {
    const store = tokenStore('https://app-api.jarvis-voice.com', { stateDir, kind: 'keychain' });
    assert.equal(await store.read(), null);
    await store.write({ accessToken: 'cvoice_at_k', refreshToken: 'cvoice_rt_k', expiresAt: 1, clientId: 'c' });
    assert.equal((await store.read()).refreshToken, 'cvoice_rt_k');
    await store.clear();
    assert.equal(await store.read(), null);
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /add-generic-password -U -s JarvisVoice -a app-api.jarvis-voice.com/);
    assert.match(calls, /find-generic-password -s JarvisVoice -a app-api.jarvis-voice.com -w/);
    assert.ok(!existsSync(join(stateDir, 'account-token-app-api.jarvis-voice.com.json')));
  } finally {
    delete process.env.VOICE_DICTATION_SECURITY_BIN;
  }
});

test('選單帶起的登入程式：印出網址給瀏覽器，登入後切到 JarvisVoice 帳號；登出換回原本的', async () => {
  const backend = await fakeBackend();
  const env = { ...process.env, VOICE_DICTATION_OPEN_URL: 'print', VOICE_DICTATION_ACCOUNT_URL: backend.url, VOICE_DICTATION_LANG: 'zh' };
  const runCli = (args, onLine = () => {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repo, 'bin/login.mjs'), ...args], { env });
    const events = [];
    createInterface({ input: child.stdout }).on('line', (line) => { const e = JSON.parse(line); events.push(e); onLine(e); });
    child.on('close', (code) => resolve({ code, events }));
  });
  try {
    writeFileSync(configFile, JSON.stringify({ engine: 'openai', ai: { provider: 'deepseek' } }));
    const signIn = await runCli([], (e) => { if (e.state === 'open') browser(e.url); });
    assert.equal(signIn.code, 0);
    assert.deepEqual(signIn.events.map((e) => e.state), ['open', 'waiting', 'done']);
    assert.equal(signIn.events.at(-1).email, 'voice@example.com');
    let saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(saved.engine, 'account');
    assert.equal(saved.ai.provider, 'account');
    assert.equal(loadConfig().config.engine, 'account');
    assert.ok(aiAvailable({ ...loadConfig().config, account: { apiUrl: backend.url } }, 'account'));

    const signOut = await runCli(['logout']);
    assert.equal(signOut.code, 0);
    assert.equal(signOut.events.at(-1).state, 'logged_out');
    saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.deepEqual(saved, { engine: 'openai', ai: { provider: 'deepseek' } });
    assert.equal(backend.state.revoked.length, 1);
  } finally {
    backend.close();
  }
});
