// 真的講話的端到端測試：say 念出句子（真的人聲音訊）→ listen.mjs 收音、切句 → 真的轉寫 → 真的 AI 整理 → 貼進測試視窗，
// 最後讀測試視窗裡真的字來比對。
// 會打雲端（轉寫、AI 整理、Jev，用設定檔裡的 key）、會搶前景（只貼進測試視窗；每句等鍵盤滑鼠停 3 秒才開始，
// 中間有人動就重跑），要 VOICE_DICTATION_E2E=1 才跑：
//   VOICE_DICTATION_E2E=1 node --test tests/voice-e2e.spec.mjs
// 設定檔用 VOICE_DICTATION_CONFIG（沒給就是 ~/.voice-dictation/config.json）；狀態資料夾用暫存的，不碰正在跑的 JarvisVoice。

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createAx } from '../bin/ax.mjs';
import { findFfmpeg } from '../bin/common.mjs';
import { holdFront, restoreFront } from './fixtures/front.mjs';

const ROOT = join(import.meta.dirname, '..');
const enabled = process.platform === 'darwin' && !!process.env.VOICE_DICTATION_E2E;
const ax = enabled ? createAx() : null;
after(() => ax?.close());
const trusted = enabled && (await ax.call('check', { ask: false }).catch(() => ({}))).trusted;
const skip = (!enabled && '會打雲端、搶前景，要 VOICE_DICTATION_E2E=1')
  || (!trusted && '沒有輔助使用權限')
  || (!existsSync(process.env.VOICE_DICTATION_CONFIG || join(homedir(), '.voice-dictation', 'config.json')) && '沒有設定檔');

const work = mkdtempSync(join(tmpdir(), 'jarvis-voice-e2e-'));
const stateDir = join(work, 'state');

// say 念出來 → 24 kHz 單聲道，前面 0.6 秒、後面 2.5 秒靜音（跟真的講話一樣有停頓）；volume 調小聲模擬離麥克風遠
function speak(name, text, volume = 1) {
  const aiff = join(work, `${name}.aiff`);
  const wav = join(work, `${name}.wav`);
  execFileSync('/usr/bin/say', ['-v', process.env.VOICE_DICTATION_E2E_VOICE || 'Meijia', '-o', aiff, text]);
  execFileSync(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-t', '0.6', '-i', 'anullsrc=r=24000:cl=mono', '-i', aiff, '-f', 'lavfi', '-t', '2.5', '-i', 'anullsrc=r=24000:cl=mono',
    '-filter_complex', `[1:a]aresample=24000,aformat=channel_layouts=mono,volume=${volume}[s];[0:a][s][2:a]concat=n=3:v=0:a=1`,
    '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', wav]);
  return wav;
}

async function waitEditable(pid) {
  for (let i = 0; i < 40; i += 1) {
    const ctx = await ax.call('context', { pid }).catch(() => null);
    if (ctx?.field?.editable) return ctx;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

// 鍵盤滑鼠多久沒動了（毫秒）。測試視窗會搶前景：有人在打字時，按鍵會跑進測試視窗，所以等人停手才開始
const idleMs = () => Number(execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem']).toString().match(/"HIDIdleTime" = (\d+)/)?.[1] ?? 0) / 1e6;
async function waitIdle(ms, limitMs = 120_000) {
  const until = Date.now() + limitMs;
  while (idleMs() < ms && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
  return idleMs() >= ms;
}

// 開一個空的測試視窗放到最前面，用音檔跑一次 listen.mjs（只寫進這個測試視窗），回傳 listen 的事件、log、視窗裡的字，
// 以及中間有沒有人動了鍵盤滑鼠（有的話這次不算）
// blur：切完句（開口時讀過游標、確定在框裡）才把測試視窗的焦點從文字框拿掉，模擬講完前點到別的地方
async function dictate(wav, { blur = false } = {}) {
  const blurFile = join(work, `blur-${Date.now()}`);
  const win = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(ROOT, 'tests', 'fixtures', 'test-window.js'), '--empty',
    ...(blur ? ['--blur-on', blurFile] : [])], { stdio: 'ignore' });
  try {
    assert.ok(await waitEditable(win.pid), '測試視窗的文字框要能寫');
    assert.ok(await holdFront(win.pid), '測試視窗要到最前面');
    // 每 100 ms 看一次最後一次鍵盤滑鼠動作是什麼時候；寫草稿、貼上時程式自己按的 Cmd+V 也算一次，要扣掉
    const started = Date.now();
    const inputs = [];
    const watch = setInterval(() => {
      const at = Date.now() - idleMs();
      if (at > started && !inputs.some((x) => Math.abs(x - at) < 150)) inputs.push(at);
    }, 100);
    const ownAt = [];
    const child = spawn(process.execPath, [join(ROOT, 'bin', 'listen.mjs'), '--file', wav, '--pid', String(win.pid)], {
      env: { ...process.env, VOICE_DICTATION_HUD: '1', VOICE_DICTATION_STATE_DIR: stateDir, VOICE_DICTATION_CONFIG: process.env.VOICE_DICTATION_CONFIG || join(homedir(), '.voice-dictation', 'config.json') },
    });
    let out = '';
    let log = '';
    child.stdout.on('data', (d) => { out += d; if (/"(live|draft|pasted)"/.test(String(d))) ownAt.push(Date.now()); });
    child.stderr.on('data', (d) => {
      log += d;
      if (blur && /切出一句/.test(log) && !existsSync(blurFile)) writeFileSync(blurFile, '');
    });
    await new Promise((r) => child.on('close', r));
    // 貼上是 Cmd+V，app 晚一點才讀剪貼簿：等字出現，最多 3 秒
    let value = '';
    for (let i = 0; i < 15 && !value; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      const { handle } = (await ax.call('context', { pid: win.pid })).field;
      value = (await ax.call('read', { handle })).value ?? '';
    }
    clearInterval(watch);
    const events = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const touched = inputs.some((at) => !ownAt.some((t) => at >= t - 1500 && at <= t + 200));
    return { events, log, value, touched };
  } finally {
    win.kill();
  }
}

const CASES = [
  { name: 'blur', say: '我們明天下午四點開會，記得帶筆電。', blur: true, expect: [/四點/, /開會/] },
  { name: 'normal', say: '我們明天下午四點開會，記得帶筆電。', live: true, expect: [/四點/, /開會/, /筆電/] },
  { name: 'hello', say: '哈囉，哈囉，哈囉。', expect: [/哈囉[^哈]*哈囉/] },
  { name: 'test', say: '測試，測試，測試。', expect: [/測試[^測]*測試/] },
  { name: 'short', say: '好', expect: [/好/] },
  { name: 'swear', say: '他媽的，這個又壞掉了。', expect: [/他媽的/, /壞掉/] },
  { name: 'mixed', say: '這個問題是 deploy 之後才出現的，我等一下用 Slack 跟你說。', live: true, expect: [/deploy/i, /slack/i] },
  { name: 'filler', say: '嗯，我們明天三點，不對，四點開會。', live: true, expect: [/四點/, /開會/], reject: [/三點/, /嗯/] },
  { name: 'quiet', say: '我們明天下午四點開會，記得帶筆電。', volume: 0.09, expect: [/四點/, /開會/] },
];

test('真的講話：念出來的句子一路轉寫、整理，貼進測試視窗的字是對的', { skip, timeout: 300_000 }, async (t) => {
  // 詞彙表跟平常用的一樣（預設放在狀態資料夾）
  mkdirSync(stateDir, { recursive: true });
  const vocab = join(homedir(), '.voice-dictation', 'vocabulary.txt');
  if (existsSync(vocab)) copyFileSync(vocab, join(stateDir, 'vocabulary.txt'));
  // 邊講邊打要本機預覽的模型（聲紋放在暫存的狀態資料夾，還在學，不擋）
  const models = join(homedir(), '.voice-dictation', 'models');
  if (existsSync(models)) symlinkSync(models, join(stateDir, 'models'));
  const failures = [];
  const latencies = [];
  try {
    // VOICE_DICTATION_E2E_ONLY=blur,normal 只跑這幾句
    const only = process.env.VOICE_DICTATION_E2E_ONLY?.split(',');
    for (const c of CASES.filter((x) => !only || only.includes(x.name))) {
      const wav = speak(c.name, c.say, c.volume);
      let run = null;
      for (let attempt = 0; attempt < 3 && (!run || run.touched); attempt += 1) {
        assert.ok(await waitIdle(3000), '等了兩分鐘鍵盤滑鼠都沒停');
        run = await dictate(wav, { blur: c.blur });
        if (run.touched) t.diagnostic(`${c.name}：中間有人動了鍵盤滑鼠，這次不算，重跑`);
      }
      assert.ok(!run.touched, `${c.name}：試了三次中間都有人動鍵盤滑鼠`);
      const { events, log, value } = run;
      const pastedEvent = events.find((e) => e.type === 'pasted');
      const raw = pastedEvent?.raw ?? '';
      // 講完到貼上幾秒（listen 記的「速度」那行：字回來、整理好、貼上各花多少）
      const speed = log.match(/速度：[^\n]*/)?.[0] ?? '';
      if (pastedEvent?.latencyMs) latencies.push(pastedEvent.latencyMs);
      t.diagnostic(`${c.name}：念「${c.say}」→ 轉寫「${raw}」→ 視窗裡「${value}」${speed ? `；${speed}` : ''}`);
      const bad = [...c.expect.filter((re) => !re.test(value)).map((re) => `少了 ${re}`), ...(c.reject ?? []).filter((re) => re.test(value)).map((re) => `不該有 ${re}`)];
      // 字先進框，整理好才換（blur：切完句游標離開框，寫準的字時對焦回原本的框）；換了字，視窗裡就是換好的
      const draftAt = events.findIndex((e) => e.type === 'draft');
      if (draftAt < 0 || draftAt > events.indexOf(pastedEvent)) bad.push('草稿要比換字早');
      // 講話中就打進框：比這句準的字回來還早
      const liveAt = events.findIndex((e) => e.type === 'live');
      if (c.live && (liveAt < 0 || liveAt > draftAt)) bad.push('講話中就要打進框');
      if (c.live) t.diagnostic(`${c.name}：講話中打進框 ${events.filter((e) => e.type === 'live').map((e) => `「${e.text}」`).join('')}`);
      if (bad.length) failures.push(`${c.name}（視窗裡「${value}」）：${bad.join('、')}\n${log.trim().split('\n').slice(-8).join('\n')}`);
    }
  } finally {
    restoreFront();
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  if (sorted.length) t.diagnostic(`講完到貼上：中位數 ${(sorted[Math.floor(sorted.length / 2)] / 1000).toFixed(2)} 秒、最慢 ${(sorted.at(-1) / 1000).toFixed(2)} 秒（${sorted.length} 句）`);
  assert.deepEqual(failures, []);
});
