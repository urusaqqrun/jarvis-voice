// 下載版（app/package.sh）用到的部分：node --test tests/onboarding.spec.mjs
// 第一次設定畫面（app/onboarding.js）每一頁中英文都畫得出來（不顯示視窗、不要權限、不帶起任何程式）；
// 模型下載（bin/models.mjs）已經有的不重下、網址只有它一份。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const mac = process.platform === 'darwin';

test('第一次設定畫面：每一頁中英文都畫得出來', { skip: !mac && '要 osascript' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-onboarding-'));
  const harness = join(dir, 'harness.js');
  writeFileSync(harness, `
    ObjC.import('Cocoa');
    function run() {
      globalThis.BUILD = { node: '/usr/bin/false', repo: ${JSON.stringify(repo)}, state: ${JSON.stringify(dir)}, bundled: true };
      const read = (p) => ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null));
      (0, eval)(read(BUILD.repo + '/app/ui.js'));
      (0, eval)(read(BUILD.repo + '/app/onboarding.js'));
      const ready = { models: { state: 'done', model: '', done: 0, total: 0, message: '' }, view: { state: 'listening', message: '', engine: 'local' } };
      const pages = ['welcome', 'mic', 'ax', 'model', 'try', 'ai', 'done'].map((step) => ({ step, file: ${JSON.stringify(dir)} + '/' + step + '.png',
        state: step === 'model' ? { models: { state: 'downloading', model: 'local', done: 5e6, total: 10e6, message: '' } } : ready }));
      pages.push({ step: 'try', file: ${JSON.stringify(dir)} + '/try-ok.png', state: ready, practice: '講好了' });
      return JSON.stringify(snapshotOnboarding(pages));
    }
  `);
  for (const lang of ['zh-Hant', 'en']) {
    const files = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', harness], { encoding: 'utf8', env: { ...process.env, VOICE_DICTATION_LANG: lang } }));
    assert.equal(files.length, 8);
    for (const file of files) assert.ok(statSync(file).size > 5_000, `${lang} ${file} 是空的`);
  }
  // 畫圖不帶起任何程式，也不寫狀態資料夾（onboarding、try-here 只在真的打開時才放）
  assert.throws(() => statSync(join(dir, 'try-here')));
  assert.throws(() => statSync(join(dir, 'onboarding')));
});

test('模型：已經有的不重下（不連網），網址只寫在 bin/models.mjs', () => {
  const state = mkdtempSync(join(tmpdir(), 'jarvis-models-'));
  const model = join(state, 'models', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17');
  mkdirSync(model, { recursive: true });
  writeFileSync(join(model, 'model.int8.onnx'), 'x');
  mkdirSync(join(state, 'models', 'speaker'), { recursive: true });
  writeFileSync(join(state, 'models', 'speaker', 'campplus_zh.onnx'), 'x');
  const out = execFileSync(process.execPath, [join(repo, 'bin/models.mjs'), '--json'], { encoding: 'utf8', env: { ...process.env, VOICE_DICTATION_STATE_DIR: state } });
  assert.deepEqual(out.trim().split('\n').map((line) => JSON.parse(line)), [{ type: 'models', state: 'done' }]);
  assert.doesNotMatch(readFileSync(join(repo, 'install.sh'), 'utf8'), /releases\/download/);
});
