// 選單「設定自己的 key…」：node --test tests/own-keys.spec.mjs
// key 存哪（鑰匙圈用假的 security 指令驗參數、其他系統用 0600 檔案）、讀取順序（選單存的最優先，清除後回到設定檔與環境變數）、
// 先測再存（假的 OpenAI／DeepSeek／Claude／Jev 在本機起，不打真的雲端）、存完切過去，以及選單每個項目都接得到 selector。

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const stateDir = mkdtempSync(join(tmpdir(), 'voice-dictation-keys-'));
process.env.VOICE_DICTATION_STATE_DIR = stateDir;
process.env.VOICE_DICTATION_TOKEN_STORE = 'file';
process.env.VOICE_DICTATION_LANG = 'zh';
for (const name of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY', 'VOICE_DICTATION_SECURITY_BIN']) delete process.env[name];
const configFile = join(stateDir, 'config.json');
const repo = fileURLToPath(new URL('..', import.meta.url));

const { loadConfig, aiKey, configMtime } = await import('../bin/config.mjs');
const { ownKeyStore, cleanKey, OWN_KEYS_FILE } = await import('../bin/own-keys.mjs');
const { useOwnKey, afterClear, failureReason } = await import('../bin/set-key.mjs');

// 假的雲端：good- 開頭的 key 回正常結果，poor- 開頭回 402（餘額不足），其他回 401。記下每次打的網址與 key
async function fakeCloud() {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const key = (req.headers.authorization || '').replace(/^Bearer /, '') || req.headers['x-api-key'] || '';
    calls.push({ url: req.url, key, body });
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (key.startsWith('poor-')) return reply(402, { error: { message: 'Insufficient Balance' } });
    if (!key.startsWith('good-')) return reply(401, { error: { message: 'Incorrect API key provided' } });
    const cleaned = JSON.stringify({ mode: 'insert', text: '我們明天四點開會，記得帶筆電。', goal: '', app: '' });
    if (req.url.startsWith('/claude')) return reply(200, { content: [{ type: 'text', text: cleaned }] });
    if (req.url.startsWith('/jev')) return reply(200, { answers: { intent: { choice: 'command', confidence: 0.93 } } });
    return reply(200, { choices: [{ message: { content: cleaned } }] });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, calls,
    env: {
      VOICE_DICTATION_OPENAI_CHAT_URL: `${url}/openai`, VOICE_DICTATION_DEEPSEEK_URL: `${url}/deepseek`,
      VOICE_DICTATION_ANTHROPIC_URL: `${url}/claude`, VOICE_DICTATION_JEV_URL: `${url}/jev`,
    },
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

// 選單帶起的 bin/set-key.mjs：key 從 stdin 送進去（跟選單一樣），stdout 一行一個 JSON
function runKey(args, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repo, 'bin/set-key.mjs'), ...args], { env: { ...process.env, ...env } });
    const events = [];
    createInterface({ input: child.stdout }).on('line', (line) => events.push(JSON.parse(line)));
    child.stdin.end(input);
    child.on('close', (code) => resolve({ code, events, last: events.at(-1) ?? {} }));
  });
}

const readConfig = () => JSON.parse(readFileSync(configFile, 'utf8'));

// 假的 /usr/bin/security：記下參數；add 把 -w 的值存成 vault/<帳號>，find 印出來（沒有就 exit 44），delete 刪掉
function fakeSecurity() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-security-'));
  const vault = join(dir, 'vault');
  mkdirSync(vault);
  const log = join(dir, 'calls');
  const bin = join(dir, 'security');
  writeFileSync(bin, `#!/bin/sh
echo "$@" >> "${log}"
cmd="$1"; shift
account=""; secret=""
while [ $# -gt 0 ]; do
  case "$1" in
    -a) account="$2"; shift ;;
    -w) if [ $# -gt 1 ]; then secret="$2"; shift; fi ;;
  esac
  shift
done
case "$cmd" in
  add-generic-password) printf '%s' "$secret" > "${vault}/$account" ;;
  find-generic-password) [ -f "${vault}/$account" ] && cat "${vault}/$account" && echo || exit 44 ;;
  delete-generic-password) [ -f "${vault}/$account" ] && rm -f "${vault}/$account" || exit 44 ;;
esac
`);
  chmodSync(bin, 0o755);
  return { bin, vault, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

// 資料夾裡所有檔案的內容接起來（確認 key 沒落在這裡）
const allText = (dir) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(dir, e.name), 'utf8')).join('\n');

test('貼上的字整理成 key：去掉空白、引號、.env 的變數名；沒貼或中間有空白不收', () => {
  assert.equal(cleanKey('  sk-abc123\n'), 'sk-abc123');
  assert.equal(cleanKey('OPENAI_API_KEY="sk-abc"'), 'sk-abc');
  assert.equal(cleanKey("export DEEPSEEK_API_KEY='sk-d'\n"), 'sk-d');
  assert.throws(() => cleanKey('   '), /沒有貼上 key/);
  assert.throws(() => cleanKey('sk-a sk-b'), /不像一把 key/);
});

test('其他系統（檔案模式）：key 存在只有自己讀得到的檔案，索引只記哪幾家、不含 key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-dictation-keys-file-'));
  const store = ownKeyStore(dir, { kind: 'file' });
  assert.equal(store.kind, 'file');
  assert.deepEqual(store.saved(), []);
  store.write('deepseek', 'sk-ds-secret');
  store.write('jev', 'ts-secret');
  assert.deepEqual(store.saved(), ['deepseek', 'jev']);
  assert.equal(store.read('deepseek'), 'sk-ds-secret');
  assert.deepEqual(store.readAll(), { deepseek: 'sk-ds-secret', jev: 'ts-secret' });
  assert.doesNotMatch(readFileSync(join(dir, OWN_KEYS_FILE), 'utf8'), /secret/);
  for (const name of readdirSync(dir).filter((n) => n !== OWN_KEYS_FILE)) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
  store.clear('deepseek');
  assert.equal(store.read('deepseek'), '');
  assert.deepEqual(store.saved(), ['jev']);
  store.clear('jev');
  assert.deepEqual(readdirSync(dir), [OWN_KEYS_FILE]); // 都清掉了，放 key 的檔案也刪掉
  assert.throws(() => store.write('gemini', 'x'), /只能設定/);
});

test('macOS 鑰匙圈：用 security 存取（假的指令驗參數），key 不落在狀態資料夾；沒存過就不去叫 security', async () => {
  const security = fakeSecurity();
  process.env.VOICE_DICTATION_SECURITY_BIN = security.bin;
  const dir = mkdtempSync(join(tmpdir(), 'voice-dictation-keys-kc-'));
  try {
    const store = ownKeyStore(dir, { kind: 'keychain' });
    assert.deepEqual(store.readAll(), {});
    assert.equal(security.calls(), '', '沒存過 key 的人讀設定時不該碰鑰匙圈');
    store.write('deepseek', 'sk-ds-kc');
    store.write('openai', 'sk-oa-kc');
    assert.deepEqual(store.readAll(), { openai: 'sk-oa-kc', deepseek: 'sk-ds-kc' });
    store.clear('deepseek');
    assert.equal(store.read('deepseek'), '');
    const calls = security.calls();
    assert.match(calls, /^add-generic-password -U -s JarvisVoice key -a deepseek -l JarvisVoice DeepSeek key -w sk-ds-kc$/m);
    assert.match(calls, /^add-generic-password -U -s JarvisVoice key -a openai -l JarvisVoice OpenAI key -w sk-oa-kc$/m);
    assert.match(calls, /^find-generic-password -s JarvisVoice key -a deepseek -w$/m);
    assert.match(calls, /^delete-generic-password -s JarvisVoice key -a deepseek$/m);
    assert.doesNotMatch(allText(dir), /sk-ds-kc|sk-oa-kc/);
    // 鑰匙圈裡被手動刪掉的：當成沒存
    unlinkSync(join(security.vault, 'openai'));
    assert.deepEqual(store.readAll(), {});

    // 選單帶起的程式在 macOS 也走鑰匙圈：key 經過 -w 存進去，狀態資料夾、設定檔都沒有
    const cloud = await fakeCloud();
    try {
      const appDir = mkdtempSync(join(tmpdir(), 'voice-dictation-keys-app-'));
      const r = await runKey(['set', 'claude'], 'good-claude-kc', { ...cloud.env, VOICE_DICTATION_STATE_DIR: appDir, VOICE_DICTATION_TOKEN_STORE: 'keychain' });
      assert.equal(r.code, 0, JSON.stringify(r.events));
      assert.equal(r.last.state, 'saved');
      assert.match(security.calls(), /add-generic-password -U -s JarvisVoice key -a claude -l JarvisVoice Claude key -w good-claude-kc/);
      assert.equal(readFileSync(join(security.vault, 'claude'), 'utf8'), 'good-claude-kc');
      assert.doesNotMatch(allText(appDir), /good-claude-kc/);
    } finally {
      cloud.close();
    }
  } finally {
    delete process.env.VOICE_DICTATION_SECURITY_BIN;
  }
});

test('讀取順序：選單存的最優先；清除後回到設定檔、keyFiles、keyCommands、環境變數；沒存過完全照舊', () => {
  writeFileSync(join(stateDir, 'ds.env'), 'DEEPSEEK_API_KEY=sk-ds-file\n');
  writeFileSync(configFile, JSON.stringify({
    openai: { apiKey: 'sk-oa-config' },
    ai: { keys: { claude: 'sk-claude-config' }, keyFiles: { deepseek: join(stateDir, 'ds.env') } },
    jev: { apiKeyCommand: 'printf ts-cmd' },
  }));
  let { config, error } = loadConfig();
  assert.equal(error, '');
  assert.deepEqual(config.ownKeys, {});
  assert.deepEqual([config.openai.apiKey, aiKey(config, 'openai'), aiKey(config, 'deepseek'), aiKey(config, 'claude'), config.jev.apiKey],
    ['sk-oa-config', 'sk-oa-config', 'sk-ds-file', 'sk-claude-config', 'ts-cmd']);
  const stamp = configMtime(config);

  const store = ownKeyStore(stateDir);
  for (const [provider, key] of Object.entries({ openai: 'sk-oa-menu', deepseek: 'sk-ds-menu', claude: 'sk-claude-menu', jev: 'ts-menu' })) store.write(provider, key);
  assert.notEqual(configMtime(config), stamp, '存了 key，常駐程式要重讀設定');
  ({ config } = loadConfig());
  assert.deepEqual([config.openai.apiKey, aiKey(config, 'openai'), aiKey(config, 'deepseek'), aiKey(config, 'claude'), config.jev.apiKey],
    ['sk-oa-menu', 'sk-oa-menu', 'sk-ds-menu', 'sk-claude-menu', 'ts-menu']);

  for (const provider of ['openai', 'deepseek', 'claude', 'jev']) store.clear(provider);
  ({ config } = loadConfig());
  assert.deepEqual([config.openai.apiKey, aiKey(config, 'deepseek'), aiKey(config, 'claude'), config.jev.apiKey],
    ['sk-oa-config', 'sk-ds-file', 'sk-claude-config', 'ts-cmd']);

  // 只靠環境變數的人：選單存了也是選單的優先，清掉就回到環境變數
  writeFileSync(configFile, '{}');
  process.env.DEEPSEEK_API_KEY = 'sk-ds-env';
  try {
    assert.equal(aiKey(loadConfig().config, 'deepseek'), 'sk-ds-env');
    assert.equal(loadConfig().config.ai.provider, 'deepseek'); // 沒指定 AI 用哪家：挑有 key 的
    store.write('deepseek', 'sk-ds-menu');
    assert.equal(aiKey(loadConfig().config, 'deepseek'), 'sk-ds-menu');
    store.clear('deepseek');
    assert.equal(aiKey(loadConfig().config, 'deepseek'), 'sk-ds-env');
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
  }
  // 選單只存了 Claude：沒指定 AI 用哪家時就用 Claude
  store.write('claude', 'sk-claude-menu');
  assert.equal(loadConfig().config.ai.provider, 'claude');
  store.clear('claude');
});

test('存完切過去：DeepSeek、Claude 切 AI 整理；OpenAI 不動本機辨識、AI 整理能用就不搶；清除後沒 key 的 OpenAI 轉寫換回本機', () => {
  assert.deepEqual(useOwnKey({}, 'deepseek'), { ai: { enabled: true, provider: 'deepseek' } });
  assert.deepEqual(useOwnKey({ ai: { enabled: false, styles: { a: 'b' } } }, 'claude'), { ai: { enabled: true, provider: 'claude', styles: { a: 'b' } } });
  assert.deepEqual(useOwnKey({ engine: 'local', ai: { provider: 'deepseek' } }, 'openai', { aiWorks: true }), { engine: 'local', ai: { provider: 'deepseek' } });
  assert.deepEqual(useOwnKey({}, 'openai', { aiWorks: false }), { ai: { enabled: true, provider: 'openai' } });
  assert.deepEqual(useOwnKey({ ai: { enabled: false } }, 'openai', { aiWorks: false }), { ai: { enabled: false } }); // 自己關掉的不幫他打開
  assert.deepEqual(useOwnKey({ ai: { provider: 'deepseek' } }, 'openai', { ai: true }), { ai: { enabled: true, provider: 'openai' } });
  assert.deepEqual(useOwnKey({ engine: 'account' }, 'openai', { engine: true, aiWorks: true }), { engine: 'openai' });
  assert.deepEqual(useOwnKey({ engine: 'local' }, 'jev', { engine: true, ai: true }), { engine: 'local' });
  assert.deepEqual(afterClear({ engine: 'openai' }, 'openai', { stillHasKey: false }), { engine: 'local' });
  assert.deepEqual(afterClear({ engine: 'openai' }, 'openai', { stillHasKey: true }), { engine: 'openai' });
  assert.deepEqual(afterClear({ engine: 'openai', ai: { provider: 'deepseek' } }, 'deepseek', { stillHasKey: false }), { engine: 'openai', ai: { provider: 'deepseek' } });
});

test('測試沒通過的原因講成看得懂的話', () => {
  assert.match(failureReason(new Error('DeepSeek AI 編輯失敗（HTTP 401）：bad'), 'deepseek'), /DeepSeek 說這把 key 不對或沒有權限（HTTP 401）/);
  assert.match(failureReason(new Error('Jev 決策失敗（HTTP 403）：x'), 'jev'), /TypeSafe Jev 說這把 key 不對/);
  assert.match(failureReason(new Error('OpenAI AI 編輯失敗（HTTP 429）：quota'), 'openai'), /超過用量或額度/);
  assert.match(failureReason(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 'claude'), /Claude 太久沒回應/);
  assert.match(failureReason(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), 'claude'), /連不到 Claude/);
  assert.match(failureReason(new Error('AI 整理回的格式不對：x'), 'openai'), /測試沒通過：AI 整理回的格式不對/);
});

test('選單帶起的程式：先實際打一次，通了才存並切過去；key 不對、餘額不足、連不到就說原因、不存', async () => {
  const cloud = await fakeCloud();
  const store = ownKeyStore(stateDir);
  try {
    // DeepSeek：通了，存進去、AI 整理切過去（原本關著也打開），轉寫不動
    writeFileSync(configFile, JSON.stringify({ engine: 'local', ai: { enabled: false } }));
    let r = await runKey(['set', 'deepseek'], '  DEEPSEEK_API_KEY=good-ds\n', cloud.env);
    assert.equal(r.code, 0, JSON.stringify(r.events));
    assert.deepEqual(r.events.map((e) => e.state), ['testing', 'saved']);
    assert.match(r.last.message, /^AI 整理用 DeepSeek。key 存在 macOS 鑰匙圈/);
    assert.doesNotMatch(JSON.stringify(r.events), /good-ds/, 'key 不印出來');
    assert.deepEqual(readConfig(), { engine: 'local', ai: { enabled: true, provider: 'deepseek' } });
    assert.doesNotMatch(readFileSync(configFile, 'utf8'), /good-ds/, 'key 不寫進設定檔');
    assert.equal(store.read('deepseek'), 'good-ds');
    assert.equal(cloud.calls.at(-1).url, '/deepseek');
    assert.equal(cloud.calls.at(-1).key, 'good-ds');
    assert.equal(aiKey(loadConfig().config), 'good-ds');

    // Claude：key 不對（401）→ 說原因、不存、設定檔不動
    const before = readFileSync(configFile, 'utf8');
    r = await runKey(['set', 'claude'], 'sk-ant-wrong', cloud.env);
    assert.equal(r.code, 1);
    assert.deepEqual(r.events.map((e) => e.state), ['testing', 'error']);
    assert.match(r.last.message, /Claude 說這把 key 不對或沒有權限（HTTP 401）/);
    assert.equal(cloud.calls.at(-1).key, 'sk-ant-wrong');
    assert.equal(store.read('claude'), '');
    assert.equal(readFileSync(configFile, 'utf8'), before);
    // 餘額不足（402）、連不到、沒貼 key
    r = await runKey(['set', 'deepseek'], 'poor-ds', cloud.env);
    assert.match(r.last.message, /DeepSeek 的帳戶餘額不足/);
    assert.equal(store.read('deepseek'), 'good-ds', '測不過的不會蓋掉原本存的');
    r = await runKey(['set', 'claude'], 'good-claude', { ...cloud.env, VOICE_DICTATION_ANTHROPIC_URL: 'http://127.0.0.1:1/claude' });
    assert.match(r.last.message, /連不到 Claude/);
    r = await runKey(['set', 'claude'], '\n', cloud.env);
    assert.equal(r.code, 1);
    assert.match(r.last.message, /沒有貼上 key/);
    assert.equal(store.read('claude'), '');

    // OpenAI：沒勾「轉寫也改用 OpenAI」就不動本機辨識；AI 整理已經有能用的 DeepSeek，不搶
    r = await runKey(['set', 'openai'], 'good-oa', cloud.env);
    assert.equal(r.code, 0, JSON.stringify(r.events));
    assert.match(r.last.message, /轉寫維持本機辨識（要換從選單「轉寫」選 OpenAI）；AI 整理維持 DeepSeek/);
    assert.deepEqual(readConfig(), { engine: 'local', ai: { enabled: true, provider: 'deepseek' } });
    assert.equal(cloud.calls.at(-1).url, '/openai');
    assert.equal(loadConfig().config.openai.apiKey, 'good-oa'); // 轉寫拿得到
    // 勾了：轉寫切到 OpenAI
    r = await runKey(['set', 'openai', '--engine'], 'good-oa', cloud.env);
    assert.match(r.last.message, /^轉寫用 OpenAI；AI 整理維持 DeepSeek/);
    assert.equal(readConfig().engine, 'openai');
    // AI 整理現在用的那家沒有 key：OpenAI 接手
    writeFileSync(configFile, JSON.stringify({ ai: { provider: 'claude' } }));
    r = await runKey(['set', 'openai'], 'good-oa', cloud.env);
    assert.deepEqual(readConfig(), { ai: { provider: 'openai', enabled: true } });
    assert.match(r.last.message, /AI 整理用 OpenAI/);
    // 從「AI 整理」子選單選 OpenAI 進來的（--ai）：一定切
    writeFileSync(configFile, JSON.stringify({ ai: { provider: 'deepseek' } }));
    await runKey(['set', 'openai', '--ai'], 'good-oa', cloud.env);
    assert.equal(readConfig().ai.provider, 'openai');

    // Jev：跑一題第三層決策，通了就存，設定檔不用改
    writeFileSync(configFile, JSON.stringify({ engine: 'local' }));
    r = await runKey(['set', 'jev'], 'good-jev', cloud.env);
    assert.equal(r.code, 0, JSON.stringify(r.events));
    assert.equal(cloud.calls.at(-1).url, '/jev');
    assert.equal(cloud.calls.at(-1).key, 'good-jev');
    assert.match(r.last.message, /自動找輸入框與語音指令改由 Jev 判斷/);
    assert.deepEqual(readConfig(), { engine: 'local' });
    assert.equal(loadConfig().config.jev.apiKey, 'good-jev');
    r = await runKey(['set', 'jev'], 'bad-jev', cloud.env);
    assert.match(r.last.message, /TypeSafe Jev 說這把 key 不對/);
    assert.equal(store.read('jev'), 'good-jev');

    // 清除：OpenAI 轉寫沒有別的 key 了就換回本機辨識；設定檔還有一把的就改用那把
    writeFileSync(configFile, JSON.stringify({ engine: 'openai', ai: { provider: 'deepseek' } }));
    r = await runKey(['clear', 'openai'], '', cloud.env);
    assert.equal(r.last.state, 'cleared');
    assert.match(r.last.message, /已清除 OpenAI 的 key：轉寫換回本機辨識/);
    assert.deepEqual(readConfig(), { engine: 'local', ai: { provider: 'deepseek' } });
    assert.equal(store.read('openai'), '');
    writeFileSync(configFile, JSON.stringify({ ai: { provider: 'deepseek', keys: { deepseek: 'sk-ds-config' } } }));
    r = await runKey(['clear', 'deepseek'], '', cloud.env);
    assert.match(r.last.message, /已清除 DeepSeek 的 key：設定檔或環境變數裡還有一把，會改用那把/);
    assert.equal(aiKey(loadConfig().config), 'sk-ds-config');
    r = await runKey(['clear', 'gemini'], '', cloud.env);
    assert.equal(r.code, 1);
    assert.match(r.last.message, /用法/);
  } finally {
    for (const provider of ['openai', 'deepseek', 'claude', 'jev']) store.clear(provider);
    cloud.close();
  }
});

test('設定檔壞掉：key 照樣測、照樣存，只是不切換，也不蓋掉設定檔', async () => {
  const cloud = await fakeCloud();
  try {
    writeFileSync(configFile, '{ 壞掉');
    const r = await runKey(['set', 'deepseek'], 'good-ds2', cloud.env);
    assert.equal(r.code, 0, JSON.stringify(r.events));
    assert.match(r.last.message, /設定檔讀不懂，沒有幫你切換/);
    assert.equal(readFileSync(configFile, 'utf8'), '{ 壞掉');
    assert.equal(ownKeyStore(stateDir).read('deepseek'), 'good-ds2');
  } finally {
    ownKeyStore(stateDir).clear('deepseek');
    cloud.close();
  }
});

test('選單（app/ui.js）：語法沒問題；每個選單項目、通知、計時器用到的 selector 都有登記；「設定自己的 key…」排在「登入 JarvisVoice…」前面', () => {
  const file = join(repo, 'app/ui.js');
  execFileSync(process.execPath, ['--check', file]);
  const ui = readFileSync(file, 'utf8');
  const registered = new Set([...ui.matchAll(/^\s*'([A-Za-z]+:)': \{\s*types:/gm)].map((m) => m[1]));
  const keysOf = (name) => [...(ui.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n?\\};`))?.[1] ?? '').matchAll(/^\s*(\w+):|[{,]\s*(\w+):/gm)].map((m) => m[1] || m[2]);
  const cap = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;
  const engines = keysOf('ENGINE_ITEMS');
  const providers = keysOf('AI_NAMES');
  assert.deepEqual(engines, ['local', 'openai', 'account', 'parallelsandbox']);
  assert.deepEqual(providers, ['openai', 'deepseek', 'claude', 'account']);
  const used = new Set([
    ...[...ui.matchAll(/menuItem\([^;]*?, '([A-Za-z]+:)'\)/g)].map((m) => m[1]),
    ...[...ui.matchAll(/controller, '([A-Za-z]+:)'/g)].map((m) => m[1]),
    ...engines.map((e) => `engine${cap(e)}:`),
    ...providers.map((p) => `ai${cap(p)}:`),
  ]);
  for (const selector of ['ownKeys:', 'keyOut:', 'keyEnded:', 'accountLogin:', 'quitApp:']) assert.ok(used.has(selector), `${selector} 沒被用到`);
  for (const selector of used) assert.ok(registered.has(selector), `${selector} 沒有在 VoiceDictationController 登記`);
  const keysAt = ui.indexOf('menu.addItem(keysItem)');
  const accountAt = ui.indexOf('menu.addItem(accountItem)');
  assert.ok(keysAt > 0 && keysAt < accountAt, '「設定自己的 key…」要排在「登入 JarvisVoice…」前面');
  assert.equal(ui.slice(keysAt, accountAt).split('menu.addItem').length, 2, '兩個中間不夾別的項目');
  // key 從管子送進 set-key.mjs，不放在參數裡
  assert.match(ui, /setArguments\(\$\(\[SET_KEY, \.\.\.args\]\)\)/);
  assert.match(ui, /writer\.writeData\(\$\(key\)/);
  assert.match(ui, /runKeyTask\(\['set', chosen, [^\n]*\], chosen, answer\.key\)/);
});
