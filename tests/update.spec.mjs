// 下載版的 App 內更新：node --test tests/update.spec.mjs
// 版號比大小、從 GitHub Release 挑更新檔、換不了的位置先擋下；check 打的是 Release API（這裡用本機假的）；
// 選單列有新版才顯示更新那一行。

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { assertReplaceable, newer, pickUpdate, teamOf } from '../bin/update.mjs';

const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const mac = process.platform === 'darwin';
const release = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, assets: [
  { name: `JarvisVoice-${tag.replace(/^v/, '')}.dmg`, browser_download_url: 'https://example.com/a.dmg' },
  { name: `JarvisVoice-${tag.replace(/^v/, '')}-update.zip`, browser_download_url: `https://example.com/${tag}.zip` },
], ...extra });

test('版號比大小：逐段比數字，前面的 v 不算', () => {
  assert.equal(newer('1.0.10', '1.0.9'), true);
  assert.equal(newer('v1.1', '1.0.9'), true);
  assert.equal(newer('1.0.0', 'v1.0.0'), false);
  assert.equal(newer('1.0.0', '1.0.1'), false);
});

test('挑更新檔：比現在新、不是草稿或預覽版、有 update.zip 才算', () => {
  assert.deepEqual(pickUpdate(release('v1.0.1'), '1.0.0'), { version: '1.0.1', url: 'https://example.com/v1.0.1.zip' });
  assert.equal(pickUpdate(release('v1.0.0'), '1.0.0'), null);
  assert.equal(pickUpdate(release('v1.0.1', { prerelease: true }), '1.0.0'), null);
  assert.equal(pickUpdate({ ...release('v1.0.1'), assets: [] }, '1.0.0'), null);
});

test('換不了的位置先擋下：還在 .dmg、被系統搬到唯讀的地方跑', () => {
  assert.throws(() => assertReplaceable('/Volumes/JarvisVoice/JarvisVoice.app'), /拖進「應用程式」/);
  assert.throws(() => assertReplaceable('/private/var/folders/x/AppTranslocation/ABC/d/JarvisVoice.app'), /拖進「應用程式」/);
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-app-'));
  assert.doesNotThrow(() => assertReplaceable(join(dir, 'JarvisVoice.app')));
});

test('Team ID：讀得到簽章的 Team ID，沒有也不出錯（codesign 把它印在 stderr）', { skip: !mac && '要 codesign' }, () => {
  const team = teamOf(process.execPath);
  assert.equal(typeof team, 'string');
  assert.equal(teamOf(join(tmpdir(), 'jarvis-沒有這個檔')), '');
});

test('check：照 Release API 回有沒有新版（這裡是本機假的 Release）', async () => {
  let body = release('v1.0.1');
  const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/latest`;
  // 要用非同步的 execFile：同步的會卡住這個程式，假的 Release 就回不了
  const run = async (current) => JSON.parse((await promisify(execFile)(process.execPath, [join(repo, 'bin/update.mjs'), 'check', '--current', current],
    { encoding: 'utf8', env: { ...process.env, JARVIS_UPDATE_URL: url } })).stdout.trim());
  try {
    assert.deepEqual(await run('1.0.0'), { type: 'update', state: 'available', version: '1.0.1', url: 'https://example.com/v1.0.1.zip' });
    body = release('v1.0.0');
    assert.deepEqual(await run('1.0.0'), { type: 'update', state: 'none' });
  } finally {
    server.close();
  }
});

test('選單列：有新版才顯示更新那一行', { skip: !mac && '要 osascript' }, () => {
  const state = mkdtempSync(join(tmpdir(), 'jarvis-ui-update-'));
  const harness = join(state, 'harness.js');
  writeFileSync(harness, `
    ObjC.import('Cocoa');
    function run() {
      globalThis.BUILD = { node: '/usr/bin/false', repo: ${JSON.stringify(repo)}, state: ${JSON.stringify(state)}, bundled: true };
      (0, eval)(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(BUILD.repo + '/app/ui.js', $.NSUTF8StringEncoding, null)));
      const seen = [updateTitle()];
      onUpdateLine('{"type":"update","state":"available","version":"1.0.1","url":"x"}');
      seen.push(updateTitle());
      onUpdateLine('{"type":"update","state":"none"}');
      seen.push(updateTitle());
      return JSON.stringify(seen);
    }
  `);
  const seen = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', harness], { encoding: 'utf8', env: { ...process.env, VOICE_DICTATION_LANG: 'zh-Hant' } }));
  assert.deepEqual(seen, ['', '有新版 1.0.1：更新並重新打開…', '']);
});
