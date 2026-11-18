// 在 JarvisVoice 裡買點數：node --test tests/credits.spec.mjs
// bin/credits.mjs 打本機假的後端（/voice/account、/voice/checkout）：帶 voice token、回點數包與付款頁網址、後端還沒開放時說清楚；
// 選單「購買點數」那一行：沒登入寫「不用 key」，有登入寫剩幾點、大約能講幾小時。

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const mac = process.platform === 'darwin';

// 假的後端：記下收到的請求；open 為 false 時兩個端點都回 404（還沒開放）
async function fakeServer({ open = true } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (!open) { res.statusCode = 404; res.end('{}'); return; }
      if (req.headers.authorization !== 'Bearer cvoice_at_test') { res.statusCode = 401; res.end('{"error":"invalid_token"}'); return; }
      if (req.method === 'GET' && req.url === '/voice/account') {
        res.end(JSON.stringify({ email: 'a@example.com', balance: 1234.5, credits_per_minute: 4.5,
          packages: [{ package_id: 'small', credits: 3500, price_usd: 6.99 }, { package_id: 'medium', credits: 8000, price_usd: 14.99 }] }));
      } else if (req.method === 'POST' && req.url === '/voice/checkout') {
        res.end(JSON.stringify({ url: `https://checkout.stripe.com/c/pay/${JSON.parse(body).package_id}`, session_id: 'cs_test' }));
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, apiUrl: `http://127.0.0.1:${server.address().port}` };
}

// 狀態資料夾：設定檔指到假的後端，token 放檔案（不碰鑰匙圈）
function stateFor(apiUrl) {
  const state = mkdtempSync(join(tmpdir(), 'jarvis-credits-'));
  writeFileSync(join(state, 'config.json'), JSON.stringify({ account: { apiUrl } }));
  const host = new URL(apiUrl).host.replace(/[^\w.-]/g, '_');
  writeFileSync(join(state, `account-token-${host}.json`), JSON.stringify({
    accessToken: 'cvoice_at_test', refreshToken: 'cvoice_rt_test', expiresAt: Date.now() + 3600_000, clientId: 'client',
  }));
  return state;
}

// 要用非同步的 execFile：同步的會卡住這個程式，假的後端就回不了
async function credits(state, ...args) {
  const env = { ...process.env, VOICE_DICTATION_STATE_DIR: state, VOICE_DICTATION_TOKEN_STORE: 'file', VOICE_DICTATION_LANG: 'zh-Hant' };
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [join(repo, 'bin/credits.mjs'), ...args], { env, encoding: 'utf8' });
    return JSON.parse(stdout.trim());
  } catch (err) {
    return JSON.parse(err.stdout.trim());
  }
}

test('查點數：帶 voice token 打 /voice/account，回剩幾點、每分鐘扣幾點、可以買的包', async () => {
  const { server, seen, apiUrl } = await fakeServer();
  try {
    const result = await credits(stateFor(apiUrl), 'account');
    assert.deepEqual(result, { type: 'credits', state: 'account', email: 'a@example.com', balance: 1234.5, creditsPerMinute: 4.5,
      packages: [{ id: 'small', credits: 3500, priceUsd: 6.99 }, { id: 'medium', credits: 8000, priceUsd: 14.99 }] });
    assert.equal(seen[0].auth, 'Bearer cvoice_at_test');
  } finally {
    server.close();
  }
});

test('買點數：POST /voice/checkout 帶包的 id，回付款頁網址（選單用瀏覽器打開）', async () => {
  const { server, seen, apiUrl } = await fakeServer();
  try {
    assert.deepEqual(await credits(stateFor(apiUrl), 'buy', 'medium'), { type: 'credits', state: 'checkout', url: 'https://checkout.stripe.com/c/pay/medium' });
    assert.deepEqual(JSON.parse(seen[0].body), { package_id: 'medium' });
  } finally {
    server.close();
  }
});

test('後端還沒開放：說清楚是還沒開放（unsupported），不是當機', async () => {
  const { server, apiUrl } = await fakeServer({ open: false });
  try {
    const result = await credits(stateFor(apiUrl), 'account');
    assert.equal(result.state, 'error');
    assert.equal(result.code, 'unsupported');
  } finally {
    server.close();
  }
});

test('還沒登入：回 not_logged_in，選單會先帶去登入', async () => {
  const { server, apiUrl } = await fakeServer();
  try {
    const state = mkdtempSync(join(tmpdir(), 'jarvis-credits-'));
    writeFileSync(join(state, 'config.json'), JSON.stringify({ account: { apiUrl } }));
    const result = await credits(state, 'account');
    assert.equal(result.code, 'not_logged_in');
  } finally {
    server.close();
  }
});

test('選單那一行：沒登入寫「不用 key」，有登入寫剩幾點、大約能講幾小時', { skip: !mac && '要 osascript' }, () => {
  const state = mkdtempSync(join(tmpdir(), 'jarvis-ui-credits-'));
  const harness = join(state, 'harness.js');
  writeFileSync(harness, `
    ObjC.import('Cocoa');
    function run() {
      globalThis.BUILD = { node: '/usr/bin/false', repo: ${JSON.stringify(repo)}, state: ${JSON.stringify(state)}, bundled: true };
      (0, eval)(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(BUILD.repo + '/app/ui.js', $.NSUTF8StringEncoding, null)));
      const seen = [creditsTitle()];
      onLine('{"type":"settings","account":{"loggedIn":true,"email":"a@example.com"}}');
      seen.push(creditsTitle());
      onCreditsLine('{"type":"credits","state":"account","balance":1234.5,"creditsPerMinute":4.5,"packages":[]}');
      seen.push(creditsTitle());
      onCreditsLine('{"type":"credits","state":"account","balance":16600,"creditsPerMinute":4.5,"packages":[]}');
      seen.push(creditsTitle());
      return JSON.stringify(seen);
    }
  `);
  const seen = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', harness], { encoding: 'utf8', env: { ...process.env, VOICE_DICTATION_LANG: 'zh-Hant' } }));
  assert.deepEqual(seen, ['購買點數（不用 key）…', '購買點數…', '購買點數…（剩 1,235 點，約 4.6 小時）', '購買點數…（剩 16,600 點，約 61 小時）']);
});
