// 只聽我的聲音（聲紋）整條管線：音檔 → listen.mjs 斷句 → 本機聲紋 → 假轉寫。
// 用 macOS 的兩種語音當兩個人：Meijia 是「我」（先講 4 句錄樣本），Eddy 是旁邊的人。Eddy 那句不送轉寫、不貼，之後 Meijia 照常。
// 要有聲紋模型（install.sh 會裝到 ~/.voice-dictation/models/speaker）和 say、ffmpeg，沒有就跳過。

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findFfmpeg } from '../bin/common.mjs';

const MODEL = join(homedir(), '.voice-dictation', 'models', 'speaker', 'campplus_zh.onnx');
const skip = (process.platform !== 'darwin' && '要 macOS 的 say') || (!existsSync(MODEL) && '沒裝聲紋模型（install.sh）');

// 一段音檔：每句之間停 1.5 秒（一句一句切開）
function conversation(dir, lines) {
  const parts = [];
  lines.forEach(([voice, text], i) => {
    const aiff = join(dir, `${i}.aiff`);
    execFileSync('/usr/bin/say', ['-v', voice, '-o', aiff, text]);
    parts.push(aiff);
  });
  const wav = join(dir, 'talk.wav');
  const inputs = [];
  const chain = [];
  parts.forEach((p, i) => {
    inputs.push('-f', 'lavfi', '-t', '1.5', '-i', 'anullsrc=r=24000:cl=mono', '-i', p);
    chain.push(`[${i * 2}:a]`, `[${i * 2 + 1}:a]aresample=24000,aformat=channel_layouts=mono[s${i}]`);
  });
  const filter = `${chain.filter((c) => c.includes('aresample')).join(';')};${parts.map((_, i) => `[${i * 2}:a][s${i}]`).join('')}[${parts.length * 2}:a]concat=n=${parts.length * 2 + 1}:v=0:a=1`;
  execFileSync(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-f', 'lavfi', '-t', '3', '-i', 'anullsrc=r=24000:cl=mono',
    '-filter_complex', filter, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', wav]);
  return wav;
}

test('只聽我的聲音：先從我講的話錄樣本，旁邊的人講的那句不送轉寫、不貼、小框說別人在講話，之後我講的照常', { skip, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-dictation-vp-'));
  mkdirSync(join(dir, 'models', 'speaker'), { recursive: true });
  symlinkSync(MODEL, join(dir, 'models', 'speaker', 'campplus_zh.onnx'));
  const me = 'Meijia';
  const other = 'Eddy (中文（台灣）)';
  const wav = conversation(dir, [
    [me, '我們明天下午四點開會，記得帶筆電還有充電器，會議室在三樓。'],
    [me, '這個問題是部署之後才出現的，我等一下再跟你說清楚到底發生什麼事。'],
    [me, '首頁的卡片高度不一致，請把每一張都改成一樣高，然後重新截圖給我。'],
    [me, '還有設定頁的按鈕太小了，手機上很難按，請放大一點再測一次。'],
    [other, '請問這裡有人坐嗎？我可以把包包放在這個位子上嗎？謝謝你。'],
    [me, '好，最後把這些改動整理成一份清單，明天早上寄給大家看。'],
  ]);
  const calls = [];
  const server = createServer(async (req, res) => {
    for await (const c of req); // 讀完上傳的音檔
    calls.push(calls.length + 1);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: `第${calls.length}句` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: false }, speed: { hedge: 1 }, voiceprint: { enabled: true },
    }));
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'listen.mjs'), '--file', wav, '--dry-paste'], {
      env: { ...process.env, VOICE_DICTATION_HUD: '1', VOICE_DICTATION_STATE_DIR: dir, VOICE_DICTATION_OPENAI_HTTP_URL: `http://127.0.0.1:${server.address().port}/v1/audio/transcriptions` },
    });
    let out = '';
    let log = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { log += d; });
    await new Promise((r) => child.on('close', r));
    const events = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const pasted = events.filter((e) => e.type === 'pasted');
    const bubbles = events.filter((e) => e.type === 'bubble');
    assert.match(log, /聲紋樣本錄好了/, log);
    assert.match(log, /聲紋不像你/, log);
    // 6 句裡旁邊的人那句不送轉寫、不貼（轉寫請求數不算：講到一半停頓時提早送、又開口作廢的也會算進去）
    assert.equal((log.match(/送去轉寫/g) ?? []).length, 5, log);
    assert.equal(pasted.length, 5, log);
    assert.equal((log.match(/聲紋不像你/g) ?? []).length, 1, log);
    assert.ok(existsSync(join(dir, 'voiceprint.json')), '聲紋存在本機');
    // Mac 不開 confirmedOnly（核心 speechBubble）：一開口就跳「聽到聲音…」，旁邊的人那句說「別人在講話」
    assert.equal(bubbles.filter((b) => b.state === 'ignored').length, 1, JSON.stringify(bubbles));
    assert.ok(bubbles.some((b) => b.state === 'hearing'), JSON.stringify(bubbles));
  } finally {
    server.close();
  }
});
