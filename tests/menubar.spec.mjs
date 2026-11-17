// 選單列小程式和常駐程式之間的 stdout：node --test tests/menubar.spec.mjs
// 11/13 起選單列不再讀常駐程式的 stdout，pipe 塞滿 64KB：圖示停在「啟動中」、講話時小框不出來，聽寫照常。
// 驗：常駐程式的看門狗（連續 30 秒送不出去才算卡住）、Node 在 Mac 上對方不讀時照樣寫（看得出卡住的只有 writableLength）、
// 選單列照 byte 切行（中文字被切在兩次讀之間湊得回來）、某一行處理出錯只記 ui.log 不會從此不讀。

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createOutputWatch } from '../bin/common.mjs';

const repo = new URL('..', import.meta.url).pathname;
const mac = process.platform === 'darwin';

test('看門狗：stdout 連續 30 秒送不出去才算卡住，中間清空過就重算', () => {
  const stuck = createOutputWatch({ stuckMs: 30_000 });
  assert.equal(stuck(0, 0), false);
  assert.equal(stuck(5_000, 1_000), false); // 開始堆
  assert.equal(stuck(9_000, 30_999), false);
  assert.equal(stuck(9_000, 31_000), true);
  assert.equal(stuck(0, 31_500), false); // 選單列讀了：重算
  assert.equal(stuck(100, 32_000), false);
  assert.equal(stuck(100, 61_999), false);
  assert.equal(stuck(100, 62_000), true);
});

test('對方不讀 stdout：Node 照樣往下跑，只有 writableLength 一直不是 0', { skip: !mac && 'Linux 的 pipe 是同步寫，會直接卡住' }, async () => {
  // 寫 200KB 給不讀的人（pipe 64KB 加上 parent 這邊最多先收的），寫完從 stderr 報 writableLength
  const child = spawn(process.execPath, ['-e', `
    const line = 'x'.repeat(999) + '\\n';
    for (let i = 0; i < 200; i += 1) process.stdout.write(line);
    process.stderr.write(String(process.stdout.writableLength));
    setTimeout(() => process.exit(0), 50);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pause();
  let report = '';
  child.stderr.on('data', (chunk) => { report += chunk; });
  await new Promise((resolve) => child.on('exit', resolve));
  assert.ok(Number(report) > 0, `writableLength 應該大於 0，拿到 ${report}`);
});

test('選單列讀 stdout：中文字切在兩次讀之間湊得回來，某一行出錯記進 ui.log、後面照樣處理', { skip: !mac && '要 osascript' }, () => {
  const state = mkdtempSync(join(tmpdir(), 'jarvis-ui-'));
  const harness = join(state, 'harness.js');
  writeFileSync(harness, `
    ObjC.import('Cocoa');
    function run() {
      globalThis.BUILD = { node: ${JSON.stringify(process.execPath)}, repo: ${JSON.stringify(repo.replace(/\/$/, ''))}, state: ${JSON.stringify(state)} };
      const code = $.NSString.stringWithContentsOfFileEncodingError(BUILD.repo + '/app/ui.js', $.NSUTF8StringEncoding, null);
      (0, eval)(ObjC.unwrap(code));
      const seen = [];
      const real = onLine;
      globalThis.onLine = (line) => { if (line.includes('boom')) throw new Error('故意出錯'); seen.push(line); real(line); };
      const handle = $.NSFileHandle.fileHandleWithNullDevice;
      const bytes = (s) => $(s).dataUsingEncoding($.NSUTF8StringEncoding);
      const send = (data) => onStdout($.NSNotification.notificationWithNameObjectUserInfo('stdout', handle,
        $.NSDictionary.dictionaryWithObjectForKey(data, $.NSFileHandleNotificationDataItem)));
      const head = '{"type":"state","state":"standby"}\\n{"type":"boom"}\\n{"type":"state","state":"listening","message":"';
      const all = bytes(head + '中文字"}\\n{"type":"hud","line":"hea');
      const cut = Number(bytes(head).length) + 1; // 切在「中」的中間
      const n = Number(all.length);
      send(all.subdataWithRange($.NSMakeRange(0, 20)));
      send(all.subdataWithRange($.NSMakeRange(20, cut - 20)));
      send(all.subdataWithRange($.NSMakeRange(cut, n - cut)));
      send(bytes('ring"}\\n'));
      return JSON.stringify({ seen, label: label() });
    }
  `);
  const result = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', harness], { encoding: 'utf8', env: { ...process.env, VOICE_DICTATION_LANG: 'zh-Hant' } }));
  assert.deepEqual(result.seen, [
    '{"type":"state","state":"standby"}',
    '{"type":"state","state":"listening","message":"中文字"}',
    '{"type":"hud","line":"hearing"}',
  ]);
  assert.match(result.label, /^聽著/);
  assert.match(readFileSync(join(state, 'ui.log'), 'utf8'), /處理常駐程式的訊息出錯：Error: 故意出錯；訊息：\{"type":"boom"\}/);
});
