// 常駐程式的零件測試：node --test tests/*.spec.mjs
// OpenAI 直連用本機假伺服器；本機辨識用模型附的 test_wavs/zh.wav（沒裝模型就跳過）。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

const stateDir = mkdtempSync(join(tmpdir(), 'voice-dictation-test-'));
process.env.VOICE_DICTATION_STATE_DIR = stateDir;

const { finishText, isSpeech, withSpacing } = await import('../bin/text.mjs');
const { loadConfig, DEFAULT_MODEL, isLiveModel, appAllowed } = await import('../bin/config.mjs');
const { charErrorRate, phantomTerms, normalize } = await import('../bin/vocab-test.mjs');
const { createBatchEngine, wavFromPcm16 } = await import('../bin/engines/batch.mjs');
const { createRealtimeEngine, openaiConnector } = await import('../bin/engines/realtime.mjs');
const { createLocalEngine } = await import('../bin/engines/local.mjs');
const { findFfmpeg } = await import('../bin/common.mjs');

test('簡體轉台灣正體、固定替換、平行沙盒已轉好的不再轉', () => {
  assert.equal(finishText('帮我看一下部署表，顺便把测试跑完。'), '幫我看一下部署表，順便把測試跑完。');
  assert.equal(finishText('打开软件', { output: 'traditional' }), '開啟軟體');
  assert.equal(finishText('幫我把測籃改掉', { replacements: { 測籃: '側欄' } }), '幫我把側欄改掉');
  assert.equal(finishText('部屬到 dev', { alreadyTraditional: true, replacements: { 部屬: '部署' } }), '部署到 dev');
  assert.equal(finishText('幫我看一下', { output: 'simplified' }), '帮我看一下');
  assert.equal(finishText('  原樣  ', { output: 'original' }), '原樣');
});

test('雜音轉出的純標點不貼；英文句尾補空白', () => {
  assert.equal(isSpeech('。，'), false);
  assert.equal(isSpeech('好'), true);
  assert.equal(withSpacing('run the build.'), 'run the build. ');
  assert.equal(withSpacing('跑完了。'), '跑完了。');
});

test('設定檔：沒寫的照預設，engine 寫錯退回本機並說明', () => {
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ engine: 'whisper', openai: { model: 'x' } }));
  const { config, error } = loadConfig();
  assert.equal(config.engine, 'local');
  assert.match(error, /engine 只能是/);
  assert.equal(config.openai.model, 'x');
  assert.equal(config.output, 'traditional');
  assert.deepEqual(config.apps, ['*']);
  assert.ok(config.local.model.endsWith(DEFAULT_MODEL));
  writeFileSync(join(stateDir, 'config.json'), '{ 壞掉');
  assert.match(loadConfig().error, /設定檔讀不懂/);
});

test('OpenAI：預設一般轉寫；key 可以放在 .env 檔；模型名稱決定一般或即時', () => {
  const envFile = join(stateDir, 'openai.env');
  writeFileSync(envFile, 'OTHER=1\nexport OPENAI_API_KEY="sk-from-file"\n');
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ engine: 'openai', openai: { apiKeyFile: envFile } }));
  const { config } = loadConfig();
  assert.equal(config.openai.model, 'gpt-transcribe');
  assert.equal(config.openai.apiKey, 'sk-from-file');
  assert.equal(isLiveModel('gpt-transcribe'), false);
  assert.equal(isLiveModel('gpt-live-transcribe'), true);
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ engine: 'openai', openai: { apiKeyFile: join(stateDir, 'nope.env') } }));
  assert.match(loadConfig().error, /讀不到 openai.apiKeyFile/);
});

test('詞彙檔：一行一個、# 是註解、和設定檔的 keywords 合併去重、拿掉 OpenAI 不收的字元', () => {
  const vocab = join(stateDir, 'vocabulary.txt');
  writeFileSync(vocab, '# 產品\nCubeLV\n平行沙盒  # 中文名\n\nsession\ncubelv\n<壞>詞\n');
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ engine: 'openai', openai: { keywords: ['Claude Code', 'CubeLV'], language: 'zh' } }));
  const { config } = loadConfig();
  assert.equal(config.openai.vocabularyFile, vocab); // 預設就讀狀態資料夾的 vocabulary.txt
  assert.deepEqual(config.openai.keywords, ['Claude Code', 'CubeLV', '平行沙盒', 'session', '壞詞']);
  assert.deepEqual(config.openai.languages, ['zh']); // 舊的 language 轉成 languages
});

test('WAV 檔頭：24kHz 單聲道 16-bit', () => {
  const wav = wavFromPcm16(Buffer.alloc(4800));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 4800);
  assert.equal(wav.length, 4844);
});

// 假的 /v1/audio/transcriptions：照 handler 回應，記下每次上傳的欄位
async function fakeTranscriptions(handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
    const file = form.get('file');
    const call = {
      auth: req.headers.authorization,
      model: form.get('model'),
      language: form.get('language'),
      languages: form.getAll('languages[]'),
      keywords: form.getAll('keywords[]'),
      prompt: form.get('prompt'),
      bytes: Buffer.from(await file.arrayBuffer()),
    };
    calls.push(call);
    const { status = 200, body, delay = 0 } = handler(call, calls.length);
    setTimeout(() => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }, delay);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.VOICE_DICTATION_OPENAI_HTTP_URL = `http://127.0.0.1:${server.address().port}/v1/audio/transcriptions`;
  return { calls, close: () => { delete process.env.VOICE_DICTATION_OPENAI_HTTP_URL; server.close(); } };
}

const speech = (seconds, value) => Buffer.alloc(Math.round(24000 * 2 * seconds), value);
const waitFor = async (check) => { for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 20)); };

test('OpenAI 一般轉寫：整句包成 WAV 上傳，先講的先貼（即使晚回來）', async () => {
  const server = await fakeTranscriptions((call, n) => (n === 1
    ? { body: { text: '第一句' }, delay: 300 }
    : { body: { text: '第二句' } }));
  try {
    const finals = [];
    const errors = [];
    const engine = createBatchEngine({
      apiKey: 'sk-test', model: 'gpt-transcribe', languages: ['zh', 'en'], prompt: '開發對話', keywords: ['CubeLV', '平行沙盒'],
      onFinal: (t) => finals.push(t), onError: (m) => errors.push(m), log: () => {},
    });
    engine.append(speech(0.5, 1));
    engine.commit();
    engine.append(speech(0.6, 2));
    engine.commit();
    await waitFor(() => finals.length === 2);
    assert.deepEqual(errors, []);
    assert.deepEqual(finals, ['第一句', '第二句']);
    assert.equal(server.calls[0].auth, 'Bearer sk-test');
    assert.equal(server.calls[0].model, 'gpt-transcribe');
    assert.equal(server.calls[0].language, null); // gpt-transcribe 不收單一 language
    assert.deepEqual(server.calls[0].languages, ['zh', 'en']);
    assert.deepEqual(server.calls[0].keywords, ['CubeLV', '平行沙盒']);
    assert.equal(server.calls[0].prompt, '開發對話');
    assert.equal(server.calls[0].bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(server.calls[0].bytes.length, 44 + 24000);
    assert.equal(engine.busy(), false);
  } finally {
    server.close();
  }
});

test('OpenAI 一般轉寫：伺服器錯誤重試一次；key 錯不重試、直接說原因；太短的不送', async () => {
  const server = await fakeTranscriptions((call, n) => {
    if (call.auth === 'Bearer sk-bad') return { status: 401, body: { error: { message: 'Incorrect API key provided' } } };
    return n === 1 ? { status: 500, body: { error: { message: 'boom' } } } : { body: { text: '重試成功' } };
  });
  try {
    const finals = [];
    const errors = [];
    const ok = createBatchEngine({ apiKey: 'sk-test', onFinal: (t) => finals.push(t), onError: (m) => errors.push(m), log: () => {} });
    ok.append(speech(0.05, 1)); // 太短，不送
    ok.commit();
    ok.append(speech(0.5, 1));
    ok.commit();
    await waitFor(() => finals.length === 1);
    assert.deepEqual(finals, ['重試成功']);
    assert.equal(server.calls.length, 2);

    const bad = createBatchEngine({ apiKey: 'sk-bad', onFinal: (t) => finals.push(t), onError: (m) => errors.push(m), log: () => {} });
    bad.append(speech(0.5, 1));
    bad.commit();
    await waitFor(() => errors.length === 1);
    assert.match(errors[0], /HTTP 401.*Incorrect API key/);
    assert.equal(server.calls.length, 3);
  } finally {
    server.close();
  }
});

test('OpenAI 一般轉寫：沒網路時寫清楚原因（不是 fetch failed），這句改用本機辨識不丟掉；剛斷過網不再等重試', async () => {
  process.env.VOICE_DICTATION_OPENAI_HTTP_URL = 'http://api.openai.invalid/v1/audio/transcriptions'; // .invalid 一定查不到
  try {
    const got = [];
    const errors = [];
    const heard = [];
    const engine = createBatchEngine({
      apiKey: 'sk-test',
      fallback: async (pcm) => { heard.push(pcm.length); return `本機${heard.length}`; },
      onFinal: (text, info) => got.push([text, info.local]), onError: (m) => errors.push(m), log: () => {},
    });
    engine.append(speech(0.5, 1));
    engine.commit();
    await waitFor(() => got.length === 1);
    const started = Date.now();
    engine.append(speech(0.6, 1));
    engine.commit();
    await waitFor(() => got.length === 2);
    assert.ok(Date.now() - started < 600, `剛斷過網還等了重試（${Date.now() - started} ms）`);
    assert.deepEqual(got, [['本機1', true], ['本機2', true]]);
    assert.deepEqual(heard, [24000, 28800]); // 整句的聲音（不含 WAV 檔頭）
    assert.match(errors[0], /^沒網路，連不上 OpenAI（E[A-Z_]+），這句改用本機辨識$/);

    // 沒有本機模型：還是沒寫，但原因寫清楚
    const finals = [];
    const noLocal = createBatchEngine({ apiKey: 'sk-test', fallback: () => null, onFinal: (t) => finals.push(t), onError: (m) => errors.push(m), log: () => {} });
    noLocal.append(speech(0.5, 1));
    noLocal.commit();
    await waitFor(() => errors.length === 3);
    assert.match(errors[2], /^沒網路，連不上 OpenAI（E[A-Z_]+）$/);
    assert.deepEqual(finals, []);
  } finally {
    delete process.env.VOICE_DICTATION_OPENAI_HTTP_URL;
  }
});

test('連線層的錯翻成看得懂的話：被切斷、逾時、拒絕連線；不是連線的錯不管', async () => {
  const { networkError } = await import('../core/net.mjs');
  const failed = (cause) => Object.assign(new TypeError('fetch failed'), { cause });
  assert.equal(networkError(failed({ code: 'ENOTFOUND', hostname: 'api.deepseek.com' })), '沒網路，連不上 api.deepseek.com（ENOTFOUND）');
  assert.equal(networkError(failed({ code: 'ECONNRESET' }), 'OpenAI'), '跟 OpenAI 的連線被切斷，網路不穩（ECONNRESET）');
  assert.equal(networkError(failed({ code: 'UND_ERR_CONNECT_TIMEOUT' }), 'OpenAI'), '連 OpenAI 逾時，網路不穩或斷了（UND_ERR_CONNECT_TIMEOUT）');
  assert.equal(networkError(failed(Object.assign(new AggregateError([{ code: 'ECONNREFUSED' }]), { code: 'ECONNREFUSED' })), 'OpenAI'), 'OpenAI 拒絕連線（ECONNREFUSED）');
  assert.equal(networkError(new DOMException('timed out', 'TimeoutError'), 'OpenAI'), '等 OpenAI 回應逾時（網路很慢或斷了）');
  assert.equal(networkError(new Error('OpenAI 轉寫失敗（HTTP 401）')), '');
  assert.equal(networkError(new DOMException('aborted', 'AbortError')), '');
});

test('OpenAI 一般轉寫：轉出空字串也照順序交出去（listen 會記「轉寫結果：（空的）」）、太短的記一行 log', async () => {
  const server = await fakeTranscriptions((call, n) => ({ body: { text: n === 1 ? '' : '第二句' } }));
  try {
    const finals = [];
    const logs = [];
    const engine = createBatchEngine({ apiKey: 'sk-test', onFinal: (t) => finals.push(t), onError: () => {}, log: (m) => logs.push(m) });
    engine.append(speech(0.05, 1));
    engine.commit();
    engine.append(speech(0.5, 1));
    engine.commit();
    engine.append(speech(0.5, 2));
    engine.commit();
    await waitFor(() => finals.length === 2);
    assert.deepEqual(finals, ['', '第二句']);
    assert.ok(logs.some((m) => /這句只有 0\.05 秒，當雜音沒送轉寫/.test(m)), logs.join('\n'));
  } finally {
    server.close();
  }
});

test('OpenAI 一般轉寫：停 0.4 秒先送（speculate），切句時直接用那份；又開口作廢就整句重送；先送的失敗也整句重送', async () => {
  const server = await fakeTranscriptions((call) => (call.bytes.length === 44 + 24000 ? { body: { text: '先送的' } } : { body: { text: `整句 ${call.bytes.length - 44}` } }));
  try {
    const got = [];
    const engine = createBatchEngine({ apiKey: 'sk-test', onFinal: (text, info) => got.push([text, info.early, info.turn]), onError: () => {}, log: () => {} });
    engine.append(speech(0.5, 1));
    assert.equal(engine.speculate(), true);
    assert.equal(engine.busy(), false); // 還沒 commit 不算在轉
    engine.append(speech(0.45, 0)); // 後面只有靜音
    engine.commit({ turn: 1 });
    await waitFor(() => got.length === 1);
    assert.deepEqual(got[0], ['先送的', true, 1]);
    assert.equal(server.calls.length, 1);

    engine.append(speech(0.5, 1));
    engine.speculate();
    assert.equal(engine.discard(), true); // 又開口了
    engine.append(speech(0.5, 2));
    engine.commit({ turn: 2 });
    await waitFor(() => got.length === 2);
    assert.deepEqual(got[1], ['整句 48000', false, 2]);
  } finally {
    server.close();
  }
  const flaky = await fakeTranscriptions((call, n) => (n === 1 ? { status: 500, body: { error: { message: 'boom' } } } : { body: { text: '重送成功' } }));
  try {
    const got = [];
    const engine = createBatchEngine({ apiKey: 'sk-test', onFinal: (text, info) => got.push([text, info.early]), onError: () => {}, log: () => {} });
    engine.append(speech(0.5, 1));
    engine.speculate();
    await new Promise((r) => setTimeout(r, 50));
    engine.commit();
    await waitFor(() => got.length === 1);
    assert.deepEqual(got[0], ['重送成功', false]);
  } finally {
    flaky.close();
  }
});

test('OpenAI 一般轉寫：hedge 2 同時送兩份，誰先回用誰（慢的那份不用等）', async () => {
  const server = await fakeTranscriptions((call, n) => (n === 1 ? { body: { text: '慢的' }, delay: 1500 } : { body: { text: '快的' }, delay: 20 }));
  try {
    const got = [];
    const engine = createBatchEngine({ apiKey: 'sk-test', hedge: 2, onFinal: (text, info) => got.push([text, info.ms]), onError: () => {}, log: () => {} });
    engine.append(speech(0.5, 1));
    engine.commit();
    await waitFor(() => got.length === 1);
    assert.equal(server.calls.length, 2);
    assert.equal(got[0][0], '快的');
    assert.ok(got[0][1] < 1000, `不用等慢的那份：${got[0][1]} ms`);
  } finally {
    server.close();
  }
});

test('OpenAI 直連：帶自己的 key、先送 session 設定，再送音訊與 commit，收到定稿', async () => {
  const wss = new WebSocketServer({ port: 0 });
  const seen = { auth: '', first: null, appends: 0 };
  wss.on('connection', (socket, req) => {
    seen.auth = req.headers.authorization;
    socket.on('message', (raw) => {
      const event = JSON.parse(String(raw));
      if (!seen.first) seen.first = event;
      if (event.type === 'input_audio_buffer.append') seen.appends += 1;
      if (event.type === 'input_audio_buffer.commit') {
        socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item_1' }));
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', delta: '你好' }));
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', transcript: '你好，世界' }));
      }
    });
  });
  await new Promise((r) => wss.on('listening', r));
  process.env.VOICE_DICTATION_OPENAI_URL = `ws://127.0.0.1:${wss.address().port}`;
  let engine;
  try {
    const finals = [];
    const errors = [];
    engine = createRealtimeEngine({
      connector: openaiConnector({ apiKey: 'sk-test', model: 'gpt-live-transcribe', languages: ['zh'] }),
      onFinal: (text) => finals.push(text),
      onError: (message) => errors.push(message),
      log: () => {},
    });
    engine.append(Buffer.alloc(4800));
    engine.commit();
    for (let i = 0; i < 50 && !finals.length; i += 1) {
      engine.flush();
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(finals, ['你好，世界']);
    assert.equal(seen.auth, 'Bearer sk-test');
    assert.equal(seen.first.type, 'session.update');
    assert.equal(seen.first.session.audio.input.transcription.model, 'gpt-live-transcribe');
    assert.deepEqual(seen.first.session.audio.input.transcription.languages, ['zh']);
    assert.equal(seen.first.session.audio.input.format.rate, 24000);
    assert.equal(seen.appends, 1);
    for (let i = 0; i < 10 && engine.busy(); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(engine.busy(), false);
  } finally {
    engine?.close();
    delete process.env.VOICE_DICTATION_OPENAI_URL;
    for (const client of wss.clients) client.terminate();
    wss.close();
  }
});

test('OpenAI 直連：沒有 key 時直接說要設定', async () => {
  const errors = [];
  const engine = createRealtimeEngine({
    connector: openaiConnector({ apiKey: '', model: 'gpt-live-transcribe' }),
    onFinal: () => {},
    onError: (message) => errors.push(message),
    log: () => {},
  });
  engine.append(Buffer.alloc(4800));
  engine.commit();
  for (let i = 0; i < 20 && !errors.length; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.match(errors[0], /沒有 OpenAI API key/);
  engine.close();
});

const model = join(process.env.HOME, '.voice-dictation', 'models', DEFAULT_MODEL);
test('本機辨識：模型附的中文範例聽得出來', { skip: !existsSync(join(model, 'tokens.txt')) && '沒裝本機模型' }, async () => {
  const raw = execFileSync(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-i', join(model, 'test_wavs', 'zh.wav'),
    '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 26 });
  const finals = [];
  const engine = createLocalEngine({ model, onFinal: (t) => finals.push(t), onError: (m) => assert.fail(m), log: () => {} });
  engine.append(raw);
  engine.commit();
  for (let i = 0; i < 100 && !finals.length; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(finals.length, 1);
  assert.match(finals[0], /[一-鿿]{4,}/);
  engine.close();
});

test('本機辨識：找不到模型時說要重跑 install.sh', () => {
  const errors = [];
  createLocalEngine({ model: join(stateDir, 'nope'), onFinal: () => {}, onError: (m) => errors.push(m), log: () => {} });
  assert.match(errors[0], /找不到本機模型/);
});

test('哪些 app 收音：預設全部，開會的 app 和自己除外；也可以只指定幾個', () => {
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ engine: 'local' }));
  const { config } = loadConfig();
  assert.equal(appAllowed(config, 'com.google.Chrome'), true);
  assert.equal(appAllowed(config, 'us.zoom.xos'), false);
  assert.equal(appAllowed(config, 'com.urusa.voice-dictation'), false);
  assert.equal(appAllowed(config, ''), false);
  const only = { ...config, apps: ['com.anthropic.claudefordesktop'] };
  assert.equal(appAllowed(only, 'com.anthropic.claudefordesktop'), true);
  assert.equal(appAllowed(only, 'com.google.Chrome'), false);
});

test('專有名詞測試的比對：不管空白標點大小寫、算字錯誤率、抓沒講卻出現的詞', () => {
  assert.equal(normalize('Test Flight，送審。'), 'testflight送審');
  assert.equal(charErrorRate('丟到 TestFlight 送審。', '丟到 test flight 送審'), 0);
  assert.equal(charErrorRate('平行沙盒', '平行沙河'), 0.25);
  assert.deepEqual(phantomTerms('今天去吃牛肉麵', '今天去吃牛肉麵 CubeLV', ['CubeLV', '牛肉麵', 'PR']), ['CubeLV']);
});
